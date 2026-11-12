"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
 MAX_BATCH_CAPTURE_ITEMS, MAX_BATCH_CAPTURE_EVENTS, MAX_BATCH_CAPTURE_TEAMS,
 EXPECTED_LOOKUPS_LIMIT, MAX_BATCH_CAPTURE_PROCESSING_MS,
 safeFailure, planBatchCapture, runBatchCapture
} = require("./batch-capture");

const good = (n = 1, override = {}) => ({
 player: "Example " + n, eventId: String(401000000 + n % 10),
 teamId: String(1 + n % 5), athleteId: String(10000 + n),
 market: "PTS", line: 16.5, side: "Over", odds: 1.82, ...override
});
const validate = x => {
 if (!x || !/^\d+$/.test(String(x.athleteId || "")) || !/^\d+$/.test(String(x.eventId || "")))
  throw Object.assign(new Error("Invalid ESPN identifiers."), { code: "invalid-argument" });
 return x;
};
const makeId = x => [x.eventId, x.athleteId, x.market,
 String(x.line).replace(".", "p"), x.side].join("_");
const save = async record => ({
 saved: true, recordId: makeId(record),
 serverCapturedMs: 1794500000000
});

test("Batch requires 1–20 observations and cannot look up ESPN on invalid top-level input", async () => {
 assert.equal(MAX_BATCH_CAPTURE_ITEMS, 20);
 for (const items of [undefined, null, [], {}, Array(21).fill(good())]) {
  let calls = 0;
  await assert.rejects(runBatchCapture({ items, validateCapture: validate,
   makeRecordId: makeId, captureOne: async () => {calls++; return save(good());} }));
  assert.equal(calls, 0);
 }
});

test("Plan deduplicates identical selections without silently replacing odds", () => {
 const items = [good(1), good(1, {odds:1.95}), good(2)];
 const p = planBatchCapture(items, validate, makeId);
 assert.equal(p.records.length,2);
 assert.deepEqual(p.records.map(x=>x.index),[0,2]);
 assert.equal(p.preliminary[1].status,"rejected");
 assert.equal(p.preliminary[1].code,"already-exists");
});

test("Valid rows proceed even when another row fails upfront local validation", async () => {
 const list = [good(1),good(2,{athleteId:"bad"}),good(3)];
 const calls=[];
 const result=await runBatchCapture({
  items:list,validateCapture:validate,makeRecordId:makeId,
  captureOne: async record=>{calls.push(record.athleteId);return save(record);}
 });
 assert.deepEqual(calls,[good(1).athleteId,good(3).athleteId]);
 assert.equal(result.total,3);
 assert.equal(result.saved,2);
 assert.equal(result.rejected,1);
 assert.deepEqual(result.results.map(x=>x.status),["saved","rejected","saved"]);
 assert.equal(result.results[1].code,"invalid-argument");
 assert.equal(result.results[2].recordId,makeId(good(3)));
});

test("No overlapping writes: batch entries run strictly sequentially", async () => {
 let current=0,maxInFlight=0,completed=0;
 const result=await runBatchCapture({
  items:[good(1),good(2),good(3)],validateCapture:validate,makeRecordId:makeId,
  captureOne: async record=>{
   current++;maxInFlight=Math.max(maxInFlight,current);
   await Promise.resolve();await Promise.resolve();
   current--;completed++;
   return save(record);
  }
 });
 assert.equal(maxInFlight,1);
 assert.equal(completed,3);
 assert.equal(result.saved,3);
});

test("Same per-invocation cache maps are passed to all records", async () => {
 const observed=[];
 await runBatchCapture({
  items:[good(1),good(2)],validateCapture:validate,makeRecordId:makeId,
  captureOne: async (record, cache)=>{
   observed.push(cache);
   cache.scoreboards.set(record.eventId,true);
   cache.rosters.set(record.teamId,true);
   return save(record);
  }
 });
 assert.equal(observed.length,2);
 assert.equal(observed[0],observed[1]);
 assert.equal(observed[1].scoreboards.size,2);
 assert.equal(observed[1].rosters.size,2);
});

test("ESPN and Firestore errors reject only their own row with no fabricated success", async () => {
 const result=await runBatchCapture({
  items:[good(1),good(2),good(3)],validateCapture:validate,makeRecordId:makeId,
  captureOne: async record=>{
   if(record.athleteId===good(2).athleteId)
    throw Object.assign(new Error("This selection already exists."),{code:"already-exists"});
   return save(record);
  }
 });
 assert.deepEqual(result.results.map(x=>x.status),["saved","rejected","saved"]);
 assert.equal(result.results[1].code,"already-exists");
 assert.equal(result.results[1].message,
  "This observation may already exist. Refresh the cloud ledger before retrying.");
 assert.equal(result.rejected,1);
});

test("Missing receipt is unconfirmed; never treat an uncertain Firestore write as a rejection", async () => {
 for (const receipt of [null, {}, {saved:true,recordId:"wrong",serverCapturedMs:123},
  {saved:true,recordId:makeId(good(1)),serverCapturedMs:null}]) {
  const res=await runBatchCapture({items:[good(1)],validateCapture:validate,
   makeRecordId:makeId,captureOne:async()=>receipt});
  assert.equal(res.saved,0);
  assert.equal(res.results[0].status,"unconfirmed");
  assert.equal(res.unconfirmed,1);
  assert.match(res.results[0].message,/cloud ledger/);
 }
});

test("Unknown exceptions cannot disclose internal details or credentials", async () => {
 const secret="Never show a secret token or private identifier";
 const r=await runBatchCapture({
  items:[good(1)],validateCapture:validate,makeRecordId:makeId,
  captureOne:async()=>{throw new Error(secret);}
 });
 assert.equal(r.saved,0);
 assert.equal(r.results[0].code,"unavailable");
 assert.equal(r.results[0].status,"unconfirmed");
 assert.equal(r.unconfirmed,1);
 assert.equal(r.rejected,0);
 assert.equal(r.requiresLedgerRefresh,true);
 assert.doesNotMatch(JSON.stringify(r),/Never show/);
 assert.deepEqual(safeFailure({code:"other",message:secret}).status,"rejected");
 assert.equal(safeFailure({code:"unavailable",message:secret},true).status,"unconfirmed");
});

test("Valid data above the unique game/team cap fails before ESPN or Firestore calls", async () => {
 assert.equal(MAX_BATCH_CAPTURE_EVENTS,12);
 assert.equal(MAX_BATCH_CAPTURE_TEAMS,12);
 assert.equal(EXPECTED_LOOKUPS_LIMIT,24);
 const items=Array.from({length:13},(_,i)=>good(i+1,{
  eventId:String(401000000+i),teamId:String(i+1)
 }));
 let called=0;
 await assert.rejects(runBatchCapture({
  items,validateCapture:validate,makeRecordId:makeId,
  captureOne:async()=>{called++;return null;}
 }),/safety cap/);
 assert.equal(called,0);
});

test("Twenty valid observations across 4 games and 5 teams have lookup ceiling 9", async () => {
 const items=Array.from({length:20},(_,i)=>good(i+1,{
  eventId:String(401000000+(i%4)),teamId:String((i%5)+1)
 }));
 const result=await runBatchCapture({items,validateCapture:validate,
  makeRecordId:makeId,captureOne:save});
 assert.equal(result.saved,20);
 assert.equal(result.total,20);
 assert.equal(result.lookupCeiling,9);
 assert.equal(result.results.filter(x=>Number.isSafeInteger(x.serverCapturedMs)).length,20);
});

test("Duplicate real-time transaction rejection remains a failure, not a second capture", async () => {
 const items=[good(1),good(2)];
 const res=await runBatchCapture({
  items,validateCapture:validate,makeRecordId:makeId,
  captureOne:async record=>{
   if(record.athleteId===good(1).athleteId)
    throw Object.assign(new Error("Already recorded."),{code:"already-exists"});
   return save(record);
  }
 });
 assert.equal(res.results[0].code,"already-exists");
 assert.equal(res.results[1].status,"saved");
});

test("Backend wiring preserves authenticated owner, exact ESPN checks and transactional single capture", () => {
 const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const start=index.indexOf("async function ledgerCaptureValidated(");
 const end=index.indexOf("function ledgerParseStat(",start);
 assert.ok(start>0&&end>start);
 const code=index.slice(start,end);
 assert.match(code,/ledgerVerifyFixture\(board, record\)/);
 assert.match(code,/ledgerVerifyRoster\(roster, record\)/);
 assert.match(code,/db\.runTransaction\(async tx =>/);
 assert.match(code,/if \(previous\.exists\) throw new HttpsError\("already-exists"/);
 assert.match(code,/Date\.now\(\) \+ LEDGER_CAPTURE_GRACE_MS >= record\.start/);
 assert.match(code,/Timestamp\.now\(\)/);
 assert.match(code,/tx\.create\(ref, \{/);
 assert.match(code,/capturedServerAt: captured/);
 assert.match(code,/clientCapturedMs: captured\.toMillis\(\)/);
 assert.match(code,/modelSelected: record\.side === "Over"/);
 assert.match(code,/schemaVersion: 2, status: "pending"/);
 assert.match(code,/ledgerAssertOwner\(request\)/);
 assert.match(code,/ledgerValidateCapture\(request\.data\)/);
 assert.match(code,/ledgerCaptureValidated\(request\.auth\.uid, record\)/);
 assert.match(code,/exports\.ledgerBatchCaptureProspective = onCall/);
 assert.match(code,/maxInstances: 1, concurrency: 1, timeoutSeconds: 300/);
 assert.match(code,/runBatchCapture\(\{/);
 assert.match(code,/validateCapture: ledgerValidateCapture/);
 assert.match(code,/ledgerCaptureValidated\(request\.auth\.uid, record, cache\)/);
 assert.doesNotMatch(code,/oddsPapiKey|reserveDiagnosticRequests|setInterval/);
});

test("Batch capture requires explicit final confirmation; ordinary research never invokes Firebase", () => {
 const frontend=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
 assert.match(frontend,/captureAuthorized:false/);
 assert.match(frontend,/batchReviewAssess/);
 assert.match(frontend,/batchCaptureSubmit\.addEventListener\('click',async/);
 assert.match(frontend,/if\(!confirm\('SAVE '\+plan\.count/);
 assert.match(frontend,/const second=batchCaptureSelectedPlan/);
 assert.match(frontend,/httpsCallable\(oddsFunctions,'ledgerBatchCaptureProspective'\)\(\{items\}\)/);
 assert.equal((frontend.match(/httpsCallable\(oddsFunctions,'ledgerBatchCaptureProspective'\)/g)||[]).length,1);
 const research=frontend.slice(frontend.indexOf("// Update 35.0D: one explicitly triggered"),
  frontend.indexOf("// Update 35.0F4: trusted callable"));
 assert.doesNotMatch(research,/httpsCallable|setDoc|runTransaction|setInterval/);
 assert.match(frontend,/httpsCallable\(oddsFunctions,'ledgerCaptureProspective'\)/);
 assert.match(frontend,/getDocFromServer\(ledgerRef\(uid,id\)\)/);
 const source=fs.readFileSync(path.join(__dirname,"batch-capture.js"),"utf8");
 assert.doesNotMatch(source,/oddsPapi|fetch\s*\(|setInterval|firebase-admin|getFirestore/gi);
});


// Offline integration tests exercise the actual trusted single/batch write helper
// with fake ESPN + transactional Firestore. No live Firebase access or API usage.
function makeCaptureHarness() {
 const source=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const begin=source.indexOf("async function ledgerGetCachedEspn(");
 const end=source.indexOf("exports.ledgerCaptureProspective = onCall(",begin);
 assert.ok(begin>0&&end>begin);
 const records=new Map(),calls=[],checks=[];
 class FakeHttpsError extends Error {
  constructor(code,message){super(message);this.code=code;}
 }
 const db={
  doc:path=>({path}),
  runTransaction:async callback=>{
   const created=[];
   const tx={
    get:async ref=>({exists:records.has(ref.path),data:()=>records.get(ref.path)}),
    create:(ref,data)=>{
     if(records.has(ref.path))throw new Error("Already exists.");
     created.push({path:ref.path,data});
    }
   };
   const result=await callback(tx);
   for(const row of created)records.set(row.path,row.data);
   return result;
  }
 };
 const capturedMs=Date.UTC(2026,10,12,1,0);
 const Timestamp={now:()=>({toMillis:()=>capturedMs})};
 const getEspn=async path=>{
  calls.push(path);
  if(path.startsWith("scoreboard?"))return {events:[{id:"401000001"}]};
  if(path.startsWith("teams/"))return {team:{id:"11"}};
  throw new Error("Unexpected path");
 };
 const fn=new Function(
  "ledgerNbaDay","ledgerGetEspn","ledgerVerifyFixture",
  "ledgerVerifyRoster","getFirestore","ledgerDocId","HttpsError",
  "Timestamp","LEDGER_CAPTURE_GRACE_MS",
  source.slice(begin,end)+"\nreturn ledgerCaptureValidated;"
 )(
  ()=> "20261112",getEspn,
  (board,r)=>{
   checks.push("event:"+r.eventId);
   if(!board.events.some(e=>e.id===r.eventId))
    throw new FakeHttpsError("failed-precondition","Event mismatch.");
   return {home:"Sample Home",away:"Sample Away"};
  },
  (roster,r)=>{
   checks.push("roster:"+r.athleteId);
   if(roster.team.id!==r.teamId)
    throw new FakeHttpsError("failed-precondition","Roster mismatch.");
  },
  ()=>db,makeId,FakeHttpsError,Timestamp,5*60000
 );
 return {fn,records,calls,checks,capturedMs};
}

test("Trusted capture writes exact frozen fields and separate server receipt", async()=>{
 const h=makeCaptureHarness(),r=good(1,{
  teamId:"11",start:Date.now()+3600000,
  homeId:"11",awayId:"27",hits12:6,games12:12,
  hits24:11,games24:24,modelOver:0.464,team:"Sample Home"
 });
 const result=await h.fn("test-account",r);
 assert.equal(result.saved,true);
 assert.equal(result.serverCapturedMs,h.capturedMs);
 assert.equal(result.recordId,makeId(r));
 assert.equal(h.records.size,1);
 const [path,entry]=[...h.records.entries()][0];
 assert.match(path,/users\/test-account\/propResearchLedger/);
 assert.equal(entry.status,"pending");
 assert.equal(entry.schemaVersion,2);
 assert.equal(entry.source,"manual_betano_unverified");
 assert.equal(entry.capturedVia,"trusted_firebase_callable");
 assert.equal(entry.odds,1.82);
 assert.equal(entry.modelOver,0.464);
 assert.equal(entry.modelSelected,0.464);
 assert.equal(entry.hits12,6);
 assert.equal(entry.games12,12);
 assert.equal(entry.capturedServerAt.toMillis(),h.capturedMs);
 assert.equal(entry.resultStat,null);
 assert.equal(entry.settledAt,null);
 assert.deepEqual(h.calls,["scoreboard?dates=20261112","teams/11/roster"]);
});

test("Under side stores complement of unvalidated over estimate; ESPN lookups deduplicated",async()=>{
 const h=makeCaptureHarness(),cache={scoreboards:new Map(),rosters:new Map()};
 const common={eventId:"401000001",teamId:"11",start:Date.now()+3600000,homeId:"11",awayId:"27",
  hits12:7,games12:12,hits24:null,games24:null,modelOver:0.41};
 const a=good(1,{...common,side:"Under"});
 const b=good(2,{...common,side:"Over"});
 await h.fn("test-account",a,cache);
 await h.fn("test-account",b,cache);
 assert.equal(h.records.size,2);
 assert.equal(h.calls.length,2);
 const entries=[...h.records.values()];
 assert.ok(entries.some(x=>Math.abs(x.modelSelected-0.59)<1e-12));
 assert.ok(entries.some(x=>x.modelSelected===0.41));
});

test("Trusted transaction rejects duplicate document and near-tipoff writes",async()=>{
 const h=makeCaptureHarness();
 const r=good(1,{teamId:"11",start:Date.now()+3600000,
  hits12:5,games12:12,modelOver:.5});
 await h.fn("test-account",r);
 await assert.rejects(h.fn("test-account",r),err=>err.code==="already-exists");
 assert.equal(h.records.size,1);
 const late={...good(2),teamId:"11",start:Date.now()+60000,
  hits12:5,games12:12,modelOver:.5};
 await assert.rejects(h.fn("test-account",late),err=>err.code==="failed-precondition");
 assert.equal(h.records.size,1);
});


test("Recognized Firebase error codes never echo arbitrary upstream text or secrets", async()=>{
 const secret="Sensitive /internal/path?auth=secret or Firebase private details";
 for(const code of ["already-exists","failed-precondition","invalid-argument",
  "unavailable","deadline-exceeded","resource-exhausted","permission-denied"]){
  const r=await runBatchCapture({items:[good(1)],validateCapture:validate,
   makeRecordId:makeId,
   captureOne:async()=>{
    throw Object.assign(new Error(secret),{code});
   }});
  assert.equal(r.results[0].code,code);
  assert.doesNotMatch(JSON.stringify(r),/Sensitive|secret|internal\/path/);
  assert.match(r.results[0].message,/ledger|authorized|Google|fields|check|limit|timed out/i);
  assert.equal(r.results[0].status,
   ["already-exists","failed-precondition","invalid-argument","permission-denied"].includes(code)?
   "rejected":"unconfirmed");
 }
});

test("A batch stops STARTING new records after its safe processing deadline",async()=>{
 assert.equal(MAX_BATCH_CAPTURE_PROCESSING_MS,210000);
 const items=[good(1),good(2),good(3),good(4)];
 let clock=1000,called=0;
 const r=await runBatchCapture({
  items,validateCapture:validate,makeRecordId:makeId,now:()=>clock,
  captureOne:async record=>{
   called++;
   if(called===1)clock+=200000; // second row may start
   else if(called===2)clock+=20000; // no further rows may start
   return save(record);
  }
 });
 assert.equal(called,2);
 assert.deepEqual(r.results.map(x=>x.status),
  ["saved","saved","not-attempted","not-attempted"]);
 assert.equal(r.saved,2);
 assert.equal(r.notAttempted,2);
 assert.equal(r.unconfirmed,0);
 assert.equal(r.rejected,0);
 assert.equal(r.requiresLedgerRefresh,true);
 assert.match(r.results[2].message,/BEFORE this row started/);
 assert.equal(r.results[2].recordId,undefined);
 assert.equal(r.results[3].serverCapturedMs,undefined);
});

test("Deadline is evaluated before the first write, and never fabricates results",async()=>{
 let clock=0,calls=0;
 const r=await runBatchCapture({
  items:[good(1),good(2)],validateCapture:validate,makeRecordId:makeId,
  now:()=>{clock+=MAX_BATCH_CAPTURE_PROCESSING_MS;return clock;},
  captureOne:async()=>{calls++;return save(good(1));}
 });
 assert.equal(calls,0);
 assert.deepEqual(r.results.map(x=>x.status),["not-attempted","not-attempted"]);
 assert.equal(r.saved,0);
 assert.equal(r.notAttempted,2);
 assert.equal(r.requiresLedgerRefresh,true);
});

test("Validated rejection, uncertain completed attempt and deadline are counted separately",async()=>{
 const items=[
  good(1,{athleteId:"bad"}),
  good(2),good(3),good(4)
 ];
 let clock=0,calls=0;
 const r=await runBatchCapture({
  items,validateCapture:validate,makeRecordId:makeId,now:()=>clock,
  captureOne:async record=>{
   calls++;
   if(calls===1){
    throw Object.assign(new Error("network credentials must not leak"),{code:"unavailable"});
   }
   clock=MAX_BATCH_CAPTURE_PROCESSING_MS;
   return save(record);
  }
 });
 assert.equal(calls,2);
 assert.deepEqual(r.results.map(x=>x.status),
  ["rejected","unconfirmed","saved","not-attempted"]);
 assert.equal(r.total,4);
 assert.equal(r.saved,1);
 assert.equal(r.rejected,1);
 assert.equal(r.unconfirmed,1);
 assert.equal(r.notAttempted,1);
 assert.equal(r.requiresLedgerRefresh,true);
 assert.doesNotMatch(JSON.stringify(r),/network credentials/);
});

test("Server wiring still bounds runtime under function timeout, with no new paid API call",()=>{
 const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const timeout=Number(/exports\.ledgerBatchCaptureProspective = onCall\([\s\S]*?timeoutSeconds:\s*(\d+)/.exec(index)?.[1]);
 assert.equal(timeout,300);
 assert.ok(MAX_BATCH_CAPTURE_PROCESSING_MS<=((timeout-60)*1000));
 const code=fs.readFileSync(path.join(__dirname,"batch-capture.js"),"utf8");
 assert.match(code,/const MAX_BATCH_CAPTURE_PROCESSING_MS = 210000/);
 assert.match(code,/status: "not-attempted"/);
 assert.match(code,/status: unconfirmed \? "unconfirmed" : "rejected"/);
 assert.match(code,/requiresLedgerRefresh: results\.some/);
 assert.doesNotMatch(code,/oddsPapiKey|reserveDiagnosticRequests|setInterval|fetch\(/);
});
