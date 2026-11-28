'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {makeTransactionJournalReader}=require('./transaction-journal-reader.cjs');
const {makeOfflineFixtureReviewJournal}=require('../offline-fixtures-review-journal-firestore.js');
const fid='synthetic-journal-reader';
const root='_internal/teamReview/fixtureJournals/'+fid;
const ep=n=>root+'/events/'+String(n).padStart(6,'0');
const packet='a'.repeat(64);
function event(action='APPROVE',revision=1){
 const base={schemaVersion:1,fixtureId:fid,revision,action,reviewedAt:new Date(Date.UTC(2026,10,20,13,revision)).toISOString(),packetDigest:packet,reviewMethod:'MANUAL_TWO_SOURCE_FIXTURES_ID_REVIEW',reviewerReference:'SYNTHETIC_REVIEWER',pairs:action==='APPROVE'?[{providerParticipantId:'5001',espnTeamId:'211'},{providerParticipantId:'5002',espnTeamId:'212'}]:null};
 return {...base,eventDigest:createHash('sha256').update(JSON.stringify(base)).digest('hex')};
}
const head=e=>({schemaVersion:1,fixtureId:fid,packetDigest:packet,revision:e.revision,lastAction:e.action,latestEventDigest:e.eventDigest,updatedAt:e.reviewedAt});
function setup(){
 const e=event(),docs=new Map([[root,head(e)],[ep(1),e]]),reads=[];
 const db={doc:path=>({path,get(){throw Error('Direct read prohibited');}}),getAll(){throw Error('Direct read prohibited');},runTransaction(){throw Error('Nested transaction prohibited');}};
 const tx={async get(ref){reads.push(ref.path);const value=docs.get(ref.path);return {exists:value!==undefined,data:()=>structuredClone(value)};},update(){throw Error('Write prohibited');},create(){throw Error('Write prohibited');},set(){throw Error('Write prohibited');},delete(){throw Error('Write prohibited');}};
 const reader=makeTransactionJournalReader({db,makeOfflineFixtureReviewJournal});
 return {docs,reads,tx,db,reader,run:()=>reader(tx,fid)};
}
test('approved journal uses only exact transaction reads',async()=>{const x=setup(),r=await x.run();assert.equal(r.status,'APPROVED_JOURNAL_ONLY');assert.equal(r.fixtureId,fid);assert.equal(r.reviewRevision,1);assert.equal(r.reviewEventDigest,x.docs.get(ep(1)).eventDigest);assert.equal(r.sourcePacketDigest,packet);assert.deepEqual(x.reads,[root,ep(1)]);assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.pairs)&&Object.isFrozen(r.pairs[0]));});
const cases=[
 ['missing head',x=>x.docs.delete(root),1],
 ['missing event',x=>x.docs.delete(ep(1)),2],
 ['extra head field',x=>x.docs.get(root).extra=true,1],
 ['wrong head fixture',x=>x.docs.get(root).fixtureId='other',1],
 ['head revision exceeds bound',x=>x.docs.get(root).revision=33,1],
 ['head revision zero',x=>x.docs.get(root).revision=0,1],
 ['head digest mismatch',x=>x.docs.get(root).latestEventDigest='b'.repeat(64),2],
 ['packet digest mismatch',x=>x.docs.get(root).packetDigest='b'.repeat(64),2],
 ['head time mismatch',x=>x.docs.get(root).updatedAt='2026-11-20T13:02:00.000Z',2],
 ['head action mismatch',x=>x.docs.get(root).lastAction='REJECT',2],
 ['event tampering',x=>x.docs.get(ep(1)).pairs[0].espnTeamId='999',2],
 ['event revision mismatch',x=>x.docs.get(ep(1)).revision=2,2],
 ['rejected review',x=>{const e=event('REJECT');x.docs.set(ep(1),e);x.docs.set(root,head(e));},2],
 ['revoked review',x=>{const e=event('REVOKE',2);x.docs.set(ep(2),e);x.docs.set(root,head(e));},3],
 ['invalid second approval',x=>{const e=event('APPROVE',2);x.docs.set(ep(2),e);x.docs.set(root,head(e));},3],
 ['invalid first revoke',x=>{const e=event('REVOKE');x.docs.set(ep(1),e);x.docs.set(root,head(e));},2],
 ['transaction read failure',x=>x.tx.get=async()=>{throw Error('failure');},0],
];
for(const [name,mutate,count] of cases)test(name,async()=>{const x=setup();mutate(x);assert.equal(await x.run(),null);assert.equal(x.reads.length,count);});
test('invalid fixture rejected before reads',async()=>{const x=setup();assert.equal(await x.reader(x.tx,'../unsafe'),null);assert.equal(x.reads.length,0);});
test('missing transaction rejected',async()=>{const x=setup();assert.equal(await x.reader(null,fid),null);assert.equal(x.reads.length,0);});
test('reference substitution rejected before reads',async()=>{const x=setup();x.db.doc=()=>({path:'wrong'});assert.equal(await x.run(),null);assert.equal(x.reads.length,0);});
test('maximum journal reads bounded',async()=>{const x=setup();for(let i=1;i<=32;i++)x.docs.set(ep(i),event('APPROVE',i));x.docs.set(root,head(x.docs.get(ep(32))));assert.equal(await x.run(),null);assert.equal(x.reads.length,33);});
