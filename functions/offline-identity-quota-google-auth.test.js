"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {makeOfflineGoogleIdTokenClientFactory}=
  require("./offline-identity-quota-google-auth");
const {makeOfflineIdentityQuotaCaller}=
  require("./offline-identity-quota-caller");

const AUD="https://synthetic-private-123.a.run.app";
const TOKEN="synthetic.header.signature";
const ACK={status:"RESERVED",protocolVersion:1};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const response=()=>({
  ok:true,status:200,redirected:false,url:AUD,
  headers:{get:k=>k==="content-type"?"application/json":null},
  body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(JSON.stringify(ACK)));c.close();}})
});
const client=()=>({getRequestHeaders:async()=>({Authorization:"Bearer "+TOKEN})});
const caller=(getIdTokenClient,fetchImpl=async()=>response(),makeSignal)=>
  makeOfflineIdentityQuotaCaller({audience:AUD,getIdTokenClient,fetchImpl,
    ...(makeSignal?{makeSignal}:{})});
const unavailable=error=>error.code==="unavailable"&&
  !/TOKEN|SYNTHETIC_SECRET|credential|metadata|Bearer/.test(error.message);

test("D15.7 lazy GoogleAuth constructor creates no client or metadata activity at setup",async()=>{
  let loads=0,constructs=0,requests=[];
  const factory=makeOfflineGoogleIdTokenClientFactory({loadGoogleAuth:()=>{
    loads++;
    return {GoogleAuth:class{
      constructor(){constructs++;}
      async getIdTokenClient(aud){requests.push(aud);return client();}
    }};
  }});
  assert.equal(loads,0);assert.equal(constructs,0);
  const result=await factory(AUD);
  assert.equal(typeof result.getRequestHeaders,"function");
  assert.equal((await factory(AUD)).getRequestHeaders instanceof Function,true);
  assert.equal(loads,1);assert.equal(constructs,1);
  assert.deepEqual(requests,[AUD,AUD]);
});
test("D15.7 GoogleAuth API adapter never supplies credential JSON or options",async()=>{
  const args=[];
  const factory=makeOfflineGoogleIdTokenClientFactory({loadGoogleAuth:()=>({
    GoogleAuth:class{
      constructor(...params){args.push(params);}
      async getIdTokenClient(aud){assert.equal(aud,AUD);return client();}
    }
  })});
  await factory(AUD);
  assert.deepEqual(args,[[]]);
});
test("D15.7 malformed or unavailable GoogleAuth is redacted",async()=>{
  assert.throws(()=>makeOfflineGoogleIdTokenClientFactory({loadGoogleAuth:null}),/Missing trusted/);
  for(const loader of [
    ()=>null,()=>({}),()=>{throw Error("SYNTHETIC_SECRET_TOKEN");},
    ()=>({GoogleAuth:class{async getIdTokenClient(){throw Error("SYNTHETIC_SECRET");}}}),
    ()=>({GoogleAuth:class{async getIdTokenClient(){return {};}}})
  ]){
    const run=makeOfflineGoogleIdTokenClientFactory({loadGoogleAuth:loader});
    await assert.rejects(run(AUD),e=>
      /Private Google identity token unavailable/.test(e.message)&&
      !/SYNTHETIC_SECRET/.test(e.message));
  }
});
test("D15.7 shared deadline starts before getIdTokenClient and rejects late resolution",async()=>{
  const pending=deferred(),abort=new AbortController();
  let getHeaders=0,sends=0;
  const run=caller(async()=>pending.promise,
    async()=>{sends++;return response();},()=>abort.signal);
  const promise=run(1);
  await flush();
  abort.abort();
  await assert.rejects(promise,unavailable);
  pending.resolve({getRequestHeaders:async()=>{getHeaders++;return {Authorization:"Bearer "+TOKEN};}});
  await flush();await flush();
  assert.equal(getHeaders,0);assert.equal(sends,0);
});
test("D15.7 header refresh after deadline cannot begin any HTTP",async()=>{
  const pending=deferred(),abort=new AbortController();
  let sends=0,headers=0;
  const run=caller(async()=>({getRequestHeaders:async()=>{headers++;return pending.promise;}}),
    async()=>{sends++;return response();},()=>abort.signal);
  const promise=run(1);
  await flush();await flush();
  assert.equal(headers,1);
  abort.abort();
  await assert.rejects(promise,unavailable);
  pending.resolve({Authorization:"Bearer "+TOKEN});
  await flush();await flush();
  assert.equal(sends,0);
});
test("D15.7 shared deadline aborts a pending HTTP response with just one attempt",async()=>{
  const pending=deferred(),abort=new AbortController();
  let sends=0,requestSignal=null;
  const run=caller(async()=>client(),async(_,options)=>{
    sends++;requestSignal=options.signal;return pending.promise;
  },()=>abort.signal);
  const promise=run(1);
  await flush();await flush();await flush();
  assert.equal(sends,1);
  assert.equal(requestSignal,abort.signal);
  abort.abort();
  await assert.rejects(promise,unavailable);
  pending.resolve(response());
  await flush();
  assert.equal(sends,1);
});
test("D15.7 deadline terminates a stalled broker response stream",async()=>{
  const abort=new AbortController();
  let sends=0,cancelled=0,started=deferred();
  const run=caller(async()=>client(),async()=>{
    sends++;
    return {
      ok:true,status:200,redirected:false,url:AUD,
      headers:{get:k=>k==="content-type"?"application/json":null},
      body:new ReadableStream({
        start(){started.resolve();},
        cancel(){cancelled++;}
      })
    };
  },()=>abort.signal);
  const result=run(1);
  await started.promise;await flush();await flush();
  abort.abort();
  await assert.rejects(result,unavailable);
  await flush();
  assert.equal(sends,1);
  assert.ok(cancelled>=1);
});
test("D15.7 malformed deadline signal blocks GoogleAuth and transport",async()=>{
  let auth=0,sends=0;
  for(const makeSignal of [
    ()=>null,()=>({aborted:false}),()=>({aborted:"no"}),
    ()=>{throw Error("SYNTHETIC_SECRET_CLOCK");}
  ]){
    const run=caller(async()=>{auth++;return client();},async()=>{sends++;return response();},makeSignal);
    await assert.rejects(run(1),unavailable);
  }
  assert.equal(auth,0);assert.equal(sends,0);
});
test("D15.7 single full deadline flows unchanged to fetch on successful reservation",async()=>{
  const abort=new AbortController();let capturedSignal=null,calls=0;
  const run=caller(async()=>client(),async(_,options)=>{
    calls++;capturedSignal=options.signal;return response();
  },()=>abort.signal);
  assert.deepEqual(await run(1),ACK);
  assert.equal(capturedSignal,abort.signal);
  assert.equal(calls,1);
});
test("D15.7 pre-aborted operation never initializes auth and performs no HTTP",async()=>{
  let auth=0,sends=0;
  const run=caller(async()=>{auth++;return client();},async()=>{sends++;return response();},
    ()=>AbortSignal.abort());
  await assert.rejects(run(1),unavailable);
  assert.equal(auth,0);assert.equal(sends,0);
});
test("D15.7 GoogleAuth factory and deadline code are disconnected from production",()=>{
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const adapter=fs.readFileSync(path.join(__dirname,
    "offline-identity-quota-google-auth.js"),"utf8");
  const callerSource=fs.readFileSync(path.join(__dirname,
    "offline-identity-quota-caller.js"),"utf8");
  assert.doesNotMatch(index,/offline-identity-quota-google-auth|offline-identity-quota-caller/);
  assert.match(index,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
  assert.match(index,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
  assert.doesNotMatch(adapter,/setInterval\(|onSchedule\(|onCall\(|onRequest\(/);
  assert.match(callerSource,/withinDeadline\(signal/);
  assert.doesNotMatch(adapter,/GOOGLE_APPLICATION_CREDENTIALS\s*=|private_key/);
});
