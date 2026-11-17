"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {captureProviderFixture,captureEspnEvent,makePendingTeamCandidate,
  reviewedManifestRow,makeOfflineTeamReviewGate}=require("./offer-team-evidence");
const {makeReviewedTeamBridgeResolver}=require("./offer-team-crosswalk");
const NOW=Date.parse("2026-11-17T10:00:00.000Z"),MIN=60000;
const iso=(minutes)=>new Date(NOW+minutes*MIN).toISOString();
const providerMeta=()=>({reference:"ODDSPAPI_SERVER_OBS_001",capturedAt:iso(-5)});
const espnMeta=()=>({reference:"ESPN_SERVER_OBS_001",capturedAt:iso(-4)});
const fixture=()=>({fixtureId:"fixture-safe-1",sportId:11,tournamentId:132,
  statusId:0,hasOdds:true,startTime:iso(180),participant1Id:"5001",
  participant2Id:"5002",participant1Name:"Untrusted Name",apiKey:"do-not-store"});
function scoreboard(events=null) {
  const event={id:"401111111",date:iso(180),status:{type:{state:"pre"}},
    season:{type:2},competitions:[{competitors:[
      {homeAway:"home",team:{id:"1",displayName:"Name A"}},
      {homeAway:"away",team:{id:"2",displayName:"Name B"}}]}]};
  return {events:events||[event]};
}
const pairs=()=>[{providerParticipantId:"5001",espnTeamId:"1"},
  {providerParticipantId:"5002",espnTeamId:"2"}];
function evidence() {
  const p=captureProviderFixture(fixture(),providerMeta());
  const e=captureEspnEvent(scoreboard(),iso(180),espnMeta());
  return {p,e,c:makePendingTeamCandidate(p,e,NOW)};
}
function journal({verified=true,clock=()=>NOW}={}) {
  let candidate=evidence().c,history=[],loads=0;
  const gate=makeOfflineTeamReviewGate({
    authorize:async auth=>verified && auth==="verified-owner" ?
      {allowed:true,reviewerReference:"OWNER_REVIEW_01"} : {allowed:false,reviewerReference:"UNKNOWN"},
    loadCandidate:async()=>{loads++;return candidate;},
    loadHistory:async()=>history.map(x=>structuredClone(x)),
    appendDecision:async({expectedRevision,candidateDigest,event})=>{
      if(history.length!==expectedRevision || candidate.candidateDigest!==candidateDigest)
        return false;
      history.push(structuredClone(event));
      return true;
    },now:clock
  });
  const approve=(rev=0,p=pairs())=>gate.submit("verified-owner",
    {fixtureId:"fixture-safe-1",action:"APPROVE",expectedRevision:rev,pairs:p});
  const revoke=(rev=1)=>gate.submit("verified-owner",
    {fixtureId:"fixture-safe-1",action:"REVOKE",expectedRevision:rev});
  const reject=(rev=0)=>gate.submit("verified-owner",
    {fixtureId:"fixture-safe-1",action:"REJECT",expectedRevision:rev});
  const query=()=>({fixtureId:"fixture-safe-1",participant1Id:"5001",
    participant2Id:"5002",startTime:iso(180)});
  return {gate,approve,revoke,reject,query,get candidate(){return candidate;},
    setCandidate:x=>{candidate=x;},getHistory:()=>history,getLoads:()=>loads};
}
test("35.1D4 provider fixture evidence extracts IDs only, never prices or secret",()=>{
  const p=evidence().p;
  assert.equal(p.fixtureId,"fixture-safe-1");
  assert.deepEqual(p.participantIds,["5001","5002"]);
  assert.match(p.digest,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(p),/Untrusted Name|do-not-store|price|apiKey/);
  assert.equal(Object.isFrozen(p),true);
});
test("35.1D4 rejects mismatched provider league, status, IDs, time and source reference",()=>{
  for(const update of [{sportId:3},{tournamentId:2},{statusId:1},{hasOdds:false},
    {participant1Id:"5002",participant2Id:"5002"},{participant1Id:"wrong"},
    {fixtureId:"bad id"},{startTime:"2026-11-17 13:00"}])
    assert.equal(captureProviderFixture({...fixture(),...update},providerMeta()),null);
  assert.equal(captureProviderFixture(fixture(),{reference:"?secret",capturedAt:iso(-5)}),null);
});
test("35.1D4 ESPN evidence uses unique regular-season scheduled event",()=>{
  const e=evidence().e;
  assert.equal(e.eventId,"401111111");
  assert.deepEqual([e.homeTeamId,e.awayTeamId],["1","2"]);
  assert.doesNotMatch(JSON.stringify(e),/Name A|Name B/);
  assert.equal(captureEspnEvent(scoreboard([]),iso(180),espnMeta()),null);
  assert.equal(captureEspnEvent(scoreboard([scoreboard().events[0],
    scoreboard().events[0]]),iso(180),espnMeta()),null);
});
test("35.1D4 ESPN fail-close on status, season, duplicate team and wrong kickoff",()=>{
  const variants=[
    e=>{e.status.type.state="in";},e=>{e.season.type=3;},
    e=>{e.competitions[0].competitors[1].team.id="1";},
    e=>{e.date=iso(187);},e=>{e.id="bad";}
  ];
  for(const mutate of variants){
    const e=structuredClone(scoreboard().events[0]);mutate(e);
    assert.equal(captureEspnEvent(scoreboard([e]),iso(180),espnMeta()),null);
  }
});
test("35.1D4 independent evidence is pending; pairing is never inferred from names",()=>{
  const c=evidence().c;
  assert.equal(c.eventId,"401111111");
  assert.deepEqual(c.participantIds,["5001","5002"]);
  assert.deepEqual(c.espnTeamIds,["1","2"]);
  assert.equal("pairs" in c,false);
  assert.equal("reviewStatus" in c,false);
});
test("35.1D4 rejects forged fingerprint, mutated fixture or ESPN identifiers",()=>{
  const {p,e}=evidence();
  for(const tamper of [
    [ {...p,participantIds:["5001","9999"]},e ],
    [ {...p,digest:"f".repeat(64)},e ],
    [ p,{...e,homeTeamId:"999"}],
    [ p,{...e,digest:"bad"}]
  ]) assert.equal(makePendingTeamCandidate(...tamper,NOW),null);
});
test("35.1D4 evidence freshness and kickoff horizon are bounded",()=>{
  const {p,e}=evidence();
  assert.equal(makePendingTeamCandidate(p,e,NOW+181*MIN),null);
  assert.equal(makePendingTeamCandidate(p,e,NOW+50*60*MIN),null);
  assert.equal(makePendingTeamCandidate(p,{...e,capturedAt:iso(-90)},NOW),null);
});
test("35.1D4 default review state creates no D3 authorization",()=>{
  const j=journal();
  assert.equal(reviewedManifestRow(j.candidate,[],NOW),null);
});
test("35.1D4 authentication precedes loading candidate or history",async()=>{
  const j=journal();
  const r=await j.gate.submit("anonymous",
    {fixtureId:"fixture-safe-1",action:"APPROVE",expectedRevision:0,pairs:pairs()});
  assert.deepEqual(r,{status:"DENIED"});
  assert.equal(j.getLoads(),0);
});
test("35.1D4 authenticated server review creates exact D3 manifest",async()=>{
  const j=journal();
  assert.deepEqual(await j.approve(),{status:"APPROVED",revision:1});
  const manifest=reviewedManifestRow(j.candidate,j.getHistory(),NOW);
  assert.equal(manifest.reviewStatus,"APPROVED");
  assert.equal(manifest.espnEventId,"401111111");
  assert.equal(j.getHistory()[0].reviewerReference,"OWNER_REVIEW_01");
  assert.deepEqual(manifest.teams,pairs());
  const resolved=makeReviewedTeamBridgeResolver([manifest],()=>NOW)(j.query());
  assert.equal(resolved.espnEventId,"401111111");
  assert.deepEqual(await j.gate.resolve(j.query()),resolved);
});
test("35.1D4 rejects invented, partial, duplicate, or crossed ESPN ID pairs",async()=>{
  for(const bad of [[pairs()[0]],[pairs()[0],pairs()[0]],
    [{providerParticipantId:"5001",espnTeamId:"9"},pairs()[1]],
    [{providerParticipantId:"5001",espnTeamId:"1"},
     {providerParticipantId:"5002",espnTeamId:"1"}],
    [{...pairs()[0],playerName:"spoof"},pairs()[1]]]){
    const j=journal();
    assert.deepEqual(await j.approve(0,bad),{status:"INVALID_PAIRS"});
    assert.equal(j.getHistory().length,0);
  }
});
test("35.1D4 no client injected proof fields in approval request",async()=>{
  const j=journal();
  const r=await j.gate.submit("verified-owner",
    {fixtureId:"fixture-safe-1",action:"APPROVE",expectedRevision:0,
      pairs:pairs(),espnEventId:"888",reviewerReference:"fake"});
  assert.deepEqual(r,{status:"INVALID_REQUEST"});
  assert.equal(j.getHistory().length,0);
});
test("35.1D4 approval is single-use, replay is rejected by revision",async()=>{
  const j=journal();
  await j.approve();
  assert.deepEqual(await j.approve(),{status:"REVISION_CONFLICT"});
  assert.equal(j.getHistory().length,1);
  assert.deepEqual(await j.approve(1),{status:"INVALID_TRANSITION"});
});
test("35.1D4 explicit rejection blocks subsequent approval",async()=>{
  const j=journal();
  assert.deepEqual(await j.reject(),{status:"REJECTED",revision:1});
  assert.equal(await j.gate.resolve(j.query()),null);
  assert.deepEqual(await j.approve(1),{status:"INVALID_TRANSITION"});
});
test("35.1D4 revocation disables crosswalk immediately and cannot be undone",async()=>{
  let tick=NOW;const j=journal({clock:()=>tick});
  await j.approve();
  assert.ok(await j.gate.resolve(j.query()));
  tick+=1000;
  assert.deepEqual(await j.revoke(),{status:"REVOKED",revision:2});
  assert.equal(await j.gate.resolve(j.query()),null);
  assert.deepEqual(await j.approve(2),{status:"INVALID_TRANSITION"});
});
test("35.1D4 revocation before approval is forbidden",async()=>{
  const j=journal();
  assert.deepEqual(await j.revoke(0),{status:"INVALID_TRANSITION"});
});
test("35.1D4 invalid review journal never becomes approved",async()=>{
  const j=journal();await j.approve();
  const h=j.getHistory();
  h[0].candidateDigest="a".repeat(64);
  assert.equal(await j.gate.resolve(j.query()),null);
  assert.deepEqual(await j.revoke(),{status:"REVIEW_HISTORY_INVALID"});
});
test("35.1D4 candidate swap invalidates old approval and refuses reuse",async()=>{
  const j=journal();await j.approve();
  const forged={...j.candidate,eventId:"401111112"};
  j.setCandidate(forged);
  assert.equal(await j.gate.resolve(j.query()),null);
  assert.deepEqual(await j.revoke(),{status:"EVIDENCE_UNAVAILABLE"});
});
test("35.1D4 foreign query participant or spoofed browser fields return no mapping",async()=>{
  const j=journal();await j.approve();
  assert.equal(await j.gate.resolve({...j.query(),participant1Id:"999"}),null);
  assert.equal(await j.gate.resolve({...j.query(),roster:"fake"}),null);
  assert.equal(await j.gate.resolve({...j.query(),startTime:iso(181)}),null);
});
test("35.1D4 concurrent approvals require an atomic append precondition",async()=>{
  const j=journal();
  const outcomes=await Promise.all([j.approve(),j.approve()]);
  assert.equal(outcomes.filter(x=>x.status==="APPROVED").length,1);
  assert.equal(outcomes.filter(x=>x.status==="REVISION_CONFLICT").length,1);
  assert.equal(j.getHistory().length,1);
});
test("35.1D4 offline-only; never import from production index or perform network",()=>{
  const fs=require("node:fs"),path=require("node:path");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const source=fs.readFileSync(path.join(__dirname,"offer-team-evidence.js"),"utf8");
  assert.doesNotMatch(index,/require\(["']\.\/offer-team-evidence["']\)/);
  assert.doesNotMatch(source,/https:\/\/|getFirestore\(|onCall\(|fetch\(|apiKey|setInterval\(/);
});

test("35.1D4 source references are opaque and sources must remain independent",()=>{
  assert.equal(captureProviderFixture(fixture(),{
    reference:"https://api.oddspapi.io/v4",capturedAt:iso(-5)}),null);
  const p=evidence().p;
  const e=captureEspnEvent(scoreboard(),iso(180),{
    reference:providerMeta().reference,capturedAt:iso(-4)});
  assert.ok(e);
  assert.equal(makePendingTeamCandidate(p,e,NOW),null);
});
test("35.1D4 forged review before source observation fails closed",async()=>{
  const j=journal();await j.approve();
  j.getHistory()[0].reviewedAt=iso(-10);
  assert.equal(await j.gate.resolve(j.query()),null);
  assert.deepEqual(await j.revoke(),{status:"REVIEW_HISTORY_INVALID"});
});
