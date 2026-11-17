"use strict";

// Update 35.1D12 — read-only, OFFLINE, fail-closed release preflight.
// It cannot authorize a deployment or paid request. No Firebase imports,
// network, external tool execution or production side effects.
const REQUIRED = Object.freeze([
  "production", "rules", "crosswalk", "integration", "readme"
]);
const EXTERNAL_GATES = Object.freeze([
  "LIVE_PROVIDER_SCHEMA_UNVERIFIED",
  "INDEPENDENT_ESPN_TEAM_EVIDENCE_UNVERIFIED",
  "FIREBASE_IAM_AND_BILLING_NOT_ATTESTED",
  "OWNER_DEPLOYMENT_APPROVAL_REQUIRED",
  "OWNER_PROVIDER_REQUEST_APPROVAL_REQUIRED"
]);
const MAX_INPUT_BYTES = 1024 * 1024;
const has = (text, pattern) => pattern.test(text);

function offlineEvidenceReleasePreflight(files) {
  if (files === null || typeof files !== "object" || Array.isArray(files) ||
      Object.keys(files).sort().join("|") !==
        [...REQUIRED].sort().join("|") ||
      REQUIRED.some(key => typeof files[key] !== "string" ||
        Buffer.byteLength(files[key],"utf8") > MAX_INPUT_BYTES)) {
    return Object.freeze({
      status:"BLOCKED",releaseReady:false,
      blockers:Object.freeze(["OFFLINE_SOURCE_INPUT_UNAVAILABLE"])
    });
  }
  const blockers = [];
  const add = code => { if (!blockers.includes(code)) blockers.push(code); };
  const {production,rules,crosswalk,integration,readme}=files;

  // Source text is only evidence about this CHECKED-OUT revision. It is not
  // proof of what functions are actually deployed, which account is billed,
  // IAM roles, or what the live provider response contains.
  const reserveStart=production.indexOf("async function reserveDiagnosticRequests(");
  const reserveEnd=reserveStart>=0 ?
    production.indexOf("exports.oddsBackendStatus",reserveStart) : -1;
  const reservationBody=reserveStart>=0 && reserveEnd>reserveStart ?
    production.slice(reserveStart,reserveEnd) : "";
  // A transaction elsewhere (e.g. a ledger write) must NEVER be mistaken
  // for the transactional daily paid-request reservation itself.
  if (!has(production,/const\s+ODDSPAPI_REQUESTS_PER_UTC_DAY\s*=\s*6\s*;/) ||
      !reservationBody ||
      !has(reservationBody,/db\.runTransaction\s*\(/) ||
      !has(reservationBody,/reserved\s*\+\s*amount\s*>\s*ODDSPAPI_REQUESTS_PER_UTC_DAY/) ||
      !has(production,/await\s+reserveDiagnosticRequests\s*\(/))
    add("SIX_REQUEST_BACKEND_GUARD_NOT_VERIFIED");

  if (!has(rules,/allow\s+create\s*,\s*update\s*,\s*delete\s*:\s*if\s+false\s*;/) ||
      !has(rules,/match\s+\/users\/\{userId\}\/propResearchLedger\/\{recordId\}/) ||
      !has(rules,/Everything else is denied by default/) ||
      has(rules,/allow\s+(?:read\s*,\s*write|write|create|update|delete)\s*:\s*if\s+true\s*;/) ||
      has(rules,/match\s+\/\{document=\*\*\}/))
    add("CLIENT_WRITE_PROTECTION_NOT_VERIFIED");

  if (!has(integration,/if\s*\(config\.enabled\s*!==\s*true\)/) ||
      !has(integration,/makeOfflineManualEvidenceAudit\s*\(/) ||
      !has(integration,/makeOfflineFixedOriginOddsPapiTransport\s*\(/))
    add("INTEGRATION_DEFAULT_OFF_NOT_VERIFIED");

  if (has(production,/require\s*\(\s*["']\.\/manual-evidence-integration["']\s*\)/) ||
      has(production,/makeOfflineManualEvidenceIntegration\s*\(/))
    add("PRODUCTION_INTEGRATION_REQUIRES_SEPARATE_REVIEW");
  else
    add("PRODUCTION_EVIDENCE_INTEGRATION_NOT_WIRED");

  if (has(crosswalk,/SERVER_REVIEWED_TEAM_MANIFEST\s*=\s*Object\.freeze\s*\(\s*\[\s*\]\s*\)/))
    add("REVIEWED_TEAM_CROSSWALK_EMPTY");
  else
    add("REVIEWED_TEAM_CROSSWALK_REQUIRES_INDEPENDENT_REVIEW");

  // Docs must never tell the owner to deploy every Cloud Function while
  // held PR #17 includes a separately deployed, absent preflight source.
  if (has(readme,/firebase(?:\.cmd)?\s+deploy\s+--only\s+functions(?:\s|$)/m) ||
      !has(readme,/targeted/i) || !has(readme,/explicit/i))
    add("UNSAFE_DEPLOYMENT_INSTRUCTIONS");

  for (const gate of EXTERNAL_GATES) add(gate);

  return Object.freeze({
    status:"BLOCKED",releaseReady:false,
    blockers:Object.freeze(blockers)
  });
}

if (require.main === module) {
  // Optional PC-side diagnostic: reads only the checked-out repository files.
  // Exit code 2 means intentionally BLOCKED, not a test failure.
  const fs = require("node:fs");
  const path = require("node:path");
  let report;
  try {
    const root=path.resolve(__dirname,"..");
    const files={
      production:fs.readFileSync(path.join(__dirname,"index.js"),"utf8"),
      rules:fs.readFileSync(path.join(root,"firestore.rules"),"utf8"),
      crosswalk:fs.readFileSync(path.join(__dirname,"offer-team-crosswalk.js"),"utf8"),
      integration:fs.readFileSync(path.join(__dirname,"manual-evidence-integration.js"),"utf8"),
      readme:fs.readFileSync(path.join(__dirname,"README.md"),"utf8")
    };
    report=offlineEvidenceReleasePreflight(files);
  } catch (_) {
    report=Object.freeze({status:"BLOCKED",releaseReady:false,
      blockers:Object.freeze(["OFFLINE_SOURCE_INPUT_UNAVAILABLE"])});
  }
  // Only static status codes; never print source, UIDs or credentials.
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
  process.exitCode=2;
}

module.exports={offlineEvidenceReleasePreflight};
