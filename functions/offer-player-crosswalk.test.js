"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {freezeUnreviewedProviderPlayerPair}=
  require("./provider-player-quote-snapshot");
const {makeReviewedTeamBridgeResolver}=
  require("./offer-team-crosswalk");
const {inspectOfflineNbaOffers}=
  require("./offer-matching");
const {makeReviewedPlayerBridgeResolver,getReviewedPlayerBridge}=
  require("./offer-player-crosswalk");

const NOW=Date.parse("2026-11-20T16:00:00.000Z");
const iso=minutes=>new Date(NOW+minutes*60000).toISOString();
const P="93001",A="7001",TEAM="1001",OTHER_TEAM="1002";
const FIXTURE="synthetic-provider-fixture-36";
const REF="ODDSPAPI_MANUAL_"+"A".repeat(32);
const PROVIDER_NAME="Daniels, Synthetic";
const ESPN_NAME="Synthetic Daniels";
const OFFICIAL_MARKET={
  marketId:91001,sportId:11,playerProp:true,period:"result",
  marketName:"Over Under Player Points (incl. overtime)",
  handicap:10.5,outcomes:[
    {outcomeId:92001,outcomeName:"Over"},
    {outcomeId:92002,outcomeName:"Under"}
  ]
};
function fixture(){
  const player=(price)=>({
    active:true,price,playerName:PROVIDER_NAME,
    changedAt:iso(-3),mainLine:false
  });
  return {
    fixtureId:FIXTURE,sportId:11,tournamentId:132,
    participant1Id:"5001",participant2Id:"5002",statusId:0,hasOdds:true,
    startTime:iso(240),bookmakerOdds:{"betano.pt":{
      bookmakerIsActive:true,suspended:false,markets:{"91001":{
        marketActive:true,outcomes:{
          "92001":{players:{[P]:player(1.88)}},
          "92002":{players:{[P]:player(1.92)}}
        }
      }}
    }}
  };
}
function quote(){
  const result=freezeUnreviewedProviderPlayerPair({
    now:NOW,capturedAt:iso(-2),snapshotReference:REF,
    fixtureId:FIXTURE,marketId:"91001",providerPlayerId:P,
    catalogue:[OFFICIAL_MARKET],leagueOdds:[fixture()]
  });
  assert.ok(result,"Existing D15.27 quote helper must yield a synthetic quote");
  return result;
}
function teamReview(){
  const resolver=makeReviewedTeamBridgeResolver([{
    schemaVersion:1,providerFixtureId:FIXTURE,
    providerStartTime:iso(240),espnEventId:"40101010",
    reviewMethod:"MANUAL_TWO_SOURCE_ID_REVIEW",reviewStatus:"APPROVED",
    reviewedAt:iso(-30),validUntil:iso(120),
    evidence:{
      providerReference:"ODDSPAPI_FIXTURE_REVIEW_SYNTHETIC",
      espnReference:"ESPN_SCOREBOARD_REVIEW_SYNTHETIC"
    },
    teams:[
      {providerParticipantId:"5001",espnTeamId:TEAM},
      {providerParticipantId:"5002",espnTeamId:OTHER_TEAM}
    ]
  }],()=>NOW);
  return resolver({
    fixtureId:FIXTURE,participant1Id:"5001",participant2Id:"5002",
    startTime:iso(240)
  });
}
function reviewedRow(overrides={}){
  return {
    schemaVersion:1,reviewMethod:"MANUAL_TWO_SOURCE_PLAYER_ID_REVIEW",
    reviewStatus:"APPROVED",reviewedAt:iso(-1),validUntil:iso(120),
    provider:{
      fixtureId:FIXTURE,participantId:"5001",playerId:P,
      playerName:PROVIDER_NAME,quoteDigest:quote().digest,
      sourceReference:REF,startTime:iso(240)
    },
    espn:{
      eventId:"40101010",teamId:TEAM,athleteId:A,
      displayName:ESPN_NAME,reference:"ESPN_ROSTER_MANUAL_SYNTHETIC"
    },
    ...overrides
  };
}
function roster(){
  return {teamId:TEAM,athletes:[
    {id:A,displayName:ESPN_NAME},
    {id:"7002",displayName:"Different Synthetic Athlete"}
  ]};
}
function query(changes={}){
  return {quote:quote(),reviewedTeamBridge:teamReview(),espnRoster:roster(),...changes};
}
function resolve(rows=[reviewedRow()],q=query(),now=NOW){
  return makeReviewedPlayerBridgeResolver(rows,()=>now)(q);
}
const checkUnsafeFalse=r=>{
  assert.ok(r);
  assert.deepEqual([
    r.bookmakerVerified,r.autoLineSelected,r.captureAllowed
  ],[false,false,false]);
  assert.equal(r.athleteMatch,"REVIEW_ASSERTION_ONLY");
};

test("D15.36 real manifest is empty: app-reported Dyson roster match is NOT an ID approval",()=>{
  assert.equal(getReviewedPlayerBridge(query()),null);
  assert.equal(makeReviewedPlayerBridgeResolver([],()=>NOW)(query()),null);
});

test("D15.36 two-source manual row joins exact original provider ID and trusted ESPN team roster",()=>{
  const result=resolve();
  checkUnsafeFalse(result);
  assert.equal(result.providerPlayerId,P);
  assert.equal(result.espnAthleteId,A);
  assert.equal(result.espnTeamId,TEAM);
  assert.equal(Object.isFrozen(result),true);
  for(const sensitive of [
    REF,quote().digest,PROVIDER_NAME,ESPN_NAME,"1.88","10.5"
  ]) assert.equal(JSON.stringify(result).includes(sensitive),false);
});

test("D15.36 reviewed IDs remain only candidates in existing offer-matching logic",()=>{
  const bridge=resolve();
  const offer=inspectOfflineNbaOffers({
    catalogue:[OFFICIAL_MARKET],fixture:fixture(),
    espnEvent:{
      eventId:"40101010",startTime:iso(240),
      status:"STATUS_SCHEDULED",homeTeamId:TEAM,awayTeamId:OTHER_TEAM
    },
    teamBridge:teamReview().teamBridge,
    rosters:[
      {teamId:TEAM,athletes:[{id:A,displayName:PROVIDER_NAME}]},
      {teamId:OTHER_TEAM,athletes:[
        {id:"7003",displayName:"Another Synthetic Athlete"}
      ]}
    ],
    providerPlayerId:P,reviewedAthleteBridge:bridge,now:NOW
  });
  assert.equal(offer.status,"REVIEW_CANDIDATES_ONLY");
  assert.equal(offer.athleteMatch,"REVIEW_ASSERTION_ONLY");
  checkUnsafeFalse(offer);
  assert.equal(offer.families.find(x=>x.market==="PTS").decision,
    "NO_EXPLICIT_MAIN_LINE");
});

test("D15.36 wrong ESPN event, team or participant bridge cannot match",()=>{
  for(const change of [
    {espnEventId:"40101011"},
    {teamBridge:[
      {providerParticipantId:"5001",espnTeamId:OTHER_TEAM},
      {providerParticipantId:"5002",espnTeamId:TEAM}
    ]},
    {teamBridge:[{providerParticipantId:"5001",espnTeamId:TEAM}]},
    {teamBridge:[
      {providerParticipantId:"5001",espnTeamId:TEAM},
      {providerParticipantId:"5001",espnTeamId:OTHER_TEAM}
    ]}
  ])assert.equal(resolve([reviewedRow()],query({
    reviewedTeamBridge:{...teamReview(),...change}
  })),null);
});

test("D15.36 wrong provider IDs, source receipt, digest or kickoff cannot match",()=>{
  const good=quote();
  for(const change of [
    {providerPlayerId:"93002"},
    {sourceReference:"ODDSPAPI_MANUAL_"+"B".repeat(32)},
    {digest:"a".repeat(64)},
    {fixtureId:"different-fixture"},
    {startTime:iso(241)},
    {providerPlayerName:"Other Provider Name"}
  ]) assert.equal(resolve([reviewedRow()],query({
    quote:{...good,...change}
  })),null);
});

test("D15.36 provider participant must agree with existing reviewed fixture/team map",()=>{
  assert.equal(resolve([reviewedRow({
    provider:{...reviewedRow().provider,participantId:"5002"}
  })]),null);
  assert.equal(resolve([reviewedRow({
    provider:{...reviewedRow().provider,participantId:"9999"}
  })]),null);
});

test("D15.36 ESPN athlete ID and name must match exact team roster",()=>{
  for(const changes of [
    {teamId:OTHER_TEAM},
    {athletes:[{id:"7003",displayName:ESPN_NAME}]},
    {athletes:[{id:A,displayName:"Different Athlete"}]},
    {athletes:[{id:A,displayName:ESPN_NAME},
      {id:"7002",displayName:ESPN_NAME}]},
    {athletes:[{id:A,displayName:ESPN_NAME},
      {id:A,displayName:"Other Name"}]},
    {athletes:[]},
    {athletes:Array(31).fill({id:A,displayName:ESPN_NAME})}
  ]) assert.equal(resolve([reviewedRow()],query({
    espnRoster:{...roster(),...changes}
  })),null);
});

test("D15.36 strict roster, team and query schemas reject browser-supplied proofs",()=>{
  for(const changes of [
    {ownerUid:"spoofed"},{approved:true},{odds:1.88},{playerName:ESPN_NAME}
  ]) assert.equal(resolve([reviewedRow()],query(changes)),null);
  assert.equal(resolve([reviewedRow()],query({
    espnRoster:{...roster(),browserVerified:true}
  })),null);
  assert.equal(resolve([reviewedRow()],query({
    reviewedTeamBridge:{...teamReview(), browserApproved:true}
  })),null);
});

test("D15.36 quote must remain unreviewed and quote schema source-bound",()=>{
  for(const change of [
    {bookmakerVerified:true},{captureAllowed:true},{autoLineSelected:true},
    {espnPlayerVerified:true},{status:"VERIFIED_BETANO_OFFER"},
    {source:"UNTRUSTED"},{attributedBookmaker:"other-book"},
    {sourceReference:"untrusted"}, {digest:"invalid"}
  ]) assert.equal(resolve([reviewedRow()],query({
    quote:{...quote(),...change}
  })),null);
});

test("D15.36 reviewed record status REVOKED never resolves",()=>{
  assert.equal(resolve([reviewedRow({reviewStatus:"REVOKED"})]),null);
});

test("D15.36 expired, premature, near-tipoff and stale reviewed rows fail",()=>{
  assert.equal(resolve([reviewedRow()],query(),NOW+121*60000),null);
  assert.equal(resolve([reviewedRow()],query(),NOW-3*60000),null);
  assert.equal(resolve([reviewedRow()],query(),NOW+236*60000),null);
  assert.equal(resolve([reviewedRow({
    reviewedAt:iso(-49*60),validUntil:iso(120)
  })]),null);
  assert.equal(resolve([reviewedRow({
    reviewedAt:iso(15),validUntil:iso(90)
  })]),null);
});

test("D15.36 duplicate same player/fixture/source rows invalidate whole manifest",()=>{
  assert.equal(resolve([reviewedRow(),reviewedRow()]),null);
  assert.equal(resolve([reviewedRow(),reviewedRow({reviewStatus:"REVOKED"})]),null);
});

test("D15.36 separate source cannot silently reapprove a revoked provider identity",()=>{
  const row=reviewedRow(),revoked=reviewedRow({
    reviewStatus:"REVOKED",
    provider:{...row.provider,sourceReference:"ODDSPAPI_MANUAL_"+"F".repeat(32)}
  });
  assert.equal(resolve([row,revoked]),null);
  assert.equal(resolve([revoked,row]),null);
});

test("D15.36 reused provider ID to a different ESPN athlete is rejected",()=>{
  const conflicting=reviewedRow({
    provider:{...reviewedRow().provider,sourceReference:"ODDSPAPI_MANUAL_"+"B".repeat(32)},
    espn:{...reviewedRow().espn,athleteId:"7009"}
  });
  assert.equal(resolve([reviewedRow(),conflicting]),null);
});

test("D15.36 reused ESPN athlete ID by different provider player ID is rejected",()=>{
  const conflict=reviewedRow({
    provider:{...reviewedRow().provider,playerId:"93002",
      sourceReference:"ODDSPAPI_MANUAL_"+"C".repeat(32)}
  });
  assert.equal(resolve([reviewedRow(),conflict]),null);
});

test("D15.36 manifest rejects extra schema fields and fake approvals",()=>{
  const good=reviewedRow();
  for(const bad of [
    {...good,captureAllowed:true},{...good,reviewMethod:"NAME_ONLY"},
    {...good,reviewStatus:"AUTO_APPROVED"},
    {...good,provider:{...good.provider,odds:1.88}},
    {...good,espn:{...good.espn,verificationByBrowser:true}},
    {...good,provider:{...good.provider,quoteDigest:"a"}},
    {...good,espn:{...good.espn,reference:"FAKE"}},
    {...good,validUntil:iso(240)}
  ]) assert.equal(resolve([bad]),null);
});

test("D15.36 malformed, oversized and throwing manifests fail closed",()=>{
  for(const rows of [null,{},Array(129).fill(reviewedRow()),[null],[{}]]){
    assert.equal(makeReviewedPlayerBridgeResolver(rows,()=>NOW)(query()),null);
  }
  assert.equal(makeReviewedPlayerBridgeResolver([reviewedRow()],()=> {
    throw Error("PRIVATE ESPN TOKEN");
  })(query()),null);
  const malicious=Object.defineProperty({},"schemaVersion",{get(){
    throw Error("PRIVATE PROVIDER SOURCE");
  }});
  assert.equal(makeReviewedPlayerBridgeResolver([malicious],()=>NOW)(query()),null);
});

test("D15.36 source data mutation cannot alter frozen review assertion",()=>{
  const raw=reviewedRow(),resolver=makeReviewedPlayerBridgeResolver([raw],()=>NOW);
  const result=resolver(query());
  checkUnsafeFalse(result);
  raw.provider.playerId="9999";
  raw.espn.athleteId="9999";
  assert.deepEqual(resolver(query()),result);
});

test("D15.36 distinct reviewed players cannot infer identity from shared name",()=>{
  const original=reviewedRow();
  const other=reviewedRow({
    provider:{...original.provider,playerId:"93003",
      sourceReference:"ODDSPAPI_MANUAL_"+"D".repeat(32)},
    espn:{...original.espn,athleteId:"7004"}
  });
  const get=makeReviewedPlayerBridgeResolver([original,other],()=>NOW);
  assert.equal(get(query()).espnAthleteId,A);
  assert.equal(get(query({quote:{...quote(),providerPlayerId:"93003"}})),null);
});

test("D15.36 no production wiring, Firebase SDK, ESPN fetch or paid provider request",()=>{
  const code=fs.readFileSync(path.join(__dirname,"offer-player-crosswalk.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const integration=fs.readFileSync(
    path.join(__dirname,"manual-evidence-integration.js"),"utf8");
  assert.doesNotMatch(index,/offer-player-crosswalk|makeReviewedPlayerBridgeResolver/);
  assert.doesNotMatch(integration,/offer-player-crosswalk|makeReviewedPlayerBridgeResolver/);
  assert.doesNotMatch(code,/require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(code,/\b(?:fetch|onCall|onSchedule|setInterval|setTimeout)\s*\(/);
  assert.doesNotMatch(code,/propResearchLedger/);
  assert.match(code,/SERVER_REVIEWED_PLAYER_MANIFEST=Object\.freeze\(\[\]\)/);
});
