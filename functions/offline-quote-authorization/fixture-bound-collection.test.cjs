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

function downstream(){
 const s=setup();const trace=[];let calls=0;
 const odds=fixture();odds.fixtureId=fixtureId;odds.startTime=s.config.scope.startTime;
 for(const outcome of Object.values(odds.bookmakerOdds['betano.pt'].markets['91001'].outcomes))for(const p of Object.values(outcome.players))p.playerName=s.config.scope.playerName;
 const config={...s.config,expectedFixtureId:fixtureId,resolveOfflineQuoteSelection,
  async reserve(n){trace.push('reserve');assert.equal(n,2);assert.equal(s.docs.get(ap).claimedAtMs,NOW);},
  async fetchCatalogue(){trace.push('catalogue');return catalog();},async fetchOdds(){trace.push('odds');return [odds];},readPrivateEvidence:async()=>null,
  makeOfflineLinkedQuoteCollector(opts){calls++;return async()=>{await opts.reserve(2);await opts.fetchCatalogue();await opts.fetchOdds();trace.push('sink');return 'LINKED_UNREVIEWED';};}
 };return {s,trace,config,odds,calls:()=>calls,run:()=>makeFixtureBoundCollection(config)(s.request)};
}
test('valid selection reaches synthetic sink after committed permit and quota',async()=>{const x=downstream();assert.deepEqual(await x.run(),{status:'LINKED_UNREVIEWED'});assert.deepEqual(x.trace,['reserve','catalogue','odds','sink']);assert.equal(x.calls(),1);});
for(const [name,mutate] of [['wrong expected fixture',x=>x.config.expectedFixtureId='different'],['wrong owner',x=>x.s.request.auth.uid='other'],['revoked or missing journal',x=>x.s.docs.delete(rootJ)],['failed commit',x=>x.s.fail=true],['disabled',x=>x.config.enabled=false]])test(name,async()=>{const x=downstream();mutate(x);assert.deepEqual(await x.run(),{status:'DENIED'});assert.deepEqual(x.trace,[]);assert.equal(x.calls(),0);});
for(const [name,mutate] of [['substituted fixture',x=>x.odds.fixtureId='different'],['wrong participant',x=>x.odds.participant1Id='9999'],['wrong start',x=>x.odds.startTime=iso(10900000)],['wrong player',x=>{for(const o of Object.values(x.odds.bookmakerOdds['betano.pt'].markets['91001'].outcomes))for(const p of Object.values(o.players))p.playerName='Other';}],['ambiguous fixture',x=>x.config.fetchOdds=async()=>[x.odds,structuredClone(x.odds)]],['provider failure',x=>x.config.fetchOdds=async()=>{throw Error('synthetic');}]])test(name,async()=>{const x=downstream();mutate(x);assert.deepEqual(await x.run(),{status:'ATTEMPT_FAILED'});assert.equal(x.trace.includes('sink'),false);assert.equal(x.s.docs.get(ap).claimedAtMs,NOW);assert.deepEqual(await x.run(),{status:'DENIED'});});
test('quota failure blocks both fetches',async()=>{const x=downstream();x.config.reserve=async()=>{throw Error('quota');};assert.deepEqual(await x.run(),{status:'ATTEMPT_FAILED'});assert.deepEqual(x.trace,[]);});
test('replay never reaches collector again',async()=>{const x=downstream();assert.equal((await x.run()).status,'LINKED_UNREVIEWED');assert.equal((await x.run()).status,'DENIED');assert.equal(x.calls(),1);});

test('overlapping reservation calls reach the quota adapter once', async () => {
 const x = downstream();
 let completeReservation;
 const pendingReservation = new Promise(resolve => { completeReservation = resolve; });
 let reservationCalls = 0;
 x.config.reserve = () => { reservationCalls++; return pendingReservation; };
 x.config.makeOfflineLinkedQuoteCollector = opts => async () => {
  const first = opts.reserve(2);
  const second = opts.reserve(2);
  const earlyFetch = assert.rejects(opts.fetchCatalogue(), /Catalogue unavailable/);
  completeReservation();
  const outcomes = await Promise.allSettled([first, second]);
  await earlyFetch;
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'rejected']);
  assert.match(outcomes[1].reason.message, /Unexpected reservation/);
  await opts.fetchCatalogue();
  return 'UNLINKED';
 };
 assert.deepEqual(await x.run(), {status:'UNLINKED'});
 assert.equal(reservationCalls, 1);
 assert.deepEqual(x.trace, ['catalogue']);
});

test('lost claim acknowledgement denies collection even if the claim committed', async () => {
 const x = downstream();
 const db = x.config.db;
 let loseAcknowledgement = true;
 x.config.db = {...db, async runTransaction(work) {
  const result = await db.runTransaction(work);
  if (loseAcknowledgement) {
   loseAcknowledgement = false;
   assert.equal(result, true);
   throw Error('Synthetic lost commit acknowledgement');
  }
  return result;
 }};
 assert.deepEqual(await x.run(), {status:'DENIED'});
 assert.equal(x.s.docs.get(ap).claimedAtMs, NOW);
 assert.deepEqual(await x.run(), {status:'DENIED'});
 assert.equal(x.calls(), 0);
 assert.deepEqual(x.trace, []);
});
