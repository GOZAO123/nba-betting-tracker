"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const begin="// Update 35.1D15.35 pure diagnostic summary BEGIN";
const end="// Update 35.1D15.35 pure diagnostic summary END";
const from=html.indexOf(begin),to=html.indexOf(end);
assert.ok(from>=0&&to>from,"Pure local summary helpers found in existing HTML");
const pure=html.slice(from+begin.length,to);
const h=new Function(pure+"\nreturn {oddsHistorySummaryFromPreview,oddsHistorySummaryValid,oddsHistoryRead,oddsHistorySave};")();
const KEY_A="nba-oddspapi-diagnostic-summary-v1-"+"a".repeat(64);
const KEY_B="nba-oddspapi-diagnostic-summary-v1-"+"b".repeat(64);
const NOW=Date.parse("2026-11-20T16:33:35.346Z");
const iso=minutes=>new Date(NOW+minutes*60000).toISOString();
const teams=[
 "Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets",
 "Chicago Bulls","Cleveland Cavaliers","Dallas Mavericks","Denver Nuggets",
 "Detroit Pistons","Golden State Warriors","Houston Rockets","Indiana Pacers",
 "LA Clippers","Los Angeles Lakers","Memphis Grizzlies","Miami Heat",
 "Milwaukee Bucks","Minnesota Timberwolves","New Orleans Pelicans",
 "New York Knicks","Oklahoma City Thunder","Orlando Magic",
 "Philadelphia 76ers","Phoenix Suns","Portland Trail Blazers",
 "Sacramento Kings","San Antonio Spurs","Toronto Raptors","Utah Jazz",
 "Washington Wizards"
];
function preview(overrides={}){
 return {
  fixture:"Atlanta Hawks vs Charlotte Hornets",
  fixtureId:"PRIVATE_FIXTURE_ID_NOT_FOR_STORAGE",
  startTime:iso(440),catalogueDefinitions:74475,
  verifiedFullGameMarketIds:248,marketCount:75,activeSelections:158,
  unavailableSelections:76,bookmakerPresent:true,bookmakerSuspended:false,
  requestsUsed:2,cached:false,
  marketCounts:[
   {family:"3PT",activeSelections:18},
   {family:"PTS",activeSelections:20},{family:"REB",activeSelections:20},
   {family:"AST",activeSelections:20},{family:"PA",activeSelections:20},
   {family:"PR",activeSelections:20},{family:"RA",activeSelections:20},
   {family:"PRA",activeSelections:20}
  ],
  samples:[{player:"PRIVATE_PLAYER_NAME",oddsPapiPlayerId:"PRIVATE_PLAYER_ID",
    price:1.88,line:22.5,selection:"Over",mainLine:false}],
  apiKey:"PRIVATE_API_KEY_SHOULD_NOT_PERSIST",
  ...overrides
 };
}
function summary(p=preview(),now=NOW){
 return h.oddsHistorySummaryFromPreview(p,now,teams);
}
function storage(){
 const map=new Map();
 return {
  map,
  getItem(k){return map.get(k)??null;},
  setItem(k,v){map.set(k,v);},
  removeItem(k){map.delete(k);}
 };
}
function rec(overrides={}){return {...summary(),...overrides};}

test("35.1D15.35 source summary derives fixed, sanitized fields from real screenshot-shaped counts",()=>{
 const x=summary();
 assert.ok(x);
 assert.equal(h.oddsHistorySummaryValid(x,NOW),true);
 assert.equal(x.status,"PROVIDER_PREVIEW_UNVERIFIED");
 assert.deepEqual([
  x.fixture,x.activeSelections,x.matchingMarketIds,
  x.verifiedMarketDefinitions,x.catalogueDefinitions,x.unavailableSelections
 ],["Atlanta Hawks vs Charlotte Hornets",158,75,248,74475,76]);
 assert.deepEqual(x.marketCounts.map(r=>r.activeSelections),[18,20,20,20,20,20,20,20]);
 assert.equal(x.observedAt,NOW);
 assert.equal(x.fixtureStart,iso(440));
 assert.equal(x.servedFromCache,false);
 assert.equal(x.requestsReported,2);
 const json=JSON.stringify(x);
 for(const forbidden of ["PRIVATE_PLAYER","PRIVATE_FIXTURE_ID","PRIVATE_API_KEY",
   "playerId","price","line","selection","samples","apiKey"])
  assert.equal(json.includes(forbidden),false,"Unexpected private source field: "+forbidden);
});

test("35.1D15.35 app history survives a simulated browser reload without another provider request",()=>{
 const mem=storage();
 assert.equal(h.oddsHistorySave(mem,KEY_A,summary(),NOW),true);
 const persisted=mem.getItem(KEY_A);
 assert.ok(typeof persisted==="string");
 const reloaded=new Function(pure+"\nreturn {oddsHistoryRead};")();
 const [item]=reloaded.oddsHistoryRead(mem,KEY_A,NOW+500);
 assert.equal(item.fixture,"Atlanta Hawks vs Charlotte Hornets");
 assert.equal(item.activeSelections,158);
 assert.equal(item.observedAt,NOW);
 assert.equal(mem.getItem(KEY_A),persisted);
});

test("35.1D15.35 browser history is keyed by opaque per-account digest",()=>{
 const mem=storage();
 assert.equal(h.oddsHistorySave(mem,KEY_A,summary(),NOW),true);
 assert.deepEqual(h.oddsHistoryRead(mem,KEY_B,NOW),[]);
 assert.equal(mem.map.size,1);
 assert.equal(h.oddsHistorySave(mem,"nba-oddspapi-diagnostic-summary-v1-RAW_UID",
   summary(),NOW),false);
 assert.deepEqual(h.oddsHistoryRead(mem,"INVALID",NOW),[]);
});

test("35.1D15.35 repeated previews retain last ten timestamp-sorted summaries only",()=>{
 const mem=storage();
 for(let i=0;i<15;i++){
  const n=NOW+i*1000;
  assert.equal(h.oddsHistorySave(mem,KEY_A,summary(preview(),n),n),true);
 }
 const data=h.oddsHistoryRead(mem,KEY_A,NOW+15000);
 assert.equal(data.length,10);
 assert.equal(data[0].observedAt,NOW+14000);
 assert.equal(data[9].observedAt,NOW+5000);
 assert.equal(mem.map.size,1);
});

test("35.1D15.35 same millisecond event never multiplies stored history",()=>{
 const mem=storage();
 const one=summary();
 assert.equal(h.oddsHistorySave(mem,KEY_A,one,NOW),true);
 assert.equal(h.oddsHistorySave(mem,KEY_A,one,NOW),true);
 assert.equal(h.oddsHistoryRead(mem,KEY_A,NOW).length,1);
});

test("35.1D15.35 historical summaries expire after 30 days, never become current odds",()=>{
 const mem=storage(),month=30*24*60*60*1000;
 h.oddsHistorySave(mem,KEY_A,summary(),NOW);
 assert.equal(h.oddsHistoryRead(mem,KEY_A,NOW+month-1).length,1);
 assert.equal(h.oddsHistoryRead(mem,KEY_A,NOW+month+1).length,0);
 assert.equal(h.oddsHistorySummaryValid(summary(),NOW+month+1),false);
});

test("35.1D15.35 source must identify two known, distinct NBA teams",()=>{
 for(const fixture of [
  "PRIVATE_PLAYER_NAME vs Charlotte Hornets",
  "Atlanta Hawks vs Atlanta Hawks","Unknown City vs Charlotte Hornets",
  "Atlanta Hawks vs <img src=x onerror=alert(1)>",
  "Atlanta Hawks | Charlotte Hornets","",
  "Atlanta Hawks vs Los Angeles Lakers and PRIVATE_PLAYER_NAME"
 ]){
  assert.equal(summary(preview({fixture})),null,fixture);
 }
 assert.equal(h.oddsHistorySummaryFromPreview(preview(),NOW,["Atlanta Hawks"]),null);
});

test("35.1D15.35 rejects suspended/unknown fixtures and expired game times",()=>{
 assert.equal(summary(preview({bookmakerPresent:false})),null);
 assert.equal(summary(preview({bookmakerSuspended:true})),null);
 assert.equal(summary(preview({startTime:iso(-1)})),null);
 assert.equal(summary(preview({startTime:iso(73*60)})),null);
 assert.equal(summary(preview({startTime:"invalid"})),null);
 assert.equal(summary(preview({marketCount:"75"})),null);
 assert.equal(summary(preview({activeSelections:-1})),null);
 assert.equal(summary(preview({catalogueDefinitions:Infinity})),null);
 assert.equal(summary(preview({unavailableSelections:NaN})),null);
});

test("35.1D15.35 market families and counts must be recognized, unique, bounded",()=>{
 const good=preview().marketCounts;
 assert.equal(summary(preview({marketCounts:[...good,{family:"PTS",activeSelections:1}]})),null);
 assert.equal(summary(preview({marketCounts:[{family:"UNKNOWN",activeSelections:3}]})),null);
 assert.equal(summary(preview({marketCounts:[{family:"PTS",activeSelections:1000001}]})),null);
 assert.equal(summary(preview({marketCounts:[{family:"PTS",activeSelections:159}]})),null);
 assert.equal(summary(preview({marketCounts:"private odds list"})),null);
});

test("35.1D15.35 rejects unexpected stored keys and wrong statuses/claims",()=>{
 for(const bad of [
  {status:"VERIFIED_BOOKMAKER_OFFER"},{captureAllowed:true},
  {odds:1.88},{samples:[{player:"PRIVATE"}]},
  {player:"PRIVATE"},{apiKey:"PRIVATE"},{marketCounts:[{family:"PTS",activeSelections:158,price:1.88}]},
  {marketCounts:[{family:"PTS",activeSelections:20},{family:"PTS",activeSelections:20}]},
  {fixture:"Atlanta Hawks<script>"},
  {observedAt:NOW+120000},{observedAt:NOW-31*24*3600000}
 ]){
  assert.equal(h.oddsHistorySummaryValid(rec(bad),NOW),false);
 }
});

test("35.1D15.35 safely ignores corrupted, oversized or throwing browser storage",()=>{
 const mem=storage();
 for(const invalid of ["{bad JSON","null","{}",JSON.stringify([rec({apiKey:"PRIVATE"})]),
   " ".repeat(16001),JSON.stringify(Array(101).fill(rec()))]){
  mem.setItem(KEY_A,invalid);
  assert.deepEqual(h.oddsHistoryRead(mem,KEY_A,NOW),[]);
 }
 const broken={
  getItem(){throw Error("storage blocked");},
  setItem(){throw Error("private mode blocked");}
 };
 assert.deepEqual(h.oddsHistoryRead(broken,KEY_A,NOW),[]);
 assert.equal(h.oddsHistorySave(broken,KEY_A,summary(),NOW),false);
});

test("35.1D15.35 cache metadata never represents a fresh upstream fetch",()=>{
 const x=summary(preview({cached:true,requestsUsed:0}));
 assert.equal(x.servedFromCache,true);
 assert.equal(x.requestsReported,0);
 assert.equal(x.status,"PROVIDER_PREVIEW_UNVERIFIED");
});

test("35.1D15.35 clear history control never touches quotas or provider transport",()=>{
 assert.match(html,/id="oddsDiagnosticHistoryClear"/);
 assert.match(html,/id="oddsDiagnosticHistoryEntries"/);
 assert.match(html,/id="oddsDiagnosticHistoryStatus"/);
 assert.match(html,/<details id="oddsDiagnosticHistory"/);
 assert.ok(html.indexOf('id="oddsDiagnosticHistory"')>
   html.indexOf('id="espnSendToAnalyzer"'),
   "Saved summaries must remain below the existing ESPN roster controls.");
 assert.match(html,/localStorage\.removeItem\(oddsHistoryKey\)/);
 assert.match(html,/Cle ar local history|Clear local history/);
 const begin=html.indexOf("const oddsHistoryStatus=document.getElementById(");
 const end=html.indexOf("document.getElementById('verifiedPropsBtn')?.addEventListener",begin);
 const local=html.slice(begin,end);
 assert.ok(begin>=0&&end>begin);
 assert.doesNotMatch(local,/httpsCallable|oddsPapiVerifiedPropsProbe|fetch\(|setInterval|runTransaction|setDoc|addDoc/);
 assert.match(local,/crypto\.subtle\.digest\('SHA-256',bytes\)/);
 assert.match(local,/if\(!account\?\.uid\)return/);
 assert.match(local,/auth\.currentUser\?\.uid!==account\.uid/);
 assert.match(local,/textContent=/);
 assert.match(local,/try\{if\(oddsHistoryKey\)summaries=oddsHistoryRead\(localStorage,oddsHistoryKey\)\}/);
 assert.doesNotMatch(local,/\.innerHTML\s*=/);
});

test("35.1D15.35 preview is saved only after the existing manual authenticated preview returns",()=>{
 const handlerStart=html.indexOf("document.getElementById('verifiedPropsBtn')?.addEventListener('click'");
 const handlerEnd=html.indexOf("document.getElementById('nbaOddsTestBtn')?.addEventListener",handlerStart);
 const handler=html.slice(handlerStart,handlerEnd);
 assert.ok(handlerStart>0&&handlerEnd>handlerStart);
 const confirmIndex=handler.indexOf("if(!confirm('Preview active full-game Betano PT player props?");
 const callableIndex=handler.indexOf("httpsCallable(oddsFunctions,'oddsPapiVerifiedPropsProbe')({})");
 const saveIndex=handler.indexOf("oddsHistorySave(localStorage,oddsHistoryKey,summary)");
 assert.ok(confirmIndex>=0&&callableIndex>confirmIndex&&saveIndex>callableIndex);
 assert.match(handler,/auth\.currentUser\?\.uid===oddsHistoryUser/);
 assert.match(handler,/try\{saved=oddsHistorySave\(localStorage,oddsHistoryKey,summary\)\}catch\(_\)\{\}/);
 assert.match(handler,/oddsHistorySummaryFromPreview\(data,Date\.now\(\),/);
 assert.doesNotMatch(handler,/setInterval|onSchedule|setTimeout/);
});

test("35.1D15.35 research preview keeps its short-lived price snapshot separate",()=>{
 assert.match(html,/const RESEARCH_STORAGE_KEY='nba-verified-market-preview-v33-7'/);
 assert.match(html,/const RESEARCH_TTL_MS=15\*60\*1000/);
 assert.match(html,/sessionStorage\.setItem\(RESEARCH_STORAGE_KEY,JSON\.stringify\(preview\)\)/);
 assert.doesNotMatch(pure,/samples:|price:|player:|oddsPapiPlayerId|apiKey|selection:/);
});

test("35.1D15.35 auth listener restores only local summary and uses Lisbon time",()=>{
 assert.match(html,/void oddsHistorySetAuthUser\(u\)/);
 assert.match(html,/timeZone:'Europe\/Lisbon'/);
 assert.match(html,/hour12:false/);
 assert.match(html,/No locally saved previews yet\. Existing screenshots are not automatically imported/);
});
