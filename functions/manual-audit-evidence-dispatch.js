"use strict";

// D14 — production-side ROUTING only, not activation. Do not export a new
// Cloud Function. A literal backend-only enabled:false must be kept in
// index.js until a separately approved, targeted rollout.
//
// In the OFF state this returns the ORIGINAL callable runner by reference:
// no provider, secret, quota, database, HTTP, logger, D11 import or cache
// initialization occurs here. All existing audit behavior is preserved.
const CONFIG_KEYS = Object.freeze([
  "enabled", "legacyRun", "ownerUid", "reserveDiagnosticRequests",
  "getProviderApiKey", "fetchImpl", "getFirestore", "waitBetweenRequests",
  "onFailure", "onEvidenceOutcome", "now", "makeSignal"
]);
const isObject=x=>x!==null && typeof x==="object" && !Array.isArray(x);

function makeManualAuditEvidenceDispatch(config={}) {
  if (!isObject(config) ||
      Object.keys(config).some(k=>!CONFIG_KEYS.includes(k)) ||
      (config.enabled!==undefined && typeof config.enabled!=="boolean") ||
      typeof config.legacyRun!=="function") {
    throw new TypeError("Invalid trusted evidence dispatch configuration.");
  }
  if (config.enabled!==true) return config.legacyRun;

  // Lazy load: the production-disabled path never even imports the D11
  // integration. The only enabled path uses its existing strict owner,
  // per-UTC-day reservation, fixed-host transport, one-use receipt, and
  // Firestore Admin create-only store. Caller-owned adapters must be vetted.
  const {makeOfflineManualEvidenceIntegration} =
    require("./manual-evidence-integration");
  const {legacyRun,enabled,...trustedAdapters}=config;
  return makeOfflineManualEvidenceIntegration({
    ...trustedAdapters,enabled:true
  });
}
module.exports={makeManualAuditEvidenceDispatch};
