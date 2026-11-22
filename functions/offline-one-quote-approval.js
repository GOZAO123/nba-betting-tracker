"use strict";

const {randomBytes} = require("node:crypto");
const {makeOfflineManualQuotePersistence} = require("./offline-manual-quote-persistence");

const APPROVAL_PATH = "_internal/oneQuoteCollection/approvals/";
const MAX_APPROVAL_WINDOW_MS = 15 * 60 * 1000;

const validApprovalId = id => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);

// Call only from trusted operator code with an Admin Firestore instance.
async function provisionOfflineOneQuoteApproval({
  db, ttlMs, now = Date.now, generateId = () => randomBytes(16).toString("hex")
}) {
  if (typeof db?.doc !== "function" || !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 || ttlMs > MAX_APPROVAL_WINDOW_MS) {
    throw new TypeError("Invalid trusted approval provisioning configuration.");
  }
  const issuedAtMs = now();
  const expiresAtMs = issuedAtMs + ttlMs;
  if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 ||
      !Number.isSafeInteger(expiresAtMs)) {
    throw new TypeError("Invalid approval timestamp.");
  }
  const approvalId = generateId();
  if (!validApprovalId(approvalId)) throw new TypeError("Invalid generated approval ID.");
  await db.doc(APPROVAL_PATH + approvalId).create({
    issuedAtMs, expiresAtMs, claimedAtMs: null
  });
  return {approvalId, expiresAtMs};
}

function deny(code, message) {
  throw Object.assign(new Error(message), {code});
}

// The caller must inject the trusted, scoped collector with its own shared quota
// reservation. This factory has no Firebase export or approval provisioning path.
function makeOfflineOneQuoteApproval({
  enabled = false, ownerUid, approvalId, db, collect, now = Date.now
} = {}) {
  if (enabled !== true) {
    return async () => deny("failed-precondition", "One-quote collection is disabled.");
  }
  if (typeof ownerUid !== "string" || ownerUid.length === 0 ||
      !validApprovalId(approvalId) ||
      typeof collect !== "function" || typeof now !== "function" ||
      typeof db?.doc !== "function" || typeof db.runTransaction !== "function") {
    throw new TypeError("Invalid trusted one-quote configuration.");
  }

  return async function run(request) {
    if (!request?.auth) deny("unauthenticated", "Sign-in required.");
    if (request.auth.uid !== ownerUid || request.auth.token?.email_verified !== true) {
      deny("permission-denied", "Verified owner required.");
    }
    const data = request.data;
    if (!data || Object.getPrototypeOf(data) !== Object.prototype ||
        Reflect.ownKeys(data).length !== 0) {
      deny("invalid-argument", "Expected an empty request.");
    }
    const approval = db.doc(APPROVAL_PATH + approvalId);
    let claimed;
    try {
      claimed = await db.runTransaction(async tx => {
        const record = (await tx.get(approval)).data();
        const tick = now();
        if (!record || record.claimedAtMs !== null ||
            ![tick, record.issuedAtMs, record.expiresAtMs].every(Number.isSafeInteger) ||
            record.issuedAtMs < 0 || record.issuedAtMs > tick || record.expiresAtMs <= tick ||
            record.expiresAtMs - record.issuedAtMs > MAX_APPROVAL_WINDOW_MS) {
          return false;
        }
        tx.update(approval, {claimedAtMs: tick});
        return true;
      });
    } catch (_) {
      deny("unavailable", "Could not claim collection approval.");
    }
    if (!claimed) deny("failed-precondition", "No usable collection approval.");

    // Once claimed, the permit is consumed even if collection fails. Never
    // forward receipts or downstream errors through this boundary.
    let outcome;
    try {
      outcome = await collect({auth: {uid: ownerUid, token: {email_verified: true}}, data: {}});
    } catch (_) {
      deny("unavailable", "Collection attempt did not complete.");
    }
    const status = outcome === "LINKED_UNREVIEWED" || outcome === "UNLINKED"
      ? outcome
      : "ATTEMPT_COMPLETED";
    return {status};
  };
}

// Construct a fresh scoped collector for each separately claimed approval.
function makeOfflineLinkedQuoteCollector(options) {
  if (typeof options?.readPrivateEvidence !== "function") {
    throw new TypeError("Missing trusted private receipt reader.");
  }
  return async request => {
    let outcome = "UNLINKED";
    const collect = makeOfflineManualQuotePersistence({
      ...options,
      onQuoteOutcome({status}) {
        if (status === "LINKED_UNREVIEWED") outcome = status;
      }
    });
    await collect(request);
    return outcome;
  };
}

module.exports = {
  makeOfflineOneQuoteApproval, makeOfflineLinkedQuoteCollector, provisionOfflineOneQuoteApproval
};
