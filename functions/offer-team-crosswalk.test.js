"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {makeReviewedTeamBridgeResolver,getReviewedTeamBridge}=require("./offer-team-crosswalk");
const {inspectWithServerEspnEvidence}=require("./offer-espn-evidence");

const NOW=Date.parse("2026-11-17T10:00:00.000Z");
const iso=m=>new Date(NOW+m*60000).toISOString();
function record(changes={}) {
 return {schemaVersion:1,providerFixtureId:"fixture-demo-001",
  providerStartTime:iso(180),espnEventId:"40101010",
  reviewMethod:"MANUAL_TWO_SOURCE_ID_REVIEW",reviewStatus:"APPROVED",
  reviewedAt:iso(-25),validUntil:iso(90),
  evidence:{providerReference:"ODDSPAPI_FIXTURE_REVIEW_001",
   espnReference:"ESPN_SCOREBOARD_REVIEW_001"},
  teams:[{providerParticipantId:"5001",espnTeamId:"1001"},
   {providerParticipantId:"5002",espnTeamId:"1002"}],...changes};
}
function query(changes={}) {
 return {fixtureId:"fixture-demo-001",participant1Id:"5001",
  participant2Id:"5002",startTime:iso(180),...changes};
}
const make=(rows=[record()],now=NOW)=>makeReviewedTeamBridgeResolver(rows,()=>now);

test("35.1D3 default shipped server manifest is empty, never fabricated",()=>{
 assert.equal(getReviewedTeamBridge(query()),null);
});
test("35.1D3 exact reviewed fixture, participants, kickoff return only ID pairs",()=>{
 const pairs=make()(query());
 assert.deepEqual(pairs.teamBridge,[{providerParticipantId:"5001",espnTeamId:"1001"},
  {providerParticipantId:"5002",espnTeamId:"1002"}]);
 assert.equal(pairs.espnEventId,"40101010");
 assert.doesNotMatch(JSON.stringify(pairs),/REVIEW_001|40101010|price|bookmaker/);
});
test("35.1D3 reverse participant order still requires the exact two IDs",()=>{
 const pairs=make()(query({participant1Id:"5002",participant2Id:"5001"}));
 assert.equal(pairs.teamBridge.length,2);
 assert.equal(pairs.teamBridge[0].espnTeamId,"1001");
});
test("35.1D3 unknown fixture, wrong team and kickoff change cannot reuse a bridge",()=>{
 const get=make();
 for (const change of [{fixtureId:"unknown"},{participant1Id:"9999"},
   {participant2Id:"5001"},{startTime:iso(181)},
   {startTime:"2026-11-17 13:00"}]) assert.equal(get(query(change)),null);
});
test("35.1D3 browser-like extra fields cannot supply identity evidence",()=>{
 const get=make();
 for(const field of ["espnEventId","rosters","teamBridge","athleteId",
  "reviewedAt","price","secret"])
  assert.equal(get({...query(),[field]:"spoofed"}),null);
});
test("35.1D3 revoked, expired, future and stale reviews fail closed",()=>{
 assert.equal(make([record({reviewStatus:"REVOKED"})])(query()),null);
 assert.equal(make([record({validUntil:iso(-1)})])(query()),null);
 assert.equal(make([record({reviewedAt:iso(10),validUntil:iso(20)})])(query()),null);
 assert.equal(make([record({reviewedAt:iso(-49*60),validUntil:iso(90)})])(query()),null);
 assert.equal(make([record()],NOW+91*60000)(query()),null);
 assert.equal(make([record()],NOW+177*60000)(query()),null);
});
test("35.1D3 malformed provenance, review method and event ID reject entire manifest",()=>{
 for(const row of [
  record({reviewMethod:"NAME_MATCH"}),
  record({schemaVersion:2}),record({espnEventId:"unknown"}),
  record({evidence:{providerReference:"ok",espnReference:"ESPN_REVIEW_001"}}),
  record({evidence:{providerReference:"REF_PROVIDER",espnReference:"REF_ESPN",secret:"secret"}}),
  record({reviewedAt:"2026-11-17"}),record({reviewedAt:iso(190)}),
  record({validUntil:iso(200)}),
  {...record(),token:"spoofed"}
 ])assert.equal(make([row])(query()),null);
});
test("35.1D3 duplicate fixture records fail, including revoked and approved",()=>{
 assert.equal(make([record(),record({reviewStatus:"REVOKED"})])(query()),null);
});
test("35.1D3 incompatible provider-to-ESPN or reverse team IDs quarantine all",()=>{
 const a=record();
 const b=record({providerFixtureId:"fixture-demo-002",
  teams:[{providerParticipantId:"5001",espnTeamId:"1999"},
   {providerParticipantId:"6002",espnTeamId:"2002"}]});
 const c=record({providerFixtureId:"fixture-demo-003",
  teams:[{providerParticipantId:"6001",espnTeamId:"1001"},
   {providerParticipantId:"6002",espnTeamId:"2002"}]});
 assert.equal(make([a,b])(query()),null);
 assert.equal(make([a,c])(query()),null);
});
test("35.1D3 duplicate, missing or extra team data never pass",()=>{
 for(const teams of [
  [{providerParticipantId:"5001",espnTeamId:"1001"}],
  [{providerParticipantId:"5001",espnTeamId:"1001"},
   {providerParticipantId:"5001",espnTeamId:"1002"}],
  [{providerParticipantId:"5001",espnTeamId:"1001"},
   {providerParticipantId:"5002",espnTeamId:"1001"}],
  [{providerParticipantId:"5001",espnTeamId:"1001"},
   {providerParticipantId:"5002",espnTeamId:"1002",name:"injected"}]
 ])assert.equal(make([record({teams})])(query()),null);
});
test("35.1D3 oversized and malformed manifest fails closed",()=>{
 for(const x of [null,{},Array(129).fill(record()),[null],
   [record({providerFixtureId:"bad fixture !"})]])
  assert.equal(makeReviewedTeamBridgeResolver(x,()=>NOW)(query()),null);
});
test("35.1D3 clock exceptions and invalid time stop matching",()=>{
 assert.equal(makeReviewedTeamBridgeResolver([record()],()=>{throw Error("sensitive")})(query()),null);
 assert.equal(makeReviewedTeamBridgeResolver([record()],()=>NaN)(query()),null);
 assert.equal(makeReviewedTeamBridgeResolver([record()],()=>NOW-3600000)(query()),null);
});
test("35.1D3 return values cannot mutate the source mapping",()=>{
 const get=make(),pairs=get(query());
 assert.throws(()=>{pairs.teamBridge[0].espnTeamId="9999"},TypeError);
 assert.equal(get(query()).teamBridge[0].providerParticipantId,"5001");
 assert.equal(get(query({participant1Id:"9999"})),null);
});
test("35.1D3 distinct fixtures may reuse consistent team mappings",()=>{
 const second=record({providerFixtureId:"fixture-demo-002",
  providerStartTime:iso(210),validUntil:iso(120),
  teams:[{providerParticipantId:"5001",espnTeamId:"1001"},
   {providerParticipantId:"6002",espnTeamId:"2002"}]});
 const get=make([record(),second]);
 assert.equal(get(query()).teamBridge.length,2);
 assert.equal(get(query({fixtureId:"fixture-demo-002",
  participant2Id:"6002",startTime:iso(210)})).teamBridge.length,2);
});
test("35.1D3 D2 adapter passes exact kickoff to server-owned resolver before ESPN",async()=>{
 const d={marketId:90001,sportId:11,playerProp:true,period:"result",
  marketName:"Over Under Player Points (incl. overtime)",handicap:20.5,
  outcomes:[{outcomeId:100001,outcomeName:"Over"},
   {outcomeId:100002,outcomeName:"Under"}]};
 const quote={active:true,price:1.8,playerName:"Synthetic Athlete",
  changedAt:iso(-2),mainLine:false};
 const fixture={fixtureId:"fixture-demo-001",sportId:11,tournamentId:132,statusId:0,
  hasOdds:true,participant1Id:"5001",participant2Id:"5002",startTime:iso(180),
  bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,
   markets:{"90001":{marketActive:true,outcomes:{
    "100001":{players:{"20001":quote}},
    "100002":{players:{"20001":quote}}
   }}}}}};
 const scoreboard={events:[{id:"40101010",date:iso(180),season:{type:2},
  status:{type:{state:"pre"}},competitions:[{date:iso(180),competitors:[
   {homeAway:"home",team:{id:"1001",displayName:"Demo Home"}},
   {homeAway:"away",team:{id:"1002",displayName:"Demo Away"}}]}]}]};
 const roster=x=>({team:{id:x,displayName:x==="1001"?"Demo Home":"Demo Away"},
  athletes:[{id:x==="1001"?"7001":"7002",
   displayName:x==="1001"?"Synthetic Athlete":"Other Athlete"}]});
 const calls=[],input={catalogue:[d],fixture,providerPlayerId:"20001"};
 const dependencies={now:NOW,getReviewedTeamBridge:c=>{calls.push("bridge");return make()(c)},
  fetchEspn:async path=>{calls.push(path);
   if(path.startsWith("scoreboard?"))return scoreboard;
   return roster(path.includes("1001")?"1001":"1002")}
 };
 const output=await inspectWithServerEspnEvidence(input,dependencies);
 assert.equal(output.status,"REVIEW_CANDIDATES_ONLY");
 assert.deepEqual([output.captureAllowed,output.autoLineSelected,output.bookmakerVerified],
  [false,false,false]);
 assert.equal(calls.length,4);
 const blocked=await inspectWithServerEspnEvidence(
  {...input,fixture:{...fixture,startTime:iso(181)}},dependencies);
 assert.equal(blocked.status,"REVIEWED_TEAM_BRIDGE_UNAVAILABLE");
 assert.equal(calls.length,5,"Kickoff mismatch must exit before ESPN reads");
});
test("35.1D3 pinned ESPN event ID mismatch stops before any roster reads",async()=>{
 const d={marketId:90001,sportId:11,playerProp:true,period:"result",
  marketName:"Over Under Player Points (incl. overtime)",handicap:20.5,
  outcomes:[{outcomeId:100001,outcomeName:"Over"},
   {outcomeId:100002,outcomeName:"Under"}]};
 const quote={active:true,price:1.85,playerName:"Synthetic Athlete",
  changedAt:iso(-2),mainLine:false};
 const fixture={fixtureId:"fixture-demo-001",sportId:11,tournamentId:132,
  statusId:0,hasOdds:true,participant1Id:"5001",participant2Id:"5002",
  startTime:iso(180),bookmakerOdds:{"betano.pt":{
   bookmakerIsActive:true,suspended:false,markets:{"90001":{
    marketActive:true,outcomes:{"100001":{players:{"20001":quote}},
     "100002":{players:{"20001":quote}}}
   }}
  }}};
 const scoreboard={events:[{id:"40101010",date:iso(180),season:{type:2},
  status:{type:{state:"pre"}},competitions:[{date:iso(180),competitors:[
   {homeAway:"home",team:{id:"1001",displayName:"Demo Home"}},
   {homeAway:"away",team:{id:"1002",displayName:"Demo Away"}}
  ]}]}]};
 const reads=[];
 const out=await inspectWithServerEspnEvidence(
  {catalogue:[d],fixture,providerPlayerId:"20001"},{
   now:NOW,getReviewedTeamBridge:make([record({espnEventId:"40101011"})]),
   fetchEspn:async path=>{reads.push(path);return scoreboard}
  });
 assert.equal(out.status,"ESPN_EVENT_NOT_UNIQUELY_VERIFIED");
 assert.equal(out.captureAllowed,false);
 assert.deepEqual(reads,["scoreboard?dates=20261117"]);
});
test("35.1D3 D2 refuses bare unpinned team arrays without any ESPN reads",async()=>{
 const fixture={fixtureId:"fixture-demo-001",sportId:11,tournamentId:132,
  statusId:0,hasOdds:true,participant1Id:"5001",participant2Id:"5002",
  startTime:iso(180),bookmakerOdds:{"betano.pt":{
   bookmakerIsActive:true,suspended:false,markets:{}
  }}};
 const out=await inspectWithServerEspnEvidence(
  {catalogue:[],fixture,providerPlayerId:"20001"},{
   now:NOW,getReviewedTeamBridge:()=>[
    {providerParticipantId:"5001",espnTeamId:"1001"},
    {providerParticipantId:"5002",espnTeamId:"1002"}],
   fetchEspn:async()=>{throw Error("Must not request ESPN")}
  });
 assert.equal(out.status,"REVIEWED_TEAM_BRIDGE_UNAVAILABLE");
});
test("35.1D3 resolver is never a Firebase callable or data writer",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const code=fs.readFileSync(require.resolve("./offer-team-crosswalk"),"utf8");
 const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 assert.doesNotMatch(code,/\bfetch\s*\(|onCall\s*\(|httpsCallable|getFirestore|runTransaction|setInterval|apiKey|ODDSPAPI_API_KEY/);
 assert.doesNotMatch(index,/require\(["']\.\/offer-team-crosswalk["']\)/);
 assert.match(code,/SERVER_REVIEWED_TEAM_MANIFEST = Object\.freeze\(\[\]\)/);
});
