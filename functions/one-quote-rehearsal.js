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


test("D18 different-fixture global team-ID claims are atomic in emulators",async t=>{
  const {extractOfflineFixtureTeamEvidence}=
    require("./offline-fixture-team-evidence");
  const {makeOfflineFixturesTeamReviewGate}=
    require("./offline-fixtures-team-review-gate");
  const {makeOfflineGloballyGuardedReviewJournal}=
    require("./offline-fixtures-global-review-registry");
  const app=initializeApp({projectId},"offline-global-id-write-race");
  t.after(()=>deleteApp(app));
  const db=getFirestore(app);
  const iso=ms=>new Date(NOW+ms).toISOString();
  const oneMinute=60000;
  const fmt={A:"A",B:"B",C:"C",D:"D"};
  function source(letter,providerIds,espnIds) {
    const fixtureId="synthetic-write-registry-"+letter;
    const startTime=iso(180*oneMinute);
    const receipt=extractOfflineFixtureTeamEvidence([{
      fixtureId,sportId:11,tournamentId:132,statusId:0,hasOdds:true,
      startTime,updatedAt:iso(-2*oneMinute),
      participant1Id:providerIds[0],participant2Id:providerIds[1],
      participant1Name:"Synthetic Provider "+providerIds[0],
      participant2Name:"Synthetic Provider "+providerIds[1],
      rawOdds:{"betano.pt":{PTS:{price:1.85}}},
      secret:"DO_NOT_COPY_SECRET"
    }],{
      reference:"ODDSPAPI_FIXTURES_"+fmt[letter].repeat(32),
      capturedAt:iso(-oneMinute)
    },NOW);
    assert.ok(receipt);
    return {
      fixtureId,providerIds,espnIds,startTime,
      providerReceipt:receipt,
      espnScoreboard:{events:[{
        id:{"A":"401987651","B":"401987652","C":"401987653","D":"401987654"}[letter],
        date:startTime,status:{type:{state:"pre"}},
        season:{type:2},competitions:[{competitors:[
          {homeAway:"home",team:{
            id:espnIds[0],displayName:"Synthetic ESPN "+espnIds[0]
          }},
          {homeAway:"away",team:{
            id:espnIds[1],displayName:"Synthetic ESPN "+espnIds[1]
          }}
        ]}]
      }]},
      espnMetadata:{
        reference:"ESPN_WRITE_"+letter+"_REVIEW",
        capturedAt:iso(-30000)
      }
    };
  }
  const a=source("A",["5001","5002"],["14","13"]);
  const b=source("B",["5001","5003"],["16","15"]);
  let tick=NOW;
  const guarded=makeOfflineGloballyGuardedReviewJournal({db});
  function buildGate(entry) {
    return makeOfflineFixturesTeamReviewGate({
      authorize:async auth=>auth===OWNER ?
        {allowed:true,reviewerReference:"OWNER_REVIEW_01"} :
        {allowed:false,reviewerReference:"UNKNOWN"},
      async loadEvidence(id){
        assert.equal(id,entry.fixtureId);
        return {
          providerReceipt:entry.providerReceipt,
          espnScoreboard:entry.espnScoreboard,
          espnMetadata:entry.espnMetadata
        };
      },
      loadHistory:guarded.loadHistory,
      appendDecision:guarded.appendDecision,
      now:()=>tick
    });
  }
  const gateA=buildGate(a),gateB=buildGate(b);
  const pairs=entry=>[
    {providerParticipantId:entry.providerIds[0],
      espnTeamId:entry.espnIds[0]},
    {providerParticipantId:entry.providerIds[1],
      espnTeamId:entry.espnIds[1]}
  ];
  const approve=(gate,entry)=>gate.submit(OWNER,{
    fixtureId:entry.fixtureId,action:"APPROVE",
    expectedRevision:0,pairs:pairs(entry)
  });
  const revoke=(gate,entry)=>gate.submit(OWNER,{
    fixtureId:entry.fixtureId,action:"REVOKE",expectedRevision:1
  });
  const query=entry=>({
    fixtureId:entry.fixtureId,
    participant1Id:entry.providerIds[0],
    participant2Id:entry.providerIds[1],
    startTime:entry.startTime
  });
  const providerDoc=db.doc("_internal/teamReview/globalProviderIds/5001");
  const registryEspn=id=>db.doc("_internal/teamReview/globalEspnIds/"+id);
  assert.equal((await providerDoc.get()).exists,false);

  // Both approvals have different fixture heads but SHARE provider ID 5001.
  // One must win the single global registry transaction; never both.
  const outcomes=await Promise.all([approve(gateA,a),approve(gateB,b)]);
  assert.equal(outcomes.filter(x=>x.status==="APPROVED").length,1);
  assert.equal(outcomes.filter(x=>x.status==="REVISION_CONFLICT").length,1);
  const winnerIndex=outcomes.findIndex(x=>x.status==="APPROVED");
  const winner=winnerIndex===0?a:b;
  const loser=winnerIndex===0?b:a;
  const winnerGate=winnerIndex===0?gateA:gateB;
  const loserGate=winnerIndex===0?gateB:gateA;
  const registered=(await providerDoc.get()).data();
  assert.equal(registered.schemaVersion,1);
  assert.deepEqual(registered.fixtureIds,[winner.fixtureId]);
  assert.equal(registered.espnTeamId,winner.espnIds[0]);
  assert.equal((await db.doc("_internal/teamReview/fixtureJournals/"+
    loser.fixtureId).get()).exists,false);
  assert.ok(await winnerGate.resolve(query(winner)));
  assert.equal(await loserGate.resolve(query(loser)),null);

  // A compatible second fixture may share the exact provider->ESPN pair.
  const c=source("C",["5001","5004"],[
    winner.espnIds[0],"17"
  ]);
  const gateC=buildGate(c);
  assert.deepEqual(await approve(gateC,c),{status:"APPROVED",revision:1});
  assert.deepEqual((await providerDoc.get()).data().fixtureIds,
    [winner.fixtureId,c.fixtureId].sort());
  assert.deepEqual((await registryEspn(winner.espnIds[0]).get())
    .data().fixtureIds,[winner.fixtureId,c.fixtureId].sort());
  assert.equal((await providerDoc.get()).data().espnTeamId,
    winner.espnIds[0]);

  // Revoking one fixture cannot silently free an ID still claimed by
  // another approved fixture. A conflicting replay must stay blocked.
  tick+=1000;
  assert.deepEqual(await revoke(winnerGate,winner),
    {status:"REVOKED",revision:2});
  assert.deepEqual((await providerDoc.get()).data().fixtureIds,
    [c.fixtureId]);
  assert.deepEqual(await approve(loserGate,loser),
    {status:"REVISION_CONFLICT"});
  assert.equal(await winnerGate.resolve(query(winner)),null);
  assert.ok(await gateC.resolve(query(c)));

  // Only after the LAST compatible fixture is explicitly revoked can
  // the mapping be assigned differently. Rejections never claim IDs.
  tick+=1000;
  assert.deepEqual(await revoke(gateC,c),{status:"REVOKED",revision:2});
  assert.equal((await providerDoc.get()).exists,false);
  assert.equal((await registryEspn(winner.espnIds[0]).get()).exists,false);
  assert.deepEqual(await approve(loserGate,loser),
    {status:"APPROVED",revision:1});
  assert.equal((await providerDoc.get()).data().espnTeamId,
    loser.espnIds[0]);
  assert.deepEqual((await providerDoc.get()).data().fixtureIds,
    [loser.fixtureId]);
  assert.equal((await db.doc("_internal/teamReview/fixtureJournals/"+
    loser.fixtureId).get()).data().revision,1);
  assert.ok(await loserGate.resolve(query(loser)));

  // Firestore browser rules keep every registry path Admin-only.
  const signup=await fetch("http://"+authHost+
    "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({returnSecureToken:true})
  });
  assert.equal(signup.status,200);
  const {idToken}=await signup.json();
  const headers={Authorization:"Bearer "+idToken};
  for(const p of [providerDoc.path,
    registryEspn(loser.espnIds[0]).path]) {
    const url="http://"+firestoreHost+"/v1/projects/"+projectId+
      "/databases/(default)/documents/"+p;
    assert.equal((await fetch(url,{headers})).status,403);
    assert.equal((await fetch(url,{
      method:"PATCH",
      headers:{...headers,"Content-Type":"application/json"},
      body:JSON.stringify({fields:{espnTeamId:{stringValue:"999"}}})
    })).status,403);
  }

  // A tampered registry must not be repaired implicitly or bypassed.
  await providerDoc.update({espnTeamId:"999"});
  const d=source("D",["5001","5005"],[loser.espnIds[0],"18"]);
  const invalid=await approve(buildGate(d),d);
  assert.equal(invalid.status,"REVISION_CONFLICT");
  assert.equal((await providerDoc.get()).data().espnTeamId,"999");
});


test("D18 source fingerprints are rechecked within review and ID-claim transaction",async t=>{
  const {extractOfflineFixtureTeamEvidence}=
    require("./offline-fixture-team-evidence");
  const {makeOfflineFixtureEspnReviewPacket}=
    require("./offline-fixture-espn-review-packet");
  const {makeOfflineFixturesTeamReviewGate}=
    require("./offline-fixtures-team-review-gate");
  const {makeOfflineSourceBoundGloballyGuardedReviewJournal}=
    require("./offline-fixtures-atomic-source-review-journal");
  const app=initializeApp({projectId},"source-bound-review-emulator-rehearsal");
  t.after(()=>deleteApp(app));
  const db=getFirestore(app);
  const iso=delta=>new Date(NOW+delta).toISOString();
  const fixtureId="synthetic-bound-review-fixture";
  const pRef="ODDSPAPI_FIXTURES_"+"C".repeat(32);
  const eRef="ESPN_BOUND_REVIEW_SOURCE_001";
  const startTime=iso(180*60000);
  const providerReceipt=extractOfflineFixtureTeamEvidence([{
    fixtureId,sportId:11,tournamentId:132,
    statusId:0,hasOdds:true,startTime,updatedAt:iso(-2*60000),
    participant1Id:"7501",participant2Id:"7502",
    participant1Name:"Synthetic Mountain Team",
    participant2Name:"Synthetic Coast Team",
    bookmakerOdds:{"betano.pt":{PTS:{price:1.91}}},
    credential:"NEVER_STORE_RAW_PROVIDER_SECRET"
  }],{reference:pRef,capturedAt:iso(-60000)},NOW);
  assert.ok(providerReceipt);
  const scoreboard={events:[{
    id:"401997345",date:startTime,status:{type:{state:"pre"}},
    season:{type:2},competitions:[{competitors:[
      {homeAway:"home",team:{id:"80",displayName:"Synthetic Home Team"}},
      {homeAway:"away",team:{id:"81",displayName:"Synthetic Away Team"}}
    ]}]
  }]};
  const espnMetadata={reference:eRef,capturedAt:iso(-30000)};
  const packet=makeOfflineFixtureEspnReviewPacket({
    fixtureId,providerReceipt,espnScoreboard:scoreboard,
    espnMetadata,now:NOW
  });
  assert.ok(packet);
  const docs={
    binding:db.doc("_internal/teamReview/sourceBindings/"+fixtureId),
    provider:db.doc("_internal/teamEvidence/fixtureTeamSnapshots/"+pRef),
    espn:db.doc("_internal/teamReview/espnSnapshots/"+eRef),
    head:db.doc("_internal/teamReview/fixtureJournals/"+fixtureId),
    registry:db.doc("_internal/teamReview/globalProviderIds/7501")
  };
  await docs.provider.create({
    ...providerReceipt,receivedAt:iso(0)
  });
  await docs.espn.create({
    schemaVersion:1,source:"ESPN_NBA_SCOREBOARD",
    reference:eRef,capturedAt:espnMetadata.capturedAt,
    scoreboard
  });
  const sourceBinding={
    schemaVersion:1,fixtureId,
    providerReference:pRef,espnReference:eRef,
    providerDigest:packet.provider.snapshotDigest,
    espnDigest:packet.espn.digest,packetDigest:packet.packetDigest
  };
  const journal=makeOfflineSourceBoundGloballyGuardedReviewJournal({db});
  // The unprivileged gate is supplied with a stale but valid synthetic
  // packet, while the guard MUST reread original Admin sources each time.
  let tick=NOW;
  const gate=makeOfflineFixturesTeamReviewGate({
    authorize:async auth=>auth===OWNER ?
      {allowed:true,reviewerReference:"OWNER_REVIEW_01"} :
      {allowed:false,reviewerReference:"UNKNOWN"},
    async loadEvidence(id){
      assert.equal(id,fixtureId);
      return {providerReceipt,espnScoreboard:scoreboard,espnMetadata};
    },
    loadHistory:journal.loadHistory,
    appendDecision:journal.appendDecision,
    now:()=>tick
  });
  const pairs=[
    {providerParticipantId:"7501",espnTeamId:"80"},
    {providerParticipantId:"7502",espnTeamId:"81"}
  ];
  const approve=()=>gate.submit(OWNER,{
    fixtureId,action:"APPROVE",expectedRevision:0,pairs
  });
  const revocation=()=>gate.submit(OWNER,{
    fixtureId,action:"REVOKE",expectedRevision:1
  });
  const query={
    fixtureId,participant1Id:"7501",participant2Id:"7502",
    startTime
  };
  const noMutation=async()=>{
    assert.equal((await docs.head.get()).exists,false);
    assert.equal((await docs.registry.get()).exists,false);
  };

  // Even a fully valid packet cannot authorize WITHOUT the pinned
  // server-only binding; no empty fallback and no global ID claims.
  assert.deepEqual(await approve(),{status:"REVISION_CONFLICT"});
  await noMutation();
  await docs.binding.create(sourceBinding);

  // The stored provider receipt can have a valid reference but an
  // altered digest. Cached pretransaction evidence must not bypass it.
  await docs.provider.update({digest:"0".repeat(64)});
  assert.deepEqual(await approve(),{status:"REVISION_CONFLICT"});
  await noMutation();
  await docs.provider.update({digest:providerReceipt.digest});

  // A valid ESPN record at the pinned ref with changed team names
  // invalidates the source packet digest inside the transaction.
  const forged=structuredClone(scoreboard);
  forged.events[0].competitions[0].competitors[0].team
    .displayName="Synthetic Replaced Home";
  await docs.espn.update({scoreboard:forged});
  assert.deepEqual(await approve(),{status:"REVISION_CONFLICT"});
  await noMutation();
  await docs.espn.update({scoreboard});

  // Correct documents + matching binding permit only the exact human
  // reviewed pair decision, with registry and journal in one transaction.
  assert.deepEqual(await approve(),{status:"APPROVED",revision:1});
  assert.equal((await docs.head.get()).data().packetDigest,
    packet.packetDigest);
  assert.equal((await docs.registry.get()).data().espnTeamId,"80");
  assert.equal((await docs.head.collection("events").get()).size,1);
  assert.ok(await gate.resolve(query));

  // Changing the independent binding after approval blocks the
  // subsequent REVOKE rather than accepting a different source.
  tick+=1000;
  await docs.binding.update({espnDigest:"f".repeat(64)});
  assert.deepEqual(await revocation(),{status:"REVISION_CONFLICT"});
  assert.equal((await docs.head.get()).data().revision,1);
  assert.equal((await docs.registry.get()).exists,true);
  await docs.binding.update({espnDigest:packet.espn.digest});
  assert.deepEqual(await revocation(),{status:"REVOKED",revision:2});
  assert.equal((await docs.registry.get()).exists,false);
  assert.equal(await gate.resolve(query),null);

  // The Firestore rules deny arbitrary browser reads/writes of these
  // backend-only source bindings and independent ESPN observations.
  const signup=await fetch("http://"+authHost+
    "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({returnSecureToken:true})
  });
  assert.equal(signup.status,200);
  const {idToken}=await signup.json();
  const headers={Authorization:"Bearer "+idToken};
  for(const ref of [docs.binding,docs.provider,docs.espn]) {
    const url="http://"+firestoreHost+"/v1/projects/"+projectId+
      "/databases/(default)/documents/"+ref.path;
    assert.equal((await fetch(url,{headers})).status,403);
    assert.equal((await fetch(url,{
      method:"PATCH",headers:{...headers,"Content-Type":"application/json"},
      body:JSON.stringify({fields:{source:{stringValue:"FORGED"}}})
    })).status,403);
  }
  const journalDoc=(await docs.head.collection("events").doc("000001").get()).data();
  assert.ok(!JSON.stringify(journalDoc).includes("NEVER_STORE_RAW_PROVIDER_SECRET"));
  assert.ok(!JSON.stringify(journalDoc).includes("bookmakerOdds"));
});


test("D19 ESPN create-only evidence custody is private in Firestore/Auth emulators",async t=>{
  const {makeOfflineEspnScoreboardCustody}=
    require("./offline-espn-scoreboard-custody");
  const {makeOfflineFixtureEspnReviewPacket}=
    require("./offline-fixture-espn-review-packet");
  const {extractOfflineFixtureTeamEvidence}=
    require("./offline-fixture-team-evidence");
  const app=initializeApp({projectId},"offline-espn-snapshot-custody");
  t.after(()=>deleteApp(app));
  const db=getFirestore(app);
  const iso=ms=>new Date(NOW+ms).toISOString();
  const metadata={reference:"ESPN_REHEARSAL_CAPTURE_001",capturedAt:iso(-60000)};
  const ref=db.doc("_internal/teamReview/espnSnapshots/"+metadata.reference);
  const token=Object.freeze({});
  const fixtureId="synthetic-espn-snapshot-fixture";
  const raw={
    events:[{
      id:"401996543",date:iso(180*60000),
      status:{type:{state:"pre",hidden:"NEVER_PERSIST_SECRET"}},
      season:{type:2},competitions:[{competitors:[
        {homeAway:"home",team:{id:"33",displayName:"Synthetic Home",
          stats:{private:"NEVER_PERSIST_SECRET"}}},
        {homeAway:"away",team:{id:"34",displayName:"Synthetic Away"}}
      ]}],
      privateOdds:{PTS:{price:1.81}}
    }],responseSecret:"NEVER_PERSIST_SECRET"
  };
  const custody=makeOfflineEspnScoreboardCustody({
    db,now:()=>NOW,
    attestCapture:async (candidate,details)=>
      candidate===token && details.source==="ESPN_NBA_SCOREBOARD" &&
      details.reference===metadata.reference &&
      details.capturedAt===metadata.capturedAt &&
      /^[a-f0-9]{64}$/.test(details.digest)
  });
  assert.deepEqual(await custody.storeCapture(raw,metadata,{}),
    {status:"DENIED"});
  assert.equal((await ref.get()).exists,false);
  const results=await Promise.all([
    custody.storeCapture(raw,metadata,token),
    custody.storeCapture(raw,metadata,token)
  ]);
  assert.equal(results.filter(x=>x.status==="STORED").length,1);
  assert.ok(results.every(x=>["STORED","REPLAY_BLOCKED",
    "STORE_UNAVAILABLE"].includes(x.status)));
  assert.deepEqual(await custody.storeCapture(raw,metadata,token),
    {status:"REPLAY_BLOCKED"});
  const saved=(await ref.get()).data();
  assert.deepEqual(Object.keys(saved).sort(),
    ["capturedAt","reference","schemaVersion","scoreboard","source"]);
  assert.doesNotMatch(JSON.stringify(saved),
    /NEVER_PERSIST_SECRET|privateOdds|price|stats/);

  // The persisted allowlisted source must remain usable by the existing
  // D18 source-aware packet builder, without granting a reviewed mapping.
  const provider=extractOfflineFixtureTeamEvidence([{
    fixtureId,sportId:11,tournamentId:132,statusId:0,hasOdds:true,
    startTime:iso(180*60000),updatedAt:iso(-120000),
    participant1Id:"7801",participant1Name:"Synthetic Home",
    participant2Id:"7802",participant2Name:"Synthetic Away"
  }],{
    reference:"ODDSPAPI_FIXTURES_"+"D".repeat(32),
    capturedAt:iso(-120000)
  },NOW);
  assert.ok(provider);
  const packet=makeOfflineFixtureEspnReviewPacket({
    fixtureId,providerReceipt:provider,
    espnScoreboard:saved.scoreboard,
    espnMetadata:{reference:saved.reference,capturedAt:saved.capturedAt},
    now:NOW
  });
  assert.ok(packet);
  assert.equal(packet.reviewedPairs,null);
  assert.equal(packet.approved,false);
  assert.deepEqual([packet.espn.home.teamId,packet.espn.away.teamId],
    ["33","34"]);

  const signup=await fetch("http://"+authHost+
    "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({returnSecureToken:true})
  });
  assert.equal(signup.status,200);
  const {idToken}=await signup.json();
  const headers={Authorization:"Bearer "+idToken};
  for(const privateRef of [
    ref,db.doc("_internal/teamReview/espnSnapshots/ESPN_MISSING_001")
  ]){
    const url="http://"+firestoreHost+"/v1/projects/"+projectId+
      "/databases/(default)/documents/"+privateRef.path;
    assert.equal((await fetch(url,{headers})).status,403);
    assert.equal((await fetch(url,{
      method:"PATCH",headers:{...headers,"Content-Type":"application/json"},
      body:JSON.stringify({fields:{source:{stringValue:"FORGED"}}})
    })).status,403);
  }
  assert.equal((await ref.get()).data().source,"ESPN_NBA_SCOREBOARD");
});


test("D21 create-only source binding composes with atomic D18 review in Firestore emulator",async t=>{
  const {extractOfflineFixtureTeamEvidence}=
    require("./offline-fixture-team-evidence");
  const {makeOfflineFixtureEspnReviewPacket}=
    require("./offline-fixture-espn-review-packet");
  const {makeOfflineTwoSourceBindingCustody}=
    require("./offline-two-source-binding-custody");
  const {makeOfflineSourceBoundGloballyGuardedReviewJournal}=
    require("./offline-fixtures-atomic-source-review-journal");
  const {makeOfflineFixturesTeamReviewGate}=
    require("./offline-fixtures-team-review-gate");
  const app=initializeApp({projectId},"offline-atomic-two-source-binding-custody");
  t.after(()=>deleteApp(app));
  const db=getFirestore(app);
  const iso=offset=>new Date(NOW+offset).toISOString();
  const fixtureId="synthetic-d21-two-source-fixture";
  const pRef="ODDSPAPI_FIXTURES_"+"E".repeat(32);
  const eRef="ESPN_CAPTURE_D21_BIND_001";
  const token=Object.freeze({});
  const receipt=extractOfflineFixtureTeamEvidence([{
    fixtureId,sportId:11,tournamentId:132,statusId:0,hasOdds:true,
    startTime:iso(180*60000),updatedAt:iso(-150000),
    participant1Id:"9901",participant1Name:"Synthetic Provider First",
    participant2Id:"9902",participant2Name:"Synthetic Provider Second"
  }],{reference:pRef,capturedAt:iso(-120000)},NOW);
  assert.ok(receipt);
  const scoreboard={events:[{
    id:"401998877",date:iso(180*60000),
    status:{type:{state:"pre"}},season:{type:2},
    competitions:[{competitors:[
      {homeAway:"home",team:{id:"1201",displayName:"Synthetic ESPN First"}},
      {homeAway:"away",team:{id:"1202",displayName:"Synthetic ESPN Second"}}
    ]}]
  }]};
  const espnMetadata={reference:eRef,capturedAt:iso(-30000)};
  const packet=makeOfflineFixtureEspnReviewPacket({
    fixtureId,providerReceipt:receipt,
    espnScoreboard:scoreboard,espnMetadata,now:NOW
  });
  assert.ok(packet);
  const docs={
    binding:db.doc("_internal/teamReview/sourceBindings/"+fixtureId),
    provider:db.doc("_internal/teamEvidence/fixtureTeamSnapshots/"+pRef),
    espn:db.doc("_internal/teamReview/espnSnapshots/"+eRef),
    journal:db.doc("_internal/teamReview/fixtureJournals/"+fixtureId),
    registry:db.doc("_internal/teamReview/globalProviderIds/9901")
  };
  await docs.provider.create({...receipt,receivedAt:iso(-60000)});
  await docs.espn.create({
    schemaVersion:1,source:"ESPN_NBA_SCOREBOARD",
    reference:eRef,capturedAt:espnMetadata.capturedAt,scoreboard
  });
  const input={
    fixtureId,providerReference:pRef,espnReference:eRef
  };
  let trustedReads=0;
  const custody=makeOfflineTwoSourceBindingCustody({
    db,now:()=>NOW,
    authorizeBinding:async (candidate,proposal)=>
      candidate===token&&
      proposal.fixtureId===fixtureId&&
      proposal.providerReference===pRef&&
      proposal.espnReference===eRef,
    attestSourceOrigins:async (candidate,proof)=>{
      trustedReads++;
      return candidate===token&&
        proof.fixtureId===fixtureId&&
        proof.providerDigest===packet.provider.snapshotDigest&&
        proof.espnDigest===packet.espn.digest&&
        proof.packetDigest===packet.packetDigest;
    }
  });

  // An untrusted caller must be rejected before any binding is created.
  assert.deepEqual(await custody.bindSources(input,{}),{status:"DENIED"});
  assert.equal((await docs.binding.get()).exists,false);
  // Competing writers preserve exactly one immutable source binding.
  const results=await Promise.all([
    custody.bindSources(input,token),custody.bindSources(input,token)
  ]);
  assert.equal(results.filter(x=>x.status==="STORED").length,1);
  assert.ok(results.every(x=>["STORED","REPLAY_BLOCKED",
    "STORE_UNAVAILABLE"].includes(x.status)));
  const saved=(await docs.binding.get()).data();
  assert.deepEqual(Object.keys(saved).sort(),
    ["espnDigest","espnReference","fixtureId","packetDigest",
     "providerDigest","providerReference","schemaVersion"]);
  assert.equal(saved.packetDigest,packet.packetDigest);
  assert.deepEqual(await custody.bindSources(input,token),
    {status:"REPLAY_BLOCKED"});
  assert.equal((await docs.journal.get()).exists,false);
  assert.equal((await docs.registry.get()).exists,false,
    "source observation alone NEVER approves a team mapping");
  assert.ok(trustedReads>=1);

  const journal=makeOfflineSourceBoundGloballyGuardedReviewJournal({db});
  const gate=makeOfflineFixturesTeamReviewGate({
    authorize:async auth=>auth===OWNER?
      {allowed:true,reviewerReference:"OWNER_REVIEW_01"}:
      {allowed:false,reviewerReference:"UNKNOWN"},
    loadEvidence:async id=>{
      assert.equal(id,fixtureId);
      const source=(await docs.provider.get()).data();
      const {receivedAt,...providerReceipt}=source;
      const espn=(await docs.espn.get()).data();
      return {
        providerReceipt,espnScoreboard:espn.scoreboard,
        espnMetadata:{
          reference:espn.reference,capturedAt:espn.capturedAt
        }
      };
    },
    loadHistory:journal.loadHistory,
    appendDecision:journal.appendDecision,
    now:()=>NOW
  });
  const pairs=[
    {providerParticipantId:"9901",espnTeamId:"1201"},
    {providerParticipantId:"9902",espnTeamId:"1202"}
  ];
  // Even with a valid source binding, only explicit owner review can
  // approve two verified pairs. A stale binding fails on changed data.
  const altered=structuredClone(scoreboard);
  altered.events[0].competitions[0].competitors[0]
    .team.displayName="Altered ESPN Label";
  await docs.espn.update({scoreboard:altered});
  const approve=()=>gate.submit(OWNER,{
    fixtureId,action:"APPROVE",expectedRevision:0,pairs
  });
  assert.notDeepEqual(await approve(),{status:"APPROVED",revision:1});
  assert.equal((await docs.journal.get()).exists,false);
  assert.equal((await docs.registry.get()).exists,false);
  await docs.espn.update({scoreboard});
  assert.deepEqual(await approve(),{status:"APPROVED",revision:1});
  assert.equal((await docs.journal.get()).data().packetDigest,
    packet.packetDigest);
  assert.equal((await docs.registry.get()).data().espnTeamId,"1201");

  // Ordinary Firebase clients cannot read or mutate private bindings.
  const signup=await fetch("http://"+authHost+
    "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({returnSecureToken:true})
    });
  assert.equal(signup.status,200);
  const {idToken}=await signup.json();
  const headers={Authorization:"Bearer "+idToken};
  const privateUrl="http://"+firestoreHost+"/v1/projects/"+projectId+
    "/databases/(default)/documents/"+docs.binding.path;
  assert.equal((await fetch(privateUrl,{headers})).status,403);
  assert.equal((await fetch(privateUrl,{
    method:"PATCH",headers:{...headers,"Content-Type":"application/json"},
    body:JSON.stringify({fields:{packetDigest:{
      stringValue:"0".repeat(64)
    }}})
  })).status,403);
  assert.equal((await docs.binding.get()).data().packetDigest,
    packet.packetDigest);
});


test("D22 backend-only ESPN reference handoff feeds D21 custody without browser disclosure",async t=>{
  const {extractOfflineFixtureTeamEvidence}=
    require("./offline-fixture-team-evidence");
  const {makeOfflineFixtureEspnReviewPacket}=
    require("./offline-fixture-espn-review-packet");
  const {makeOfflineTwoSourceBindingCustody}=
    require("./offline-two-source-binding-custody");
  const {makeOfflineFixedEspnScoreboardAcquisition}=
    require("./offline-fixed-espn-scoreboard-acquisition");

  const app=initializeApp({projectId},"offline-private-espn-handoff-d22");
  t.after(()=>deleteApp(app));
  const db=getFirestore(app);
  const iso=ms=>new Date(NOW+ms).toISOString();
  const fixtureId="synthetic-d22-es-pair";
  const pRef="ODDSPAPI_FIXTURES_"+"F".repeat(32);
  const startMs=NOW+180*60000;
  const receipt=extractOfflineFixtureTeamEvidence([{
    fixtureId,sportId:11,tournamentId:132,statusId:0,hasOdds:true,
    startTime:iso(180*60000),updatedAt:iso(-150000),
    participant1Id:"9501",participant1Name:"Synthetic Provider One",
    participant2Id:"9502",participant2Name:"Synthetic Provider Two"
  }],{reference:pRef,capturedAt:iso(-120000)},NOW);
  assert.ok(receipt);
  await db.doc("_internal/teamEvidence/fixtureTeamSnapshots/"+pRef)
    .create({...receipt,receivedAt:iso(-60000)});
  const scoreboard={events:[{
    id:"401998811",date:iso(180*60000).replace(".000Z","Z"),
    status:{type:{state:"pre"},unusedSecret:"DO_NOT_SAVE_SECRET"},
    season:{type:2},
    competitions:[{competitors:[
      {homeAway:"home",team:{id:"202",displayName:"Synthetic ESPN One"}},
      {homeAway:"away",team:{id:"203",displayName:"Synthetic ESPN Two"}}
    ]}]
  }],secret:"DO_NOT_SAVE_SECRET"};
  let fetchCalls=0,handoffCalls=0,privateReference=null;
  const token=Object.freeze({});
  const binding=makeOfflineTwoSourceBindingCustody({
    db,now:()=>NOW,
    authorizeBinding:async (candidate,input)=>
      candidate===token&&
      input.fixtureId===fixtureId&&
      input.providerReference===pRef&&
      input.espnReference===privateReference,
    attestSourceOrigins:async (candidate,proof)=>{
      if(candidate!==token||proof.fixtureId!==fixtureId||
         proof.providerReference!==pRef||
         proof.espnReference!==privateReference)
        return false;
      const source=(await db.doc(
        "_internal/teamReview/espnSnapshots/"+privateReference).get()).data();
      const packet=makeOfflineFixtureEspnReviewPacket({
        fixtureId,providerReceipt:receipt,
        espnScoreboard:source.scoreboard,
        espnMetadata:{
          reference:source.reference,capturedAt:source.capturedAt
        },now:NOW
      });
      // Synthetic attestation: this is NOT an independent live source proof.
      return !!packet&&
        proof.providerDigest===packet.provider.snapshotDigest&&
        proof.espnDigest===packet.espn.digest&&
        proof.packetDigest===packet.packetDigest;
    }
  });

  const acquisition=makeOfflineFixedEspnScoreboardAcquisition({
    db,now:()=>NOW,makeSignal:()=>({aborted:false}),
    fetchImpl:async (url,options)=>{
      fetchCalls++;
      assert.match(url,
        /^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/basketball\/nba\/scoreboard\?dates=\d{8}$/);
      assert.equal(options.redirect,"error");
      assert.equal(options.method,"GET");
      return {
        ok:true,redirected:false,url,
        headers:{get:k=>k==="content-type"?"application/json":null},
        body:new ReadableStream({start(c){
          c.enqueue(Buffer.from(JSON.stringify(scoreboard)));c.close();
        }})
      };
    },
    deliverPrivateReceipt:async source=>{
      handoffCalls++;
      assert.deepEqual(Object.keys(source).sort(),
        ["capturedAt","reference","source"]);
      privateReference=source.reference;
      const result=await binding.bindSources({
        fixtureId,providerReference:pRef,espnReference:source.reference
      },token);
      return result.status==="STORED";
    }
  });
  const result=await acquisition.captureForFixtureStart(startMs);
  assert.deepEqual(result,{status:"STORED"});
  assert.deepEqual(Object.keys(result),["status"]);
  assert.equal(fetchCalls,1);
  assert.equal(handoffCalls,1);
  assert.ok(/^ESPN_CAPTURE_[A-F0-9]{32}$/.test(privateReference));
  assert.doesNotMatch(JSON.stringify(result),
    /ESPN_CAPTURE_|9501|9502|401998811|source|reference/);

  const sourceRef=db.doc(
    "_internal/teamReview/espnSnapshots/"+privateReference);
  const bindRef=db.doc("_internal/teamReview/sourceBindings/"+fixtureId);
  const [storedSource,storedBinding]=await Promise.all([
    sourceRef.get(),bindRef.get()
  ]);
  assert.equal(storedSource.exists,true);
  assert.equal(storedBinding.exists,true);
  assert.equal(storedBinding.data().espnReference,privateReference);
  assert.equal(storedBinding.data().providerReference,pRef);
  assert.doesNotMatch(JSON.stringify(storedSource.data()),
    /DO_NOT_SAVE_SECRET|unusedSecret/);
  assert.equal((await db.doc(
    "_internal/teamReview/fixtureJournals/"+fixtureId).get()).exists,false);
  assert.equal((await db.doc(
    "_internal/teamReview/globalProviderIds/9501").get()).exists,false);

  const signup=await fetch("http://"+authHost+
    "/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({returnSecureToken:true})
    });
  assert.equal(signup.status,200);
  const {idToken}=await signup.json();
  const headers={Authorization:"Bearer "+idToken};
  for(const ref of [sourceRef,bindRef]){
    const url="http://"+firestoreHost+
      "/v1/projects/"+projectId+"/databases/(default)/documents/"+ref.path;
    assert.equal((await fetch(url,{headers})).status,403);
    assert.equal((await fetch(url,{
      method:"PATCH",
      headers:{...headers,"Content-Type":"application/json"},
      body:JSON.stringify({fields:{source:{
        stringValue:"SPOOFED_SOURCE"}}})
    })).status,403);
  }
});
