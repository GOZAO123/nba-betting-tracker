"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {spawnSync} = require("node:child_process");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const begin = "// Update 34.7 pure dashboard metrics BEGIN";
const end = "// Update 34.7 pure dashboard metrics END";
const first = html.indexOf(begin), last = html.indexOf(end);
assert.ok(first > 0 && last > first, "Pure dashboard calculation section exists");
const pure = html.slice(first + begin.length, last);
const {ledgerWilson95, ledgerDashboardMetrics} =
  new Function(pure + "\nreturn { ledgerWilson95, ledgerDashboardMetrics };")();

function row(overrides = {}) {
 return {player:"Example Player",team:"Example Team",market:"PTS",status:"settled",
  modelSelected:0.5,resultStat:23,resultWon:true,schemaVersion:2,
  capturedVia:"trusted_firebase_callable",...overrides};
}
const status = r=>r.status==="settled"?"SETTLED":
 r.status==="pending"?"PENDING":"UNVERIFIED TIMESTAMP";

test("all inline frontend JavaScript scripts parse, including ES modules", () => {
 const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(x=>!/\bsrc\s*=/.test(x[1]));
 assert.ok(scripts.length>=4, "Expected inline scripts are present");
 for(const [i,s] of scripts.entries()){
  const module = /\btype\s*=\s*["']module["']/.test(s[1]);
  const args = ["--check", ...(module?["--input-type=module"]:[])];
  const result = spawnSync(process.execPath,args,{input:s[2],encoding:"utf8"});
  assert.equal(result.status,0,"Script "+(i+1)+" failed: "+result.stderr);
 }
});

test("two losing settled observations produce the displayed historical Brier 0.1976", () => {
 const records=[
  row({player:"First",team:"NYK",modelSelected:0.506,resultWon:false,
    capturedVia:null,schemaVersion:1}),
  row({player:"Second",team:"OKC",modelSelected:0.373,resultWon:false})
 ];
 const m=ledgerDashboardMetrics(records,status);
 assert.equal(m.loaded,2);
 assert.deepEqual([m.overall.records,m.overall.pending,m.overall.settled,
  m.overall.wins,m.overall.losses,m.overall.scored],[2,0,2,0,2,2]);
 assert.equal((m.overall.squaredError/2).toFixed(4),"0.1976");
 assert.equal(m.overall.squaredError/2,0.1975825);
 assert.equal(m.groups.capture.length,2);
 assert.equal(m.groups.team.length,2);
 assert.equal(m.groups.market.length,1);
 assert.equal(m.groups.player.length,2);
});

test("pending/excluded outcomes are not counted as losses or scored", () => {
 const m=ledgerDashboardMetrics([
  row({status:"pending",resultStat:null,resultWon:null}),
  row({status:"unverified",resultStat:null,resultWon:null}),
  row({resultStat:null,resultWon:null}),
  row({resultStat:24,resultWon:false})
 ],status);
 assert.deepEqual([m.overall.records,m.overall.pending,m.overall.excluded,
  m.overall.settled,m.overall.losses,m.overall.wins,m.overall.scored],
 [4,1,1,2,1,0,1]);
});

test("Brier score excludes invalid model estimates and absent ESPN results", () => {
 const m=ledgerDashboardMetrics([
  row({resultWon:true,modelSelected:0.8}),
  row({resultWon:false,modelSelected:1.2}),
  row({resultWon:false,modelSelected:NaN}),
  row({resultWon:null,resultStat:null,modelSelected:0.3})
 ],status);
 assert.equal(m.overall.settled,4);
 assert.equal(m.overall.wins,1);
 assert.equal(m.overall.losses,2);
 assert.equal(m.overall.scored,1);
 assert.ok(Math.abs(m.overall.squaredError-0.04)<1e-12);
});

test("Wilson uncertainty reports sparse 0/2 outcomes and refuses n=0",()=>{
 const [low,high]=ledgerWilson95(0,2);
 assert.equal(low,0);
 assert.ok(high>0.65&&high<0.66);
 assert.equal(ledgerWilson95(0,0),null);
 assert.equal(ledgerWilson95(3,2),null);
 const [lower,upper]=ledgerWilson95(100,100);
 assert.ok(lower>0.96&&upper===1);
});

test("breakdowns show grouped pending/settled and avoid false legacy classification", () => {
 const m=ledgerDashboardMetrics([
  row({player:"A",team:"Team X",market:"PTS",status:"pending"}),
  row({player:"A",team:"Team X",market:"PTS",resultWon:false,
    capturedVia:null,schemaVersion:1}),
  row({player:"B",team:"Team Y",market:"REB",resultWon:true}),
  row({player:"C",team:"Team Z",market:"AST",resultWon:false,
    capturedVia:"unknown",schemaVersion:99})
 ],status);
 const pts=m.groups.market.find(x=>x.name==="PTS");
 assert.deepEqual([pts.records,pts.pending,pts.settled,pts.wins,pts.losses],
 [2,1,1,0,1]);
 assert.deepEqual(m.groups.capture.map(x=>x.name).sort(),
  ["Backend","Legacy / pre-backend","Unclassified"]);
});

test("latest 50 records are labeled a sample, never an all-time total",()=>{
 assert.equal(ledgerDashboardMetrics(Array.from({length:49},()=>row()),status).limited,false);
 assert.equal(ledgerDashboardMetrics(Array.from({length:50},()=>row()),status).limited,true);
 const renderBlock=html.slice(html.indexOf("function ledgerRenderDashboard("),
  html.indexOf("// Descriptive calibration only."));
 assert.match(renderBlock,/NOT all-time totals/);
 assert.match(renderBlock,/No additional Firebase reads/);
 assert.doesNotMatch(renderBlock,/getDocsFromServer|httpsCallable|fetch\s*\(/);
});

test("ledger dashboard renders from existing loaded rows without changing cloud query limit",()=>{
 assert.match(html,/ledgerRenderDashboard\(ledgerResults,ledgerDashboardMetrics\(ledgerRows,ledgerState,ledgerMoreAvailable\)\)/);
 assert.match(html,/const constraints=\[orderBy\('clientCapturedMs','desc'\)\]/);
 assert.match(html,/constraints.push\(limit\(LEDGER_PAGE_SIZE\)\)/);
 assert.match(html,/constraints.push\(startAfter\(ledgerLastDoc\)\)/);
 assert.match(html,/ledgerSettleProspective/);
 assert.match(html,/ledgerCaptureProspective/);
 assert.match(html,/width=800,initial-scale/);
});

test("pagination combines three 50/50/20 pages into 120 unique records", () => {
 const begin=html.indexOf("function ledgerCombinePages(");
 const end=html.indexOf("async function ledgerLoad(",begin);
 assert.ok(begin>0&&end>begin);
 const combine=new Function("const LEDGER_PAGE_SIZE=50;\n"+
  html.slice(begin,end)+"\nreturn ledgerCombinePages;")();
 const docs=Array.from({length:120},(_,i)=>({
  id:"record-"+i,data:()=>row({player:"Player "+i,modelSelected:i%2?.6:.4})
 }));
 const first=combine([],docs.slice(0,50),false);
 assert.equal(first.records.length,50);
 assert.equal(first.moreAvailable,true);
 const second=combine(first.records,docs.slice(50,100),true);
 assert.equal(second.records.length,100);
 assert.equal(second.moreAvailable,true);
 const third=combine(second.records,docs.slice(100),true);
 assert.equal(third.records.length,120);
 assert.equal(third.moreAvailable,false);
 assert.equal(new Set(third.records.map(r=>r.id)).size,120);
 const metrics=ledgerDashboardMetrics(third.records,status,third.moreAvailable);
 assert.equal(metrics.overall.records,120);
 assert.equal(metrics.limited,false);
});

test("pagination avoids duplicated document IDs when appending or resetting",()=>{
 const begin=html.indexOf("function ledgerCombinePages(");
 const end=html.indexOf("async function ledgerLoad(",begin);
 const combine=new Function("const LEDGER_PAGE_SIZE=50;\n"+
  html.slice(begin,end)+"\nreturn ledgerCombinePages;")();
 const docs=[{id:"one",data:()=>row({player:"First"})},
  {id:"two",data:()=>row({player:"Second"})}];
 const first=combine([],docs,false);
 assert.deepEqual(first.records.map(r=>r.id),["one","two"]);
 assert.deepEqual(combine(first.records,[docs[0]],true).records.map(r=>r.id),["one","two"]);
 assert.deepEqual(combine(first.records,[docs[0]],false).records.map(r=>r.id),["one"]);
 assert.equal(combine(first.records,[],true).moreAvailable,false);
});

test("exactly 50 records requires one explicit click to determine whether older exist",()=>{
 const begin=html.indexOf("function ledgerCombinePages(");
 const end=html.indexOf("async function ledgerLoad(",begin);
 const combine=new Function("const LEDGER_PAGE_SIZE=50;\n"+
  html.slice(begin,end)+"\nreturn ledgerCombinePages;")();
 const first=combine([],Array.from({length:50},(_,i)=>({id:String(i),data:()=>row()})),false);
 assert.equal(first.moreAvailable,true);
 const second=combine(first.records,[],true);
 assert.equal(second.moreAvailable,false);
 assert.equal(second.records.length,50);
});

test("dashboard highlights partially loaded data even when more than 50 entries are loaded",()=>{
 const rows=Array.from({length:105},(_,i)=>row({player:"P"+i}));
 const result=ledgerDashboardMetrics(rows,status,true);
 assert.equal(result.loaded,105);
 assert.equal(result.limited,true);
 assert.equal(ledgerDashboardMetrics(rows,status,false).limited,false);
 const msg=html.slice(html.indexOf("function ledgerRenderDashboard("),
  html.indexOf("// Descriptive calibration only."));
 assert.match(msg,/More may exist/);
 assert.match(msg,/Documents without a client capture timestamp are not included/);
});

test("paginator guards account changes, duplicate requests and leaves reads explicit",()=>{
 const begin=html.indexOf("// Update 35.0A:");
 const end=html.indexOf("// Update 34.7 pure dashboard metrics BEGIN",begin);
 const block=html.slice(begin,end);
 assert.ok(begin>0&&end>begin);
 assert.match(block,/ledgerPageBusy=true;ledgerRefresh.disabled=true;ledgerLoadMore.disabled=true/);
 assert.match(block,/auth\.currentUser\?\.uid!==uid\|\|session!==ledgerSession/);
 assert.match(block,/getDocsFromServer/);
 assert.match(block,/ledgerLoadMore\.addEventListener\('click'/);
 assert.match(block,/ledgerRefresh\.addEventListener\('click'/);
 assert.match(block,/if\(append\)constraints\.push\(startAfter\(ledgerLastDoc\)\)/);
 assert.match(block,/ledgerLastDoc=page\.docs\.length\?page\.docs\[page\.docs\.length-1\]/);
 assert.doesNotMatch(block,/getDocs\s*\(|httpsCallable|fetch\s*\(/);
 const reset=html.slice(html.indexOf("function ledgerReset(){"),
  html.indexOf("ledgerDate.addEventListener('change'"));
 assert.match(reset,/ledgerLastDoc=null;ledgerMoreAvailable=false;ledgerPageBusy=false/);
 assert.match(reset,/ledgerLoadMore.hidden=true/);
});


// Update 35.0B: all batch rows below are synthetic offline parser fixtures.
// No fixture, odds, or quote in these tests is a verified bookmaker offer.
const batchParser=(()=>{
 const canonicalStart=html.indexOf("function canonicalPlayerName(");
 const canonicalEnd=html.indexOf("const ESPN_NBA_TEAM_IDS=",canonicalStart);
 const validateStart=html.indexOf("function lrValidateLine(");
 const validateEnd=html.indexOf("function lrNormalOver(",validateStart);
 const parserStart=html.indexOf("function batchParseOffers(");
 const parserEnd=html.indexOf("// Update 35.0B pure parser END",parserStart);
 assert.ok(canonicalStart>0&&canonicalEnd>canonicalStart);
 assert.ok(validateStart>0&&validateEnd>validateStart);
 assert.ok(parserStart>0&&parserEnd>parserStart);
 return new Function(
  html.slice(canonicalStart,canonicalEnd)+
  html.slice(validateStart,validateEnd)+
  html.slice(parserStart,parserEnd)+
  "\nreturn batchParseOffers;")();
})();
const exampleTeams={"Boston Celtics":"2","New York Knicks":"18","Oklahoma City Thunder":"25"};
const item=(player="Example Player",team="Boston Celtics",market="PTS",line="20.5",
 side="Over",odds="1.80")=>[player,team,market,line,side,odds].join(" | ");

test("manual quote parser accepts up to 20 valid rows, comma decimals and TAB columns",()=>{
 const input=[
  item("Sample One","Boston Celtics","pts","20,5","over","1,75"),
  ["Sample Two","New York Knicks","REB","7.5","UNDER","2.20"].join("\t")
 ].join("\n");
 const parsed=batchParser(input,exampleTeams);
 assert.deepEqual(parsed.errors,[]);
 assert.equal(parsed.rows.length,2);
 assert.deepEqual([parsed.rows[0].market,parsed.rows[0].line,parsed.rows[0].side,
  parsed.rows[0].odds],["PTS",20.5,"Over",1.75]);
 assert.deepEqual([parsed.rows[1].market,parsed.rows[1].side],["REB","Under"]);
 assert.equal(parsed.rows.every(r=>!Object.hasOwn(r,"modelSelected")&&!Object.hasOwn(r,"athleteId")),true);
});

test("all eight supported markets are accepted without unvalidated model filters",()=>{
 const markets=["PTS","REB","AST","3PT","PR","PA","RA","PRA"];
 const payload=markets.map((market,i)=>item("Sample "+i,"Boston Celtics",
  market,(i+1)+".5","Over","1.80")).join("\n");
 const parsed=batchParser(payload,exampleTeams);
 assert.deepEqual(parsed.errors,[]);
 assert.equal(parsed.rows.length,8);
 assert.deepEqual(parsed.rows.map(x=>x.market),markets);
});

test("wrong team or invalid odds, line, side and market reject the entire batch",()=>{
 const faulty=[
  item("One","Boston Celtics"),
  item("Two","Fake Team"),
  item("Three","Boston Celtics","PTS","21","Over","1.80"),
  item("Four","Boston Celtics","PTS","21.5","Over","1.00"),
  item("Five","Boston Celtics","PTS","21.5","Draw","1.80"),
  item("Six","Boston Celtics","NotMarket","21.5","Over","1.80")
 ].join("\n");
 const parsed=batchParser(faulty,exampleTeams);
 assert.equal(parsed.rows.length,0);
 assert.equal(parsed.errors.length,5);
});

test("duplicate selections are rejected even if a second quote has different odds",()=>{
 const p=batchParser([
  item("Same Player","Boston Celtics","PTS","20.5","Over","1.80"),
  item("Same Player","Boston Celtics","PTS","20.5","Over","1.95")
 ].join("\n"),exampleTeams);
 assert.equal(p.rows.length,0);
 assert.match(p.errors.join(" "),/duplicate selection/i);
});

test("missing columns, empty input and oversized batches are rejected",()=>{
 assert.ok(batchParser("",exampleTeams).errors.length);
 assert.ok(batchParser("First | Boston Celtics | PTS",exampleTeams).errors.length);
 assert.ok(batchParser(Array.from({length:21},(_,i)=>
  item("Test Player "+i)).join("\n"),exampleTeams).errors.length);
 assert.ok(batchParser("a".repeat(5001),exampleTeams).errors.length);
});

test("malicious HTML-looking player strings are rejected and never rendered as HTML",()=>{
 const parsed=batchParser(item("<img src=x onerror=alert(1)>"),exampleTeams);
 assert.equal(parsed.rows.length,0);
 assert.ok(parsed.errors.length);
 const start=html.indexOf("function batchRender(){");
 const end=html.indexOf("batchOfferPrepare.addEventListener(",start);
 const render=html.slice(start,end);
 assert.ok(start>0&&end>start);
 assert.doesNotMatch(render,/innerHTML|insertAdjacentHTML/);
 assert.match(render,/researchCreate\('strong'/);
});

test("batch queue requires explicit quote confirmation and only prefills existing research",()=>{
 assert.match(html,/id="batchOfferConfirmed"/);
 assert.match(html,/id="batchOfferInput"/);
 assert.match(html,/maxlength="5000"/);
 assert.match(html,/id="batchOfferRows"/);
 const start=html.indexOf("// Update 35.0B — pure parser;");
 const end=html.indexOf("// Update 34.3:",start);
 const block=html.slice(start,end);
 assert.ok(start>0&&end>start);
 assert.match(block,/if\(!batchOfferConfirmed.checked\)/);
 assert.match(block,/lrQuoteContext=null;lrLatestResearch=null;lrResults.replaceChildren\(\)/);
 assert.match(block,/ledgerQuoteConfirmed.checked=false/);
 assert.match(block,/function batchReset\(\)/);
 assert.doesNotMatch(block,/httpsCallable|getDocsFromServer|fetch\s*\(|sessionStorage|localStorage|\.click\s*\(/);
 const signout=html.slice(html.indexOf("function ledgerReset(){"),
  html.indexOf("ledgerDate.addEventListener('change'"));
 assert.match(signout,/batchReset\(\)/);
 assert.match(html,/ledgerCaptureProspective/);
 assert.match(html,/confirmedObservedQuote:true/);
});


// Update 35.0C: synthetic inputs exercise UI-only offer validation.
// No real sportsbook odds or player-team facts are asserted by these tests.
const testComposer=(()=>{
 const begin=html.indexOf("// Update 35.0C pure offer validation BEGIN");
 const end=html.indexOf("// Update 35.0C pure offer validation END",begin);
 assert.ok(begin>0&&end>begin);
 const validator=html.slice(begin,end);
 const script=html.slice(html.indexOf("function canonicalPlayerName("),
  html.indexOf("const ESPN_NBA_TEAM_IDS="))+
  html.slice(html.indexOf("function lrValidateLine("),html.indexOf("function lrNormalOver("))+
  html.slice(html.indexOf("function batchParseOffers("),
   html.indexOf("// Update 35.0B pure parser END"))+
  validator+"\nreturn batchComposerCandidate;";
 return new Function(script)();
})();
const fixtureAt=(start=Date.now()+8*3600000)=>({
 id:"401000001",start,homeId:"18",awayId:"2",home:"New York Knicks",away:"Boston Celtics"
});
const quote={
 player:"Example Player",team:"Boston Celtics",market:"PTS",
 line:"20.5",side:"Over",odds:"1.82"
};
const idTeams={"Boston Celtics":"2","New York Knicks":"18"};
const athlete={id:"1234567",name:"Example Player"};

test("searchable composer accepts exact ESPN roster player, team and fixture",()=>{
 const draft=testComposer(quote,athlete,fixtureAt(),[],idTeams);
 assert.equal(draft.player,"Example Player");
 assert.equal(draft.team,"Boston Celtics");
 assert.equal(draft.market,"PTS");
 assert.equal(draft.odds,1.82);
 assert.equal(draft.eventId,"401000001");
 assert.equal(draft.espnAthleteId,"1234567");
 assert.equal(draft.fixtureLabel,"Boston Celtics @ New York Knicks");
 assert.equal(Object.hasOwn(draft,"modelOver"),false);
 assert.equal(Object.hasOwn(draft,"resultWon"),false);
});

test("searchable composer fails closed for ambiguous/mismatched player identity",()=>{
 assert.throws(()=>testComposer({...quote,player:"Other Player"},athlete,fixtureAt(),[],idTeams),/exact player/);
 assert.throws(()=>testComposer(quote,null,fixtureAt(),[],idTeams),/exact player/);
 assert.throws(()=>testComposer(quote,{name:"Example Player",id:"invalid"},fixtureAt(),[],idTeams),/exact player/);
});

test("searchable composer rejects different team and near-tipoff fixtures",()=>{
 assert.throws(()=>testComposer({...quote,team:"Washington Wizards"},athlete,fixtureAt(),[],{
  ...idTeams,"Washington Wizards":"27"
 }),/fixture/);
 assert.throws(()=>testComposer(quote,athlete,fixtureAt(Date.now()+2*60000),[],idTeams),/fixture/);
 assert.throws(()=>testComposer(quote,athlete,undefined,[],idTeams),/fixture/);
});

test("searchable composer rejects malformed lines/odds, duplicates and more than 20 drafts",()=>{
 assert.throws(()=>testComposer({...quote,line:"20"},athlete,fixtureAt(),[],idTeams),/invalid|half-point/i);
 assert.throws(()=>testComposer({...quote,odds:"1.00"},athlete,fixtureAt(),[],idTeams),/invalid|price/i);
 const existing=testComposer(quote,athlete,fixtureAt(),[],idTeams);
 assert.throws(()=>testComposer(quote,athlete,fixtureAt(),[existing],idTeams),/already/);
 assert.throws(()=>testComposer(quote,athlete,fixtureAt(),Array(20).fill(existing),idTeams),/20 drafts/);
});

test("composer preserves explicit user actions, cached roster lookup and no paid API calls",()=>{
 const begin=html.indexOf("// Update 35.0C pure offer validation BEGIN");
 const end=html.indexOf("function ledgerSameResearch(",begin);
 const block=html.slice(begin,end);
 assert.ok(begin>0&&end>begin);
 assert.match(block,/batchComposerFind\.addEventListener\('click'/);
 assert.match(block,/ledgerFind\.click\(\)/);
 assert.match(block,/batchComposerLoadRoster\.addEventListener\('click'/);
 assert.match(block,/readEspnIdentity\(RESEARCH_ESPN_BASE/);
 assert.match(block,/batchComposerAdd\.addEventListener\('click'/);
 assert.match(block,/batchComposerConfirmed.checked/);
 assert.match(block,/batchOffers.push\(draft\)/);
 assert.match(block,/batchRosterEpoch/);
 assert.match(block,/uid!==auth\.currentUser\?\.uid\|\|session!==ledgerSession/);
 assert.doesNotMatch(block,/oddsPapi[A-Z]|httpsCallable|getDocsFromServer|setInterval|setTimeout|localStorage|sessionStorage/);
});

test("composer and price editing do not bypass the original secure capture workflow",()=>{
 for(const id of ["batchComposerDate","batchComposerFixture","batchComposerTeam",
  "batchComposerPlayer","batchComposerPlayers","batchComposerMarket",
  "batchComposerSide","batchComposerLine","batchComposerOdds",
  "batchComposerConfirmed","batchComposerAdd","batchComposerStatus"]){
  assert.equal([...html.matchAll(new RegExp('id="'+id+'"','g'))].length,1,
   id+" must exist exactly once");
 }
 assert.match(html,/batchComposerSyncFixtures\(\)/);
 assert.match(html,/ledgerQuoteConfirmed.checked=false/);
 assert.match(html,/lrLatestResearch=null;lrQuoteContext=null;lrResults.replaceChildren\(\)/);
 assert.match(html,/Edit odds/);
 assert.match(html,/Save new price/);
 assert.match(html,/confirm\('Confirm this is the updated Betano price/);
 assert.match(html,/Remove this unsaved local draft/);
 assert.match(html,/trusted backend capture/);
 assert.match(html,/httpsCallable\(oddsFunctions,'ledgerCaptureProspective'\)/);
});

test("composer reuses existing verified ESPN fixture map and resets on signout",()=>{
 assert.match(html,/const available=\[\.\.\.ledgerEvents.values\(\)\]/);
 assert.match(html,/fixture\.start>Date\.now\(\)\+LEDGER_GRACE/);
 assert.match(html,/if\(session===ledgerSession\)batchComposerSyncFixtures\(\)/);
 const reset=html.slice(html.indexOf("function ledgerReset(){"),
  html.indexOf("ledgerDate.addEventListener('change'"));
 assert.match(reset,/batchReset\(\)/);
 assert.match(html,/function batchReset\(\)[\s\S]*?batchComposerReset\(\)/);
 assert.match(html,/batchComposerRoster|batchRosterNames/);
});


// Update 35.0D: deterministic synthetic research fixtures, never bookmaker data.
const {batchResearchPlan,batchResearchMatchRoster,batchResearchEvaluate}=(()=>{
 const between=(a,b)=>{const i=html.indexOf(a),j=html.indexOf(b,i+a.length);
  assert.ok(i>=0&&j>i,"Missing testable research helper "+a);return html.slice(i,j);};
 const script=[
  between("function canonicalPlayerName(","const ESPN_NBA_TEAM_IDS="),
  between("function btNormalCdf(","// One forecast for the NEXT game"),
  between("function lrValidateLine(","function lrDraw("),
  between("function batchParseOffers(","// Update 35.0B pure parser END"),
  between("const BATCH_ESPN_MAX_ROWS=","// Update 35.0D pure batch research END")
 ].join("\n");
 return new Function(script+
  "\nreturn {batchResearchPlan,batchResearchMatchRoster,batchResearchEvaluate};")();
})();
const staged=(player,team="Indiana Pacers",market="PTS",line=16.5,side="Over",odds=1.82)=>({
 key:[player,team,market,line,side].join("|"),
 player,team,market,line,side,odds
});

test("batch ESPN plan deduplicates players across markets and counts bounded lookups",()=>{
 const rows=[
  staged("Andrew Nembhard"),staged("Andrew Nembhard","Indiana Pacers","AST",4.5),
  staged("Example Two","New York Knicks","REB",5.5)
 ];
 const p=batchResearchPlan(rows,{"Indiana Pacers":"11","New York Knicks":"18"});
 assert.equal(p.teams.length,2);
 assert.equal(p.players.length,2);
 assert.equal(p.potentialRequests,6); // 2 rosters and 2 logs each
 assert.equal(p.players.find(x=>x.teamId==="11").name,"Andrew Nembhard");
});

test("20 unique players across nine teams stay inside the 52-lookup hard cap",()=>{
 const teams=Object.fromEntries(Array.from({length:9},(_,i)=>["Team "+i,String(i+1)]));
 const rows=Array.from({length:20},(_,i)=>staged("Example Player "+i,"Team "+(i%9)));
 const p=batchResearchPlan(rows,teams);
 assert.equal(p.teams.length,9);
 assert.equal(p.players.length,20);
 assert.equal(p.potentialRequests,49);
});

test("batch research fails closed for excess teams, rows, malformed quotes and mismatched IDs",()=>{
 const teams=Object.fromEntries(Array.from({length:13},(_,i)=>["Team "+i,String(i+1)]));
 assert.throws(()=>batchResearchPlan([],teams),/1–20/);
 assert.throws(()=>batchResearchPlan(Array.from({length:21},(_,i)=>
  staged("Athlete "+i,"Team "+(i%13))),teams),/1–20/);
 assert.throws(()=>batchResearchPlan(Array.from({length:13},(_,i)=>
  staged("Athlete "+i,"Team "+i)),teams),/lookup ceiling/);
 assert.throws(()=>batchResearchPlan([staged("Athlete","Missing Team")],teams),/invalid player/i);
 assert.throws(()=>batchResearchPlan([staged("Athlete","Team 0","PTS",20, "Over")],teams),/invalid player/i);
 assert.throws(()=>batchResearchPlan([staged("Athlete","Team 0","PTS",20.5,"Over",1)],teams),/invalid player/i);
 const a={...staged("Athlete","Team 0","PTS"),espnAthleteId:"101"};
 const b={...staged("Athlete","Team 0","REB"),espnAthleteId:"999"};
 assert.throws(()=>batchResearchPlan([a,b],teams),/Conflicting ESPN player IDs/);
});

test("batch ESPN player identity is exact and rejects ambiguous or changed rosters",()=>{
 const roster={team:{id:"11",displayName:"Indiana Pacers"},
  athletes:[{items:[{id:"123",displayName:"Andrew Nembhard"},
   {id:"456",displayName:"Aaron Nesmith"}]}]};
 const verified=batchResearchMatchRoster(roster,"Indiana Pacers","11","Andrew Nembhard","123");
 assert.deepEqual(verified,{id:"123",name:"Andrew Nembhard"});
 assert.throws(()=>batchResearchMatchRoster(roster,"New York Knicks","11","Andrew Nembhard"),/team roster/);
 assert.throws(()=>batchResearchMatchRoster(roster,"Indiana Pacers","18","Andrew Nembhard"),/team roster/);
 assert.throws(()=>batchResearchMatchRoster(roster,"Indiana Pacers","11","Different Player"),/uniquely matched/);
 assert.throws(()=>batchResearchMatchRoster(roster,"Indiana Pacers","11","Andrew Nembhard","999"),/Staged ESPN athlete ID/);
 const ambiguous={...roster,athletes:[{items:[{id:"123",displayName:"Andrew Nembhard"},
  {id:"999",displayName:"Andrew Nembhard"}]}]};
 assert.throws(()=>batchResearchMatchRoster(ambiguous,"Indiana Pacers","11","Andrew Nembhard"),/uniquely matched/);
});

test("batch preview computes historical Over/Under side hits from the same preserved model",()=>{
 const now=Date.now();
 const games=Array.from({length:30},(_,i)=>({
  id:String(401000000+i),date:now-(30-i)*86400000,stats:{
   PTS:i%2===0?22:12,REB:i%3===0?9:5,AST:i%4===0?7:3,
   "3PT":i%2===0?3:0,PR:27,PA:25,RA:10,PRA:35,MIN:30
  }
 }));
 const over=batchResearchEvaluate(staged("Player","Indiana Pacers","PTS",16.5,"Over"),games);
 const under=batchResearchEvaluate(staged("Player","Indiana Pacers","PTS",16.5,"Under"),games);
 assert.equal(over.status,"ready");
 assert.equal(under.status,"ready");
 assert.equal(over.games,30);
 assert.equal(over.sample12,12);
 assert.equal(over.sample24,24);
 assert.equal(over.hits12+under.hits12,12);
 assert.equal(over.hits24+under.hits24,24);
 assert.ok(Math.abs(over.estimate+under.estimate-1)<1e-12);
 assert.ok(Math.abs(over.estimate24+under.estimate24-1)<1e-12);
});

test("missing ESPN history never creates a numerical research estimate",()=>{
 const now=Date.now();
 const tiny=Array.from({length:11},(_,i)=>({
  id:String(500000+i),date:now-(12-i)*86400000,stats:{PTS:20}
 }));
 const result=batchResearchEvaluate(staged("Player"),tiny);
 assert.equal(result.status,"insufficient");
 assert.equal(result.games,11);
 assert.equal(Object.hasOwn(result,"estimate"),false);
});

test("batch research runs only after explicit click, with two workers and no capture calls",()=>{
 const begin=html.indexOf("// Update 35.0D: one explicitly triggered");
 const end=html.indexOf("// Update 34.3:",begin);
 assert.ok(begin>0&&end>begin);
 const code=html.slice(begin,end);
 assert.match(code,/batchResearchRun.addEventListener\('click',async/);
 assert.match(code,/batchResearchPlan\(batchOffers,ESPN_NBA_TEAM_IDS\)/);
 assert.match(code,/readEspnIdentity\(\s*RESEARCH_ESPN_BASE/);
 assert.match(code,/encodeURIComponent\(athlete.id\).*gamelog\?season=/s);
 assert.match(code,/btParseGamelog\(payload,athlete.id,season\)/);
 assert.match(code,/Math\.min\(2,plan\.players\.length\)/);
 assert.match(code,/batchResearchMatchRoster/);
 assert.match(code,/auth\.currentUser\?\.uid===uid&&ledgerSession===session&&/);
 assert.doesNotMatch(code,/httpsCallable|getDocsFromServer|setDoc|runTransaction|oddsPapi[A-Z]|setInterval/);
});

test("batch output is purely descriptive and original capture still requires fresh individual research",()=>{
 assert.match(html,/id="batchResearchRun"/);
 assert.match(html,/id="batchResearchResults"/);
 assert.match(html,/52 potential ESPN lookups/);
 assert.match(html,/No bookmaker verification or cloud research capture/);
 assert.match(html,/run the original individual ESPN line research within 5 minutes/);
 assert.match(html,/batchResearchInvalidate\('A draft price changed/);
 assert.match(html,/batchResearchInvalidate\('New pasted drafts prepared/);
 assert.match(html,/batchResearchInvalidate\('A new local offer was added/);
 assert.match(html,/function batchReset\(\)[\s\S]*?batchResearchReset\(\)/);
 assert.match(html,/httpsCallable\(oddsFunctions,'ledgerCaptureProspective'\)/);
 assert.match(html,/Date\.now\(\)-\(snap\?\.at\|\|0\)>5\*60000/);
 assert.match(html,/confirmedObservedQuote:true/);
});
