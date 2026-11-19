"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {makeOfflineDualQuotaGuard}=require("./offline-identity-quota-dual-guard");
const NOW=Date.parse("2026-11-19T12:30:00.000Z");
const DAY="2026-11-19";
const unavailable=e=>e?.code==="unavailable"&&
  e.message==="Shared daily diagnostic reservation unavailable. No provider request authorized.";
const rejectUnavailable=p=>assert.rejects(p,unavailable);
function fixture({oldCount=0,newCount=0,now=()=>NOW,
  legacyFailure=false,metadataFailure=false,
  legacyOverride=null,metadataOverride=null}={}){
 const events=[],counts={legacy:oldCount,metadata:newCount};
 const reserveLegacy=async amount=>{
   events.push(["legacy",amount]);
   if(legacyFailure)throw Error("SYNTHETIC_FIRESTORE_PRIVATE_TOKEN");
   if(counts.legacy+amount>6)throw Error("FIRESTORE_EXHAUSTED");
   counts.legacy+=amount;
   return legacyOverride||{utcDay:DAY,remaining:6-counts.legacy};
 };
 const reserveMetadata=async amount=>{
   events.push(["metadata",amount]);
   if(metadataFailure)throw Error("SYNTHETIC_SECRET_MANAGER_PRIVATE_KEY");
   if(counts.metadata+amount>6)throw Error("METADATA_EXHAUSTED");
   counts.metadata+=amount;
   return metadataOverride||{utcDay:DAY,remaining:6-counts.metadata};
 };
 return {events,counts,
   run:makeOfflineDualQuotaGuard({reserveFirestore:reserveLegacy,
     reserveMetadata,now})};
}
test("D15.11 factory is inert and creates no reservations",()=>{
 const x=fixture();
 assert.equal(typeof x.run,"function");
 assert.equal(Object.isFrozen(x.run),true);
 assert.deepEqual(x.events,[]);
});
test("D15.11 one slot reserves Firestore first then metadata and freezes acknowledgement",async()=>{
 const x=fixture(),ack=await x.run(1);
 assert.deepEqual(ack,{utcDay:DAY,remaining:5});
 assert.equal(Object.isFrozen(ack),true);
 assert.deepEqual(x.events,[["legacy",1],["metadata",1]]);
 assert.deepEqual(x.counts,{legacy:1,metadata:1});
});
test("D15.11 two-slot legacy diagnostics share the same order and ceiling",async()=>{
 const x=fixture();
 assert.deepEqual(await x.run(2),{utcDay:DAY,remaining:4});
 assert.deepEqual(await x.run(2),{utcDay:DAY,remaining:2});
 assert.deepEqual(await x.run(2),{utcDay:DAY,remaining:0});
 await rejectUnavailable(x.run(2));
 assert.deepEqual(x.counts,{legacy:6,metadata:6});
 assert.equal(x.events.filter(e=>e[0]==="metadata").length,3);
});
test("D15.11 mixed one/two reservations never exceed shared six slots",async()=>{
 const x=fixture();
 for(const amount of [1,2,1,2])await x.run(amount);
 await rejectUnavailable(x.run(1));
 assert.deepEqual(x.counts,{legacy:6,metadata:6});
});
test("D15.11 a nonempty legacy counter and newer metadata counter return the safer remainder",async()=>{
 const x=fixture({oldCount:1,newCount:3});
 assert.deepEqual(await x.run(1),{utcDay:DAY,remaining:2});
 assert.deepEqual(x.counts,{legacy:2,metadata:4});
});
test("D15.11 rejected amount never opens either budget backend",async()=>{
 const x=fixture();
 for(const amount of [0,-1,3,7,"1",1.5,null,undefined,{},NaN])
   await assert.rejects(x.run(amount),e=>e.code==="invalid-argument");
 assert.deepEqual(x.events,[]);
});
test("D15.11 legacy failure prevents metadata reservation and paid authorization",async()=>{
 const x=fixture({legacyFailure:true});
 await rejectUnavailable(x.run(1));
 assert.deepEqual(x.events,[["legacy",1]]);
 assert.deepEqual(x.counts,{legacy:0,metadata:0});
});
test("D15.11 metadata failure wastes one Firestore slot but never retries",async()=>{
 const x=fixture({metadataFailure:true});
 await rejectUnavailable(x.run(1));
 assert.deepEqual(x.events,[["legacy",1],["metadata",1]]);
 assert.deepEqual(x.counts,{legacy:1,metadata:0});
});
test("D15.11 a malformed legacy receipt fails before metadata access",async()=>{
 const variants=[null,{},[],{utcDay:DAY},
  {utcDay:DAY,remaining:"5"},{utcDay:DAY,remaining:6},
  {utcDay:DAY,remaining:5,apiKey:"SYNTHETIC_PRIVATE_KEY"},
  {utcDay:"2026-02-30",remaining:4},
  {utcDay:"2026-11-18",remaining:5}];
 for(const receipt of variants){
   const x=fixture({legacyOverride:receipt||{}});
   await rejectUnavailable(x.run(1));
   assert.equal(x.events.length,1);
 }
});
test("D15.11 metadata receipt must match the same UTC day and exact schema",async()=>{
 const variants=[{},[],{utcDay:DAY},{utcDay:"2026-11-20",remaining:4},
   {utcDay:DAY,remaining:Infinity},{utcDay:DAY,remaining:-1},
   {utcDay:DAY,remaining:6},{utcDay:DAY,remaining:4,extra:true}];
 for(const receipt of variants){
   const x=fixture({metadataOverride:receipt});
   await rejectUnavailable(x.run(1));
   assert.deepEqual(x.events,[["legacy",1],["metadata",1]]);
 }
});
test("D15.11 cross-midnight completion denies even two successful backend commits",async()=>{
 let clock=0;
 const x=fixture({now:()=>{
   clock++;
   return clock===1?Date.parse("2026-11-19T23:59:59.999Z"):
     Date.parse("2026-11-20T00:00:00.001Z");
 }});
 await rejectUnavailable(x.run(1));
 assert.deepEqual(x.counts,{legacy:1,metadata:1});
 assert.equal(x.events.length,2);
});
test("D15.11 invalid UTC clock fails before any external reservation",async()=>{
 for(const now of [
   ()=>NaN,()=>Infinity,()=>-1,()=>1.1,
   ()=>{throw Error("SYNTHETIC_PRIVATE_CLOCK");}
 ]){
   const x=fixture({now});
   await rejectUnavailable(x.run(1));
   assert.deepEqual(x.events,[]);
 }
});
test("D15.11 a late malformed clock still denies both committed reservations",async()=>{
 let tick=0;
 const x=fixture({now:()=>++tick===1?NOW:NaN});
 await rejectUnavailable(x.run(1));
 assert.deepEqual(x.counts,{legacy:1,metadata:1});
});
test("D15.11 concurrent requests cannot overdraw either synthetic shared budget",async()=>{
 const x=fixture();
 const all=await Promise.allSettled(
   Array.from({length:9},()=>x.run(1)));
 assert.equal(all.filter(r=>r.status==="fulfilled").length,6);
 assert.equal(all.filter(r=>r.status==="rejected").length,3);
 assert.deepEqual(x.counts,{legacy:6,metadata:6});
});
test("D15.11 an ambiguous second write could commit and still fails closed",async()=>{
 let legacy=0,metadata=0,calls=0;
 const run=makeOfflineDualQuotaGuard({
   now:()=>NOW,
   reserveFirestore:async amount=>{
     legacy+=amount;return{utcDay:DAY,remaining:6-legacy};
   },
   reserveMetadata:async amount=>{
     calls++;metadata+=amount;
     throw Error("SYNTHETIC_NETWORK_AFTER_COMMIT");
   }
 });
 await rejectUnavailable(run(1));
 assert.equal(legacy,1);assert.equal(metadata,1);assert.equal(calls,1);
});
test("D15.11 dangerous incoming getter and receipt prototype fail closed",async()=>{
 const bad=new Proxy({utcDay:DAY,remaining:5},{
   getPrototypeOf(){throw Error("SYNTHETIC_PRIVATE_PROXY");}
 });
 const x=fixture({legacyOverride:bad});
 await rejectUnavailable(x.run(1));
 assert.equal(x.events.length,1);
});
test("D15.11 no deployed import, credential, or automatic paid request",()=>{
 const production=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const implementation=fs.readFileSync(path.join(__dirname,
   "offline-identity-quota-dual-guard.js"),"utf8");
 assert.doesNotMatch(production,/offline-identity-quota-dual-guard/);
 assert.match(production,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
 assert.match(production,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
 assert.match(production,/const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;/);
 assert.doesNotMatch(implementation,/require\(["'](?:firebase-|@google-cloud|google-auth-library)/);
 assert.doesNotMatch(implementation,/fetch\(|onCall\(|onRequest\(|setInterval\(/);
});
