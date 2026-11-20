"use strict";

// D15.23: offline, redacted, *owner-supplied* evidence shape review.
// NO cloud SDK/CLI, gcloud, Firebase Admin, credentials, API calls, or writes.
// A matching summary is NOT proof of live provenance or deployment readiness.
const { SOURCE_NAMES, EXPECTED, PREFLIGHT } =
  require("./offline-production-function-inventory");

const SCHEMA_VERSION = "d15.23/v1";
const METHODS = Object.freeze([
  "owner-readonly-console-summary",
  "owner-readonly-cli-summary"
]);
const ROOT_FIELDS = Object.freeze(["schemaVersion", "observedAtUtc", "method", "functions"]);
const ROW_FIELDS = Object.freeze([
  "id", "generation", "region", "runtime", "trigger", "state",
  "codebase", "firebaseManaged", "runtimeIdentity", "revisionTraffic"
]);
const PERSISTENT_BLOCKERS = Object.freeze([
  "REDACTED_SUMMARY_ORIGIN_NOT_INDEPENDENTLY_AUTHENTICATED",
  "LIVE_DEPLOYED_SOURCE_EQUIVALENCE_NOT_ATTESTED",
  "EFFECTIVE_IAM_AND_ACTAS_NOT_ATTESTED",
  "FULL_ENV_AND_INVOKER_POLICY_NOT_ATTESTED",
  "ROLLBACK_SOURCE_AND_CONFIG_NOT_ATTESTED",
  "BILLING_AND_COSTS_NOT_ATTESTED",
  "OWNER_CLOUD_CHANGE_APPROVAL_NOT_GRANTED"
]);
const MAX_INPUT_LENGTH = 32000;
const MAX_AGE_MILLIS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MILLIS = 5 * 60 * 1000;

function exactFields(value, keys) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(k => Object.prototype.hasOwnProperty.call(value, k));
}

function sourceIsCanonical(source) {
  if (typeof source !== "string" || source.length < 1000 || source.length > 300000) return false;
  const names = [...source.matchAll(
    /exports\.([A-Za-z0-9_]+)\s*=\s*(?:onCall|onSchedule|onRequest)\s*\(/g
  )].map(m => m[1]).sort();
  const expected = [...SOURCE_NAMES].sort();
  return names.length === 14 && names.every((name, i) => name === expected[i]) &&
    !names.includes(PREFLIGHT) &&
    source.includes("const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;") &&
    source.includes("const NBA_PROVIDER_EVIDENCE_ENABLED = false;") &&
    source.includes("const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;");
}

function createReport({ matched, count, missing, mismatched, unknownCount, blockers }) {
  const unique = [...new Set([...blockers, ...PERSISTENT_BLOCKERS])];
  // No supplied values, unknown names, principal IDs, URLs, env values or errors reflected.
  return Object.freeze({
    status: "BLOCKED",
    releaseReady: false,
    paidProviderAllowed: false,
    cloudChangesAuthorized: false,
    summaryMatches: matched,
    expectedCount: EXPECTED.length,
    observedCount: count,
    missing: Object.freeze(missing),
    mismatched: Object.freeze(mismatched),
    unexpectedCount: unknownCount,
    blockers: Object.freeze(unique)
  });
}

function assessRedactedAttestation(text, source, nowMs = Date.now()) {
  const errors = [], missing = [], mismatched = [];
  let observedCount = 0, unknownCount = 0;
  const add = code => { if (!errors.includes(code)) errors.push(code); };
  const report = () => createReport({
    matched: errors.length === 0,
    count: observedCount,
    missing, mismatched, unknownCount, blockers: errors
  });
  if (!sourceIsCanonical(source)) add("SOURCE_OR_SAFETY_GUARDS_DRIFT");
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) add("CLOCK_UNAVAILABLE");
  if (typeof text !== "string" || !text.length || text.length > MAX_INPUT_LENGTH) {
    add("OFFLINE_ATTESTATION_INPUT_INVALID");
    return report();
  }
  let data;
  try { data = JSON.parse(text); }
  catch { add("OFFLINE_ATTESTATION_JSON_INVALID"); return report(); }
  if (!exactFields(data, ROOT_FIELDS)) {
    add("OFFLINE_ATTESTATION_SCHEMA_INVALID");
    return report();
  }
  if (data.schemaVersion !== SCHEMA_VERSION || !METHODS.includes(data.method)) {
    add("OFFLINE_ATTESTATION_SCHEMA_INVALID");
  }
  if (typeof data.observedAtUtc !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(data.observedAtUtc) ||
      !Number.isFinite(Date.parse(data.observedAtUtc)) ||
      new Date(data.observedAtUtc).toISOString().slice(0, 19) + "Z" !== data.observedAtUtc) {
    add("OBSERVATION_TIMESTAMP_INVALID");
  } else if (Number.isFinite(nowMs) &&
      (nowMs - Date.parse(data.observedAtUtc) > MAX_AGE_MILLIS ||
       Date.parse(data.observedAtUtc) - nowMs > CLOCK_SKEW_MILLIS)) {
    add("OBSERVATION_TOO_OLD_OR_FUTURE");
  }
  if (!Array.isArray(data.functions) || data.functions.length > 20) {
    add("FUNCTION_METADATA_ROWS_INVALID");
    return report();
  }
  observedCount = data.functions.length;
  if (observedCount !== EXPECTED.length) add("FUNCTION_COUNT_MISMATCH");
  const counts = new Map();
  const expectedIds = new Set(EXPECTED);
  for (const row of data.functions) {
    if (!exactFields(row, ROW_FIELDS)) {
      add("FUNCTION_METADATA_FIELDS_INVALID");
      continue;
    }
    // Unknown identifiers are never emitted into output, logs or GitHub issues.
    if (typeof row.id !== "string" || !expectedIds.has(row.id)) {
      unknownCount++;
      add("UNEXPECTED_FUNCTION_PRESENT");
      continue;
    }
    counts.set(row.id, (counts.get(row.id) || 0) + 1);
    const expectedTrigger = row.id === "ledgerAutoSettleProspective" ? "scheduled" : "callable";
    const expectedIdentity = row.id === "oddsPapiNbaIdentitySchemaDiagnostic"
      ? "dedicated" : "default-compute";
    const valid = row.generation === "v2" &&
      row.region === "europe-west1" &&
      row.runtime === "nodejs22" &&
      row.trigger === expectedTrigger &&
      row.state === "ACTIVE" &&
      row.codebase === "default" &&
      (row.firebaseManaged === "yes" ||
       (row.id === PREFLIGHT && row.firebaseManaged === "no")) &&
      row.runtimeIdentity === expectedIdentity &&
      row.revisionTraffic === "single-100";
    if (!valid) mismatched.push(row.id);
  }
  for (const id of EXPECTED) {
    if (!counts.has(id)) missing.push(id);
    if ((counts.get(id) || 0) > 1) add("DUPLICATE_FUNCTION_METADATA");
  }
  if (missing.length) add("EXPECTED_FUNCTIONS_MISSING");
  if (mismatched.length) add("FUNCTION_METADATA_MISMATCH_OR_UNKNOWN");
  // For the independently deployed preflight, both known Firebase-managed
  // and known non-Firebase-managed labels are allowed for documentation.
  // Neither permits blanket deploy. A missing/unknown label blocks.
  return report();
}

module.exports = Object.freeze({
  SCHEMA_VERSION, ROW_FIELDS, ROOT_FIELDS, SOURCE_NAMES, EXPECTED, PREFLIGHT,
  assessRedactedAttestation
});
