"use strict";

// Update 35.1D11 — OFFLINE deployment-readiness boundary.
// No Firebase imports, HTTP calls, secret reads or database connections occur
// when this module is loaded or the default-disabled factory is constructed.
// Production functions/index.js intentionally does not import this file.
const { makeOfflineFixedOriginOddsPapiTransport } =
  require("./manual-odds-fixed-transport");
const { makeOfflineManualEvidenceAudit } =
  require("./manual-evidence-receipt");

const ALLOWED_KEYS = Object.freeze([
  "enabled", "ownerUid", "reserveDiagnosticRequests", "getProviderApiKey",
  "fetchImpl", "getFirestore", "makeSignal", "waitBetweenRequests",
  "now", "onFailure", "onEvidenceOutcome"
]);

function makeOfflineManualEvidenceIntegration(config={}) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).some(key=>!ALLOWED_KEYS.includes(key)) ||
      (config.enabled !== undefined && typeof config.enabled !== "boolean"))
    throw new TypeError("Invalid backend integration configuration.");

  // Safe by DEFAULT and inert even when constructed with live backend adapters.
  // This fixed decision is made at BACKEND CONSTRUCTION; client request data
  // cannot turn it on, change the host, bypass the quota, or supply a receipt.
  if (config.enabled !== true) {
    const runDisabled = async () => {
      const error = new Error("Manual provider evidence integration is disabled.");
      error.code = "failed-precondition";
      throw error;
    };
    return Object.freeze(runDisabled);
  }

  const {ownerUid,reserveDiagnosticRequests,getProviderApiKey,fetchImpl,
    getFirestore,waitBetweenRequests,now=Date.now,
    onFailure=()=>{},onEvidenceOutcome=null,makeSignal} = config;
  if (typeof ownerUid !== "string" || !ownerUid ||
      [reserveDiagnosticRequests,getProviderApiKey,fetchImpl,
        getFirestore,waitBetweenRequests,now,onFailure].some(
        x=>typeof x!=="function") ||
      (onEvidenceOutcome !== null && typeof onEvidenceOutcome !== "function") ||
      (makeSignal !== undefined && typeof makeSignal !== "function")) {
    throw new TypeError("Missing trusted enabled-integration dependencies.");
  }

  // Lazy backend-only Admin database handle. A denied/cached request, absent
  // provider identity, or failed upstream read must not initialize Firestore.
  // Once initialized, doc() and runTransaction() use the SAME db instance.
  let resolvedDb = null;
  const database = () => {
    if (!resolvedDb) {
      const db = getFirestore();
      if (!db || typeof db.doc !== "function" ||
          typeof db.runTransaction !== "function")
        throw new Error("Trusted evidence database unavailable.");
      resolvedDb = db;
    }
    return resolvedDb;
  };
  const db = Object.freeze({
    doc(path) { return database().doc(path); },
    runTransaction(callback) { return database().runTransaction(callback); }
  });

  const transport=makeOfflineFixedOriginOddsPapiTransport({
    getApiKey:getProviderApiKey,fetchImpl,
    ...(makeSignal===undefined ? {} : {makeSignal})
  });
  const run = makeOfflineManualEvidenceAudit({
    ownerUid, reserve:reserveDiagnosticRequests,
    fetchCatalogue:transport.fetchCatalogue,fetchOdds:transport.fetchOdds,
    db,waitBetweenRequests,now,onFailure,onEvidenceOutcome
  });
  // Only the owner-gated, parameterless manual audit can be invoked by a
  // future trusted callable; neither fetcher, receipt, nor db is exposed.
  return Object.freeze(run);
}

module.exports={makeOfflineManualEvidenceIntegration};
