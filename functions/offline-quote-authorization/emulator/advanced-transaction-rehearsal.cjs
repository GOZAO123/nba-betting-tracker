"use strict";
// Local demo emulator only; no provider transport or production entrypoint.
const assert=require("node:assert/strict");
const {createHash,randomUUID}=require("node:crypto");

const {makeFixtureBoundAuthorization}=require("../fixture-bound-authorization.cjs");
const {makeTransactionJournalReader}=require("../transaction-journal-reader.cjs");
const {makeTransactionSourceReader}=require("../transaction-source-reader.cjs");
const {readRegistry}=require("../transaction-registry-reader.cjs");
const {PROJECT, AUTH, FIRESTORE, assertDemoEnvironment, assertEmulatorsRunning}=require('./environment.cjs');
assertDemoEnvironment();
const {makeScopeBoundApprovalSchema}=require('../scope-bound-approval.cjs');
const {makeOfflineSourceBoundGloballyGuardedReviewJournal}=require("../../offline-fixtures-atomic-source-review-journal.js");
const {makeOfflineFixtureReviewJournal}=require('../../offline-fixtures-review-journal-firestore.js');
const {makeOfflineFixtureEspnReviewPacket:makePacket}=require('../../offline-fixture-espn-review-packet.js');
const {extractOfflineFixtureTeamEvidence:extract}=require('../../offline-fixture-team-evidence.js');
const {sanitizeOfflineEspnScoreboard:sanitizeScoreboard}=require('../../offline-espn-scoreboard-custody.js');
const {normalizeOfflineQuoteScope}=require('../../provider-player-quote-snapshot.js');
const NOW=Date.parse('2026-11-23T16:00:00.000Z'),iso=n=>new Date(NOW+n).toISOString(),fixtureId='synthetic-emulator-'+randomUUID(),pr='ODDSPAPI_FIXTURES_'+randomUUID().replace(/-/g,'').toUpperCase(),er='ESPN_'+randomUUID().replace(/-/g,'').toUpperCase(),approvalId=randomUUID().replace(/-/g,'');
const rootJ='_internal/teamReview/fixtureJournals/'+fixtureId,ev=rootJ+'/events/000001',bp='_internal/teamReview/sourceBindings/'+fixtureId,pp='_internal/teamEvidence/fixtureTeamSnapshots/'+pr,ep='_internal/teamReview/espnSnapshots/'+er,ap='_internal/oneQuoteCollection/scopeBoundApprovals/'+approvalId;
const pairs=[{providerParticipantId:'5001',espnTeamId:'13'},{providerParticipantId:'5002',espnTeamId:'14'}];
const rp=pairs.flatMap(p=>['_internal/teamReview/globalProviderIds/'+p.providerParticipantId,'_internal/teamReview/globalEspnIds/'+p.espnTeamId]);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function event(base){return {...base,eventDigest:hash(base)};}
function head(e){return {schemaVersion:1,fixtureId,packetDigest:e.packetDigest,revision:e.revision,lastAction:e.action,latestEventDigest:e.eventDigest,updatedAt:e.reviewedAt};}
function setup(){
 const receipt=extract([{fixtureId,sportId:11,tournamentId:132,statusId:0,hasOdds:true,startTime:iso(10800000),updatedAt:iso(-120000),participant1Id:'5001',participant2Id:'5002',participant1Name:'Synthetic Red',participant2Name:'Synthetic Blue'}],{reference:pr,capturedAt:iso(-60000)},NOW);assert.ok(receipt);
 const scoreboard=sanitizeScoreboard({events:[{id:'401001234',date:iso(10800000),status:{type:{state:'pre'}},season:{type:2},competitions:[{competitors:[{homeAway:'home',team:{id:'13',displayName:'Synthetic ESPN Red'}},{homeAway:'away',team:{id:'14',displayName:'Synthetic ESPN Blue'}}]}]}]});assert.ok(scoreboard);
 const packet=makePacket({fixtureId,providerReceipt:receipt,espnScoreboard:scoreboard,espnMetadata:{reference:er,capturedAt:iso(-30000)},now:NOW});assert.ok(packet);
 const e=event({schemaVersion:1,fixtureId,revision:1,action:'APPROVE',reviewedAt:iso(-10000),packetDigest:packet.packetDigest,reviewMethod:'MANUAL_TWO_SOURCE_FIXTURES_ID_REVIEW',reviewerReference:'SYNTHETIC_REVIEWER',pairs});
 const scope={participant1Id:'5001',participant2Id:'5002',startTime:iso(10800000),playerName:'Synthetic Athlete',family:'PTS',line:20.5};
 const review={fixtureId,reviewRevision:1,reviewEventDigest:e.eventDigest,sourcePacketDigest:packet.packetDigest,participant1Id:'5001',participant2Id:'5002',startTime:NOW+10800000,validUntilMs:NOW+29*60000};
 const approval=makeScopeBoundApprovalSchema(normalizeOfflineQuoteScope).create(scope,review,NOW-5000,NOW+60000);assert.ok(approval);
 const docs=new Map([[ap,approval],[rootJ,head(e)],[ev,e],[bp,{schemaVersion:1,fixtureId,providerReference:pr,espnReference:er,providerDigest:packet.provider.snapshotDigest,espnDigest:packet.espn.digest,packetDigest:packet.packetDigest}],[pp,{...receipt,receivedAt:iso(-30000)}],[ep,{schemaVersion:1,source:'ESPN_NBA_SCOREBOARD',reference:er,capturedAt:iso(-30000),scoreboard}],...rp.map((p,i)=>[p,{schemaVersion:1,...pairs[Math.floor(i/2)],fixtureIds:[fixtureId]}])].map(([k,v])=>[k,structuredClone(v)]));
 return {docs,scope,e};
}

async function main(){
 await assertEmulatorsRunning();
 const {initializeApp,deleteApp}=require("firebase-admin/app");
 const {getAuth}=require("firebase-admin/auth");
 const {getFirestore}=require("firebase-admin/firestore");
 const app=initializeApp({projectId:PROJECT});const auth=getAuth(app);const db=getFirestore(app);
 const users=[];let seeded=false;let ownsRevocation=false;const revPath=rootJ+"/events/000002";const s=setup();const paths=[...s.docs.keys()];
 const pass=label=>console.log("PASS: "+label);
 async function identity(role,verified){
  const uid="rehearsal-"+role+"-"+randomUUID(),email=uid+"@example.invalid",password=randomUUID()+"-Synthetic!";
  await auth.createUser({uid,email,password,emailVerified:verified});users.push(uid);
  const response=await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-emulator-key`,{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password,returnSecureToken:true}),signal:AbortSignal.timeout(10000)});
  assert.equal(response.ok,true);const session=await response.json();const decoded=await auth.verifyIdToken(session.idToken);
  assert.equal(decoded.uid,uid);assert.equal(decoded.aud,PROJECT);assert.equal(decoded.email_verified,verified);
  return {auth:{uid:decoded.uid,token:{email_verified:decoded.email_verified}},data:{}};
 }
 const claimed=async()=> (await db.doc(ap).get()).data().claimedAtMs;
 // Reset only the synthetic permit between independent test scenarios.
 async function reset(){await db.doc(ap).update({claimedAtMs:null});}
 try{
  const owner=await identity("owner",true),other=await identity("other",true),unverified=await identity("unverified",false);pass("Verified emulator identities");
  // Atomic create-only seed: refuse any collision, never overwrite existing data.
  const batch=db.batch();for(const [p,v] of s.docs){assert.equal(p.split("/").length%2,0,"Invalid synthetic document path");batch.create(db.doc(p),v);}await batch.commit();seeded=true;pass("Ten synthetic documents created");
  const config={enabled:true,expectedFixtureId:fixtureId,db,ownerUid:owner.auth.uid,approvalId,scope:s.scope,normalizeOfflineQuoteScope,makeOfflineFixtureReviewJournal,makePacket,sanitizeScoreboard,now:()=>NOW};
  const run=makeFixtureBoundAuthorization(config);
  const j=makeTransactionJournalReader({db,makeOfflineFixtureReviewJournal});
  const source=makeTransactionSourceReader({db,makePacket,sanitizeScoreboard});
  // Fail fast on storage representation incompatibilities, without reordering or rewriting any evidence.
  const roundtrip=await db.runTransaction(async tx=>{
   const eventDoc=(await tx.get(db.doc(ev))).data();const {eventDigest,...base}=eventDoc;
   const digestMatches=hash(base)===eventDigest;
   const journal=await j(tx,fixtureId);
   const src=await source({tx,fixtureId,packetDigest:s.e.packetDigest,pairs,now:NOW});
   const reg=await readRegistry({db,tx,fixtureId,pairs});
   return {eventDigestMatches:digestMatches,journalAccepted:journal?.status==="APPROVED_JOURNAL_ONLY",sourceAccepted:src?.status==="SOURCE_CONSISTENCY_ONLY",registryAccepted:reg?.status==="REGISTRY_CONSISTENCY_ONLY"};
  });
  console.log("ROUNDTRIP_DIAGNOSTIC "+JSON.stringify(roundtrip));
  assert.ok(Object.values(roundtrip).every(Boolean),"Storage round-trip failed; stop before concurrency tests");pass("Actual Firestore evidence round trip");
  assert.equal(db.doc(ap).path,ap);assert.throws(()=>db.doc("_internal/scopeBoundQuoteApprovals/"+approvalId));pass("Corrected permit path accepted; old path rejected");
  const journalWriter=makeOfflineSourceBoundGloballyGuardedReviewJournal({db});
  const revokeEvent=event({...s.e,revision:2,action:"REVOKE",reviewedAt:iso(-1000),pairs:null});
  // event() hashes its input, so remove the previous eventDigest first.
  const {eventDigest:ignored,...revokeBase}=revokeEvent;
  const rev=event(revokeBase);
  async function revoke(){const ok=await journalWriter.appendDecision({fixtureId,expectedRevision:1,packetDigest:s.e.packetDigest,event:rev});if(ok)ownsRevocation=true;return ok;}
  async function restore(){assert.equal(ownsRevocation,true);const b=db.batch();b.delete(db.doc(revPath));for(const p of [rootJ,...rp])b.set(db.doc(p),s.docs.get(p));b.update(db.doc(ap),{claimedAtMs:null});await b.commit();ownsRevocation=false;}
  async function verifyRevoked(){const h=(await db.doc(rootJ).get()).data();assert.equal(h.lastAction,"REVOKE");assert.equal(h.revision,2);assert.equal((await db.doc(revPath).get()).exists,true);for(const p of rp)assert.equal((await db.doc(p).get()).exists,false);}
  assert.equal(await revoke(),true);await verifyRevoked();assert.deepEqual(await run(owner),{status:"DENIED"});assert.equal(await claimed(),null);pass("Committed source-bound revocation prevents claim");await restore();
  assert.deepEqual(await run(owner),{status:"CLAIMED"});assert.equal(await revoke(),true);await verifyRevoked();assert.equal(await claimed(),NOW);assert.deepEqual(await run(owner),{status:"DENIED"});pass("Claim committed before revocation remains consumed");await restore();
  const races=[];
  for(let i=0;i<3;i++){const [claim,revoked]=await Promise.all([run(owner),revoke()]);assert.equal(revoked,true);await verifyRevoked();assert.ok(["CLAIMED","DENIED"].includes(claim.status));assert.equal(await claimed(),claim.status==="CLAIMED"?NOW:null);assert.deepEqual(await run(owner),{status:"DENIED"});races.push(claim.status);await restore();}
  console.log("RACE_OUTCOMES "+JSON.stringify(races));pass("Three concurrent claim/revocation races preserve final invariants");
  for(let i=0;i<3;i++){await reset();const outcomes=await Promise.all(Array.from({length:5},()=>run(owner)));assert.equal(outcomes.filter(x=>x.status==="CLAIMED").length,1);assert.equal(outcomes.filter(x=>x.status==="DENIED").length,4);assert.equal(await claimed(),NOW);}pass("Three five-request contention batches each have one winner");
  await reset();const aborted={doc:p=>db.doc(p),runTransaction:fn=>db.runTransaction(async tx=>{assert.equal(await fn(tx),true);throw Error("Intentional synthetic rollback");})};let downstream=0;const denied=await makeFixtureBoundAuthorization({...config,db:aborted})(owner);if(denied.status==="CLAIMED")downstream++;assert.equal(downstream,0);assert.equal(await claimed(),null);pass("Aborted transaction cannot reach synthetic downstream");
  assert.deepEqual(await run(owner),{status:"CLAIMED"});await assert.rejects(async()=>{throw Error("Synthetic downstream failure");});assert.equal(await claimed(),NOW);assert.deepEqual(await run(owner),{status:"DENIED"});pass("Synthetic downstream failure leaves committed permit consumed");
  console.log("ADVANCED_TRANSACTION_REHEARSAL_PASSED");
 }finally{
  try{if(seeded){const cleanup=db.batch();for(const p of paths)cleanup.delete(db.doc(p));if(ownsRevocation)cleanup.delete(db.doc(revPath));await cleanup.commit();console.log("Synthetic documents cleaned: "+paths.length+"/"+paths.length);}}
  finally{try{for(const uid of users)await auth.deleteUser(uid);console.log("Synthetic users cleaned: "+users.length+"/"+users.length);}finally{await db.terminate();await deleteApp(app);}}
 }
}
main().catch(e=>{console.error("ADVANCED_TRANSACTION_REHEARSAL_FAILED:",e.code||e.name||"UNKNOWN",e.message||"");process.exitCode=1;});
