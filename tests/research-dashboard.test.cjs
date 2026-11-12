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
 r.status==="pending"?"PENDING":
 r.status==="void"&&r.voidReason==="ESPN_EXPLICIT_DNP"?"DNP / NO ACTION":"UNVERIFIED TIMESTAMP";

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


test("explicit ESPN DNP is a separate non-scoring category, never a win or loss",()=>{
 const m=ledgerDashboardMetrics([
  row({player:"DNP",status:"void",voidReason:"ESPN_EXPLICIT_DNP",
    resultStat:null,resultWon:null,modelSelected:.65}),
  row({player:"Pending",status:"pending",resultStat:null,resultWon:null}),
  row({player:"Played",resultWon:false,modelSelected:.25}),
  row({player:"Invalid",status:"void",voidReason:"not confirmed",
    resultStat:null,resultWon:null})
 ],status,false);
 assert.deepEqual([m.overall.records,m.overall.pending,m.overall.settled,
   m.overall.voided,m.overall.excluded,m.overall.wins,m.overall.losses,
   m.overall.scored],[4,1,1,1,1,0,1,1]);
 assert.equal(m.overall.squaredError,0.25**2);
 const dnp=m.groups.player.find(x=>x.name==="DNP");
 assert.equal(dnp.voided,1);
 assert.equal(dnp.scored,0);
 assert.equal(dnp.losses,0);
 const ledgerStateText=html.slice(html.indexOf("function ledgerState(row)"),
   html.indexOf("function ledgerRef(",html.indexOf("function ledgerState(row)")));
 assert.match(ledgerStateText,/row\.status==='void'/);
 assert.match(ledgerStateText,/voidReason==='ESPN_EXPLICIT_DNP'/);
 assert.match(html,/\['DNP \/ no action',s\.voided/);
 assert.match(html,/state==='DNP \/ NO ACTION'\?'DNP · no action'/);
 assert.match(html,/data\.voided===true/);
 assert.match(html,/resultStat===null&&data\.resultWon===null/);
 assert.match(html,/Cloud refresh failed after the trusted server response/);
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
 const end=html.indexOf("// Update 35.0F4: trusted callable",start);
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
 const end=html.indexOf("// Update 35.0F4: trusted callable",begin);
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


// Update 35.0E: all offer and fixture values below are synthetic offline fixtures.
const {batchReviewSignature,batchReviewAssess}=(()=>{
 const a=html.indexOf("// Update 35.0E: pure, conservative pre-capture review");
 const b=html.indexOf("// Update 35.0E pure review END",a);
 assert.ok(a>0&&b>a,"35.0E pure review helpers exist");
 return new Function(html.slice(a,b)+"\nreturn {batchReviewSignature,batchReviewAssess};")();
})();
const reviewNow=Date.UTC(2026,10,11,20,0);
const reviewFixture={id:"401234567",start:reviewNow+90*60000,homeId:"11",awayId:"27",
 home:"Indiana Pacers",away:"Washington Wizards"};
const reviewDraft={
 key:"synthetic-1",player:"Example Player",team:"Indiana Pacers",
 market:"PTS",line:16.5,side:"Over",odds:1.82,
 eventId:reviewFixture.id,eventStartMs:reviewFixture.start
};
const reviewPreview={status:"ready",estimate:0.47,sample12:12,asOf:reviewNow-2*60000};
const reviewTeams={"Indiana Pacers":"11","Washington Wizards":"27"};
const quoteRecheck=(item,at=reviewNow-60000)=>({signature:batchReviewSignature(item),at});

test("35.0E review has no capture authorization, even after all local checks",()=>{
 const result=batchReviewAssess(reviewDraft,reviewPreview,reviewFixture,
  quoteRecheck(reviewDraft),reviewTeams,reviewNow,300000);
 assert.equal(result.research,true);
 assert.equal(result.fixtureValid,true);
 assert.equal(result.quoteValid,true);
 assert.equal(result.preparedForIndividual,true);
 assert.equal(result.needsIndividualResearch,true);
 assert.equal(result.captureAuthorized,false);
 assert.deepEqual(result.reasons,[]);
});

test("35.0E reviewer requires a verified matching future fixture, never just a staged ID",()=>{
 const mismatch={...reviewFixture,id:"999"};
 const wrongTeam={...reviewFixture,homeId:"2",awayId:"18"};
 const tooNear={...reviewFixture,start:reviewNow+200000};
 const cases=[null,mismatch,wrongTeam,tooNear];
 for(const fixture of cases){
  const actual=batchReviewAssess(reviewDraft,reviewPreview,fixture,
   quoteRecheck(reviewDraft),reviewTeams,reviewNow,300000);
  assert.equal(actual.fixtureValid,false);
  assert.equal(actual.preparedForIndividual,false);
  assert.ok(actual.reasons.some(x=>/fixture/.test(x)));
 }
});

test("35.0E quote recheck expires after five minutes and binds exact offer fields",()=>{
 const stale=quoteRecheck(reviewDraft,reviewNow-300001);
 assert.equal(batchReviewAssess(reviewDraft,reviewPreview,reviewFixture,stale,
  reviewTeams,reviewNow).quoteValid,false);
 const future=quoteRecheck(reviewDraft,reviewNow+1);
 assert.equal(batchReviewAssess(reviewDraft,reviewPreview,reviewFixture,future,
  reviewTeams,reviewNow).quoteValid,false);
 const changed={...reviewDraft,odds:1.85};
 assert.equal(batchReviewAssess(changed,reviewPreview,reviewFixture,
  quoteRecheck(reviewDraft),reviewTeams,reviewNow).quoteValid,false);
 assert.equal(batchReviewAssess(reviewDraft,reviewPreview,reviewFixture,
  quoteRecheck(reviewDraft,reviewNow-300000),reviewTeams,reviewNow).quoteValid,true);
 assert.notEqual(batchReviewSignature(reviewDraft),batchReviewSignature(changed));
});

test("35.0E incomplete and failed ESPN research never pass review",()=>{
 for(const preview of [null,
  {status:"insufficient",games:11},
  {status:"error",message:"Player identity mismatch"},
  {status:"ready",estimate:NaN,sample12:12,asOf:reviewNow},
  {status:"ready",estimate:0.7,sample12:11,asOf:reviewNow},
  {status:"ready",estimate:0.7,sample12:12,asOf:reviewNow+1}]){
  const result=batchReviewAssess(reviewDraft,preview,reviewFixture,
   quoteRecheck(reviewDraft),reviewTeams,reviewNow);
  assert.equal(result.research,false);
  assert.equal(result.captureAuthorized,false);
  assert.equal(result.preparedForIndividual,false);
  assert.ok(result.reasons.length>0);
 }
});

test("35.0E unlinked pasted drafts remain incomplete even with ESPN and quote review",()=>{
 const item={...reviewDraft,eventId:undefined,eventStartMs:undefined};
 const result=batchReviewAssess(item,reviewPreview,undefined,
  quoteRecheck(item),reviewTeams,reviewNow);
 assert.equal(result.quoteValid,true);
 assert.equal(result.research,true);
 assert.equal(result.fixtureValid,false);
 assert.equal(result.preparedForIndividual,false);
});

test("35.0E review UI uses safe DOM text, explicit quote recheck and local-only state",()=>{
 for(const id of ["batchCaptureReview","batchReviewSummary","batchReviewRows"])
  assert.equal([...html.matchAll(new RegExp('id="'+id+'"','g'))].length,1);
 const begin=html.indexOf("function batchReviewDraw(){");
 const end=html.indexOf("function batchReset(){",begin);
 assert.ok(begin>0&&end>begin);
 const block=html.slice(begin,end);
 assert.match(block,/batchReviewAssess\(/);
 assert.match(block,/batchQuoteRechecks\.set\(item.key/);
 assert.match(block,/confirm\('Confirm you just checked Betano/);
 assert.match(block,/batchSelectDraft\(item,i\)/);
 assert.match(block,/batchReviewSummary\.textContent/);
 assert.doesNotMatch(block,/innerHTML|insertAdjacentHTML/);
 assert.doesNotMatch(block,/httpsCallable|fetch\s*\(|getDocsFromServer|runTransaction|setDoc|setInterval/);
 assert.match(html,/No Firebase writes or independently verified bookmaker odds/);
});

test("35.0E invalidates local review on edits, replacement, removal and sign-out",()=>{
 const invalidate=html.slice(html.indexOf("function batchResearchInvalidate("),
  html.indexOf("function batchResearchReset(",html.indexOf("function batchResearchInvalidate(")));
 assert.match(invalidate,/batchQuoteRechecks\.clear\(\)/);
 assert.match(invalidate,/batchReviewDraw\(\)/);
 const reset=html.slice(html.indexOf("function batchResearchReset("),
  html.indexOf("function batchResearchDraw(",html.indexOf("function batchResearchReset(")));
 assert.match(reset,/batchQuoteRechecks\.clear\(\)/);
 const resetAll=html.slice(html.indexOf("function batchReset(){"),
  html.indexOf("function batchRender(){"));
 assert.match(resetAll,/batchResearchReset\(\)/);
 assert.match(html,/batchResearchInvalidate\('A draft price changed/);
 assert.match(html,/batchResearchInvalidate\('New pasted drafts prepared/);
 assert.match(html,/batchResearchInvalidate\('One draft removed/);
 assert.match(html,/batchResearchInvalidate\('A new local offer was added/);
});

test("35.0E prevents previously chosen fixtures from leaking into another player's capture",()=>{
 const a=html.indexOf("function batchSelectDraft(");
 const b=html.indexOf("function batchReset(){",a);
 const block=html.slice(a,b);
 assert.match(block,/if\(item\.eventId&&ledgerEvents\.has\(item\.eventId\)\)ledgerFixture\.value=item\.eventId/);
 assert.match(block,/else ledgerFixture\.value=''/);
 assert.match(block,/lrQuoteContext=null;lrLatestResearch=null;lrResults\.replaceChildren\(\)/);
 assert.match(block,/ledgerQuoteConfirmed\.checked=false/);
 const backend=html.slice(html.indexOf("ledgerSave.addEventListener('click'"),
  html.indexOf("// Update 35.0A:",html.indexOf("ledgerSave.addEventListener('click'")));
 assert.match(backend,/Date\.now\(\)-\(snap\?\.at\|\|0\)>5\*60000/);
 assert.match(backend,/confirmedObservedQuote:true/);
 assert.match(backend,/httpsCallable\(oddsFunctions,'ledgerCaptureProspective'\)/);
 assert.doesNotMatch(block,/httpsCallable|fetch\s*\(/);
});

test("35.0E batch preview retains as-of timestamp for conservative review",()=>{
 assert.match(html,/preview\.set\(item\.key,\{\.\.\.result,asOf:cutoff\}\)/);
 assert.match(html,/batchReviewDraw\(\)/);
 assert.match(html,/preparedForIndividual/);
 assert.match(html,/captureAuthorized:false/);
});


// Update 35.0F2: all inputs below are synthetic and never written to Firebase.
const {batchCaptureStage,batchCaptureAssess,batchCaptureSelectedPlan}=(()=>{
 const between=(a,b)=>{
  const i=html.indexOf(a),j=html.indexOf(b,i+a.length);
  assert.ok(i>=0&&j>i,'Missing approval helper '+a);
  return html.slice(i,j);
 };
 const source=[
  between("function lrValidateLine(","function lrNormalOver("),
  between("// Update 35.0E: pure, conservative","// Update 35.0E pure review END"),
  between("function batchCaptureStage(","// Update 35.0F2 pure selection END")
 ].join("\n");
 return new Function(source+"\nreturn {batchCaptureStage,batchCaptureAssess,batchCaptureSelectedPlan};")();
})();
const capNow=Date.UTC(2026,10,12,1,0),capFixture={
 id:"401234568",start:capNow+3600000,homeId:"11",awayId:"27"
},capDraft={
 key:"synthetic-secure",player:"Synthetic Athlete",team:"Indiana Pacers",
 market:"REB",line:5.5,side:"Under",odds:1.88,
 eventId:capFixture.id,eventStartMs:capFixture.start,
 espnAthleteId:"123456"
};
const capResearch={status:"ready",sample12:12,sample24:24,
 modelOver:.625456,overHits12:8,overHits24:16};
const capTeams={"Indiana Pacers":"11"};
const makeCapStage=(item=capDraft,fixture=capFixture,at=capNow-5000)=>
 batchCaptureStage(item,"123456",capResearch,fixture,capTeams,at,300000);
const makeCapQuote=(item=capDraft,at=capNow-1000)=>
 ({signature:batchReviewSignature(item),at});

test("35.0F2 stages exact unrounded Over model and raw Over counts even for an Under selection",()=>{
 const s=makeCapStage();
 assert.ok(s);
 assert.equal(s.at,capNow-5000);
 assert.equal(s.payload.modelOver,.625456);
 assert.equal(s.payload.hits12,8);
 assert.equal(s.payload.games12,12);
 assert.equal(s.payload.hits24,16);
 assert.equal(s.payload.games24,24);
 assert.equal(s.payload.side,"Under");
 assert.equal(s.payload.odds,1.88);
 assert.equal(s.payload.athleteId,"123456");
 assert.equal(s.payload.confirmedObservedQuote,true);
 assert.equal(s.payload.eventId,capFixture.id);
 assert.equal(s.payload.teamId,"11");
 assert.equal(s.payload.homeId,"11");
 assert.equal(s.payload.awayId,"27");
});

test("35.0F2 refuses bad team/fixture/athlete, near-tipoff or insufficient history in staging",()=>{
 assert.equal(batchCaptureStage(capDraft,"999",capResearch,capFixture,capTeams,capNow),null);
 assert.equal(makeCapStage({...capDraft,team:"New York Knicks"}),null);
 assert.equal(makeCapStage(capDraft,{...capFixture,id:"wrong"}),null);
 assert.equal(makeCapStage(capDraft,{...capFixture,start:capNow+30000}),null);
 assert.equal(batchCaptureStage(capDraft,"123456",
  {...capResearch,status:"insufficient"},capFixture,capTeams,capNow),null);
 assert.equal(batchCaptureStage(capDraft,"123456",
  {...capResearch,sample12:11},capFixture,capTeams,capNow),null);
 assert.equal(batchCaptureStage(capDraft,"123456",
  {...capResearch,modelOver:1.0},capFixture,capTeams,capNow),null);
 assert.equal(batchCaptureStage({...capDraft,odds:1}, "123456",
  capResearch,capFixture,capTeams,capNow),null);
});

test("35.0F2 only approves an exact fresh price and fresh independently refreshed ESPN capture evidence",()=>{
 const s=makeCapStage(),q=makeCapQuote();
 const good=batchCaptureAssess(capDraft,s,capFixture,q,capTeams,capNow);
 assert.equal(good.ready,true);
 assert.equal(good.quote,true);
 assert.equal(good.fresh,true);
 assert.equal(good.validFixture,true);
 assert.equal(good.bound,true);
 assert.deepEqual(good.reasons,[]);
 assert.equal(batchCaptureAssess(capDraft,null,capFixture,q,capTeams,capNow).ready,false);
 assert.equal(batchCaptureAssess(capDraft,s,capFixture,q,capTeams,capNow+300001).ready,false);
 assert.equal(batchCaptureAssess(capDraft,s,capFixture,
  makeCapQuote(capDraft,capNow-300001),capTeams,capNow).ready,false);
 assert.equal(batchCaptureAssess({...capDraft,odds:1.91},s,capFixture,q,capTeams,capNow).ready,false);
 assert.equal(batchCaptureAssess(capDraft,s,{...capFixture,start:capNow+5000},q,capTeams,capNow).ready,false);
 assert.equal(batchCaptureAssess({...capDraft,espnAthleteId:"777"},s,capFixture,q,capTeams,capNow).ready,false);
});

test("35.0F2 local selection never includes unapproved rows or expired approvals",()=>{
 const items=[capDraft,{...capDraft,key:"synthetic-second",
  player:"Synthetic Second",espnAthleteId:undefined}];
 const stage=makeCapStage();
 const stages=new Map([[capDraft.key,stage]]);
 const quotes=new Map([[capDraft.key,makeCapQuote()]]);
 const approvals=new Map([[capDraft.key,batchReviewSignature(capDraft)]]);
 const events=new Map([[capFixture.id,capFixture]]);
 let plan=batchCaptureSelectedPlan(items,approvals,stages,quotes,events,capTeams,capNow);
 assert.equal(plan.ready,true);
 assert.equal(plan.count,1);
 assert.equal(plan.items.length,1);
 assert.equal(plan.items[0].player,capDraft.player);
 assert.equal(plan.items[0].confirmedObservedQuote,true);
 plan=batchCaptureSelectedPlan(items,approvals,stages,quotes,events,capTeams,capNow+300001);
 assert.equal(plan.ready,false);
 assert.equal(plan.count,0);
 assert.ok(plan.problems.length>0);
});

test("35.0F2 selection rejects duplicated trusted document IDs across two approved drafts",()=>{
 const other={...capDraft,key:"second",player:"Duplicate Name"};
 const otherStage=batchCaptureStage(other,"123456",capResearch,capFixture,capTeams,capNow);
 const items=[capDraft,other];
 const approvals=new Map(items.map(x=>[x.key,batchReviewSignature(x)]));
 const stages=new Map([[capDraft.key,makeCapStage()],[other.key,otherStage]]);
 const quotes=new Map(items.map(x=>[x.key,makeCapQuote(x)]));
 const events=new Map([[capFixture.id,capFixture]]);
 const p=batchCaptureSelectedPlan(items,approvals,stages,quotes,events,capTeams,capNow);
 assert.equal(p.ready,false);
 assert.equal(p.count,1);
 assert.match(p.problems.join(" "),/duplicate prospective/);
});

test("35.0F2 research refresh remains manually triggered; only 35.0F4 submit can invoke batch backend",()=>{
 for(const id of ["batchCaptureVerify","batchCaptureVerifyStatus","batchCaptureDryRun",
 "batchCaptureSubmit","batchCaptureStatus"]){
  assert.equal([...html.matchAll(new RegExp('id="'+id+'"','g'))].length,1,id);
 }
 const begin=html.indexOf("// Update 35.0D: one explicitly triggered");
 const end=html.indexOf("// Update 34.3:",begin);
 const block=html.slice(begin,end);
 assert.match(block,/batchCaptureVerify\.addEventListener\('click',async/);
 assert.match(block,/batchExecuteResearch\(true\)/);
 assert.match(block,/readEspnIdentity\(/);
 assert.match(block,/batchCaptureStage\(item,player\.athlete\.id/);
 assert.match(block,/batchResearchMatchRoster/);
 assert.match(block,/auth\.currentUser\?\.uid===uid&&ledgerSession===session&&/);
 const research=block.slice(0,block.indexOf("// Update 35.0F4: trusted callable"));
 assert.doesNotMatch(research,/httpsCallable|setDoc|runTransaction|setInterval|oddsPapi[A-Z]/);
 assert.match(html,/const BATCH_CAPTURE_DEPLOYED=true/);
 assert.match(html,/batchCaptureSubmit\.addEventListener\('click'/);
 assert.match(html,/httpsCallable\(oddsFunctions,'ledgerBatchCaptureProspective'\)/);
 assert.match(html,/httpsCallable\(oddsFunctions,'ledgerCaptureProspective'\)/);
});

test("35.0F2 approvals are per-row, explicit and cleared by changes/signout",()=>{
 const begin=html.indexOf("function batchReviewDraw(){");
 const end=html.indexOf("function batchReset(){",begin);
 const block=html.slice(begin,end);
 assert.match(block,/tick\.addEventListener\('change'/);
 assert.match(block,/batchCaptureApprovals\.set\(item.key,batchReviewSignature\(item\)\)/);
 assert.match(block,/confirm\('Approve this specific genuine Betano observation/);
 assert.match(block,/batchCaptureApprovals\.delete\(item.key\)/);
 const invalid=html.slice(html.indexOf("function batchResearchInvalidate("),
  html.indexOf("function batchResearchDraw("));
 assert.match(invalid,/batchCaptureStages\.clear\(\)/);
 assert.match(invalid,/batchCaptureApprovals\.clear\(\)/);
 assert.match(html,/function batchReset\(\)[\s\S]*?batchResearchReset\(\)/);
 assert.match(html,/batchCaptureDryRun.addEventListener\('click'/);
 assert.match(html,/batchCaptureSelectedPlan\(batchOffers,batchCaptureApprovals/);
 assert.doesNotMatch(block,/innerHTML|insertAdjacentHTML/);
});

test("35.0F2 staged research and approval alone cannot write without final explicit Save",()=>{
 assert.match(html,/The trusted batch function is deployed/);
 assert.match(html,/Securely save approved observations/);
 assert.match(html,/batchCaptureSubmit\.disabled=!BATCH_CAPTURE_DEPLOYED/);
 assert.match(html,/BATCH_CAPTURE_DEPLOYED=true/);
 assert.match(html,/This checkbox only prepares approval/);
 assert.match(html,/batchCaptureSubmit\.addEventListener\('click'/);
});


// Update 35.0F3: responsive review presentation regression checks.
test("35.0F3 renders per-player review cards instead of a cramped seven-column table",()=>{
 const begin=html.indexOf("function batchReviewDraw(){");
 const end=html.indexOf("function batchSelectDraft(",begin);
 assert.ok(begin>0&&end>begin);
 const review=html.slice(begin,end);
 assert.match(review,/researchCreate\('article',null,'batch-review-card'\)/);
 assert.match(review,/researchCreate\('div',null,'batch-review-grid'\)/);
 assert.match(review,/researchCreate\('div',null,'batch-review-header'\)/);
 assert.match(review,/researchCreate\('div',null,'batch-review-footer'\)/);
 assert.match(review,/researchCreate\('div',null,'batch-review-approval'\)/);
 assert.match(review,/researchCreate\('h4',\(i\+1\)\+'\. '\+item\.player\)/);
 assert.match(review,/batchReviewRows\.append\(body\)/);
 assert.doesNotMatch(review,/researchCreate\('(?:table|thead|tbody|tr|th|td)'/);
 assert.doesNotMatch(review,/innerHTML|insertAdjacentHTML/);
});

test("35.0F3 review layout uses three desktop columns and readable responsive mobile cards",()=>{
 const styles=html.slice(html.indexOf("/* Update 35.0E/F3:"),
  html.indexOf("</style>",html.indexOf("/* Update 35.0E/F3:")));
 assert.match(styles,/\.batch-review-table\{display:grid;gap:12px/);
 assert.match(styles,/\.batch-review-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
 assert.match(styles,/@media\(max-width:850px\)\{\.batch-review-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(styles,/@media\(max-width:600px\)\{\.batch-review-grid\{grid-template-columns:minmax\(0,1fr\)/);
 assert.match(styles,/\.batch-review-approval\{flex:1 1 270px;min-width:0/);
 assert.match(styles,/\.batch-capture-approval label\{display:block;flex:1;min-width:0/);
 assert.doesNotMatch(styles,/\.batch-review-table table\{min-width:760px/);
 assert.doesNotMatch(styles,/\.batch-capture-approval label\{[^}]*overflow-wrap:anywhere/);
});

test("35.0F3 cards preserve explicit manual quote recheck and approval confirmation",()=>{
 const from=html.indexOf("function batchReviewDraw(){");
 const to=html.indexOf("function batchSelectDraft(",from);
 const review=html.slice(from,to);
 assert.match(review,/batchReviewAssess\(item,preview,fixture,recheck,ESPN_NBA_TEAM_IDS,now,LEDGER_GRACE\)/);
 assert.match(review,/batchCaptureAssess\(item,batchCaptureStages\.get\(item\.key\)/);
 assert.match(review,/confirm\('Confirm you just checked Betano/);
 assert.match(review,/batchQuoteRechecks\.set\(item\.key,\{signature:batchReviewSignature\(item\),at:Date\.now\(\)\}\)/);
 assert.match(review,/batchCaptureApprovals\.delete\(item\.key\)/);
 assert.match(review,/tick\.disabled=!eligibility\.ready/);
 assert.match(review,/confirm\('Approve this specific genuine Betano observation/);
 assert.match(review,/batchCaptureApprovals\.set\(item\.key,batchReviewSignature\(item\)\)/);
 assert.match(review,/tick\.id=approvalId/);
 assert.match(review,/description\.htmlFor=approvalId/);
 assert.match(review,/tick\.setAttribute\('aria-label','Approve '/);
 assert.match(review,/single\.addEventListener\('click',\(\)=>batchSelectDraft\(item,i\)\)/);
 assert.match(review,/timeZone:'Europe\/Lisbon',hour:'2-digit',minute:'2-digit',hour12:false/);
 assert.doesNotMatch(review,/httpsCallable|fetch\s*\(|setDoc|runTransaction|getDocsFromServer|setInterval/);
});

test("35.0F3 keeps original research and Android viewport untouched through batch integration",()=>{
 assert.match(html,/const BATCH_CAPTURE_DEPLOYED=true/);
 assert.match(html,/batchCaptureSubmit\.disabled=!BATCH_CAPTURE_DEPLOYED/);
 assert.match(html,/batchCaptureSubmit\.addEventListener\('click'/);
 assert.match(html,/function batchResearchDraw\(\)[\s\S]*?researchCreate\('table'\)/);
 assert.match(html,/batchResearchRun\.addEventListener\('click'/);
 assert.match(html,/batchCaptureVerify\.addEventListener\('click'/);
 assert.match(html,/httpsCallable\(oddsFunctions,'ledgerCaptureProspective'\)/);
 assert.match(html,/id="batchCaptureReview"/);
 assert.match(html,/id="batchReviewRows"/);
});


// Update 35.0F4: offline receipt/reconciliation tests with synthetic player IDs.
const {batchCaptureDocId,batchCaptureInterpret,batchCaptureMatchesCloud,batchCaptureReconcileResult}=(()=>{
 const a=html.indexOf("// Update 35.0F4: deterministic client receipts");
 const b=html.indexOf("// Update 35.0F4 pure receipt checks END",a);
 assert.ok(a>=0&&b>a);
 return new Function(html.slice(a,b)+
 "\nreturn {batchCaptureDocId,batchCaptureInterpret,batchCaptureMatchesCloud,batchCaptureReconcileResult};")();
})();
const exampleCapture={player:"Synthetic Person",team:"Indiana Pacers",
 athleteId:"123456",teamId:"11",eventId:"401234568",
 homeId:"11",awayId:"27",eventStartMs:Date.UTC(2026,10,12,2,0),
 market:"REB",line:5.5,side:"Under",odds:1.88,modelOver:.625456,
 hits12:8,games12:12,hits24:16,games24:24,confirmedObservedQuote:true};
const exampleRecordId="401234568_123456_REB_5p5_Under";
const exampleReceiptTime=Date.UTC(2026,10,12,1,0);

test("35.0F4 deterministic exact document ID is identical to backend ledgerDocId",()=>{
 assert.equal(batchCaptureDocId(exampleCapture),exampleRecordId);
 assert.match(html,/function batchCaptureDocId\(p\)/);
});
test("35.0F4 accepts a saved server receipt only with exact ID and safe timestamp",()=>{
 const data={total:1,results:[{index:0,status:"saved",recordId:exampleRecordId,
  serverCapturedMs:exampleReceiptTime}]};
 const result=batchCaptureInterpret(data,[exampleCapture]);
 assert.equal(result.length,1);
 assert.equal(result[0].status,"saved");
 assert.equal(result[0].recordId,exampleRecordId);
 assert.equal(result[0].serverCapturedMs,exampleReceiptTime);
 for(const bad of [
  {...data,results:[{...data.results[0],recordId:"wrong"}]},
  {...data,results:[{...data.results[0],serverCapturedMs:null}]},
  {...data,total:2},{total:1,results:[]},
  {total:1,results:[{...data.results[0],index:1}]}
 ]){
  const r=batchCaptureInterpret(bad,[exampleCapture]);
  assert.equal(r[0].status,"unconfirmed");
  assert.match(r[0].message,/ledger|receipt|response/i);
 }
});
test("35.0F4 distinguishes rejected, unconfirmed and never-attempted outcomes",()=>{
 const items=[0,1,2].map(i=>({...exampleCapture,athleteId:String(123456+i)}));
 const raw={total:3,results:[
  {index:0,status:"rejected",code:"already-exists",message:"PRIVATE ERROR DETAILS"},
  {index:1,status:"unconfirmed",code:"unavailable",message:"PRIVATE TOKEN"},
  {index:2,status:"not-attempted",code:"resource-exhausted",message:"PRIVATE PASSWORD"}]};
 const parsed=batchCaptureInterpret(raw,items);
 assert.deepEqual(parsed.map(x=>x.status),["rejected","unconfirmed","not-attempted"]);
 assert.ok(parsed.every((x,i)=>x.recordId===batchCaptureDocId(items[i])));
 assert.doesNotMatch(JSON.stringify(parsed),/PRIVATE|TOKEN|PASSWORD/);
 assert.match(parsed[0].message,/may already exist/);
 assert.match(parsed[2].message,/not started/);
});
test("35.0F4 never calls a response timeout or missing payload a confirmed rejection",()=>{
 for(const response of [null,undefined,{},[],{results:[{}],total:1}]){
  const parsed=batchCaptureInterpret(response,[exampleCapture]);
  assert.equal(parsed[0].status,"unconfirmed");
 }
});
test("35.0F4 strict cloud reconciliation checks every frozen field and server timestamp",()=>{
 const document={...exampleCapture,schemaVersion:2,status:"pending",
  source:"manual_betano_unverified",capturedVia:"trusted_firebase_callable",
  capturedServerAt:{toMillis:()=>exampleReceiptTime},
  clientCapturedMs:exampleReceiptTime};
 assert.equal(batchCaptureMatchesCloud(exampleCapture,document),true);
 assert.equal(batchCaptureMatchesCloud(exampleCapture,{...document,status:"settled"}),true);
 for(const field of ["player","team","athleteId","teamId","eventId","homeId",
 "awayId","market","line","side","odds","modelOver","hits12","games12","hits24","games24"]){
  const wrong={...document,[field]:"incorrect"};
  assert.equal(batchCaptureMatchesCloud(exampleCapture,wrong),false,field);
 }
 for(const wrong of [
  {...document,clientCapturedMs:exampleReceiptTime+1},
  {...document,eventStartMs:exampleCapture.eventStartMs+1},
  {...document,capturedVia:"browser"},
  {...document,status:"excluded"},
  {...document,capturedServerAt:null}
 ])assert.equal(batchCaptureMatchesCloud(exampleCapture,wrong),false);
});
test("35.0F4 cloud missing is never interpreted as permission to retry",()=>{
 const receipt=batchCaptureInterpret(null,[exampleCapture])[0];
 const missing=batchCaptureReconcileResult(receipt,false,null,exampleCapture);
 assert.equal(missing.status,"unconfirmed");
 assert.equal(missing.cloudStatus,"missing");
 assert.match(missing.cloudMessage,/Do not automatically retry/);
 const record={...exampleCapture,schemaVersion:2,status:"pending",
 source:"manual_betano_unverified",capturedVia:"trusted_firebase_callable",
 capturedServerAt:{toMillis:()=>exampleReceiptTime},clientCapturedMs:exampleReceiptTime};
 const verified=batchCaptureReconcileResult(receipt,true,record,exampleCapture);
 assert.equal(verified.cloudStatus,"verified");
 assert.equal(verified.serverCapturedMs,exampleReceiptTime);
 const mismatch=batchCaptureReconcileResult(receipt,true,{...record,odds:2.0},exampleCapture);
 assert.equal(mismatch.cloudStatus,"mismatch");
 assert.match(mismatch.cloudMessage,/Do not overwrite or retry/);
});
test("35.0F4 callable triggers only from final explicit Save with revalidation after confirmation",()=>{
 const start=html.indexOf("// Update 35.0F4: trusted callable requires deliberate");
 const end=html.indexOf("// Update 34.3:",start);
 assert.ok(start>0&&end>start);
 const src=html.slice(start,end);
 assert.match(src,/batchCaptureSubmit\.addEventListener\('click',async/);
 assert.match(src,/if\(!confirm\('SAVE '\+plan\.count/);
 assert.match(src,/const second=batchCaptureSelectedPlan/);
 assert.match(src,/if\(!second\.ready/);
 assert.match(src,/batchCaptureAttempt=\{uid,session,items/);
 assert.match(src,/batchCaptureBusy=true;ledgerBusy=true/);
 assert.match(src,/httpsCallable\(oddsFunctions,'ledgerBatchCaptureProspective'\)\(\{items\}\)/);
 assert.match(src,/batchCaptureAttempt\.results=batchCaptureInterpret\(data,items\)/);
 assert.match(src,/batchCaptureAttempt\.results=batchCaptureInterpret\(null,items\)/);
 assert.doesNotMatch(src,/setInterval|setDoc|runTransaction|oddsPapiMarketCatalogProbe/);
 const count=(html.match(/httpsCallable\(oddsFunctions,'ledgerBatchCaptureProspective'\)/g)||[]).length;
 assert.equal(count,1);
});
test("35.0F4 cloud receipt verification is manual, exact and read-only",()=>{
 const start=html.indexOf("batchCaptureReconcile.addEventListener('click'");
 const end=html.indexOf("// Update 34.3:",start);
 const src=html.slice(start,end);
 assert.ok(start>0&&end>start);
 assert.match(src,/if\(!confirm\('Read the exact '/);
 assert.match(src,/for\(let i=0;i<attempt\.items\.length;i\+\+\)/);
 assert.match(src,/getDocFromServer\(ledgerRef\(uid,id\)\)/);
 assert.match(src,/batchCaptureReconcileResult\(r,record\.exists\(\)/);
 assert.match(src,/cloudStatus:'read-error'/);
 assert.doesNotMatch(src,/httpsCallable|setDoc|deleteDoc|runTransaction|setInterval/);
 assert.match(html,/getDocsFromServer,getDocFromServer,onSnapshot/);
});
test("35.0F4 in-flight lock, signout clearing and current-session isolation",()=>{
 const begin=html.indexOf("batchCaptureSubmit.addEventListener('click'");
 const end=html.indexOf("// Update 34.3:",begin);
 const src=html.slice(begin,end);
 assert.match(src,/batchCaptureAttempt\|\|batchCaptureBusy/);
 assert.match(src,/auth\.currentUser\?\.uid===uid&&ledgerSession===session/);
 assert.match(src,/batchCaptureSubmit\.disabled=true/);
 assert.match(src,/batchCaptureReconcile\.disabled=true/);
 assert.match(src,/if\(!current\(\)\)return/);
 assert.match(html,/function batchReset\(\)\{[\s\S]*?batchCaptureAttempt=null;batchCaptureBusy=false/);
 assert.match(html,/function ledgerReset\(\)\{[\s\S]*?ledgerBusy=false;ledgerSave\.disabled=false/);
 assert.match(html,/Check exact cloud receipts first. Clearing now would discard/);
});
test("35.0F4 no automatic OddsPapi calls, no implicit Firebase write after refresh",()=>{
 const source=html.slice(html.indexOf("// Update 35.0F4: trusted callable"),html.indexOf("// Update 34.3:",html.indexOf("// Update 35.0F4: trusted callable")));
 assert.equal((source.match(/httpsCallable\(oddsFunctions,'ledgerBatchCaptureProspective'\)/g)||[]).length,1);
 assert.doesNotMatch(source,/reserveDiagnosticRequests|oddsPapiKey|setInterval/);
 assert.match(html,/BATCH_CAPTURE_DEPLOYED=true/);
 assert.match(html,/Capture blocked/);
 assert.match(html,/No automatic retry/);
 assert.match(html,/capturedServerAt/);
 assert.match(html,/batchCaptureSubmit\.disabled=!BATCH_CAPTURE_DEPLOYED/);
});

test("35.1A unmetered OddsPapi account preflight never triggers odds capture",()=>{
 assert.match(html,/id="oddsAccountCheckBtn"/);
 assert.match(html,/id="oddsAccountCheckStatus"/);
 const start=html.indexOf("// Update 35.1A: manual unmetered account-preflight");
 const end=html.indexOf("document.getElementById('detailedPropsBtn')",start);
 assert.ok(start>0&&end>start);
 const script=html.slice(start,end);
 assert.match(script,/oddsPapiAccountPreflight/);
 assert.match(script,/auth\.currentUser/);
 assert.match(script,/0 billable|unmetered/);
 assert.doesNotMatch(script,/ledgerBatchCaptureProspective|ledgerSave|\/v4\/odds|setInterval|runTransaction/);
 assert.match(script,/textContent=value/);
});
