"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {extractOfflineFixtureTeamEvidence}=require("./offline-fixture-team-evidence");
const {makeOfflineFixturesTeamReviewGate}=
  require("./offline-fixtures-team-review-gate");
const {getReviewedTeamBridge}=require("./offer-team-crosswalk");

const NOW=Date.parse("2026-11-23T16:00:00.000Z");
const iso=n=>new Date(NOW+n).toISOString();
const FIXTURE_ID="synthetic-d18-fixture";
const ref="ODDSPAPI_FIXTURES_"+"A".repeat(32);
const fixture=(name="Synthetic Lakers")=>({
  fixtureId:FIXTURE_ID,sportId:11,tournamentId:132,statusId:0,
  hasOdds:true,startTime:iso(180*60000),updatedAt:iso(-120000),
  participant1Id:5001,participant1Name:name,
  participant2Id:5002,participant2Name:"Synthetic Utah Jazz",
  bookmakerOdds:{"betano.pt":{price:1.89}},
  rawSecret:"DO_NOT_STORE"
});
const provider=(name)=>extractOfflineFixtureTeamEvidence([fixture(name)],{
  reference:ref,capturedAt:iso(-60000)
},NOW);
const scoreboard=(override={})=>({events:[{
  id:"401123456",date:iso(180*60000),season:{type:2},
  status:{type:{state:"pre"}},competitions:[{competitors:[
    {homeAway:"home",team:{id:"13",displayName:"Synthetic Utah Jazz"}},
    {homeAway:"away",team:{id:"14",displayName:"Synthetic Los Angeles Lakers"}}
  ]}],...override
}]});
const reviewEvidence=()=>({
  providerReceipt:provider(),
  espnScoreboard:scoreboard(),
  espnMetadata:{reference:"ESPN_SERVER_OBS_001",capturedAt:iso(-30000)}
});
const query=()=>({
  fixtureId:FIXTURE_ID,participant1Id:"5001",participant2Id:"5002",
  startTime:iso(180*60000)
});
const pair=()=>[
  {providerParticipantId:"5001",espnTeamId:"14"},
  {providerParticipantId:"5002",espnTeamId:"13"}
];
function journal({clock=()=>NOW,verified=true}={}) {
  let evidence=reviewEvidence(),history=[],loads=0;
  const gate=makeOfflineFixturesTeamReviewGate({
    authorize:async auth=>verified && auth==="synthetic-verified-owner" ?
      {allowed:true,reviewerReference:"OWNER_REVIEW_01"} :
      {allowed:false,reviewerReference:"UNKNOWN"},
    loadEvidence:async()=>{loads++;return structuredClone(evidence);},
    loadHistory:async()=>structuredClone(history),
    appendDecision:async({fixtureId,expectedRevision,packetDigest,event})=>{
      if(fixtureId!==FIXTURE_ID || history.length!==expectedRevision ||
          (history.length && history[history.length-1].packetDigest!==packetDigest))
        return false;
      history.push(structuredClone(event));return true;
    },
    now:clock
  });
  const submit=(action,revision=0,pairs=pair(),auth="synthetic-verified-owner")=>
    gate.submit(auth,{
      fixtureId:FIXTURE_ID,action,expectedRevision:revision,
      ...(action==="APPROVE"?{pairs}: {})
    });
  return {gate,submit,query,get history(){return history;},get loads(){return loads;},
    set evidence(v){evidence=v;},get evidence(){return evidence;}};
}
test("D18 gate requires trusted injected backend dependencies",()=>{
  assert.throws(()=>makeOfflineFixturesTeamReviewGate({}),TypeError);
});

test("D18 exact manual two-way approval unlocks only matched D3 resolver",async()=>{
  const j=journal();
  assert.equal(await j.gate.resolve(query()),null);
  assert.deepEqual(await j.submit("APPROVE"),{status:"APPROVED",revision:1});
  assert.equal(j.history.length,1);
  const decision=j.history[0];
  assert.equal(decision.reviewMethod,"MANUAL_TWO_SOURCE_FIXTURES_ID_REVIEW");
  assert.equal(decision.reviewerReference,"OWNER_REVIEW_01");
  assert.match(decision.packetDigest,/^[a-f0-9]{64}$/);
  assert.match(decision.eventDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(decision.pairs,pair());
  assert.equal(decision.fixtureId,FIXTURE_ID);
  assert.doesNotMatch(JSON.stringify(decision),
    /bookmakerOdds|price|rawSecret|DO_NOT_STORE/);

  const result=await j.gate.resolve(query());
  assert.ok(result);
  assert.equal(result.espnEventId,"401123456");
  assert.deepEqual(result.teamBridge,pair());
  // The production manifest stays EMPTY; only this disconnected test gate
  // can resolve the explicit synthetic mapping from its private journal.
  assert.equal(getReviewedTeamBridge(query()),null);
  assert.equal(await j.gate.resolve({...query(),espnEventId:"401123456"}),null);
  assert.equal(await j.gate.resolve({...query(),participant1Id:"9000"}),null);
  assert.equal(await j.gate.resolve({...query(),startTime:iso(181*60000)}),null);
});

test("D18 invalid or anonymous review cannot read source evidence",async()=>{
  const j=journal();
  assert.deepEqual(await j.submit("APPROVE",0,pair(),"intruder"),
    {status:"DENIED"});
  assert.equal(j.loads,0);
  assert.equal(j.history.length,0);
});
test("D18 client cannot inject source, packet, reviewer, or approval state",async()=>{
  const j=journal();
  for(const extra of [
    {providerReceipt:provider()},{packetDigest:"f".repeat(64)},
    {reviewerReference:"FOREIGN"},{approved:true},
    {espnEventId:"401123456"}
  ]) {
    const result=await j.gate.submit("synthetic-verified-owner",{
      fixtureId:FIXTURE_ID,action:"APPROVE",expectedRevision:0,pairs:pair(),
      ...extra
    });
    assert.deepEqual(result,{status:"INVALID_REQUEST"});
  }
  assert.equal(j.loads,0);
  assert.equal(j.history.length,0);
});

test("D18 rejecting unknown, missing, duplicated, non-bijective pair IDs",async()=>{
  for(const pairs of [
    [pair()[0]],[pair()[0],pair()[0]],
    [{providerParticipantId:"5001",espnTeamId:"13"},
     {providerParticipantId:"5002",espnTeamId:"13"}],
    [{providerParticipantId:"5001",espnTeamId:"14"},
     {providerParticipantId:"9999",espnTeamId:"13"}],
    [{providerParticipantId:"5001",espnTeamId:"9999"},pair()[1]],
    [{...pair()[0],claimedName:"Synthetic Lakers"},pair()[1]]
  ]) {
    const j=journal();
    assert.deepEqual(await j.submit("APPROVE",0,pairs),
      {status:"INVALID_PAIRS"});
    assert.equal(j.history.length,0);
  }
});

test("D18 the gate does not infer pairing from names or order",async()=>{
  const j=journal();
  const changed=j.evidence;
  changed.espnScoreboard.events[0].competitions[0].competitors[0]
    .team.displayName="Completely Different Official Label";
  changed.espnScoreboard.events[0].competitions[0].competitors[1]
    .team.displayName="Other Independent Team Label";
  j.evidence=changed;
  assert.equal(await j.gate.resolve(query()),null);
  assert.deepEqual(await j.submit("APPROVE"),{status:"APPROVED",revision:1});
  assert.deepEqual((await j.gate.resolve(query())).teamBridge,pair());
});

test("D18 exact source fingerprint prevents reusing approval after source change",async()=>{
  const j=journal();
  assert.deepEqual(await j.submit("APPROVE"),{status:"APPROVED",revision:1});
  const evidence=j.evidence;
  evidence.providerReceipt=provider("Synthetic LA Lakers");
  j.evidence=evidence;
  assert.equal(await j.gate.resolve(query()),null);
  assert.deepEqual(await j.submit("REVOKE",1),{status:"REVIEW_HISTORY_INVALID"});
  assert.equal(j.history.length,1);
});

test("D18 tampered journal digest, packet, revision or reviewed pair fails",async()=>{
  const alterations=[
    h=>{h[0].eventDigest="0".repeat(64);},
    h=>{h[0].packetDigest="0".repeat(64);},
    h=>{h[0].revision=3;},
    h=>{h[0].reviewMethod="MANUAL_TWO_SOURCE_ID_REVIEW";},
    h=>{h[0].pairs[0].espnTeamId="99";},
    h=>{h[0].reviewerReference="unsafe";},
    h=>{h[0].reviewedAt=iso(-200000);}
  ];
  for(const edit of alterations) {
    const j=journal();await j.submit("APPROVE");edit(j.history);
    assert.equal(await j.gate.resolve(query()),null);
    assert.deepEqual(await j.submit("REVOKE",1),{status:"REVIEW_HISTORY_INVALID"});
  }
});

test("D18 explicit rejection blocks approval; revocation disables mapping",async()=>{
  const rejected=journal();
  assert.deepEqual(await rejected.submit("REJECT"),{status:"REJECTED",revision:1});
  assert.deepEqual(await rejected.submit("APPROVE",1),{status:"INVALID_TRANSITION"});
  assert.equal(await rejected.gate.resolve(query()),null);
  let tick=NOW;
  const j=journal({clock:()=>tick});
  assert.deepEqual(await j.submit("APPROVE"),{status:"APPROVED",revision:1});
  assert.ok(await j.gate.resolve(query()));
  tick+=1000;
  assert.deepEqual(await j.submit("REVOKE",1),{status:"REVOKED",revision:2});
  assert.equal(await j.gate.resolve(query()),null);
  assert.deepEqual(await j.submit("APPROVE",2),{status:"INVALID_TRANSITION"});
  assert.deepEqual(await j.submit("REVOKE",2),{status:"INVALID_TRANSITION"});
});

test("D18 concurrent attempts require atomic compare and set, cannot replay",async()=>{
  const j=journal();
  const result=await Promise.all([j.submit("APPROVE"),j.submit("APPROVE")]);
  assert.equal(result.filter(x=>x.status==="APPROVED").length,1);
  assert.equal(result.filter(x=>x.status==="REVISION_CONFLICT").length,1);
  assert.equal(j.history.length,1);
  assert.deepEqual(await j.submit("APPROVE"),{status:"REVISION_CONFLICT"});
});

test("D18 missing or ambiguous ESPN evidence never reaches review journal",async()=>{
  const j=journal();
  const ev=j.evidence;
  const copy=structuredClone(ev.espnScoreboard.events[0]);
  copy.id="401123457";
  ev.espnScoreboard.events.push(copy);
  j.evidence=ev;
  assert.deepEqual(await j.submit("APPROVE"),{status:"EVIDENCE_UNAVAILABLE"});
  assert.equal(j.history.length,0);
});

test("D18 stale capture and near-tipoff packet cannot authorize",async()=>{
  let tick=NOW;
  const j=journal({clock:()=>tick});
  tick+=31*60000;
  assert.deepEqual(await j.submit("APPROVE"),{status:"EVIDENCE_UNAVAILABLE"});
  assert.equal(j.history.length,0);
  const j2=journal({clock:()=>NOW+179*60000});
  assert.equal(await j2.gate.resolve(query()),null);
  assert.deepEqual(await j2.submit("APPROVE"),{status:"EVIDENCE_UNAVAILABLE"});
});

test("D18 non-blocking source errors and CAS failures fail closed",async()=>{
  const j=makeOfflineFixturesTeamReviewGate({
    authorize:async()=>({allowed:true,reviewerReference:"OWNER_REVIEW_01"}),
    loadEvidence:async()=>{throw Error("RAW_INTERNAL_SECRET");},
    loadHistory:async()=>[],
    appendDecision:async()=>true,now:()=>NOW
  });
  const out=await j.submit("owner",{
    fixtureId:FIXTURE_ID,action:"APPROVE",expectedRevision:0,pairs:pair()
  });
  assert.deepEqual(out,{status:"UNAVAILABLE"});
  const second=makeOfflineFixturesTeamReviewGate({
    authorize:async()=>({allowed:true,reviewerReference:"OWNER_REVIEW_01"}),
    loadEvidence:async()=>reviewEvidence(),
    loadHistory:async()=>[],
    appendDecision:async()=>false,now:()=>NOW
  });
  assert.deepEqual(await second.submit("owner",{
    fixtureId:FIXTURE_ID,action:"APPROVE",expectedRevision:0,pairs:pair()
  }),{status:"REVISION_CONFLICT"});
});

test("D18 production entrypoint stays disconnected and no network is invoked",()=>{
  const source=fs.readFileSync(path.join(__dirname,"offline-fixtures-team-review-gate.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(index,/require\(["']\.\/offline-fixtures-team-review-gate["']\)/);
  assert.doesNotMatch(source,/\bfetch\s*\(|\bonCall\s*\(|\bonSchedule\s*\(|\bgetFirestore\s*\(/);
  assert.doesNotMatch(source,/firebase-functions|firebase-admin|api\.oddspapi\.io/);
});
