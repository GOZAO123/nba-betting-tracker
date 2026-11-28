'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {makeTransactionSourceReader}=require('./transaction-source-reader.cjs');
const {makeOfflineFixtureEspnReviewPacket:makePacket}=require('../offline-fixture-espn-review-packet.js');
const {extractOfflineFixtureTeamEvidence:extract}=require('../offline-fixture-team-evidence.js');
const {sanitizeOfflineEspnScoreboard:sanitizeScoreboard}=require('../offline-espn-scoreboard-custody.js');
const now=Date.parse('2026-11-23T16:00:00.000Z'),iso=n=>new Date(now+n).toISOString();
const fixtureId='synthetic-source-reader',pr='ODDSPAPI_FIXTURES_'+'A'.repeat(32),er='ESPN_SERVER_OBS_001';
const bp='_internal/teamReview/sourceBindings/'+fixtureId,pp='_internal/teamEvidence/fixtureTeamSnapshots/'+pr,ep='_internal/teamReview/espnSnapshots/'+er;
function setup(){
 const receipt=extract([{fixtureId,sportId:11,tournamentId:132,statusId:0,hasOdds:true,startTime:iso(10800000),updatedAt:iso(-120000),participant1Id:'5001',participant2Id:'5002',participant1Name:'Synthetic Red',participant2Name:'Synthetic Blue'}],{reference:pr,capturedAt:iso(-60000)},now);
 assert.ok(receipt);
 const scoreboard=sanitizeScoreboard({events:[{id:'401001234',date:iso(10800000),status:{type:{state:'pre'}},season:{type:2},competitions:[{competitors:[{homeAway:'home',team:{id:'13',displayName:'Synthetic ESPN Red'}},{homeAway:'away',team:{id:'14',displayName:'Synthetic ESPN Blue'}}]}]}]});
 assert.ok(scoreboard);
 const packet=makePacket({fixtureId,providerReceipt:receipt,espnScoreboard:scoreboard,espnMetadata:{reference:er,capturedAt:iso(-30000)},now});assert.ok(packet);
 const docs=new Map([[bp,{schemaVersion:1,fixtureId,providerReference:pr,espnReference:er,providerDigest:packet.provider.snapshotDigest,espnDigest:packet.espn.digest,packetDigest:packet.packetDigest}],[pp,{...receipt,receivedAt:iso(-30000)}],[ep,{schemaVersion:1,source:'ESPN_NBA_SCOREBOARD',reference:er,capturedAt:iso(-30000),scoreboard}]].map(([k,v])=>[k,structuredClone(v)]));
 const reads=[];const db={doc:path=>({path})};const tx={async get(ref){reads.push(ref.path);return {exists:docs.has(ref.path),data:()=>docs.get(ref.path)};}};
 const input={tx,fixtureId,packetDigest:packet.packetDigest,pairs:[{providerParticipantId:'5001',espnTeamId:'13'},{providerParticipantId:'5002',espnTeamId:'14'}],now};
 return {docs,reads,db,tx,input,run:()=>makeTransactionSourceReader({db,makePacket,sanitizeScoreboard})(input)};
}
test('valid source consistency, exact three transaction reads',async()=>{const s=setup();const r=await s.run();assert.equal(r?.status,'SOURCE_CONSISTENCY_ONLY');assert.equal(r.packet.approved,false);assert.deepEqual(s.reads,[bp,pp,ep]);});
for(const [name,mutate] of [
 ['missing binding',s=>s.docs.delete(bp)],['missing provider',s=>s.docs.delete(pp)],['missing ESPN',s=>s.docs.delete(ep)],['provider digest mismatch',s=>s.docs.get(bp).providerDigest='0'.repeat(64)],['ESPN digest mismatch',s=>s.docs.get(bp).espnDigest='0'.repeat(64)],['packet digest mismatch',s=>s.input.packetDigest='0'.repeat(64)],['stale evidence',s=>s.input.now+=31*60000],['fixture mismatch',s=>s.docs.get(bp).fixtureId='other'],['team mismatch',s=>s.input.pairs[0].espnTeamId='99'],['unsafe provider reference',s=>s.docs.get(bp).providerReference='../unsafe'],['unsafe ESPN reference',s=>s.docs.get(bp).espnReference='../unsafe'],['read failure',s=>s.tx.get=async()=>{throw Error('synthetic');}],['provider tampering',s=>s.docs.get(pp).records[0].participant1Name='Altered'],['ESPN tampering',s=>s.docs.get(ep).scoreboard.events[0].competitions[0].competitors[0].team.displayName='Altered'],['future receipt',s=>s.docs.get(pp).receivedAt=iso(1000)],['extra binding field',s=>s.docs.get(bp).extra=true],['duplicate pair',s=>s.input.pairs[1]=s.input.pairs[0]],['reference substitution',s=>s.db.doc=()=>({path:'wrong'})],['unsafe fixture',s=>s.input.fixtureId='..'],['missing transaction',s=>s.input.tx=null],['future ESPN capture',s=>s.docs.get(ep).capturedAt=iso(1000)]
])test(name,async()=>{const s=setup();mutate(s);assert.equal(await s.run(),null);assert.ok(s.reads.length<=3);});
