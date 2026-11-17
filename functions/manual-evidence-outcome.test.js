"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const {makeLeagueMarketAuditRunner} = require("./league-market-audit-runner");
const {makeOfflineManualEvidenceAudit} = require("./manual-evidence-receipt");

const NOW = Date.parse("2026-11-17T10:00:00.000Z");
const iso = m => new Date(NOW + m * 60000).toISOString();
const owner = {auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const CATALOGUE = [{
  marketId:101,sportId:11,playerProp:true,
  marketName:"Over Under Player Points (incl. overtime)",
  period:"result",handicap:20.5,
  outcomes:[{outcomeId:201,outcomeName:"Over"},
    {outcomeId:202,outcomeName:"Under"}]
}];
const fixture=(change={})=>({
  fixtureId:"synthetic-d10-fixture",sportId:11,tournamentId:132,
  statusId:0,hasOdds:true,startTime:iso(180),
  participant1Id:"5101",participant2Id:"5102",
  apiKey:"DO_NOT_LOG_SECRET",teamName:"PRIVATE_TEAM_NAME",
  bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,
    markets:{"101":{marketActive:true,outcomes:{"201":{
      players:{"301":{playerName:"PRIVATE_PLAYER_NAME",active:true,
        price:1.87,changedAt:iso(-2)}}}}}}}},...change
});

function offlineRunner(options={}){
  const {odds=[fixture()],sinkThrows=false,monitorThrows=false,
    failedBudget=false,failedCatalogue=false,failedOdds=false,
    withMonitor=true}=options;
  const result=Object.hasOwn(options,"result") ? options.result : {status:"STORED"};
  const seen=[];
  let requests=0, reserves=0, oddsCalls=0, sinkCalls=0;
  const run=makeLeagueMarketAuditRunner({
    ownerUid:"synthetic-owner",now:()=>NOW,
    reserve:async()=>{reserves++;if(failedBudget)throw Error("budget exhausted");},
    fetchCatalogue:async()=>{requests++;if(failedCatalogue)throw Error("catalogue unavailable");return CATALOGUE;},
    fetchOdds:async()=>{requests++;oddsCalls++;if(failedOdds)throw Error("provider unavailable");return odds;},
    onProviderEvidence:async()=>{
      sinkCalls++;
      if(sinkThrows)throw Error("PRIVATE_STORE_ERROR");
      return result;
    },
    ...(withMonitor?{onEvidenceOutcome:async data=>{
      seen.push(data);
      if(monitorThrows)throw Error("PRIVATE_TELEMETRY_ERROR");
    }}:{})
  });
  return {run,seen,stats:()=>({requests,reserves,oddsCalls,sinkCalls})};
}

test("D10 emits one fixed STORED status after successful authenticated manual fetch",async()=>{
 const s=offlineRunner();
 const result=await s.run(owner);
 assert.equal(result.activePriceEntries,1);
 assert.equal(result.requestsUsedOnThisClick,2);
 assert.deepEqual(s.seen,[{status:"STORED"}]);
 assert.equal(Object.isFrozen(s.seen[0]),true);
 assert.equal(Object.keys(s.seen[0]).length,1);
 assert.equal(s.stats().oddsCalls,1);
 assert.doesNotMatch(JSON.stringify(result),/status.*STORED|DO_NOT_LOG_SECRET|PRIVATE_PLAYER_NAME|5101/);
});
test("D10 repeated cached click cannot rerun monitoring or provider",async()=>{
 const s=offlineRunner();
 await s.run(owner);
 const cached=await s.run(owner);
 assert.equal(cached.cached,true);
 assert.equal(cached.requestsUsedOnThisClick,0);
 assert.deepEqual(s.seen,[{status:"STORED"}]);
 assert.equal(s.stats().oddsCalls,1);
});
test("D10 concurrent manual clicks share one safe signal",async()=>{
 const s=offlineRunner();
 const both=await Promise.all([s.run(owner),s.run(owner)]);
 assert.deepEqual(new Set(both.map(x=>x.cached)),new Set([true,false]));
 assert.equal(s.seen.length,1);
 assert.equal(s.stats().oddsCalls,1);
});
test("D10 missing participant IDs are NO_STORABLE_EVIDENCE, not a fake success",async()=>{
 const s=offlineRunner({odds:[fixture({participant1Id:null})]});
 const r=await s.run(owner);
 assert.equal(r.activePriceEntries,1);
 assert.deepEqual(s.seen,[{status:"NO_STORABLE_EVIDENCE"}]);
 assert.equal(s.stats().sinkCalls,0);
});
test("D10 duplicate fixture IDs fail closed with no first-wins evidence",async()=>{
 const s=offlineRunner({odds:[fixture(),fixture({participant2Id:"5200"})]});
 await s.run(owner);
 assert.deepEqual(s.seen,[{status:"NO_STORABLE_EVIDENCE"}]);
 assert.equal(s.stats().sinkCalls,0);
});
test("D10 oversized evidence subset is not truncated or persisted",async()=>{
 const inputs=Array.from({length:65},(_,i)=>fixture({
   fixtureId:"synthetic-d10-"+i,
   participant1Id:String(6000+2*i),participant2Id:String(6001+2*i)
 }));
 const s=offlineRunner({odds:inputs});
 await s.run(owner);
 assert.deepEqual(s.seen,[{status:"NO_STORABLE_EVIDENCE"}]);
 assert.equal(s.stats().sinkCalls,0);
});
test("D10 reports each allowed storage result as a single sanitized status",async()=>{
 for(const status of ["STORED","ALREADY_STORED","CONFLICT","DENIED",
   "INVALID_BATCH","UNAVAILABLE"]) {
   const s=offlineRunner({result:{status}});
   await s.run(owner);
   assert.deepEqual(s.seen,[{status}]);
 }
});
test("D10 does not forward untrusted sink fields, even if status is otherwise valid",async()=>{
 const s=offlineRunner({result:{status:"STORED",secret:"DO_NOT_LOG_SECRET"}});
 await s.run(owner);
 assert.deepEqual(s.seen,[{status:"SINK_RESULT_INVALID"}]);
});
test("D10 rejects unexpected storage status and cannot echo secrets",async()=>{
 const s=offlineRunner({result:{status:"SECRET_PROVIDER_RESPONSE"}});
 const result=await s.run(owner);
 assert.deepEqual(s.seen,[{status:"SINK_RESULT_INVALID"}]);
 assert.doesNotMatch(JSON.stringify(s.seen)+JSON.stringify(result),/SECRET_PROVIDER_RESPONSE/);
});
test("D10 malformed status from sink uses a safe fallback",async()=>{
 for(const value of [null,undefined,[],{}, {status:123}, {status:"SUCCEEDED"}]) {
   const s=offlineRunner({result:value});
   await s.run(owner);
   assert.deepEqual(s.seen,[{status:"SINK_RESULT_INVALID"}]);
 }
});
test("D10 rejected or throwing sink is reported safely without paid retry",async()=>{
 const s=offlineRunner({sinkThrows:true});
 const report=await s.run(owner);
 assert.equal(report.activePriceEntries,1);
 assert.deepEqual(s.seen,[{status:"SINK_EXCEPTION"}]);
 assert.equal(s.stats().oddsCalls,1);
});
test("D10 monitor failure cannot fail the audit, change report or retry provider",async()=>{
 const s=offlineRunner({monitorThrows:true});
 const report=await s.run(owner);
 assert.equal(report.activePriceEntries,1);
 assert.equal(report.cached,false);
 assert.equal(s.stats().oddsCalls,1);
 assert.equal(s.seen.length,1);
 assert.doesNotMatch(JSON.stringify(report),/TELEMETRY_ERROR/);
});
test("D10 anonymous, wrong-owner and spoofed caller never emit outcome",async()=>{
 const s=offlineRunner();
 for(const request of [null,{}, {auth:{uid:"someone-else",
   token:{email_verified:true}},data:{}},
   {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}},
   {auth:owner.auth,data:{status:"STORED"}}])
   await assert.rejects(s.run(request));
 assert.deepEqual(s.seen,[]);
 assert.deepEqual(s.stats(),{requests:0,reserves:0,oddsCalls:0,sinkCalls:0});
});
test("D10 blocked quota does not fetch provider, storage or monitoring",async()=>{
 const s=offlineRunner({failedBudget:true});
 await assert.rejects(s.run(owner),/budget exhausted/);
 assert.deepEqual(s.seen,[]);
 assert.equal(s.stats().requests,0);
 assert.equal(s.stats().sinkCalls,0);
});
test("D10 failed catalogue stops before identity processing and monitoring",async()=>{
 const s=offlineRunner({failedCatalogue:true});
 await assert.rejects(s.run(owner),/catalogue unavailable/);
 assert.deepEqual(s.seen,[]);
 assert.equal(s.stats().oddsCalls,0);
});
test("D10 failed league fetch never creates a source receipt or monitoring signal",async()=>{
 const s=offlineRunner({failedOdds:true});
 await assert.rejects(s.run(owner),/provider unavailable/);
 assert.deepEqual(s.seen,[]);
 assert.equal(s.stats().oddsCalls,1);
 assert.equal(s.stats().sinkCalls,0);
});
test("D10 outcome callback cannot be configured without evidence store",()=>{
 assert.throws(()=>makeLeagueMarketAuditRunner({
   ownerUid:"synthetic-owner",reserve:async()=>{},
   fetchCatalogue:async()=>CATALOGUE,fetchOdds:async()=>[fixture()],
   onEvidenceOutcome:async()=>{}
 }),/Missing league market audit dependencies/);
});
test("D10 rejects invalid monitoring dependencies on both factories",()=>{
 assert.throws(()=>makeLeagueMarketAuditRunner({
   ownerUid:"synthetic-owner",reserve:async()=>{},
   fetchCatalogue:async()=>CATALOGUE,fetchOdds:async()=>[fixture()],
   onProviderEvidence:async()=>({status:"STORED"}),onEvidenceOutcome:{}
 }),/Missing league market audit dependencies/);
 assert.throws(()=>makeOfflineManualEvidenceAudit({
   ownerUid:"synthetic-owner",reserve:async()=>{},
   fetchCatalogue:async()=>CATALOGUE,fetchOdds:async()=>[fixture()],
   db:{doc:path=>({path}),runTransaction:async()=>{}},
   onEvidenceOutcome:{}
 }),/Missing trusted manual audit dependencies/);
});
test("D10 monitoring can be entirely disabled by default",async()=>{
 const s=offlineRunner({withMonitor:false});
 const report=await s.run(owner);
 assert.equal(report.activePriceEntries,1);
 assert.equal(s.stats().oddsCalls,1);
 assert.deepEqual(s.seen,[]);
});
test("D10 trusted D8 integration emits STORED after one mock Firestore transaction",async()=>{
 const docs=new Map(),signals=[],calls={reserves:0,odds:0,creates:0};
 const db={doc:p=>({path:p}),runTransaction:async fn=>{
   const toWrite=[];
   const value=await fn({
     get:async ref=>({exists:docs.has(ref.path),data:()=>docs.get(ref.path)}),
     create:(ref,data)=>{calls.creates++;toWrite.push([ref.path,data]);}
   });
   for(const [p,d] of toWrite){if(docs.has(p))throw Error("collision");docs.set(p,d);}
   return value;
 }};
 const run=makeOfflineManualEvidenceAudit({
   ownerUid:"synthetic-owner",db,now:()=>NOW,
   reserve:async()=>{calls.reserves++;},
   fetchCatalogue:async()=>CATALOGUE,
   fetchOdds:async()=>{calls.odds++;return [fixture()];},
   onEvidenceOutcome:async data=>signals.push(data)
 });
 const a=await run(owner),b=await run(owner);
 assert.equal(a.activePriceEntries,1);
 assert.equal(b.cached,true);
 assert.deepEqual(signals,[{status:"STORED"}]);
 assert.equal(calls.reserves,1);
 assert.equal(calls.odds,1);
 assert.equal(calls.creates,1);
 assert.equal(docs.size,1);
 assert.doesNotMatch(JSON.stringify(signals),/synthetic-d10|5101|PRIVATE_/);
});
test("D10 D8 integration reports UNAVAILABLE on read-only/storage failure",async()=>{
 const signals=[];
 const run=makeOfflineManualEvidenceAudit({
   ownerUid:"synthetic-owner",now:()=>NOW,
   reserve:async()=>{},fetchCatalogue:async()=>CATALOGUE,
   fetchOdds:async()=>[fixture()],
   db:{doc:p=>({path:p}),runTransaction:async()=>{throw Error("SECRET_STORAGE_ERROR");}},
   onEvidenceOutcome:async data=>signals.push(data)
 });
 const result=await run(owner);
 assert.equal(result.activePriceEntries,1);
 assert.deepEqual(signals,[{status:"UNAVAILABLE"}]);
 assert.doesNotMatch(JSON.stringify(result),/SECRET_STORAGE_ERROR/);
});
test("D10 D8 integration exposes one safe NO_STORABLE_EVIDENCE on missing IDs",async()=>{
 const seen=[];
 const run=makeOfflineManualEvidenceAudit({
   ownerUid:"synthetic-owner",now:()=>NOW,
   reserve:async()=>{},fetchCatalogue:async()=>CATALOGUE,
   fetchOdds:async()=>[fixture({participant1Id:null})],
   db:{doc:p=>({path:p}),runTransaction:async()=>{throw Error("unreachable");}},
   onEvidenceOutcome:async result=>seen.push(result)
 });
 const report=await run(owner);
 assert.equal(report.activePriceEntries,1);
 assert.deepEqual(seen,[{status:"NO_STORABLE_EVIDENCE"}]);
});
test("D10 never activates or exports production evidence monitoring or polling",()=>{
 const production=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const source=fs.readFileSync(path.join(__dirname,"league-market-audit-runner.js"),"utf8");
 // The D14 production router may configure fixed-enum monitoring adapters,
 // but its hard-coded false switch keeps the live evidence sink inert.
 assert.match(production,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
 assert.match(production,/enabled:\s*NBA_PROVIDER_EVIDENCE_ENABLED/);
 assert.doesNotMatch(production,/require\(["']\.\/manual-evidence-outcome/);
 assert.doesNotMatch(source,/onSchedule\(|setInterval\(|https:\/\/api\.oddspapi\.io/);
});
