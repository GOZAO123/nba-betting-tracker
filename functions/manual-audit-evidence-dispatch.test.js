"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {makeManualAuditEvidenceDispatch:dispatch} =
  require("./manual-audit-evidence-dispatch");
const {makeLeagueMarketAuditRunner}=require("./league-market-audit-runner");

const NOW=Date.parse("2026-11-17T11:00:00.000Z");
const iso=m=>new Date(NOW+m*60000).toISOString();
const OWNER={auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const CATALOGUE=[{marketId:101,sportId:11,playerProp:true,
  marketName:"Over Under Player Points (incl. overtime)",period:"result",
  handicap:20.5,outcomes:[{outcomeId:201,outcomeName:"Over"},
    {outcomeId:202,outcomeName:"Under"}]}];
const fixture=(update={})=>({
 fixtureId:"synthetic-d14-fixture",sportId:11,tournamentId:132,statusId:0,
 hasOdds:true,startTime:iso(180),participant1Id:"5001",participant2Id:"5002",
 playerName:"PRIVATE_PLAYER",apiKey:"PRIVATE_SECRET",
 bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,
  markets:{"101":{marketActive:true,outcomes:{"201":{
    players:{"301":{playerName:"PRIVATE_PLAYER",price:1.87,
      active:true,changedAt:iso(-2)}}}}}}}},...update
});
function stream(payload,url) {
 const bytes=new TextEncoder().encode(JSON.stringify(payload));
 return {ok:true,redirected:false,url,
  headers:{get:key=>key==="content-type"?"application/json":null},
  body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})
 };
}
function fakeEnabled({blockQuota=false,failNetwork=false,failStore=false,
 fixtureOverride={},response=null}={}){
 const counts={secrets:0,reserved:[],http:[],db:0,reads:0,creates:0,
  legacy:0,cooldown:0,signals:[]};
 const docs=new Map();let serial=Promise.resolve();
 const db={doc:p=>({path:p}),async runTransaction(run){
  const prev=serial;let release;
  serial=new Promise(resolve=>{release=resolve;});await prev;
  try{
   if(failStore) throw Error("PRIVATE_DATABASE_FAILURE");
   const additions=[];
   const value=await run({
     async get(ref){
       counts.reads++;
       const exists=docs.has(ref.path);
       return {exists,data:()=>exists?structuredClone(docs.get(ref.path)):undefined};
     },
     create(ref,record){counts.creates++;additions.push([ref.path,structuredClone(record)]);}
   });
   for(const [p,value] of additions){if(docs.has(p))throw Error("collision");docs.set(p,value);}
   return value;
  } finally {release();}
 }};
 const config={
   enabled:true,legacyRun:async()=>{counts.legacy++;return {source:"legacy"};},
   ownerUid:"synthetic-owner",
   reserveDiagnosticRequests:async amount=>{
     counts.reserved.push(amount);
     if(blockQuota)throw Error("quota unavailable");
   },
   getProviderApiKey:()=>{counts.secrets++;return "SYNTHETIC_KEY_DO_NOT_LOG";},
   fetchImpl:async(url,options)=>{
     counts.http.push({url,options});
     if(failNetwork) throw Error("PRIVATE_NETWORK_FAILURE");
     return stream(new URL(url).pathname==="/v4/markets"?CATALOGUE:
      (response??[fixture(fixtureOverride)]),url);
   },
   getFirestore:()=>{counts.db++;return db;},
   now:()=>NOW,
   makeSignal:ms=>({deadline:ms}),
   waitBetweenRequests:async()=>{counts.cooldown++;},
   onFailure:()=>{},
   onEvidenceOutcome:signal=>counts.signals.push(signal)
 };
 return {config,counts,docs};
}
test("D14 default-off returns the exact existing audit runner by reference",async()=>{
 const old=async request=>({report:"original",request});
 const run=dispatch({legacyRun:old});
 assert.equal(run,old);
 const r=await run(OWNER);
 assert.equal(r.report,"original");
 assert.equal(r.request,OWNER);
});
test("D14 explicit false never consults secrets, database or provider adapters",async()=>{
 let effects=0;
 const old=async()=>({cached:true,requestsUsedOnThisClick:0});
 const run=dispatch({enabled:false,legacyRun:old,
  ownerUid:"synthetic-owner",
  reserveDiagnosticRequests:async()=>{effects++;throw Error("should not run");},
  getProviderApiKey:()=>{effects++;throw Error("should not run");},
  getFirestore:()=>{effects++;throw Error("should not run");},
  fetchImpl:async()=>{effects++;throw Error("should not run");},
  waitBetweenRequests:async()=>{effects++;throw Error("should not run");},
  onEvidenceOutcome:()=>{effects++;throw Error("should not run");}
 });
 assert.equal(run,old);
 assert.deepEqual(await run(OWNER),{cached:true,requestsUsedOnThisClick:0});
 assert.equal(effects,0);
});
test("D14 off-state preserves existing cached and concurrent runner semantics",async()=>{
 let calls=0;
 const old=makeLeagueMarketAuditRunner({
  ownerUid:"synthetic-owner",now:()=>NOW,
  reserve:async()=>{calls++;},
  fetchCatalogue:async()=>CATALOGUE,
  fetchOdds:async()=>[fixture()]
 });
 const run=dispatch({enabled:false,legacyRun:old});
 const results=await Promise.all([run(OWNER),run(OWNER)]);
 assert.deepEqual(new Set(results.map(x=>x.cached)),new Set([true,false]));
 assert.equal(calls,1);
 assert.equal((await run(OWNER)).cached,true);
});
test("D14 invalid configuration is rejected, not silently enabled",()=>{
 const old=async()=>{};
 for(const invalid of [null,[],{enabled:true},
   {legacyRun:"not-function"},{legacyRun:old,enabled:"true"},
   {legacyRun:old,enabled:1},
   {legacyRun:old,enabled:false,host:"untrusted.example"},
   {legacyRun:old,enableFromClient:true}]){
  assert.throws(()=>dispatch(invalid),/Invalid trusted evidence dispatch configuration/);
 }
});
test("D14 enabled routing fails closed without trusted Firebase/HTTP dependencies",()=>{
 assert.throws(()=>dispatch({enabled:true,legacyRun:async()=>{}}),
  /Missing trusted enabled-integration dependencies/);
});
test("D14 enabled runner constructs without a secret, request or database operation",()=>{
 const s=fakeEnabled();
 const runner=dispatch(s.config);
 assert.equal(typeof runner,"function");
 assert.equal(s.counts.secrets,0);
 assert.equal(s.counts.http.length,0);
 assert.deepEqual(s.counts.reserved,[]);
 assert.equal(s.counts.db,0);
});
test("D14 wrong owner, unverified identity, and client overrides cannot call provider",async()=>{
 const s=fakeEnabled(),run=dispatch(s.config);
 for(const invalid of [null,{}, {auth:{uid:"stranger",token:{email_verified:true}},data:{}},
  {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}},
  {auth:OWNER.auth,data:{enabled:true}}, {auth:OWNER.auth,data:{fixtureId:"x"}}]){
  await assert.rejects(run(invalid));
 }
 assert.deepEqual(s.counts.reserved,[]);
 assert.equal(s.counts.secrets,0);
 assert.equal(s.counts.http.length,0);
 assert.equal(s.counts.db,0);
});
test("D14 denied transactional reservation blocks HTTP and secret access",async()=>{
 const s=fakeEnabled({blockQuota:true}),run=dispatch(s.config);
 await assert.rejects(run(OWNER),/quota unavailable/);
 assert.deepEqual(s.counts.reserved,[2]);
 assert.equal(s.counts.secrets,0);
 assert.equal(s.counts.http.length,0);
 assert.equal(s.counts.db,0);
});
test("D14 fake enabled path reuses exactly two manual provider calls and stores one sanitized snapshot",async()=>{
 const s=fakeEnabled(),run=dispatch(s.config);
 const report=await run(OWNER);
 assert.equal(report.activePriceEntries,1);
 assert.equal(report.requestsUsedOnThisClick,2);
 assert.equal(report.researchSaved,false);
 assert.equal(report.pricesBookmakerVerified,false);
 assert.deepEqual(s.counts.reserved,[2]);
 assert.equal(s.counts.http.length,2);
 assert.equal(s.counts.secrets,2);
 assert.equal(s.counts.cooldown,1);
 assert.equal(s.counts.db,1);
 assert.equal(s.counts.reads,1);
 assert.equal(s.counts.creates,1);
 assert.equal(s.counts.legacy,0);
 assert.deepEqual(s.counts.signals,[{status:"STORED"}]);
 assert.deepEqual(s.counts.http.map(x=>new URL(x.url).pathname),
  ["/v4/markets","/v4/odds-by-tournaments"]);
 assert.ok(s.counts.http.every(x=>new URL(x.url).origin==="https://api.oddspapi.io"));
 assert.ok(s.counts.http.every(x=>x.options.redirect==="error"));
 assert.equal(s.docs.size,1);
 const snapshot=[...s.docs.values()][0];
 assert.equal(snapshot.status,"UNREVIEWED_PROVIDER_EVIDENCE");
 assert.deepEqual(snapshot.records[0].participantIds,["5001","5002"]);
 assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_PLAYER|PRIVATE_SECRET|1\.87|SYNTHETIC_KEY/);
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE_PLAYER|PRIVATE_SECRET|5001|5002|SYNTHETIC_KEY/);
});
test("D14 fake enabled cache neither reserves nor fetches nor writes again",async()=>{
 const s=fakeEnabled(),run=dispatch(s.config);
 await run(OWNER);
 const r=await run(OWNER);
 assert.equal(r.cached,true);
 assert.equal(r.requestsUsedOnThisClick,0);
 assert.deepEqual(s.counts.reserved,[2]);
 assert.equal(s.counts.http.length,2);
 assert.equal(s.counts.creates,1);
 assert.equal(s.counts.signals.length,1);
});
test("D14 fake enabled concurrent clicks share the same reserved response",async()=>{
 const s=fakeEnabled(),run=dispatch(s.config);
 const result=await Promise.all([run(OWNER),run(OWNER)]);
 assert.deepEqual(new Set(result.map(x=>x.cached)),new Set([false,true]));
 assert.deepEqual(s.counts.reserved,[2]);
 assert.equal(s.counts.http.length,2);
 assert.equal(s.counts.creates,1);
});
test("D14 absent participant ID never opens Firestore or promotes a mapping",async()=>{
 const s=fakeEnabled({fixtureOverride:{participant1Id:null}}),run=dispatch(s.config);
 const report=await run(OWNER);
 assert.equal(report.activePriceEntries,1);
 assert.deepEqual(s.counts.signals,[{status:"NO_STORABLE_EVIDENCE"}]);
 assert.equal(s.counts.db,0);
 assert.equal(s.docs.size,0);
});
test("D14 storage failures cannot retry the provider or leak backend error",async()=>{
 const s=fakeEnabled({failStore:true}),run=dispatch(s.config);
 const report=await run(OWNER);
 assert.equal(report.activePriceEntries,1);
 assert.equal(s.counts.http.length,2);
 assert.deepEqual(s.counts.signals,[{status:"UNAVAILABLE"}]);
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE_DATABASE_FAILURE/);
 assert.equal(s.docs.size,0);
});
test("D14 network failure never retries or writes a record",async()=>{
 const s=fakeEnabled({failNetwork:true}),run=dispatch(s.config);
 await assert.rejects(run(OWNER),error=>{
  assert.match(error.message,/transport unavailable/);
  assert.doesNotMatch(error.message,/PRIVATE_NETWORK_FAILURE|SYNTHETIC_KEY/);
  return true;
 });
 assert.equal(s.counts.http.length,1);
 assert.equal(s.counts.db,0);
});
test("D14 production code keeps the explicit backend gate FALSE and legacy callable",()=>{
 const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 assert.match(prod,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
 assert.match(prod,/require\(["']\.\/manual-audit-evidence-dispatch["']\)/);
 assert.match(prod,/enabled:\s*NBA_PROVIDER_EVIDENCE_ENABLED/);
 assert.match(prod,/legacyRun:\s*runNbaMarketAudit/);
 assert.match(prod,/return await runNbaMarketAuditRouted\(request\)/);
 assert.match(prod,/exports\.oddsPapiNbaMarketAudit\s*=\s*onCall\(/);
 assert.match(prod,/maxInstances:\s*1,\s*concurrency:\s*1,\s*timeoutSeconds:\s*120/);
 assert.match(prod,/waitBetweenRequests:\s*\(\)\s*=>\s*new Promise\(resolve\s*=>\s*setTimeout\(resolve,\s*1200\)\)/);
 assert.match(prod,/const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;/);
 assert.doesNotMatch(prod,/process\.env\.NBA_PROVIDER_EVIDENCE|request\.data\??\.enabled/);
});
test("D14 never creates a new Cloud Function, schedule or browser write rule",()=>{
 const source=fs.readFileSync(path.join(__dirname,"manual-audit-evidence-dispatch.js"),"utf8");
 const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
 assert.doesNotMatch(source,/onCall\(|onSchedule\(|setInterval\(|https:\/\/api|firebase-admin|firebase-functions/);
 assert.doesNotMatch(rules,/teamEvidence|providerSnapshots/);
 assert.match(rules,/Everything else is denied by default/);
});
