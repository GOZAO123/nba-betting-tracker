"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectOfflineNbaOffers } = require("./offer-matching");

const NOW = Date.parse("2026-11-16T22:30:00.000Z");
const iso = minutes => new Date(NOW + 60000 * minutes).toISOString();
const playerId = "20001";
const athleteName = "Synthetic Athlete";
function def(marketId = 90001, handicap = 20.5, overrides = {}) {
 return {marketId, sportId:11, playerProp:true, period:"result",
  marketName:"Over Under Player Points (incl. overtime)", handicap,
  outcomes:[{outcomeId:marketId+10000,outcomeName:"Over"},
   {outcomeId:marketId+10001,outcomeName:"Under"}], ...overrides};
}
function quote(changes = {}) {
 return {active:true,price:1.88,playerName:athleteName,mainLine:false,
  changedAt:iso(-2),...changes};
}
function market(d, changes = {}) {
 return {marketActive:true,outcomes:{
  [d.outcomes[0].outcomeId]:{players:{[playerId]:quote()}},
  [d.outcomes[1].outcomeId]:{players:{[playerId]:quote({price:1.90})}}
 },...changes};
}
function sample({definitions=[def()], fixtureOver={}, eventOver={},
 teamBridgeOver=null, rostersOver=null, athleteBridge=null}={}) {
 const markets=Object.fromEntries(definitions.map(d=>[d.marketId,market(d)]));
 const fixture={fixtureId:"provider-fixture-synthetic",sportId:11,tournamentId:132,
  participant1Id:5001,participant2Id:5002,statusId:0,hasOdds:true,
  startTime:iso(240),bookmakerOdds:{"betano.pt":{
   bookmakerIsActive:true,suspended:false,markets
  }},...fixtureOver};
 const event={eventId:"40101010",startTime:iso(240),
  status:"STATUS_SCHEDULED",homeTeamId:"1001",awayTeamId:"1002",...eventOver};
 const teamBridge=teamBridgeOver??[
  {providerParticipantId:5001,espnTeamId:"1001"},
  {providerParticipantId:5002,espnTeamId:"1002"}
 ];
 const rosters=rostersOver??[
  {teamId:"1001",athletes:[{id:"7001",displayName:athleteName}]},
  {teamId:"1002",athletes:[{id:"7002",displayName:"Other Synthetic Athlete"}]}
 ];
 return {catalogue:definitions,fixture,espnEvent:event,teamBridge,rosters,
  providerPlayerId:playerId,reviewedAthleteBridge:athleteBridge,now:NOW};
}
const inspect=o=>inspectOfflineNbaOffers(sample(o));
const pts=x=>x.families.find(p=>p.market==="PTS");

test("35.1D1 strict unique ESPN roster name is CANDIDATE only, not identity proof",()=>{
 const out=inspect();
 assert.equal(out.status,"REVIEW_CANDIDATES_ONLY");
 assert.equal(out.eventMatched,true);
 assert.equal(out.athleteMatch,"EXACT_NAME_ONLY_NOT_VERIFIED");
 assert.equal(out.captureAllowed,false);
 assert.equal(out.autoLineSelected,false);
 assert.equal(out.bookmakerVerified,false);
 assert.equal(pts(out).pairedLines,1);
 assert.equal(pts(out).decision,"NO_EXPLICIT_MAIN_LINE");
 assert.equal(JSON.stringify(out).includes(athleteName),false);
 assert.equal(JSON.stringify(out).includes("20001"),false);
 assert.equal(JSON.stringify(out).includes("1.88"),false);
});

test("35.1D1 requires explicit exact provider participant to ESPN team bridge",()=>{
 const wrong=[{providerParticipantId:5001,espnTeamId:"1001"},
  {providerParticipantId:5002,espnTeamId:"1003"}];
 assert.equal(inspect({teamBridgeOver:wrong}).status,"EVENT_OR_ESPN_EVIDENCE_UNVERIFIED");
 assert.equal(inspect({fixtureOver:{participant2Id:5001}}).status,"EVENT_OR_ESPN_EVIDENCE_UNVERIFIED");
 assert.equal(inspect({eventOver:{homeTeamId:"1003"}}).status,"EVENT_OR_ESPN_EVIDENCE_UNVERIFIED");
});

test("35.1D1 checks upcoming strict fixture start and ESPN status",()=>{
 for(const changes of [{statusId:1},{sportId:10},{tournamentId:133},
  {hasOdds:false},{startTime:iso(1)},{startTime:iso(73*60)},
  {startTime:"2026-11-17 04:30"}])
  assert.equal(inspect({fixtureOver:changes}).status,"EVENT_OR_ESPN_EVIDENCE_UNVERIFIED");
 assert.equal(inspect({eventOver:{status:"STATUS_IN_PROGRESS"}}).status,"EVENT_OR_ESPN_EVIDENCE_UNVERIFIED");
 assert.equal(inspect({eventOver:{startTime:iso(252)}}).status,"EVENT_OR_ESPN_EVIDENCE_UNVERIFIED");
});

test("35.1D1 rejects duplicate ESPN athlete identity and ambiguous identical roster names",()=>{
 const rosters=[
  {teamId:"1001",athletes:[{id:"7001",displayName:athleteName}]},
  {teamId:"1002",athletes:[{id:"7002",displayName:athleteName}]}
 ];
 assert.equal(inspect({rostersOver:rosters}).status,"AMBIGUOUS_ESPN_NAME");
 const duplicateIds=[...rosters];duplicateIds[1]={teamId:"1002",athletes:[{id:"7001",displayName:athleteName}]};
 assert.equal(inspect({rostersOver:duplicateIds}).status,"EVENT_OR_ESPN_EVIDENCE_UNVERIFIED");
});

test("35.1D1 normalized name mismatch fails closed; never fuzzy joins different athletes",()=>{
 const rosters=[{teamId:"1001",athletes:[{id:"7001",displayName:"Synthetic Athelete"}]},
  {teamId:"1002",athletes:[{id:"7002",displayName:"Other Synthetic Athlete"}]}];
 assert.equal(inspect({rostersOver:rosters}).status,"ESPN_NAME_NOT_CONFIRMED");
});

test("35.1D1 an asserted reviewed athlete bridge must exactly agree, never authorizes capture",()=>{
 const good={providerPlayerId:playerId,espnAthleteId:"7001",espnTeamId:"1001"};
 const a=inspect({athleteBridge:good});
 assert.equal(a.status,"REVIEW_CANDIDATES_ONLY");
 assert.equal(a.athleteMatch,"REVIEW_ASSERTION_ONLY");
 assert.equal(a.captureAllowed,false);
 assert.equal(inspect({athleteBridge:{...good,espnAthleteId:"7002"}}).status,"REVIEWED_ATHLETE_BRIDGE_CONFLICT");
 assert.equal(inspect({athleteBridge:{...good,providerPlayerId:"10002"}}).status,"REVIEWED_ATHLETE_BRIDGE_CONFLICT");
});

test("35.1D1 provider Over/Under must agree on player name and matching provider ID",()=>{
 const input=sample(),m=input.fixture.bookmakerOdds["betano.pt"].markets[90001];
 m.outcomes[100002].players[playerId].playerName="Different Athlete";
 assert.equal(inspectOfflineNbaOffers(input).status,"PROVIDER_PLAYER_NAME_CONFLICT");
 delete m.outcomes[100002].players[playerId];
 assert.equal(inspectOfflineNbaOffers(input).status,"NO_VALID_PROVIDER_PLAYER_PAIR");
});

test("35.1D1 missing mainLine flags never cause automatic selection",()=>{
 const input=sample(),m=input.fixture.bookmakerOdds["betano.pt"].markets[90001];
 m.outcomes[100001].players[playerId].mainLine=true;
 assert.equal(pts(inspectOfflineNbaOffers(input)).decision,"NO_EXPLICIT_MAIN_LINE");
 m.outcomes[100002].players[playerId].mainLine=true;
 const p=pts(inspectOfflineNbaOffers(input));
 assert.equal(p.decision,"EXPLICIT_MAIN_LINE_REVIEW_REQUIRED");
 assert.equal(p.explicitMainPairs,1);
 assert.equal(inspectOfflineNbaOffers(input).autoLineSelected,false);
});

test("35.1D1 more than one explicit main line is ambiguous, no automatic selection",()=>{
 const a=def(90001,20.5),b=def(90011,21.5),input=sample({definitions:[a,b]});
 const markets=input.fixture.bookmakerOdds["betano.pt"].markets;
 for(const m of Object.values(markets))for(const o of Object.values(m.outcomes))
  o.players[playerId].mainLine=true;
 const r=inspectOfflineNbaOffers(input);
 assert.equal(pts(r).pairedLines,2);
 assert.equal(pts(r).decision,"MULTIPLE_EXPLICIT_MAIN_LINES");
 assert.equal(r.autoLineSelected,false);
});

test("35.1D1 identical family/line across different market IDs is quarantined",()=>{
 const a=def(90001,20.5),b=def(90011,20.5);
 const r=inspect({definitions:[a,b]});
 assert.equal(pts(r).decision,"AMBIGUOUS_DUPLICATE_LINE");
 assert.equal(r.captureAllowed,false);
});

test("35.1D1 old timestamps are descriptive only; future timestamps and prices fail closed",()=>{
 const input=sample(),m=input.fixture.bookmakerOdds["betano.pt"].markets[90001];
 m.outcomes[100002].players[playerId].changedAt=iso(-30);
 assert.equal(pts(inspectOfflineNbaOffers(input)).decision,"STALE_ONLY");
 m.outcomes[100002].players[playerId].changedAt=iso(4);
 assert.equal(inspectOfflineNbaOffers(input).status,"NO_VALID_PROVIDER_PLAYER_PAIR");
 m.outcomes[100002].players[playerId].changedAt=iso(-1);
 m.outcomes[100002].players[playerId].price="1.75";
 assert.equal(inspectOfflineNbaOffers(input).status,"NO_VALID_PROVIDER_PLAYER_PAIR");
});

test("35.1D1 catalogue excludes wrong periods and globally repeated market IDs",()=>{
 assert.equal(inspect({definitions:[def(90001,20.5,{period:"fulltime"})]}).status,"NO_VALID_PROVIDER_PLAYER_PAIR");
 assert.equal(inspect({definitions:[def(),def()]}).status,"NO_VALID_PROVIDER_PLAYER_PAIR");
});

test("35.1D1 wrong bookmaker, suspension and extra outcome IDs fail closed",()=>{
 const input=sample();
 input.fixture.bookmakerOdds["betano.pt"].suspended=true;
 assert.equal(inspectOfflineNbaOffers(input).status,"BOOKMAKER_NOT_ACTIVE");
 input.fixture.bookmakerOdds["betano.pt"].suspended=false;
 input.fixture.bookmakerOdds["betano.pt"].markets[90001].outcomes[999999]={players:{[playerId]:quote()}};
 assert.equal(inspectOfflineNbaOffers(input).status,"NO_VALID_PROVIDER_PLAYER_PAIR");
});

test("35.1D1 malformed or oversized catalogue is quarantined without leaking error text",()=>{
 const r=inspectOfflineNbaOffers({...sample(),catalogue:{nonsense:"secret text"}});
 assert.equal(r.status,"CATALOGUE_UNVERIFIED");
 assert.equal(JSON.stringify(r).includes("secret"),false);
 assert.equal(r.captureAllowed,false);
});

test("35.1D1 offline helper has no HTTP, Firebase SDK, metered quota, or production export",()=>{
 const fs=require("node:fs");
 const source=fs.readFileSync(require.resolve("./offer-matching"),"utf8");
 assert.doesNotMatch(source,/\bfetch\s*\(|httpsCallable|onCall\s*\(|getFirestore|runTransaction|setInterval|apiKey|secretmanager|ledgerCaptureProspective/);
 assert.match(source,/captureAllowed:\s*false/);
 const path=require("node:path");
 const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 assert.doesNotMatch(index,/require\(["']\.\/offer-matching["']\)/);
});