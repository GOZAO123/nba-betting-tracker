"use strict";

// Pure orchestration for the daily ESPN-only settlement job. Firebase/ESPN
// dependencies are injected so failures can be tested offline without network
// access, credentials, Firestore writes or any OddsPapi calls.
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_EVENT_AGE_MS = 3 * HOUR_MS;
const MAX_EVENT_AGE_MS = 14 * DAY_MS;
const CAPTURE_GRACE_MS = 5 * 60 * 1000;
const MAX_EVENTS_PER_RUN = 16;

const FROZEN_FIELDS = Object.freeze([
  "eventId", "eventStartMs", "athleteId", "teamId", "homeId", "awayId",
  "market", "line", "side", "modelSelected", "modelOver", "odds",
  "player", "team", "home", "away", "clientCapturedMs",
  "hits12", "games12", "hits24", "games24"
]);

function receiptTime(entry) {
  const ms = entry?.capturedServerAt?.toMillis?.();
  return Number.isSafeInteger(ms) ? ms : null;
}

function eligibleForAutomaticSettlement(entry, now) {
  if (!entry || entry.status !== "pending" ||
      !Number.isSafeInteger(entry.eventStartMs) ||
      !/^\d{1,20}$/.test(String(entry.eventId || "")) ||
      !Number.isSafeInteger(now) ||
      now - entry.eventStartMs < MIN_EVENT_AGE_MS ||
      now - entry.eventStartMs > MAX_EVENT_AGE_MS) return false;
  const receipt = receiptTime(entry);
  return receipt !== null && receipt < entry.eventStartMs - CAPTURE_GRACE_MS;
}

function frozenFieldsMatch(before, after) {
  if (!before || !after || receiptTime(before) !== receiptTime(after)) return false;
  return FROZEN_FIELDS.every(field => before[field] === after[field]);
}

async function writeVerifiedSettlement({ db, ref, original, outcome, serverTimestamp }) {
  const dnp = outcome?.kind === "dnp" &&
    !Object.hasOwn(outcome, "stat") && !Object.hasOwn(outcome, "won");
  if (!dnp && (outcome?.kind === "dnp" ||
      !Number.isFinite(outcome?.stat) || typeof outcome?.won !== "boolean"))
    throw new Error("Invalid ESPN settlement outcome");
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return false;
    const current = snapshot.data();
    // A simultaneous manual settlement or retried scheduled invocation is a no-op.
    if (current.status === "settled" || current.status === "void") return false;
    if (current.status !== "pending" || !frozenFieldsMatch(original, current) ||
        !Number.isSafeInteger(current.eventStartMs) ||
        receiptTime(current) >= current.eventStartMs - CAPTURE_GRACE_MS)
      throw new Error("Pending record or original frozen fields failed validation");
    tx.update(ref, dnp ? {
      // Research no-action, not independently authenticated bookmaker void.
      status: "void", voidReason: "ESPN_EXPLICIT_DNP",
      resultStat: null, resultWon: null, settledAt: serverTimestamp(),
      settlementSource: "ESPN Final verified DNP by scheduled server: event/team/athlete"
    } : {
      status: "settled", resultStat: outcome.stat, resultWon: outcome.won,
      settledAt: serverTimestamp(),
      settlementSource: "ESPN Final verified by scheduled server: event/team/athlete"
    });
    return true;
  }, { maxAttempts: 3 });
}

async function runAutomaticSettlement({ snapshots, now, fetchSummary, extractFinal,
  db, serverTimestamp, maxEvents = MAX_EVENTS_PER_RUN }) {
  if (!Array.isArray(snapshots) || typeof fetchSummary !== "function" ||
      typeof extractFinal !== "function" || !db ||
      typeof serverTimestamp !== "function" ||
      !Number.isSafeInteger(maxEvents) || maxEvents < 1 ||
      maxEvents > MAX_EVENTS_PER_RUN) throw new Error("Invalid auto-settlement configuration");

  const summary = {
    examined: snapshots.length, eligible: 0, gamesFetched: 0,
    settled: 0, voided: 0, alreadySettled: 0, unresolved: 0, errors: 0,
    truncatedGames: false
  };
  const groups = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot?.ref || typeof snapshot.data !== "function") continue;
    const entry = snapshot.data();
    if (!eligibleForAutomaticSettlement(entry, now)) continue;
    summary.eligible++;
    const id = String(entry.eventId);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ ref: snapshot.ref, entry });
  }
  // Newest games first, to prevent stale DNP/postponed records from consuming
  // the ESPN request cap. The next daily run can retry unresolved games.
  const ordered = [...groups.entries()].sort((a, b) =>
    Math.max(...b[1].map(x => x.entry.eventStartMs)) -
    Math.max(...a[1].map(x => x.entry.eventStartMs)));
  summary.truncatedGames = ordered.length > maxEvents;
  for (const [eventId, records] of ordered.slice(0, maxEvents)) {
    summary.gamesFetched++;
    let espn;
    try {
      espn = await fetchSummary(eventId);
    } catch (_) {
      summary.unresolved += records.length;
      continue;
    }
    for (const record of records) {
      let outcome;
      try {
        // Reuse the EXACT same ESPN Final event/team/athlete/stat validation as
        // the manual callable: only explicit DNP can void; missing data,
        // postponements and mismatches remain pending.
        outcome = extractFinal(espn, record.entry);
      } catch (_) {
        summary.unresolved++;
        continue;
      }
      try {
        const wrote = await writeVerifiedSettlement({
          db, ref: record.ref, original: record.entry, outcome, serverTimestamp
        });
        if (wrote) {
          if (outcome.kind === "dnp") summary.voided++;
          else summary.settled++;
        } else summary.alreadySettled++;
      } catch (_) {
        // Firestore transaction failure or an immutable-field mismatch.
        summary.errors++;
      }
    }
  }
  return summary;
}

module.exports = {
  MAX_EVENTS_PER_RUN, MIN_EVENT_AGE_MS, MAX_EVENT_AGE_MS,
  eligibleForAutomaticSettlement, frozenFieldsMatch,
  writeVerifiedSettlement, runAutomaticSettlement
};
