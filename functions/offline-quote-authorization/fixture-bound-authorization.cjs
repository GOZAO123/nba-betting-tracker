'use strict';
// Offline composition only. Local consistency is not global completeness,
// genuine source attestation, live IAM evidence or permission to call a provider.
const {makeAtomicClaim}=require('./atomic-claim.cjs');
const {makeTransactionJournalReader}=require('./transaction-journal-reader.cjs');
const {makeTransactionSourceReader}=require('./transaction-source-reader.cjs');
const {readRegistry}=require('./transaction-registry-reader.cjs');
const MIN=60000;
function makeFixtureBoundAuthorization({enabled=false,expectedFixtureId,db,ownerUid,approvalId,scope,normalizeOfflineQuoteScope,makeOfflineFixtureReviewJournal,makePacket,sanitizeScoreboard,now=Date.now,includeClaimWindow=false}={}){
 if(enabled!==true)return async()=>Object.freeze({status:'DENIED'});
 if(typeof expectedFixtureId!=='string'||!/^[A-Za-z0-9._:-]{1,120}$/.test(expectedFixtureId)||['.','..'].includes(expectedFixtureId))throw TypeError('Expected fixture required');
 if(typeof db?.doc!=='function'||typeof db?.runTransaction!=='function'||typeof now!=='function')throw TypeError('Trusted dependencies required');
 // Pin and check every reference including the permit; do not expose direct reads.
 const checkedDb={doc(path){const ref=db.doc(path);if(ref?.path!==path)throw Error('Reference mismatch');return ref;},runTransaction(fn){return db.runTransaction(fn);}};
 const journal=makeTransactionJournalReader({db:checkedDb,makeOfflineFixtureReviewJournal});
 const source=makeTransactionSourceReader({db:checkedDb,makePacket,sanitizeScoreboard});
 return makeAtomicClaim({enabled:true,ownerUid,approvalId,scope,normalizeOfflineQuoteScope,db:checkedDb,now,includeClaimWindow,
  async loadVerifiedReviewInTransaction(tx,fixtureId){
   if(fixtureId!==expectedFixtureId)return null;
   const j=await journal(tx,fixtureId);
   if(j?.status!=='APPROVED_JOURNAL_ONLY'||j.fixtureId!==fixtureId)return null;
   const tick=now();
   const s=await source({tx,fixtureId,packetDigest:j.sourcePacketDigest,pairs:j.pairs,now:tick});
   if(s?.status!=='SOURCE_CONSISTENCY_ONLY')return null;
   const p=s.packet;
   const startTime=Date.parse(p.provider.startTime),reviewed=Date.parse(j.reviewedAt),providerAt=Date.parse(p.provider.capturedAt),espnAt=Date.parse(p.espn.capturedAt);
   if(![tick,startTime,reviewed,providerAt,espnAt].every(Number.isSafeInteger)||reviewed<Math.max(providerAt,espnAt)||reviewed>tick||reviewed>=startTime-5*MIN||reviewed-providerAt>30*MIN||reviewed-espnAt>30*MIN)return null;
   const r=await readRegistry({db:checkedDb,tx,fixtureId,pairs:j.pairs});
   if(r?.status!=='REGISTRY_CONSISTENCY_ONLY'||r.fixtureId!==fixtureId)return null;
   // Cap permit lifetime at the earliest evidence/review/game deadline. The
   // atomic claim rechecks the clock after this loader returns (including retries).
   const validUntilMs=Math.min(startTime-5*MIN,reviewed+48*60*MIN,providerAt+30*MIN,espnAt+30*MIN);
   if(now()>=validUntilMs)return null;
   return Object.freeze({fixtureId,reviewRevision:j.reviewRevision,reviewEventDigest:j.reviewEventDigest,sourcePacketDigest:j.sourcePacketDigest,participant1Id:p.provider.participants[0].participantId,participant2Id:p.provider.participants[1].participantId,startTime,validUntilMs});
  }});
}
module.exports={makeFixtureBoundAuthorization};
