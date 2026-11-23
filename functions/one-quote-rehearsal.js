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
const {makeOneQuoteCallable} = require("./one-quote-callable");
const {HttpsError} = require("firebase-functions/v2/https");
const {getFirestore} = require("firebase-admin/firestore");
const {makeOfflineManualQuotePersistence} = require("./offline-manual-quote-persistence");
const {makeOfflineFixedOriginOddsPapiTransport} = require("./manual-odds-fixed-transport");
const {makeOfflinePlayerReceiptLink} = require("./offline-player-receipt-link");
const {NOW, OWNER, SCOPE, catalog, fixture} = require("./one-quote-rehearsal-fixtures");

const {
  makeOfflineOneQuoteApproval, makeOfflineLinkedQuoteCollector, provisionOfflineOneQuoteApproval
} = require("./offline-one-quote-approval");

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

  function manualRun({enabled = true, failQuoteWrite = false, corruptReadback = false, now = NOW} = {}) {
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

    const transportDependencies = {
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
    };
    const transport = makeOfflineFixedOriginOddsPapiTransport(transportDependencies);
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
    const options = {
      enabled, ownerUid: OWNER.auth.uid, trustedQuoteScope: SCOPE,
      now: () => now, reserve, db: custody, ...transport
    };
    const privateReads = [];
    const collectLinked = makeOfflineLinkedQuoteCollector({
      ...options,
      async readPrivateEvidence(path) {
        privateReads.push(path);
        const record = (await db.doc(path).get()).data();
        if (corruptReadback && record?.quote) record.quote.digest = "0".repeat(64);
        return record;
      }
    });
    return {trace, privateReads, collectLinked, reserve, transportDependencies, run: makeOfflineManualQuotePersistence(options)};
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
  const {approvalId: coldApprovalId} = await provisionOfflineOneQuoteApproval({
    db, ttlMs: 120_000, now: () => NOW
  });
  assert.match(coldApprovalId, /^[a-f0-9]{32}$/);
  const coldApproval = db.doc("_internal/oneQuoteCollection/approvals/" + coldApprovalId);
  const makeOperatorHandoff = (collector, enabled = "true", approvalId = coldApprovalId) =>
    makeOneQuoteCallable({
      HttpsError, ownerUid: OWNER.auth.uid, now: () => NOW + 60_000,
      getConfig: () => ({enabled, approvalId, scopeJson: JSON.stringify(SCOPE)}),
      getDb: () => db,
      async reserve(amount) {
        if (approvalId === coldApprovalId)
          assert.equal((await coldApproval.get()).data().claimedAtMs, NOW + 60_000);
        return collector.reserve(amount);
      },
      ...collector.transportDependencies
    });
  await assert.rejects(makeOperatorHandoff(cold, "")(OWNER), {code: "failed-precondition"});
  await assert.rejects(makeOperatorHandoff(cold)({data: {}}), {code: "unauthenticated"});
  await assert.rejects(makeOperatorHandoff(cold)({...OWNER, data: {approvalId: coldApprovalId}}),
    {code: "invalid-argument"});
  assert.equal((await coldApproval.get()).data().claimedAtMs, null);
  assert.deepEqual(cold.trace, []);
  assert.deepEqual(await makeOperatorHandoff(cold)(OWNER), {status: "LINKED_UNREVIEWED"});
  assert.deepEqual(cold.trace, freshTrace.filter(action => action !== "custody"));
  assert.equal((await budget.get()).data().reserved, 4);

  const replay = manualRun({now: NOW + 60_000});
  await assert.rejects(makeOperatorHandoff(replay)(OWNER), {code: "failed-precondition"});
  assert.deepEqual(replay.trace, []);
  assert.equal((await budget.get()).data().reserved, 4);
  assert.deepEqual((await receipts()).map(snapshot => snapshot.size), [2, 2]);

  // Fixture and quote are separate transactions. A synthetic quote failure leaves a fixture only.
  const partial = manualRun({now: NOW + 120_000, failQuoteWrite: true});
  assert.equal(await partial.collectLinked(OWNER), "UNLINKED");
  assert.deepEqual(partial.privateReads, []);
  assert.deepEqual(partial.trace, freshTrace);
  assert.deepEqual((await receipts()).map(snapshot => snapshot.size), [3, 2]);
  const exhausted = manualRun({now: NOW + 180_000});
  const {approvalId: exhaustedApprovalId} = await provisionOfflineOneQuoteApproval({
    db, ttlMs: 120_000, now: () => NOW
  });
  await assert.rejects(makeOperatorHandoff(exhausted, "true", exhaustedApprovalId)(OWNER),
    {code: "unavailable"});
  assert.deepEqual(exhausted.trace, ["budget"]);
  assert.equal((await budget.get()).data().reserved, 6);
  assert.deepEqual((await receipts()).map(snapshot => snapshot.size), [3, 2]);

  // Reset only the synthetic budget to exercise a stored quote with bad readback.
  await budget.set({utcDay: new Date(NOW).toISOString().slice(0, 10), reserved: 0});
  const mismatch = manualRun({now: NOW + 240_000, corruptReadback: true});
  assert.equal(await mismatch.collectLinked(OWNER), "UNLINKED");
  assert.equal(mismatch.privateReads.length, 1);
  assert.deepEqual((await receipts()).map(snapshot => snapshot.size), [4, 3]);
});

test("single-use approval gates the offline collector across instances", async t => {
  const app = initializeApp({projectId}, "approval-rehearsal");
  t.after(() => deleteApp(app));
  const db = getFirestore(app);
  const approvalId = "a".repeat(32);
  const approval = db.doc("_internal/oneQuoteCollection/approvals/" + approvalId);
  let calls = 0;
  const config = {
    enabled: true, ownerUid: OWNER.auth.uid, approvalId, db, now: () => NOW,
    async collect() {
      calls++;
      assert.equal((await approval.get()).data().claimedAtMs, NOW);
      return {privateReceipt: "synthetic-private-receipt"};
    }
  };
  const make = overrides => makeOfflineOneQuoteApproval({...config, ...overrides});
  await assert.rejects(make({enabled: false})(OWNER), {code: "failed-precondition"});
  await assert.rejects(make()({data: {}}), {code: "unauthenticated"});
  for (const auth of [
    {...OWNER.auth, uid: "synthetic-other"},
    {...OWNER.auth, token: {email_verified: false}}
  ]) await assert.rejects(make()({...OWNER, auth}), {code: "permission-denied"});
  await assert.rejects(make()({...OWNER, data: {enabled: true}}), {code: "invalid-argument"});
  await assert.rejects(make()(OWNER), {code: "failed-precondition"});
  await approval.set({issuedAtMs: NOW - 2000, expiresAtMs: NOW, claimedAtMs: null});
  await assert.rejects(make()(OWNER), {code: "failed-precondition"});
  assert.equal(calls, 0);

  await approval.set({issuedAtMs: NOW, expiresAtMs: NOW + 60_000, claimedAtMs: null});
  const outcomes = await Promise.allSettled([make()(OWNER), make()(OWNER)]);
  assert.equal(calls, 1);
  assert.deepEqual(outcomes.find(outcome => outcome.status === "fulfilled")?.value,
    {status: "ATTEMPT_COMPLETED"});
  assert.equal(outcomes.find(outcome => outcome.status === "rejected")?.reason.code,
    "failed-precondition");
  await assert.rejects(make()(OWNER), {code: "failed-precondition"});

  const failedApprovalId = "b".repeat(32);
  const provision = ttlMs => provisionOfflineOneQuoteApproval({
    db, ttlMs, now: () => NOW, generateId: () => failedApprovalId
  });
  for (const ttlMs of [0, 1.5, 900_001]) await assert.rejects(provision(ttlMs), TypeError);
  assert.deepEqual(await provision(60_000), {
    approvalId: failedApprovalId, expiresAtMs: NOW + 60_000
  });
  const failedApproval = db.doc("_internal/oneQuoteCollection/approvals/" + failedApprovalId);
  const failed = make({
    approvalId: failedApprovalId,
    async collect() { throw Error("synthetic private downstream failure"); }
  });
  await assert.rejects(failed(OWNER), {
    code: "unavailable", message: "Collection attempt did not complete."
  });
  assert.equal((await failedApproval.get()).data().claimedAtMs, NOW);
  await assert.rejects(provision(120_000), {code: 6}); // Firestore ALREADY_EXISTS
  assert.deepEqual((await failedApproval.get()).data(), {
    issuedAtMs: NOW, expiresAtMs: NOW + 60_000, claimedAtMs: NOW
  });
  await assert.rejects(failed(OWNER), {code: "failed-precondition"});
});


test("disconnected identity discovery single-use permit is atomic across instances", async t => {
  const {makeOfflineManualIdentityDiscovery} =
    require("./offline-manual-identity-discovery");
  const app=initializeApp({projectId},"offline-identity-discovery-rehearsal");
  t.after(()=>deleteApp(app));
  const db=getFirestore(app);
  const approvalId="c".repeat(32);
  const approval=db.doc("_internal/identityDiscovery/approvals/"+approvalId);
  const isolatedBudget=db.doc("_internal/identityDiscoveryRehearsalBudget");
  const utcDay=new Date(NOW).toISOString().slice(0,10);
  const capturedAt=new Date(NOW).toISOString();
  const discoveryFixtureId="synthetic-discovery-unique-fixture";
  let reservations=0,secretReads=0,providerCalls=0;

  await approval.create({
    issuedAtMs:NOW-1000,expiresAtMs:NOW+60000,claimedAtMs:null
  });
  assert.equal((await isolatedBudget.get()).exists,false);

  async function reserve(amount) {
    assert.equal(amount,1);
    assert.equal((await approval.get()).data().claimedAtMs,NOW);
    const remaining=await db.runTransaction(async tx=>{
      const old=(await tx.get(isolatedBudget)).data();
      const used=old?.utcDay===utcDay?old.reserved:0;
      if(used+amount>6)throw Error("synthetic exhausted budget");
      tx.set(isolatedBudget,{utcDay,reserved:used+amount,limit:6});
      return 6-used-amount;
    });
    reservations++;
    return {utcDay,remaining};
  }
  const factory=(overrides={})=>makeOfflineManualIdentityDiscovery({
    enabled:true,ownerUid:OWNER.auth.uid,approvalId,
    getDb:()=>db,reserve,now:()=>NOW,
    getApiKey(){
      assert.ok(reservations>=1,"secret only after a committed reservation");
      secretReads++;
      return "SYNTHETIC_IDENTITY_DISCOVERY_KEY";
    },
    async fetchImpl(target,options) {
      assert.equal(new URL(target).origin,"https://api.oddspapi.io");
      assert.equal(new URL(target).pathname,"/v4/odds-by-tournaments");
      assert.equal(new URL(target).searchParams.get("bookmaker"),"betano.pt");
      assert.equal(options.method,"GET");
      assert.equal(options.redirect,"error");
      providerCalls++;
      return Response.json([{...fixture(),fixtureId:discoveryFixtureId}]);
    },
    ...overrides
  });

  await assert.rejects(makeOfflineManualIdentityDiscovery()(OWNER),
    {code:"failed-precondition"});
  await assert.rejects(factory()({...OWNER,auth:{uid:"someone-else",
    token:{email_verified:true}}}),{code:"permission-denied"});
  await assert.rejects(factory()({...OWNER,data:{market:"PTS"}}),
    {code:"invalid-argument"});
  assert.equal((await approval.get()).data().claimedAtMs,null);
  assert.equal(reservations,0);
  assert.equal(providerCalls,0);

  // Separate cold factories model independent Cloud Function instances.
  const outcomes=await Promise.allSettled([factory()(OWNER),factory()(OWNER)]);
  const completed=outcomes.filter(o=>o.status==="fulfilled");
  const denied=outcomes.filter(o=>o.status==="rejected");
  assert.equal(completed.length,1);
  assert.deepEqual(completed[0].value,{status:"STORED_UNREVIEWED"});
  assert.equal(denied.length,1);
  assert.equal(denied[0].reason.code,"failed-precondition");
  assert.equal((await approval.get()).data().claimedAtMs,NOW);
  assert.equal((await isolatedBudget.get()).data().reserved,1);
  assert.deepEqual([reservations,secretReads,providerCalls],[1,1,1]);

  const evidence=await db.collection(fixtureCollection).get();
  const matching=evidence.docs.filter(doc=>{
    const value=doc.data();
    return value.capturedAt===capturedAt &&
      value.records?.some(row=>row.fixtureId===discoveryFixtureId);
  });
  assert.equal(matching.length,1);
  const value=matching[0].data();
  assert.equal(value.status,"UNREVIEWED_PROVIDER_EVIDENCE");
  assert.equal(value.acceptedFixtures,1);
  assert.deepEqual(value.records[0].participantIds,["5001","5002"]);
  assert.ok(!JSON.stringify(value).includes("SYNTHETIC_PRIVATE_KEY"));
  assert.ok(!JSON.stringify(value).includes("bookmakerOdds"));
  assert.ok(!JSON.stringify(completed[0].value).includes(discoveryFixtureId));

  // The client-facing Firestore rules must deny the stored private evidence.
  const signup=await fetch("http://"+authHost+
    "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({returnSecureToken:true})
  });
  assert.equal(signup.status,200);
  const {idToken}=await signup.json();
  const privateUrl="http://"+firestoreHost+"/v1/projects/"+projectId+
    "/databases/(default)/documents/"+matching[0].ref.path;
  const clientRead=await fetch(privateUrl,{headers:{
    Authorization:"Bearer "+idToken
  }});
  assert.equal(clientRead.status,403);
  await assert.rejects(factory()(OWNER),{code:"failed-precondition"});
  assert.deepEqual([reservations,secretReads,providerCalls],[1,1,1]);

  // A separate valid approval with denied quota is consumed without HTTP.
  const deniedId="d".repeat(32);
  const deniedApproval=db.doc("_internal/identityDiscovery/approvals/"+deniedId);
  await deniedApproval.create({
    issuedAtMs:NOW-1000,expiresAtMs:NOW+60000,claimedAtMs:null
  });
  const blocked=factory({
    approvalId:deniedId,
    async reserve(amount){
      assert.equal(amount,1);
      throw Object.assign(Error("synthetic quota reached"),
        {code:"resource-exhausted"});
    }
  });
  await assert.rejects(blocked(OWNER),{code:"resource-exhausted"});
  assert.equal((await deniedApproval.get()).data().claimedAtMs,NOW);
  await assert.rejects(blocked(OWNER),{code:"failed-precondition"});
  assert.deepEqual([reservations,secretReads,providerCalls],[1,1,1]);
});
