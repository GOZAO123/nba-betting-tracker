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


test("fixture-name discovery permit, quota and private receipt are atomic in emulators", async t => {
  const {makeOfflineManualFixturesCollector} =
    require("./offline-manual-fixtures-collector");
  const app=initializeApp({projectId},"fixtures-team-identity-rehearsal");
  t.after(()=>deleteApp(app));
  const db=getFirestore(app);
  const approvalId="e".repeat(32);
  const approval=db.doc("_internal/fixtureTeamDiscovery/approvals/"+approvalId);
  const budget=db.doc("_internal/fixtureTeamDiscoveryEmulatorBudget");
  const collection=db.collection("_internal/teamEvidence/fixtureTeamSnapshots");
  const utcDay=new Date(NOW).toISOString().slice(0,10);
  const syntheticFixtureId="synthetic-fixtures-team-map-unique";
  let reservations=0,credentialReads=0,providerCalls=0;
  await approval.create({
    issuedAtMs:NOW-1000,expiresAtMs:NOW+60000,claimedAtMs:null
  });
  assert.equal((await budget.get()).exists,false);
  assert.equal((await collection.get()).size,0);

  async function reserve(amount) {
    assert.equal(amount,1);
    assert.equal((await approval.get()).data().claimedAtMs,NOW);
    const remaining=await db.runTransaction(async tx=>{
      const old=(await tx.get(budget)).data();
      const reserved=old?.utcDay===utcDay ? old.reserved : 0;
      assert.ok(Number.isSafeInteger(reserved) && reserved>=0);
      if(reserved+amount>6)throw Error("synthetic quota exhausted");
      tx.set(budget,{utcDay,reserved:reserved+amount,limit:6});
      return 6-reserved-amount;
    },{maxAttempts:5});
    reservations++;
    return {utcDay,remaining};
  }
  const make=(overrides={})=>makeOfflineManualFixturesCollector({
    enabled:true,ownerUid:OWNER.auth.uid,approvalId,
    now:()=>NOW,getDb:()=>db,reserve,
    getApiKey() {
      assert.equal(reservations,1,"credential lookup requires committed reservation");
      credentialReads++;
      return "SYNTHETIC_FIXTURES_PROVIDER_KEY";
    },
    async fetchImpl(target,options) {
      const url=new URL(target);
      assert.equal(url.origin,"https://api.oddspapi.io");
      assert.equal(url.pathname,"/v4/fixtures");
      for(const [key,value] of Object.entries({
        sportId:"11",tournamentId:"132",statusId:"0",
        hasOdds:"true",bookmakers:"betano.pt",language:"en"
      }))assert.equal(url.searchParams.get(key),value);
      assert.equal(options.method,"GET");
      assert.equal(options.redirect,"error");
      assert.equal((await budget.get()).data().reserved,1);
      providerCalls++;
      return Response.json([{
        fixtureId:syntheticFixtureId,sportId:11,tournamentId:132,
        statusId:0,hasOdds:true,
        startTime:new Date(NOW+180*60000).toISOString(),
        updatedAt:new Date(NOW-60000).toISOString(),
        participant1Id:"5001",participant2Id:"5002",
        participant1Name:"Synthetic Los Angeles Lakers",
        participant2Name:"Synthetic Utah Jazz",
        privateApiKey:"SYNTHETIC_FIXTURES_RAW_SECRET",
        bookmakerOdds:{"betano.pt":{price:1.87}}
      }]);
    },
    ...overrides
  });

  await assert.rejects(makeOfflineManualFixturesCollector()(OWNER),
    {code:"failed-precondition"});
  await assert.rejects(make()({...OWNER,
    auth:{uid:"synthetic-intruder",token:{email_verified:true}}}),
  {code:"permission-denied"});
  await assert.rejects(make()({...OWNER,data:{fixtureId:syntheticFixtureId}}),
    {code:"invalid-argument"});
  assert.equal((await approval.get()).data().claimedAtMs,null);
  assert.deepEqual([reservations,credentialReads,providerCalls],[0,0,0]);

  // Two independent cold factories must not both claim or spend this permit.
  const results=await Promise.allSettled([make()(OWNER),make()(OWNER)]);
  const successful=results.filter(x=>x.status==="fulfilled");
  const denied=results.filter(x=>x.status==="rejected");
  assert.equal(successful.length,1);
  assert.deepEqual(successful[0].value,{status:"STORED_UNREVIEWED"});
  assert.equal(denied.length,1);
  assert.equal(denied[0].reason.code,"failed-precondition");
  assert.equal((await approval.get()).data().claimedAtMs,NOW);
  assert.deepEqual((await budget.get()).data(),{
    utcDay,reserved:1,limit:6
  });
  assert.deepEqual([reservations,credentialReads,providerCalls],[1,1,1]);

  const snapshot=await collection.get();
  assert.equal(snapshot.size,1);
  const document=snapshot.docs[0];
  const stored=document.data();
  assert.match(document.id,/^ODDSPAPI_FIXTURES_[A-F0-9]{32}$/);
  assert.equal(stored.source,"ODDSPAPI_V4_FIXTURES");
  assert.equal(stored.status,"UNREVIEWED_PROVIDER_TEAM_NAMES");
  assert.equal(stored.acceptedFixtures,1);
  assert.equal(stored.records[0].fixtureId,syntheticFixtureId);
  assert.deepEqual([
    stored.records[0].participant1Id,stored.records[0].participant2Id
  ],["5001","5002"]);
  assert.deepEqual([
    stored.records[0].participant1Name,stored.records[0].participant2Name
  ],["Synthetic Los Angeles Lakers","Synthetic Utah Jazz"]);
  assert.ok(!JSON.stringify(stored).includes("SYNTHETIC_FIXTURES_RAW_SECRET"));
  assert.ok(!JSON.stringify(stored).includes("bookmakerOdds"));
  assert.ok(!JSON.stringify(stored).includes("price"));
  assert.equal("espnEventId" in stored,false);
  assert.equal("reviewStatus" in stored,false);
  assert.ok(!JSON.stringify(successful[0].value).includes(syntheticFixtureId));

  // Client Auth cannot read or mutate the private Admin-only evidence.
  const signup=await fetch("http://"+authHost+
    "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({returnSecureToken:true})
  });
  assert.equal(signup.status,200);
  const {idToken}=await signup.json();
  const privateUrl="http://"+firestoreHost+"/v1/projects/"+projectId+
    "/databases/(default)/documents/"+document.ref.path;
  const headers={Authorization:"Bearer "+idToken};
  const deniedRead=await fetch(privateUrl,{headers});
  assert.equal(deniedRead.status,403);
  const deniedWrite=await fetch(privateUrl,{
    method:"PATCH",headers:{...headers,"Content-Type":"application/json"},
    body:JSON.stringify({fields:{status:{stringValue:"APPROVED"}}})
  });
  assert.equal(deniedWrite.status,403);
  assert.equal((await document.ref.get()).data().status,
    "UNREVIEWED_PROVIDER_TEAM_NAMES");

  await assert.rejects(make()(OWNER),{code:"failed-precondition"});
  assert.deepEqual([reservations,credentialReads,providerCalls],[1,1,1]);
  assert.equal((await collection.get()).size,1);

  // A distinct permit can be consumed on quota failure, never reading a key.
  const quotaId="f".repeat(32);
  const quotaApproval=db.doc("_internal/fixtureTeamDiscovery/approvals/"+quotaId);
  await quotaApproval.create({
    issuedAtMs:NOW-1000,expiresAtMs:NOW+60000,claimedAtMs:null
  });
  const blocked=make({
    approvalId:quotaId,
    async reserve(amount) {
      assert.equal(amount,1);
      throw Object.assign(Error("synthetic budget exhausted"),
        {code:"resource-exhausted"});
    }
  });
  await assert.rejects(blocked(OWNER),{code:"resource-exhausted"});
  assert.equal((await quotaApproval.get()).data().claimedAtMs,NOW);
  await assert.rejects(blocked(OWNER),{code:"failed-precondition"});
  assert.deepEqual([reservations,credentialReads,providerCalls],[1,1,1]);
});


test("D18 manual source-aware review journal is atomic and private in emulators",async t=>{
  const {extractOfflineFixtureTeamEvidence}=
    require("./offline-fixture-team-evidence");
  const {makeOfflineFixturesTeamReviewGate}=
    require("./offline-fixtures-team-review-gate");
  const {makeOfflineFixtureReviewJournal}=
    require("./offline-fixtures-review-journal-firestore");
  const {getReviewedTeamBridge}=require("./offer-team-crosswalk");
  const app=initializeApp({projectId},"offline-team-review-journal-rehearsal");
  t.after(()=>deleteApp(app));
  const db=getFirestore(app);
  const fixtureId="synthetic-d18-journal-001";
  const journalRef=db.doc("_internal/teamReview/fixtureJournals/"+fixtureId);
  const eventCollection=journalRef.collection("events");
  const toIso=delta=>new Date(NOW+delta).toISOString();
  const providerReceipt=extractOfflineFixtureTeamEvidence([{
    fixtureId,sportId:11,tournamentId:132,statusId:0,hasOdds:true,
    startTime:toIso(180*60000),updatedAt:toIso(-120000),
    participant1Id:"5001",participant2Id:"5002",
    participant1Name:"Synthetic Lakers",
    participant2Name:"Synthetic Utah Jazz",
    bookmakerOdds:{"betano.pt":{price:1.85}},
    privateToken:"SYNTHETIC_NEVER_STORE_SECRET"
  }],{
    reference:"ODDSPAPI_FIXTURES_"+"B".repeat(32),
    capturedAt:toIso(-60000)
  },NOW);
  assert.ok(providerReceipt);
  const evidence={
    providerReceipt,
    espnScoreboard:{events:[{
      id:"401123456",date:toIso(180*60000),season:{type:2},
      status:{type:{state:"pre"}},competitions:[{competitors:[
        {homeAway:"home",team:{id:"13",displayName:"Synthetic Utah Jazz"}},
        {homeAway:"away",team:{id:"14",displayName:"Synthetic Los Angeles Lakers"}}
      ]}]
    }]},
    espnMetadata:{
      reference:"ESPN_SERVER_OBS_001",capturedAt:toIso(-30000)
    }
  };
  const pairs=[
    {providerParticipantId:"5001",espnTeamId:"14"},
    {providerParticipantId:"5002",espnTeamId:"13"}
  ];
  const query={
    fixtureId,participant1Id:"5001",participant2Id:"5002",
    startTime:toIso(180*60000)
  };
  let tick=NOW,loads=0;
  const journal=makeOfflineFixtureReviewJournal({db});
  const make=()=>makeOfflineFixturesTeamReviewGate({
    async authorize(auth) {
      return auth===OWNER ?
        {allowed:true,reviewerReference:"OWNER_REVIEW_01"} :
        {allowed:false,reviewerReference:"UNKNOWN"};
    },
    async loadEvidence(requestedId) {
      assert.equal(requestedId,fixtureId);
      loads++;
      return structuredClone(evidence);
    },
    loadHistory:journal.loadHistory,
    appendDecision:journal.appendDecision,
    now:()=>tick
  });
  const gate1=make(),gate2=make();
  const approve=gate=>gate.submit(OWNER,{
    fixtureId,action:"APPROVE",expectedRevision:0,pairs
  });
  assert.equal((await journalRef.get()).exists,false);
  assert.equal((await eventCollection.get()).size,0);
  assert.equal(await gate1.resolve(query),null);
  const loadsBeforeAuth=loads;
  assert.deepEqual(await gate1.submit({auth:{uid:"someone-else"}},{
    fixtureId,action:"APPROVE",expectedRevision:0,pairs
  }),{status:"DENIED"});
  assert.equal(loads,loadsBeforeAuth);
  assert.equal((await journalRef.get()).exists,false);

  // Independently constructed gates race through real Admin Firestore
  // transactions. Both may see revision 0, but only one can commit.
  const outcomes=await Promise.all([approve(gate1),approve(gate2)]);
  assert.equal(outcomes.filter(x=>x.status==="APPROVED").length,1);
  assert.equal(outcomes.filter(x=>x.status==="REVISION_CONFLICT").length,1);
  const head=(await journalRef.get()).data();
  assert.equal(head.schemaVersion,1);
  assert.equal(head.revision,1);
  assert.equal(head.lastAction,"APPROVE");
  assert.equal((await eventCollection.get()).size,1);
  assert.deepEqual((await journal.loadHistory(fixtureId))[0].pairs,pairs);
  assert.deepEqual((await gate1.resolve(query)).teamBridge,pairs);
  assert.equal(getReviewedTeamBridge(query),null,
    "production reviewed team manifest must remain empty");

  assert.deepEqual(await approve(gate2),{status:"REVISION_CONFLICT"});
  assert.equal((await eventCollection.get()).size,1);
  tick+=1000;
  const revoke=()=>gate1.submit(OWNER,{
    fixtureId,action:"REVOKE",expectedRevision:1
  });
  assert.deepEqual(await revoke(),{status:"REVOKED",revision:2});
  assert.equal((await journalRef.get()).data().revision,2);
  assert.equal((await eventCollection.get()).size,2);
  assert.equal((await gate1.resolve(query)),null);
  assert.deepEqual(await revoke(),{status:"REVISION_CONFLICT"});
  assert.deepEqual(await approve(gate1),{status:"REVISION_CONFLICT"});

  // Auth-emulator browser users cannot read or mutate Admin-only journal
  // head OR immutable event documents. Explicitly test both documents.
  const signup=await fetch("http://"+authHost+
    "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({returnSecureToken:true})
  });
  assert.equal(signup.status,200);
  const {idToken}=await signup.json();
  const headers={Authorization:"Bearer "+idToken};
  const paths=[journalRef.path,eventCollection.doc("000001").path];
  for(const privatePath of paths) {
    const url="http://"+firestoreHost+"/v1/projects/"+projectId+
      "/databases/(default)/documents/"+privatePath;
    assert.equal((await fetch(url,{headers})).status,403);
    assert.equal((await fetch(url,{
      method:"PATCH",headers:{...headers,"Content-Type":"application/json"},
      body:JSON.stringify({fields:{reviewStatus:{stringValue:"APPROVED"}}})
    })).status,403);
  }
  const records=await journal.loadHistory(fixtureId);
  assert.equal(records.length,2);
  assert.deepEqual(records.map(x=>x.action),["APPROVE","REVOKE"]);
  assert.ok(!JSON.stringify(records).includes("SYNTHETIC_NEVER_STORE_SECRET"));
  assert.ok(!JSON.stringify(records).includes("bookmakerOdds"));

  // Simulate an administrator tampering with an immutable historical
  // event: readback and the gate must refuse to authorize that journal.
  await eventCollection.doc("000001").update({eventDigest:"0".repeat(64)});
  await assert.rejects(journal.loadHistory(fixtureId),/Invalid review event/);
  assert.equal(await gate1.resolve(query),null);
});
