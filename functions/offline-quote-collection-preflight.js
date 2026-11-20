"use strict";

// Update 35.1D15.33: DISCONNECTED, READ-ONLY quote collection preflight.
// A source-text check is not a live provider, IAM, source-image or quote
// attestation. This gate can ONLY return BLOCKED, never authorize API spending,
// deployment, live Firestore operations or an odds/research observation.
const { offlineEvidenceReleasePreflight } =
  require("./evidence-release-preflight");

const REQUIRED = Object.freeze([
  "production","rules","crosswalk","integration","readme",
  "manualReceipt","quoteSnapshot","quoteStore","quoteAdmin","quotePipeline"
]);
const MAX_SOURCE_BYTES=1024*1024;

const NON_SOURCE_ATTESTATIONS = Object.freeze([
  "REAL_ODDSPAPI_QUOTE_SCHEMA_NOT_ATTESTED",
  "PROVIDER_PLAN_AND_REQUEST_COST_NOT_ATTESTED",
  "INDEPENDENT_ESPN_PLAYER_IDENTITY_NOT_ATTESTED",
  "PRODUCTION_RECEIPT_TO_QUOTE_INTEGRITY_NOT_ATTESTED",
  "DURABLE_QUOTE_REPLAY_AND_ADMIN_IAM_NOT_ATTESTED",
  "EXACT_TARGETED_DEPLOYMENT_AND_ROLLBACK_NOT_ATTESTED",
  "OWNER_PRODUCTION_DEPLOYMENT_APPROVAL_REQUIRED",
  "OWNER_LIVE_PROVIDER_REQUEST_APPROVAL_REQUIRED"
]);
const SOURCE_GUARDS=Object.freeze([
  "PRODUCTION_QUOTE_PATH_NOT_DISCONNECTED",
  "PRODUCTION_INTEGRATION_QUOTE_OVERRIDE_DETECTED",
  "QUOTE_PIPELINE_DEFAULT_OFF_NOT_CONFIRMED",
  "PRIVATE_RECEIPT_ORDER_NOT_CONFIRMED",
  "QUOTE_RECORD_ALWAYS_UNREVIEWED_NOT_CONFIRMED",
  "QUOTE_CREATE_ONLY_GUARD_NOT_CONFIRMED",
  "ADMIN_FIXED_PATH_GUARD_NOT_CONFIRMED",
  "EXISTING_RELEASE_PREFLIGHT_UNAVAILABLE"
]);
const has = (value, pattern) => pattern.test(value);
const blocked=items=>Object.freeze({
  status:"BLOCKED",releaseReady:false,paidProviderAllowed:false,
  cloudChangesAuthorized:false,
  blockers:Object.freeze([...new Set(items)])
});
const inputInvalid = x => x===null || typeof x!=="object" ||
  Array.isArray(x) || Object.keys(x).sort().join("|") !==
  [...REQUIRED].sort().join("|") ||
  REQUIRED.some(k=>typeof x[k]!=="string" ||
    Buffer.byteLength(x[k],"utf8")>MAX_SOURCE_BYTES);

function offlineQuoteCollectionPreflight(files) {
  try {
    if (inputInvalid(files)) return blocked(["QUOTE_PREFLIGHT_INPUT_UNAVAILABLE"]);
    const {
      production,rules,crosswalk,integration,readme,
      manualReceipt,quoteSnapshot,quoteStore,quoteAdmin,quotePipeline
    }=files;
    const baseline=offlineEvidenceReleasePreflight({
      production,rules,crosswalk,integration,readme
    });
    const blockers = [];
    const add=code=>{if (!blockers.includes(code))blockers.push(code);};

    if (!baseline || baseline.status!=="BLOCKED" ||
        baseline.releaseReady!==false ||
        !Array.isArray(baseline.blockers)) add(SOURCE_GUARDS[7]);
    else for(const reason of baseline.blockers) {
      if (typeof reason!=="string" || !/^[A-Z0-9_]{3,90}$/.test(reason))
        add(SOURCE_GUARDS[7]);
      else add(reason);
    }

    // A direct production import may bypass intentional default-off behavior.
    // Even if removed from the importer name, this always remains blocked by
    // the independent non-source attestations at the bottom.
    if (has(production,
      /offline-manual-quote-persistence|makeOfflineManualQuotePersistence|offline-quote-evidence-firestore|makeOfflineFirestoreQuoteEvidenceStore/) ||
        has(production,/const\s+NBA_PROVIDER_EVIDENCE_ENABLED\s*=\s*true\s*;/))
      add(SOURCE_GUARDS[0]);

    if (has(integration,
      /offline-manual-quote-persistence|makeOfflineManualQuotePersistence|trustedQuoteSelection|onTrustedQuote|onQuoteOutcome/))
      add(SOURCE_GUARDS[1]);

    if (!has(quotePipeline,/if\s*\(\s*config\.enabled\s*!==\s*true\s*\)/) ||
        !has(quotePipeline,/makeOfflineManualEvidenceAudit\s*\(/) ||
        !has(quotePipeline,/makeOfflineFirestoreQuoteEvidenceStore\s*\(/) ||
        !has(quotePipeline,/scope\.claimed\s*=\s*true/) ||
        has(quotePipeline,/\b(?:fetch|setInterval|setTimeout|onCall|onSchedule)\s*\(/))
      add(SOURCE_GUARDS[2]);

    if (!has(manualReceipt,/outcome\?\.status\s*===\s*"STORED"/) ||
        !has(manualReceipt,/await\s+onTrustedQuote\s*\(\s*quote\s*\)/) ||
        !has(manualReceipt,/await\s+store\.storeBatch\s*\(\s*batch\s*,\s*token\s*\)/) ||
        !has(manualReceipt,/trustedQuoteSelection\s*=\s*null/) ||
        !has(manualReceipt,/onTrustedQuote\s*=\s*null/))
      add(SOURCE_GUARDS[3]);

    if (!has(quoteSnapshot,/status:\s*"UNREVIEWED_PROVIDER_QUOTE"/) ||
        !has(quoteSnapshot,/bookmakerVerified:\s*false/) ||
        !has(quoteSnapshot,/espnPlayerVerified:\s*false/) ||
        !has(quoteSnapshot,/autoLineSelected:\s*false/) ||
        !has(quoteSnapshot,/captureAllowed:\s*false/))
      add(SOURCE_GUARDS[4]);

    if (!has(quoteStore,/isTrustedQuoteReceipt\s*\(/) ||
        !has(quoteStore,/await\s+tx\.read\s*\(/) ||
        !has(quoteStore,/await\s+tx\.create\s*\(/) ||
        !has(quoteStore,/return\s+"REPLAY_BLOCKED"\s*;/) ||
        !has(quoteStore,/isTrustedQuoteReceipt\s*,\s*runTransaction/) ||
        has(quoteStore,/\b(?:tx|db)\.(?:update|delete|set)\s*\(/))
      add(SOURCE_GUARDS[5]);

    if (!has(quoteAdmin,/_internal\/quoteEvidence\/providerObservations\//) ||
        !has(quoteAdmin,/checkedDocumentReference\s*\(/) ||
        !has(quoteAdmin,/!\s*validCreateDocument\s*\(\s*path\s*,\s*record\s*\)/) ||
        !has(quoteAdmin,/wasAbsent/) ||
        !has(quoteAdmin,/readPath\s*!==\s*path/) ||
        !has(quoteAdmin,/adminTx\.create\s*\(/))
      add(SOURCE_GUARDS[6]);

    for(const code of NON_SOURCE_ATTESTATIONS)add(code);
    return blocked(blockers);
  } catch (_) {
    return blocked(["QUOTE_PREFLIGHT_INPUT_UNAVAILABLE"]);
  }
}

if (require.main===module) {
  // Safe local-only developer check; it never prints source, identifiers,
  // raw credentials, odds, or any claims of deployment readiness.
  const fs=require("node:fs"),path=require("node:path");
  let report;
  try {
    const root=path.resolve(__dirname,"..");
    const paths={
      production:"index.js",
      integration:"manual-evidence-integration.js",
      crosswalk:"offer-team-crosswalk.js",
      manualReceipt:"manual-evidence-receipt.js",
      quoteSnapshot:"provider-player-quote-snapshot.js",
      quoteStore:"offline-quote-evidence-store.js",
      quoteAdmin:"offline-quote-evidence-firestore.js",
      quotePipeline:"offline-manual-quote-persistence.js"
    };
    const inputs={};
    for(const [key,name] of Object.entries(paths))
      inputs[key]=fs.readFileSync(path.join(__dirname,name),"utf8");
    inputs.rules=fs.readFileSync(path.join(root,"firestore.rules"),"utf8");
    inputs.readme=fs.readFileSync(path.join(__dirname,"README.md"),"utf8");
    report=offlineQuoteCollectionPreflight(inputs);
  }catch(_){report=blocked(["QUOTE_PREFLIGHT_INPUT_UNAVAILABLE"]);}
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
  process.exitCode=2; // An intentionally blocked release is not a success.
}

module.exports={offlineQuoteCollectionPreflight};
