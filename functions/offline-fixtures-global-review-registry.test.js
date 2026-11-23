"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {makeOfflineGloballyGuardedReviewJournal}=
  require("./offline-fixtures-global-review-registry");

test("global journal requires Firestore transaction-capable Admin dependencies",()=>{
  assert.throws(()=>makeOfflineGloballyGuardedReviewJournal(),TypeError);
  assert.throws(()=>makeOfflineGloballyGuardedReviewJournal({
    db:{doc:()=>({}),runTransaction:async()=>{}}
  }),TypeError);
});

test("invalid review events cannot create global ID registry mutations",async()=>{
  let docs=0,transactions=0;
  const db={
    doc(p){docs++;return {path:p};},
    getAll:async()=>[],
    async runTransaction(){transactions++;throw Error("Unexpected transaction");}
  };
  const journal=makeOfflineGloballyGuardedReviewJournal({db});
  assert.equal(await journal.appendDecision({
    fixtureId:"bad fixture",expectedRevision:0,
    packetDigest:"a".repeat(64),event:{action:"APPROVE"}
  }),false);
  assert.equal(docs,0);
  assert.equal(transactions,0);
});

test("global registry remains disconnected from production and has no provider access",()=>{
  const source=fs.readFileSync(path.join(__dirname,
    "offline-fixtures-global-review-registry.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(index,
    /require\(["']\.\/offline-fixtures-global-review-registry["']\)/);
  assert.doesNotMatch(source,
    /onCall\s*\(|onSchedule\s*\(|getFirestore\s*\(|\bfetch\s*\(/);
  assert.doesNotMatch(source,/firebase-admin|firebase-functions|api\.oddspapi\.io/);
});
