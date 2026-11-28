'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {createHash}=require('node:crypto');
const {makeCombinedAuthorization}=require('./combined-authorization.cjs');
const {makeFixtureBoundCollection}=require('./fixture-bound-collection.cjs');
const {resolveOfflineQuoteSelection}=require('../provider-player-quote-snapshot.js');
const {catalog,fixture}=require('../one-quote-rehearsal-fixtures.js');
const {makeScopeBoundApprovalSchema}=require('./scope-bound-approval.cjs');
const {makeOfflineFixtureReviewJournal}=require('../offline-fixtures-review-journal-firestore.js');
const {makeOfflineFixtureEspnReviewPacket:makePacket}=require('../offline-fixture-espn-review-packet.js');
const {extractOfflineFixtureTeamEvidence:extract}=require('../offline-fixture-team-evidence.js');
const {sanitizeOfflineEspnScoreboard:sanitizeScoreboard}=require('../offline-espn-scoreboard-custody.js');
const {normalizeOfflineQuoteScope}=require('../provider-player-quote-snapshot.js');
const NOW=Date.parse('2026-11-23T16:00:00.000Z'),iso=n=>new Date(NOW+n).toISOString(),fixtureId='synthetic-combined',pr='ODDSPAPI_FIXTURES_'+'A'.repeat(32),er='ESPN_SERVER_OBS_001',approvalId='a'.repeat(32);
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
 const s={docs,reads:[],writes:[],attempts:0,clock:NOW,retry:false,fail:false,request:{auth:{uid:'synthetic-owner',token:{email_verified:true}},data:{}}};let queue=Promise.resolve();
 const db={doc:p=>({path:p,get(){throw Error('Direct reads forbidden');}}),runTransaction(fn){const job=queue.then(async()=>{for(let i=0;i<(s.retry?2:1);i++){s.attempts++;const pending=[];const tx={async get(ref){assert.equal(pending.length,0,'reads before writes');s.reads.push([s.attempts,ref.path]);return {exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path))};},update(ref,patch){assert.equal(ref.path,ap);assert.deepEqual(Object.keys(patch),['claimedAtMs']);pending.push([ref.path,patch]);}};const ok=await fn(tx);if(s.retry&&i===0)continue;if(s.fail)throw Error('Synthetic failed commit');for(const [p,v] of pending){docs.set(p,{...docs.get(p),...v});s.writes.push(p);}return ok;}});queue=job.catch(()=>{});return job;}};
 s.config={enabled:true,db,ownerUid:'synthetic-owner',approvalId,scope,normalizeOfflineQuoteScope,makeOfflineFixtureReviewJournal,makePacket,sanitizeScoreboard,now:()=>s.clock};s.run=()=>makeCombinedAuthorization(s.config)(s.request);return s;
}


const {makeOfflineLinkedQuoteCollector}=require('../offline-one-quote-approval.js');
const TEAM=/^_internal\/teamEvidence\/providerSnapshots\/ODDSPAPI_MANUAL_[A-F0-9]{32}$/;
const QUOTE=/^_internal\/quoteEvidence\/providerObservations\/[a-f0-9]{64}$/;
function actual(){
 const s=setup(),trace=[],violations=[]; const original=s.config.db; let queue=Promise.resolve();
 const safe=(p)=>TEAM.test(p)||QUOTE.test(p);
 const db={doc:original.doc,runTransaction(fn){const job=queue.then(async()=>{
  const pending=[],read=new Set(); const tx={async get(ref){if(pending.length)throw Error('Read after write');read.add(ref.path);return {exists:s.docs.has(ref.path),data:()=>structuredClone(s.docs.get(ref.path))};},
  update(ref,patch){if(ref.path!==ap||!read.has(ap)||Object.keys(patch).join()!=='claimedAtMs'){violations.push('update');throw Error('Unexpected update');}pending.push(['update',ref.path,patch]);},
  create(ref,value){if(!safe(ref.path)||!read.has(ref.path)||s.docs.has(ref.path)){violations.push('create');throw Error('Unexpected create');}pending.push(['create',ref.path,structuredClone(value)]);}};
  const result=await fn(tx); if(s.fail||pending.some(([kind,p])=>kind==='create'&&((s.failTeam&&TEAM.test(p))||(s.failQuote&&QUOTE.test(p)))))throw Error('Synthetic commit failure');
  for(const [kind,p,v] of pending){s.docs.set(p,kind==='update'?{...s.docs.get(p),...v}:v);s.writes.push(p);trace.push(kind==='update'?'claim':TEAM.test(p)?'team-create':'quote-create');}return result;
 });queue=job.catch(()=>{});return job;}};
 const odds=fixture(); odds.fixtureId=fixtureId;odds.startTime=s.config.scope.startTime;
 for(const o of Object.values(odds.bookmakerOdds['betano.pt'].markets['91001'].outcomes))for(const p of Object.values(o.players)){p.playerName=s.config.scope.playerName;p.changedAt=iso(-120000);}
 const config={...s.config,db,expectedFixtureId:fixtureId,resolveOfflineQuoteSelection,makeOfflineLinkedQuoteCollector,
 async reserve(n){trace.push('reserve');assert.equal(n,2);assert.equal(s.docs.get(ap).claimedAtMs,NOW);if(s.quotaFail)throw Error('Synthetic quota denial');},
 async fetchCatalogue(){trace.push('catalogue');if(s.catFail)throw Error('Synthetic catalogue failure');return catalog();},
 async fetchOdds(){trace.push('odds');if(s.oddsFail)throw Error('Synthetic odds failure');return [odds];},
 async readPrivateEvidence(p){if(!safe(p)){violations.push('read');throw Error('Unexpected private read');}trace.push(QUOTE.test(p)?'quote-read':'team-read');const v=structuredClone(s.docs.get(p));if(s.tamperLink&&QUOTE.test(p)&&v){s.beforeTamper=structuredClone([...s.docs].filter(([key])=>safe(key)));v.quote.digest='0'.repeat(64);}return v;}
 };
 return {s,trace,violations,config,odds,run:()=>makeFixtureBoundCollection(config)(s.request),privateDocs:()=>[...s.docs].filter(([p])=>safe(p))};
}

const qdoc=x=>x.privateDocs().find(([p])=>QUOTE.test(p));
const tdoc=x=>x.privateDocs().find(([p])=>TEAM.test(p));
async function linked(x){assert.deepEqual(await x.run(),{status:'LINKED_UNREVIEWED'});assert.deepEqual(x.violations,[]);}
test('original prices and timestamps preserved exactly',async()=>{const x=actual();await linked(x);const q=qdoc(x)[1].quote;for(const [side,id] of [['Over','92001'],['Under','92002']]){const original=x.odds.bookmakerOdds['betano.pt'].markets['91001'].outcomes[id].players['93001'];assert.equal(q.outcomes[side].price,original.price);assert.equal(q.outcomes[side].changedAt,original.changedAt);assert.equal(q.outcomes[side].mainLineFlag,original.mainLine);}});
test('receipt reference and document identity match',async()=>{const x=actual();await linked(x);const [qp,d]=qdoc(x),[tp,t]=tdoc(x),q=d.quote;assert.equal(q.sourceReference,t.reference);assert.equal(tp,'_internal/teamEvidence/providerSnapshots/'+q.sourceReference);assert.equal(qp,'_internal/quoteEvidence/providerObservations/'+hash([q.sourceReference,q.fixtureId,q.providerPlayerId,q.marketId]));const r=t.records.find(r=>r.fixtureId===q.fixtureId);assert.ok(r);assert.equal(r.startTime,q.startTime);assert.deepEqual(r.participantIds,q.providerParticipantIds);assert.equal(r.capturedAt,q.capturedAt);});
test('raw unrelated provider fields excluded and research writes absent',async()=>{const x=actual();const before=new Set(x.s.docs.keys());await linked(x);const added=[...x.s.docs.keys()].filter(k=>!before.has(k));assert.equal(added.length,2);assert.ok(added.every(p=>TEAM.test(p)||QUOTE.test(p)));assert.deepEqual(x.s.writes,[ap,tdoc(x)[0],qdoc(x)[0]]);assert.doesNotMatch(JSON.stringify(x.privateDocs()),/privateToken|SYNTHETIC_PRIVATE_KEY_DO_NOT_STORE|bookmakerOdds/);for(const k of ['bookmakerVerified','espnPlayerVerified','autoLineSelected','captureAllowed'])assert.equal(qdoc(x)[1].quote[k],false);});
test('quote commit failure preserves fixture receipt and consumed permit',async()=>{const x=actual();x.s.failQuote=true;assert.deepEqual(await x.run(),{status:'UNLINKED'});assert.ok(tdoc(x));assert.equal(qdoc(x),undefined);assert.equal(x.s.docs.get(ap).claimedAtMs,NOW);const saved=structuredClone(tdoc(x));const trace=[...x.trace];x.s.failQuote=false;assert.deepEqual(await x.run(),{status:'DENIED'});assert.deepEqual(tdoc(x),saved);assert.deepEqual(x.trace,trace);assert.deepEqual(x.violations,[]);});
test('new synthetic permit creates distinct receipts without overwriting originals',async()=>{const x=actual();const original=structuredClone(x.s.docs.get(ap));await linked(x);const prior=structuredClone(x.privateDocs());/* test-only restore */x.s.docs.set(ap,original);await linked(x);assert.equal(x.privateDocs().length,4);for(const [p,v] of prior)assert.deepEqual(x.s.docs.get(p),v);assert.equal(x.trace.filter(t=>t==='team-create').length,2);assert.equal(x.trace.filter(t=>t==='quote-create').length,2);});
test('actual fixture storage refuses same-reference replay and conflicting receipt',async()=>{const x=actual();await linked(x);const [p,saved]=structuredClone(tdoc(x));const {reference,receivedAt,...rest}=saved;const batch={...rest,snapshotReference:reference};delete batch.digest;const {makeOfflineFirestoreProviderEvidenceStore}=require('../provider-evidence-firestore.js');const token={};const store=makeOfflineFirestoreProviderEvidenceStore({db:x.config.db,now:()=>NOW,isTrustedManualReceipt:async(t)=>t===token});const writes=[...x.s.writes];assert.deepEqual(await store.storeBatch(batch,token),{status:'ALREADY_STORED'});const {captureProviderFixture}=require('../offer-team-evidence.js');const changed=captureProviderFixture({...x.odds,participant1Id:'6001'},{reference,capturedAt:batch.capturedAt});assert.ok(changed);assert.deepEqual(await store.storeBatch({...batch,records:[changed]},token),{status:'CONFLICT'});assert.deepEqual(x.s.docs.get(p),saved);assert.deepEqual(x.s.writes,writes);assert.deepEqual(x.violations,[]);});
test('tampered linkage read leaves original stored receipts intact',async()=>{const x=actual();x.s.tamperLink=true;assert.deepEqual(await x.run(),{status:'UNLINKED'});assert.equal(x.s.beforeTamper?.length,2);assert.deepEqual(x.privateDocs(),x.s.beforeTamper);assert.equal(x.s.docs.get(ap).claimedAtMs,NOW);assert.deepEqual(x.violations,[]);});
