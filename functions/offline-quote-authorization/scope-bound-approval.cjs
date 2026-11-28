'use strict';
// Offline schema only. No authorization, DB, network or production wiring.
const {createHash}=require('node:crypto');
const exact=(v,keys)=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.getOwnPropertyDescriptor(v,k).get===undefined&&Object.getOwnPropertyDescriptor(v,k).set===undefined);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fid=v=>typeof v==='string'&&/^[A-Za-z0-9._:-]{1,120}$/.test(v);
const time=v=>Number.isSafeInteger(v)&&v>=0;
const scopeKeys=['participant1Id','participant2Id','startTime','playerName','family','line'];
const reviewKeys=['fixtureId','reviewRevision','reviewEventDigest','sourcePacketDigest','participant1Id','participant2Id','startTime','validUntilMs'];
const recordKeys=['schemaVersion','fixtureId','reviewRevision','reviewEventDigest','sourcePacketDigest','scopeDigest','issuedAtMs','expiresAtMs','claimedAtMs'];
function makeScopeBoundApprovalSchema(normalizeOfflineQuoteScope){
 if(typeof normalizeOfflineQuoteScope!=='function')throw new TypeError('Existing normalizer required');
 function binding(scope,review){
  if(!exact(scope,scopeKeys)||!exact(review,reviewKeys))return null;
  const normalized=normalizeOfflineQuoteScope({...scope});
  if(!normalized||!fid(review.fixtureId)||!Number.isSafeInteger(review.reviewRevision)||review.reviewRevision<1||review.reviewRevision>32||!hex(review.reviewEventDigest)||!hex(review.sourcePacketDigest)||!time(review.validUntilMs)||!time(review.startTime)||review.validUntilMs>review.startTime-300000||normalized.startTime!==review.startTime||normalized.participant1Id!==review.participant1Id||normalized.participant2Id!==review.participant2Id)return null;
  return {fixtureId:review.fixtureId,reviewRevision:review.reviewRevision,reviewEventDigest:review.reviewEventDigest,sourcePacketDigest:review.sourcePacketDigest,scopeDigest:hash(['NBA_SCOPE_V1',review.fixtureId,normalized.participant1Id,normalized.participant2Id,normalized.startTime,normalized.playerName,normalized.family,normalized.line]),validUntilMs:review.validUntilMs};
 }
 function create(scope,review,issuedAtMs,expiresAtMs){try{
  const b=binding(scope,review);if(!b||!time(issuedAtMs)||!time(expiresAtMs)||expiresAtMs<=issuedAtMs||expiresAtMs-issuedAtMs>900000||expiresAtMs>b.validUntilMs)return null;
  const {validUntilMs,...fields}=b;return Object.freeze({schemaVersion:1,...fields,issuedAtMs,expiresAtMs,claimedAtMs:null});
 }catch{return null;}}
 function matches(record,scope,review,now){try{
  if(!exact(record,recordKeys)||record.claimedAtMs!==null||!time(now)||now<record.issuedAtMs||now>=record.expiresAtMs)return false;
  const expected=create(scope,review,record.issuedAtMs,record.expiresAtMs);
  return !!expected&&recordKeys.every(k=>record[k]===expected[k]);
 }catch{return false;}}
 return Object.freeze({create,matches});
}
module.exports={makeScopeBoundApprovalSchema};
