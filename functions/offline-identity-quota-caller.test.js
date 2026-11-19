"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {makeOfflineIdentityQuotaCaller}=require("./offline-identity-quota-caller");
const {makeOfflineAuthenticatedQuotaIngress}=require("./offline-identity-quota-ingress");

const AUD="https://synthetic-private-123.a.run.app";
const CALLER="synthetic-schema@synthetic-project.iam.gserviceaccount.com";
const JWT="synthetic.header.signature";
const ACK=Object.freeze({status:"RESERVED",protocolVersion:1});
const NOW=Date.parse("2026-11-18T10:00:00.000Z");
const encoded=text=>new TextEncoder().encode(text);
function response(data=ACK,options={}){
  const payload=typeof data==="string"?data:JSON.stringify(data);
  const bytes=encoded(payload);
  const chunks=options.chunks||[bytes];
  return {
    ok:options.ok??true,status:options.status??200,
    redirected:options.redirected??false,url:options.url??AUD,
    headers:{get:key=>{
      if(key==="content-type")return options.contentType??"application/json";
      if(key==="content-length")return options.length??null;
      return null;
    }},
    body:new ReadableStream({
      start(controller){
        for(const chunk of chunks)controller.enqueue(chunk);
        controller.close();
      }
    })
  };
}
function fixture({rawHeaders={Authorization:"Bearer "+JWT},
  getClientFails=false,getHeadersFails=false,fetchFails=false,
  fetchResponse,makeSignal=()=>AbortSignal.timeout(6000)}={}){
  const effects={clients:[],headerCalls:[],sent:[]};
  const caller=makeOfflineIdentityQuotaCaller({
    audience:AUD,makeSignal,
    getIdTokenClient:async target=>{
      effects.clients.push(target);
      if(getClientFails)throw Error("SYNTHETIC_PRIVATE_AUTH_PROVIDER");
      return {getRequestHeaders:async url=>{
        effects.headerCalls.push(url);
        if(getHeadersFails)throw Error("SYNTHETIC_PRIVATE_TOKEN");
        return rawHeaders;
      }};
    },
    fetchImpl:async(url,options)=>{
      effects.sent.push({url,options});
      if(fetchFails)throw Error("SYNTHETIC_PRIVATE_NETWORK");
      return fetchResponse?fetchResponse(url,options):response();
    }
  });
  return {caller,effects};
}
async function expectUnavailable(promise){
  await assert.rejects(promise,error=>{
    assert.equal(error.code,"unavailable");
    assert.doesNotMatch(error.message,/SYNTHETIC_PRIVATE|Bearer|signature|Firestore/);
    return true;
  });
}

test("D15.6 constructor remains inert before an approved manual invocation",()=>{
  const x=fixture();
  assert.deepEqual(x.effects,{clients:[],headerCalls:[],sent:[]});
  assert.equal(typeof x.caller,"function");
});
test("D15.6 single authenticated POST is pinned to the exact broker audience",async()=>{
  const x=fixture(),ack=await x.caller(1);
  assert.deepEqual(ack,ACK);
  assert.deepEqual(x.effects.clients,[AUD]);
  assert.deepEqual(x.effects.headerCalls,[AUD]);
  assert.equal(x.effects.sent.length,1);
  const {url,options}=x.effects.sent[0];
  assert.equal(url,AUD);
  assert.equal(options.method,"POST");
  assert.equal(options.redirect,"error");
  assert.equal(options.cache,"no-store");
  assert.deepEqual(options.headers,{
    Authorization:"Bearer "+JWT,
    "Content-Type":"application/json",Accept:"application/json"
  });
  assert.deepEqual(JSON.parse(options.body),{
    operation:"RESERVE_IDENTITY_SCHEMA_ONE_SLOT",protocolVersion:1
  });
  assert.equal(options.signal.aborted,false);
});
test("D15.6 supports Google's Headers.get authorization response",async()=>{
 const x=fixture({rawHeaders:{
  get:key=>key==="authorization"?"Bearer "+JWT:null
 }});
 assert.deepEqual(await x.caller(1),ACK);
 assert.equal(x.effects.sent.length,1);
});
test("D15.6 invalid reservation amount rejects before any token or HTTP",async()=>{
 const x=fixture();
 for(const amount of [0,2,-1,"1",1.5,null,undefined,{amount:1}]){
   await assert.rejects(x.caller(amount),e=>e.code==="invalid-argument");
 }
 assert.deepEqual(x.effects,{clients:[],headerCalls:[],sent:[]});
});
test("D15.6 target URL must be a canonical HTTPS Cloud Run service root",()=>{
 const config={audience:AUD,
  getIdTokenClient:async()=>({getRequestHeaders:async()=>({Authorization:"Bearer "+JWT})}),
  fetchImpl:async()=>response()
 };
 for(const audience of [
  "http://synthetic-private-123.a.run.app",
  "https://evil.example",
  "https://synthetic-private-123.a.run.app/",
  "https://synthetic-private-123.a.run.app/budget",
  "https://synthetic-private-123.a.run.app?retry=1",
  "https://other@synthetic-private-123.a.run.app",
  "https://synthetic-private-123.a.run.app:444", "",
  "https://synthetic-private-123.a.run.app#fragment"
 ])assert.throws(()=>makeOfflineIdentityQuotaCaller({...config,audience}),
    /Invalid trusted/);
 for(const overrides of [{getIdTokenClient:null},{fetchImpl:null},
  {makeSignal:null}])assert.throws(()=>makeOfflineIdentityQuotaCaller({
   ...config,...overrides}),/Invalid trusted/);
});
test("D15.6 ID token client failure redacted, with zero HTTP calls",async()=>{
 const x=fixture({getClientFails:true});
 await expectUnavailable(x.caller(1));
 assert.equal(x.effects.sent.length,0);
});
test("D15.6 Google token header acquisition failure redacted, no HTTP",async()=>{
 const x=fixture({getHeadersFails:true});
 await expectUnavailable(x.caller(1));
 assert.equal(x.effects.sent.length,0);
});
test("D15.6 malformed or duplicate bearer header cannot be forwarded",async()=>{
 for(const headers of [
  {},{Authorization:"Basic abc"},{Authorization:"Bearer not-a-jwt"},
  {Authorization:"Bearer a.b"},
  {Authorization:["Bearer a.b.c"]},
  {Authorization:"Bearer "+JWT,authorization:"Bearer "+JWT},
  {Authorization:"Bearer "+("a".repeat(8200))+".b.c"},
  null
 ]){
   const x=fixture({rawHeaders:headers});
   await expectUnavailable(x.caller(1));
   assert.equal(x.effects.sent.length,0);
 }
});
test("D15.6 network exception cannot retry or disclose transport failure",async()=>{
 const x=fixture({fetchFails:true});
 await expectUnavailable(x.caller(1));
 assert.equal(x.effects.sent.length,1);
});
test("D15.6 HTTP failure, including 401 or 503, cannot retry",async()=>{
 for(const status of [301,401,403,404,429,500,503]){
  const x=fixture({fetchResponse:()=>response(ACK,{status,ok:false})});
  await expectUnavailable(x.caller(1));
  assert.equal(x.effects.sent.length,1);
 }
});
test("D15.6 rejects redirects and responses from a different URL",async()=>{
 for(const config of [
  {redirected:true},{url:"https://evil.example"},
  {url:"https://synthetic-private-123.a.run.app/other"}
 ]){
  const x=fixture({fetchResponse:()=>response(ACK,config)});
  await expectUnavailable(x.caller(1));
  assert.equal(x.effects.sent.length,1);
 }
});
test("D15.6 rejects wrong content type and overdeclared responses",async()=>{
 for(const config of [
  {contentType:"text/html"},{contentType:"application/json-extra"},
  {length:"257"},{length:"infinity"}
 ]){
  const x=fixture({fetchResponse:()=>response(ACK,config)});
  await expectUnavailable(x.caller(1));
  assert.equal(x.effects.sent.length,1);
 }
});
test("D15.6 bounds STREAMED bytes, not just a Content-Length header",async()=>{
 const chunks=[encoded(" ".repeat(200)),encoded(" ".repeat(201))];
 const x=fixture({fetchResponse:()=>response(ACK,{length:"12",chunks})});
 await expectUnavailable(x.caller(1));
 assert.equal(x.effects.sent.length,1);
});
test("D15.6 malformed, oversized or misleading success JSON is denied",async()=>{
 for(const fake of [
   "not-json","", "null", JSON.stringify({status:"DENIED"}),
   JSON.stringify({status:"RESERVED"}),
   JSON.stringify({...ACK,extra:true}),
   JSON.stringify({status:"RESERVED",protocolVersion:"1"}),
   JSON.stringify({status:"RESERVED",protocolVersion:1,token:"secret"})
 ]){
  const x=fixture({fetchResponse:()=>response(fake)});
  await expectUnavailable(x.caller(1));
  assert.equal(x.effects.sent.length,1);
 }
});
test("D15.6 real timed-out/aborted transport is not retried",async()=>{
 const x=fixture({
  makeSignal:()=>AbortSignal.abort(),
  fetchResponse:async(_,options)=>{
    assert.equal(options.signal.aborted,true);
    throw Error("SYNTHETIC_PRIVATE_ABORTED");
  }
 });
 await expectUnavailable(x.caller(1));
 assert.equal(x.effects.sent.length,1);
});
test("D15.6 synthetic broker roundtrip still blocks a seventh reservation",async()=>{
 let reserved=0,verificationCount=0;
 const ingress=makeOfflineAuthenticatedQuotaIngress({
  audience:AUD,expectedCaller:CALLER,now:()=>NOW,
  verifyIdToken:async(token,audience)=>{
    verificationCount++;
    assert.equal(token,JWT);
    assert.equal(audience,AUD);
    return {aud:AUD,email:CALLER,email_verified:true,
      iss:"https://accounts.google.com",sub:"synthetic-subject",
      exp:Math.floor(NOW/1000)+3600};
  },
  reserve:async amount=>{
    if(reserved+amount>6)throw Error("SYNTHETIC_PRIVATE_BUDGET_DENIED");
    reserved+=amount;
    return {utcDay:"2026-11-18",remaining:6-reserved};
  }
 });
 let sends=0;
 const x=fixture({fetchResponse:async(url,options)=>{
   sends++;
   assert.equal(url,AUD);
   const out=await ingress({
     method:options.method,query:{},body:JSON.parse(options.body),
     headers:{
       authorization:options.headers.Authorization,
       "content-type":options.headers["Content-Type"]
     }
   });
   return response(out);
 }});
 for(let i=0;i<6;i++)assert.deepEqual(await x.caller(1),ACK);
 await expectUnavailable(x.caller(1));
 assert.equal(reserved,6);
 assert.equal(verificationCount,7);
 assert.equal(sends,7);
 assert.equal(x.effects.sent.length,7);
});
test("D15.6 caller remains disconnected from production and paid provider",()=>{
 const source=fs.readFileSync(path.join(__dirname,
  "offline-identity-quota-caller.js"),"utf8");
 const main=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 assert.doesNotMatch(source,/require\(["'](?:firebase-|google-auth-library)/);
 assert.doesNotMatch(main,/offline-identity-quota-caller/);
 assert.doesNotMatch(source,/odds-by-tournaments|api\.oddspapi\.io|setInterval\(/);
 assert.match(main,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
 assert.match(main,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
});
