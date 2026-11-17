"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const {makeOfflineManualEvidenceIntegration} =
  require("./manual-evidence-integration");

const BASE=Date.parse("2026-11-17T10:00:00.000Z");
const iso=m=>new Date(BASE+m*60000).toISOString();
const OWNER={auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const CATALOGUE=[{marketId:101,sportId:11,playerProp:true,
  marketName:"Over Under Player Points (incl. overtime)",period:"result",
  handicap:20.5,outcomes:[{outcomeId:201,outcomeName:"Over"},
    {outcomeId:202,outcomeName:"Under"}]}];
const odds=(overrides={})=>[{
  fixtureId:"synthetic-d11-fixture",tournamentId:132,sportId:11,
  statusId:0,hasOdds:true,startTime:iso(180),
  participant1Id:"5001",participant2Id:"5002",
  apiKey:"SENSITIVE_SHOULD_NOT_STORE",
  bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,
    markets:{"101":{marketActive:true,outcomes:{"201":{
      players:{"301":{playerName:"SECRET_PLAYER",price:1.87,
        active:true,changedAt:iso(-1)}}}}}}}},...overrides
}];

function fakeStreamResponse(payload,requestUrl) {
  const bytes=new TextEncoder().encode(JSON.stringify(payload));
  return {
    ok:true,redirected:false,url:requestUrl,
    headers:{get:name=>name==="content-type"?"application/json":null},
    body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})
  };
}
function setup(config={}) {
  let time=BASE,quotaTotal=0;
  const docs=new Map(), calls={
    fetched:[],reserves:[],secrets:0,dbAcquisitions:0,transactions:0,
    reads:0,creates:0,cooldowns:0,monitor:[],failures:[]
  };
  let serial=Promise.resolve();
  const db={
    doc(p){return {path:p};},
    async runTransaction(callback){
      calls.transactions++;
      const prev=serial;let resume;
      serial=new Promise(r=>{resume=r;});
      await prev;
      try {
        if(config.failStore)throw Error("SENSITIVE_FIRESTORE_ERROR");
        const pending=[];
        const result=await callback({
          async get(ref){
            calls.reads++;
            return {exists:docs.has(ref.path),
              data:()=>docs.has(ref.path)?structuredClone(docs.get(ref.path)):undefined};
          },
          create(ref,value){calls.creates++;pending.push([ref.path,structuredClone(value)]);}
        });
        for(const [p,value] of pending){
          if(docs.has(p))throw Error("create-only violation");
          docs.set(p,value);
        }
        return result;
      }finally{resume();}
    }
  };
  const dependencies={
    enabled:config.enabled ?? true,
    ownerUid:"synthetic-owner",
    now:()=>time,
    reserveDiagnosticRequests:async n=>{
      calls.reserves.push(n);
      if(config.failBudget || quotaTotal+n>6)throw Error("BUDGET_BLOCKED");
      quotaTotal+=n;
    },
    getProviderApiKey:()=>{calls.secrets++;return "SYNTHETIC_PRIVATE_KEY";},
    getFirestore:()=>{
      calls.dbAcquisitions++;
      if(config.failDb)throw Error("SENSITIVE_DB_CONSTRUCTION_ERROR");
      return db;
    },
    fetchImpl:async (url,options)=>{
      calls.fetched.push({url,options});
      if(config.failHttp)throw Error("SENSITIVE_UPSTREAM_ERROR");
      const isCatalogue=new URL(url).pathname==="/v4/markets";
      return fakeStreamResponse(isCatalogue ? (config.catalogue??CATALOGUE)
        : (config.odds??odds()),url);
    },
    makeSignal:ms=>({syntheticAbortAfterMs:ms}),
    waitBetweenRequests:async()=>{calls.cooldowns++;},
    onFailure:reason=>calls.failures.push(reason),
    onEvidenceOutcome:status=>calls.monitor.push(status)
  };
  const run=makeOfflineManualEvidenceIntegration(dependencies);
  return {run,docs,calls,dependencies,
    advance:m=>{time+=m*60000;},
    reserved:()=>quotaTotal};
}

test("D11 default disabled refuses calls before any injected effect or secrets",async()=>{
 const run=makeOfflineManualEvidenceIntegration();
 await assert.rejects(run(OWNER),e=>e.code==="failed-precondition");
 assert.equal(typeof run,"function");
 assert.equal(Object.isFrozen(run),true);
});
test("D11 disabled ignores supplied effects even for an authenticated owner",async()=>{
 let touched=0;
 const run=makeOfflineManualEvidenceIntegration({
   enabled:false,fetchImpl:()=>{touched++;},
   getProviderApiKey:()=>{touched++;},
   reserveDiagnosticRequests:()=>{touched++;},
   getFirestore:()=>{touched++;}
 });
 await assert.rejects(run(OWNER),/disabled/);
 await assert.rejects(run({auth:{uid:"intruder"}}),/disabled/);
 assert.equal(touched,0);
});
test("D11 fail closed on invalid config or browser-looking override fields",()=>{
 for(const bad of [null,[],{enabled:"true"}, {enabled:1},
  {enabled:true,host:"evil.example"}, {enabled:false,autoPoll:true},
  {enabled:true,clientUid:"intruder"}])
   assert.throws(()=>makeOfflineManualEvidenceIntegration(bad),
     /Invalid backend integration configuration/);
});
test("D11 enabled mode requires all trusted server dependencies",()=>{
 for(const bad of [{enabled:true},{enabled:true,ownerUid:"synthetic-owner"},
   {enabled:true,ownerUid:"synthetic-owner",fetchImpl:async()=>{}}])
   assert.throws(()=>makeOfflineManualEvidenceIntegration(bad),
     /Missing trusted enabled-integration dependencies/);
});
test("D11 enabled construction remains inert before a manual click",()=>{
 const s=setup();
 assert.deepEqual(s.calls.reserves,[]);
 assert.equal(s.calls.secrets,0);
 assert.equal(s.calls.dbAcquisitions,0);
 assert.equal(s.calls.fetched.length,0);
 assert.equal(s.docs.size,0);
});
test("D11 disabled integration does not expose re-enable, provider or db method",()=>{
 const run=makeOfflineManualEvidenceIntegration({enabled:false});
 for(const field of ["enable","fetchOdds","fetchCatalogue","receipt","db","storeBatch"])
   assert.equal(Object.hasOwn(run,field),false);
});
test("D11 wrong-owner, anonymous and unverified identity fail before budget",async()=>{
 const s=setup();
 for(const request of [null,{}, {auth:{uid:"intruder",token:{email_verified:true}},data:{}},
  {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}},
  {auth:OWNER.auth,data:{enabled:true}}, {auth:OWNER.auth,data:{bookmaker:"other"}}])
   await assert.rejects(s.run(request));
 assert.equal(s.calls.fetched.length,0);
 assert.equal(s.calls.secrets,0);
 assert.deepEqual(s.calls.reserves,[]);
 assert.equal(s.calls.dbAcquisitions,0);
});
test("D11 quota denial prevents secret access, HTTP and Firestore",async()=>{
 const s=setup({failBudget:true});
 await assert.rejects(s.run(OWNER),/BUDGET_BLOCKED/);
 assert.deepEqual(s.calls.reserves,[2]);
 assert.equal(s.calls.fetched.length,0);
 assert.equal(s.calls.secrets,0);
 assert.equal(s.calls.dbAcquisitions,0);
 assert.equal(s.calls.monitor.length,0);
});
test("D11 successful manual audit composes two fixed URLs, one receipt and one write",async()=>{
 const s=setup();
 const report=await s.run(OWNER);
 assert.equal(report.requestsUsedOnThisClick,2);
 assert.equal(report.activePriceEntries,1);
 assert.equal(report.researchSaved,false);
 assert.equal(report.pricesBookmakerVerified,false);
 assert.deepEqual(s.calls.reserves,[2]);
 assert.equal(s.calls.fetched.length,2);
 assert.equal(s.calls.secrets,2);
 assert.equal(s.calls.cooldowns,1);
 assert.equal(s.calls.dbAcquisitions,1);
 assert.equal(s.calls.transactions,1);
 assert.equal(s.calls.reads,1);
 assert.equal(s.calls.creates,1);
 assert.deepEqual(s.calls.monitor,[{status:"STORED"}]);
 const paths=s.calls.fetched.map(({url})=>new URL(url).pathname);
 assert.deepEqual(paths,["/v4/markets","/v4/odds-by-tournaments"]);
 for(const {url,options} of s.calls.fetched){
   assert.equal(new URL(url).origin,"https://api.oddspapi.io");
   assert.equal(options.redirect,"error");
   assert.equal(options.signal.syntheticAbortAfterMs,35000);
 }
 assert.equal(s.docs.size,1);
 const [record]=[...s.docs.values()];
 assert.equal(record.status,"UNREVIEWED_PROVIDER_EVIDENCE");
 assert.equal(record.records[0].fixtureId,"synthetic-d11-fixture");
 assert.deepEqual(record.records[0].participantIds,["5001","5002"]);
 assert.doesNotMatch(JSON.stringify(record),/SECRET_PLAYER|SYNTHETIC_PRIVATE_KEY|SENSITIVE_SHOULD_NOT_STORE|1\.87/);
 assert.doesNotMatch(JSON.stringify(report),/synthetic-d11-fixture|5001|SECRET_PLAYER|SYNTHETIC_PRIVATE_KEY/);
});
test("D11 cached manual clicks reuse result without any provider or store operation",async()=>{
 const s=setup();
 await s.run(OWNER);
 const repeat=await s.run(OWNER);
 assert.equal(repeat.cached,true);
 assert.equal(repeat.requestsUsedOnThisClick,0);
 assert.deepEqual(s.calls.reserves,[2]);
 assert.equal(s.calls.fetched.length,2);
 assert.equal(s.calls.transactions,1);
 assert.deepEqual(s.calls.monitor,[{status:"STORED"}]);
});
test("D11 concurrent authorized clicks deduplicate paid and storage stages",async()=>{
 const s=setup();
 const [a,b]=await Promise.all([s.run(OWNER),s.run(OWNER)]);
 assert.deepEqual(new Set([a.cached,b.cached]),new Set([false,true]));
 assert.equal(s.calls.fetched.length,2);
 assert.equal(s.calls.creates,1);
 assert.equal(s.calls.monitor.length,1);
});
test("D11 stale cache reserves only one new league call, never extra for evidence",async()=>{
 const s=setup();
 await s.run(OWNER);
 s.advance(16);
 const later=await s.run(OWNER);
 assert.equal(later.catalogueCached,true);
 assert.equal(later.requestsUsedOnThisClick,1);
 assert.deepEqual(s.calls.reserves,[2,1]);
 assert.equal(s.calls.fetched.length,3);
 assert.equal(s.calls.dbAcquisitions,1);
 assert.equal(s.docs.size,2);
 assert.deepEqual(s.calls.monitor.map(x=>x.status),["STORED","STORED"]);
});
test("D11 six-reservation cap blocks seventh upstream attempt",async()=>{
 const s=setup();
 await s.run(OWNER);
 for(let i=0;i<4;i++){s.advance(16);await s.run(OWNER);}
 assert.equal(s.reserved(),6);
 assert.equal(s.calls.fetched.length,6);
 s.advance(16);
 await assert.rejects(s.run(OWNER),/BUDGET_BLOCKED/);
 assert.equal(s.calls.fetched.length,6);
 assert.equal(s.docs.size,5);
});
test("D11 missing provider identity produces fixed no-evidence status without DB",async()=>{
 const s=setup({odds:odds({participant1Id:null})});
 const report=await s.run(OWNER);
 assert.equal(report.activePriceEntries,1);
 assert.deepEqual(s.calls.monitor,[{status:"NO_STORABLE_EVIDENCE"}]);
 assert.equal(s.calls.dbAcquisitions,0);
 assert.equal(s.docs.size,0);
});
test("D11 duplicate fixtures are not promoted into first-wins evidence",async()=>{
 const raw=odds()[0];
 const s=setup({odds:[raw,{...raw,participant2Id:"5888"}]});
 const report=await s.run(OWNER);
 assert.equal(report.totalFixtures,2);
 assert.deepEqual(s.calls.monitor,[{status:"NO_STORABLE_EVIDENCE"}]);
 assert.equal(s.calls.dbAcquisitions,0);
});
test("D11 failed catalogue validation avoids league call and evidence storage",async()=>{
 const s=setup({catalogue:[]});
 await assert.rejects(s.run(OWNER),/no usable/);
 assert.deepEqual(s.calls.reserves,[2]);
 assert.equal(s.calls.fetched.length,1);
 assert.equal(s.calls.dbAcquisitions,0);
 assert.deepEqual(s.calls.monitor,[]);
});
test("D11 provider HTTP failure fails closed with no secret/error leak or retries",async()=>{
 const s=setup({failHttp:true});
 await assert.rejects(s.run(OWNER),e=>{
   assert.match(e.message,/transport unavailable/);
   assert.doesNotMatch(e.message,/SENSITIVE_UPSTREAM_ERROR|SYNTHETIC_PRIVATE_KEY/);
   return true;
 });
 assert.equal(s.calls.fetched.length,1);
 assert.equal(s.calls.dbAcquisitions,0);
 assert.deepEqual(s.calls.monitor,[]);
});
test("D11 malformed backend database results are UNAVAILABLE but audit survives",async()=>{
 const s=setup({failDb:true});
 const report=await s.run(OWNER);
 assert.equal(report.activePriceEntries,1);
 assert.equal(report.cached,false);
 assert.deepEqual(s.calls.monitor,[{status:"UNAVAILABLE"}]);
 assert.equal(s.calls.fetched.length,2);
 assert.equal(s.docs.size,0);
});
test("D11 storage transaction failure cannot trigger extra provider calls",async()=>{
 const s=setup({failStore:true});
 const report=await s.run(OWNER);
 assert.equal(report.activePriceEntries,1);
 assert.deepEqual(s.calls.monitor,[{status:"UNAVAILABLE"}]);
 assert.equal(s.calls.fetched.length,2);
 assert.equal(s.docs.size,0);
});
test("D11 outcome is backend-only and contains no receipt, provider ID or quote",async()=>{
 const s=setup();
 await s.run(OWNER);
 const output=JSON.stringify(s.calls.monitor);
 assert.equal(output,'[{"status":"STORED"}]');
 assert.doesNotMatch(output,/SYNTHETIC|5001|5002|odds|SECRET|betano/);
});
test("D11 existing frontend, production backend, rules and quota are untouched",()=>{
 const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const source=fs.readFileSync(path.join(__dirname,"manual-evidence-integration.js"),"utf8");
 const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
 assert.doesNotMatch(prod,/manual-evidence-integration|makeOfflineManualEvidenceIntegration/);
 assert.doesNotMatch(source,/require\(["']firebase-admin|onCall\(|onSchedule\(|setInterval\(|https:\/\/api\.oddspapi\.io/);
 assert.doesNotMatch(rules,/teamEvidence|providerSnapshots/);
 assert.match(rules,/Everything else is denied by default/);
});
