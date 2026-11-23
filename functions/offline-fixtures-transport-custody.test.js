"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {makeOfflineFixedFixturesTransport}=
  require("./offline-fixtures-fixed-transport");
const {extractOfflineFixtureTeamEvidence:extract}=
  require("./offline-fixture-team-evidence");
const {makeOfflineFixtureTeamEvidenceStore}=
  require("./offline-fixtures-evidence-firestore");

const NOW=Date.parse("2026-11-23T16:00:00.000Z");
const iso=n=>new Date(NOW+n).toISOString();
const META={reference:"ODDSPAPI_FIXTURES_"+"A".repeat(32),
  capturedAt:iso(-60_000)};
const TOKEN=Object.freeze({});
const FIXTURE={
  fixtureId:"synthetic-fixture-456",sportId:11,tournamentId:132,statusId:0,
  hasOdds:true,startTime:iso(3*60*60*1000),updatedAt:iso(-2*60_000),
  participant1Id:501,participant1Name:"Lakers",
  participant2Id:502,participant2Name:"Jazz",
  apiSecret:"SYNTHETIC_DO_NOT_STORE",
  bookmakerOdds:{"betano.pt":{price:1.87}}
};
const receipt=(items=[FIXTURE])=>extract(items,META,NOW);
function fixtureTransport(opts={}) {
  let secretReads=0;
  const calls=[];
  const getApiKey=()=>{
    secretReads++;
    return opts.key??"SYNTHETIC_API_SECRET";
  };
  const fetchImpl=async (url,options)=>{
    calls.push({url,options});
    if(opts.reject)throw Error("RAW_PROVIDER_SECRET_INFORMATION");
    if(opts.oversize) return new Response(JSON.stringify([FIXTURE]),{
      headers:{"content-type":"application/json",
        "content-length":String(4*1024*1024+1)}
    });
    if(opts.invalid) return new Response("{not-json",{
      headers:{"content-type":"application/json"}
    });
    if(opts.html) return new Response("<html></html>",{
      headers:{"content-type":"text/html"}
    });
    if(opts.httpError) return new Response("RAW_PROVIDER_ERROR",{status:429});
    const response=Response.json(opts.array??[FIXTURE]);
    if(opts.moved||opts.redirected) {
      return {ok:true,redirected:opts.redirected??false,
        url:opts.moved?"https://evil.example/fixture":url,
        headers:response.headers,body:response.body};
    }
    return response;
  };
  const transport=makeOfflineFixedFixturesTransport({
    getApiKey,fetchImpl,makeSignal:ms=>({syntheticTimeout:ms})
  });
  return {transport,calls,secretReads:()=>secretReads};
}
function fakeAdminDb() {
  const docs=new Map(),operations=[];
  const db={
    docs,operations,
    doc(path){operations.push("doc");return {path};},
    async runTransaction(action) {
      operations.push("transaction");
      const changes=[];
      const tx={
        async get(ref) {
          operations.push("get");
          const value=docs.get(ref.path);
          return {exists:value!==undefined,
            data:()=>structuredClone(value)};
        },
        async create(ref,value) {
          operations.push("create");
          if (docs.has(ref.path)) throw Error("duplicate receipt");
          changes.push([ref.path,structuredClone(value)]);
        }
      };
      const result=await action(tx);
      for(const [path,value] of changes)docs.set(path,value);
      return result;
    }
  };
  return db;
}
function custody(db=fakeAdminDb(),check=(token)=>token===TOKEN) {
  return {db,store:makeOfflineFixtureTeamEvidenceStore({
    db,now:()=>NOW,isTrustedReceipt:async(token,meta)=>
      check(token,meta)
  })};
}

test("fixtures transport construction is inert and dependencies are enforced",()=>{
  const t=fixtureTransport();
  assert.equal(t.secretReads(),0);
  assert.equal(t.calls.length,0);
  for(const bad of [{},{fetchImpl:async()=>{}},{getApiKey:()=>""}])
    assert.throws(()=>makeOfflineFixedFixturesTransport(bad),
      /Missing trusted fixture transport dependencies/);
});

test("fixtures transport uses exact fixed NBA scheduled Betano query",async()=>{
  const t=fixtureTransport();
  const payload=await t.transport.fetchFixtures({
    host:"evil.example",participantId:999,bookmaker:"other"
  });
  assert.deepEqual(payload,[FIXTURE]);
  assert.equal(t.calls.length,1);
  assert.equal(t.secretReads(),1);
  const {url,options}=t.calls[0];
  const parsed=new URL(url);
  assert.equal(parsed.origin,"https://api.oddspapi.io");
  assert.equal(parsed.pathname,"/v4/fixtures");
  assert.deepEqual([...parsed.searchParams.keys()].sort(),
    ["apiKey","bookmakers","hasOdds","language","sportId","statusId",
      "tournamentId"]);
  for(const [k,v] of Object.entries({
    apiKey:"SYNTHETIC_API_SECRET",bookmakers:"betano.pt",
    hasOdds:"true",language:"en",sportId:"11",statusId:"0",
    tournamentId:"132"
  }))assert.equal(parsed.searchParams.get(k),v);
  assert.equal(options.method,"GET");
  assert.equal(options.redirect,"error");
  assert.equal(options.credentials,"omit");
  assert.equal(options.cache,"no-store");
  assert.equal(options.signal.syntheticTimeout,35000);
});

test("transport correctly escapes a credential without injecting query fields",async()=>{
  const t=fixtureTransport({key:"secret&bookmakers=other"});
  await t.transport.fetchFixtures();
  const q=new URL(t.calls[0].url).searchParams;
  assert.equal(q.get("apiKey"),"secret&bookmakers=other");
  assert.equal(q.get("bookmakers"),"betano.pt");
  assert.equal([...q.keys()].filter(k=>k==="apiKey").length,1);
});
test("bad credentials fail before transport call",async()=>{
  for(const key of ["","bad\nkey","x".repeat(257)]) {
    const t=fixtureTransport({key});
    await assert.rejects(t.transport.fetchFixtures(),/transport unavailable/);
    assert.equal(t.calls.length,0);
  }
});
test("HTTP failures, bad JSON, wrong host and redirects fail closed without retry",async()=>{
  for(const opts of [
    {reject:true},{httpError:true},{invalid:true},{html:true},
    {moved:true},{redirected:true},{oversize:true},
    {array:{fixtures:[FIXTURE]}},{array:Array(251).fill(FIXTURE)}
  ]) {
    const t=fixtureTransport(opts);
    await assert.rejects(t.transport.fetchFixtures(),error=>{
      assert.match(error.message,/transport unavailable/);
      assert.doesNotMatch(error.message,
        /RAW_PROVIDER|SYNTHETIC_API_SECRET|oddspapi\.io|bookmakers|apiKey/);
      return true;
    });
    assert.equal(t.calls.length,1);
  }
});
test("malformed or oversized stream never becomes a valid fixture result",async()=>{
  const t=makeOfflineFixedFixturesTransport({
    getApiKey:()=>"SYNTHETIC",
    makeSignal:()=>({}),
    fetchImpl:async()=>({
      ok:true,redirected:false,url:"",headers:{get:()=>null},
      body:{getReader:()=>({
        async read(){return {done:false,value:"RAW_TEXT_NOT_BYTES"};},
        async cancel(){},releaseLock(){}
      })}
    })
  });
  await assert.rejects(t.fetchFixtures(),/transport unavailable/);
});
test("single fixture evidence receipt is stored on a fixed internal Admin path",async()=>{
  const {db,store}=custody();
  const raw=receipt();
  assert.ok(raw);
  assert.deepEqual(await store.storeReceipt(raw,TOKEN),{status:"STORED"});
  assert.equal(db.docs.size,1);
  const [savedPath,saved]=[...db.docs.entries()][0];
  assert.match(savedPath,/^_internal\/teamEvidence\/fixtureTeamSnapshots\/ODDSPAPI_FIXTURES_[A-F0-9]{32}$/);
  assert.equal(saved.status,"UNREVIEWED_PROVIDER_TEAM_NAMES");
  assert.equal(saved.receivedAt,iso(0));
  assert.deepEqual([saved.records[0].participant1Id,
    saved.records[0].participant2Id],["501","502"]);
  assert.doesNotMatch(JSON.stringify(saved),
    /SYNTHETIC_DO_NOT_STORE|bookmakerOdds|betano\.pt|price/);
  assert.equal("approvedPairs" in saved,false);
  assert.deepEqual(await store.storeReceipt(raw,TOKEN),
    {status:"REPLAY_BLOCKED"});
  assert.equal(db.docs.size,1);
});
test("forged or missing source receipt never opens Firestore",async()=>{
  const {db,store}=custody();
  const original=receipt();
  assert.deepEqual(await store.storeReceipt(original,{}),{status:"DENIED"});
  assert.deepEqual(db.operations,[]);
  assert.deepEqual(await store.storeReceipt(null,TOKEN),{status:"INVALID_EVIDENCE"});
  assert.deepEqual(db.operations,[]);
  assert.deepEqual(await store.storeReceipt({...original,digest:"0".repeat(64)},TOKEN),
    {status:"INVALID_EVIDENCE"});
  assert.deepEqual(db.operations,[]);
});
test("tampered names, IDs, other fields, and raw odds are not accepted",async()=>{
  const raw=receipt();
  for(const mutate of [
    {records:[{...raw.records[0],participant1Name:"Bad NBA Team"}]},
    {records:[{...raw.records[0],participant2Id:"999"}]},
    {records:[{...raw.records[0],digest:"f".repeat(64)}]},
    {records:[{...raw.records[0],bookmakerOdds:{private:"UNSAFE"}}]},
    {acceptedFixtures:2},{skippedOutsideWindow:1},
    {totalFixtures:251},{status:"APPROVED"},
    {secret:"SHOULD_NOT_STORE"}
  ]) {
    const {db,store}=custody();
    assert.deepEqual(await store.storeReceipt({...raw,...mutate},TOKEN),
      {status:"INVALID_EVIDENCE"});
    assert.equal(db.docs.size,0);
  }
});
test("valid receipt with skipped earlier fixture can be stored intact",async()=>{
  const raw=receipt([
    {...FIXTURE,fixtureId:"earlier",startTime:iso(-20*60_000)},
    FIXTURE
  ]);
  assert.ok(raw);
  assert.equal(raw.acceptedFixtures,1);
  assert.equal(raw.skippedOutsideWindow,1);
  const {db,store}=custody();
  assert.deepEqual(await store.storeReceipt(raw,TOKEN),{status:"STORED"});
  assert.equal(db.docs.size,1);
});
test("invalid Admin ref and failed transaction are sanitized",async()=>{
  const raw=receipt();
  const badRef={
    doc(){return {path:"other"}} ,
    async runTransaction(){throw Error("RAW_FIRESTORE_SECRET");}
  };
  const a=custody(badRef);
  assert.deepEqual(await a.store.storeReceipt(raw,TOKEN),
    {status:"STORE_UNAVAILABLE"});
  const badTx={
    doc(path){return {path};},
    async runTransaction(){throw Error("RAW_FIRESTORE_SECRET");}
  };
  const b=custody(badTx);
  assert.deepEqual(await b.store.storeReceipt(raw,TOKEN),
    {status:"STORE_UNAVAILABLE"});
});
test("offline only: production entrypoint and Firestore rules remain untouched",()=>{
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
  for(const module of ["offline-fixtures-fixed-transport",
    "offline-fixtures-evidence-firestore"]) {
    assert.doesNotMatch(index,new RegExp("require\\([\"']\\./"+module+"[\"']\\)"));
  }
  assert.match(rules,/Everything else is denied by default/);
  assert.doesNotMatch(rules,/match\s+\/\{document=\*\*\}/);
});
