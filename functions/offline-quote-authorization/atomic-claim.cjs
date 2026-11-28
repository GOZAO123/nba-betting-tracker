'use strict';
// Disconnected transaction adapter. Trusted review loader MUST read and validate
// all required evidence using the supplied transaction. No production wiring.
const {makeScopeBoundApprovalSchema}=require('./scope-bound-approval.cjs');
const ROOT='_internal/oneQuoteCollection/scopeBoundApprovals/';
const fields=['participant1Id','participant2Id','startTime','playerName','family','line'];
function makeAtomicClaim({enabled=false,ownerUid,approvalId,scope,normalizeOfflineQuoteScope,db,loadVerifiedReviewInTransaction,now=Date.now}={}) {
 const deny=()=>Object.freeze({status:'DENIED'});
 if(enabled!==true)return async()=>deny();
 if(typeof ownerUid!=='string'||!ownerUid||typeof approvalId!=='string'||!/^[a-f0-9]{32}$/.test(approvalId)||typeof db?.doc!=='function'||typeof db?.runTransaction!=='function'||typeof loadVerifiedReviewInTransaction!=='function'||typeof now!=='function')throw TypeError('Invalid trusted configuration');
 if(!scope||Object.getPrototypeOf(scope)!==Object.prototype||Reflect.ownKeys(scope).length!==fields.length||!fields.every(k=>Object.hasOwn(scope,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(scope,k),'value')&&['string','number'].includes(typeof scope[k])))throw TypeError('Invalid scope');
 const pinned=Object.freeze({...scope});
 const schema=makeScopeBoundApprovalSchema(normalizeOfflineQuoteScope);
 if(!normalizeOfflineQuoteScope(pinned))throw TypeError('Invalid scope');
 return async request=>{
  try {
   if(request?.auth?.uid!==ownerUid||request.auth.token?.email_verified!==true||!request.data||Object.getPrototypeOf(request.data)!==Object.prototype||Reflect.ownKeys(request.data).length!==0)return deny();
   const ref=db.doc(ROOT+approvalId);
   const result=await db.runTransaction(async tx=>{
    const record=(await tx.get(ref)).data();
    if(!record||typeof record.fixtureId!=='string'||!/^[A-Za-z0-9._:-]{1,120}$/.test(record.fixtureId)||record.claimedAtMs!==null)return false;
    // The injected loader is not itself proof of genuine source origin or completeness.
    const review=await loadVerifiedReviewInTransaction(tx,record.fixtureId);
    const tick=now();
    if(!schema.matches(record,pinned,review,tick))return false;
    tx.update(ref,{claimedAtMs:tick});
    return true;
   });
   return result===true?Object.freeze({status:'CLAIMED'}):deny();
  } catch{return deny();}
 };
}
module.exports={makeAtomicClaim};
