"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeOfflineManualIdentityShapeProbe } =
  require("./manual-identity-shape-probe");

const BASE = Date.parse("2026-11-18T10:00:00.000Z");
const iso = minutes => new Date(BASE + minutes * 60000).toISOString();
const OWNER = {auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const fixture = (update={}) => ({
  fixtureId:"synthetic-d15-fixture",sportId:11,tournamentId:132,
  statusId:0,hasOdds:true,startTime:iso(180),
  participant1Id:5101,participant2Id:5102,
  bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,
    markets:{}}},
  privatePlayer:"SECRET_PLAYER_NAME",privatePrice:1.87,
  ...update
});
function setup(options={}) {
  let clock = BASE, quota = 0, fetched = 0;
  const calls = {reserved:[],secretReads:0,dbReads:0,requests:0};
  const run = makeOfflineManualIdentityShapeProbe({
    ownerUid:"synthetic-owner",
    now:() => clock,
    reserve:async slots => {
      calls.reserved.push(slots);
      if (options.denyBudget || quota + slots > 6)
        throw new Error("SENSITIVE_BUDGET_FAILURE");
      quota += slots;
    },
    fetchOdds:async () => {
      fetched++;
      calls.requests++;
      if (options.failFetch) throw new Error("SECRET_API_KEY_IN_URL");
      return options.response ?? [fixture()];
    }
  });
  return {run,calls,advance:minutes=>{clock+=minutes*60000;},
    fetched:()=>fetched,quota:()=>quota};
}
test("D15 enabled constructor is completely inert",()=>{
  const s=setup();
  assert.equal(typeof s.run,"function");
  assert.deepEqual(s.calls.reserved,[]);
  assert.equal(s.fetched(),0);
});
test("D15 rejects missing or non-function trusted dependencies",()=>{
  for (const x of [{},{ownerUid:"x"},
    {ownerUid:"x",reserve:async()=>{},fetchOdds:123}]) {
    assert.throws(()=>makeOfflineManualIdentityShapeProbe(x),/Missing trusted/);
  }
});
test("D15 rejects anonymous, wrong owner, unverified email and client arguments before quota",async()=>{
  const s=setup();
  for(const bad of [null,{}, {auth:{uid:"intruder",token:{email_verified:true}},data:{}},
    {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}},
    {auth:OWNER.auth,data:{identityOnly:true}},
    {auth:OWNER.auth,data:{bookmaker:"betano.pt"}},
    {auth:OWNER.auth,data:[]}]) {
    await assert.rejects(s.run(bad));
  }
  assert.deepEqual(s.calls.reserved,[]);
  assert.equal(s.fetched(),0);
});
test("D15 makes exactly one reserved league request, no catalogue or extra lookups",async()=>{
  const s=setup(),result=await s.run(OWNER);
  assert.deepEqual(s.calls.reserved,[1]);
  assert.equal(s.fetched(),1);
  assert.equal(result.requestsUsedOnThisClick,1);
  assert.equal(result.cached,false);
  assert.equal(result.diagnostic,"PROVIDER_IDENTITY_SHAPE_ONLY");
  assert.equal(result.shapeStatus,"SAMPLE_COMPATIBLE");
  assert.equal(result.acceptedFixtures,1);
  assert.equal(result.rejectedFixtures,0);
  assert.equal(result.teamMappingApproved,false);
  assert.equal(result.bookmakerOddsVerified,false);
  assert.equal(result.researchSaved,false);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-d15|5101|5102|SECRET_PLAYER_NAME|1\.87/);
});
test("D15 missing participant ID produces reason-only blocked result",async()=>{
  const s=setup({response:[fixture({participant1Id:null})]});
  const result=await s.run(OWNER);
  assert.equal(result.shapeStatus,"BLOCKED");
  assert.equal(result.acceptedFixtures,0);
  assert.equal(result.reasonCounts.PARTICIPANT_IDS_INVALID,1);
  assert.equal(result.requestsUsedOnThisClick,1);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-d15|SECRET_PLAYER/);
});
test("D15 unsupported single-object response is BLOCKED, never guessed",async()=>{
  const s=setup({response:fixture()});
  const r=await s.run(OWNER);
  assert.equal(r.shapeStatus,"BLOCKED");
  assert.equal(r.reason,"INVALID_RESPONSE_SHAPE");
  assert.equal(r.acceptedFixtures,0);
});
test("D15 duplicate fixture IDs are both rejected",async()=>{
  const s=setup({response:[fixture(),fixture({participant2Id:6002})]});
  const r=await s.run(OWNER);
  assert.equal(r.shapeStatus,"BLOCKED");
  assert.equal(r.reasonCounts.DUPLICATE_FIXTURE_ID,2);
  assert.equal(r.acceptedFixtures,0);
});
test("D15 huge response fails bounded D13 diagnostic without extra request",async()=>{
  const s=setup({response:Array.from({length:251},(_,i)=>
    fixture({fixtureId:"synthetic-"+i}))});
  const r=await s.run(OWNER);
  assert.equal(r.shapeStatus,"BLOCKED");
  assert.equal(r.reason,"FIXTURE_COUNT_LIMIT");
  assert.deepEqual(s.calls.reserved,[1]);
});
test("D15 cache reuses schema result for 15 minutes without reserving again",async()=>{
  const s=setup();
  const first=await s.run(OWNER);
  s.advance(14);
  const cached=await s.run(OWNER);
  assert.equal(first.cached,false);
  assert.equal(cached.cached,true);
  assert.equal(cached.requestsUsedOnThisClick,0);
  assert.deepEqual(s.calls.reserved,[1]);
  assert.equal(s.fetched(),1);
});
test("D15 concurrent owner clicks share exactly one upstream reservation",async()=>{
  const s=setup();
  const both=await Promise.all([s.run(OWNER),s.run(OWNER)]);
  assert.deepEqual(new Set(both.map(x=>x.cached)),new Set([false,true]));
  assert.deepEqual(s.calls.reserved,[1]);
  assert.equal(s.fetched(),1);
});
test("D15 expired cache requires another manually triggered reservation",async()=>{
  const s=setup();
  await s.run(OWNER);
  s.advance(16);
  const r=await s.run(OWNER);
  assert.equal(r.cached,false);
  assert.deepEqual(s.calls.reserved,[1,1]);
  assert.equal(s.fetched(),2);
});
test("D15 denied backend budget never fetches or accesses provider",async()=>{
  const s=setup({denyBudget:true});
  await assert.rejects(s.run(OWNER),err=>{
    assert.equal(err.code,"unavailable");
    assert.doesNotMatch(err.message,/SENSITIVE_BUDGET_FAILURE/);
    return true;
  });
  assert.equal(s.fetched(),0);
  assert.deepEqual(s.calls.reserved,[1]);
});
test("D15 failed fetch is not retried, leaked or cached",async()=>{
  const s=setup({failFetch:true});
  await assert.rejects(s.run(OWNER),err=>{
    assert.equal(err.code,"unavailable");
    assert.doesNotMatch(err.message,/SECRET_API_KEY_IN_URL/);
    return true;
  });
  assert.equal(s.fetched(),1);
  assert.deepEqual(s.calls.reserved,[1]);
});
test("D15 source has no scheduler, Firebase admin, direct HTTP or Firestore",()=>{
  const source=fs.readFileSync(path.join(__dirname,
    "manual-identity-shape-probe.js"),"utf8");
  assert.doesNotMatch(source,/firebase-admin|firebase-functions|onSchedule\(|setInterval\(|https:\/\/|getFirestore|setDoc\(/);
});
