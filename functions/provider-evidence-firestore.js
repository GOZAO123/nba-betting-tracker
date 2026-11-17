"use strict";

// Update 35.1D7 — OFFLINE Firebase Admin-style transaction bridge.
// This module does not import Firebase, initialize an app or run operations
// on construction. It is not imported by production functions/index.js.
const { makeOfflineProviderEvidenceStore } = require("./provider-evidence-storage");

const PATH_RE = /^_internal\/teamEvidence\/providerSnapshots\/ODDSPAPI_MANUAL_[A-F0-9]{32}$/;
const SOURCE = "ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const STORED_KEYS = Object.freeze(["schemaVersion", "source", "status",
  "reference", "capturedAt", "receivedAt", "totalFixtures", "acceptedFixtures",
  "rejectedFixtures", "digest", "records"]);
const RECORD_KEYS = Object.freeze(["schemaVersion", "source", "reference",
  "capturedAt", "fixtureId", "startTime", "participantIds", "digest"]);
const isObject = value => value !== null && typeof value === "object" &&
  !Array.isArray(value);
const hasKeys = (value, keys) => isObject(value) &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

function checkedDocumentReference(db, path) {
  if (typeof path !== "string" || !PATH_RE.test(path))
    throw new Error("Invalid evidence document path.");
  const ref = db.doc(path);
  if (!ref || ref.path !== path) throw new Error("Invalid document reference.");
  return ref;
}

function checkedDocumentForCreate(path, value) {
  if (!hasKeys(value, STORED_KEYS) || value.schemaVersion !== 1 ||
      value.source !== SOURCE || value.status !== "UNREVIEWED_PROVIDER_EVIDENCE" ||
      path !== "_internal/teamEvidence/providerSnapshots/" + value.reference ||
      !/^[a-f0-9]{64}$/.test(value.digest) ||
      !Array.isArray(value.records) || value.records.length < 1 ||
      value.records.length > 64 ||
      value.acceptedFixtures !== value.records.length) return false;
  return value.records.every(row =>
    hasKeys(row, RECORD_KEYS) && row.schemaVersion === 1 &&
    row.source === SOURCE && row.reference === value.reference &&
    row.capturedAt === value.capturedAt &&
    typeof row.fixtureId === "string" &&
    Array.isArray(row.participantIds) && row.participantIds.length === 2 &&
    row.participantIds.every(x => typeof x === "string") &&
    /^[a-f0-9]{64}$/.test(row.digest));
}

// db must be a backend-owned Firestore Admin Database with:
//   db.doc(path), db.runTransaction(async adminTransaction => ...)
//
// Transaction facade exposes exactly one read and at most one create on that
// same fixed internal evidence path. Never accept arbitrary client paths.
// Admin transactions guarantee atomic commit and create-only semantics.
// A mocked db in CI cannot establish real IAM / Firestore permissions.
function makeOfflineFirestoreEvidenceTransaction(db) {
  if (!db || typeof db.doc !== "function" ||
      typeof db.runTransaction !== "function") {
    throw new TypeError("Missing backend Firestore transaction dependencies.");
  }
  return async function runEvidenceTransaction(callback) {
    if (typeof callback !== "function")
      throw new TypeError("Transaction callback must be a function.");
    return db.runTransaction(async adminTx => {
      if (!adminTx || typeof adminTx.get !== "function" ||
          typeof adminTx.create !== "function")
        throw new Error("Invalid backend transaction.");
      let readPath = null;
      let wasAbsent = false;
      let created = false;
      const tx = Object.freeze({
        async read(path) {
          if (readPath !== null) throw new Error("Multiple evidence reads forbidden.");
          const ref = checkedDocumentReference(db, path);
          readPath = path;
          const snapshot = await adminTx.get(ref);
          if (!snapshot || typeof snapshot.exists !== "boolean")
            throw new Error("Invalid Firestore snapshot.");
          if (!snapshot.exists) {
            wasAbsent = true;
            return null;
          }
          if (typeof snapshot.data !== "function")
            throw new Error("Invalid Firestore snapshot data.");
          const data = snapshot.data();
          if (!isObject(data)) throw new Error("Invalid stored evidence.");
          return data;
        },
        async create(path, value) {
          if (!wasAbsent || readPath !== path || created ||
              !checkedDocumentForCreate(path, value)) {
            throw new Error("Evidence create not authorized.");
          }
          const ref = checkedDocumentReference(db, path);
          created = true;
          await adminTx.create(ref, value);
        }
      });
      return callback(tx);
    });
  };
}

// Composes D6's existing strict receipt validator with an injected Admin-style
// transaction. Caller MUST authenticate the manual fetched source receipt.
// Merely supplying a valid batch or SHA-256 digest is not authentication.
// This object is inert until a trusted backend explicitly invokes storeBatch.
function makeOfflineFirestoreProviderEvidenceStore({
  db, isTrustedManualReceipt, now=Date.now
}={}) {
  if (typeof isTrustedManualReceipt !== "function" ||
      typeof now !== "function")
    throw new TypeError("Missing trusted source-receipt dependencies.");
  return makeOfflineProviderEvidenceStore({
    isTrustedManualReceipt,
    runTransaction: makeOfflineFirestoreEvidenceTransaction(db),
    now
  });
}

module.exports = {
  makeOfflineFirestoreEvidenceTransaction,
  makeOfflineFirestoreProviderEvidenceStore
};
