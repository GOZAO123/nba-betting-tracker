"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {extractOfflineFixtureTeamEvidence}=require("./offline-fixture-team-evidence");
const {makeOfflineFixtureEspnReviewPacket:make}=require("./offline-fixture-espn-review-packet");
const {getReviewedTeamBridge}=require("./offer-team-crosswalk");

const NOW=Date.parse("2026-11-23T16:00:00.000Z");
const iso=n=>new Date(NOW+n).toISOString();
const reference="ODDSPAPI_FIXTURES_"+"A".repeat(32);
const metadata=()=>({reference,capturedAt:iso(-60000)});
const fixture=(id="synthetic-fixture-1")=>({
  fixtureId:id,sportId:11,tournamentId:132,statusId:0,hasOdds:true,
  startTime:iso(180*60000),updatedAt:iso(-120000),
  participant1Id:"5001",participant1Name:"Synthetic Lakers",
  participant2Id:"5002",participant2Name:"Synthetic Jazz",
  bookmakerOdds:{"betano.pt":{price:1.87}},
  privateKey:"SHOULD_NOT_COPY_ODDS"
});
const receipt=(rows=[fixture()])=>
  extractOfflineFixtureTeamEvidence(rows,metadata(),NOW);
const event=(id="401001234")=>({
  id,date:iso(180*60000),
  status:{type:{state:"pre"}},
  season:{type:2},
  competitions:[{competitors:[
    {homeAway:"home",team:{id:"13",displayName:"Synthetic Utah Jazz"}},
    {homeAway:"away",team:{id:"14",displayName:"Synthetic Los Angeles Lakers"}}
  ]}]
});
const board=(events=[event()])=>({events});
const espnMeta=()=>({reference:"ESPN_SERVER_OBS_001",capturedAt:iso(-30000)});
const input=(override={})=>({
  fixtureId:"synthetic-fixture-1",providerReceipt:receipt(),
  espnScoreboard:board(),espnMetadata:espnMeta(),now:NOW,...override
});

test("two independent synthetic sources produce a review-only immutable packet",()=>{
  const result=make(input());
  assert.ok(result);
  assert.equal(result.status,"EVIDENCE_READY_FOR_MANUAL_REVIEW");
  assert.equal(result.approved,false);
  assert.equal(result.reviewRequired,true);
  assert.equal(result.reviewedPairs,null);
  assert.equal(result.provider.source,"ODDSPAPI_V4_FIXTURES");
  assert.equal(result.espn.source,"ESPN_NBA_SCOREBOARD");
  assert.equal(result.provider.fixtureId,"synthetic-fixture-1");
  assert.deepEqual(result.provider.participants.map(p=>p.participantId),
    ["5001","5002"]);
  assert.equal(result.espn.home.teamId,"13");
  assert.equal(result.espn.away.teamId,"14");
  assert.equal(result.espn.eventId,"401001234");
  assert.equal(result.provider.reference,reference);
  assert.equal(result.espn.reference,"ESPN_SERVER_OBS_001");
  assert.match(result.packetDigest,/^[a-f0-9]{64}$/);
  for(const obj of [result,result.provider,result.espn,
    result.provider.participants,...result.provider.participants,
    result.espn.home,result.espn.away]) assert.equal(Object.isFrozen(obj),true);
  assert.doesNotMatch(JSON.stringify(result),/SHOULD_NOT_COPY_ODDS|bookmakerOdds|price/);
  assert.equal(getReviewedTeamBridge({
    fixtureId:"synthetic-fixture-1",participant1Id:"5001",
    participant2Id:"5002",startTime:iso(180*60000)
  }),null);
});

test("receipt fingerprint cannot be silently rewritten or relabeled",()=>{
  const original=receipt();
  for(const damaged of [
    {...original,digest:"0".repeat(64)},
    {...original,source:"ODDSPAPI_V4_ODDS_BY_TOURNAMENTS"},
    {...original,records:[{...original.records[0],participant1Name:"Forged Team"}]},
    {...original,records:[{...original.records[0],participant1Id:"9001"}]},
    {...original,secret:"EXTRA_CLIENT_DATA"},
    {...original,acceptedFixtures:2}
  ]) assert.equal(make(input({providerReceipt:damaged})),null);
});
test("a document carrying unreviewed raw odds is never a review receipt",()=>{
  const doc={...receipt(),rawProvider:{bookmakerOdds:{prices:[1.85]}}};
  assert.equal(make(input({providerReceipt:doc})),null);
});
test("only existing fixture ID can be selected; no guessing from kickoff",()=>{
  assert.equal(make(input({fixtureId:"not-stored"})),null);
  assert.equal(make(input({fixtureId:"unsafe fixture"})),null);
  const two=receipt([
    fixture("synthetic-fixture-1"),
    {...fixture("synthetic-fixture-2"),
      participant1Id:"6001",participant1Name:"Synthetic Cavaliers",
      participant2Id:"6002",participant2Name:"Synthetic Bulls"}
  ]);
  const result=make(input({providerReceipt:two}));
  assert.ok(result);
  assert.equal(result.provider.fixtureId,"synthetic-fixture-1");
  assert.equal(result.provider.participants.length,2);
});

test("stale or future provider and ESPN capture times fail closed",()=>{
  const ancient=extractOfflineFixtureTeamEvidence([fixture()],{
    reference,capturedAt:iso(-31*60000)
  },NOW-30*60000);
  assert.ok(ancient);
  assert.equal(make(input({providerReceipt:ancient})),null);
  assert.equal(make(input({espnMetadata:{
    ...espnMeta(),capturedAt:iso(-31*60000)
  }})),null);
  assert.equal(make(input({espnMetadata:{
    ...espnMeta(),capturedAt:iso(3000)
  }})),null);
  assert.equal(make(input({espnMetadata:{
    ...espnMeta(),reference:reference
  }})),null);
  assert.equal(make(input({espnMetadata:{
    ...espnMeta(),extra:"browser-supplied"
  }})),null);
  assert.equal(make(input({now:NaN})),null);
});

test("ambiguous simultaneous NBA fixtures are not automatically selected",()=>{
  const one=event("401001234");
  const second={...event("401001235"),competitions:[{competitors:[
    {homeAway:"home",team:{id:"21",displayName:"Synthetic Portland"}},
    {homeAway:"away",team:{id:"22",displayName:"Synthetic Philadelphia"}}
  ]}]};
  assert.equal(make(input({espnScoreboard:board([one,second])})),null);
  assert.equal(make(input({espnScoreboard:board([])})),null);
  assert.equal(make(input({espnScoreboard:board([one,one])})),null);
});

test("ESPN event must be scheduled regular-season with two distinct team IDs",()=>{
  const base=event();
  const cases=[
    {...base,status:{type:{state:"in"}}},
    {...base,season:{type:3}},
    {...base,id:"bad"},
    {...base,date:iso(181*60000+6*60000)},
    {...base,competitions:[{competitors:[
      {homeAway:"home",team:{id:"13",displayName:"Synthetic Utah Jazz"}},
      {homeAway:"away",team:{id:"13",displayName:"Synthetic Utah Jazz"}}
    ]}]}
  ];
  for(const bad of cases)assert.equal(make(input({espnScoreboard:board([bad])})),null);
});
test("noncanonical ESPN team labels and invalid team IDs are rejected",()=>{
  const original=event();
  const altered=[
    {homeAway:"home",team:{id:"13",displayName:"<script>bad</script>"}},
    {homeAway:"home",team:{id:"13",displayName:"Unsafe\u202eSuffix"}},
    {homeAway:"home",team:{id:"13",displayName:"  Synthetic Utah Jazz"}},
    {homeAway:"home",team:{id:"13",displayName:"Synthetic Los Angeles Lakers"}}
  ];
  for(const changed of altered) {
    const e=structuredClone(original);
    e.competitions[0].competitors[0]=changed;
    assert.equal(make(input({espnScoreboard:board([e])})),null);
  }
});

test("different name conventions stay unreviewed and never imply a pair",()=>{
  const changed=structuredClone(event());
  changed.competitions[0].competitors[0].team.displayName="Synthetic Salt Lake Team";
  changed.competitions[0].competitors[1].team.displayName="Synthetic Los Angeles Club";
  const packet=make(input({espnScoreboard:board([changed])}));
  assert.ok(packet);
  assert.equal(packet.reviewedPairs,null);
  assert.equal(packet.approved,false);
  assert.notEqual(packet.provider.participants[0].displayName,
    packet.espn.away.displayName);
  assert.equal(getReviewedTeamBridge({
    fixtureId:packet.provider.fixtureId,
    participant1Id:"5001",participant2Id:"5002",
    startTime:packet.provider.startTime
  }),null);
});
test("any changed source name changes the evidence binding digest",()=>{
  const original=make(input());
  const rec=receipt([{...fixture(),participant1Name:"Synthetic LA Lakers"}]);
  assert.ok(rec);
  const changed=make(input({providerReceipt:rec}));
  assert.ok(changed);
  assert.notEqual(original.packetDigest,changed.packetDigest);
  assert.notEqual(original.provider.snapshotDigest,changed.provider.snapshotDigest);
});
test("unsupported envelopes, request injection, clock, and unsafe metadata fail",()=>{
  for(const change of [
    {providerReceipt:null},{espnScoreboard:null},{espnMetadata:null},
    {fixtureId:""},{now:-1},{otherField:"untrusted"},
    {espnScoreboard:{events:Array(41).fill(event())}},
    {espnMetadata:{...espnMeta(),reference:"https://espn.example"}},
  ]) assert.equal(make(input(change)),null);
});

test("no live requests, writes, Firebase runtime exports or scheduled activity",()=>{
  const source=fs.readFileSync(path.join(__dirname,
    "offline-fixture-espn-review-packet.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(index,/require\(["']\.\/offline-fixture-espn-review-packet["']\)/);
  assert.doesNotMatch(source,/fetch\s*\(|onCall\s*\(|onSchedule\s*\(|setInterval\s*\(|getFirestore\s*\(/);
  assert.doesNotMatch(source,/firebase-functions|firebase-admin|https:\/\/api\.oddspapi\.io/);
});
