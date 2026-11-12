"use strict";

// Update 35.0F, phase 1: bounded, manually triggered batch capture orchestration.
// No Firebase or network dependency here: injected helpers own ESPN validation and
// Firestore transactions. All prices and estimates remain unverified manual input.
const MAX_BATCH_CAPTURE_ITEMS = 20;
const MAX_BATCH_CAPTURE_EVENTS = 12;
const MAX_BATCH_CAPTURE_TEAMS = 12;
const EXPECTED_LOOKUPS_LIMIT = MAX_BATCH_CAPTURE_EVENTS + MAX_BATCH_CAPTURE_TEAMS;
// Keep a 90-second buffer under the 300-second Firebase function timeout so
// queued rows don't start near shutdown. A currently active Firestore operation
// can still return an uncertain result; clients MUST reconcile from the ledger.
const MAX_BATCH_CAPTURE_PROCESSING_MS = 210000;
// Never echo upstream / Firestore / unexpected exception messages. Even a
// familiar Firebase error code may originate from an external dependency.
const PUBLIC_FAILURE_MESSAGES = Object.freeze({
  "invalid-argument": "Invalid quote or ESPN research fields. Correct the observation before retrying.",
  "failed-precondition": "A fixture, roster or capture-time check failed. Refresh the cloud ledger before retrying.",
  "already-exists": "This observation may already exist. Refresh the cloud ledger before retrying.",
  "permission-denied": "Not authorized to capture research observations.",
  "unauthenticated": "Google sign-in is required for secure capture.",
  "resource-exhausted": "A server limit was reached. Refresh the cloud ledger before retrying.",
  "unavailable": "ESPN verification or secure write could not be confirmed. Refresh the cloud ledger before retrying.",
  "deadline-exceeded": "A server operation timed out. Refresh the cloud ledger before retrying."
});
// A transport/transaction/receipt failure after a capture attempt may have
// committed despite the missing response. Do NOT call it a rejected write.
const DEFINITELY_REJECTED_CODES = new Set([
  "invalid-argument", "failed-precondition", "already-exists",
  "permission-denied", "unauthenticated"
]);
function safeFailure(error, attempted = false) {
  const code = Object.hasOwn(PUBLIC_FAILURE_MESSAGES, error?.code) ?
    error.code : "unavailable";
  const unconfirmed = attempted && !DEFINITELY_REJECTED_CODES.has(code);
  return {
    status: unconfirmed ? "unconfirmed" : "rejected",
    code, message: PUBLIC_FAILURE_MESSAGES[code]
  };
}

function planBatchCapture(items, validateCapture, makeRecordId) {
  if (!Array.isArray(items) || !items.length || items.length > MAX_BATCH_CAPTURE_ITEMS)
    throw new Error("A manual batch must contain 1 to 20 observations.");
  const records = [];
  const preliminary = Array(items.length).fill(null);
  const ids = new Set();
  const events = new Set(), teams = new Set();
  for (let index = 0; index < items.length; index++) {
    try {
      const record = validateCapture(items[index]);
      const recordId = makeRecordId(record);
      if (typeof recordId !== "string" || !/^[A-Za-z0-9_]{1,180}$/.test(recordId))
        throw new Error("Invalid record identifier.");
      if (ids.has(recordId)) {
        preliminary[index] = {
          index, status: "rejected", code: "already-exists",
          message: "This event, player, market, line and side are duplicated in this batch."
        };
        continue;
      }
      ids.add(recordId);
      events.add(record.eventId);
      teams.add(record.teamId);
      records.push({ index, record, recordId });
    } catch (error) {
      preliminary[index] = { index, ...safeFailure(error) };
    }
  }
  if (events.size > MAX_BATCH_CAPTURE_EVENTS || teams.size > MAX_BATCH_CAPTURE_TEAMS)
    throw new Error("Batch exceeds the safety cap of 12 unique events and 12 unique teams.");
  return {
    records, preliminary,
    eventCount: events.size, teamCount: teams.size,
    expectedLookups: events.size + teams.size
  };
}

async function runBatchCapture({ items, validateCapture, makeRecordId, captureOne, now = Date.now }) {
  if (typeof validateCapture !== "function" || typeof makeRecordId !== "function" ||
      typeof captureOne !== "function" || typeof now !== "function")
    throw new TypeError("Missing trusted capture dependencies.");
  const startedAt = now();
  const plan = planBatchCapture(items, validateCapture, makeRecordId);
  const results = plan.preliminary.slice();
  // Process sequentially: at most one active trusted ESPN verification/Firestore
  // transaction per invocation. Reuse request-local scoreboard/roster caches.
  const cache = { scoreboards: new Map(), rosters: new Map() };
  let outOfTime = false;
  for (const { index, record, recordId } of plan.records) {
    if (outOfTime || now() - startedAt >= MAX_BATCH_CAPTURE_PROCESSING_MS) {
      outOfTime = true;
      results[index] = {
        index, status: "not-attempted", code: "resource-exhausted",
        message: "The batch time limit was reached BEFORE this row started. Refresh the cloud ledger before retrying."
      };
      continue;
    }
    try {
      const receipt = await captureOne(record, cache);
      if (receipt?.saved !== true || receipt.recordId !== recordId ||
          !Number.isSafeInteger(receipt.serverCapturedMs))
        throw new Error("Unconfirmed trusted server receipt.");
      results[index] = {
        index, status: "saved", recordId, serverCapturedMs: receipt.serverCapturedMs
      };
    } catch (error) {
      results[index] = { index, ...safeFailure(error, true) };
    }
  }
  return {
    total: items.length,
    saved: results.filter(x => x?.status === "saved").length,
    rejected: results.filter(x => x?.status === "rejected").length,
    unconfirmed: results.filter(x => x?.status === "unconfirmed").length,
    notAttempted: results.filter(x => x?.status === "not-attempted").length,
    requiresLedgerRefresh: results.some(x => x?.status !== "saved"),
    results,
    // Potential ESPN upstream URLs if all valid unique team/event pairs were
    // uncached. This is an upper bound, NOT a reported observed request count.
    lookupCeiling: plan.expectedLookups,
    note: "Manual Betano prices and experimental estimates are not independently verified. Each saved row has a separate server receipt. No wagers placed."
  };
}

module.exports = {
  MAX_BATCH_CAPTURE_ITEMS, MAX_BATCH_CAPTURE_EVENTS,
  MAX_BATCH_CAPTURE_TEAMS, EXPECTED_LOOKUPS_LIMIT,
  MAX_BATCH_CAPTURE_PROCESSING_MS, safeFailure, planBatchCapture, runBatchCapture
};
