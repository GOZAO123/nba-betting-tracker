"use strict";

// Draft-only, disconnected manual fixture-identity discovery. No Firebase or
// HTTP calls on import/construction; functions/index.js must NOT import this.
// All dependencies are trusted backend adapters, never request.data values.
const {makeOfflineFixedOriginOddsPapiTransport} =
  require("./manual-odds-fixed-transport");
const {extractManualProviderIdentityBatch} =
  require("./provider-evidence-acquisition");
const {makeOfflineFirestoreProviderEvidenceStore} =
  require("./provider-evidence-firestore");

const APPROVAL_PREFIX = "_internal/identityDiscovery/approvals/";
const APPROVAL_MAX_MS = 15 * 60 * 1000;
const APPROVAL_RE = /^[a-f0-9]{32}$/;
const deny = (code, message) => Object.assign(new Error(message), {code});

// One owner-initiated attempt can reserve one OddsPapi league request; it is
// NOT a substitute for independent ESPN team mapping or player verification.
function makeOfflineManualIdentityDiscovery({
  enabled = false, ownerUid, approvalId, getDb, reserve, getApiKey,
  fetchImpl, now = Date.now
} = {}) {
  if (enabled !== true) {
    return Object.freeze(async () => {
      throw deny("failed-precondition", "Identity discovery is disabled.");
    });
  }
  if (typeof ownerUid !== "string" || ownerUid.length === 0 ||
      !APPROVAL_RE.test(approvalId) ||
      [getDb, reserve, getApiKey, fetchImpl, now]
        .some(fn => typeof fn !== "function")) {
    throw new TypeError("Missing trusted discovery configuration.");
  }

  return Object.freeze(async request => {
    // No permit, quota, secrets or Firestore activity for invalid callers.
    if (!request?.auth || request.auth.uid !== ownerUid ||
        request.auth.token?.email_verified !== true) {
      throw deny("permission-denied", "Verified owner required.");
    }
    const data = request.data;
    if (!data || Object.getPrototypeOf(data) !== Object.prototype ||
        Reflect.ownKeys(data).length !== 0) {
      throw deny("invalid-argument", "Expected an empty request.");
    }

    let db;
    try {
      db = getDb();
      if (typeof db?.doc !== "function" ||
          typeof db?.runTransaction !== "function") throw Error("DB");
      const approvalRef = db.doc(APPROVAL_PREFIX + approvalId);
      const claimed = await db.runTransaction(async tx => {
        const snap = await tx.get(approvalRef);
        const record = snap?.exists ? snap.data() : null;
        const tick = now();
        if (!record || Object.keys(record).sort().join("|") !==
            "claimedAtMs|expiresAtMs|issuedAtMs" ||
            record.claimedAtMs !== null ||
            ![record.issuedAtMs, record.expiresAtMs, tick]
              .every(Number.isSafeInteger) ||
            record.issuedAtMs < 0 || record.issuedAtMs > tick ||
            record.expiresAtMs <= tick ||
            record.expiresAtMs - record.issuedAtMs > APPROVAL_MAX_MS) {
          return false;
        }
        tx.update(approvalRef, {claimedAtMs: tick});
        return true;
      });
      if (claimed !== true) {
        throw deny("failed-precondition", "No usable discovery approval.");
      }
    } catch (error) {
      if (error?.code === "failed-precondition") throw error;
      throw deny("unavailable", "Discovery approval check failed.");
    }

    // A claimed approval is consumed even if quota, provider or storage fails.
    // The trusted fixed-origin transport resolves the secret only AFTER this.
    try {
      const budget = await reserve(1);
      if (!budget || !/^\d{4}-\d{2}-\d{2}$/.test(budget.utcDay) ||
          !Number.isSafeInteger(budget.remaining) ||
          budget.remaining < 0 || budget.remaining > 5) {
        throw Error("Unverified reservation receipt.");
      }
    } catch (error) {
      throw deny(error?.code === "resource-exhausted" ?
        "resource-exhausted" : "unavailable", "Discovery budget unavailable.");
    }

    let payload;
    try {
      payload = await makeOfflineFixedOriginOddsPapiTransport({
        getApiKey, fetchImpl
      }).fetchOdds();
    } catch (_) {
      throw deny("unavailable", "Discovery provider request failed.");
    }

    let batch;
    try {
      const tick = now();
      if (!Number.isSafeInteger(tick) || tick < 0) throw Error("clock");
      batch = extractManualProviderIdentityBatch(payload,
        new Date(tick).toISOString());
      if (!batch || batch.acceptedFixtures === 0) {
        return Object.freeze({status:"NO_STORABLE_FIXTURES"});
      }
      // An object-identity receipt exists only in this invocation. The D6/D7
      // backend store independently validates the exact allowlisted evidence
      // and commits via an Admin create-only transaction on a fixed path.
      const receipt = Object.freeze({});
      const store = makeOfflineFirestoreProviderEvidenceStore({
        db, now,
        isTrustedManualReceipt: async (token, metadata) =>
          token === receipt && metadata?.source === batch.source &&
          metadata.reference === batch.snapshotReference &&
          metadata.capturedAt === batch.capturedAt
      });
      const result = await store.storeBatch(batch, receipt);
      if (result?.status !== "STORED") throw Error("store");
      return Object.freeze({status:"STORED_UNREVIEWED"});
    } catch (_) {
      throw deny("unavailable", "Discovery evidence unavailable.");
    }
  });
}

module.exports = {makeOfflineManualIdentityDiscovery};
