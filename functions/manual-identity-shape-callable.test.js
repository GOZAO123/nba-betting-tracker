"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {makeManualIdentityShapeCallable}=require("./manual-identity-shape-callable");
const {makeManualAuditEvidenceDispatch}=require("./manual-audit-evidence-dispatch");

class FakeHttpsError extends Error {
 constructor(code,message){super(message);this.code=code;}
}
const CLOCK=Date.parse("2026-11-18T10:00:00.000Z");
const OWNER={auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const leagueFixture=()=>({
 fixtureId:"PRIVATE_FIXTURE_0001",sportId:11,tournamentId:132,
 statusId:0,hasOdds:true,startTime:new Date(CLOCK+180*60000).toISOString(),
 participant1Id:4201,participant2Id:4202,
 bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,markets:{}}},
 privateName:"PRIVATE_PLAYER",privateOdds:1.91
});
const response=(body,url)=>{
 const bytes=new TextEncoder().encode(JSON.stringify(body));
 return {ok:true,redirected:false,url,
  headers:{get:k=>k==="content-type"?"application/json":null},
  body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})
 };
};
function create({enabled=false,budget=6,throwHttp=false,failSecret=false}={}) {
 const effects={reserved:[],http:[],secretChecks:0,transportSecretReads:0,
   firestore:0,wait:0};
 let slots=0,now=CLOCK;
 const run=makeManualAuditEvidenceDispatch({
  enabled,identityOnly:true,
  legacyRun:async()=>{throw new Error("Disabled legacy runner invoked");},
  ownerUid:"synthetic-owner",now:()=>now,
  reserveDiagnosticRequests:async n=>{
   effects.reserved.push(n);
   if(slots+n>budget)throw Error("PRIVATE_QUOTA_FAILURE");
   slots+=n;
  },
  getProviderApiKey:()=>{
   effects.transportSecretReads++;
   return "PRIVATE_SYNTHETIC_API_KEY";
  },
  fetchImpl:async(url,options)=>{
   effects.http.push({url,options});
   if(throwHttp)throw Error("PRIVATE_PROVIDER_FAILURE");
   return response([leagueFixture()],url);
  },
  getFirestore:()=>{effects.firestore++;throw Error("Firestore prohibited");},
  waitBetweenRequests:async()=>{effects.wait++;},
  onFailure:()=>{},onEvidenceOutcome:()=>{}
 });
 const invoke=makeManualIdentityShapeCallable({
  enabled,ownerUid:"synthetic-owner",run,HttpsError:FakeHttpsError,
  secretAvailable:()=>{
   effects.secretChecks++;
   if(failSecret)throw Error("PRIVATE_SECRET_FAILURE");
   return true;
  }
 });
 return {invoke,effects,advance:n=>{now+=n*60000;},slots:()=>slots};
}
const errorCode=code=>err=>{assert.equal(err.code,code);return true;};

test("D15.1 disabled callable is fully inert for owner, never consults secret or quota",async()=>{
 const x=create();
 await assert.rejects(x.invoke(OWNER),errorCode("failed-precondition"));
 assert.deepEqual(x.effects.reserved,[]);
 assert.equal(x.effects.secretChecks,0);
 assert.equal(x.effects.transportSecretReads,0);
 assert.equal(x.effects.http.length,0);
 assert.equal(x.effects.firestore,0);
});
test("D15.1 validates owner and email verification before disabled feedback",async()=>{
 const x=create();
 for(const bad of [null,{}, {auth:{uid:"different",token:{email_verified:true}},data:{}},
   {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}}])
  await assert.rejects(x.invoke(bad),errorCode("permission-denied"));
 assert.deepEqual(x.effects.reserved,[]);
 assert.equal(x.effects.secretChecks,0);
});
test("D15.1 rejects client-supplied tournament, bookmaker, player and enable flags",async()=>{
 const x=create({enabled:true});
 for(const data of [{identityOnly:true},{bookmaker:"other"},{playerId:"private"},
   {tournamentId:111},{enabled:true},[],42,"",true]){
  await assert.rejects(x.invoke({auth:OWNER.auth,data}),
   errorCode("invalid-argument"));
 }
 assert.deepEqual(x.effects.reserved,[]);
 assert.equal(x.effects.secretChecks,0);
 assert.equal(x.effects.http.length,0);
});
test("D15.1 cannot be enabled by a client payload while disabled",async()=>{
 const x=create();
 await assert.rejects(x.invoke({auth:OWNER.auth,data:{enabled:true}}),
  errorCode("invalid-argument"));
 assert.equal(x.effects.http.length,0);
});
test("D15.1 invalid server configuration fails before constructing callable",()=>{
 for(const opts of [{},{enabled:"true",ownerUid:"synthetic-owner",run:async()=>{},
   secretAvailable:()=>true,HttpsError:FakeHttpsError},
  {enabled:true,ownerUid:"",run:async()=>{},
   secretAvailable:()=>true,HttpsError:FakeHttpsError}]){
  assert.throws(()=>makeManualIdentityShapeCallable(opts),/Missing trusted/);
 }
});
test("D15.1 missing secret blocks before quota or transport, with redacted errors",async()=>{
 const x=create({enabled:true,failSecret:true});
 await assert.rejects(x.invoke(OWNER),err=>{
  assert.equal(err.code,"failed-precondition");
  assert.doesNotMatch(err.message,/PRIVATE_SECRET_FAILURE/);
  return true;
 });
 assert.deepEqual(x.effects.reserved,[]);
 assert.equal(x.effects.http.length,0);
});
test("D15.1 fresh synthetic run reserves one and calls only fixed league endpoint",async()=>{
 const x=create({enabled:true}),out=await x.invoke(OWNER);
 assert.equal(out.diagnostic,"PROVIDER_IDENTITY_SHAPE_ONLY");
 assert.equal(out.shapeStatus,"SAMPLE_COMPATIBLE");
 assert.equal(out.requestsUsedOnThisClick,1);
 assert.equal(out.cached,false);
 for(const key of ["teamMappingApproved","identityVerified","releaseReady",
   "bookmakerOddsVerified","researchSaved"])assert.equal(out[key],false);
 assert.deepEqual(x.effects.reserved,[1]);
 assert.equal(x.effects.http.length,1);
 assert.equal(x.effects.firestore,0);
 assert.equal(x.effects.wait,0);
 const http=x.effects.http[0],url=new URL(http.url);
 assert.equal(url.origin,"https://api.oddspapi.io");
 assert.equal(url.pathname,"/v4/odds-by-tournaments");
 assert.equal(url.searchParams.get("tournamentIds"),"132");
 assert.equal(url.searchParams.get("bookmaker"),"betano.pt");
 assert.equal(url.searchParams.get("verbosity"),"3");
 assert.equal(http.options.redirect,"error");
 assert.doesNotMatch(JSON.stringify(out),
  /PRIVATE_|4201|4202|1\.91|apiKey|fixtureId|participant1Id/);
});
test("D15.1 cache reuses 15-minute result without paid quota or HTTP",async()=>{
 const x=create({enabled:true});
 await x.invoke(OWNER);x.advance(14);
 const cached=await x.invoke(OWNER);
 assert.equal(cached.cached,true);
 assert.equal(cached.requestsUsedOnThisClick,0);
 assert.deepEqual(x.effects.reserved,[1]);
 assert.equal(x.effects.http.length,1);
});
test("D15.1 concurrent synthetic owner invocations deduplicate one paid request",async()=>{
 const x=create({enabled:true});
 const results=await Promise.all([x.invoke(OWNER),x.invoke(OWNER)]);
 assert.deepEqual(results.map(r=>r.requestsUsedOnThisClick).sort(),[0,1]);
 assert.deepEqual(x.effects.reserved,[1]);
 assert.equal(x.effects.http.length,1);
});
test("D15.1 cache expires only on a fresh manual invocation",async()=>{
 const x=create({enabled:true});
 await x.invoke(OWNER);x.advance(16);
 const out=await x.invoke(OWNER);
 assert.equal(out.cached,false);
 assert.equal(out.requestsUsedOnThisClick,1);
 assert.deepEqual(x.effects.reserved,[1,1]);
 assert.equal(x.effects.http.length,2);
});
test("D15.1 depleted global quota cannot read transport secret or send request",async()=>{
 const x=create({enabled:true,budget:0});
 await assert.rejects(x.invoke(OWNER),err=>{
  assert.equal(err.code,"unavailable");
  assert.doesNotMatch(err.message,/PRIVATE_QUOTA_FAILURE/);
  return true;
 });
 assert.deepEqual(x.effects.reserved,[1]);
 assert.equal(x.effects.transportSecretReads,0);
 assert.equal(x.effects.http.length,0);
 assert.equal(x.effects.firestore,0);
});
test("D15.1 six-request daily cap applies across noncached fresh manual runs",async()=>{
 const x=create({enabled:true,budget:2});
 await x.invoke(OWNER);x.advance(16);
 await x.invoke(OWNER);x.advance(16);
 await assert.rejects(x.invoke(OWNER),errorCode("unavailable"));
 assert.deepEqual(x.effects.reserved,[1,1,1]);
 assert.equal(x.effects.http.length,2);
 assert.equal(x.slots(),2);
});
test("D15.1 provider failure never retries, refunds, writes or discloses provider text",async()=>{
 const x=create({enabled:true,throwHttp:true});
 await assert.rejects(x.invoke(OWNER),err=>{
  assert.equal(err.code,"unavailable");
  assert.doesNotMatch(err.message,/PRIVATE_PROVIDER_FAILURE|PRIVATE_SYNTHETIC/);
  return true;
 });
 assert.deepEqual(x.effects.reserved,[1]);
 assert.equal(x.effects.http.length,1);
 assert.equal(x.effects.firestore,0);
});
test("D15.1 source guards the named callable independently of legacy audit",()=>{
 const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 assert.match(prod,/const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
 assert.match(prod,/const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
 assert.match(prod,/enabled:\s*NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED/);
 assert.match(prod,/exports\.oddsPapiNbaIdentitySchemaDiagnostic\s*=\s*onCall\(/);
 assert.match(prod,/exports\.oddsPapiNbaMarketAudit\s*=\s*onCall\(/);
 assert.match(prod,/return await runNbaMarketAuditRouted\(request\);/);
 assert.match(prod,/const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;/);
 assert.doesNotMatch(prod,/process\.env\.NBA_IDENTITY_SCHEMA|onSchedule\([^)]*Identity/i);
 const helper=fs.readFileSync(path.join(__dirname,
  "manual-identity-shape-callable.js"),"utf8");
 assert.doesNotMatch(helper,/firebase-admin|firebase-functions|https:\/\/|onSchedule\(|setInterval\(|getFirestore|runTransaction/);
});
