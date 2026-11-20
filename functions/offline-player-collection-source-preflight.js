"use strict";

// D15.38 — OFFLINE source-only inspection for prospective player quote
// collection. This never authenticates a deployed Cloud Function, actual
// OddsPapi response, IAM, pricing or a source-image rollback. NO HTTP, SDK,
// Firebase initialization, trusted receipts, timers, or production imports.
const {offlineQuoteCollectionPreflight} =
  require("./offline-quote-collection-preflight");
const {assessOfflinePaidCallerInventory} =
  require("./offline-identity-quota-caller-inventory");

const REQUIRED=Object.freeze([
  "production","rules","crosswalk","integration","readme",
  "manualReceipt","quoteSnapshot","quoteStore","quoteAdmin","quotePipeline",
  "playerCrosswalk","receiptLink"
]);
const BASELINE_KEYS=Object.freeze(REQUIRED.filter(
  x=>x!=="playerCrosswalk"&&x!=="receiptLink"
));
const QUOTE_BASELINE_SOURCE_FAILURES=Object.freeze([
  "PRODUCTION_QUOTE_PATH_NOT_DISCONNECTED",
  "PRODUCTION_INTEGRATION_QUOTE_OVERRIDE_DETECTED",
  "QUOTE_PIPELINE_DEFAULT_OFF_NOT_CONFIRMED",
  "PRIVATE_RECEIPT_ORDER_NOT_CONFIRMED",
  "QUOTE_RECORD_ALWAYS_UNREVIEWED_NOT_CONFIRMED",
  "QUOTE_CREATE_ONLY_GUARD_NOT_CONFIRMED",
  "ADMIN_FIXED_PATH_GUARD_NOT_CONFIRMED",
  "EXISTING_RELEASE_PREFLIGHT_UNAVAILABLE"
]);
const EXTERNAL=Object.freeze([
  "LIVE_FUNCTION_SOURCE_AND_IMAGE_NOT_ATTESTED",
  "LIVE_SERVICE_ACCOUNT_IAM_NOT_ATTESTED",
  "SEPARATE_ACCOUNT_PREFLIGHT_SOURCE_NOT_ATTESTED",
  "PROVIDER_ACCOUNT_COST_AND_BILLING_NOT_ATTESTED",
  "ORIGINAL_REAL_PROVIDER_PLAYER_RECEIPT_NOT_ATTESTED",
  "INDEPENDENT_ESPN_PLAYER_ID_NOT_ATTESTED",
  "MAIN_LINE_AND_INDEPENDENT_BETANO_QUOTE_NOT_VERIFIED",
  "SINGLE_TARGET_ROLLBACK_NOT_REHEARSED",
  "OWNER_PROVIDER_REQUEST_APPROVAL_REQUIRED",
  "OWNER_PRODUCTION_DEPLOYMENT_APPROVAL_REQUIRED"
]);
const RESTRICTED_PRODUCTION_IMPORTS=Object.freeze([
  "offer-player-crosswalk","offline-player-receipt-link",
  "offline-manual-quote-persistence","offline-quote-evidence-firestore",
  "offline-quote-collection-preflight"
]);
const has=(text,re)=>re.test(text);
function report(findings,inspected=false) {
  const unique=[...new Set(findings)];
  return Object.freeze({
    status:"BLOCKED", releaseReady:false,
    paidProviderAllowed:false,cloudChangesAuthorized:false,
    sourceInspectionCompleted:inspected,
    sourceGuardFindings:Object.freeze(unique),
    blockers:Object.freeze([...new Set([...unique,...EXTERNAL])])
  });
}
function validInput(input) {
  if(!input||typeof input!=="object"||Array.isArray(input)||
     Object.keys(input).sort().join("|")!==[...REQUIRED].sort().join("|"))
    return false;
  return REQUIRED.every(k=>typeof input[k]==="string"&&
    Buffer.byteLength(input[k],"utf8")<=1024*1024);
}
function assessOfflinePlayerCollectionSource(files) {
  try {
    if(!validInput(files))return report(["PLAYER_SOURCE_INPUT_UNAVAILABLE"]);
    const failures=[];
    const add=x=>{if(!failures.includes(x))failures.push(x);};
    const baselineInput=Object.fromEntries(
      BASELINE_KEYS.map(k=>[k,files[k]])
    );
    const baseline=offlineQuoteCollectionPreflight(baselineInput);
    if(baseline?.status!=="BLOCKED"||
       baseline.releaseReady!==false||
       baseline.paidProviderAllowed!==false||
       baseline.cloudChangesAuthorized!==false||
       !Array.isArray(baseline.blockers)||
       baseline.blockers.some(code=>
         QUOTE_BASELINE_SOURCE_FAILURES.includes(code)||
         /(?:_DRIFT|_OVERRIDE_DETECTED|_NOT_CONFIRMED|_UNAVAILABLE)$/.test(code)
       ))
      add("EXISTING_QUOTE_SOURCE_GUARDS_DRIFT");

    const paid=assessOfflinePaidCallerInventory(files.production);
    if(paid?.status!=="BLOCKED"||
       paid.sourceInventoryVerified!==true||
       paid.providerRequestAllowed!==false)
      add("PAID_CALLER_RESERVATION_SOURCE_DRIFT");

    // Never route a disconnected review module directly from an onCall or
    // production import; even a deliberate accidental comment match blocks.
    if(RESTRICTED_PRODUCTION_IMPORTS.some(name=>
       files.production.includes(name))||
       /makeReviewedPlayerBridgeResolver|makeOfflinePlayerReceiptLink|makeOfflineManualQuotePersistence/.test(files.production)||
       /const\s+NBA_PROVIDER_EVIDENCE_ENABLED\s*=\s*true\s*;/.test(files.production))
      add("PRODUCTION_PLAYER_RESEARCH_WIRING_DETECTED");

    const player=files.playerCrosswalk;
    if(!has(player,/const\s+SERVER_REVIEWED_PLAYER_MANIFEST\s*=\s*Object\.freeze\(\[\]\)\s*;/)||
       !has(player,/reviewMethod\s*!==\s*"MANUAL_TWO_SOURCE_PLAYER_ID_REVIEW"/)||
       !has(player,/row\.status\s*!==\s*"APPROVED"/)||
       !has(player,/athleteMatch:\s*"REVIEW_ASSERTION_ONLY"/)||
       !has(player,/bookmakerVerified:\s*false/)||
       !has(player,/autoLineSelected:\s*false/)||
       !has(player,/captureAllowed:\s*false/)||
       !has(player,/const\s+getReviewedPlayerBridge\s*=/))
      add("PLAYER_REVIEW_MANIFEST_OR_DENIAL_DRIFT");

    const receipt=files.receiptLink;
    const fixed=[
      'const TEAM_PATH="_internal/teamEvidence/providerSnapshots/";',
      'const QUOTE_PATH="_internal/quoteEvidence/providerObservations/";',
      "const metadata=Object.freeze({...selection});",
      "await isTrustedInternalReview(token,metadata)!==true",
      "const quoteDoc=await readPrivateEvidence(quotePath);",
      "const batch=await readPrivateEvidence(TEAM_PATH+metadata.sourceReference);",
      'status:"UNREVIEWED_RECEIPT_LINK_ONLY"',
      "bookmakerVerified:false,espnPlayerVerified:false",
      "autoLineSelected:false,captureAllowed:false"
    ];
    if(fixed.some(s=>!receipt.includes(s))||
       receipt.indexOf("await isTrustedInternalReview(token,metadata)")>
         receipt.indexOf("await readPrivateEvidence(quotePath)")||
       has(receipt,/\b(?:fetch|onCall|onSchedule|setInterval|setTimeout)\s*\(/)||
       has(receipt,/\b(?:adminTx|db|tx)\.(?:set|update|delete|create)\s*\(/))
      add("RECEIPT_PRIVATE_READ_OR_UNREVIEWED_GUARD_DRIFT");

    // Firestore rules are OR-composed. Never treat a deny in one match as
    // sufficient if a catch-all read/write exception was added elsewhere.
    if(!has(files.rules,/match\s+\/users\/\{userId\}\/propResearchLedger\/\{recordId\}/)||
       !has(files.rules,/allow\s+create,\s*update,\s*delete:\s*if\s+false\s*;/)||
       !has(files.rules,/\/\/ Everything else is denied by default\./)||
       has(files.rules,/allow\s+(?:write|create|update|delete)\s*:\s*if\s+true\s*;/)||
       has(files.rules,/match\s+\/\{document=\*\*\}/))
      add("CLIENT_RESEARCH_WRITE_PROTECTION_DRIFT");

    return report(failures,true);
  } catch (_) {
    // Never echo source text, exception details, private strings or file paths.
    return report(["PLAYER_SOURCE_INPUT_UNAVAILABLE"]);
  }
}
module.exports={assessOfflinePlayerCollectionSource};
