"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {inspectOfflineProviderIdentityShape:inspect}=
  require("./provider-schema-readiness");
const {extractManualProviderIdentityBatch}=
  require("./provider-evidence-acquisition");
const NOW=Date.parse("2026-11-17T11:00:00.000Z");
const iso=m=>new Date(NOW+m*60000).toISOString();
const CAPTURE=iso(0);
const fixture=(update={})=>({
 fixtureId:"synthetic-d13-fixture",sportId:11,tournamentId:132,statusId:0,
 hasOdds:true,startTime:iso(180),
 participant1Id:"5001",participant2Id:"5002",
 bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,markets:{}}},
 playerName:"PRIVATE_D13_PLAYER",apiKey:"PRIVATE_D13_APIKEY",
 bookmakerPrices:{PTS:1.87},...update
});
const good=()=>inspect([fixture()],CAPTURE);
test("D13 synthetic valid fixture is shape-compatible but NEVER live-verified or deploy-ready",()=>{
 const r=good();
 assert.equal(r.status,"SAMPLE_COMPATIBLE");
 assert.equal(r.sampleOnly,true);
 assert.equal(r.liveProviderVerified,false);
 assert.equal(r.releaseReady,false);
 assert.deepEqual([r.totalFixtures,r.acceptedFixtures,r.rejectedFixtures],[1,1,0]);
 assert.equal(r.reason,"NONE");
 assert.ok(Object.values(r.reasonCounts).every(v=>v===0));
 assert.equal(Object.isFrozen(r),true);
 assert.equal(Object.isFrozen(r.reasonCounts),true);
});
test("D13 accepts all three bounded D5 response envelopes",()=>{
 const f=fixture();
 for(const payload of [[f],{data:[f]},{fixtures:[f]}]){
  const r=inspect(payload,CAPTURE);
  assert.equal(r.status,"SAMPLE_COMPATIBLE");
  assert.equal(r.acceptedFixtures,extractManualProviderIdentityBatch(payload,CAPTURE).acceptedFixtures);
 }
});
test("D13 reports mixed sample as PARTIAL_SAMPLE and never silently approves mapping",()=>{
 const r=inspect([fixture(),fixture({fixtureId:"synthetic-d13-2",participant2Id:null})],CAPTURE);
 assert.equal(r.status,"PARTIAL_SAMPLE");
 assert.deepEqual([r.totalFixtures,r.acceptedFixtures,r.rejectedFixtures],[2,1,1]);
 assert.equal(r.reasonCounts.PARTICIPANT_IDS_INVALID,1);
 assert.equal(r.releaseReady,false);
 assert.equal(Object.hasOwn(r,"teamBridge"),false);
});
test("D13 rejection reason counts reconcile with strict D5 actual acceptance",()=>{
 const input=[
  fixture(),
  fixture({fixtureId:"q2",sportId:5}),
  fixture({fixtureId:"q3",tournamentId:999}),
  fixture({fixtureId:"q4",statusId:2}),
  fixture({fixtureId:"q5",hasOdds:false}),
  fixture({fixtureId:"q6",participant1Id:null}),
  fixture({fixtureId:"q7",participant2Id:"5001"}),
  fixture({fixtureId:"q8",startTime:iso(4)}),
  fixture({fixtureId:"q9",bookmakerOdds:{}})
 ];
 const r=inspect(input,CAPTURE);
 const expected=extractManualProviderIdentityBatch(input,CAPTURE);
 assert.equal(r.status,"PARTIAL_SAMPLE");
 assert.equal(r.acceptedFixtures,expected.acceptedFixtures);
 assert.equal(r.rejectedFixtures,expected.rejectedFixtures);
 assert.equal(Object.values(r.reasonCounts).reduce((a,b)=>a+b,0),r.rejectedFixtures);
 assert.equal(r.reasonCounts.NBA_SPORT_NOT_CONFIRMED,1);
 assert.equal(r.reasonCounts.NBA_TOURNAMENT_NOT_CONFIRMED,1);
 assert.equal(r.reasonCounts.SCHEDULED_STATUS_NOT_CONFIRMED,1);
 assert.equal(r.reasonCounts.HAS_ODDS_FLAG_NOT_CONFIRMED,1);
 assert.equal(r.reasonCounts.PARTICIPANT_IDS_INVALID,1);
 assert.equal(r.reasonCounts.PARTICIPANT_IDS_DUPLICATE,1);
 assert.equal(r.reasonCounts.START_TIME_INVALID_OR_OUT_OF_WINDOW,1);
 assert.equal(r.reasonCounts.BETANO_OFFER_UNAVAILABLE,1);
});
test("D13 absent sport, tournament, status or hasOdds must not be guessed",()=>{
 const options=[{sportId:undefined},{tournamentId:undefined},
  {statusId:undefined},{hasOdds:undefined}];
 const codes=["NBA_SPORT_NOT_CONFIRMED","NBA_TOURNAMENT_NOT_CONFIRMED",
  "SCHEDULED_STATUS_NOT_CONFIRMED","HAS_ODDS_FLAG_NOT_CONFIRMED"];
 for(let i=0;i<options.length;i++){
  const r=inspect([fixture(options[i])],CAPTURE);
  assert.equal(r.status,"BLOCKED");
  assert.equal(r.acceptedFixtures,0);
  assert.equal(r.reasonCounts[codes[i]],1);
 }
});
test("D13 bookmaker absent, suspended, inactive, or without markets is unavailable",()=>{
 for(const bookmakerOdds of [
  undefined,{}, {"betano.pt":{bookmakerIsActive:false,markets:{}}},
  {"betano.pt":{bookmakerIsActive:true,suspended:true,markets:{}}},
  {"betano.pt":{bookmakerIsActive:true,suspended:false}}
 ]){
  const r=inspect([fixture({bookmakerOdds})],CAPTURE);
  assert.equal(r.reasonCounts.BETANO_OFFER_UNAVAILABLE,1);
  assert.equal(r.status,"BLOCKED");
 }
});
test("D13 duplicate fixture IDs quarantine every colliding record",()=>{
 const f=fixture();
 const r=inspect([f,{...f,participant2Id:"5999"}],CAPTURE);
 assert.deepEqual([r.acceptedFixtures,r.rejectedFixtures],[0,2]);
 assert.equal(r.reasonCounts.DUPLICATE_FIXTURE_ID,2);
 assert.equal(r.status,"BLOCKED");
});
test("D13 unrelated invalid objects are counted, not enumerated",()=>{
 const r=inspect([null,42,"bad"],CAPTURE);
 assert.equal(r.status,"BLOCKED");
 assert.equal(r.totalFixtures,3);
 assert.equal(r.reasonCounts.FIXTURE_INVALID,3);
 assert.equal(r.acceptedFixtures,0);
});
test("D13 invalid fixture ID is rejected even with synthetic bookmaker data",()=>{
 for(const id of ["bad id","../../x","",123,"a".repeat(121)]){
  const r=inspect([fixture({fixtureId:id})],CAPTURE);
  assert.equal(r.reasonCounts.FIXTURE_ID_INVALID,1);
 }
});
test("D13 kickoff at 5 minutes or after 72 hours must be blocked",()=>{
 for(const t of [iso(5),iso(72*60+1),iso(-1),"2026-11-17 13:00",null]){
  const r=inspect([fixture({startTime:t})],CAPTURE);
  assert.equal(r.status,"BLOCKED");
  assert.equal(r.reasonCounts.START_TIME_INVALID_OR_OUT_OF_WINDOW,1);
 }
});
test("D13 no valid fixture returns BLOCKED, not a misleading ready badge",()=>{
 const r=inspect([fixture({participant1Id:null})],CAPTURE);
 assert.equal(r.status,"BLOCKED");
 assert.equal(r.reason,"NO_ACCEPTED_FIXTURES");
 assert.equal(r.releaseReady,false);
});
test("D13 empty sample blocks without treating zero fixtures as successful collection",()=>{
 const r=inspect([],CAPTURE);
 assert.equal(r.status,"BLOCKED");
 assert.equal(r.reason,"EMPTY_FIXTURE_SAMPLE");
 assert.equal(r.totalFixtures,0);
 assert.equal(r.liveProviderVerified,false);
});
test("D13 no response envelope or unexpected nested object fails closed",()=>{
 for(const sample of [null,undefined,{},5,"{}",{data:{}},{events:[]}]){
  const r=inspect(sample,CAPTURE);
  assert.equal(r.status,"BLOCKED");
  assert.equal(r.reason,"INVALID_RESPONSE_SHAPE");
 }
});
test("D13 capturedAt must be complete ISO timestamp",()=>{
 for(const t of ["",null,undefined,"2026-11-17 11:00","bad",iso(0).slice(0,10)]){
  const r=inspect([fixture()],t);
  assert.equal(r.status,"BLOCKED");
  assert.equal(r.reason,"INVALID_CAPTURE_TIME");
 }
});
test("D13 maximum sample fixture count is 250, never traverse larger list",()=>{
 const arr=Array.from({length:251},(_,i)=>fixture({fixtureId:"id"+i}));
 const r=inspect(arr,CAPTURE);
 assert.equal(r.reason,"FIXTURE_COUNT_LIMIT");
 assert.equal(r.totalFixtures,0);
 assert.equal(r.acceptedFixtures,0);
});
test("D13 D5 64 accepted-row cap is a BLOCK, never truncate first 64",()=>{
 const arr=Array.from({length:65},(_,i)=>fixture({fixtureId:"id"+i}));
 const r=inspect(arr,CAPTURE);
 assert.equal(r.status,"BLOCKED");
 assert.equal(r.reason,"D5_ACCEPTED_COUNT_LIMIT");
 assert.equal(r.acceptedFixtures,0);
 assert.equal(r.totalFixtures,65);
 assert.equal(extractManualProviderIdentityBatch(arr,CAPTURE),null);
});
test("D13 64 eligible rows are bounded and only synthetic-shape-compatible",()=>{
 const arr=Array.from({length:64},(_,i)=>fixture({fixtureId:"id"+i}));
 const r=inspect(arr,CAPTURE);
 assert.equal(r.status,"SAMPLE_COMPATIBLE");
 assert.equal(r.acceptedFixtures,64);
 assert.equal(r.releaseReady,false);
});
test("D13 malformed proxy fixture returns fixed code without leaking error",()=>{
 const malicious=new Proxy({},{get(){throw new Error("PRIVATE_API_KEY");}});
 const r=inspect([malicious],CAPTURE);
 assert.equal(r.reason,"DIAGNOSTIC_INPUT_UNAVAILABLE");
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_API_KEY/);
});
test("D13 malformed proxy response envelope fails closed with fixed code",()=>{
 const malicious=new Proxy({},{get(){throw new Error("PRIVATE_RESPONSE_BODY");}});
 const r=inspect(malicious,CAPTURE);
 assert.equal(r.reason,"DIAGNOSTIC_INPUT_UNAVAILABLE");
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE_RESPONSE_BODY/);
});
test("D13 input secrets, player names, bookie offers, IDs and quotes never return",()=>{
 const r=inspect([fixture({fixtureId:"extremely-private-fixture-123",
  participant1Id:"987654321",participant2Id:"876543210",
  playerName:"PRIVATE_ATHLETE",apiKey:"PRIVATE_KEY_123",
  bookmakerPrices:{mainLine:22.5,price:1.87}})],CAPTURE);
 const text=JSON.stringify(r);
 assert.equal(r.status,"SAMPLE_COMPATIBLE");
 assert.doesNotMatch(text,/extremely-private|987654321|876543210|PRIVATE_|22\.5|1\.87|betano\.pt/);
});
test("D13 field-value mismatch cannot be inferred from team names or kickoff",()=>{
 const r=inspect([fixture({participant1Id:undefined,participant2Id:undefined,
  participant1Name:"Boston Celtics",participant2Name:"Miami Heat"})],CAPTURE);
 assert.equal(r.status,"BLOCKED");
 assert.equal(r.reasonCounts.PARTICIPANT_IDS_INVALID,1);
 assert.equal(r.releaseReady,false);
});
test("D13 no Firestore, network, paid provider, polling or production code wiring",()=>{
 const src=fs.readFileSync(path.join(__dirname,"provider-schema-readiness.js"),"utf8");
 const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 assert.doesNotMatch(src,/firebase-admin|firebase-functions|onCall\(|onSchedule\(|setInterval\(|\bfetch\(|https:\/\/api/);
 assert.doesNotMatch(index,/provider-schema-readiness|inspectOfflineProviderIdentityShape/);
});
