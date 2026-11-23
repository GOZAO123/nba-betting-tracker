"use strict";

// Issue #97 D18 journal CAS regressions: no Cloud SDK is initialized here.
// Full concurrent Firestore/Auth emulator integration is appended to the
// existing one-quote-rehearsal.js harness.
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {makeOfflineFixtureReviewJournal}=
  require("./offline-fixtures-review-journal-firestore");

test("journal refuses non-Admin dependencies and malformed decisions",async()=>{
  assert.throws(()=>makeOfflineFixtureReviewJournal({}),TypeError);
  const db={
    doc(path){return {path};},getAll:async()=>[],
    async runTransaction(){throw Error("should never run");}
  };
  const journal=makeOfflineFixtureReviewJournal({db});
  assert.equal(await journal.appendDecision({
    fixtureId:"unsafe fixture",expectedRevision:0,packetDigest:"f".repeat(64),
    event:{}
  }),false);
  assert.equal(await journal.appendDecision({
    fixtureId:"synthetic-1",expectedRevision:0,packetDigest:"f".repeat(64),
    event:{action:"APPROVE",pairs:[]}
  }),false);
  await assert.rejects(journal.loadHistory("../unsafe"),/Invalid review fixture/);
});

test("review journal cannot be called through a production function or browser",()=>{
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const src=fs.readFileSync(path.join(__dirname,
    "offline-fixtures-review-journal-firestore.js"),"utf8");
  assert.doesNotMatch(index,
    /require\(["']\.\/offline-fixtures-review-journal-firestore["']\)/);
  assert.doesNotMatch(src,/onCall\(|onSchedule\(|setInterval\(|fetch\s*\(/);
  assert.doesNotMatch(src,/firebase-admin|firebase-functions|api\.oddspapi\.io/);
});
