"use strict";
const {BUDGET_PATH}=require('../../offline-identity-quota-firestore-reserve.js');
// Local demo emulator only; no provider transport or production entrypoint.
const assert=require("node:assert/strict");
const {createHash,randomUUID}=require("node:crypto");

const {makeFixtureBoundCollection}=require("../fixture-bound-collection.cjs");
const {makeFixtureBoundAuthorization}=require("../fixture-bound-authorization.cjs");
const {makeTransactionJournalReader}=require("../transaction-journal-reader.cjs");
const {makeTransactionSourceReader}=require("../transaction-source-reader.cjs");
const {readRegistry}=require("../transaction-registry-reader.cjs");
const {PROJECT, AUTH, FIRESTORE, assertDemoEnvironment, assertEmulatorsRunning}=require('./environment.cjs');
assertDemoEnvironment();
const {makeScopeBoundApprovalSchema}=require('../scope-bound-approval.cjs');
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
 const receipts=new Set();const users=[];let seeded=false;const s=setup();const budget=db.doc(BUDGET_PATH);const counter=(reserved)=>({utcDay:iso(0).slice(0,10),reserved,limit:6,lastReservedAt:iso(0)});const paths=[...s.docs.keys(),BUDGET_PATH];
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
  const batch=db.batch();for(const [p,v] of s.docs){assert.equal(p.split("/").length%2,0,"Invalid synthetic document path");batch.create(db.doc(p),v);}batch.create(budget,counter(0));await batch.commit();seeded=true;pass("Ten synthetic authorization documents and one shared counter created");
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

  const {makeOfflineLinkedQuoteCollector}=require('../../offline-one-quote-approval.js');
  const {resolveOfflineQuoteSelection}=require('../../provider-player-quote-snapshot.js');
  const {catalog,fixture}=require('../../one-quote-rehearsal-fixtures.js');
  const TEAM=/^_internal\/teamEvidence\/providerSnapshots\/ODDSPAPI_MANUAL_[A-F0-9]{32}$/;
  const QUOTE=/^_internal\/quoteEvidence\/providerObservations\/[a-f0-9]{64}$/;
  const safe=p=>TEAM.test(p)||QUOTE.test(p);
  const trace=[]; let failure=null; let scenario="";
  const guarded={doc:p=>{assert.ok(s.docs.has(p)||safe(p)||p===BUDGET_PATH,'Unexpected path');return db.doc(p);},runTransaction:async fn=>{
   let committed=[];
   const result=await db.runTransaction(async tx=>{
    const pending=[];const read=new Set();let budgetBefore;
    const out=await fn({async get(ref){assert.ok(s.docs.has(ref.path)||safe(ref.path)||ref.path===BUDGET_PATH);read.add(ref.path);if(ref.path===BUDGET_PATH){trace.push('reserve');assert.equal(await claimed(),NOW);const snapshot=await tx.get(ref);budgetBefore=snapshot.data().reserved;return snapshot;}return tx.get(ref);},update(ref,patch){assert.equal(ref.path,ap);assert.ok(read.has(ap));assert.deepEqual(Object.keys(patch),['claimedAtMs']);tx.update(ref,patch);pending.push(['claim',ref.path]);},set(ref,value){assert.equal(ref.path,BUDGET_PATH);assert.equal(value.reserved,budgetBefore+2);tx.set(ref,value);},create(ref,value){assert.ok(safe(ref.path));assert.ok(read.has(ref.path));tx.create(ref,value);pending.push([TEAM.test(ref.path)?'team-create':'quote-create',ref.path]);}});
    if(pending.some(([kind])=>kind===failure))throw Error('Intentional synthetic transaction abort');
    committed=pending;return out;
   });
   for(const [kind,p] of committed){trace.push(kind);if(kind!=='claim')receipts.add(p);}return result;
  }};
  const odds=fixture();odds.fixtureId=fixtureId;odds.startTime=s.scope.startTime;
  for(const o of Object.values(odds.bookmakerOdds['betano.pt'].markets['91001'].outcomes))for(const p of Object.values(o.players)){p.playerName=s.scope.playerName;p.changedAt=iso(-120000);}
  const cfg={...config,db:guarded,resolveOfflineQuoteSelection,makeOfflineLinkedQuoteCollector,
   async fetchCatalogue(){trace.push('catalogue');if(scenario==='catalogue-error')throw Error('Synthetic catalogue failure');return scenario==='invalid-catalogue'?[]:catalog();},
   async fetchOdds(){trace.push('odds');if(scenario==='odds-error')throw Error('Synthetic odds failure');const f=structuredClone(odds);if(scenario==='fixture-mismatch')f.fixtureId='synthetic-wrong-fixture';if(scenario==='missing-player')for(const o of Object.values(f.bookmakerOdds['betano.pt'].markets['91001'].outcomes))o.players={};return [f];},
   async readPrivateEvidence(p){assert.ok(safe(p));assert.ok(receipts.has(p));trace.push(QUOTE.test(p)?'quote-read':'team-read');if(scenario==='linkage-error')throw Error('Synthetic linkage read failure');return (await db.doc(p).get()).data();}
  };
  const collect=makeFixtureBoundCollection(cfg);
  async function check(name,mode,expected,expectedTrace,created,consumed=true,abort=null){
   await db.doc(ap).set(s.docs.get(ap));await budget.set(counter(mode==='quota'?5:0));trace.length=0;scenario=mode;failure=abort;
   if(mode==='expired')await db.doc(ap).update({expiresAtMs:NOW});
   const before=receipts.size;
   const result=await collect(owner);
   console.log('CASE '+JSON.stringify({name,status:result.status,trace,consumed:(await claimed())===NOW,newReceipts:receipts.size-before}));
   assert.deepEqual(result,{status:expected},name);assert.deepEqual(trace,expectedTrace,name);
   assert.equal((await budget.get()).data().reserved,mode==='quota'?5:consumed?2:0,name);
   assert.equal(await claimed(),consumed?NOW:null,name);assert.equal(receipts.size-before,created,name);
   if(consumed){const prior=[...trace];assert.deepEqual(await collect(owner),{status:'DENIED'});assert.deepEqual(trace,prior);}
   pass(name);
  }
  await check('Expired permit','expired','DENIED',[],0,false);
  await check('Quota exhausted','quota','ATTEMPT_FAILED',['claim','reserve'],0);
  await check('Catalogue fetch failure','catalogue-error','ATTEMPT_FAILED',['claim','reserve','catalogue'],0);
  await check('Invalid catalogue','invalid-catalogue','ATTEMPT_FAILED',['claim','reserve','catalogue'],0);
  const two=['claim','reserve','catalogue','odds'];
  await check('Odds fetch failure','odds-error','ATTEMPT_FAILED',two,0);
  await check('Mismatched fixture','fixture-mismatch','ATTEMPT_FAILED',two,0);
  await check('Missing player','missing-player','ATTEMPT_FAILED',two,0);
  await check('Fixture persistence abort','fixture-abort','UNLINKED',two,0,true,'team-create');
  await check('Receipt linkage read failure','linkage-error','UNLINKED',[...two,'team-create','quote-create','quote-read'],2);
  // Revocation last: no restoration or rewriting of the revoked review.
  const {makeOfflineSourceBoundGloballyGuardedReviewJournal}=require('../../offline-fixtures-atomic-source-review-journal.js');
  const writer=makeOfflineSourceBoundGloballyGuardedReviewJournal({db});
  const {eventDigest:ignored,...base}=s.e;
  const rev=event({...base,revision:2,action:'REVOKE',reviewedAt:iso(-1000),pairs:null});
  assert.equal(await writer.appendDecision({fixtureId,expectedRevision:1,packetDigest:s.e.packetDigest,event:rev}),true);
  paths.push(rootJ+'/events/000002');
  await check('Committed review revocation','revoked','DENIED',[],0,false);
  console.log('COLLECTOR_FAILURE_MATRIX_PASSED');

 }finally{
  try{if(seeded){const cleanup=db.batch();for(const p of [...paths,...receipts])cleanup.delete(db.doc(p));await cleanup.commit();console.log('Synthetic documents cleaned: '+(paths.length+receipts.size)+'/'+(paths.length+receipts.size));}}
  finally{try{for(const uid of users)await auth.deleteUser(uid);console.log('Synthetic users cleaned: '+users.length+'/'+users.length);}finally{await db.terminate();await deleteApp(app);}}
 }
}
main().catch(e=>{console.error('COLLECTOR_FAILURE_MATRIX_FAILED:',e.code||e.name||'UNKNOWN',e.message||'');process.exitCode=1;});
