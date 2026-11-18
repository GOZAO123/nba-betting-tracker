"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {OPERATION,PROTOCOL_VERSION,makeOfflineIdentityQuotaBroker,
  isStrictReservationAck}=require("./offline-identity-quota-broker");

const CALLER="synthetic-identity-schema@invalid.test";
const envelope=()=>({method:"POST",body:{operation:OPERATION,protocolVersion:PROTOCOL_VERSION}});
const receipt=remaining=>({utcDay:"2026-11-18",remaining});
function fixture({caller=CALLER,verifyFails=false,reserveFails=false,
  badReceipt=null}={}){
  const effects={auth:[],reservations:[]};
  const run=makeOfflineIdentityQuotaBroker({
    expectedCaller:CALLER,
    verifyCaller:async context=>{
      effects.auth.push(context);
      if(verifyFails)throw Error("PRIVATE_IDENTITY_TOKEN");
      return caller;
    },
    reserve:async n=>{
      effects.reservations.push(n);
      if(reserveFails)throw Error("PRIVATE_FIRESTORE_DENIAL");
      return badReceipt||receipt(5);
    }
  });
  return {run,effects};
}
test("D15.4 verified caller reserves exactly one fixed slot",async()=>{
  const x=fixture(),ctx=Object.freeze({verified:"SYNTHETIC"});
  const out=await x.run(envelope(),ctx);
  assert.deepEqual(out,{status:"RESERVED",protocolVersion:1});
  assert.equal(isStrictReservationAck(out),true);
  assert.deepEqual(x.effects.reservations,[1]);
  assert.deepEqual(x.effects.auth,[ctx]);
});
test("D15.4 other service account is denied before quota operation",async()=>{
  const x=fixture({caller:"unknown@invalid.test"});
  assert.deepEqual(await x.run(envelope(),{}),{status:"DENIED"});
  assert.deepEqual(x.effects.reservations,[]);
});
test("D15.4 identity-verifier errors fail closed without token leakage",async()=>{
  const x=fixture({verifyFails:true}),out=await x.run(envelope(),{});
  assert.deepEqual(out,{status:"DENIED"});
  assert.doesNotMatch(JSON.stringify(out),/PRIVATE_IDENTITY_TOKEN/);
  assert.deepEqual(x.effects.reservations,[]);
});
test("D15.4 browser assertions cannot override verified identity",async()=>{
  const x=fixture({caller:"unverified@invalid.test"}),request=envelope();
  request.body.caller=CALLER;request.headers={"X-Caller":CALLER};
  assert.deepEqual(await x.run(request,{}),{status:"DENIED"});
  assert.deepEqual(x.effects.reservations,[]);
});
test("D15.4 rejects GET, client quota overrides, unknown data and queries",async()=>{
  const bad=[
    {method:"GET",body:envelope().body},
    {method:"POST",body:{...envelope().body,amount:2}},
    {method:"POST",body:{...envelope().body,utcDay:"2099-01-01"}},
    {method:"POST",body:{...envelope().body,document:"/users/other"}},
    {method:"POST",body:{...envelope().body,providerKey:"FAKE"}},
    {method:"POST",body:{operation:OPERATION,protocolVersion:2}},
    {method:"POST",body:[]},
    {method:"POST",body:null},
    {...envelope(),query:{retry:true}},
    null,
    Object.create({method:"POST",body:envelope().body})
  ];
  const x=fixture();
  for(const request of bad)
    assert.deepEqual(await x.run(request,{}),{status:"INVALID_REQUEST"});
  assert.deepEqual(x.effects.reservations,[]);
});
test("D15.4 rejects missing or invalid trusted adapters",()=>{
  for(const opts of [undefined,{}, {expectedCaller:"",verifyCaller:()=>CALLER,reserve:()=>receipt(5)},
    {expectedCaller:CALLER,verifyCaller:()=>CALLER},
    {expectedCaller:CALLER,reserve:()=>receipt(5)}])
    assert.throws(()=>makeOfflineIdentityQuotaBroker(opts),/Missing trusted/);
});
test("D15.4 quota failure redacts Firestore error and never retries",async()=>{
  const denied=fixture({reserveFails:true}),out=await denied.run(envelope(),{});
  assert.deepEqual(out,{status:"BUDGET_UNAVAILABLE"});
  assert.doesNotMatch(JSON.stringify(out),/PRIVATE_FIRESTORE_DENIAL/);
  assert.deepEqual(denied.effects.reservations,[1]);
  const corrupt=fixture({badReceipt:{status:"OK",remaining:999}});
  assert.deepEqual(await corrupt.run(envelope(),{}),{status:"BUDGET_UNAVAILABLE"});
  assert.deepEqual(corrupt.effects.reservations,[1]);
});
test("D15.4 strict acknowledgement rejects spoofed success and extra fields",()=>{
  for(const invalid of [null,{}, {status:"RESERVED"},
    {status:"RESERVED",protocolVersion:1,extra:true},
    {status:"RESERVED",protocolVersion:"1"},
    {status:"BUDGET_UNAVAILABLE",protocolVersion:1},
    {status:"RESERVED",protocolVersion:2}])
    assert.equal(isStrictReservationAck(invalid),false);
});
test("D15.4 synthetic shared six-slot counter blocks the seventh",async()=>{
  let reserved=0;
  const broker=makeOfflineIdentityQuotaBroker({
    expectedCaller:CALLER,
    verifyCaller:async()=>CALLER,
    reserve:async n=>{
      if(reserved+n>6)throw Error("SYNTHETIC_QUOTA_EXHAUSTED");
      reserved+=n;
      return receipt(6-reserved);
    }
  });
  for(let i=0;i<6;i++)
    assert.equal(isStrictReservationAck(await broker(envelope(),{})),true);
  assert.deepEqual(await broker(envelope(),{}),{status:"BUDGET_UNAVAILABLE"});
  assert.equal(reserved,6);
});
test("D15.4 pure broker contract is disconnected from deployed Firebase entrypoint",()=>{
  const source=fs.readFileSync(path.join(__dirname,"offline-identity-quota-broker.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(source,/require\(["'](?:firebase-|google-auth-library)|onCall\(|onRequest\(|getFirestore\(|fetch\(/);
  assert.doesNotMatch(index,/offline-identity-quota-broker/);
  assert.match(index,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
  assert.match(index,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
  assert.equal((index.match(/exports\.oddsPapiNbaIdentitySchemaDiagnostic\s*=/g)||[]).length,1);
});
