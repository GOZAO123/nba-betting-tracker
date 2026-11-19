"use strict";

// D15.12 OFFLINE-only review of the pasted, read-only Firebase CLI table.
// NO Firebase/Google libraries, network, project API, credentials, or
// production entrypoint imports. A matching inventory NEVER authorizes IAM,
// deployments, quota migration, or metered OddsPapi diagnostics.
const REGION="europe-west1";
const RUNTIME="nodejs22";
const SOURCE_NAMES=Object.freeze([
 "oddsBackendStatus","oddsPapiTournamentProbe","oddsPapiNbaOddsProbe",
 "oddsPapiDetailedPropsProbe","oddsPapiMarketCatalogProbe",
 "oddsPapiVerifiedPropsProbe","oddsPapiNbaFeasibilityProbe",
 "oddsPapiNbaMarketAudit","oddsPapiNbaIdentitySchemaDiagnostic",
 "ledgerCaptureProspective","ledgerBatchCaptureProspective",
 "ledgerSettleProspective","ledgerAutoSettleProspective",
 "ledgerReconcileReviewedInactive"
]);
const PREFLIGHT="oddsPapiAccountPreflight"; // separately deployed; not in main
const EXPECTED=Object.freeze([...SOURCE_NAMES,PREFLIGHT]);
const HEADERS=Object.freeze(["Function","Version","Trigger","Location","Memory","Runtime"]);
const EXTERNAL_BLOCKERS=Object.freeze([
 "LIVE_CLOUD_RUN_REVISIONS_NOT_ATTESTED",
 "LIVE_SERVICE_ACCOUNT_IAM_NOT_ATTESTED",
 "SEPARATELY_DEPLOYED_PREFLIGHT_SOURCE_NOT_ATTESTED",
 "SECRET_MANAGER_ETAG_AND_RESOURCE_IAM_NOT_ATTESTED",
 "BILLING_AND_CLOUD_COSTS_NOT_ATTESTED",
 "ALL_PAID_CALLERS_MIGRATION_NOT_ATTESTED",
 "OWNER_APPROVAL_FOR_CLOUD_CHANGES_NOT_GRANTED"
]);

function assessOfflineFunctionList(table,source){
 const blockers=[],missing=[],mismatched=[];
 const add=x=>{if(!blockers.includes(x))blockers.push(x);};
 const fail=()=>({
   status:"BLOCKED",releaseReady:false,paidProviderAllowed:false,
   cloudChangesAuthorized:false,inventoryMatches:false,
   expectedCount:EXPECTED.length,observedCount:0,
   missing:Object.freeze([...EXPECTED]),mismatched:Object.freeze([]),
   unexpectedCount:0,blockers:Object.freeze([...blockers,...EXTERNAL_BLOCKERS])
 });
 if(typeof table!=="string"||table.length===0||table.length>18000||
    typeof source!=="string"||source.length<1000||source.length>300000){
   add("OFFLINE_INVENTORY_INPUT_UNAVAILABLE");
   return Object.freeze(fail());
 }
 // Compare the expected source exports with the actual main entrypoint.
 // The preflight is known to be deployed separately and intentionally absent.
 const exports=[...source.matchAll(
   /exports\.([A-Za-z0-9_]+)\s*=\s*(?:onCall|onSchedule|onRequest)\s*\(/g
 )].map(x=>x[1]);
 if(exports.length!==SOURCE_NAMES.length||
    exports.some(x=>!SOURCE_NAMES.includes(x))||
    SOURCE_NAMES.some(x=>exports.filter(y=>y===x).length!==1)||
    exports.includes(PREFLIGHT))
   add("GITHUB_FUNCTION_EXPORTS_DRIFT");
 if(!source.includes("const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;")||
    !source.includes("const NBA_PROVIDER_EVIDENCE_ENABLED = false;")||
    !source.includes("const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;"))
   add("PRODUCTION_QUOTA_OR_DIAGNOSTIC_GATES_DRIFT");

 // Firebase CLI emits ANSI SGR colours (e.g. ESC[90m) even when piped.
 // Remove ONLY bounded Select Graphic Rendition codes, not cursor movement,
 // erased-screen controls or arbitrary escape sequences. Unrecognised output
 // still fails the strict Unicode table structure checks below.
 const lines=table.split(/\r?\n/).map(
   line=>line.replace(/\x1b\[[0-9;]{0,32}m/g,"")
 );
 if(lines.length>65)add("FUNCTION_LIST_INPUT_TOO_MANY_LINES");
 let headerCount=0,rows=[],unsupported=0;
 for(const line of lines){
   const text=line.trim();
   if(!text)continue;
   // Firebase CLI unicode table border and separator characters.
   if(/^[┌┬┐├┼┤└┴┘─━═╞╪╡╔╦╗╚╩╝╠╬╣]+$/.test(text))
     continue;
   if(!(text.startsWith("│")&&text.endsWith("│"))){
     unsupported++;continue;
   }
   const cells=text.slice(1,-1).split("│").map(x=>x.trim());
   if(cells.length!==HEADERS.length){
     unsupported++;continue;
   }
   if(cells[0]==="Function"){
     headerCount++;
     if(!HEADERS.every((v,i)=>cells[i]===v))add("FUNCTION_LIST_HEADER_MISMATCH");
   }else{
     rows.push(cells);
   }
 }
 if(headerCount!==1)add("FUNCTION_LIST_HEADER_MISMATCH");
 if(unsupported>0)add("FUNCTION_LIST_UNKNOWN_LINES");
 if(rows.length!==EXPECTED.length)add("FUNCTION_LIST_COUNT_MISMATCH");
 if(rows.length>40)add("FUNCTION_LIST_TOO_MANY_ROWS");

 const byName=new Map();
 let unknownCount=0;
 for(const row of rows){
   const [name,version,trigger,location,memory,runtime]=row;
   if(!EXPECTED.includes(name)){
     // Never return unknown raw names: malicious/pasted console text could
     // contain secret values, account IDs or other private information.
     unknownCount++;
     continue;
   }
   byName.set(name,(byName.get(name)||0)+1);
   const expectedTrigger=name==="ledgerAutoSettleProspective"?"scheduled":"callable";
   if(version!=="v2"||trigger!==expectedTrigger||
      location!==REGION||runtime!==RUNTIME||
      !/^(?:128|256|512|1024|2048|4096)$/.test(memory))
     mismatched.push(name);
 }
 for(const name of EXPECTED){
   const count=byName.get(name)||0;
   if(count===0)missing.push(name);
   if(count>1)add("DUPLICATE_FUNCTION_ROWS");
 }
 if(missing.length)add("EXPECTED_FUNCTIONS_MISSING");
 if(unknownCount>0)add("UNEXPECTED_FUNCTIONS_PRESENT");
 if(mismatched.length)add("FUNCTION_RUNTIME_REGION_OR_TRIGGER_MISMATCH");
 for(const blocker of EXTERNAL_BLOCKERS)add(blocker);
 const inventoryMatches=blockers.every(x=>EXTERNAL_BLOCKERS.includes(x));
 return Object.freeze({
   status:"BLOCKED",releaseReady:false,paidProviderAllowed:false,
   cloudChangesAuthorized:false,inventoryMatches,
   expectedCount:EXPECTED.length,observedCount:rows.length,
   missing:Object.freeze(missing),mismatched:Object.freeze(mismatched),
   unexpectedCount:unknownCount,blockers:Object.freeze(blockers)
 });
}
module.exports=Object.freeze({
  EXPECTED,SOURCE_NAMES,PREFLIGHT,assessOfflineFunctionList
});
