"use strict";

// Update 35.0F, phase 1: bounded, manually triggered batch capture orchestration.
// No Firebase or network dependency here: injected helpers own ESPN validation and
// Firestore transactions. All prices and estimates remain unverified manual input.
const MAX_BATCH_CAPTURE_ITEMS = 20;
const MAX_BATCH_CAPTURE_EVENTS = 12;
const MAX_BATCH_CAPTURE_TEAMS = 12;
const EXPECTED_LOOKUPS_LIMIT = MAX_BATCH_CAPTURE_EVENTS + MAX_BATCH_CAPTURE_TEAMS;
const PUBLIC_ERROR_CODES = new Set([
  "invalid-argument", "failed-precondition", "already-exists",
  "permission-denied", "unauthenticated", "resource-exhausted",
  "unavailable", "deadline-exceeded"
]);

function safeFailure(error) {
  const code = PUBLIC_ERROR_CODES.has(error?.code) ? error.code : "unavailable";
  const message = PUBLIC_ERROR_CODES.has(error?.code) &&
      typeof error?.message === "string" && error.message.length <= 250
    ? error.message
    : "ESPN verification or secure capture failed. Check the cloud ledger before retrying.";
  return { status: "rejected", code, message };
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

async function runBatchCapture({ items, validateCapture, makeRecordId, captureOne }) {
  if (typeof validateCapture !== "function" || typeof makeRecordId !== "function" ||
      typeof captureOne !== "function") throw new TypeError("Missing trusted capture dependencies.");
  const plan = planBatchCapture(items, validateCapture, makeRecordId);
  const results = plan.preliminary.slice();
  // Process sequentially: at most one active trusted ESPN verification/Firestore
  // transaction per invocation. Reuse request-local scoreboard/roster caches.
  const cache = { scoreboards: new Map(), rosters: new Map() };
  for (const { index, record, recordId } of plan.records) {
    try {
      const receipt = await captureOne(record, cache);
      if (receipt?.saved !== true || receipt.recordId !== recordId ||
          !Number.isSafeInteger(receipt.serverCapturedMs))
        throw new Error("Unconfirmed trusted server receipt.");
      results[index] = {
        index, status: "saved", recordId, serverCapturedMs: receipt.serverCapturedMs
      };
    } catch (error) {
      results[index] = { index, ...safeFailure(error) };
    }
  }
  return {
    total: items.length,
    saved: results.filter(x => x?.status === "saved").length,
    rejected: results.filter(x => x?.status === "rejected").length,
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
  safeFailure, planBatchCapture, runBatchCapture
};
