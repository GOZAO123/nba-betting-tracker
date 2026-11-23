"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {makeOfflineFixedEspnScoreboardAcquisition}=
  require("./offline-fixed-espn-scoreboard-acquisition");

const NOW=Date.parse("2026-11-23T10:00:00.000Z");
const START=NOW+180*60000;
const ENDPOINT=
  "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261123";
const ISO=ms=>new Date(ms).toISOString();
const secret="UNTRUSTED_ESPN_RAW_SECRET_NEVER_STORE";
const event=(id="401234567",delta=0,opts={})=>({
  id,date:ISO(START+delta).replace(".000Z","Z"),
  status:{type:{state:"pre",extra:secret}},
  season:{type:2,metadata:secret},
  competitions:[{competitors:[
    {homeAway:"home",team:{id:"100",displayName:"Synthetic East Team",
      privateStats:secret}},
    {homeAway:"away",team:{id:"101",displayName:"Synthetic West Team",
      bookmakerOdds:secret}}
  ]}],rawKey:secret,...opts
});
const payload=(rows=[event()])=>({
  events:rows,
  rawHeaders:{Authorization:secret}
});

function response(url,body,{redirected=false,ok=true,
  contentType="application/json",declared=null,stream=null}={}){
  const bytes=Buffer.from(JSON.stringify(body));
  return {url,redirected,ok,
    headers:{get:key=>key==="content-type"?contentType:
      key==="content-length"?declared:null},
    body:stream||new ReadableStream({
      start(controller){controller.enqueue(bytes);controller.close();}
    })
  };
}
function fakeDb(){
  const docs=new Map(),ops=[];
  const db={docs,ops,
    doc(path){ops.push("doc");return {path};},
    async runTransaction(callback){
      ops.push("transaction");
      const staged=[];
      const tx={
        async get(ref){ops.push("get");return {
          exists:docs.has(ref.path),
          data:()=>structuredClone(docs.get(ref.path))
        };},
        create(ref,value){
          ops.push("create");
          if(docs.has(ref.path))throw Error("duplicate");
          staged.push([ref.path,structuredClone(value)]);
        }
      };
      const result=await callback(tx);
      for(const [loc,value] of staged)docs.set(loc,value);
      return result;
    }
  };
  return db;
}
function setup({clock=()=>NOW,makeSignal=()=>({aborted:false}),
  reply,payloadOverride=payload(),db=fakeDb()}={}){
  const calls=[];
  const transport=makeOfflineFixedEspnScoreboardAcquisition({
    db,now:clock,makeSignal,
    fetchImpl:async(url,options)=>{
      calls.push({url,options});
      if(typeof reply==="function")return reply(url,options);
      return response(url,payloadOverride);
    }
  });
  return {transport,calls,db,
    capture:(start=START)=>transport.captureForFixtureStart(start)};
}

test("D20 constructor is inert and needs backend-supplied transport and DB",()=>{
  assert.throws(()=>makeOfflineFixedEspnScoreboardAcquisition(),TypeError);
  assert.throws(()=>makeOfflineFixedEspnScoreboardAcquisition({
    db:{doc:()=>{},runTransaction:async()=>{}}
  }),TypeError);
  const t=setup();
  assert.deepEqual(t.calls,[]);
  assert.deepEqual(t.db.ops,[]);
});

test("D20 successful manual ESPN acquisition is fixed-host, normalized, sanitized and create-only",async()=>{
  const t=setup();
  const out=await t.capture();
  assert.deepEqual(out,{status:"STORED"});
  assert.equal(Object.isFrozen(out),true);
  assert.equal(t.calls.length,1);
  assert.equal(t.calls[0].url,ENDPOINT);
  assert.deepEqual(Object.keys(t.calls[0].options).sort(),[
    "cache","headers","method","redirect","signal"
  ]);
  assert.equal(t.calls[0].options.method,"GET");
  assert.equal(t.calls[0].options.redirect,"error");
  assert.equal(t.calls[0].options.cache,"no-store");
  assert.deepEqual(t.calls[0].options.headers,{Accept:"application/json"});
  assert.equal(t.db.docs.size,1);
  const [loc,saved]=[...t.db.docs.entries()][0];
  assert.match(loc,
    /^_internal\/teamReview\/espnSnapshots\/ESPN_CAPTURE_[0-9A-F]{32}$/);
  assert.deepEqual(Object.keys(saved).sort(),[
    "capturedAt","reference","schemaVersion","scoreboard","source"
  ]);
  assert.equal(saved.capturedAt,ISO(NOW));
  assert.equal(saved.scoreboard.events[0].date,ISO(START));
  assert.deepEqual(saved.scoreboard.events[0].competitions[0]
    .competitors.map(x=>x.team.id),["100","101"]);
  assert.doesNotMatch(JSON.stringify(saved),/UNTRUSTED_ESPN|privateStats|bookmakerOdds|rawHeaders/);
  assert.deepEqual(t.db.ops.filter(x=>x==="create"),["create"]);
  assert.doesNotMatch(JSON.stringify(out),/ESPN_CAPTURE|401234567|100|101|digest/);
});

test("D20 NBA calendar day uses New York even around Lisbon midnight",async()=>{
  const now=Date.parse("2026-11-23T00:00:00.000Z");
  const start=now+3*3600000;
  const t=setup({clock:()=>now,payloadOverride:payload([
    {...event(),date:ISO(start)}
  ])});
  assert.deepEqual(await t.capture(start),{status:"STORED"});
  assert.equal(t.calls[0].url,ENDPOINT.replace("20261123","20261122"));
});

test("D20 invalid, late and distant fixture starts reject before HTTP or database",async()=>{
  for(const start of [undefined,null,"20261123",NaN,0,-1,
    NOW,NOW+5*60000,NOW+72*3600000+1]) {
    const t=setup();
    // Call the exported operation directly: the test harness capture()
    // convenience wrapper defaults undefined to a valid START.
    assert.deepEqual(await t.transport.captureForFixtureStart(start),
      {status:"INVALID_FIXTURE_START"});
    assert.equal(t.calls.length,0);
    assert.equal(t.db.docs.size,0);
    assert.deepEqual(t.db.ops,[]);
  }
});

test("D20 no ESPN snapshot is created for missing or ambiguous scheduled game",async()=>{
  const cases=[
    payload([]),
    payload([event("401234567",20*60000)]),
    payload([event("401234567",0),event("401234568",0)]),
    payload([event("401234567",0),event("401234567",40*60000)]),
    payload([event("401234567",0,{
      season:{type:1}
    })]),
    payload([event("401234567",0,{
      status:{type:{state:"in"}}
    })]),
    payload([event("401234567",0,{
      competitions:[{competitors:[
        {homeAway:"home",team:{id:"100",displayName:"Name One"}},
        {homeAway:"home",team:{id:"101",displayName:"Name Two"}}
      ]}]
    })]),
    payload([event("401234567",0,{date:"not-a-date"})])
  ];
  for(const x of cases) {
    const t=setup({payloadOverride:x});
    assert.deepEqual(await t.capture(),{status:"ESPN_CAPTURE_UNAVAILABLE"});
    assert.equal(t.calls.length,1);
    assert.equal(t.db.docs.size,0);
    assert.deepEqual(t.db.ops,[]);
  }
});

test("D20 unrelated games are retained; exactly one near the intended tipoff",async()=>{
  const t=setup({payloadOverride:payload([
    event("401234567"),event("401234568",60*60000)
  ])});
  assert.deepEqual(await t.capture(),{status:"STORED"});
  assert.equal([...t.db.docs.values()][0].scoreboard.events.length,2);
});

test("D20 wrong URL, redirects, HTTP denial and content type all reject without writes",async()=>{
  const cases=[
    (url)=>response("https://other.invalid/scoreboard",payload()),
    (url)=>response(url,payload(),{redirected:true}),
    (url)=>response(url,payload(),{ok:false}),
    (url)=>response(url,payload(),{contentType:"text/html"}),
    (url)=>response(url,payload(),{contentType:"application/json",declared:"abc"}),
    (url)=>response(url,payload(),{declared:String(4*1024*1024+1)}),
    (url)=>response(url,payload(),{stream:{}})
  ];
  for(const reply of cases){
    const t=setup({reply});
    assert.deepEqual(await t.capture(),{status:"ESPN_CAPTURE_UNAVAILABLE"});
    assert.equal(t.calls.length,1);
    assert.deepEqual(t.db.ops,[]);
  }
});

test("D20 streamed byte cap denies misleading and unlimited response lengths",async()=>{
  const overLimit=new Uint8Array(4*1024*1024+1);
  const t=setup({reply:url=>response(url,payload(),{
    declared:"100",
    stream:new ReadableStream({
      start(controller){controller.enqueue(overLimit);controller.close();}
    })
  })});
  assert.deepEqual(await t.capture(),{status:"ESPN_CAPTURE_UNAVAILABLE"});
  assert.equal(t.calls.length,1);
  assert.deepEqual(t.db.ops,[]);
});

test("D20 malformed JSON and truncated body never create source evidence",async()=>{
  const t=setup({reply:url=>response(url,payload(),{
    stream:new ReadableStream({
      start(controller){
        controller.enqueue(Buffer.from('{"events":[', "utf8"));
        controller.close();
      }
    })
  })});
  assert.deepEqual(await t.capture(),{status:"ESPN_CAPTURE_UNAVAILABLE"});
  assert.deepEqual(t.db.ops,[]);
});

test("D20 provider and server errors are sanitized with no retries",async()=>{
  let count=0;
  const t=setup({reply:async()=>{
    count++;
    throw Error("PRIVATE_ESPN_AUTH_KEY");
  }});
  assert.deepEqual(await t.capture(),{status:"ESPN_CAPTURE_UNAVAILABLE"});
  assert.equal(count,1);
  assert.equal(t.db.ops.length,0);
  const backendDb=fakeDb();
  backendDb.runTransaction=async()=>{
    throw Error("PRIVATE_ADMIN_DATABASE");
  };
  const broken=setup({db:backendDb});
  assert.deepEqual(await broken.capture(),{status:"STORE_UNAVAILABLE"});
  assert.equal(broken.calls.length,1);
  assert.equal(backendDb.docs.size,0);
});

test("D20 pre-aborted signal prevents the ESPN request",async()=>{
  const t=setup({makeSignal:()=>({aborted:true})});
  assert.deepEqual(await t.capture(),{status:"ESPN_CAPTURE_UNAVAILABLE"});
  assert.deepEqual(t.calls,[]);
  assert.deepEqual(t.db.ops,[]);
});

test("D20 source remains disconnected from production, no OddsPapi or automatic polling",()=>{
  const source=fs.readFileSync(path.join(__dirname,
    "offline-fixed-espn-scoreboard-acquisition.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(index,
    /require\(["']\.\/offline-fixed-espn-scoreboard-acquisition["']\)/);
  assert.doesNotMatch(source,
    /firebase-admin|firebase-functions|api\.oddspapi\.io|onCall\s*\(|onSchedule\s*\(|setInterval\s*\(/);
  assert.match(source,/site\.api\.espn\.com/);
});
