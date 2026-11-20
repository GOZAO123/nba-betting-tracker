"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeOfflineOneShotQuoteReview } =
  require("./offline-one-shot-quote-review");

const NOW = Date.parse("2026-11-20T13:00:00.000Z");
const iso = n => new Date(NOW + n * 60000).toISOString();
const REF = "ODDSPAPI_MANUAL_" + "B".repeat(32);
const OWNER = "synthetic-owner";

function definition() {
  return {marketId:91001,sportId:11,playerProp:true,period:"result",
    marketName:"Over Under Player Points (incl. overtime)",handicap:20.5,
    outcomes:[{outcomeId:92001,outcomeName:"Over"},
      {outcomeId:92002,outcomeName:"Under"}]};
}
function quote(price=1.88) {
  return {active:true,price,playerName:"Synthetic Player",
    changedAt:iso(-4),mainLine:false};
}
function source() {
  return {
    fetchedAt:NOW-60000, capturedAt:iso(-1),snapshotReference:REF,
    catalogue:[definition()],
    leagueOdds:[{fixtureId:"one-event-synthetic",sportId:11,
      tournamentId:132,participant1Id:"5001",participant2Id:"5002",
      statusId:0,hasOdds:true,startTime:iso(180),
      bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,
        suspended:false, markets:{"91001":{marketActive:true,outcomes:{
          "92001":{players:{"93001":quote(1.88)}},
          "92002":{players:{"93001":quote(1.92)}}
        }}}}}
    }]
  };
}
const request = () => ({
  auth:{uid:OWNER,token:{email_verified:true}},
  data:{fixtureId:"one-event-synthetic",marketId:"91001",providerPlayerId:"93001"}
});
function setup(config={}) {
  let count=0;
  const original=config.source??source();
  const loader=config.takeBackendOwnedSource??(async()=>{count++;return original;});
  const review=makeOfflineOneShotQuoteReview({
    ownerUid:OWNER,now:config.now??(()=>NOW),
    takeBackendOwnedSource:loader
  });
  return {review,original,request:request(),getCalls:()=>count};
}
const assertUnreviewed = result => {
  assert.equal(result?.status,"UNREVIEWED_PROVIDER_QUOTE");
  assert.deepEqual([
    result.bookmakerVerified,result.espnPlayerVerified,
    result.autoLineSelected,result.captureAllowed
  ],[false,false,false,false]);
};

test("D15.28 trusted injected source is inspected once and never selects a line",async()=>{
  const s=setup(), result=await s.review(s.request);
  assertUnreviewed(result);
  assert.equal(s.getCalls(),1);
  assert.equal(result.sourceReference,REF);
  assert.equal(result.capturedAt,iso(-1));
  assert.equal(result.fixtureId,"one-event-synthetic");
  assert.equal(result.providerPlayerId,"93001");
  assert.deepEqual([result.outcomes.Over.price,result.outcomes.Under.price],[1.88,1.92]);
  assert.equal(result.freshness,"FRESH_WITHIN_15_MIN");
  assert.equal(result.mainLineEvidence,"NO_EXPLICIT_FLAGS");
});

test("D15.28 a second review cannot reuse consumed source, even with a new selection",async()=>{
  const s=setup();
  assertUnreviewed(await s.review(s.request));
  const second=structuredClone(s.request);
  second.data.marketId="91002";
  assert.equal(await s.review(second),null);
  assert.equal(s.getCalls(),1);
});

test("D15.28 concurrently submitted selections consume one source only",async()=>{
  let hits=0;
  const s=setup({takeBackendOwnedSource:async()=>{
    hits++;
    await Promise.resolve();
    return source();
  }});
  const [a,b]=await Promise.all([s.review(s.request),s.review(s.request)]);
  assert.equal([a,b].filter(x=>x!==null).length,1);
  assert.equal(hits,1);
});

test("D15.28 anonymous, wrong-owner and email-unverified requests never touch source",async()=>{
  const s=setup();
  for(const bad of [null,{}, {data:s.request.data},
    {auth:{uid:"not-the-owner",token:{email_verified:true}},data:s.request.data},
    {auth:{uid:OWNER,token:{email_verified:false}},data:s.request.data},
    {auth:{uid:OWNER,token:{}},data:s.request.data}]) {
    assert.equal(await s.review(bad),null);
  }
  assert.equal(s.getCalls(),0);
  assertUnreviewed(await s.review(s.request));
  assert.equal(s.getCalls(),1);
});

test("D15.28 browser-supplied odds and fake approval cannot enter trusted quote source",async()=>{
  for(const field of ["catalogue","leagueOdds","capturedAt","snapshotReference",
    "source","receipt","espnEvent","verified","approved","price","playerName"]) {
    const s=setup();
    const bad=structuredClone(s.request);
    bad.data[field]={claimed:true,price:99.99};
    assert.equal(await s.review(bad),null);
    assert.equal(s.getCalls(),0);
    assertUnreviewed(await s.review(s.request));
  }
});

test("D15.28 request must contain only three valid exact selectors",async()=>{
  for(const data of [{},{marketId:"91001",providerPlayerId:"93001"},
    {fixtureId:"../../other",marketId:"91001",providerPlayerId:"93001"},
    {fixtureId:"one-event-synthetic",marketId:"0",providerPlayerId:"93001"},
    {fixtureId:"one-event-synthetic",marketId:"91001",providerPlayerId:"abc"},
    {fixtureId:"one-event-synthetic",marketId:"91001",providerPlayerId:"93001",uid:OWNER}]) {
    const s=setup();
    assert.equal(await s.review({...s.request,data}),null);
    assert.equal(s.getCalls(),0);
  }
});

test("D15.28 source receipt expires before inspection; cannot retry consumed session",async()=>{
  const s=setup({source:{...source(),fetchedAt:NOW-121000}});
  assert.equal(await s.review(s.request),null);
  assert.equal(await s.review(s.request),null);
  assert.equal(s.getCalls(),1);
});

test("D15.28 source future times, late capture and mismatched fetch time fail closed",async()=>{
  const changes=[
    {fetchedAt:NOW+1},{fetchedAt:-1},{fetchedAt:NaN},
    {capturedAt:iso(1)},{capturedAt:iso(-5)},
    {capturedAt:"not-a-time"},{capturedAt:null},
    {fetchedAt:NOW-180000,capturedAt:iso(-1)}
  ];
  for(const change of changes) {
    const s=setup({source:{...source(),...change}});
    assert.equal(await s.review(s.request),null);
    assert.equal(s.getCalls(),1);
  }
});

test("D15.28 malformed backend source shape and extra fields are rejected once",async()=>{
  for(const original of [null,{},[],{...source(),extra:true},
    {...source(),snapshotReference:"forged-source"}]) {
    const s=setup({source:original});
    assert.equal(await s.review(s.request),null);
    assert.equal(s.getCalls(),1);
  }
});

test("D15.28 backend source callback failure is private and non-retryable",async()=>{
  let hits=0;
  const s=setup({takeBackendOwnedSource:async()=>{
    hits++;
    throw Error("PRIVATE API KEY AND QUOTES");
  }});
  assert.equal(await s.review(s.request),null);
  assert.equal(await s.review(s.request),null);
  assert.equal(hits,1);
});

test("D15.28 invalid source quote pairs fail without re-fetch or invented values",async()=>{
  const original=source();
  delete original.leagueOdds[0].bookmakerOdds["betano.pt"]
    .markets["91001"].outcomes["92002"];
  const s=setup({source:original});
  assert.equal(await s.review(s.request),null);
  assert.equal(await s.review(s.request),null);
  assert.equal(s.getCalls(),1);
});

test("D15.28 same player name does not allow unknown provider-player ID",async()=>{
  const s=setup();
  const bad=structuredClone(s.request);
  bad.data.providerPlayerId="93002";
  assert.equal(await s.review(bad),null);
  assert.equal(s.getCalls(),1);
});

test("D15.28 source quote and receipt are frozen by value against subsequent mutations",async()=>{
  const s=setup(),result=await s.review(s.request);
  assertUnreviewed(result);
  assert.ok(Object.isFrozen(result));
  const previousDigest=result.digest;
  const original=s.original.leagueOdds[0].bookmakerOdds["betano.pt"]
    .markets["91001"].outcomes["92001"].players["93001"];
  original.price=2.34;
  s.original.snapshotReference="ODDSPAPI_MANUAL_"+"C".repeat(32);
  assert.equal(result.outcomes.Over.price,1.88);
  assert.equal(result.sourceReference,REF);
  assert.equal(result.digest,previousDigest);
});

test("D15.28 malformed time callback fails closed without invoking source callback",async()=>{
  const s=setup({now:()=>{throw Error("PRIVATE CLOCK");}});
  assert.equal(await s.review(s.request),null);
  assert.equal(s.getCalls(),0);
  assert.equal(await s.review(s.request),null);
});

test("D15.28 source may be reused in another factory: cross-session replay is NOT attested",async()=>{
  // This intentionally documents the unimplemented global durable/replay gate.
  const shared=source();
  const a=setup({source:shared}), b=setup({source:shared});
  assertUnreviewed(await a.review(a.request));
  assertUnreviewed(await b.review(b.request));
  assert.equal(a.getCalls(),1);
  assert.equal(b.getCalls(),1);
});

test("D15.28 missing backend loader or owner rejects construction",()=>{
  for(const config of [{},{ownerUid:OWNER},
    {ownerUid:"",takeBackendOwnedSource:async()=>source()},
    {ownerUid:OWNER,takeBackendOwnedSource:"from-browser"},
    {ownerUid:OWNER,takeBackendOwnedSource:async()=>source(),now:0}])
    assert.throws(()=>makeOfflineOneShotQuoteReview(config),
      /Missing backend-owned quote source dependencies/);
});

test("D15.28 no deployed callable, persistence, polling or direct provider transport",()=>{
  const production=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const code=fs.readFileSync(path.join(__dirname,"offline-one-shot-quote-review.js"),"utf8");
  assert.doesNotMatch(production,/offline-one-shot-quote-review|makeOfflineOneShotQuoteReview/);
  assert.doesNotMatch(code,/require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(code,/\b(?:fetch|setInterval|setTimeout|onCall|onSchedule)\s*\(/);
  assert.doesNotMatch(code,/\b(?:db|tx|firestore)\s*\.\s*(?:set|update|create|delete)\s*\(/);
});
