"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {RESOURCE_NAME,STATE_KEY,LIMIT,
  makeOfflineSecretMetadataQuotaReservation:makeReserve}=
  require("./offline-identity-quota-secret-metadata");

const NOW=Date.parse("2026-11-19T09:30:00.000Z");
const makeState=(day="2026-11-19",reserved=0)=>({
  schemaVersion:1,utcDay:day,reserved,limit:LIMIT
});
function fixture({initial=makeState(),clock=()=>NOW,
  getFailure=false,updateFailure=false,returnWrongReceipt=false}={}){
  let etag='"e1"',state=initial,successfulWrites=0;
  const events={gets:[],updates:[],writes:0};
  const getSecret=async request=>{
    events.gets.push(request);
    if(getFailure)throw Error("PRIVATE_SECRET_MANAGER_GET_FAILURE");
    return {name:RESOURCE_NAME,etag,
      annotations:{[STATE_KEY]:JSON.stringify(state)}};
  };
  const updateSecret=async request=>{
    events.updates.push(request);
    if(updateFailure)throw Error("PRIVATE_ETAG_AMBIGUOUS_WRITE");
    if(request.secret.etag!==etag)throw Error("FAILED_PRECONDITION");
    if(request.secret.name!==RESOURCE_NAME||
       JSON.stringify(request.updateMask)!=='{"paths":["annotations"]}')
      throw Error("Untrusted update");
    const encoded=request.secret.annotations[STATE_KEY];
    const next=JSON.parse(encoded);
    assert.ok(next.reserved<=LIMIT);
    state=next;
    successfulWrites++;events.writes++;
    etag='"e'+(successfulWrites+1)+'"';
    return returnWrongReceipt?{name:RESOURCE_NAME,etag,
      annotations:{[STATE_KEY]:"invalid"}}:
      {name:RESOURCE_NAME,etag,annotations:{[STATE_KEY]:encoded}};
  };
  const reserve=makeReserve({getSecret,updateSecret,now:clock});
  return {reserve,events,get:()=>({etag,state,successfulWrites})};
}
const unavailable=err=>err instanceof Error&&
  err.message==="Shared diagnostic metadata quota unavailable."&&
  !/PRIVATE|FAILED_PRECONDITION|token|key/.test(err.message);
const expectBlocked=promise=>assert.rejects(promise,unavailable);

test("D15.10 creates no metadata operations during factory construction",()=>{
 const x=fixture();
 assert.deepEqual(x.events,{gets:[],updates:[],writes:0});
 assert.equal(typeof x.reserve,"function");
});
test("D15.10 accepts exactly one slot with unchanged quote-safe ETag as CAS precondition",async()=>{
 const x=fixture();const receipt=await x.reserve(1);
 assert.deepEqual(receipt,{utcDay:"2026-11-19",remaining:5});
 assert.equal(Object.isFrozen(receipt),true);
 assert.deepEqual(x.events.gets,[{name:RESOURCE_NAME}]);
 assert.equal(x.events.updates.length,1);
 const update=x.events.updates[0];
 assert.equal(update.secret.name,RESOURCE_NAME);
 assert.equal(update.secret.etag,'"e1"');
 assert.deepEqual(update.updateMask,{paths:["annotations"]});
 assert.deepEqual(JSON.parse(update.secret.annotations[STATE_KEY]),makeState("2026-11-19",1));
 assert.deepEqual(Object.keys(update.secret.annotations),[STATE_KEY]);
});
test("D15.10 accepts legacy two-slot request to allow ONE authority for all diagnostics",async()=>{
 const x=fixture();const first=await x.reserve(2);
 assert.deepEqual(first,{utcDay:"2026-11-19",remaining:4});
 assert.equal(x.get().state.reserved,2);
 const second=await x.reserve(2);
 assert.deepEqual(second,{utcDay:"2026-11-19",remaining:2});
});
test("D15.10 six shared quota slots then deny the seventh without mutation",async()=>{
 const x=fixture();for(let i=0;i<6;i++)
   assert.equal((await x.reserve(1)).remaining,5-i);
 await expectBlocked(x.reserve(1));
 assert.equal(x.get().state.reserved,6);
 assert.equal(x.events.writes,6);
});
test("D15.10 mixed one- and two-slot reservations cannot exceed six",async()=>{
 const x=fixture();for(const n of [2,1,2,1])await x.reserve(n);
 await expectBlocked(x.reserve(1));
 await expectBlocked(x.reserve(2));
 assert.equal(x.get().state.reserved,6);
 assert.equal(x.events.writes,4);
});
test("D15.10 truly concurrent operations use ETag to prevent lost updates",async()=>{
 const x=fixture();
 const results=await Promise.allSettled(Array.from({length:10},
   ()=>x.reserve(1)));
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
 assert.equal(results.filter(r=>r.status==="rejected").length,9);
 for(const r of results.filter(r=>r.status==="rejected"))
   assert.ok(unavailable(r.reason));
 assert.equal(x.get().state.reserved,1);
 assert.equal(x.events.writes,1);
});
test("D15.10 invalid amounts fail before metadata I/O",async()=>{
 const x=fixture();
 for(const n of [0,3,7,-1,NaN,"1","2",null,undefined,{},1.25]){
   await expectBlocked(x.reserve(n));
 }
 assert.equal(x.events.gets.length,0);
 assert.equal(x.events.updates.length,0);
});
test("D15.10 UTC midnight resets correctly only from valid previous day",async()=>{
 const x=fixture({initial:makeState("2026-11-18",6)});
 assert.deepEqual(await x.reserve(1),{utcDay:"2026-11-19",remaining:5});
 assert.equal(x.get().state.utcDay,"2026-11-19");
 assert.equal(x.get().state.reserved,1);
});
test("D15.10 future-day state cannot be reset by a stale runtime clock",async()=>{
 const x=fixture({initial:makeState("2026-11-20",1)});
 await expectBlocked(x.reserve(1));
 assert.equal(x.events.writes,0);
});
test("D15.10 corrupt snapshots are blocked rather than reinitialized",async()=>{
 for(const state of [
   null,{},[],{...makeState(),reserved:7},
   {...makeState(),reserved:-1},{...makeState(),reserved:"0"},
   {...makeState(),limit:12},{...makeState(),schemaVersion:2},
   {...makeState(),utcDay:"2026-02-30"},
   {...makeState(),utcDay:"INVALID"},
   {...makeState(),amount:1}
 ]){
   const x=fixture({initial:state});
   await expectBlocked(x.reserve(1));
   assert.equal(x.events.writes,0);
 }
});
test("D15.10 missing quota secret is NOT automatically created",async()=>{
 const x=fixture({getFailure:true});
 await expectBlocked(x.reserve(1));
 assert.equal(x.events.updates.length,0);
});
test("D15.10 failed or ambiguous metadata write does NOT authorize provider call",async()=>{
 const x=fixture({updateFailure:true});
 await expectBlocked(x.reserve(1));
 assert.equal(x.events.updates.length,1);
 assert.equal(x.events.gets.length,1);
 assert.equal(x.events.writes,0);
});
test("D15.10 wrong or incomplete management response cannot count as reserved",async()=>{
 const x=fixture({returnWrongReceipt:true});
 await expectBlocked(x.reserve(1));
 assert.equal(x.events.updates.length,1);
 // The metadata write may have committed before a bad/missing response.
 assert.equal(x.events.writes,1);
});
test("D15.10 invalid clock blocks every metadata request",async()=>{
 for(const clock of [()=>NaN,()=>-1,()=>Infinity,()=>({}),
   ()=>{throw Error("PRIVATE_TIME_ERROR");}]){
   const x=fixture({clock});
   await expectBlocked(x.reserve(1));
   assert.equal(x.events.gets.length,0);
 }
});
test("D15.10 injected untrusted adapters fail construction",()=>{
 for(const config of [
  {},{getSecret:async()=>({})},
  {getSecret:async()=>({}),updateSecret:()=>{},now:null}
 ]){
   assert.throws(()=>makeReserve(config),/Missing trusted/);
 }
});
test("D15.10 no new quota authority is deployed or read by production code",()=>{
 const source=fs.readFileSync(path.join(__dirname,
   "offline-identity-quota-secret-metadata.js"),"utf8");
 const main=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 assert.doesNotMatch(main,/offline-identity-quota-secret-metadata/);
 assert.match(main,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
 assert.match(main,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
 assert.match(main,/const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;/);
 assert.match(main,/_internal\/oddsPapiDailyDiagnosticBudget/);
 assert.doesNotMatch(source,/require\(["'](?:firebase-|@google-cloud|google-auth-library)/);
 assert.doesNotMatch(source,/\.listen\(|\bfetch\(|onRequest\(|onCall\(|setInterval\(/);
});
