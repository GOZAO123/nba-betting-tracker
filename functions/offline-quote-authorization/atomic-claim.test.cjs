'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {makeAtomicClaim}=require('./atomic-claim.cjs');const {makeScopeBoundApprovalSchema}=require('./scope-bound-approval.cjs');
const {normalizeOfflineQuoteScope:norm}=require('../provider-player-quote-snapshot.js');
const now=Date.parse('2026-11-20T13:30:00Z'),start=now+3600000;
const scope={participant1Id:'5001',participant2Id:'5002',startTime:new Date(start).toISOString(),playerName:'Synthetic Athlete',family:'PTS',line:20.5};
const review={fixtureId:'synthetic-fixture',reviewRevision:1,reviewEventDigest:'a'.repeat(64),sourcePacketDigest:'b'.repeat(64),participant1Id:'5001',participant2Id:'5002',startTime:start,validUntilMs:start-300000};
const original=makeScopeBoundApprovalSchema(norm).create(scope,review,now,now+60000);
const owner={auth:{uid:'synthetic-owner',token:{email_verified:true}},data:{}};
function harness({record=original,current=review,tick=now,fail=false,retry=false,enabled=true,selection={...scope}}={}){
 let saved=record&&{...record},tail=Promise.resolve(),reads=0,loads=0,writes=0,attempts=0;
 const db={doc:path=>{assert.equal(path,'_internal/oneQuoteCollection/scopeBoundApprovals/'+'1'.repeat(32));return path;},runTransaction(fn){const run=tail.then(async()=>{for(let i=0;i<(retry?2:1);i++){attempts++;let staged=null;const tx={get:async()=>{reads++;return {data:()=>saved&&{...saved}};},update:(ref,value)=>{assert.deepEqual(Object.keys(value),['claimedAtMs']);staged=value;}};const result=await fn(tx);if(retry&&i===0)continue;if(fail)throw Error('synthetic commit failure');if(staged){saved={...saved,...staged};writes++;}return result;}});tail=run.catch(()=>{});return run;}};
 const claim=makeAtomicClaim({enabled,ownerUid:'synthetic-owner',approvalId:'1'.repeat(32),scope:selection,normalizeOfflineQuoteScope:norm,db,now:()=>tick,loadVerifiedReviewInTransaction:async(tx,id)=>{loads++;assert.equal(typeof tx.get,'function');assert.equal(id,review.fixtureId);return current;}});
 return {claim,stats:()=>({reads,loads,writes,attempts}),saved:()=>saved};
}
const denied={status:'DENIED'},claimed={status:'CLAIMED'};
test('valid claim commits once',async()=>{const h=harness();assert.deepEqual(await h.claim(owner),claimed);assert.equal(h.saved().claimedAtMs,now);assert.equal(h.stats().writes,1);});
for(const [name,request] of [['no auth',{}],['wrong owner',{...owner,auth:{...owner.auth,uid:'other'}}],['unverified',{...owner,auth:{...owner.auth,token:{email_verified:false}}}],['client scope',{...owner,data:{line:21.5}}]])test(name,async()=>{const h=harness();assert.deepEqual(await h.claim(request),denied);assert.equal(h.stats().attempts,0);});
for(const [name,opts] of [['disabled',{enabled:false}],['missing permit',{record:null}],['consumed',{record:{...original,claimedAtMs:now}}],['expired',{tick:now+60000}],['future',{tick:now-1}],['scope changed',{selection:{...scope,line:21.5}}],['review unavailable or revoked',{current:null}],['review revision changed',{current:{...review,reviewRevision:2}}],['packet fingerprint changed',{current:{...review,sourcePacketDigest:'c'.repeat(64)}}],['review expiry shortened',{current:{...review,validUntilMs:now+1000}}],['malformed permit',{record:{...original,extra:true}}],['commit failure',{fail:true}]])test(name,async()=>{const h=harness(opts);assert.deepEqual(await h.claim(owner),denied);assert.equal(h.stats().writes,0);});
test('serialized mock concurrent attempts one winner',async()=>{const h=harness();const results=await Promise.all([h.claim(owner),h.claim(owner)]);assert.equal(results.filter(x=>x.status==='CLAIMED').length,1);assert.equal(h.stats().writes,1);});
test('mock transaction retry commits once',async()=>{const h=harness({retry:true});assert.deepEqual(await h.claim(owner),claimed);assert.equal(h.stats().attempts,2);assert.equal(h.stats().writes,1);});
test('sequential replay denied',async()=>{const h=harness();await h.claim(owner);assert.deepEqual(await h.claim(owner),denied);assert.equal(h.stats().writes,1);});
test('scope pinned before asynchronous work',async()=>{const selection={...scope};const h=harness({selection});selection.line=99.5;assert.deepEqual(await h.claim(owner),claimed);});
