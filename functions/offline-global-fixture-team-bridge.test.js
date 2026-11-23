"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {extractOfflineFixtureTeamEvidence}=
  require("./offline-fixture-team-evidence");
const {makeOfflineFixturesTeamReviewGate}=
  require("./offline-fixtures-team-review-gate");
const {makeOfflineGlobalFixtureTeamBridge}=
  require("./offline-global-fixture-team-bridge");
const {getReviewedTeamBridge}=require("./offer-team-crosswalk");

const NOW=Date.parse("2026-11-23T16:00:00.000Z");
const iso=delta=>new Date(NOW+delta).toISOString();
const MINUTE=60000;
const defaults={
  fixtureId:"synthetic-global-a",letter:"A",eventId:"401123456",
  offset:180,providers:["5001","5002"],espn:["14","13"],
  pairs:[["5001","14"],["5002","13"]]
};
function record(changes={}) {
  const opts={...defaults,...changes};
  const {fixtureId,letter,eventId,offset,providers,espn}=opts;
  const startTime=iso(offset*MINUTE);
  const providerReceipt=extractOfflineFixtureTeamEvidence([{
    fixtureId,sportId:11,tournamentId:132,statusId:0,hasOdds:true,
    startTime,updatedAt:iso(-2*MINUTE),
    participant1Id:providers[0],participant2Id:providers[1],
    participant1Name:"Synthetic "+providers[0],
    participant2Name:"Synthetic "+providers[1],
    bookmakerOdds:{"betano.pt":{PTS:{price:1.88}}},
    credential:"DO_NOT_COPY_SYNTHETIC_SECRET"
  }],{
    reference:"ODDSPAPI_FIXTURES_"+letter.repeat(32),
    capturedAt:iso(-MINUTE)
  },NOW);
  assert.ok(providerReceipt);
  return {
    fixtureId,providerReceipt,
    espnScoreboard:{events:[{
      id:eventId,date:startTime,status:{type:{state:"pre"}},
      season:{type:2},competitions:[{competitors:[
        {homeAway:"home",team:{id:espn[0],
          displayName:"Synthetic ESPN "+espn[0]}},
        {homeAway:"away",team:{id:espn[1],
          displayName:"Synthetic ESPN "+espn[1]}}
      ]}]
    }]},
    espnMetadata:{
      reference:"ESPN_GLOBAL_"+letter+"_SOURCE",
      capturedAt:iso(-MINUTE/2)
    },
    history:[]
  };
}
const pairs=values=>values.map(
  ([providerParticipantId,espnTeamId])=>
    ({providerParticipantId,espnTeamId})
);
async function decide(entry,action="APPROVE",values=defaults.pairs,offset=0) {
  const gate=makeOfflineFixturesTeamReviewGate({
    authorize:async()=>({allowed:true,reviewerReference:"OWNER_REVIEW_01"}),
    loadEvidence:async()=>({
      providerReceipt:entry.providerReceipt,
      espnScoreboard:entry.espnScoreboard,
      espnMetadata:entry.espnMetadata
    }),
    loadHistory:async()=>structuredClone(entry.history),
    async appendDecision({event,expectedRevision,packetDigest}) {
      assert.equal(expectedRevision,entry.history.length);
      if(entry.history.length)
        assert.equal(entry.history.at(-1).packetDigest,packetDigest);
      entry.history.push(structuredClone(event));
      return true;
    },
    now:()=>NOW+offset
  });
  const request={
    fixtureId:entry.fixtureId,action,
    expectedRevision:entry.history.length,
    ...(action==="APPROVE"?{pairs:pairs(values)}:{})
  };
  const result=await gate.submit("trusted-synthetic-reviewer",request);
  assert.equal(result.status,action==="APPROVE"?"APPROVED":
    action==="REVOKE"?"REVOKED":"REJECTED");
  return entry;
}
function createResolver(records,options={}) {
  let reads=0,checks=0;
  const snapshot={complete:options.complete??true,
    records};
  if(options.invalidExtra)snapshot.clientProvided="NEVER_TRUST";
  const runner=makeOfflineGlobalFixtureTeamBridge({
    async loadCompleteReviewSet(){reads++;return snapshot;},
    async isTrustedCompleteSet(value,tick) {
      checks++;
      assert.equal(tick,options.tick??NOW);
      return options.trusted!==false && value===snapshot;
    },
    now:()=>options.tick??NOW
  });
  return {runner,stats:()=>({reads,checks})};
}
const second=changes=>record({
  fixtureId:"synthetic-global-b",letter:"B",
  eventId:"401123457",offset:240,
  providers:["5001","5003"],espn:["14","15"],...changes
});
const query=(r,providerIds)=>({
  fixtureId:r.fixtureId,
  participant1Id:providerIds[0],participant2Id:providerIds[1],
  startTime:r.providerReceipt.records[0].startTime
});

test("global gate requires a complete trusted set callback",()=>{
  assert.throws(()=>makeOfflineGlobalFixtureTeamBridge(),TypeError);
  assert.throws(()=>makeOfflineGlobalFixtureTeamBridge({
    loadCompleteReviewSet:async()=>({complete:true,records:[]})
  }),TypeError);
});

test("consistent explicit pairs across two fixtures resolve; production remains empty",async()=>{
  const a=await decide(record());
  const b=await decide(second(),"APPROVE",
    [["5001","14"],["5003","15"]]);
  const {runner,stats}=createResolver([a,b]);
  const q1=query(a,["5001","5002"]);
  const q2=query(b,["5001","5003"]);
  assert.deepEqual((await runner.resolve(q1)).teamBridge,
    pairs([["5001","14"],["5002","13"]]));
  assert.deepEqual((await runner.resolve(q2)).teamBridge,
    pairs([["5001","14"],["5003","15"]]));
  assert.deepEqual(stats(),{reads:2,checks:2});
  assert.equal(getReviewedTeamBridge(q1),null);
});

test("provider ID mapped to two ESPN IDs poisons even an unrelated first fixture",async()=>{
  const a=await decide(record());
  const b=await decide(second({espn:["16","15"]}),"APPROVE",
    [["5001","16"],["5003","15"]]);
  const {runner}=createResolver([a,b]);
  assert.equal(await runner.resolve(query(a,["5001","5002"])),null);
  assert.equal(await runner.resolve(query(b,["5001","5003"])),null);
});

test("two provider IDs mapped to one ESPN team poisons whole set",async()=>{
  const a=await decide(record());
  const b=await decide(second({
    providers:["5004","5003"],espn:["14","15"]
  }),"APPROVE",[["5004","14"],["5003","15"]]);
  const {runner}=createResolver([a,b]);
  assert.equal(await runner.resolve(query(a,["5001","5002"])),null);
  assert.equal(await runner.resolve(query(b,["5004","5003"])),null);
});

test("duplicate fixture is rejected, regardless of status",async()=>{
  const a=await decide(record());
  const {runner}=createResolver([a,structuredClone(a)]);
  assert.equal(await runner.resolve(query(a,["5001","5002"])),null);
});

test("revoked and rejected observations cannot authorize or poison active mappings",async()=>{
  const a=await decide(record());
  const b=await decide(second({espn:["16","15"]}),"APPROVE",
    [["5001","16"],["5003","15"]]);
  // Revocation is a separate genuine owner action and keeps full history.
  await decide(b,"REVOKE",[],1000);
  const {runner}=createResolver([a,b],{tick:NOW+1000});
  assert.deepEqual((await runner.resolve(query(a,["5001","5002"]))).teamBridge,
    pairs([["5001","14"],["5002","13"]]));
  assert.equal(await runner.resolve(query(b,["5001","5003"])),null);

  const c=await decide(second({letter:"C",fixtureId:"synthetic-global-c"}),
    "REJECT",[]);
  const neutral=createResolver([a,c]);
  assert.ok(await neutral.runner.resolve(query(a,["5001","5002"])));
  assert.equal(await neutral.runner.resolve(query(c,["5001","5003"])),null);
});

test("pending records remain nonauthorizing and do not suppress real approval",async()=>{
  const a=await decide(record());
  const b=second({espn:["16","15"]}); // no approval
  const {runner}=createResolver([a,b]);
  assert.ok(await runner.resolve(query(a,["5001","5002"])));
  assert.equal(await runner.resolve(query(b,["5001","5003"])),null);
});

test("a forged, stale or altered source or journal poisons the full snapshot",async()=>{
  const a=await decide(record());
  const b=await decide(second(),"APPROVE",[["5001","14"],["5003","15"]]);
  for(const changed of [
    r=>{r.providerReceipt.digest="0".repeat(64);},
    r=>{r.providerReceipt.records[0].participant1Id="7777";},
    r=>{r.espnScoreboard.events[0].competitions[0]
      .competitors[0].team.displayName="Synthetic Spoofed Team";},
    r=>{r.history[0].eventDigest="0".repeat(64);},
    r=>{r.history[0].packetDigest="f".repeat(64);}
  ]) {
    const bad=structuredClone(b);
    changed(bad);
    assert.equal(await createResolver([a,bad]).runner.resolve(
      query(a,["5001","5002"])),null);
  }
  const stale=createResolver([a,b],{tick:NOW+31*MINUTE});
  assert.equal(await stale.runner.resolve(query(a,["5001","5002"])),null);
});

test("missing trusted completeness proof or malformed set fails without approval",async()=>{
  const a=await decide(record());
  const q=query(a,["5001","5002"]);
  const untrusted=createResolver([a],{trusted:false});
  assert.equal(await untrusted.runner.resolve(q),null);
  assert.deepEqual(untrusted.stats(),{reads:1,checks:1});
  assert.equal(await createResolver([a],{complete:false}).runner.resolve(q),null);
  assert.equal(await createResolver([a],{invalidExtra:true}).runner.resolve(q),null);
  assert.equal(await createResolver(Array(129).fill(a)).runner.resolve(q),null);
  assert.equal(await createResolver([null]).runner.resolve(q),null);
  assert.equal(await createResolver([]).runner.resolve(q),null);
});
test("invalid queries are rejected before even loading sensitive review records",async()=>{
  const a=await decide(record());
  const {runner,stats}=createResolver([a]);
  const q=query(a,["5001","5002"]);
  for(const bad of [
    {...q,extra:"client-proof"},
    {...q,participant2Id:"5001"},
    {...q,participant1Id:5001},
    {...q,fixtureId:"../escape"},
    {...q,startTime:null},
    {fixtureId:q.fixtureId},
    null
  ])assert.equal(await runner.resolve(bad),null);
  assert.deepEqual(stats(),{reads:0,checks:0});
});

test("global helper stays disconnected from Firebase, HTTP and production index",()=>{
  const source=fs.readFileSync(path.join(__dirname,
    "offline-global-fixture-team-bridge.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(index,
    /require\(["']\.\/offline-global-fixture-team-bridge["']\)/);
  assert.doesNotMatch(source,
    /onCall\s*\(|onSchedule\s*\(|getFirestore\s*\(|\bfetch\s*\(/);
  assert.doesNotMatch(source,/firebase-admin|firebase-functions|api\.oddspapi\.io/);
});
