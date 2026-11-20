"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {assessOfflinePlayerCollectionSource:assess}=
  require("./offline-player-collection-source-preflight");
const REQUIRED=Object.freeze({
  production:"index.js",
  rules:"../firestore.rules",
  crosswalk:"offer-team-crosswalk.js",
  integration:"manual-evidence-integration.js",
  readme:"README.md",
  manualReceipt:"manual-evidence-receipt.js",
  quoteSnapshot:"provider-player-quote-snapshot.js",
  quoteStore:"offline-quote-evidence-store.js",
  quoteAdmin:"offline-quote-evidence-firestore.js",
  quotePipeline:"offline-manual-quote-persistence.js",
  playerCrosswalk:"offer-player-crosswalk.js",
  receiptLink:"offline-player-receipt-link.js"
});
function current() {
  return Object.fromEntries(Object.entries(REQUIRED).map(([k,v])=>
    [k,fs.readFileSync(path.join(__dirname,v),"utf8")]
  ));
}
function blocked(result) {
  assert.equal(result.status,"BLOCKED");
  assert.equal(result.releaseReady,false);
  assert.equal(result.paidProviderAllowed,false);
  assert.equal(result.cloudChangesAuthorized,false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.blockers));
  assert.ok(Object.isFrozen(result.sourceGuardFindings));
  assert.equal(new Set(result.blockers).size,result.blockers.length);
  for(const code of result.blockers)
    assert.match(code,/^[A-Z0-9_]{3,90}$/);
  return result.sourceGuardFindings;
}
function detect(input,code) {
  const result=assess(input);
  assert.ok(blocked(result).includes(code),
    "Expected "+code+"; got "+JSON.stringify(result.sourceGuardFindings));
}
test("D15.38 canonical main source has no new local drift but remains blocked",()=>{
  const result=assess(current());
  assert.equal(result.sourceInspectionCompleted,true);
  assert.deepEqual(blocked(result),[]);
  for(const pending of [
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
  ])assert.ok(result.blockers.includes(pending),pending);
});

test("D15.38 empty or oversized source and unknown fields fail without echo",()=>{
  for(const v of [undefined,null,{},[],{production:"x"},
    {...current(),clientClaim:"PAID"},
    {...current(),receiptLink:34},
    {...current(),receiptLink:"S".repeat(1024*1024+1)}])
    detect(v,"PLAYER_SOURCE_INPUT_UNAVAILABLE");
});
test("D15.38 input getter traps never reflect sensitive errors",()=>{
  const x=current();
  Object.defineProperty(x,"playerCrosswalk",{enumerable:true,get(){
    throw Error("PRIVATE_SDK_CREDENTIAL_SENTINEL");
  }});
  const result=assess(x);
  blocked(result);
  assert.equal(JSON.stringify(result).includes("PRIVATE_SDK_CREDENTIAL"),false);
});
test("D15.38 introducing production player resolver import is denied",()=>{
  for(const injection of [
    '\nrequire("./offer-player-crosswalk");',
    '\nrequire("./offline-player-receipt-link");',
    '\nrequire("./offline-manual-quote-persistence");',
    '\nconst future = makeReviewedPlayerBridgeResolver([]);',
    '\nconst future = makeOfflinePlayerReceiptLink({});'
  ]){
    const x=current();x.production+=injection;
    detect(x,"PRODUCTION_PLAYER_RESEARCH_WIRING_DETECTED");
  }
});
test("D15.38 changing live evidence enable flag is blocked",()=>{
  const x=current();
  x.production=x.production.replace(
    "const NBA_PROVIDER_EVIDENCE_ENABLED = false;",
    "const NBA_PROVIDER_EVIDENCE_ENABLED = true;");
  detect(x,"PRODUCTION_PLAYER_RESEARCH_WIRING_DETECTED");
  detect(x,"PAID_CALLER_RESERVATION_SOURCE_DRIFT");
});
test("D15.38 server-side six request cap cannot drift",()=>{
  const x=current();
  x.production=x.production.replace(
    "const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;",
    "const ODDSPAPI_REQUESTS_PER_UTC_DAY = 12;");
  detect(x,"PAID_CALLER_RESERVATION_SOURCE_DRIFT");
});
test("D15.38 direct OddsPapi caller reservation removal blocks",()=>{
  const x=current();
  x.production=x.production.replace(
    "await reserveDiagnosticRequests(2);","await reserveDiagnosticRequests(0);");
  detect(x,"PAID_CALLER_RESERVATION_SOURCE_DRIFT");
});
test("D15.38 dormant identity diagnostic flag must remain false",()=>{
  const x=current();
  x.production=x.production.replace(
    "const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;",
    "const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = true;");
  detect(x,"PAID_CALLER_RESERVATION_SOURCE_DRIFT");
});
test("D15.38 real player review manifest must remain empty",()=>{
  const x=current();
  x.playerCrosswalk=x.playerCrosswalk.replace(
    "const SERVER_REVIEWED_PLAYER_MANIFEST=Object.freeze([]);",
    "const SERVER_REVIEWED_PLAYER_MANIFEST=Object.freeze([{approved:true}]);");
  detect(x,"PLAYER_REVIEW_MANIFEST_OR_DENIAL_DRIFT");
});
test("D15.38 player review result cannot promote approval flags",()=>{
  for(const field of ["bookmakerVerified","autoLineSelected","captureAllowed"]){
    const x=current();
    x.playerCrosswalk=x.playerCrosswalk.replace(
      field+":false",field+":true");
    detect(x,"PLAYER_REVIEW_MANIFEST_OR_DENIAL_DRIFT");
  }
});
test("D15.38 player name-only review status change rejected",()=>{
  const x=current();
  x.playerCrosswalk=x.playerCrosswalk.replace(
    'athleteMatch:"REVIEW_ASSERTION_ONLY"',
    'athleteMatch:"VERIFIED_PLAYER_ID"');
  detect(x,"PLAYER_REVIEW_MANIFEST_OR_DENIAL_DRIFT");
});
test("D15.38 original private quote paths cannot be redirected",()=>{
  for(const [from,to] of [
    ['_internal/quoteEvidence/providerObservations/','users/owner/ledger/'],
    ['_internal/teamEvidence/providerSnapshots/','other/private/']
  ]){
    const x=current();x.receiptLink=x.receiptLink.replace(from,to);
    detect(x,"RECEIPT_PRIVATE_READ_OR_UNREVIEWED_GUARD_DRIFT");
  }
});
test("D15.38 read cannot bypass async backend internal review",()=>{
  const x=current();
  x.receiptLink=x.receiptLink.replace(
    "await isTrustedInternalReview(token,metadata)!==true",
    "await isTrustedInternalReview(token,metadata)!==false");
  detect(x,"RECEIPT_PRIVATE_READ_OR_UNREVIEWED_GUARD_DRIFT");
});
test("D15.38 immutable selector requirement rejects regression",()=>{
  const x=current();
  x.receiptLink=x.receiptLink.replace(
    "const metadata=Object.freeze({...selection});",
    "const metadata=selection;");
  detect(x,"RECEIPT_PRIVATE_READ_OR_UNREVIEWED_GUARD_DRIFT");
});
test("D15.38 private quote receipt cannot enable capture or bookmaker approval",()=>{
  for(const field of ["bookmakerVerified","espnPlayerVerified","autoLineSelected",
    "captureAllowed"]){
    const x=current();
    x.receiptLink=x.receiptLink.replace(field+":false",field+":true");
    detect(x,"RECEIPT_PRIVATE_READ_OR_UNREVIEWED_GUARD_DRIFT");
  }
});
test("D15.38 reader must not gain HTTP, scheduler, or Admin writes",()=>{
  for(const command of [
    'fetch("https://example.invalid");',
    'setInterval(()=>{},200);',
    "adminTx.create(ref,document);",
    "db.update(other,anything);"
  ]){
    const x=current();x.receiptLink+="\n"+command;
    detect(x,"RECEIPT_PRIVATE_READ_OR_UNREVIEWED_GUARD_DRIFT");
  }
});
test("D15.38 browser ledger write OR-rule reintroduction is blocked",()=>{
  for(const injected of [
    '\nmatch /{document=**} {allow write: if true;}',
    '\nallow create: if true;',
    '\nmatch /{document=**} { allow read: if true; }'
  ]){
    const x=current();x.rules+=injected;
    detect(x,"CLIENT_RESEARCH_WRITE_PROTECTION_DRIFT");
  }
});
test("D15.38 existing strict create-only quote storage remains guarded",()=>{
  const x=current();
  x.quoteStore=x.quoteStore.replace(
    'await tx.create(target,record)','await tx.set(target,record)');
  detect(x,"EXISTING_QUOTE_SOURCE_GUARDS_DRIFT");
});
test("D15.38 existing quote pipeline must remain default-off",()=>{
  const x=current();
  x.quotePipeline=x.quotePipeline.replace(
    'if (config.enabled!==true)','if (config.enabled===false)');
  detect(x,"EXISTING_QUOTE_SOURCE_GUARDS_DRIFT");
});
test("D15.38 no live cloud code, no provider calls, no credentials, no browser wiring",()=>{
  const source=fs.readFileSync(
    path.join(__dirname,"offline-player-collection-source-preflight.js"),"utf8");
  const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(prod,/offline-player-collection-source-preflight/);
  assert.doesNotMatch(source,
    /require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(source,
    /\b(?:fetch|onCall|onSchedule|setInterval|setTimeout)\s*\(/);
  assert.doesNotMatch(source,/\b(?:tx|db|adminTx)\.(?:set|update|create|delete)\s*\(/);
  assert.doesNotMatch(source,/apiKey\s*=/);
});
