"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {OPTIONS,assessOfflineQuotaTopology:assess}=
  require("./offline-identity-quota-topology-review");
const actual=()=>fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
const choice=(topology=OPTIONS.UNDECIDED,evidence={},productionSource=actual())=>
  assess({topology,productionSource,evidence});
const blocked=r=>{
  assert.equal(r.status,"BLOCKED");
  assert.equal(r.releaseReady,false);
  assert.equal(r.providerRequestAllowed,false);
  assert.ok(Array.isArray(r.blockers)&&r.blockers.length>0);
  assert.equal(Object.isFrozen(r),true);
  assert.equal(Object.isFrozen(r.blockers),true);
};
const has=(r,code)=>assert.ok(r.blockers.includes(code),JSON.stringify(r));

test("D15.9 actual main code stays hard-off with one shared six-slot transaction",()=>{
 const r=choice();blocked(r);
 assert.equal(r.topology,"UNDECIDED");
 has(r,"QUOTA_AUTHORITY_TOPOLOGY_UNDECIDED");
 for(const x of [
 "SIX_SLOT_SHARED_TRANSACTION_NOT_VERIFIED",
 "IDENTITY_DIAGNOSTIC_NOT_HARD_DISABLED",
 "PROVIDER_EVIDENCE_NOT_HARD_DISABLED",
 "DEDICATED_CALLER_IDENTITY_NOT_PINNED",
 "STAGED_BROKER_NOT_INERT"])
   assert.equal(r.blockers.includes(x),false,x);
});
test("D15.9 new service principal on default database is blocked even if all reviews self-asserted",()=>{
 const e={ownerRiskAcknowledgment:true,newRuntimeDataAccessReviewed:true,
   privateServiceIamReviewed:true,costReviewCompleted:true};
 const r=choice(OPTIONS.NEW_PRINCIPAL_DEFAULT_DATABASE,e);
 blocked(r);
 has(r,"NEW_PRINCIPAL_CAN_ACCESS_OTHER_DEFAULT_DATABASE_DOCUMENTS");
 has(r,"FIRESTORE_DOCUMENT_LEVEL_IAM_IS_NOT_SUPPORTED");
 has(r,"OWNER_DEPLOYMENT_APPROVAL_REQUIRED");
});
test("D15.9 default-database new principal requires access review",()=>{
 const r=choice(OPTIONS.NEW_PRINCIPAL_DEFAULT_DATABASE);
 blocked(r);has(r,"NEW_RUNTIME_ACCESS_REVIEW_REQUIRED");
});
test("D15.9 reused privileged runtime is NOT safe merely because no new IAM role is granted",()=>{
 const r=choice(OPTIONS.REUSE_PRIVILEGED_BUDGET_RUNTIME);
 blocked(r);
 has(r,"EXISTING_EDITOR_RUNTIME_EXPOSES_PROJECT_WIDE_PRIVILEGE");
 has(r,"EXISTING_EDITOR_RUNTIME_RISK_REVIEW_REQUIRED");
 has(r,"NEW_PRIVATE_ENDPOINT_IAM_REVIEW_REQUIRED");
});
test("D15.9 IAM attestation cannot override the current Editor runtime risk",()=>{
 const r=choice(OPTIONS.REUSE_PRIVILEGED_BUDGET_RUNTIME,{
   ownerRiskAcknowledgment:true,privateServiceIamReviewed:true,
   existingEditorRiskReviewed:true});
 blocked(r);
 has(r,"EXISTING_EDITOR_RUNTIME_EXPOSES_PROJECT_WIDE_PRIVILEGE");
 has(r,"LIVE_IAM_AND_BILLING_ATTESTATION_REQUIRED");
});
test("D15.9 additional named quota database requires cost and coordinated budget migration",()=>{
 const r=choice(OPTIONS.ISOLATED_NAMED_DATABASE);
 blocked(r);
 has(r,"ADDITIONAL_FIRESTORE_DATABASE_HAS_NO_FREE_TIER");
 has(r,"NAMED_DATABASE_BILLING_APPROVAL_REQUIRED");
 has(r,"ALL_PAID_CALLERS_MUST_SHARE_ONE_COUNTER");
 has(r,"ATOMICITY_GAP_REQUIRES_FAIL_CLOSED_CUTOVER");
});
test("D15.9 simulated completed named-db approvals do not imply real deployment readiness",()=>{
 const r=choice(OPTIONS.ISOLATED_NAMED_DATABASE,{
   ownerRiskAcknowledgment:true,costReviewCompleted:true,
   allPaidCallersMigrationReviewed:true,freezeAndRollbackReviewed:true});
 blocked(r);
 has(r,"ADDITIONAL_FIRESTORE_DATABASE_HAS_NO_FREE_TIER");
 has(r,"OWNER_DEPLOYMENT_APPROVAL_REQUIRED");
 has(r,"PROVIDER_FREE_CLOUD_REHEARSAL_UNVERIFIED");
});
test("D15.9 any loss of literal disabled identity flag fails review",()=>{
 const src=actual().replace(
   "const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;",
   "const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = true;");
 assert.notEqual(src,actual());
 const r=choice(OPTIONS.UNDECIDED,{},src);
 blocked(r);has(r,"IDENTITY_DIAGNOSTIC_NOT_HARD_DISABLED");
});
test("D15.9 evidence flag loss fails review",()=>{
 const src=actual().replace(
   "const NBA_PROVIDER_EVIDENCE_ENABLED = false;",
   "const NBA_PROVIDER_EVIDENCE_ENABLED = true;");
 const r=choice(undefined,{},src);
 blocked(r);has(r,"PROVIDER_EVIDENCE_NOT_HARD_DISABLED");
});
test("D15.9 alteration of six-per-UTC-day ceiling is blocked",()=>{
 const src=actual().replace(
   "const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;",
   "const ODDSPAPI_REQUESTS_PER_UTC_DAY = 12;");
 const r=choice(undefined,{},src);
 blocked(r);has(r,"SIX_SLOT_SHARED_TRANSACTION_NOT_VERIFIED");
});
test("D15.9 change to shared quota document path blocks approval",()=>{
 const src=actual().replace("_internal/oddsPapiDailyDiagnosticBudget",
   "_internal/alternateQuotaDoc");
 const r=choice(undefined,{},src);
 blocked(r);has(r,"SIX_SLOT_SHARED_TRANSACTION_NOT_VERIFIED");
});
test("D15.9 removal of transaction guard blocks review",()=>{
 const src=actual().replace("db.runTransaction(", "db.fakeTransaction(");
 const r=choice(undefined,{},src);
 blocked(r);has(r,"SIX_SLOT_SHARED_TRANSACTION_NOT_VERIFIED");
});
test("D15.9 changing the dedicated diagnostic identity fails review",()=>{
 const src=actual().replace("nba-identity-schema@nba-betting-tracker-3979d.iam.gserviceaccount.com",
   "default-compute@invalid.example");
 const r=choice(undefined,{},src);
 blocked(r);has(r,"DEDICATED_CALLER_IDENTITY_NOT_PINNED");
});
test("D15.9 connecting offline broker into index without review fails safety gate",()=>{
 const src=actual()+'\nrequire("./offline-identity-quota-http-handler");\n';
 const r=choice(undefined,{},src);
 blocked(r);has(r,"STAGED_BROKER_NOT_INERT");
});
test("D15.9 unsupported architecture values and unexpected evidence fields fail closed",()=>{
 for(const topology of [
   "",null,"DOCUMENT_SCOPED_IAM","default","ALL_USERS",
   "NEW_PRINCIPAL_DEFAULT_DATABASE "
 ]){
   const r=choice(topology);
   blocked(r);has(r,"INVALID_OFFLINE_ARCHITECTURE_REVIEW");
 }
 for(const evidence of [{deploymentApproved:true},{ownerRiskAcknowledgment:"true"},
   {costReviewCompleted:1},[], "approved",null]){
   const r=choice(OPTIONS.ISOLATED_NAMED_DATABASE,evidence);
   blocked(r);has(r,"INVALID_OFFLINE_ARCHITECTURE_REVIEW");
 }
});
test("D15.9 synthetic approval booleans cannot grant metered OddsPapi authority",()=>{
 const all={ownerRiskAcknowledgment:true,costReviewCompleted:true,
   allPaidCallersMigrationReviewed:true,freezeAndRollbackReviewed:true,
   newRuntimeDataAccessReviewed:true,privateServiceIamReviewed:true,
   existingEditorRiskReviewed:true};
 for(const topology of Object.values(OPTIONS)){
  const r=choice(topology,all);
  blocked(r);
  assert.equal(r.providerRequestAllowed,false);
  has(r,"OWNER_DEPLOYMENT_APPROVAL_REQUIRED");
  has(r,"REAL_GOOGLE_ID_TOKEN_AND_PRIVATE_INVOKER_UNVERIFIED");
 }
});
test("D15.9 malformed proxies and getters fail closed without side effects",()=>{
 const throwing={get ownerRiskAcknowledgment(){
   throw Error("PRIVATE_OWNER_AUTH_TOKEN");
 }};
 const inputs=[
   null,[],0,"review",
   {topology:OPTIONS.UNDECIDED,productionSource:actual(),evidence:throwing},
   {get topology(){throw Error("PRIVATE_CONFIG");}},
   new Proxy({}, {getPrototypeOf(){throw Error("PRIVATE_PROXY");}})
 ];
 for(const input of inputs){
   let r;
   assert.doesNotThrow(()=>{r=assess(input);});
   blocked(r);
   has(r,"INVALID_OFFLINE_ARCHITECTURE_REVIEW");
 }
});
test("D15.9 code remains disconnected from deployed Functions",()=>{
 const source=fs.readFileSync(path.join(__dirname,
  "offline-identity-quota-topology-review.js"),"utf8");
 const index=actual();
 assert.doesNotMatch(index,/require\(["']\.\/offline-identity-quota-topology-review["']\)/);
 assert.doesNotMatch(source,/require\(["'](?:firebase-|google-auth-library)/);
 assert.doesNotMatch(source,/fetch\(|setInterval\(|onRequest\(|onCall\(/);
});
