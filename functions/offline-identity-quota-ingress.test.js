"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {makeOfflineAuthenticatedQuotaIngress}=require("./offline-identity-quota-ingress");
const {OPERATION,PROTOCOL_VERSION}=require("./offline-identity-quota-broker");

const AUD="https://private-broker-xyz.a.run.app";
const CALLER="synthetic-schema@synthetic-project.iam.gserviceaccount.com";
const FIXED_NOW=Date.parse("2026-11-18T10:00:00.000Z");
const TOKEN="synthetic.fake.signature";
const body=()=>({operation:OPERATION,protocolVersion:PROTOCOL_VERSION});
const message=()=>({method:"POST",headers:{
  authorization:"Bearer "+TOKEN,"content-type":"application/json"
 },body:body(),query:{}});
const claims=()=>({aud:AUD,email:CALLER,email_verified:true,
  iss:"https://accounts.google.com",sub:"123456789012345",exp:Math.floor(FIXED_NOW/1000)+3600});

function fixture({verifier=async()=>claims(),budget=6,reserveThrows=false}={}){
  const effects={verified:[],reservations:[]};
  let count=0;
  const ingress=makeOfflineAuthenticatedQuotaIngress({
    audience:AUD,expectedCaller:CALLER,now:()=>FIXED_NOW,
    verifyIdToken:async(token,audience)=>{
      effects.verified.push({token,audience});
      return verifier(token,audience);
    },
    reserve:async amount=>{
      effects.reservations.push(amount);
      if(reserveThrows)throw Error("SYNTHETIC_PRIVATE_FIRESTORE_ERROR");
      if(count+amount>budget)throw Error("SYNTHETIC_NO_QUOTA");
      count+=amount;
      return {utcDay:"2026-11-18",remaining:budget-count};
    }
  });
  return {ingress,effects,count:()=>count};
}
const expectDenied=async(x,request)=>{
  assert.deepEqual(await x.ingress(request),{status:"DENIED"});
  assert.deepEqual(x.effects.reservations,[]);
};

test("D15.5 signed Google claims permit exactly one trusted reservation",async()=>{
 const x=fixture(),result=await x.ingress(message());
 assert.deepEqual(result,{status:"RESERVED",protocolVersion:1});
 assert.deepEqual(x.effects.verified,[{token:TOKEN,audience:AUD}]);
 assert.deepEqual(x.effects.reservations,[1]);
 assert.equal(x.count(),1);
});
test("D15.5 signed token verifier failure denies without reserving or echoing details",async()=>{
 const x=fixture({verifier:async()=>{throw Error("SYNTHETIC_PRIVATE_SIGNATURE");}});
 const result=await x.ingress(message());
 assert.deepEqual(result,{status:"DENIED"});
 assert.deepEqual(x.effects.reservations,[]);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|synthetic\.fake/);
});
test("D15.5 rejected audience and wrong Google issuer cannot reserve",async()=>{
 for(const bad of [{aud:"https://other-broker.a.run.app"},
  {iss:"https://evil.example"},{iss:"http://accounts.google.com"}]){
  const x=fixture({verifier:async()=>({...claims(),...bad})});
  await expectDenied(x,message());
 }
});
test("D15.5 verified email must be the exact dedicated runtime identity",async()=>{
 for(const bad of [{email:"different@synthetic-project.iam.gserviceaccount.com"},
  {email:""},{email_verified:false},{email_verified:"true"},{sub:""}]){
  const x=fixture({verifier:async()=>({...claims(),...bad})});
  await expectDenied(x,message());
 }
});
test("D15.5 expired, missing or malformed token expiration fails closed",async()=>{
 for(const exp of [Math.floor(FIXED_NOW/1000),Math.floor(FIXED_NOW/1000)-1,
  "2099",null,NaN]){
  const x=fixture({verifier:async()=>({...claims(),exp})});
  await expectDenied(x,message());
 }
});
test("D15.5 absent, malformed and duplicated Authorization headers deny",async()=>{
 for(const change of [
  {},{authorization:"Basic abc"},{authorization:"Bearer invalid"},
  {authorization:"Bearer a.b"},{authorization:["Bearer a.b.c"]},
  {authorization:"Bearer a.b.c "+("X".repeat(8300))},
  {authorization:"Bearer a.b.c","Authorization":"Bearer a.b.c"},
  {authorization:"Bearer a.b.c","x-serverless-authorization":"Bearer other"},
  {authorization:"Bearer a.b.c","content-type":"application/text"}
 ]){
  const req=message();req.headers=change;
  const x=fixture();await expectDenied(x,req);
  assert.deepEqual(x.effects.verified,[]);
 }
});
test("D15.5 browser-supplied email and header cannot impersonate the signed identity",async()=>{
 const req=message();req.body.email=CALLER;req.headers["x-client-email"]=CALLER;
 const x=fixture({verifier:async()=>({...claims(),email:"other@synthetic-project.iam.gserviceaccount.com"})});
 await expectDenied(x,req);
});
test("D15.5 malformed payload or query never reaches quota after valid verification",async()=>{
 const x=fixture();
 for(const change of [
  {method:"GET"},{query:{amount:1}},
  {body:{...body(),amount:2}},
  {body:{...body(),utcDay:"2099-01-01"}},
  {body:{...body(),retry:true}},
  {body:[]},{body:{operation:OPERATION,protocolVersion:2}}
 ]){
  const req=Object.assign(message(),change);
  assert.deepEqual(await x.ingress(req),{status:"INVALID_REQUEST"});
 }
 assert.deepEqual(x.effects.reservations,[]);
});
test("D15.5 oversized JSON payload denied before verifier and quota",async()=>{
 const x=fixture(),req=message();req.body.blob="x".repeat(1024);
 await expectDenied(x,req);
 assert.deepEqual(x.effects.verified,[]);
});
test("D15.5 Firestore rejection is redacted and does not retry",async()=>{
 const x=fixture({reserveThrows:true}),result=await x.ingress(message());
 assert.deepEqual(result,{status:"BUDGET_UNAVAILABLE"});
 assert.deepEqual(x.effects.reservations,[1]);
 assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE/);
});
test("D15.5 shared six-slot ceiling forbids seventh signed request",async()=>{
 const x=fixture();
 for(let i=0;i<6;i++){
  const result=await x.ingress(message());
  assert.deepEqual(result,{status:"RESERVED",protocolVersion:1});
 }
 assert.deepEqual(await x.ingress(message()),{status:"BUDGET_UNAVAILABLE"});
 assert.equal(x.count(),6);
 assert.equal(x.effects.reservations.length,7);
});
test("D15.5 rejects unsafe audience, missing verifier or invalid caller configuration",()=>{
 const config={audience:AUD,expectedCaller:CALLER,
  verifyIdToken:async()=>claims(),reserve:async()=>({utcDay:"2026-11-18",remaining:5})};
 for(const change of [
  {audience:"http://private-broker-xyz.a.run.app"},
  {audience:"https://evil.example"},
  {audience:"https://private-broker-xyz.a.run.app/other"},
  {audience:"https://private-broker-xyz.a.run.app?x=1"},
  {audience:"https://evil.example@private-broker-xyz.a.run.app"},
  {audience:"https://private-broker-xyz.a.run.app:444"},
  {expectedCaller:"a-user@gmail.com"},
  {expectedCaller:""},{verifyIdToken:null},{reserve:null}
 ]){
  assert.throws(()=>makeOfflineAuthenticatedQuotaIngress({...config,...change}),
   /Invalid trusted offline/);
 }
});
test("D15.5 ingress is inert, not imported from production, and hard-off gates unchanged",()=>{
 const source=fs.readFileSync(path.join(__dirname,"offline-identity-quota-ingress.js"),"utf8");
 const entry=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 assert.doesNotMatch(source,/require\(["'](?:firebase-|google-auth-library)/);
 assert.doesNotMatch(source,/\bonRequest\s*\(|\bonCall\s*\(|\bonSchedule\s*\(/);
 assert.doesNotMatch(source,/\bfetch\s*\(|\bgetFirestore\s*\(/);
 assert.doesNotMatch(entry,/offline-identity-quota-ingress/);
 assert.match(entry,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
 assert.match(entry,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
});
