"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {makeOfflineSourceBoundGloballyGuardedReviewJournal}=
  require("./offline-fixtures-atomic-source-review-journal");

test("source-and-global guarded journal requires Admin Firestore dependencies",()=>{
  assert.throws(()=>makeOfflineSourceBoundGloballyGuardedReviewJournal(),
    TypeError);
  assert.throws(()=>makeOfflineSourceBoundGloballyGuardedReviewJournal({
    db:{doc:()=>({}),runTransaction:async()=>{}}
  }),TypeError);
});

test("invalid source-bound review event cannot access Firestore",async()=>{
  let called=0;
  const db={
    doc(){called++;return {path:"unexpected"};},
    getAll:async()=>[],
    runTransaction(){called++;throw Error("invalid request must not transact");}
  };
  const journal=makeOfflineSourceBoundGloballyGuardedReviewJournal({db});
  assert.equal(await journal.appendDecision({
    fixtureId:"../unsafe",expectedRevision:0,packetDigest:"a".repeat(64),
    event:{action:"APPROVE"}
  }),false);
  assert.equal(called,0);
});

test("new source guard is disconnected from production runtime and network",()=>{
  const source=fs.readFileSync(path.join(__dirname,
    "offline-fixtures-atomic-source-review-journal.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(index,
    /require\(["']\.\/offline-fixtures-atomic-source-review-journal["']\)/);
  assert.doesNotMatch(source,
    /onCall\s*\(|onSchedule\s*\(|getFirestore\s*\(|\bfetch\s*\(/);
  assert.doesNotMatch(source,/firebase-admin|firebase-functions|api\.oddspapi\.io/);
});
