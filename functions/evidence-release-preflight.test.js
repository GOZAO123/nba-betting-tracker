"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {spawnSync}=require("node:child_process");
const {offlineEvidenceReleasePreflight}=require("./evidence-release-preflight");
function input(){
 return {
  production:fs.readFileSync(path.join(__dirname,"index.js"),"utf8"),
  rules:fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8"),
  crosswalk:fs.readFileSync(path.join(__dirname,"offer-team-crosswalk.js"),"utf8"),
  integration:fs.readFileSync(path.join(__dirname,"manual-evidence-integration.js"),"utf8"),
  readme:fs.readFileSync(path.join(__dirname,"README.md"),"utf8")
 };
}
const report=s=>offlineEvidenceReleasePreflight(s===undefined?input():s);
test("D12 current checkout blocked with only unresolved readiness gates",()=>{
 const r=report();
 assert.equal(r.status,"BLOCKED");assert.equal(r.releaseReady,false);
 assert.equal(Object.isFrozen(r),true);assert.equal(Object.isFrozen(r.blockers),true);
 assert.deepEqual(new Set(r.blockers),new Set([
  "PRODUCTION_EVIDENCE_INTEGRATION_NOT_WIRED",
  "REVIEWED_TEAM_CROSSWALK_EMPTY",
  "LIVE_PROVIDER_SCHEMA_UNVERIFIED",
  "INDEPENDENT_ESPN_TEAM_EVIDENCE_UNVERIFIED",
  "FIREBASE_IAM_AND_BILLING_NOT_ATTESTED",
  "OWNER_DEPLOYMENT_APPROVAL_REQUIRED",
  "OWNER_PROVIDER_REQUEST_APPROVAL_REQUIRED"
 ]));
});
test("D12 only emits static safe codes, no credentials or source",()=>{
 assert.doesNotMatch(JSON.stringify(report()),/apiKey|uid|ownerUid|betano|https:\/\/|database path/i);
});
test("D12 invalid input fails closed with fixed one-code result",()=>{
 for(const wrong of [null,{},[],{...input(),extra:"field"},
  {...input(),rules:null},{...input(),production:42},
  {...input(),integration:"X".repeat(1048577)}]){
   assert.deepEqual(report(wrong),{status:"BLOCKED",releaseReady:false,
    blockers:["OFFLINE_SOURCE_INPUT_UNAVAILABLE"]});
 }
});
test("D12 six-request transactional guard detected in current production source",()=>{
 assert.equal(report().blockers.includes("SIX_REQUEST_BACKEND_GUARD_NOT_VERIFIED"),false);
});
test("D12 detects relaxed numeric budget guard",()=>{
 const s=input();s.production=s.production.replace("ODDSPAPI_REQUESTS_PER_UTC_DAY = 6","ODDSPAPI_REQUESTS_PER_UTC_DAY = 60");
 assert.ok(report(s).blockers.includes("SIX_REQUEST_BACKEND_GUARD_NOT_VERIFIED"));
});
test("D12 detects missing atomic quota transaction",()=>{
 const s=input();s.production=s.production.replace("return await db.runTransaction(","return await db.insecureWrite(");
 assert.ok(report(s).blockers.includes("SIX_REQUEST_BACKEND_GUARD_NOT_VERIFIED"));
});
test("D12 detects missing reservation function",()=>{
 const s=input();s.production=s.production.replace("async function reserveDiagnosticRequests(","async function unsafeReserve(");
 assert.ok(report(s).blockers.includes("SIX_REQUEST_BACKEND_GUARD_NOT_VERIFIED"));
});
test("D12 detects research ledger direct writes enabled",()=>{
 const s=input();s.rules=s.rules.replace("allow create, update, delete: if false;","allow create, update, delete: if true;");
 assert.ok(report(s).blockers.includes("CLIENT_WRITE_PROTECTION_NOT_VERIFIED"));
});
test("D12 detects overlapping permissive recursive browser rules",()=>{
 const s=input();s.rules+="\nmatch /{document=**} { allow read, write: if true; }\n";
 assert.ok(report(s).blockers.includes("CLIENT_WRITE_PROTECTION_NOT_VERIFIED"));
});
test("D12 notices removed default deny guidance",()=>{
 const s=input();s.rules=s.rules.replace("Everything else is denied by default","Rules are permissive");
 assert.ok(report(s).blockers.includes("CLIENT_WRITE_PROTECTION_NOT_VERIFIED"));
});
test("D12 detects integration no longer default disabled",()=>{
 const s=input();s.integration=s.integration.replace("if (config.enabled !== true)","if (config.enabled === true)");
 assert.ok(report(s).blockers.includes("INTEGRATION_DEFAULT_OFF_NOT_VERIFIED"));
});
test("D12 flags accidental production integration for manual review",()=>{
 const s=input();s.production+='\nconst {makeOfflineManualEvidenceIntegration}=require("./manual-evidence-integration");\n';
 const codes=report(s).blockers;
 assert.ok(codes.includes("PRODUCTION_INTEGRATION_REQUIRES_SEPARATE_REVIEW"));
 assert.ok(!codes.includes("PRODUCTION_EVIDENCE_INTEGRATION_NOT_WIRED"));
 assert.equal(report(s).releaseReady,false);
});
test("D12 never treats a nonempty mapping manifest as independently reviewed",()=>{
 const s=input();
 s.crosswalk=s.crosswalk.replace("SERVER_REVIEWED_TEAM_MANIFEST = Object.freeze([])",
  "SERVER_REVIEWED_TEAM_MANIFEST = Object.freeze([uncorroborated])");
 const codes=report(s).blockers;
 assert.ok(codes.includes("REVIEWED_TEAM_CROSSWALK_REQUIRES_INDEPENDENT_REVIEW"));
 assert.equal(report(s).releaseReady,false);
});
test("D12 detects unsafe broad Firebase CLI deployment in documentation",()=>{
 const s=input();s.readme+="\nfirebase.cmd deploy --only functions\n";
 assert.ok(report(s).blockers.includes("UNSAFE_DEPLOYMENT_INSTRUCTIONS"));
});
test("D12 checks targeted and explicit owner approval deployment language",()=>{
 const s=input();s.readme="Any function can deploy at will";
 assert.ok(report(s).blockers.includes("UNSAFE_DEPLOYMENT_INSTRUCTIONS"));
});
test("D12 a zero euro billing report cannot authorize deployment or provider calls",()=>{
 const s=input();s.readme+="\nBilling currently 0 EUR.\n";
 const codes=report(s).blockers;
 assert.ok(codes.includes("FIREBASE_IAM_AND_BILLING_NOT_ATTESTED"));
 assert.ok(codes.includes("OWNER_DEPLOYMENT_APPROVAL_REQUIRED"));
 assert.ok(codes.includes("OWNER_PROVIDER_REQUEST_APPROVAL_REQUIRED"));
});
test("D12 read-only CLI exits 2 and displays no private information",()=>{
 const p=spawnSync(process.execPath,[path.join(__dirname,"evidence-release-preflight.js")],{
  cwd:__dirname,encoding:"utf8",timeout:10000,env:{PATH:process.env.PATH}
 });
 assert.equal(p.status,2);assert.equal(p.stderr,"");
 const r=JSON.parse(p.stdout);
 assert.equal(r.releaseReady,false);
 assert.ok(r.blockers.includes("OWNER_DEPLOYMENT_APPROVAL_REQUIRED"));
 assert.doesNotMatch(p.stdout,/private|secret|uid|apiKey/i);
});
test("D12 safety preflight cannot import or invoke live production providers",()=>{
 const s=fs.readFileSync(path.join(__dirname,"evidence-release-preflight.js"),"utf8");
 assert.doesNotMatch(s,/require\(["']\.\/index|onCall\(|onSchedule\(|setInterval\(|https:\/\/api\.oddspapi/);
 assert.doesNotMatch(s,/firebase-admin|firebase-functions/);
});
