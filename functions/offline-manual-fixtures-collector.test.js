"use strict";
const assert=require("node:assert/strict");
const {test}=require("node:test");
const fs=require("node:fs");
const path=require("node:path");
const {makeOfflineManualFixturesCollector}=
  require("./offline-manual-fixtures-collector");

const NOW=Date.parse("2026-11-23T16:00:00.000Z");
const APPROVAL_ID="b".repeat(32);
const APPROVAL_PATH="_internal/fixtureTeamDiscovery/approvals/"+APPROVAL_ID;
const PRIVATE_PREFIX="_internal/teamEvidence/fixtureTeamSnapshots/";
const OWNER={auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const iso=n=>new Date(NOW+n).toISOString();
const fixture=()=>({
  fixtureId:"synthetic-team-fixture",sportId:11,tournamentId:132,
  statusId:0,hasOdds:true,startTime:iso(3*60*60*1000),
  updatedAt:iso(-1000),participant1Id:5001,
  participant2Id:5002,participant1Name:"Lakers",
  participant2Name:"Jazz",
  apiKey:"SYNTHETIC_SECRET_NOT_SAVED",
  bookmakerOdds:{"betano.pt":{market:{PTS:{price:1.89}}}}
});

function fakeDb() {
  const docs=new Map();
  return {
    docs,
    doc(path){return {path};},
    async runTransaction(work) {
      const queued=[];
      const tx={
        async get(ref) {
          const data=docs.get(ref.path);
          return {exists:data!==undefined,
            data:()=>data===undefined?undefined:structuredClone(data)};
        },
        update(ref,patch) {
          if(!docs.has(ref.path))throw Error("missing update");
          queued.push({type:"update",path:ref.path,data:patch});
        },
        create(ref,value) {
          if(docs.has(ref.path))throw Error("existing receipt");
          queued.push({type:"create",path:ref.path,data:value});
        }
      };
      const value=await work(tx);
      for(const change of queued) {
        if(change.type==="update")docs.set(change.path,
          {...docs.get(change.path),...change.data});
        else docs.set(change.path,structuredClone(change.data));
      }
      return value;
    }
  };
}
function setup({enabled=true,approval=null,broken=null,
  provider=[fixture()],badQuota=false}={}) {
  const db=fakeDb(),trace=[];
  db.docs.set(APPROVAL_PATH,approval??{
    issuedAtMs:NOW-1000,expiresAtMs:NOW+60_000,claimedAtMs:null
  });
  const opts={
    enabled,ownerUid:OWNER.auth.uid,approvalId:APPROVAL_ID,
    getDb(){trace.push("db");return db;},now:()=>NOW,
    async reserve(n) {
      trace.push("reserve");
      assert.equal(n,1);
      assert.equal(db.docs.get(APPROVAL_PATH).claimedAtMs,NOW);
      if(broken==="quota")throw Object.assign(Error("raw quota failure"),
        {code:"resource-exhausted"});
      if(broken==="database")throw Error("RAW_DB_QUOTA_ERROR");
      return badQuota ? {utcDay:"2026-11-22",remaining:5} :
        {utcDay:"2026-11-23",remaining:5};
    },
    getApiKey(){
      trace.push("secret");
      return "SYNTHETIC_API_KEY";
    },
    async fetchImpl(url,options) {
      trace.push("provider");
      assert.equal(new URL(url).origin,"https://api.oddspapi.io");
      assert.equal(new URL(url).pathname,"/v4/fixtures");
      assert.equal(new URL(url).searchParams.get("bookmakers"),"betano.pt");
      assert.equal(options.method,"GET");
      assert.equal(options.redirect,"error");
      if(broken==="http")throw Error("RAW_PROVIDER_KEY_LEAK");
      if(broken==="response")return Response.json({fixtures:provider});
      return Response.json(provider);
    }
  };
  const run=makeOfflineManualFixturesCollector(opts);
  return {db,trace,run};
}
const stored=db=>[...db.docs.entries()]
  .filter(([name])=>name.startsWith(PRIVATE_PREFIX));

test("factory is disabled by default without touching dependencies",async()=>{
  const run=makeOfflineManualFixturesCollector();
  await assert.rejects(run(OWNER),{code:"failed-precondition"});
  assert.throws(()=>makeOfflineManualFixturesCollector({
    enabled:true,ownerUid:"synthetic-owner",approvalId:"bad"
  }),TypeError);
});

test("unverified owner and nonempty data have no approval or quota effects",async()=>{
  const t=setup();
  for(const req of [null,{data:{}},
    {...OWNER,auth:{uid:"intruder",token:{email_verified:true}}},
    {...OWNER,auth:{uid:OWNER.auth.uid,token:{email_verified:false}}}])
    await assert.rejects(t.run(req),{code:"permission-denied"});
  for(const data of [null,[],{fixtureId:"anything"},{enabled:true},
    {apiKey:"SYNTHETIC"}])
    await assert.rejects(t.run({...OWNER,data}),{code:"invalid-argument"});
  assert.deepEqual(t.trace,[]);
  assert.equal(t.db.docs.get(APPROVAL_PATH).claimedAtMs,null);
  assert.equal(stored(t.db).length,0);
});

test("missing expired future malformed and already claimed approvals fail closed",async()=>{
  for(const record of [
    {issuedAtMs:NOW-1000,expiresAtMs:NOW,claimedAtMs:null},
    {issuedAtMs:NOW+1000,expiresAtMs:NOW+5000,claimedAtMs:null},
    {issuedAtMs:NOW-1000,expiresAtMs:NOW+5000,claimedAtMs:NOW-500},
    {issuedAtMs:NOW-1000,expiresAtMs:NOW+5000,claimedAtMs:null,extra:true},
    {issuedAtMs:NOW-1000,expiresAtMs:NOW+15*60_000+1,claimedAtMs:null}
  ]) {
    const t=setup({approval:record});
    await assert.rejects(t.run(OWNER),{code:"failed-precondition"});
    assert.deepEqual(t.trace,["db"]);
  }
  const t=setup();t.db.docs.delete(APPROVAL_PATH);
  await assert.rejects(t.run(OWNER),{code:"failed-precondition"});
  assert.deepEqual(t.trace,["db"]);
});

test("one success consumes permit, reserves once, returns only status and private evidence",async()=>{
  const t=setup();
  assert.deepEqual(await t.run(OWNER),{status:"STORED_UNREVIEWED"});
  assert.deepEqual(t.trace,["db","reserve","secret","provider"]);
  assert.equal(t.db.docs.get(APPROVAL_PATH).claimedAtMs,NOW);
  const items=stored(t.db);
  assert.equal(items.length,1);
  assert.match(items[0][0],/^_internal\/teamEvidence\/fixtureTeamSnapshots\/ODDSPAPI_FIXTURES_[A-F0-9]{32}$/);
  assert.equal(items[0][1].status,"UNREVIEWED_PROVIDER_TEAM_NAMES");
  assert.deepEqual(items[0][1].records.map(x=>[x.participant1Id,x.participant2Id]),
    [["5001","5002"]]);
  assert.doesNotMatch(JSON.stringify(items[0][1]),/SYNTHETIC_SECRET|bookmakerOdds|price|PTS/);
  assert.equal("espnTeamId" in items[0][1],false);
  await assert.rejects(t.run(OWNER),{code:"failed-precondition"});
  assert.deepEqual(t.trace,["db","reserve","secret","provider","db"]);
  assert.equal(stored(t.db).length,1);
});

test("quota exhaustion consumes permit and never accesses provider key",async()=>{
  const t=setup({broken:"quota"});
  await assert.rejects(t.run(OWNER),{code:"resource-exhausted"});
  assert.deepEqual(t.trace,["db","reserve"]);
  assert.equal(t.db.docs.get(APPROVAL_PATH).claimedAtMs,NOW);
  await assert.rejects(t.run(OWNER),{code:"failed-precondition"});
});

test("broken quota backend or stale receipt blocks secret and transport",async()=>{
  for(const variation of [{broken:"database"},{badQuota:true}]) {
    const t=setup(variation);
    await assert.rejects(t.run(OWNER),error=>
      error.code==="unavailable" && !error.message.includes("RAW_DB"));
    assert.deepEqual(t.trace,["db","reserve"]);
    assert.equal(stored(t.db).length,0);
  }
});

test("provider failure is sanitized and is not retried",async()=>{
  for(const broken of ["http","response"]) {
    const t=setup({broken});
    await assert.rejects(t.run(OWNER),error=>
      error.code==="unavailable" && !/RAW_PROVIDER|SYNTHETIC/.test(error.message));
    assert.deepEqual(t.trace,["db","reserve","secret","provider"]);
    assert.equal(stored(t.db).length,0);
  }
});

test("invalid, duplicate, stale or missing source identities never persist",async()=>{
  for(const provider of [
    [fixture(),fixture()],
    [{...fixture(),participant1Id:0}],
    [{...fixture(),participant2Name:"Lakers"}],
    [{...fixture(),statusId:1}],
    [{...fixture(),startTime:iso(-60*60_000)}],
    []
  ]) {
    const t=setup({provider});
    assert.deepEqual(await t.run(OWNER),{status:"NO_STORABLE_FIXTURES"});
    assert.equal(stored(t.db).length,0);
    assert.deepEqual(t.trace,["db","reserve","secret","provider"]);
  }
});

test("store failures are sanitized and do not authorize retries",async()=>{
  const t=setup();
  const old=t.db.runTransaction;
  let n=0;
  t.db.runTransaction=async callback=>{
    n++;
    if(n===2)throw Error("RAW_PRIVATE_FIRESTORE_FAILURE");
    return old.call(t.db,callback);
  };
  await assert.rejects(t.run(OWNER),error=>
    error.code==="unavailable" && !error.message.includes("RAW_PRIVATE"));
  assert.equal(stored(t.db).length,0);
  await assert.rejects(t.run(OWNER),{code:"failed-precondition"});
  assert.deepEqual(t.trace,["db","reserve","secret","provider","db"]);
});

test("no production wiring, client exports, payment calls or scheduled work",()=>{
  const source=fs.readFileSync(path.join(__dirname,"offline-manual-fixtures-collector.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(index,/require\(["']\.\/offline-manual-fixtures-collector["']\)/);
  assert.doesNotMatch(source,/onCall\(|onSchedule\(|setInterval\(|setTimeout\(|getFirestore\(/);
  assert.doesNotMatch(source,/https:\/\/api\.oddspapi\.io/);
  assert.doesNotMatch(source,/firebase-functions|firebase-admin/);
});
