"use strict";
// Synthetic fixtures only. No Firebase, ESPN, NBA or OddsPapi live calls.
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {REVIEWED_CASE,REASON,matchReviewedCase,verifyEspnFinalAbsent,makeEvidence,
 reconcileReviewedInactive}=require("./reconcile-reviewed-inactive");
const NOW=Date.parse("2026-11-13T17:00:00.000Z");
const CAPTURE=Date.parse("2026-11-11T17:09:51.713Z");
function record(overrides={}){
 return {
  ...Object.fromEntries(["eventId","athleteId","teamId","homeId","awayId","eventStartMs",
   "player","team","home","away","market","line","side"].map(k=>[k,REVIEWED_CASE[k]])),
  schemaVersion:2,capturedVia:"trusted_firebase_callable",odds:1.95,
  modelOver:0.72,modelSelected:0.28,status:"pending",
  capturedServerAt:{toMillis:()=>CAPTURE},clientCapturedMs:CAPTURE,
  hits12:5,games12:12,hits24:10,games24:24,
  resultStat:null,resultWon:null,settledAt:null,voidReason:null,settlementSource:null,
  ...overrides
 };
}
function finalSummary(players=[]){
 const competitor=(homeAway,id)=>({homeAway,team:{id}});
 return {header:{id:REVIEWED_CASE.eventId,competitions:[{
  id:REVIEWED_CASE.eventId,date:new Date(REVIEWED_CASE.eventStartMs).toISOString(),
  status:{type:{state:"post",completed:true,name:"STATUS_FINAL"}},
  competitors:[competitor("home",REVIEWED_CASE.homeId),competitor("away",REVIEWED_CASE.awayId)]
 }]},boxscore:{players:[
  {team:{id:REVIEWED_CASE.teamId},statistics:[{athletes:
   players.length?players:[{athlete:{id:"100101"},stats:["22:00"]}]}]},
  {team:{id:REVIEWED_CASE.homeId},statistics:[{athletes:[{athlete:{id:"200101"},stats:["32:00"]}]}]}
 ]}};
}
function dbFixture(first=record()){
 const ref={state:first};let reads=0,txCalls=0,updates=0;
 const doc={get:async()=>{reads++;return {exists:true,data:()=>ref.state}}};
 const db={
  doc:pathStr=>{assert.equal(pathStr,"users/TestOwner/propResearchLedger/"+
   REVIEWED_CASE.recordId);return {...doc,path:pathStr}},
  runTransaction:async(fn,opt)=>{
   txCalls++;assert.equal(opt.maxAttempts,3);
   return fn({get:async()=>({exists:true,data:()=>ref.state}),
    update:(_ref,changes)=>{updates++;ref.state={...ref.state,...changes}}});
  }
 };
 return {db,ref,counts:()=>({reads,txCalls,updates})};
}
const args=(db,more={})=>({db,uid:"TestOwner",recordId:REVIEWED_CASE.recordId,
 now:NOW,fetchEspnFinal:async()=>finalSummary(),serverTimestamp:()=>({toMillis:()=>NOW}),...more});

test("fixed reviewed manifest is game/athlete/selection-specific with official URLs",()=>{
 assert.equal(REVIEWED_CASE.recordId,"401909968_4251_REB_4p5_Under");
 assert.equal(REVIEWED_CASE.eventId,"401909968");
 assert.equal(REVIEWED_CASE.athleteId,"4251");
 assert.equal(REVIEWED_CASE.teamId,"2");
 assert.equal(REVIEWED_CASE.nbaGameId,"0022600219");
 assert.equal(REVIEWED_CASE.nbaReportStatus,"Out");
 assert.match(REVIEWED_CASE.nbaReportUrl,/^https:\/\/ak-static\.cms\.nba\.com\/referee\/injury\//);
 assert.match(REVIEWED_CASE.nbaPostgameUrl,/^https:\/\/www\.nba\.com\/game\//);
 assert.match(REVIEWED_CASE.reviewMethod,/not_live_parsed/);
});
test("trusted capture and exact identity required; all other records rejected",()=>{
 assert.equal(matchReviewedCase(REVIEWED_CASE.recordId,record(),NOW),"pending");
 for(const [field,value] of [["player","Other Player"],["athleteId","999"],["teamId","28"],
  ["homeId","2"],["awayId","28"],["eventId","999"],["eventStartMs",NOW],
  ["market","PTS"],["side","Over"],["line",6.5],["capturedVia","legacy"],
  ["schemaVersion",1],["resultWon",false],["resultStat",0],
  ["odds",null],["modelOver",NaN],["modelSelected",1.5]]){
  assert.throws(()=>matchReviewedCase(REVIEWED_CASE.recordId,record({[field]:value}),NOW),field);
 }
 assert.throws(()=>matchReviewedCase("other",record(),NOW),/No reviewed/);
 assert.throws(()=>matchReviewedCase(REVIEWED_CASE.recordId,record(),
  REVIEWED_CASE.eventStartMs),/No reviewed/);
});
test("pre-tip-off receipt, client/server match, pending state and unscored record required",()=>{
 const bad=[record({capturedServerAt:null}),record({clientCapturedMs:CAPTURE+1000}),
  record({capturedServerAt:{toMillis:()=>REVIEWED_CASE.eventStartMs-300000}}),
  record({status:"settled"}),record({status:"void"}),
  record({settledAt:{toMillis:()=>NOW}}),record({voidReason:"other"}),
  record({settlementSource:"other"})];
 for(const r of bad)assert.throws(()=>matchReviewedCase(REVIEWED_CASE.recordId,r,NOW));
});
test("ESPN Final and absence require exact game, team, start, and valid player rows",()=>{
 assert.equal(verifyEspnFinalAbsent(finalSummary(),record()).checkedTeamAthletes,1);
 const mismatches=[
  s=>s.header.id="999",s=>s.header.competitions[0].id="999",
  s=>s.header.competitions[0].date="2026-11-13T00:00:00Z",
  s=>s.header.competitions[0].status.type.state="in",
  s=>{s.header.competitions[0].status.type.completed=false;
   s.header.competitions[0].status.type.name="IN_PROGRESS"},
  s=>s.header.competitions[0].competitors[1].team.id="99",
  s=>s.header.competitions[0].competitors[1].homeAway="home",
  s=>s.boxscore.players[0].team.id="99",
  s=>s.boxscore.players[0].statistics=[]
 ];
 for(const change of mismatches){const s=finalSummary();change(s);
  assert.throws(()=>verifyEspnFinalAbsent(s,record()));}
});
test("any matching ESPN athlete row blocks the exception even when explicitly DNP",()=>{
 for(const athlete of [
  {athlete:{id:REVIEWED_CASE.athleteId},stats:["0:00"],didNotPlay:true},
  {athlete:{id:REVIEWED_CASE.athleteId},stats:["22:10"],didNotPlay:false}
 ])assert.throws(()=>verifyEspnFinalAbsent(finalSummary([athlete]),record()),
  /normal verified settlement/);
 const s=finalSummary();
 s.boxscore.players[1].statistics[0].athletes=[{athlete:{id:REVIEWED_CASE.athleteId}}];
 assert.throws(()=>verifyEspnFinalAbsent(s,record()),/contains the player/);
});
test("reviewed case writes only a no-action with evidence, preserving all original fields",async()=>{
 const f=dbFixture(),old=f.ref.state;let fetched=0;
 const result=await reconcileReviewedInactive(args(f.db,{
  fetchEspnFinal:async()=>{fetched++;return finalSummary()}}));
 assert.deepEqual(result,{voided:true,alreadyReconciled:false,
  reason:REASON,recordId:REVIEWED_CASE.recordId});
 assert.equal(fetched,1);
 assert.deepEqual(f.counts(),{reads:1,txCalls:1,updates:1});
 const now=f.ref.state;
 assert.equal(now.status,"void");assert.equal(now.voidReason,REASON);
 assert.equal(now.resultWon,null);assert.equal(now.resultStat,null);
 for(const k of ["odds","line","side","modelOver","modelSelected","eventId",
  "athleteId","clientCapturedMs","capturedServerAt"])
  assert.equal(now[k],old[k],"Frozen original must not change: "+k);
 assert.equal(now.reconciliationEvidence.nbaGameId,"0022600219");
 assert.match(now.reconciliationEvidence.disclaimer,/not fetched or parsed/);
 assert.equal(now.reconciliationEvidence.reviewMethod,REVIEWED_CASE.reviewMethod);
});
test("repeat invocation is idempotent without another ESPN fetch or mutation",async()=>{
 const f=dbFixture();let fetched=0;
 const input=args(f.db,{fetchEspnFinal:async()=>{fetched++;return finalSummary()}});
 await reconcileReviewedInactive(input);
 const again=await reconcileReviewedInactive(input);
 assert.equal(again.alreadyReconciled,true);
 assert.equal(fetched,1);assert.equal(f.counts().updates,1);
 assert.equal(f.counts().txCalls,1);
});
test("missing or unavailable ESPN Final cannot update a PENDING record",async()=>{
 const f=dbFixture();await assert.rejects(()=>reconcileReviewedInactive(args(f.db,{
  fetchEspnFinal:async()=>{throw new Error("ESPN unavailable")}})),/ESPN unavailable/);
 assert.equal(f.ref.state.status,"pending");assert.equal(f.counts().updates,0);
});
test("ESPN played player row cannot be used for reviewed no-action",async()=>{
 const f=dbFixture();await assert.rejects(()=>reconcileReviewedInactive(args(f.db,{
  fetchEspnFinal:async()=>finalSummary([{athlete:{id:REVIEWED_CASE.athleteId},
   stats:["23:00"]}])})),/normal verified settlement/);
 assert.equal(f.ref.state.status,"pending");assert.equal(f.counts().updates,0);
});
test("transaction refuses racing settlement or changed frozen model, price or receipt",async()=>{
 for(const altered of [{status:"settled",resultWon:false,resultStat:5},
  {odds:1.99},{modelSelected:0.2},
  {capturedServerAt:{toMillis:()=>CAPTURE+1}}]){
  const f=dbFixture();f.db.runTransaction=async fn=>{
   f.ref.state={...f.ref.state,...altered};
   return fn({get:async()=>({exists:true,data:()=>f.ref.state}),
    update:()=>assert.fail("Unsafe write attempted")});
  };
  await assert.rejects(()=>reconcileReviewedInactive(args(f.db)),
   /changed|requires|not an eligible/);
 }
});
test("other records and malformed account identifiers reject before Firestore reads",async()=>{
 const f=dbFixture();
 for(const override of [{recordId:"random"},{uid:""},{uid:"../../other"}])
  await assert.rejects(()=>reconcileReviewedInactive(args(f.db,override)),
   /Invalid or unsupported/);
 assert.deepEqual(f.counts(),{reads:0,txCalls:0,updates:0});
});
test("source provenance explicitly separates reviewed NBA evidence from Betano void",()=>{
 const ev=makeEvidence({eventId:REVIEWED_CASE.eventId,teamId:REVIEWED_CASE.teamId,
  athleteId:REVIEWED_CASE.athleteId,checkedTeamAthletes:14});
 assert.equal(ev.schemaVersion,1);assert.equal(ev.espnReviewedTeamAthletes,14);
 assert.match(ev.disclaimer,/No independently verified Betano void/);
 assert.match(ev.reviewMethod,/not_live_parsed/);
});
test("callable is owner-only, single-case, manual and reuses existing ESPN verification",()=>{
 const source=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const block=source.slice(source.indexOf("// Update 35.2C — owner-clicked"));
 assert.match(block,/ledgerAssertOwner\(request\)/);
 assert.match(block,/Object\.keys\(request\.data\)\.length !== 1/);
 assert.match(block,/REVIEWED_CASE\.recordId/);
 assert.match(block,/ledgerGetEspn\("summary\?event="/);
 assert.match(block,/FieldValue\.serverTimestamp\(\)/);
 assert.doesNotMatch(block,/oddsPapi|setInterval|onSchedule\(/);
 const normal=source.slice(source.indexOf("exports.ledgerSettleProspective=onCall("),
  source.indexOf("// Update 34.6 — optional daily"));
 assert.match(normal,/ledgerExtractFinalFromEspn\(summary,entry\)/);
 assert.match(normal,/ESPN_EXPLICIT_DNP/);
});
