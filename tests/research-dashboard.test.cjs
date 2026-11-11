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
