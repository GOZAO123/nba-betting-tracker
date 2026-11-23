"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {extractOfflineFixtureTeamEvidence:extract} =
  require("./offline-fixture-team-evidence");

const NOW=Date.parse("2026-11-23T16:00:00.000Z");
const iso=offset=>new Date(NOW+offset).toISOString();
const meta=()=>({
  reference:"ODDSPAPI_FIXTURES_"+"A".repeat(32),
  capturedAt:iso(-60_000)
});
const fixture=(id="synthetic-nba-fixture")=>({
  fixtureId:id,sportId:11,tournamentId:132,statusId:0,hasOdds:true,
  startTime:iso(3*60*60*1000),updatedAt:iso(-15*60*1000),
  participant1Id:5401,participant2Id:5402,
  participant1Name:"Los Angeles Lakers",
  participant2Name:"Utah Jazz",
  privateKey:"SYNTHETIC_SECRET_MUST_NOT_SURVIVE",
  bookmakerOdds:{"betano.pt":{market:{"PTS":{price:1.85}}}},
  otherData:{sensitive:"NO_RAW_FIXTURE_COPY"}
});
const run=(payload=[fixture()],metadata=meta(),tick=NOW)=>
  extract(payload,metadata,tick);

test("canonical provider IDs and names are preserved as UNREVIEWED source-only receipt",()=>{
  const data=run();
  assert.equal(data.source,"ODDSPAPI_V4_FIXTURES");
  assert.equal(data.status,"UNREVIEWED_PROVIDER_TEAM_NAMES");
  assert.equal(data.totalFixtures,1);
  assert.equal(data.acceptedFixtures,1);
  assert.equal(data.skippedOutsideWindow,0);
  const row=data.records[0];
  assert.deepEqual([
    row.fixtureId,row.participant1Id,row.participant2Id,
    row.participant1Name,row.participant2Name
  ],["synthetic-nba-fixture","5401","5402","Los Angeles Lakers","Utah Jazz"]);
  assert.match(row.digest,/^[a-f0-9]{64}$/);
  assert.match(data.digest,/^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(data),true);
  assert.equal(Object.isFrozen(data.records),true);
  assert.equal(Object.isFrozen(row),true);
  assert.equal("espnTeamId" in row,false);
  assert.equal("reviewStatus" in row,false);
  assert.equal("bookmakerVerified" in row,false);
  assert.doesNotMatch(JSON.stringify(data),
    /SYNTHETIC_SECRET|betano\.pt|bookmakerOdds|otherData|price|PTS|sensitive/);
});
test("source timestamp and IDs are always server-supplied, not guessed",()=>{
  assert.equal(run([fixture()],{...meta(),extra:"spoof"}),null);
  assert.equal(run([fixture()],{...meta(),reference:"client-picked-id"}),null);
  assert.equal(run([fixture()],{...meta(),capturedAt:iso(1000)}),null);
  assert.equal(run([fixture()],{...meta(),capturedAt:iso(-6*60*1000)}),null);
  assert.equal(run([fixture()],meta(),NaN),null);
  assert.equal(run([fixture()],meta(),-1),null);
});
test("reject wrong league, non-scheduled, no odds, invalid source identities",()=>{
  const mutations=[
    {sportId:10},{tournamentId:999},{statusId:1},{hasOdds:false},
    {participant1Id:0},{participant1Id:"0003"},
    {participant2Id:5401},{participant1Name:""},
    {participant1Name:"  Los Angeles Lakers"},
    {participant1Name:"Los  Angeles Lakers"},
    {participant1Name:"Unsafe\nName"},
    {participant1Name:"\u202eSpoof"},
    {participant1Name:"<script>"},
    {participant2Name:"Los Angeles Lakers"},
    {fixtureId:"unsafe id"},{startTime:"2026-11-23 19:00"},
    {updatedAt:"invalid"}
  ];
  for(const bad of mutations)
    assert.equal(run([{...fixture(),...bad}]),null,
      "unsafe field: "+Object.keys(bad)[0]);
});
test("invalid date rollover and clock-skewed provider updatedAt are rejected",()=>{
  assert.equal(run([{...fixture(),startTime:"2026-02-30T19:00:00.000Z"}]),null);
  assert.equal(run([{...fixture(),updatedAt:iso(5*60*1000)}]),null);
  assert.equal(run([{...fixture(),startTime:iso(5*60*1000)}]),null);
  assert.equal(run([{...fixture(),startTime:iso(73*60*60*1000)}]),null);
});
test("duplicate fixture IDs invalidate entire snapshot, never first-wins",()=>{
  assert.equal(run([fixture("x"),fixture("x")]),null);
  assert.equal(run([fixture("x"),{...fixture("x"),participant1Id:999}]),null);
});
test("ambiguous team IDs and names across fixtures invalidate the entire snapshot",()=>{
  assert.equal(run([fixture("x"),{...fixture("y"),participant1Name:"LA Lakers"}]),null);
  assert.equal(run([fixture("x"),{...fixture("y"),
    participant1Id:9999,participant1Name:"Los Angeles Lakers"}]),null);
  assert.equal(run([fixture("x"),{...fixture("y"),
    participant2Id:9999,participant2Name:"Utah Jazz"}]),null);
});
test("same-time fixtures remain separate unreviewed rows, not an automatic ESPN match",()=>{
  const data=run([fixture("x"),{
    ...fixture("y"),
    participant1Id:9999,participant1Name:"Boston Celtics",
    participant2Id:8888,participant2Name:"Toronto Raptors"
  }]);
  assert.equal(data.acceptedFixtures,2);
  assert.equal(data.records[0].startTime,data.records[1].startTime);
  assert.equal("espnEventId" in data,false);
  assert.equal("teamBridge" in data,false);
  assert.equal("approvedPairs" in data,false);
});
test("out-of-window fixtures are counted but never stored; no silent truncation",()=>{
  const one=run([{...fixture("old"),startTime:iso(-600_000)},fixture("valid")]);
  assert.equal(one.acceptedFixtures,1);
  assert.equal(one.skippedOutsideWindow,1);
  assert.equal(one.records[0].fixtureId,"valid");

  const many=Array.from({length:65},(_,i)=>fixture("game-"+i));
  assert.equal(run(many),null);
  const tooMany=Array.from({length:251},(_,i)=>fixture("game-"+i));
  assert.equal(run(tooMany),null);
  const allowed=Array.from({length:250},(_,i)=>
    i<64?fixture("game-"+i):{...fixture("game-"+i),
      startTime:iso(-600_000)});
  const result=run(allowed);
  assert.equal(result?.acceptedFixtures,64);
  assert.equal(result?.skippedOutsideWindow,186);
});
test("failed response envelopes, malicious getters and missing required fields fail closed",()=>{
  assert.equal(run(null),null);
  assert.equal(run({data:[fixture()]}),null);
  assert.equal(run([]),null);
  assert.equal(run([null]),null);
  assert.equal(run([{...fixture(),participant2Name:undefined}]),null);
  const hostile={...fixture()};
  Object.defineProperty(hostile,"participant1Id",{get(){throw Error("untrusted getter");}});
  assert.equal(run([hostile]),null);
});
test("source receipt fingerprint changes if any allowlisted field changes",()=>{
  const one=run([fixture()]);
  const two=run([{...fixture(),participant2Name:"Utah Jazz Basketball"}]);
  assert.ok(one&&two);
  assert.notEqual(one.digest,two.digest);
  assert.notEqual(one.records[0].digest,two.records[0].digest);
});
test("disconnected and fail-closed: no production import, API request or Firebase dependency",()=>{
  const entry=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const source=fs.readFileSync(
    path.join(__dirname,"offline-fixture-team-evidence.js"),"utf8");
  assert.doesNotMatch(entry,/require\(["']\.\/offline-fixture-team-evidence["']\)/);
  assert.doesNotMatch(source,/\b(?:fetch|onCall|onSchedule|getFirestore)\s*\(/);
  assert.doesNotMatch(source,/https:\/\/api\.oddspapi\.io/);
  assert.doesNotMatch(source,/require\(["']firebase/);
});
