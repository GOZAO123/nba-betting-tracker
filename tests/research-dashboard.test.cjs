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
 assert.match(html,/ledgerRenderDashboard\(ledgerResults,ledgerDashboardMetrics\(ledgerRows,ledgerState\)\)/);
 assert.match(html,/orderBy\('clientCapturedMs','desc'\),limit\(50\)/);
 assert.match(html,/ledgerSettleProspective/);
 assert.match(html,/ledgerCaptureProspective/);
 assert.match(html,/width=800,initial-scale/);
});
