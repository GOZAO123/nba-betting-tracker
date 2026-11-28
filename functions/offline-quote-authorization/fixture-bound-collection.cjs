'use strict';
// Disconnected rehearsal. No SDK, transport, secret access or production export.
const {makeFixtureBoundAuthorization}=require('./fixture-bound-authorization.cjs');
const {makeOfflineSharedBudgetReservation,isOfflineSharedBudgetReceipt}=require('../offline-identity-quota-firestore-reserve.js');
const fields=['participant1Id','participant2Id','startTime','playerName','family','line'];
function makeFixtureBoundCollection({enabled=false,expectedFixtureId,scope,normalizeOfflineQuoteScope,resolveOfflineQuoteSelection,makeOfflineLinkedQuoteCollector,db,ownerUid,approvalId,makeOfflineFixtureReviewJournal,makePacket,sanitizeScoreboard,now=Date.now,fetchCatalogue,fetchOdds,readPrivateEvidence,waitBetweenRequests=async()=>{}}={}){
 const denied=()=>Object.freeze({status:'DENIED'});
 if(enabled!==true)return async()=>denied();
 if(!scope||Object.getPrototypeOf(scope)!==Object.prototype||Reflect.ownKeys(scope).length!==fields.length||!fields.every(k=>Object.hasOwn(scope,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(scope,k),'value')&&['string','number'].includes(typeof scope[k])))throw TypeError('Invalid scope');
 const pinned=Object.freeze({...scope});
 if([normalizeOfflineQuoteScope,resolveOfflineQuoteSelection,makeOfflineLinkedQuoteCollector,fetchCatalogue,fetchOdds,readPrivateEvidence,waitBetweenRequests].some(f=>typeof f!=='function'))throw TypeError('Trusted dependencies required');
 const normalized=normalizeOfflineQuoteScope(pinned);
 if(!normalized)throw TypeError('Invalid scope');
 const authorize=makeFixtureBoundAuthorization({enabled:true,expectedFixtureId,scope:pinned,normalizeOfflineQuoteScope,db,ownerUid,approvalId,makeOfflineFixtureReviewJournal,makePacket,sanitizeScoreboard,now,includeClaimWindow:true});
 const reserve=makeOfflineSharedBudgetReservation({getFirestore:()=>db,now});
 return async request=>{
  const claim=await authorize(request);
  if(claim.status!=='CLAIMED')return denied();
  // The actual collector must reserve before accessing either injected fetch.
  // A fresh instance is created only AFTER successful commit; no replay/retry.
  let reservationStarted=false,reserved=false,catalogue=null,catUsed=false,oddsUsed=false;
  try {
   const day=new Date(claim.window.claimedAtMs).toISOString().slice(0,10);
   let latestTick=claim.window.claimedAtMs;
   function requireLiveClaim(){
    const tick=now();
    if(!Number.isSafeInteger(tick)||tick<latestTick||tick>=claim.window.expiresAtMs||
       new Date(tick).toISOString().slice(0,10)!==day)throw Error('Collection window closed');
    latestTick=tick;
   }
   const collector=makeOfflineLinkedQuoteCollector({enabled:true,ownerUid,db,now,trustedQuoteScope:pinned,readPrivateEvidence,waitBetweenRequests,
    async reserve(n){
     if(reservationStarted||n!==2)throw Error('Unexpected reservation');
     reservationStarted=true;
     requireLiveClaim();
     const receipt=await reserve(n,claim.window);
     if(!isOfflineSharedBudgetReceipt(receipt,n,day))throw Error('Quota receipt unavailable');
     requireLiveClaim();
     reserved=true;
    },
    async fetchCatalogue(){if(!reserved||catUsed)throw Error('Catalogue unavailable');requireLiveClaim();catUsed=true;catalogue=structuredClone(await fetchCatalogue());return structuredClone(catalogue);},
    async fetchOdds(){if(!reserved||!catalogue||oddsUsed)throw Error('League unavailable');requireLiveClaim();oddsUsed=true;const odds=structuredClone(await fetchOdds());const selection=resolveOfflineQuoteSelection(normalized,catalogue,odds);if(!selection||selection.fixtureId!==expectedFixtureId)throw Error('Authorized fixture/selection unavailable');return odds;}
   });
   const result=await collector({auth:{uid:ownerUid,token:{email_verified:true}},data:{}});
   return Object.freeze({status:result==='LINKED_UNREVIEWED'?'LINKED_UNREVIEWED':'UNLINKED'});
  }catch{return Object.freeze({status:'ATTEMPT_FAILED'});}
 };
}
module.exports={makeFixtureBoundCollection};
