"use strict";
const {BUDGET_PATH,makeOfflineSharedBudgetReservation}=require('../../offline-identity-quota-firestore-reserve.js');
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
  const trace=[]; let failure=null;let ackMode=null;
  const guardedFor=permitPath=>({doc:p=>{assert.ok(s.docs.has(p)||safe(p)||p===BUDGET_PATH,'Unexpected path');return db.doc(p);},runTransaction:async fn=>{
   let committed=[];let quotaCommitted=false;
   const result=await db.runTransaction(async tx=>{
    const pending=[];const read=new Set();let budgetBefore;let quotaWrite=false;
    const out=await fn({async get(ref){assert.ok(s.docs.has(ref.path)||safe(ref.path)||ref.path===BUDGET_PATH);read.add(ref.path);if(ref.path===BUDGET_PATH){trace.push('reserve');assert.equal((await db.doc(permitPath).get()).data().claimedAtMs,NOW);const snapshot=await tx.get(ref);budgetBefore=snapshot.data().reserved;return snapshot;}return tx.get(ref);},update(ref,patch){assert.equal(ref.path,permitPath);assert.ok(read.has(permitPath));assert.deepEqual(Object.keys(patch),['claimedAtMs']);tx.update(ref,patch);pending.push(['claim',ref.path]);},set(ref,value){assert.equal(ref.path,BUDGET_PATH);assert.equal(value.reserved,budgetBefore+2);tx.set(ref,value);quotaWrite=true;},create(ref,value){assert.ok(safe(ref.path));assert.ok(read.has(ref.path));tx.create(ref,value);pending.push([TEAM.test(ref.path)?'team-create':'quote-create',ref.path]);}});
    if(quotaWrite&&ackMode==='quota-abort')throw Error('Synthetic pre-commit quota failure');
    quotaCommitted=quotaWrite;
    if(pending.some(([kind])=>kind===failure))throw Error('Intentional synthetic transaction abort');
    committed=pending;return out;
   });
   for(const [kind,p] of committed){trace.push(kind);if(kind!=='claim')receipts.add(p);}
   if((quotaCommitted&&ackMode==='quota-lost')||(result?.claimedAtMs===NOW&&ackMode==='claim-lost'))throw Error('Synthetic lost acknowledgement');
   if(quotaCommitted&&ackMode==='quota-fabricated')return {...result};
   return result;
  }});
  const odds=fixture();odds.fixtureId=fixtureId;odds.startTime=s.scope.startTime;
  for(const o of Object.values(odds.bookmakerOdds['betano.pt'].markets['91001'].outcomes))for(const p of Object.values(o.players)){p.playerName=s.scope.playerName;p.changedAt=iso(-120000);}
  const cfg={...config,db:guardedFor(ap),resolveOfflineQuoteSelection,makeOfflineLinkedQuoteCollector,
   async fetchCatalogue(){trace.push('catalogue');return catalog();},
   async fetchOdds(){trace.push('odds');return [structuredClone(odds)];},
   async readPrivateEvidence(p){assert.ok(safe(p));assert.ok(receipts.has(p));trace.push(QUOTE.test(p)?'quote-read':'team-read');return (await db.doc(p).get()).data();}
  };
  const collect=makeFixtureBoundCollection(cfg);
  for(const req of [other,unverified])assert.deepEqual(await collect(req),{status:'DENIED'});
  assert.deepEqual(trace,[]);assert.equal(await claimed(),null);pass('Unauthorized identities cannot reserve or fetch');
  const result=await collect(owner);console.log('COLLECTION_STATUS '+result.status);console.log('COLLECTION_TRACE '+JSON.stringify(trace));console.log('PERMIT_CONSUMED '+String((await claimed())===NOW));assert.deepEqual(result,{status:'LINKED_UNREVIEWED'});
  assert.deepEqual(trace,['claim','reserve','catalogue','odds','team-create','quote-create','quote-read','team-read']);assert.equal(receipts.size,2);assert.equal((await budget.get()).data().reserved,2);pass('Actual collector commits and links two private receipts');
  const qp=[...receipts].find(p=>QUOTE.test(p));const q=(await db.doc(qp).get()).data().quote;
  assert.equal(q.fixtureId,fixtureId);assert.equal(q.family,'PTS');assert.equal(q.line,20.5);
  for(const k of ['bookmakerVerified','espnPlayerVerified','autoLineSelected','captureAllowed'])assert.equal(q[k],false);
  for(const [side,id] of [['Over','92001'],['Under','92002']]){const original=odds.bookmakerOdds['betano.pt'].markets['91001'].outcomes[id].players['93001'];assert.equal(q.outcomes[side].price,original.price);assert.equal(q.outcomes[side].changedAt,original.changedAt);assert.equal(q.outcomes[side].mainLineFlag,original.mainLine);}
  pass('Original synthetic prices and timestamps preserved; verification flags false');
  const prior=[...trace];assert.deepEqual(await collect(owner),{status:'DENIED'});assert.deepEqual(trace,prior);pass('Replay cannot reserve or fetch');
  // Reset only this synthetic permit for a separate failure scenario.
  await reset();trace.length=0;failure='quote-create';
  const failed=await collect(owner);console.log('FAILURE_STATUS '+failed.status);assert.deepEqual(failed,{status:'UNLINKED'});assert.equal(await claimed(),NOW);assert.equal(receipts.size,3);assert.equal((await budget.get()).data().reserved,4);assert.equal(trace.filter(x=>x==='odds').length,1);assert.equal(trace.filter(x=>x==='quote-create').length,0);assert.deepEqual(await collect(owner),{status:'DENIED'});pass('Aborted quote persistence preserves fixture receipt and consumed permit');

  for(const mode of ['claim-lost','quota-abort','quota-lost','quota-fabricated']){
   await reset();await budget.set(counter(0));trace.length=0;failure=null;ackMode=mode;
   const expected=mode==='claim-lost'?'DENIED':'ATTEMPT_FAILED';
   assert.deepEqual(await collect(owner),{status:expected});
   assert.equal(await claimed(),NOW);
   const persisted=mode==='quota-lost'||mode==='quota-fabricated'?2:0;
   assert.equal((await budget.get()).data().reserved,persisted);
   assert.deepEqual(trace,mode==='claim-lost'?['claim']:['claim','reserve']);
   const priorTrace=[...trace];
   assert.deepEqual(await collect(owner),{status:'DENIED'});
   assert.deepEqual(trace,priorTrace);
   assert.equal((await budget.get()).data().reserved,persisted);
   pass(mode+' blocks every fetch and replay; persisted quota '+persisted+'/6');
  }
  ackMode=null;

  await reset();await budget.set(counter(0));trace.length=0;
  const samePermit=await Promise.all(Array.from({length:4},()=>collect(owner)));
  assert.equal(samePermit.filter(x=>x.status==='LINKED_UNREVIEWED').length,1);
  assert.equal(samePermit.filter(x=>x.status==='DENIED').length,3);
  assert.equal((await budget.get()).data().reserved,2);
  for(const event of ['claim','reserve','catalogue','odds'])
   assert.equal(trace.filter(x=>x===event).length,1,event);
  pass('Four requests with one permit produce one claim and two committed slots');

  const ids=Array.from({length:4},()=>randomUUID().replace(/-/g,''));
  const permits=ids.map(id=>ap.replace(approvalId,id));
  const extra=db.batch();
  for(const path of permits)extra.create(db.doc(path),s.docs.get(ap));
  await extra.commit();
  for(const path of permits){s.docs.set(path,s.docs.get(ap));paths.push(path);}
  const collectors=ids.map((id,index)=>makeFixtureBoundCollection({
   ...cfg,approvalId:id,db:guardedFor(permits[index])
  }));
  for(const oneSlot of [[],[1,1]]){
   await budget.set(counter(0));
   const restore=db.batch();
   for(const path of permits)restore.update(db.doc(path),{claimedAtMs:null});
   await restore.commit();
   trace.length=0;
   const results=await Promise.all(collectors.map(run=>run(owner)).concat(
    oneSlot.map(amount=>makeOfflineSharedBudgetReservation({getFirestore:()=>db,now:()=>NOW})(amount).catch(()=>null))
   ));
   const outcomes=results.slice(0,collectors.length);
   const linked=outcomes.filter(result=>result.status==='LINKED_UNREVIEWED').length;
   assert.ok(linked>=2&&linked<=3);
   assert.equal(outcomes.filter(result=>result.status==='ATTEMPT_FAILED').length,4-linked);
   assert.equal(trace.filter(event=>event==='catalogue').length,linked);
   assert.equal(trace.filter(event=>event==='odds').length,linked);
   const single=results.slice(collectors.length).filter(Boolean).length;
   assert.deepEqual((await budget.get()).data(),counter(6));
   assert.equal(2*linked+single,6);
   for(const [index,path] of permits.entries()){
    assert.equal((await db.doc(path).get()).data().claimedAtMs,NOW);
    assert.deepEqual(await collectors[index](owner),{status:'DENIED'});
   }
   pass('Concurrent distinct permits'+(oneSlot.length?' and one-slot callers':'')+' persisted exactly 6/6 with no excess fetches');
  }
  console.log('END_TO_END_EMULATOR_PASSED');
 }finally{
  try{if(seeded){const cleanup=db.batch();for(const p of [...paths,...receipts])cleanup.delete(db.doc(p));await cleanup.commit();console.log('Synthetic documents cleaned: '+(paths.length+receipts.size)+'/'+(paths.length+receipts.size));}}
  finally{try{for(const uid of users)await auth.deleteUser(uid);console.log('Synthetic users cleaned: '+users.length+'/'+users.length);}finally{await db.terminate();await deleteApp(app);}}
 }
}
main().catch(e=>{console.error('END_TO_END_EMULATOR_FAILED:',e.code||e.name||'UNKNOWN',e.message||'');process.exitCode=1;});
