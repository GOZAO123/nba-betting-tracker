"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {spawnSync}=require("node:child_process");
const {offlineQuoteCollectionPreflight:review}=
  require("./offline-quote-collection-preflight");

const REQUIRED={
  production:"index.js",
  integration:"manual-evidence-integration.js",
  crosswalk:"offer-team-crosswalk.js",
  manualReceipt:"manual-evidence-receipt.js",
  quoteSnapshot:"provider-player-quote-snapshot.js",
  quoteStore:"offline-quote-evidence-store.js",
  quoteAdmin:"offline-quote-evidence-firestore.js",
  quotePipeline:"offline-manual-quote-persistence.js"
};
const input=()=>{
  const files={};
  for(const [key,name] of Object.entries(REQUIRED))
    files[key]=fs.readFileSync(path.join(__dirname,name),"utf8");
  files.rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
  files.readme=fs.readFileSync(path.join(__dirname,"README.md"),"utf8");
  return files;
};
const blocked=result=>{
  assert.equal(result.status,"BLOCKED");
  assert.equal(result.releaseReady,false);
  assert.equal(result.paidProviderAllowed,false);
  assert.equal(result.cloudChangesAuthorized,false);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.blockers),true);
  assert.ok(result.blockers.length>0);
  assert.equal(new Set(result.blockers).size,result.blockers.length);
  for(const code of result.blockers)
    assert.match(code,/^[A-Z0-9_]{3,90}$/);
  return result.blockers;
};

test("D15.33 current main quote components are source-guard compatible, never release-ready",()=>{
  const codes=blocked(review(input()));
  for(const unresolved of [
    "REAL_ODDSPAPI_QUOTE_SCHEMA_NOT_ATTESTED",
    "PROVIDER_PLAN_AND_REQUEST_COST_NOT_ATTESTED",
    "INDEPENDENT_ESPN_PLAYER_IDENTITY_NOT_ATTESTED",
    "PRODUCTION_RECEIPT_TO_QUOTE_INTEGRITY_NOT_ATTESTED",
    "DURABLE_QUOTE_REPLAY_AND_ADMIN_IAM_NOT_ATTESTED",
    "EXACT_TARGETED_DEPLOYMENT_AND_ROLLBACK_NOT_ATTESTED",
    "OWNER_PRODUCTION_DEPLOYMENT_APPROVAL_REQUIRED",
    "OWNER_LIVE_PROVIDER_REQUEST_APPROVAL_REQUIRED"
  ])assert.ok(codes.includes(unresolved),unresolved);
  assert.ok(codes.includes("PRODUCTION_INTEGRATION_REQUIRES_SEPARATE_REVIEW"));
  assert.ok(codes.includes("REVIEWED_TEAM_CROSSWALK_EMPTY"));
  assert.equal(codes.some(code=>code.endsWith("_NOT_CONFIRMED")),false);
  assert.equal(codes.some(code=>code==="PRODUCTION_QUOTE_PATH_NOT_DISCONNECTED"),false);
  assert.equal(codes.some(code=>code==="PRODUCTION_INTEGRATION_QUOTE_OVERRIDE_DETECTED"),false);
  assert.equal(codes.includes("EXISTING_RELEASE_PREFLIGHT_UNAVAILABLE"),false);
});

test("D15.33 offline quote preflight refuses partial, extraneous and wrong input",()=>{
  for(const val of [null,undefined,{},[],{production:"text"},
    {...input(),clientClaim:{paid:true}},
    {...input(),quoteStore:42},
    {...input(),readme:"x".repeat(1024*1024+1)}]){
    assert.deepEqual(blocked(review(val)),["QUOTE_PREFLIGHT_INPUT_UNAVAILABLE"]);
  }
});

test("D15.33 source getter traps cannot leak provider content or crash caller",()=>{
  const source=input();
  Object.defineProperty(source,"quoteStore",{enumerable:true,get(){
    throw Error("PRIVATE_PROVIDER_SECRET_NEVER_PRINT");
  }});
  const result=review(source);
  assert.deepEqual(blocked(result),["QUOTE_PREFLIGHT_INPUT_UNAVAILABLE"]);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROVIDER_SECRET/);
});

test("D15.33 accidental production quote importer triggers blocker",()=>{
  const source=input();
  source.production+='\nrequire("./offline-manual-quote-persistence");\n';
  const codes=blocked(review(source));
  assert.ok(codes.includes("PRODUCTION_QUOTE_PATH_NOT_DISCONNECTED"));
});

test("D15.33 enabling legacy backend flag is treated as unsafe",()=>{
  const source=input();
  source.production=source.production.replace(
    "const NBA_PROVIDER_EVIDENCE_ENABLED = false;",
    "const NBA_PROVIDER_EVIDENCE_ENABLED = true;"
  );
  const codes=blocked(review(source));
  assert.ok(codes.includes("PRODUCTION_QUOTE_PATH_NOT_DISCONNECTED"));
  assert.ok(codes.includes("PRODUCTION_EVIDENCE_DISABLED_GATE_NOT_VERIFIED"));
});

test("D15.33 adding browser-controlled quote options to integration is blocked",()=>{
  const source=input();
  source.integration+='\nconst trustedQuoteSelection = request.data.marketId;\n';
  const codes=blocked(review(source));
  assert.ok(codes.includes("PRODUCTION_INTEGRATION_QUOTE_OVERRIDE_DETECTED"));
});

test("D15.33 disabled-by-default factory must not become opt-out",()=>{
  const source=input();
  source.quotePipeline=source.quotePipeline.replace(
    "if (config.enabled!==true)","if (config.enabled===false)"
  );
  const codes=blocked(review(source));
  assert.ok(codes.includes("QUOTE_PIPELINE_DEFAULT_OFF_NOT_CONFIRMED"));
});

test("D15.33 private one-use capability consumption must stay present",()=>{
  const source=input();
  source.quotePipeline=source.quotePipeline.replace(
    "scope.claimed=true;","scope.claimed=false;"
  );
  const codes=blocked(review(source));
  assert.ok(codes.includes("QUOTE_PIPELINE_DEFAULT_OFF_NOT_CONFIRMED"));
});

test("D15.33 D8 fixture store must report STORED before emitting a quote",()=>{
  const source=input();
  source.manualReceipt=source.manualReceipt.replace(
    'outcome?.status==="STORED"',
    'outcome?.status!=="DENIED"'
  );
  const codes=blocked(review(source));
  assert.ok(codes.includes("PRIVATE_RECEIPT_ORDER_NOT_CONFIRMED"));
});

test("D15.33 unreviewed quote flags cannot silently become approved",()=>{
  for(const field of [
    "bookmakerVerified","espnPlayerVerified","autoLineSelected","captureAllowed"
  ]){
    const source=input();
    source.quoteSnapshot=source.quoteSnapshot.replace(field+": false",field+": true");
    const codes=blocked(review(source));
    assert.ok(codes.includes("QUOTE_RECORD_ALWAYS_UNREVIEWED_NOT_CONFIRMED"),field);
  }
});

test("D15.33 original quote store needs receipt trust and replay blockers",()=>{
  for(const change of [
    text=>text.replace('"REPLAY_BLOCKED"','"REPLAY_OK"'),
    text=>text.replace("await tx.create(target,record)","await tx.set(target,record)"),
    text=>text.replace("await tx.read(target)","await tx.readOther(target)"),
    text=>text.replace("await isTrustedQuoteReceipt(token,","await untrustedSourceClaim(token,")
  ]){
    const source=input();
    source.quoteStore=change(source.quoteStore);
    const codes=blocked(review(source));
    assert.ok(codes.includes("QUOTE_CREATE_ONLY_GUARD_NOT_CONFIRMED"));
  }
});

test("D15.33 Admin facade must use its fixed path and create-only transaction",()=>{
  for(const change of [
    text=>text.replace("_internal/quoteEvidence/providerObservations/","_internal/other/"),
    text=>text.replace("validCreateDocument(path,record)","trustClientRecord(path,record)"),
    text=>text.replace("await adminTx.create(ref,record)","await adminTx.update(ref,record)")
  ]){
    const source=input();
    source.quoteAdmin=change(source.quoteAdmin);
    const codes=blocked(review(source));
    assert.ok(codes.includes("ADMIN_FIXED_PATH_GUARD_NOT_CONFIRMED"));
  }
});

test("D15.33 direct browser write permissiveness retains preexisting D12 blocker",()=>{
  const source=input();
  source.rules+='\nmatch /{document=**} {allow write: if true;}\n';
  const codes=blocked(review(source));
  assert.ok(codes.includes("CLIENT_WRITE_PROTECTION_NOT_VERIFIED"));
});

test("D15.33 source spoofing approval or cloud billing cannot return success",()=>{
  const source=input();
  source.readme+="\nLIVE_PROVIDER_APPROVED=true\nBILLING_EUR=0\nOWNER_APPROVED=true\n";
  source.quotePipeline+="\n// ALL_PRICE_OFFERS_INDEPENDENTLY_VERIFIED\n";
  const response=review(source);
  const codes=blocked(response);
  assert.ok(codes.includes("OWNER_LIVE_PROVIDER_REQUEST_APPROVAL_REQUIRED"));
  assert.ok(codes.includes("OWNER_PRODUCTION_DEPLOYMENT_APPROVAL_REQUIRED"));
});

test("D15.33 CLI prints only static codes, deliberately exits 2, never provider data",()=>{
  const child=spawnSync(process.execPath,
    [path.join(__dirname,"offline-quote-collection-preflight.js")],
    {encoding:"utf8",timeout:4000,maxBuffer:100000});
  assert.equal(child.status,2);
  assert.equal(child.stderr,"");
  const result=JSON.parse(child.stdout);
  assert.equal(result.status,"BLOCKED");
  for(const name of ["releaseReady","paidProviderAllowed","cloudChangesAuthorized"])
    assert.equal(result[name],false);
  assert.ok(Array.isArray(result.blockers));
  assert.ok(result.blockers.includes("OWNER_LIVE_PROVIDER_REQUEST_APPROVAL_REQUIRED"));
  assert.ok(result.blockers.every(x=>/^[A-Z0-9_]{3,90}$/.test(x)));
  // JSON serialization does not preserve Object.freeze on the original value.
  assert.doesNotMatch(child.stdout,/apiKey|PRIVATE_PROVIDER|Synthetic|93001|1\.88|firebaseConfig/i);
});

test("D15.33 quote readiness checker is entirely disconnected from live services",()=>{
  const code=fs.readFileSync(
    path.join(__dirname,"offline-quote-collection-preflight.js"),"utf8");
  const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(code,/require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(code,/\b(?:fetch|setInterval|setTimeout|onCall|onSchedule)\s*\(/);
  assert.doesNotMatch(code,/https:\/\/api\.oddspapi\.io/);
  assert.doesNotMatch(prod,/offline-quote-collection-preflight/);
});
