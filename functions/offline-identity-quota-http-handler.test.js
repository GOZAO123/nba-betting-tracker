"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {Readable}=require("node:stream");
const fs=require("node:fs"),path=require("node:path");
const {makeOfflineGoogleIdentityVerifier}=
  require("./offline-identity-quota-google-verify");
const {makeOfflineSharedBudgetReservation}=
  require("./offline-identity-quota-firestore-reserve");
const {makeOfflinePrivateQuotaHttpHandler}=
  require("./offline-identity-quota-http-handler");

const AUD="https://synthetic-private-123.a.run.app";
const CALLER="synthetic-schema@synthetic-project.iam.gserviceaccount.com";
const TOKEN="synthetic.header.signature";
const BODY='{"operation":"RESERVE_IDENTITY_SCHEMA_ONE_SLOT","protocolVersion":1}';
const claims=()=>({aud:AUD,email:CALLER,email_verified:true,
  iss:"https://accounts.google.com",sub:"a-synthetic-subject",
  exp:Math.floor(Date.now()/1000)+3600});
function fakeDb(initial=null){
  let record=initial,paths=[],options=[],reads=0,writes=0;
  let chain=Promise.resolve();
  const db={
    doc:p=>{paths.push(p);return {path:p};},
    runTransaction:async(fn,opts)=>{
      options.push(opts);
      const task=chain.then(async()=>{
        let proposed=null;
        const tx={
          get:async(ref)=>{
            reads++;
            assert.equal(ref.path,"_internal/oddsPapiDailyDiagnosticBudget");
            return {exists:record!==null,data:()=>record};
          },
          set:(ref,value)=>{
            assert.equal(ref.path,"_internal/oddsPapiDailyDiagnosticBudget");
            proposed=value;
          }
        };
        const result=await fn(tx);
        if(proposed){writes++;record=proposed;}
        return result;
      });
      chain=task.then(()=>{},()=>{});
      return task;
    }
  };
  return {db,state:()=>({record,paths,options,reads,writes})};
}
function fixture({claimsOverride=null,initial=null,reserveError=false,
  verifyError=false,signal=null}={}){
  const storage=fakeDb(initial),effects={verifications:[],dbCalls:0};
  const reserve=makeOfflineSharedBudgetReservation({
    getFirestore:()=>{effects.dbCalls++;return storage.db;},
    now:()=>Date.parse("2026-11-19T00:04:00.000Z")
  });
  const handler=makeOfflinePrivateQuotaHttpHandler({
    audience:AUD,expectedCaller:CALLER,
    verifyIdToken:async(token,audience)=>{
      effects.verifications.push({token,audience});
      if(verifyError)throw Error("PRIVATE_TOKEN_AUTH_FAILURE");
      return {...claims(),...claimsOverride};
    },
    reserve:async n=>{
      if(reserveError)throw Error("PRIVATE_DATABASE_FAILURE");
      return reserve(n);
    },
    ...(signal?{makeSignal:()=>signal}:{})
  });
  return {storage,effects,handler};
}
function request({body=BODY,method="POST",url="/",rawHeaders=null,chunks=null}={}){
  const headers=rawHeaders??["Authorization","Bearer "+TOKEN,
    "Content-Type","application/json"];
  const buffers=chunks??[Buffer.from(body,"utf8")];
  const req=Readable.from(buffers);
  req.method=method;req.url=url;req.rawHeaders=headers;
  return req;
}
async function invoke(handler,req=request()){
  const headers={};
  const res={
    statusCode:0,
    setHeader:(name,value)=>{headers[name.toLowerCase()]=value;},
    end(text){this.body=text;}
  };
  await handler(req,res);
  return {status:res.statusCode,body:JSON.parse(res.body),headers};
}
const expectSafe=(response,status,key)=>{
  assert.equal(response.status,status);
  assert.equal(response.body.status,key);
  assert.equal(response.headers["cache-control"],"no-store");
  assert.equal(response.headers["x-content-type-options"],"nosniff");
  assert.equal(response.headers["content-type"],"application/json");
  assert.equal(response.headers["content-length"],
    Buffer.byteLength(JSON.stringify(response.body)));
};

test("D15.8 real Google verify adapter is lazy and invokes signature verifier interface",async()=>{
  let loaded=0,instances=0,calls=[];
  const verify=makeOfflineGoogleIdentityVerifier({loadGoogleAuth:()=>{
    loaded++;
    return {OAuth2Client:class{
      constructor(...args){instances++;assert.deepEqual(args,[]);}
      async verifyIdToken(opts){
        calls.push(opts);
        return {getPayload:()=>claims()};
      }
    }};
  }});
  assert.equal(loaded,0);assert.equal(instances,0);
  assert.deepEqual(await verify(TOKEN,AUD),claims());
  assert.equal(loaded,1);assert.equal(instances,1);
  assert.deepEqual(calls,[{idToken:TOKEN,audience:AUD}]);
});
test("D15.8 verifier fails closed on invalid token and missing Google library",async()=>{
  let loaded=0;
  const verifier=makeOfflineGoogleIdentityVerifier({loadGoogleAuth:()=>{
    loaded++;throw Error("PRIVATE_CERT_FETCH");
  }});
  for(const bad of [null,"x","a.b","Bearer "+TOKEN,("x".repeat(9000))])
    await assert.rejects(verifier(bad,AUD));
  assert.equal(loaded,0);
  await assert.rejects(verifier(TOKEN,AUD),err=>
    err.message==="Google service identity unavailable.");
  assert.equal(loaded,1);
  assert.throws(()=>makeOfflineGoogleIdentityVerifier({loadGoogleAuth:null}));
  const broken=makeOfflineGoogleIdentityVerifier({loadGoogleAuth:()=>({
    OAuth2Client:class{
      verifyIdToken(){throw Error("PRIVATE_CERT_FETCH");}
    }
  })});
  await assert.rejects(broken(TOKEN,AUD),err=>
    err.message==="Google service identity unavailable.");
});
test("D15.8 signed internal request reserves one existing shared Firestore slot",async()=>{
  const x=fixture(),out=await invoke(x.handler);
  expectSafe(out,200,"RESERVED");
  assert.deepEqual(out.body,{status:"RESERVED",protocolVersion:1});
  assert.deepEqual(x.effects.verifications,[{token:TOKEN,audience:AUD}]);
  const state=x.storage.state();
  assert.equal(x.effects.dbCalls,1);
  assert.deepEqual(state.paths,["_internal/oddsPapiDailyDiagnosticBudget"]);
  assert.deepEqual(state.options,[{maxAttempts:5}]);
  assert.deepEqual(state.record,{
    utcDay:"2026-11-19",reserved:1,limit:6,
    lastReservedAt:"2026-11-19T00:04:00.000Z"
  });
});
test("D15.8 six accepted reservations block the seventh, including concurrent calls",async()=>{
  const x=fixture();
  const results=await Promise.all(Array.from({length:10},
    ()=>invoke(x.handler,request())));
  assert.equal(results.filter(x=>x.status===200).length,6);
  assert.equal(results.filter(x=>x.status===503).length,4);
  assert.equal(x.storage.state().record.reserved,6);
  assert.equal(x.storage.state().writes,6);
});
test("D15.8 any bad principal, issuer or expiry blocks Firestore",async()=>{
  const variants=[{email:"other@synthetic-project.iam.gserviceaccount.com"},
    {aud:"https://other.a.run.app"},{iss:"https://evil.example"},
    {exp:Math.floor(Date.now()/1000)-1},{email_verified:false}];
  for(const claimsOverride of variants){
    const x=fixture({claimsOverride});
    expectSafe(await invoke(x.handler),403,"DENIED");
    assert.equal(x.effects.dbCalls,0);
  }
});
test("D15.8 signed JWT verification failure cannot reserve or leak",async()=>{
  const x=fixture({verifyError:true});
  const out=await invoke(x.handler);
  expectSafe(out,403,"DENIED");
  assert.doesNotMatch(JSON.stringify(out),/PRIVATE_TOKEN_AUTH_FAILURE/);
  assert.equal(x.effects.dbCalls,0);
});
test("D15.8 no Authorization and X-Serverless-Authorization denied before verification",async()=>{
  for(const headers of [
    ["Content-Type","application/json"],
    ["Authorization","Bearer "+TOKEN,"Content-Type","application/json",
      "X-Serverless-Authorization","Bearer "+TOKEN],
    ["Authorization","Bearer "+TOKEN,"authorization","Bearer "+TOKEN,
      "Content-Type","application/json"],
    ["Authorization","Bearer "+TOKEN,"Content-Type","application/json",
      "content-type","application/json"],
    ["Authorization","Bearer "+TOKEN,"Content-Type","text/plain"],
  ]){
    const x=fixture(),out=await invoke(x.handler,request({rawHeaders:headers}));
    expectSafe(out,403,"DENIED");
    assert.equal(x.effects.verifications.length,0);
    assert.equal(x.effects.dbCalls,0);
  }
});
test("D15.8 wrong method or path must not read a body or verify identity",async()=>{
  for(const variant of [{method:"GET"},{method:"OPTIONS"},{url:"/reserve"},
    {url:"/?amount=2"},{url:"/%2f"}]){
    const x=fixture(),out=await invoke(x.handler,request(variant));
    expectSafe(out,405,"INVALID_REQUEST");
    assert.equal(x.effects.verifications.length,0);
    assert.equal(x.effects.dbCalls,0);
  }
});
test("D15.8 exactly canonical JSON accepted; duplicate keys and overrides rejected",async()=>{
  const invalid=[
    '{"protocolVersion":1,"operation":"RESERVE_IDENTITY_SCHEMA_ONE_SLOT"}',
    '{"operation":"RESERVE_IDENTITY_SCHEMA_ONE_SLOT","protocolVersion":1,"amount":2}',
    '{"operation":"RESERVE_IDENTITY_SCHEMA_ONE_SLOT","operation":"RESERVE_IDENTITY_SCHEMA_ONE_SLOT","protocolVersion":1}',
    '{"operation":"RESERVE_IDENTITY_SCHEMA_ONE_SLOT","protocolVersion":1}\n',
    "{}", "null",""
  ];
  for(const body of invalid){
    const x=fixture(),out=await invoke(x.handler,request({body}));
    expectSafe(out,400,"INVALID_REQUEST");
    assert.equal(x.effects.verifications.length,0);
    assert.equal(x.effects.dbCalls,0);
  }
});
test("D15.8 raw streaming prevents oversized requests before any parsing or token",async()=>{
  const x=fixture(),out=await invoke(x.handler,request({
    chunks:[Buffer.from(BODY),Buffer.alloc(250,120)]
  }));
  expectSafe(out,400,"INVALID_REQUEST");
  assert.equal(x.effects.verifications.length,0);
  assert.equal(x.effects.dbCalls,0);
});
test("D15.8 content-length mismatch and smuggling indicators reject",async()=>{
  for(const headers of [
    ["Authorization","Bearer "+TOKEN,"Content-Type","application/json",
      "Content-Length","99999"],
    ["Authorization","Bearer "+TOKEN,"Content-Type","application/json",
      "Content-Length","4"],
    ["Authorization","Bearer "+TOKEN,"Content-Type","application/json",
      "Content-Length","12","Transfer-Encoding","chunked"],
    ["Authorization","Bearer "+TOKEN,"Content-Type","application/json",
      "Content-Length","12","content-length","12"]
  ]){
    const x=fixture(),out=await invoke(x.handler,request({rawHeaders:headers}));
    assert.ok(out.status===400||out.status===403);
    assert.equal(x.effects.dbCalls,0);
  }
});
test("D15.8 invalid prior reservation, unexpected limit and Firestore outage all deny",async()=>{
  for(const initial of [
    {utcDay:"2026-11-19",reserved:-1,limit:6},
    {utcDay:"2026-11-19",reserved:7,limit:6},
    {utcDay:"2026-11-19",reserved:2,limit:8},
    {utcDay:"2026-11-19",reserved:"2",limit:6}
  ]){
    const x=fixture({initial});
    expectSafe(await invoke(x.handler),503,"BUDGET_UNAVAILABLE");
    assert.equal(x.storage.state().writes,0);
  }
  const x=fixture({reserveError:true});
  const out=await invoke(x.handler);
  expectSafe(out,503,"BUDGET_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(out),/PRIVATE_DATABASE_FAILURE/);
});
test("D15.8 counter safely resets when UTC day changes",async()=>{
  const x=fixture({initial:{utcDay:"2026-11-18",reserved:6,limit:6}});
  expectSafe(await invoke(x.handler),200,"RESERVED");
  assert.equal(x.storage.state().record.reserved,1);
  assert.equal(x.storage.state().record.utcDay,"2026-11-19");
});
test("D15.8 invalid caller request cannot select alternate quota doc or amount",async()=>{
  const x=fixture();
  await invoke(x.handler,request({body:JSON.stringify({
    operation:"RESERVE_IDENTITY_SCHEMA_ONE_SLOT",protocolVersion:1,
    document:"users/other/propResearchLedger",amount:6
  })}));
  assert.equal(x.effects.dbCalls,0);
  assert.equal(x.storage.state().paths.length,0);
});
test("D15.8 expired whole-operation signal blocks verification and Firestore",async()=>{
  const x=fixture({signal:AbortSignal.abort()});
  expectSafe(await invoke(x.handler),503,"BUDGET_UNAVAILABLE");
  assert.equal(x.effects.verifications.length,0);
  assert.equal(x.effects.dbCalls,0);
});
test("D15.8 stalled raw request returns unavailable on timeout without reservations",async()=>{
  const controller=new AbortController();
  const x=fixture({signal:controller.signal});
  const stalled=new Readable({read(){}});
  stalled.method="POST";stalled.url="/";
  stalled.rawHeaders=["Authorization","Bearer "+TOKEN,
    "Content-Type","application/json"];
  const result=invoke(x.handler,stalled);
  await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  expectSafe(await result,503,"BUDGET_UNAVAILABLE");
  assert.equal(x.effects.verifications.length,0);
  assert.equal(x.effects.dbCalls,0);
  stalled.destroy();
});
test("D15.8 default-unwired modules do not create any production endpoints",()=>{
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const files=["offline-identity-quota-google-verify.js",
    "offline-identity-quota-firestore-reserve.js",
    "offline-identity-quota-http-handler.js"];
  for(const filename of files){
    assert.doesNotMatch(index,new RegExp(filename.replaceAll(".","\\.")));
    const source=fs.readFileSync(path.join(__dirname,filename),"utf8");
    assert.doesNotMatch(source,/\bonRequest\(|\bonCall\(|\.listen\(|setInterval\(/);
  }
  assert.match(index,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
  assert.match(index,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
  assert.match(index,/const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;/);
  assert.match(index,/_internal\/oddsPapiDailyDiagnosticBudget/);
});
