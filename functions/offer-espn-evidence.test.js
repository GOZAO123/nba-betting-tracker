"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectWithServerEspnEvidence } = require("./offer-espn-evidence");

const NOW = Date.parse("2026-11-16T22:30:00.000Z");
const iso = n => new Date(NOW + n * 60000).toISOString();
const PLAYER = "20001", ATHLETE = "Synthetic Athlete";
function def(marketId=90001,line=20.5) {
 return {marketId,sportId:11,playerProp:true,period:"result",
  marketName:"Over Under Player Points (incl. overtime)",handicap:line,
  outcomes:[{outcomeId:marketId+10000,outcomeName:"Over"},
   {outcomeId:marketId+10001,outcomeName:"Under"}]};
}
function quote(overrides={}) {
 return {active:true,price:1.88,playerName:ATHLETE,mainLine:false,
  changedAt:iso(-2),...overrides};
}
function market(d) {
 return {marketActive:true,outcomes:{
  [d.outcomes[0].outcomeId]:{players:{[PLAYER]:quote()}},
  [d.outcomes[1].outcomeId]:{players:{[PLAYER]:quote({price:1.91})}}
 }};
}
function fixture(defs=[def()]) {
 return {fixtureId:"synthetic-provider-event",sportId:11,tournamentId:132,
  participant1Id:5001,participant2Id:5002,statusId:0,hasOdds:true,
  startTime:iso(240),bookmakerOdds:{"betano.pt":{
   bookmakerIsActive:true,suspended:false,
   markets:Object.fromEntries(defs.map(d=>[String(d.marketId),market(d)]))
  }}};
}
function game(overrides={}) {
 return {id:"40101010",date:iso(240),season:{type:2},
  status:{type:{state:"pre",name:"STATUS_SCHEDULED"}},
  competitions:[{date:iso(240),competitors:[
   {homeAway:"home",team:{id:"1001",displayName:"Home Synthetic Team"}},
   {homeAway:"away",team:{id:"1002",displayName:"Away Synthetic Team"}}
  ]}],...overrides};
}
function roster(teamId) {
 return {team:{id:teamId,displayName:teamId==="1001"?"Home Synthetic Team":"Away Synthetic Team"},
  athletes:teamId==="1001"?
   [{id:"7001",displayName:ATHLETE}]:
   [{id:"7002",displayName:"Other Synthetic Athlete"}]};
}
function harness(overrides={}) {
 const reads=[];
 const d=def(),input={catalogue:[d],fixture:fixture([d]),providerPlayerId:PLAYER};
 const dependencies={
  now:NOW, getReviewedTeamBridge:async()=>[
   {providerParticipantId:"5001",espnTeamId:"1001"},
   {providerParticipantId:"5002",espnTeamId:"1002"}],
  fetchEspn:async path=>{
   reads.push(path);
   if(path.startsWith("scoreboard?"))return {events:[game()]};
   if(path==="teams/1001/roster")return roster("1001");
   if(path==="teams/1002/roster")return roster("1002");
   throw Error("Unexpected ESPN path");
  }
 };
 Object.assign(input,overrides.input||{});
 Object.assign(dependencies,overrides.dependencies||{});
 return {input,dependencies,reads,run:()=>inspectWithServerEspnEvidence(input,dependencies)};
}
const pts = out => out.families.find(x=>x.market==="PTS");

test("35.1D2 trusted adapter derives ESPN fixture and rosters; cannot capture or select",async()=>{
 const h=harness(),out=await h.run();
 assert.equal(out.status,"REVIEW_CANDIDATES_ONLY");
 assert.equal(out.eventMatched,true);
 assert.equal(out.athleteMatch,"EXACT_NAME_ONLY_NOT_VERIFIED");
 assert.deepEqual([out.autoLineSelected,out.captureAllowed,out.bookmakerVerified],[false,false,false]);
 assert.deepEqual(h.reads,["scoreboard?dates=20261116","teams/1001/roster","teams/1002/roster"]);
 assert.equal(pts(out).decision,"NO_EXPLICIT_MAIN_LINE");
 assert.doesNotMatch(JSON.stringify(out),/Synthetic Athlete|20001|7001|1\.88|90001/);
});
test("35.1D2 request rejects browser-supplied event, roster or reviewed bridge proofs without reads",async()=>{
 for(const field of ["espnEvent","teamBridge","rosters","eventId","reviewedAthleteBridge"]){
  const h=harness({input:{[field]:{spoofed:true}}}),out=await h.run();
  assert.equal(out.status,"INVALID_INPUT");
  assert.equal(h.reads.length,0);
 }
});
test("35.1D2 malformed input and absent server dependencies reject without reads",async()=>{
 const h=harness();
 assert.equal((await inspectWithServerEspnEvidence(null,h.dependencies)).status,"INVALID_INPUT");
 assert.equal((await inspectWithServerEspnEvidence(h.input,{})).status,"INVALID_INPUT");
 assert.equal(h.reads.length,0);
});
test("35.1D2 invalid provider fixture and inactive bookmaker cause zero ESPN requests",async()=>{
 for(const change of [{sportId:10},{tournamentId:133},{statusId:1},{hasOdds:false},
  {startTime:iso(4)},{startTime:iso(73*60)},{participant1Id:5002},
  {bookmakerOdds:{"betano.pt":{bookmakerIsActive:false,markets:{}}}}]){
  const h=harness();Object.assign(h.input.fixture,change);
  const out=await h.run();
  assert.equal(out.status,"INVALID_PROVIDER_FIXTURE");assert.equal(h.reads.length,0);
 }
});
test("35.1D2 oversized markets and malformed catalogue are rejected before ESPN reads",async()=>{
 const badCatalogue=harness({input:{catalogue:{bad:"private"}}});
 assert.equal((await badCatalogue.run()).status,"INVALID_PROVIDER_CATALOGUE");
 assert.equal(badCatalogue.reads.length,0);
 const tooMany=harness();
 tooMany.input.fixture.bookmakerOdds["betano.pt"].markets=
  Object.fromEntries(Array.from({length:18001},(_,i)=>[String(100000+i),{}]));
 assert.equal((await tooMany.run()).status,"INVALID_PROVIDER_FIXTURE");
 assert.equal(tooMany.reads.length,0);
});
test("35.1D2 reviewed bridge must be complete, one-to-one and server-owned",async()=>{
 const wrong=[
  [{providerParticipantId:5001,espnTeamId:1001}],
  [{providerParticipantId:5001,espnTeamId:1001},{providerParticipantId:5002,espnTeamId:1001}],
  [{providerParticipantId:5001,espnTeamId:1001},{providerParticipantId:5999,espnTeamId:1002}],
  [{providerParticipantId:5001,espnTeamId:1001},{providerParticipantId:5001,espnTeamId:1002}]
 ];
 for(const bridge of wrong){
  const h=harness({dependencies:{getReviewedTeamBridge:async()=>bridge}});
  assert.equal((await h.run()).status,"REVIEWED_TEAM_BRIDGE_UNAVAILABLE");
  assert.equal(h.reads.length,0);
 }
});
test("35.1D2 reviewer failure exposes no secret and skips ESPN",async()=>{
 const h=harness({dependencies:{getReviewedTeamBridge:async()=>{throw Error("secret provider token");}}});
 const out=await h.run();
 assert.equal(out.status,"REVIEWED_TEAM_BRIDGE_UNAVAILABLE");
 assert.equal(h.reads.length,0);
 assert.doesNotMatch(JSON.stringify(out),/secret|token/);
});
test("35.1D2 malformed or empty scoreboard fails before any roster request",async()=>{
 for(const payload of [{events:null},{events:[]},{events:Array(41).fill({})}]){
  const h=harness({dependencies:{fetchEspn:async path=>{h.reads.push(path);return payload;}}});
  assert.equal((await h.run()).status,"ESPN_EVENT_NOT_UNIQUELY_VERIFIED");
  assert.equal(h.reads.length,1);
 }
});
test("35.1D2 duplicated matching ESPN events fail closed, not first-match-wins",async()=>{
 const h=harness({dependencies:{fetchEspn:async path=>{h.reads.push(path);return {events:[game(),game()]};}}});
 assert.equal((await h.run()).status,"ESPN_EVENT_NOT_UNIQUELY_VERIFIED");
 assert.deepEqual(h.reads,["scoreboard?dates=20261116"]);
});
test("35.1D2 requires ESPN pregame regular season and exact team pair",async()=>{
 const mutations=[
  {status:{type:{state:"post"}}},{season:{type:3}},
  {competitions:[{competitors:[]}]},
  {date:iso(251)},
  {competitions:[{date:iso(240),competitors:[
   {homeAway:"home",team:{id:"9999",displayName:"Other"}},
   {homeAway:"away",team:{id:"1002",displayName:"Away Synthetic Team"}}
  ]}]},
  {id:null}
 ];
 for(const change of mutations){
  const h=harness({dependencies:{fetchEspn:async path=>{h.reads.push(path);return {events:[game(change)]};}}});
  assert.equal((await h.run()).status,"ESPN_EVENT_NOT_UNIQUELY_VERIFIED");
  assert.equal(h.reads.length,1);
 }
});
test("35.1D2 ESPN outage is bounded to one read and sanitized",async()=>{
 const h=harness({dependencies:{fetchEspn:async path=>{h.reads.push(path);throw Error("ESPN raw URL + sensitive payload");}}});
 const out=await h.run();
 assert.equal(out.status,"ESPN_SCOREBOARD_UNAVAILABLE");
 assert.equal(h.reads.length,1);assert.doesNotMatch(JSON.stringify(out),/raw URL|sensitive/);
});
test("35.1D2 first ESPN roster outage skips second roster",async()=>{
 const h=harness({dependencies:{fetchEspn:async path=>{
  h.reads.push(path);if(path.startsWith("scoreboard?"))return {events:[game()]};
  throw Error("private roster error");
 }}});
 const out=await h.run();
 assert.equal(out.status,"ESPN_ROSTER_UNAVAILABLE");
 assert.deepEqual(h.reads,["scoreboard?dates=20261116","teams/1001/roster"]);
 assert.doesNotMatch(JSON.stringify(out),/private roster/);
});
test("35.1D2 roster team ID and displayed name must match scoreboard",async()=>{
 for(const change of [{team:{id:"1005",displayName:"Home Synthetic Team"}},
  {team:{id:"1001",displayName:"Impostor Team"}}]){
  const h=harness({dependencies:{fetchEspn:async path=>{
   h.reads.push(path);
   if(path.startsWith("scoreboard?"))return {events:[game()]};
   if(path==="teams/1001/roster")return {...roster("1001"),...change};
   return roster("1002");
  }}});
  assert.equal((await h.run()).status,"ESPN_ROSTER_UNVERIFIED");
  assert.equal(h.reads.length,2);
 }
});
test("35.1D2 grouped ESPN roster items accepted while duplicate athlete IDs are blocked",async()=>{
 const a=harness({dependencies:{fetchEspn:async path=>{
  a.reads.push(path);if(path.startsWith("scoreboard?"))return {events:[game()]};
  const raw=roster(path.includes("1001")?"1001":"1002");
  return {...raw,athletes:[{items:raw.athletes}]};
 }}});
 assert.equal((await a.run()).status,"REVIEW_CANDIDATES_ONLY");
 const b=harness({dependencies:{fetchEspn:async path=>{
  b.reads.push(path);if(path.startsWith("scoreboard?"))return {events:[game()]};
  const raw=roster(path.includes("1001")?"1001":"1002");
  if(path==="teams/1001/roster")raw.athletes.push({...raw.athletes[0]});
  return raw;
 }}});
 assert.equal((await b.run()).status,"ESPN_ROSTER_UNVERIFIED");
 assert.equal(b.reads.length,2);
});
test("35.1D2 cross-team duplicate ESPN athlete IDs are rejected",async()=>{
 const h=harness({dependencies:{fetchEspn:async path=>{
  h.reads.push(path);if(path.startsWith("scoreboard?"))return {events:[game()]};
  const raw=roster(path.includes("1001")?"1001":"1002");
  if(path==="teams/1002/roster")raw.athletes[0].id="7001";
  return raw;
 }}});
 assert.equal((await h.run()).status,"ESPN_ROSTER_UNVERIFIED");assert.equal(h.reads.length,3);
});
test("35.1D2 exact duplicate ESPN names are not proof of a unique provider player",async()=>{
 const h=harness({dependencies:{fetchEspn:async path=>{
  h.reads.push(path);if(path.startsWith("scoreboard?"))return {events:[game()]};
  const raw=roster(path.includes("1001")?"1001":"1002");
  if(path==="teams/1002/roster")raw.athletes[0].displayName=ATHLETE;
  return raw;
 }}});
 const out=await h.run();
 assert.equal(out.status,"AMBIGUOUS_ESPN_NAME");
 assert.equal(out.captureAllowed,false);
});
test("35.1D2 validated ESPN evidence still never guesses an unflagged main line",async()=>{
 const h=harness(),d=def(90003,21.5);
 h.input.catalogue.push(d);
 h.input.fixture.bookmakerOdds["betano.pt"].markets[d.marketId]=market(d);
 const out=await h.run();
 assert.equal(out.status,"REVIEW_CANDIDATES_ONLY");
 assert.equal(pts(out).pairedLines,2);
 assert.equal(pts(out).decision,"NO_EXPLICIT_MAIN_LINE");
 assert.equal(out.autoLineSelected,false);
});
test("35.1D2 Lisbon midnight maps to prior New York NBA calendar day",async()=>{
 const h=harness(),start=Date.parse("2026-11-17T00:30:00.000Z");
 h.input.fixture.startTime=new Date(start).toISOString();
 const event=game({date:new Date(start).toISOString(),
  competitions:[{date:new Date(start).toISOString(),competitors:game().competitions[0].competitors}]});
 h.dependencies.fetchEspn=async path=>{
  h.reads.push(path);
  if(path.startsWith("scoreboard?"))return {events:[event]};
  return roster(path.includes("1001")?"1001":"1002");
 };
 // Must be >5 minutes pregame to meet ledger's near-tipoff threshold.
 h.dependencies.now=start-30*60000;
 const out=await h.run();
 assert.equal(out.status,"REVIEW_CANDIDATES_ONLY");
 assert.equal(h.reads[0],"scoreboard?dates=20261116");
});
test("35.1D2 module stays offline and is never wired as a public production callable",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const source=fs.readFileSync(require.resolve("./offer-espn-evidence"),"utf8");
 const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 assert.doesNotMatch(source,/\bfetch\s*\(|httpsCallable|onCall\s*\(|getFirestore|runTransaction|setInterval|apiKey|ODDSPAPI/);
 assert.doesNotMatch(index,/require\(["']\.\/offer-espn-evidence["']\)/);
 assert.match(source,/captureAllowed|inspectOfflineNbaOffers/);
});
