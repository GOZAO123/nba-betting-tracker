"use strict";

// D15.9 OFFLINE architecture safety gate. NOT imported by Firebase exports.
// This assesses proposed *designs*, not live IAM policies, deployed revisions,
// account ownership, Firestore content or billing. It NEVER authorizes rollout.
const OPTIONS=Object.freeze({
  UNDECIDED:"UNDECIDED",
  NEW_PRINCIPAL_DEFAULT_DATABASE:"NEW_PRINCIPAL_DEFAULT_DATABASE",
  REUSE_PRIVILEGED_BUDGET_RUNTIME:"REUSE_PRIVILEGED_BUDGET_RUNTIME",
  ISOLATED_NAMED_DATABASE:"ISOLATED_NAMED_DATABASE"
});
const HARD_BLOCKERS=Object.freeze([
  "OWNER_DEPLOYMENT_APPROVAL_REQUIRED",
  "LIVE_IAM_AND_BILLING_ATTESTATION_REQUIRED",
  "REAL_GOOGLE_ID_TOKEN_AND_PRIVATE_INVOKER_UNVERIFIED",
  "PROVIDER_FREE_CLOUD_REHEARSAL_UNVERIFIED"
]);
const RECORD=x=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
  (Object.getPrototypeOf(x)===Object.prototype||
   Object.getPrototypeOf(x)===null);
const has=(text,re)=>typeof text==="string"&&re.test(text);
const must=Object.freeze([
  ["SIX_SLOT_SHARED_TRANSACTION_NOT_VERIFIED",s=>
    has(s,/const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;/)&&
    has(s,/async function reserveDiagnosticRequests\(amount\)/)&&
    has(s,/db\.doc\("_internal\/oddsPapiDailyDiagnosticBudget"\)/)&&
    has(s,/db\.runTransaction\(/)&&
    has(s,/reserved \+ amount > ODDSPAPI_REQUESTS_PER_UTC_DAY/)],
  ["IDENTITY_DIAGNOSTIC_NOT_HARD_DISABLED",s=>
    has(s,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/)],
  ["PROVIDER_EVIDENCE_NOT_HARD_DISABLED",s=>
    has(s,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/)],
  ["DEDICATED_CALLER_IDENTITY_NOT_PINNED",s=>
    has(s,/serviceAccount: "nba-identity-schema@nba-betting-tracker-3979d\.iam\.gserviceaccount\.com"/)],
  ["STAGED_BROKER_NOT_INERT",s=>
    !has(s,/require\(["']\.\/offline-identity-quota-(?:broker|ingress|caller|google-auth|google-verify|firestore-reserve|http-handler)["']\)/)]
]);
const validEvidence=e=>e===undefined||
  (RECORD(e)&&Object.keys(e).every(k=>[
    "ownerRiskAcknowledgment","costReviewCompleted",
    "allPaidCallersMigrationReviewed","freezeAndRollbackReviewed",
    "newRuntimeDataAccessReviewed","privateServiceIamReviewed",
    "existingEditorRiskReviewed"
  ].includes(k)&&typeof e[k]==="boolean"));

function assessOfflineQuotaTopology({topology=OPTIONS.UNDECIDED,
  productionSource,evidence}={}){
  const blockers=[];
  const add=x=>{if(!blockers.includes(x))blockers.push(x);};
  if(!Object.values(OPTIONS).includes(topology)||!validEvidence(evidence)){
    add("INVALID_OFFLINE_ARCHITECTURE_REVIEW");
    return Object.freeze({status:"BLOCKED",releaseReady:false,
      providerRequestAllowed:false,topology:"INVALID",
      blockers:Object.freeze(blockers)});
  }
  for(const [code,check] of must)
    if(!check(productionSource))add(code);
  const e=evidence||{};
  if(topology===OPTIONS.UNDECIDED){
    add("QUOTA_AUTHORITY_TOPOLOGY_UNDECIDED");
  }else if(topology===OPTIONS.NEW_PRINCIPAL_DEFAULT_DATABASE){
    // Do NOT allow self-declared risk acceptance to bypass document-privacy
    // concern; native Firestore IAM conditions scope at DATABASE not DOC.
    add("NEW_PRINCIPAL_CAN_ACCESS_OTHER_DEFAULT_DATABASE_DOCUMENTS");
    add("FIRESTORE_DOCUMENT_LEVEL_IAM_IS_NOT_SUPPORTED");
    if(e.newRuntimeDataAccessReviewed!==true)
      add("NEW_RUNTIME_ACCESS_REVIEW_REQUIRED");
  }else if(topology===OPTIONS.REUSE_PRIVILEGED_BUDGET_RUNTIME){
    // No new database grant, but the *existing* default runtime is project
    // Editor. A new request surface would expose this broad authority.
    add("EXISTING_EDITOR_RUNTIME_EXPOSES_PROJECT_WIDE_PRIVILEGE");
    if(e.existingEditorRiskReviewed!==true)
      add("EXISTING_EDITOR_RUNTIME_RISK_REVIEW_REQUIRED");
    if(e.privateServiceIamReviewed!==true)
      add("NEW_PRIVATE_ENDPOINT_IAM_REVIEW_REQUIRED");
  }else if(topology===OPTIONS.ISOLATED_NAMED_DATABASE){
    // One free Firestore database per project. A second one can charge.
    // A second independent daily counter is FORBIDDEN until *every* paid
    // diagnostic uses the same authority at a coordinated safe cutover.
    add("ADDITIONAL_FIRESTORE_DATABASE_HAS_NO_FREE_TIER");
    if(e.costReviewCompleted!==true)
      add("NAMED_DATABASE_BILLING_APPROVAL_REQUIRED");
    if(e.allPaidCallersMigrationReviewed!==true)
      add("ALL_PAID_CALLERS_MUST_SHARE_ONE_COUNTER");
    if(e.freezeAndRollbackReviewed!==true)
      add("ATOMICITY_GAP_REQUIRES_FAIL_CLOSED_CUTOVER");
  }
  if(e.ownerRiskAcknowledgment!==true)add("OWNER_TOPOLOGY_DECISION_REQUIRED");
  for(const code of HARD_BLOCKERS)add(code);
  return Object.freeze({status:"BLOCKED",releaseReady:false,
    providerRequestAllowed:false,topology,
    blockers:Object.freeze(blockers)});
}
module.exports=Object.freeze({OPTIONS,assessOfflineQuotaTopology});
