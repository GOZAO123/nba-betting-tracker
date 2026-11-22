"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");

const projectId = "demo-nba-quote-rehearsal";
const firestoreHost = "127.0.0.1:8187";
const authHost = "127.0.0.1:9197";
assert.equal(process.env.GCLOUD_PROJECT, projectId);
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, firestoreHost);
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, authHost);

const {initializeApp, deleteApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const {makeOfflineManualQuotePersistence} = require("./offline-manual-quote-persistence");
const {makeOfflineFixedOriginOddsPapiTransport} = require("./manual-odds-fixed-transport");
const {makeOfflinePlayerReceiptLink} = require("./offline-player-receipt-link");
const {NOW, OWNER, SCOPE, catalog, fixture} = require("./one-quote-rehearsal-fixtures");

const budgetPath = "_internal/oddsPapiDailyDiagnosticBudget";
const fixtureCollection = "_internal/teamEvidence/providerSnapshots";
const quoteCollection = "_internal/quoteEvidence/providerObservations";

test("one-quote custody with Firestore and Auth emulators", async t => {
  const app = initializeApp({projectId});
  t.after(() => deleteApp(app));
  const db = getFirestore(app);
  const budget = db.doc(budgetPath);
  const receipts = () => Promise.all(
    [fixtureCollection, quoteCollection].map(path => db.collection(path).get()));
  assert.equal((await budget.get()).exists, false, "start with an empty emulator");
  assert.deepEqual((await receipts()).map(snapshot => snapshot.size), [0, 0]);

  function manualRun({enabled = true, failQuoteWrite = false, now = NOW} = {}) {
    const trace = [];
    const utcDay = new Date(now).toISOString().slice(0, 10);
    let committed;
    // Rehearsal adapter mirrors the pinned production budget transaction.
    // Loading the production functions entry point would initialize unrelated services.
    async function reserve(amount) {
      trace.push("budget");
      assert.ok(Number.isSafeInteger(amount) && amount >= 1 && amount <= 2);
      committed = await db.runTransaction(async tx => {
        const previous = (await tx.get(budget)).data();
        const reserved = previous?.utcDay === utcDay ? previous.reserved : 0;
        assert.ok(Number.isSafeInteger(reserved) && reserved >= 0);
        if (reserved + amount > 6) throw Error("REHEARSAL_QUOTA_EXHAUSTED");
        const next = reserved + amount;
        tx.set(budget, {utcDay, reserved: next, limit: 6,
          lastReservedAt: new Date(now).toISOString()});
        return next;
      }, {maxAttempts: 5});
    }

    const transport = makeOfflineFixedOriginOddsPapiTransport({
      getApiKey() {
        assert.ok(committed >= 2);
        trace.push("key");
        return "SYNTHETIC_REHEARSAL_KEY";
      },
      async fetchImpl(target) {
        const {origin, pathname} = new URL(target);
        assert.equal(origin, "https://api.oddspapi.io");
        trace.push(pathname);
        assert.equal((await budget.get()).data().reserved, committed);
        switch (pathname) {
          case "/v4/markets": return Response.json(catalog());
          case "/v4/odds-by-tournaments": return Response.json([fixture()]);
          default: assert.fail("unexpected synthetic transport endpoint");
        }
      }
    });
    const custody = {
      doc: path => db.doc(path),
      runTransaction(callback) {
        trace.push("custody");
        return db.runTransaction(tx => callback({
          get: ref => tx.get(ref),
          create(ref, data) {
            if (failQuoteWrite && ref.path.startsWith(quoteCollection + "/")) {
              throw Error("REHEARSAL_QUOTE_WRITE_FAILURE");
            }
            return tx.create(ref, data);
          }
        }));
      }
    };
    return {trace, run: makeOfflineManualQuotePersistence({
      enabled, ownerUid: OWNER.auth.uid, trustedQuoteScope: SCOPE,
      now: () => now, reserve, db: custody, ...transport
    })};
  }

  const disabled = manualRun({enabled: false});
  await assert.rejects(disabled.run(OWNER), {code: "failed-precondition"});
  assert.deepEqual(disabled.trace, []);
  const warm = manualRun();
  await assert.rejects(warm.run({data: {}}));
  await assert.rejects(warm.run({...OWNER, auth: {...OWNER.auth, uid: "synthetic-other"}}));
  assert.deepEqual(warm.trace, []);
  assert.equal((await budget.get()).exists, false);
  assert.deepEqual((await receipts()).map(snapshot => snapshot.size), [0, 0]);

  const results = await Promise.all([warm.run(OWNER), warm.run(OWNER)]);
  assert.equal(results[0].requestsUsedOnThisClick, 2);
  const cached = await warm.run(OWNER);
  assert.equal(cached.cached, true);
  assert.equal(cached.requestsUsedOnThisClick, 0);
  const freshTrace = ["budget", "key", "/v4/markets", "key",
    "/v4/odds-by-tournaments", "custody", "custody"];
  assert.deepEqual(warm.trace, freshTrace);
  const [fixtures, quotes] = await receipts();
  assert.deepEqual([fixtures.size, quotes.size], [1, 1]);
  const [fixtureDoc] = fixtures.docs;
  const [quoteDoc] = quotes.docs;
  const {fixtureId, marketId, providerPlayerId, sourceReference, digest} = quoteDoc.data().quote;
  const readerApp = initializeApp({projectId}, "trusted-rehearsal-reader");
  t.after(() => deleteApp(readerApp));
  const reader = getFirestore(readerApp);
  const reads = [];
  const token = Object.freeze({});
  const review = makeOfflinePlayerReceiptLink({
    now: () => NOW,
    isTrustedInternalReview: candidate => candidate === token,
    async readPrivateEvidence(path) {
      reads.push(path);
      return (await reader.doc(path).get()).data();
    }
  });
  const selection = {fixtureId, marketId, providerPlayerId, sourceReference};
  assert.equal(await review(selection, {}), null);
  assert.deepEqual(reads, []);
  const linked = await review(selection, token);
  assert.equal(linked?.status, "UNREVIEWED_RECEIPT_LINK_ONLY");
  assert.equal(linked.quoteDigest, digest);
  assert.equal(linked.fixtureDigest, fixtureDoc.data().records[0].digest);
  assert.deepEqual(reads, [quoteDoc.ref.path, fixtureDoc.ref.path]);
  for (const flag of ["captureAllowed", "bookmakerVerified", "espnPlayerVerified",
    "autoLineSelected"]) assert.equal(linked[flag], false);

  const signup = await fetch("http://" + authHost +
    "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({returnSecureToken: true})
  });
  assert.equal(signup.status, 200);
  const {idToken} = await signup.json();
  assert.ok(idToken);
  for (const path of [budgetPath, fixtureDoc.ref.path, quoteDoc.ref.path]) {
    const url = "http://" + firestoreHost + "/v1/projects/" + projectId +
      "/databases/(default)/documents/" + path;
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const response = await fetch(url, {method,
        headers: {Authorization: "Bearer " + idToken, "Content-Type": "application/json"},
        body: method === "PATCH" ? JSON.stringify({fields: {rehearsal: {booleanValue: true}}}) : undefined
      });
      assert.equal(response.status, 403, method + " denied by private-path rules");
      assert.equal((await response.json()).error.status, "PERMISSION_DENIED");
    }
  }

  // A new composition is cold even with existing receipts and a persistent budget.
  // A later synthetic capture can create another pair.
  const cold = manualRun({now: NOW + 60_000});
  assert.equal((await cold.run(OWNER)).requestsUsedOnThisClick, 2);
  assert.deepEqual(cold.trace, freshTrace);
  assert.deepEqual((await receipts()).map(snapshot => snapshot.size), [2, 2]);

  // Fixture and quote are separate transactions. A synthetic quote failure leaves a fixture only.
  const partial = manualRun({now: NOW + 120_000, failQuoteWrite: true});
  assert.equal((await partial.run(OWNER)).requestsUsedOnThisClick, 2);
  assert.deepEqual(partial.trace, freshTrace);
  assert.deepEqual((await receipts()).map(snapshot => snapshot.size), [3, 2]);
  const exhausted = manualRun({now: NOW + 180_000});
  await assert.rejects(exhausted.run(OWNER), /REHEARSAL_QUOTA_EXHAUSTED/);
  assert.deepEqual(exhausted.trace, ["budget"]);
  assert.equal((await budget.get()).data().reserved, 6);
  assert.deepEqual((await receipts()).map(snapshot => snapshot.size), [3, 2]);
});
