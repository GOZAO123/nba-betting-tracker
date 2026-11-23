"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const {makeOfflineManualIdentityDiscovery} =
  require("./offline-manual-identity-discovery");

const NOW = Date.parse("2026-11-23T16:00:00.000Z");
const APPROVAL = "b".repeat(32);
const APPROVAL_PATH = "_internal/identityDiscovery/approvals/" + APPROVAL;
const RECORD_PREFIX = "_internal/teamEvidence/providerSnapshots/";
const OWNER = {auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const timestamp = n => new Date(NOW + n).toISOString();
const fixture = (id="synthetic-fixture-1") => ({
  fixtureId:id, sportId:11,tournamentId:132,statusId:0,hasOdds:true,
  startTime:timestamp(3*60*60*1000),
  participant1Id:"5001",participant2Id:"5002",
  bookmakerOdds:{"betano.pt":{
    bookmakerIsActive:true,suspended:false,markets:{"90001":{marketActive:true}}
  }},
  privateApiKey:"SYNTHETIC_MUST_NOT_PERSIST",
  bookmakerOddsSecret:"SYNTHETIC_NO_RAW_ODDS"
});

// Synthetic Admin-style transaction facade. Production uses the independently
// tested D7 fixed-path, create-only store and Firestore transactions.
function fakeDb() {
  const docs=new Map();
  const db={
    docs,
    doc(path) {return {path};},
    async runTransaction(work) {
      const changes=[];
      const tx={
        async get(ref) {
          const data=docs.get(ref.path);
          return {exists:data!==undefined,
            data:()=>data===undefined?undefined:structuredClone(data)};
        },
        update(ref,patch) {
          if (!docs.has(ref.path)) throw Error("missing update target");
          changes.push({action:"update",path:ref.path,data:patch});
        },
        create(ref,data) {
          if (docs.has(ref.path)) throw Error("already exists");
          changes.push({action:"create",path:ref.path,data});
        }
      };
      const result=await work(tx);
      for (const c of changes) {
        if(c.action==="update")docs.set(c.path,{...docs.get(c.path),...c.data});
        else docs.set(c.path,structuredClone(c.data));
      }
      return result;
    }
  };
  return db;
}
function setup({enabled=true,record=null,fixtures=[fixture()],failure=null,
  badReceipt=false}={}) {
  const db=fakeDb();
  db.docs.set(APPROVAL_PATH,record??{
    issuedAtMs:NOW-1000,expiresAtMs:NOW+120000,claimedAtMs:null
  });
  const trace=[];
  const run=makeOfflineManualIdentityDiscovery({
    enabled, ownerUid:OWNER.auth.uid, approvalId:APPROVAL, getDb:()=>{
      trace.push("db");return db;
    },
    now:()=>NOW,
    async reserve(amount) {
      trace.push("reserve:"+amount);
      assert.equal(db.docs.get(APPROVAL_PATH).claimedAtMs,NOW);
      if (failure==="budget") throw Object.assign(Error("quota"),{code:"resource-exhausted"});
      return badReceipt ? null : {utcDay:"2026-11-23",remaining:5};
    },
    getApiKey() {trace.push("secret");return "SYNTHETIC_TEST_KEY";},
    async fetchImpl(url,options) {
      trace.push("fetch");
      assert.equal(new URL(url).origin,"https://api.oddspapi.io");
      assert.equal(new URL(url).pathname,"/v4/odds-by-tournaments");
      assert.equal(new URL(url).searchParams.get("bookmaker"),"betano.pt");
      assert.equal(options.method,"GET");
      assert.equal(options.redirect,"error");
      if (failure==="provider") throw Error("RAW_PROVIDER_FAILURE");
      return Response.json(fixtures);
    }
  });
  return {run,db,trace};
}
const snapshots=db=>[...db.docs.entries()]
  .filter(([path])=>path.startsWith(RECORD_PREFIX));

// DISCONNECTED default means not even a database or token dependency is needed.
test("disabled discovery rejects without any side effects",async()=>{
  const disabled=makeOfflineManualIdentityDiscovery();
  await assert.rejects(disabled(OWNER),{code:"failed-precondition"});
});

test("owner, email verification and empty payload precede permit/quota/secret",async()=>{
  const t=setup();
  for(const req of [null,{data:{}},
    {...OWNER,auth:{uid:"another",token:{email_verified:true}}},
    {...OWNER,auth:{uid:OWNER.auth.uid,token:{email_verified:false}}}]) {
    await assert.rejects(t.run(req),{code:"permission-denied"});
  }
  for(const data of [null,{approvalId:APPROVAL},{playerName:"synthetic"},[]]) {
    await assert.rejects(t.run({...OWNER,data}),{code:"invalid-argument"});
  }
  assert.deepEqual(t.trace,[]);
  assert.equal(t.db.docs.get(APPROVAL_PATH).claimedAtMs,null);
  assert.equal(snapshots(t.db).length,0);
});

test("unprovisioned, expired, claimed and malformed approvals fail before quota",async()=>{
  for(const record of [
    {issuedAtMs:NOW-2000000,expiresAtMs:NOW-1,claimedAtMs:null},
    {issuedAtMs:NOW-1000,expiresAtMs:NOW+1000,claimedAtMs:NOW-200},
    {issuedAtMs:NOW+1000,expiresAtMs:NOW+2000,claimedAtMs:null},
    {issuedAtMs:NOW-1000,expiresAtMs:NOW+1000,claimedAtMs:null,other:"unsafe"},
    {issuedAtMs:NOW-1000,expiresAtMs:NOW+15*60*1000+1,claimedAtMs:null}
  ]) {
    const t=setup({record});
    await assert.rejects(t.run(OWNER),{code:"failed-precondition"});
    assert.deepEqual(t.trace,["db"]);
  }
  const absent=setup();absent.db.docs.delete(APPROVAL_PATH);
  await assert.rejects(absent.run(OWNER),{code:"failed-precondition"});
  assert.deepEqual(absent.trace,["db"]);
});

test("success writes one sanitized unreviewed snapshot and consumes approval",async()=>{
  const t=setup();
  const result=await t.run(OWNER);
  assert.deepEqual(result,{status:"STORED_UNREVIEWED"});
  assert.deepEqual(t.trace,["db","reserve:1","secret","fetch"]);
  assert.equal(t.db.docs.get(APPROVAL_PATH).claimedAtMs,NOW);
  const records=snapshots(t.db);
  assert.equal(records.length,1);
  const [path,stored]=records[0];
  assert.match(path,/^_internal\/teamEvidence\/providerSnapshots\/ODDSPAPI_MANUAL_[A-F0-9]{32}$/);
  assert.equal(stored.status,"UNREVIEWED_PROVIDER_EVIDENCE");
  assert.equal(stored.acceptedFixtures,1);
  assert.equal(stored.records[0].fixtureId,"synthetic-fixture-1");
  assert.deepEqual(stored.records[0].participantIds,["5001","5002"]);
  assert.ok(!JSON.stringify(stored).includes("SYNTHETIC_MUST_NOT_PERSIST"));
  assert.ok(!JSON.stringify(stored).includes("bookmakerOdds"));
  assert.ok(!JSON.stringify(result).includes("5001"));
  await assert.rejects(t.run(OWNER),{code:"failed-precondition"});
  assert.equal(snapshots(t.db).length,1);
  assert.deepEqual(t.trace,["db","reserve:1","secret","fetch","db"]);
});

test("budget deny blocks secret and HTTP and consumes approval",async()=>{
  const t=setup({failure:"budget"});
  await assert.rejects(t.run(OWNER),{code:"resource-exhausted"});
  assert.deepEqual(t.trace,["db","reserve:1"]);
  assert.equal(t.db.docs.get(APPROVAL_PATH).claimedAtMs,NOW);
  assert.equal(snapshots(t.db).length,0);
  await assert.rejects(t.run(OWNER),{code:"failed-precondition"});
});

test("unverified reservation receipt blocks all outbound activity",async()=>{
  const t=setup({badReceipt:true});
  await assert.rejects(t.run(OWNER),{code:"unavailable"});
  assert.deepEqual(t.trace,["db","reserve:1"]);
});

test("provider errors are sanitized, not retried and never persisted",async()=>{
  const t=setup({failure:"provider"});
  await assert.rejects(t.run(OWNER),error=>
    error.code==="unavailable" && !error.message.includes("RAW_PROVIDER_FAILURE"));
  assert.deepEqual(t.trace,["db","reserve:1","secret","fetch"]);
  assert.equal(snapshots(t.db).length,0);
});

test("duplicate provider fixtures and missing identity store nothing",async()=>{
  for(const fixtures of [[fixture(),fixture()],
    [{...fixture(),participant2Id:null}],
    [{...fixture(),startTime:timestamp(60*1000)}]]) {
    const t=setup({fixtures});
    assert.deepEqual(await t.run(OWNER),{status:"NO_STORABLE_FIXTURES"});
    assert.equal(snapshots(t.db).length,0);
    assert.deepEqual(t.trace,["db","reserve:1","secret","fetch"]);
  }
});
