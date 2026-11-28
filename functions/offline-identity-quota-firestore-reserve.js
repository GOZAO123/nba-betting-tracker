"use strict";

// Offline-only adapter for the existing default-database counter.
const BUDGET_PATH = "_internal/oddsPapiDailyDiagnosticBudget";
const LIMIT = 6;
const unavailable = () => new Error("Shared daily budget unavailable.");

function utcInstant(tick) {
  if (!Number.isSafeInteger(tick) || tick < 0) throw unavailable();
  const instant = new Date(tick).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(instant)) throw unavailable();
  return instant;
}

function validDay(day) {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}

function dataFields(record, keys) {
  return record !== null && typeof record === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(record)) &&
    Reflect.ownKeys(record).length === keys.length &&
    keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(record, key) ?? {}, "value"));
}

function isOfflineSharedBudgetReceipt(receipt, amount, day) {
  return (amount === 1 || amount === 2) && validDay(day) &&
    dataFields(receipt, ["utcDay", "remaining"]) && receipt.utcDay === day &&
    Number.isSafeInteger(receipt.remaining) &&
    receipt.remaining >= 0 && receipt.remaining <= LIMIT - amount;
}

function readReserved(snapshot, day) {
  if (snapshot?.exists === false) return 0;
  if (snapshot?.exists !== true) throw unavailable();
  const record = snapshot.data();
  const keys = ["utcDay", "reserved", "limit"];
  const hasTimestamp = record != null && Object.hasOwn(record, "lastReservedAt");
  // The legacy offline caller recognizes older three-field counter records.
  if (hasTimestamp) keys.push("lastReservedAt");
  if (!dataFields(record, keys) || !validDay(record.utcDay) || record.utcDay > day ||
      record.limit !== LIMIT || !Number.isSafeInteger(record.reserved) ||
      record.reserved < 0 || record.reserved > LIMIT) throw unavailable();
  if (hasTimestamp && (typeof record.lastReservedAt !== "string" ||
      utcInstant(Date.parse(record.lastReservedAt)) !== record.lastReservedAt ||
      record.lastReservedAt.slice(0, 10) !== record.utcDay)) throw unavailable();
  return record.utcDay === day ? record.reserved : 0;
}

function makeOfflineSharedBudgetReservation({getFirestore, now = Date.now} = {}) {
  if (typeof getFirestore !== "function" || typeof now !== "function") {
    throw new TypeError("Missing trusted shared-budget backend adapters.");
  }
  return Object.freeze(async function reserve(amount, window) {
    if (amount !== 1 && amount !== 2) throw new Error("Budget requires one or two slots.");
    try {
      let latestTick = now();
      const day = utcInstant(latestTick).slice(0, 10);
      let expiresAtMs = Infinity;
      if (window !== undefined) {
        if (!dataFields(window, ["claimedAtMs", "expiresAtMs"])) throw unavailable();
        expiresAtMs = window.expiresAtMs;
        utcInstant(expiresAtMs);
        if (utcInstant(window.claimedAtMs).slice(0, 10) !== day ||
            window.claimedAtMs > latestTick || latestTick >= expiresAtMs) throw unavailable();
      }
      function currentInstant() {
        const tick = now();
        const instant = utcInstant(tick);
        if (tick < latestTick || tick >= expiresAtMs || instant.slice(0, 10) !== day) {
          throw unavailable();
        }
        latestTick = tick;
        return instant;
      }
      const db = getFirestore();
      const ref = db.doc(BUDGET_PATH);
      if (ref?.path !== BUDGET_PATH) throw unavailable();
      let prepared;
      const receipt = await db.runTransaction(async tx => {
        prepared = undefined;
        currentInstant();
        const reserved = readReserved(await tx.get(ref), day);
        if (reserved + amount > LIMIT) throw unavailable();
        const lastReservedAt = currentInstant();
        tx.set(ref, {utcDay: day, reserved: reserved + amount, limit: LIMIT, lastReservedAt});
        prepared = Object.freeze({utcDay: day, remaining: LIMIT - reserved - amount});
        return prepared;
      }, {maxAttempts: 5});
      if (receipt !== prepared || !isOfflineSharedBudgetReceipt(receipt, amount, day)) throw unavailable();
      currentInstant();
      return receipt;
    } catch (_) {
      // A delayed or uncertain commit may have consumed slots. Never refund or retry it.
      throw unavailable();
    }
  });
}

module.exports = Object.freeze({BUDGET_PATH, makeOfflineSharedBudgetReservation, isOfflineSharedBudgetReceipt});
