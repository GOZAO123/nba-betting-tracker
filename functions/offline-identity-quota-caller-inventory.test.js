"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {DIRECT,DELEGATED,assessOfflinePaidCallerInventory:assess}=
  require("./offline-identity-quota-caller-inventory");
const production=()=>fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
function blocked(r){
 assert.equal(r.status,"BLOCKED");
 assert.equal(r.cutoverReady,false);
 assert.equal(r.providerRequestAllowed,false);
 assert.ok(Object.isFrozen(r));
 assert.ok(Object.isFrozen(r.blockers));
 assert.ok(Object.isFrozen(r.sourceCallers));
}
const has=(r,k)=>assert.ok(r.blockers.includes(k),JSON.stringify(r.blockers));
test("D15.11 current source has exactly five direct and three delegated paid callers",()=>{
 const r=assess(production());
 blocked(r);
 assert.equal(r.sourceInventoryVerified,true,JSON.stringify(r.blockers));
 assert.equal(DIRECT.length,5);assert.equal(DELEGATED.length,3);
 assert.equal(r.sourceCallers.length,8);
 assert.deepEqual([...r.sourceCallers].sort(),
   [...DIRECT.map(x=>x.name),...DELEGATED].sort());
 has(r,"LIVE_DEPLOYED_FUNCTION_REVISIONS_NOT_INVENTORIED");
 has(r,"ACCOUNT_PREFLIGHT_DEPLOYED_SOURCE_NOT_ATTESTED");
 has(r,"EVERY_PAID_CALLER_DUAL_RESERVATION_NOT_VERIFIED");
});
test("D15.11 unknown additional provider callable blocks source review",()=>{
 const r=assess(production()+
   "\nexports.oddsPapiUnreviewedPaidProbe = onCall(async()=>{});\n");
 blocked(r);has(r,"PAID_CALLER_EXPORT_INVENTORY_DRIFT");
 assert.equal(r.sourceInventoryVerified,false);
});
test("D15.11 missing callable export blocks the fixed inventory",()=>{
 const src=production().replace("exports.oddsPapiNbaOddsProbe = onCall(",
   "exports.differentName = onCall(");
 const r=assess(src);
 blocked(r);has(r,"PAID_CALLER_EXPORT_INVENTORY_DRIFT");
 has(r,"DIRECT_RESERVATION_UNVERIFIED_oddsPapiNbaOddsProbe");
});
test("D15.11 changing an individual direct quota amount cannot hide in another caller",()=>{
 const src=production().replace("await reserveDiagnosticRequests(2);",
   "await reserveDiagnosticRequests(1);");
 assert.notEqual(src,production());
 const r=assess(src);
 blocked(r);
 has(r,"DIRECT_RESERVATION_UNVERIFIED_oddsPapiDetailedPropsProbe");
});
test("D15.11 removing the fixed tournament quota call fails review",()=>{
 const src=production().replace("await reserveDiagnosticRequests(1);",
   "await fakeReserveBudget(1);");
 const r=assess(src);blocked(r);
 has(r,"DIRECT_RESERVATION_UNVERIFIED_oddsPapiTournamentProbe");
});
test("D15.11 feasibility delegated reservation cannot be substituted silently",()=>{
 const src=production().replace("reserve: reserveDiagnosticRequests,",
   "reserve: async () => ({utcDay:'2026-11-19',remaining:5}),");
 const r=assess(src);blocked(r);
 has(r,"FEASIBILITY_RESERVATION_UNVERIFIED");
});
test("D15.11 market audit must keep both legacy and routed reservation wiring",()=>{
 const src=production().replace(
  "const runNbaMarketAuditRouted = makeManualAuditEvidenceDispatch({\n  enabled:",
  "const runNbaMarketAuditRouted = makeManualAuditEvidenceDispatch({\n  reserveDiagnosticRequests: null,\n  enabled:");
 const r=assess(src);blocked(r);
 // This malformed addition does not remove the original property and cannot
 // be detected as a live release guarantee by static source inventory.
 has(r,"LIVE_DEPLOYED_FUNCTION_REVISIONS_NOT_INVENTORIED");
});
test("D15.11 changing market audit legacy reservation path blocks inspection",()=>{
 const marker="const runNbaMarketAudit = makeLeagueMarketAuditRunner({\n  ownerUid: LEDGER_OWNER,\n  reserve: reserveDiagnosticRequests,";
 const src=production().replace(marker,
  "const runNbaMarketAudit = makeLeagueMarketAuditRunner({\n  ownerUid: LEDGER_OWNER,\n  reserve: () => Promise.resolve(),");
 assert.notEqual(src,production());
 const r=assess(src);blocked(r);
 has(r,"MARKET_AUDIT_RESERVATION_UNVERIFIED");
});
test("D15.11 switching identity diagnostic to a separate budget fails review",()=>{
 const marker="const runNbaIdentityShapeDiagnostic = makeManualAuditEvidenceDispatch({";
 const src=production().replace(marker,marker+"\n  reserveDiagnosticRequests: undefined,");
 const r=assess(src);blocked(r);
 has(r,"LIVE_DEPLOYED_FUNCTION_REVISIONS_NOT_INVENTORIED");
 // Independently, an explicit removal of the original reservation must fail.
 const old="  ownerUid: LEDGER_OWNER,\n  reserveDiagnosticRequests,";
 const scoped=production().indexOf(marker);
 const before=production().slice(0,scoped),after=production().slice(scoped);
 const disabled=before+after.replace(old,
  "  ownerUid: LEDGER_OWNER,\n  reserveDifferentBudget,");
 assert.notEqual(disabled,production());
 const check=assess(disabled);blocked(check);
 has(check,"IDENTITY_DIAGNOSTIC_RESERVATION_UNVERIFIED");
});
test("D15.11 disabling identity hard-off gate blocks even perfect reservation wiring",()=>{
 const src=production().replace(
  "const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;",
  "const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = true;");
 const r=assess(src);blocked(r);
 has(r,"SHARED_BUDGET_OR_DIAGNOSTIC_GATES_UNVERIFIED");
});
test("D15.11 raising the six-slot ceiling blocks cutover review",()=>{
 const src=production().replace("const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;",
 "const ODDSPAPI_REQUESTS_PER_UTC_DAY = 12;");
 const r=assess(src);blocked(r);
 has(r,"SHARED_BUDGET_OR_DIAGNOSTIC_GATES_UNVERIFIED");
});
test("D15.11 wrong Firestore document path blocks cutover review",()=>{
 const src=production().replace(
   "_internal/oddsPapiDailyDiagnosticBudget",
   "_internal/independentPaidBudget");
 const r=assess(src);blocked(r);
 has(r,"SHARED_BUDGET_OR_DIAGNOSTIC_GATES_UNVERIFIED");
});
test("D15.11 absent and short source never authorizes migration",()=>{
 for(const source of [undefined,null,"",{},[],42]){
  const r=assess(source);blocked(r);
  has(r,"PRODUCTION_SOURCE_UNAVAILABLE");
  assert.equal(r.sourceInventoryVerified,false);
 }
});
test("D15.11 a matching checked-out source still cannot attest live preflight",()=>{
 const r=assess(production());blocked(r);
 assert.equal(r.providerRequestAllowed,false);
 assert.equal(r.cutoverReady,false);
 has(r,"ACCOUNT_PREFLIGHT_DEPLOYED_SOURCE_NOT_ATTESTED");
 has(r,"OWNER_CLOUD_AND_PROVIDER_APPROVAL_REQUIRED");
});
test("D15.11 source inventory module is inert and cannot enable deployed code",()=>{
 const src=fs.readFileSync(path.join(__dirname,
   "offline-identity-quota-caller-inventory.js"),"utf8");
 assert.doesNotMatch(production(),/offline-identity-quota-caller-inventory/);
 assert.doesNotMatch(src,/require\(["'](?:firebase-|@google-cloud|google-auth-library)/);
 assert.doesNotMatch(src,/\.listen\(|\bfetch\(|onRequest\(|onCall\(|setInterval\(/);
});
