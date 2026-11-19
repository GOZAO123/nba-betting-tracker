"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {spawnSync}=require("node:child_process");
const {EXPECTED,SOURCE_NAMES,PREFLIGHT,assessOfflineFunctionList:assess}=
  require("./offline-production-function-inventory");
const SOURCE=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
const HEADERS=["Function","Version","Trigger","Location","Memory","Runtime"];
const line=values=>"│ "+values.join(" │ ")+" │";
function table(rows=EXPECTED.map(name=>[
 name,"v2",name==="ledgerAutoSettleProspective"?"scheduled":"callable",
 "europe-west1","256","nodejs22"
])){
  return [
    "┌───────────────────┬─────────┬──────────┬──────────┬─────────┬──────────┐",
    line(HEADERS),
    "├───────────────────┼─────────┼──────────┼──────────┼─────────┼──────────┤",
    ...rows.map(line),
    "└───────────────────┴─────────┴──────────┴──────────┴─────────┴──────────┘"
  ].join("\n")+"\n";
}
function rows(){
 return EXPECTED.map(name=>[
 name,"v2",name==="ledgerAutoSettleProspective"?"scheduled":"callable",
 "europe-west1","256","nodejs22"
 ]);
}
const blocked=r=>{
 assert.equal(r.status,"BLOCKED");
 assert.equal(r.releaseReady,false);
 assert.equal(r.paidProviderAllowed,false);
 assert.equal(r.cloudChangesAuthorized,false);
 assert.equal(Object.isFrozen(r),true);
 assert.equal(Object.isFrozen(r.blockers),true);
};
const has=(r,b)=>assert.ok(r.blockers.includes(b),JSON.stringify(r.blockers));
test("D15.12 source inventory has exactly 14 exports plus separately deployed preflight",()=>{
 assert.equal(SOURCE_NAMES.length,14);
 assert.equal(EXPECTED.length,15);
 assert.equal(PREFLIGHT,"oddsPapiAccountPreflight");
 assert.equal(SOURCE_NAMES.includes(PREFLIGHT),false);
 const exports=[...SOURCE.matchAll(
  /exports\.([A-Za-z0-9_]+)\s*=\s*(?:onCall|onSchedule|onRequest)\s*\(/g
 )].map(m=>m[1]);
 assert.deepEqual([...SOURCE_NAMES].sort(),exports.sort());
});
test("D15.12 canonical 15-row, Node22, europe-west1 table matches inventory but BLOCKS release",()=>{
 const result=assess(table(),SOURCE);
 blocked(result);
 assert.equal(result.inventoryMatches,true);
 assert.equal(result.expectedCount,15);
 assert.equal(result.observedCount,15);
 assert.deepEqual(result.missing,[]);
 assert.deepEqual(result.mismatched,[]);
 assert.equal(result.unexpectedCount,0);
 assert.deepEqual(result.blockers,[
  "LIVE_CLOUD_RUN_REVISIONS_NOT_ATTESTED",
  "LIVE_SERVICE_ACCOUNT_IAM_NOT_ATTESTED",
  "SEPARATELY_DEPLOYED_PREFLIGHT_SOURCE_NOT_ATTESTED",
  "SECRET_MANAGER_ETAG_AND_RESOURCE_IAM_NOT_ATTESTED",
  "BILLING_AND_CLOUD_COSTS_NOT_ATTESTED",
  "ALL_PAID_CALLERS_MIGRATION_NOT_ATTESTED",
  "OWNER_APPROVAL_FOR_CLOUD_CHANGES_NOT_GRANTED"
 ]);
});
test("D15.12 missing preflight blocks even if 14 current GitHub exports match",()=>{
 const copy=rows().filter(r=>r[0]!==PREFLIGHT);
 const result=assess(table(copy),SOURCE);blocked(result);
 assert.equal(result.inventoryMatches,false);
 assert.deepEqual(result.missing,[PREFLIGHT]);
 has(result,"FUNCTION_LIST_COUNT_MISMATCH");
 has(result,"EXPECTED_FUNCTIONS_MISSING");
});
test("D15.12 missing enabled diagnostic blocks live inventory verification",()=>{
 const copy=rows().filter(r=>r[0]!=="oddsPapiNbaIdentitySchemaDiagnostic");
 const result=assess(table(copy),SOURCE);blocked(result);
 has(result,"EXPECTED_FUNCTIONS_MISSING");
});
test("D15.12 unknown or renamed production callable is never considered expected",()=>{
 const copy=rows();copy[0][0]="unexpectedPaidProviderProbe";
 const result=assess(table(copy),SOURCE);blocked(result);
 assert.equal(result.inventoryMatches,false);
 assert.equal(result.unexpectedCount,1);
 assert.equal(result.missing.includes(EXPECTED[0]),true);
 has(result,"UNEXPECTED_FUNCTIONS_PRESENT");
});
test("D15.12 duplicate function rows fail closed even when the count is 15",()=>{
 const copy=rows();copy[0]=[...copy[1]];
 const result=assess(table(copy),SOURCE);blocked(result);
 has(result,"DUPLICATE_FUNCTION_ROWS");
 has(result,"EXPECTED_FUNCTIONS_MISSING");
});
test("D15.12 wrong region is detected without assuming hidden cloud state",()=>{
 const copy=rows();copy[0][3]="us-central1";
 const result=assess(table(copy),SOURCE);blocked(result);
 has(result,"FUNCTION_RUNTIME_REGION_OR_TRIGGER_MISMATCH");
 assert.deepEqual(result.mismatched,[EXPECTED[0]]);
});
test("D15.12 runtime drift from Node 22 is detected",()=>{
 const copy=rows();copy[0][5]="nodejs20";
 const result=assess(table(copy),SOURCE);blocked(result);
 has(result,"FUNCTION_RUNTIME_REGION_OR_TRIGGER_MISMATCH");
});
test("D15.12 version v1 and unexpected memory reject release",()=>{
 for(const [idx,value] of [[1,"v1"],[4,"16384"]]){
   const copy=rows();copy[0][idx]=value;
   const result=assess(table(copy),SOURCE);blocked(result);
   has(result,"FUNCTION_RUNTIME_REGION_OR_TRIGGER_MISMATCH");
 }
});
test("D15.12 schedule/Callable semantics cannot be swapped",()=>{
 for(const [name,trigger] of [
   ["ledgerAutoSettleProspective","callable"],
   ["oddsPapiNbaMarketAudit","scheduled"]
 ]){
   const copy=rows();copy.find(r=>r[0]===name)[2]=trigger;
   const result=assess(table(copy),SOURCE);blocked(result);
   has(result,"FUNCTION_RUNTIME_REGION_OR_TRIGGER_MISMATCH");
 }
});
test("D15.12 header mismatch and non-table text are visible blockers",()=>{
 for(const content of [
   table().replace("Function │","Functions │"),
   table()+"PS F:\\Documents> echo PRIVATE_TOKEN\n",
   table().replace("│ "+EXPECTED[0]+" │","NONSENSE "+EXPECTED[0]+" │")
 ]){
   const result=assess(content,SOURCE);blocked(result);
   assert.equal(result.inventoryMatches,false);
 }
});
test("D15.12 oversize and malformed table input cannot become a passing inventory",()=>{
 for(const input of [
   "",null,undefined,[],{},42,"x".repeat(18001),
   table()+ "\n".repeat(70)+"Extra\n"
 ]){
  const result=assess(input,SOURCE);blocked(result);
  assert.equal(result.inventoryMatches,false);
 }
});
test("D15.12 checked-out source export drift fails even with a perfect CLI table",()=>{
 const source=SOURCE.replace("exports.oddsBackendStatus = onCall(",
  "exports.otherStatus = onCall(");
 const result=assess(table(),source);blocked(result);
 has(result,"GITHUB_FUNCTION_EXPORTS_DRIFT");
});
test("D15.12 enabling identity or changing six-slot quota blocks inventory review",()=>{
 for(const mutated of [
  SOURCE.replace("const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;",
    "const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = true;"),
  SOURCE.replace("const NBA_PROVIDER_EVIDENCE_ENABLED = false;",
    "const NBA_PROVIDER_EVIDENCE_ENABLED = true;"),
  SOURCE.replace("const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;",
    "const ODDSPAPI_REQUESTS_PER_UTC_DAY = 12;")
 ]){
  const result=assess(table(),mutated);blocked(result);
  has(result,"PRODUCTION_QUOTA_OR_DIAGNOSTIC_GATES_DRIFT");
 }
});
test("D15.12 unknown malicious row text is never reflected in the safe result",()=>{
 const privateMarker="SYNTHETIC_PRIVATE_TOKEN_OR_UID";
 const copy=rows();copy.push([privateMarker,"v2","callable",
  "europe-west1","256","nodejs22"]);
 const result=assess(table(copy),SOURCE);blocked(result);
 assert.equal(JSON.stringify(result).includes(privateMarker),false);
 assert.equal(result.unexpectedCount,1);
});
test("D15.12 local CLI reads stdin and returns sanitized, BLOCKED JSON only",()=>{
 const cli=path.join(__dirname,"offline-production-inventory-cli.js");
 const result=spawnSync(process.execPath,[cli],{
  input:table(),encoding:"utf8",timeout:5000
 });
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stderr,"");
 const report=JSON.parse(result.stdout);
 assert.equal(report.status,"BLOCKED");
 assert.equal(report.releaseReady,false);
 assert.equal(report.paidProviderAllowed,false);
 assert.equal(report.cloudChangesAuthorized,false);
 assert.equal(report.inventoryMatches,true);
 assert.equal(report.expectedCount,15);
 assert.equal(report.observedCount,15);
 assert.ok(report.blockers.includes("OWNER_APPROVAL_FOR_CLOUD_CHANGES_NOT_GRANTED"));
});
test("D15.12 CLI rejects unknown names without printing them",()=>{
 const privateMarker="PRIVATE_TEST_BEARER_TOKEN";
 const copy=rows();copy.push([privateMarker,"v2","callable",
  "europe-west1","256","nodejs22"]);
 const cli=path.join(__dirname,"offline-production-inventory-cli.js");
 const result=spawnSync(process.execPath,[cli],{
   input:table(copy),encoding:"utf8",timeout:5000
 });
 assert.equal(result.status,2);
 assert.doesNotMatch(result.stdout,new RegExp(privateMarker));
 const report=JSON.parse(result.stdout);
 assert.equal(report.inventoryMatches,false);
});
test("D15.12 CLI never accepts user-supplied file paths as arguments",()=>{
 const cli=path.join(__dirname,"offline-production-inventory-cli.js");
 const result=spawnSync(process.execPath,[cli,"--read-credentials"],{
  input:table(),encoding:"utf8",timeout:5000
 });
 assert.equal(result.status,2);
 assert.equal(JSON.parse(result.stdout).status,"BLOCKED");
 assert.doesNotMatch(result.stdout,/private_key|ODDSPAPI_API_KEY/);
});
test("D15.12 module is inert and never touched by Firebase entrypoint",()=>{
 const code=fs.readFileSync(path.join(__dirname,
  "offline-production-function-inventory.js"),"utf8");
 const cli=fs.readFileSync(path.join(__dirname,
  "offline-production-inventory-cli.js"),"utf8");
 assert.doesNotMatch(SOURCE,/offline-production-function-inventory|offline-production-inventory-cli/);
 assert.doesNotMatch(code,/\bfetch\(|onCall\(|onRequest\(|setInterval\(|firebase-admin|google-auth-library/);
 assert.doesNotMatch(cli,/\bfetch\(|onCall\(|onRequest\(|setInterval\(|firebase-admin|google-auth-library/);
});
