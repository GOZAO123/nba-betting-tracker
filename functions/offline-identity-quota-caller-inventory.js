"use strict";

// D15.11 OFFLINE source-inventory snapshot. It is NOT an authenticated view
// of deployed Cloud Functions or a production release authorization. Unknown
// callers and edits to existing reservation wiring must fail review.
const DIRECT=Object.freeze([
  Object.freeze({name:"oddsPapiTournamentProbe",amount:1}),
  Object.freeze({name:"oddsPapiNbaOddsProbe",amount:1}),
  Object.freeze({name:"oddsPapiDetailedPropsProbe",amount:2}),
  Object.freeze({name:"oddsPapiMarketCatalogProbe",amount:1}),
  Object.freeze({name:"oddsPapiVerifiedPropsProbe",amount:2})
]);
const DELEGATED=Object.freeze([
  "oddsPapiNbaFeasibilityProbe",
  "oddsPapiNbaMarketAudit",
  "oddsPapiNbaIdentitySchemaDiagnostic"
]);
const EXPECTED=Object.freeze([...DIRECT.map(x=>x.name),...DELEGATED]);
const safe=(s,re)=>typeof s==="string"&&re.test(s);
const between=(s,start,end)=>{
  const a=s.indexOf(start);
  const b=a<0?-1:s.indexOf(end,a+start.length);
  return b>a?s.slice(a,b):"";
};
function exportBlock(src,name){
  const marker="exports."+name+" = onCall(";
  const a=src.indexOf(marker);
  if(a<0)return "";
  const b=src.indexOf("\nexports.",a+marker.length);
  return src.slice(a,b<0?src.length:b);
}
function assessOfflinePaidCallerInventory(source){
  const blockers=[];
  const add=x=>{if(!blockers.includes(x))blockers.push(x);};
  if(typeof source!=="string"||source.length<1000)
    add("PRODUCTION_SOURCE_UNAVAILABLE");
  // A malformed file input can never reach the string-only scanners.
  if(typeof source!=="string")source="";
  const names=typeof source==="string"?
    [...source.matchAll(/exports\.(oddsPapi[A-Za-z0-9]+)\s*=\s*onCall\(/g)]
      .map(x=>x[1]):[];
  if(names.length!==EXPECTED.length||
     names.some(n=>!EXPECTED.includes(n))||
     EXPECTED.some(n=>names.filter(x=>x===n).length!==1))
    add("PAID_CALLER_EXPORT_INVENTORY_DRIFT");
  for(const entry of DIRECT){
    const block=exportBlock(source||"",entry.name);
    const reserve=new RegExp("await reserveDiagnosticRequests\\("+entry.amount+"\\);");
    if(!reserve.test(block))
      add("DIRECT_RESERVATION_UNVERIFIED_"+entry.name);
  }
  // Delegated diagnostic calls reserve through a specifically constructed
  // runner; do not count an unrelated quota invocation elsewhere in source.
  const feasible=between(source||"",
    "const runNbaOddsFeasibility = makeFeasibilityRunner({",
    "exports.oddsPapiNbaFeasibilityProbe = onCall(");
  if(!safe(feasible,/reserve:\s*reserveDiagnosticRequests\s*,/)||
     !safe(exportBlock(source||"",DELEGATED[0]),
       /return await runNbaOddsFeasibility\(request\)/))
    add("FEASIBILITY_RESERVATION_UNVERIFIED");
  const audit=between(source||"",
    "const runNbaMarketAudit = makeLeagueMarketAuditRunner({",
    "const runNbaMarketAuditRouted = makeManualAuditEvidenceDispatch({");
  const auditRouted=between(source||"",
    "const runNbaMarketAuditRouted = makeManualAuditEvidenceDispatch({",
    "exports.oddsPapiNbaMarketAudit = onCall(");
  if(!safe(audit,/reserve:\s*reserveDiagnosticRequests\s*,/)||
     !safe(auditRouted,/reserveDiagnosticRequests\s*,/)||
     !safe(exportBlock(source||"",DELEGATED[1]),
       /return await runNbaMarketAuditRouted\(request\)/))
    add("MARKET_AUDIT_RESERVATION_UNVERIFIED");
  const identity=between(source||"",
    "const runNbaIdentityShapeDiagnostic = makeManualAuditEvidenceDispatch({",
    "const runNbaIdentitySchemaCallable = makeManualIdentityShapeCallable({");
  const identityCallable=between(source||"",
    "const runNbaIdentitySchemaCallable = makeManualIdentityShapeCallable({",
    "exports.oddsPapiNbaIdentitySchemaDiagnostic = onCall(");
  if(!safe(identity,/enabled:\s*NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED\s*,/)||
     !safe(identity,/reserveDiagnosticRequests\s*,/)||
     !safe(identityCallable,/enabled:\s*NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED\s*,/)||
     !safe(exportBlock(source||"",DELEGATED[2]),
       /runNbaIdentitySchemaCallable/))
    add("IDENTITY_DIAGNOSTIC_RESERVATION_UNVERIFIED");
  if(!safe(source,/const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;/)||
     !safe(source,/db\.doc\("_internal\/oddsPapiDailyDiagnosticBudget"\)/)||
     !safe(source,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/)||
     !safe(source,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/))
    add("SHARED_BUDGET_OR_DIAGNOSTIC_GATES_UNVERIFIED");
  // GitHub source cannot prove all live deployed revisions or the separately
  // deployed, unmetered account-preflight source. ALWAYS leave blocked.
  add("LIVE_DEPLOYED_FUNCTION_REVISIONS_NOT_INVENTORIED");
  add("ACCOUNT_PREFLIGHT_DEPLOYED_SOURCE_NOT_ATTESTED");
  add("NEW_METADATA_QUOTA_NOT_LIVE_VERIFIED");
  add("EVERY_PAID_CALLER_DUAL_RESERVATION_NOT_VERIFIED");
  add("OWNER_CLOUD_AND_PROVIDER_APPROVAL_REQUIRED");
  return Object.freeze({
    status:"BLOCKED",cutoverReady:false,providerRequestAllowed:false,
    sourceInventoryVerified:blockers.every(x=>
      !/UNVERIFIED_|INVENTORY_DRIFT/.test(x)&&
      x!=="PRODUCTION_SOURCE_UNAVAILABLE"),
    sourceCallers:Object.freeze([...names]),
    blockers:Object.freeze(blockers)
  });
}
module.exports=Object.freeze({DIRECT,DELEGATED,
  assessOfflinePaidCallerInventory});
