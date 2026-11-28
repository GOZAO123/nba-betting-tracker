'use strict';
// Disconnected rehearsal. No SDK, transport, secret access or production export.
const {makeFixtureBoundAuthorization}=require('./fixture-bound-authorization.cjs');
const fields=['participant1Id','participant2Id','startTime','playerName','family','line'];
function makeFixtureBoundCollection({enabled=false,expectedFixtureId,scope,normalizeOfflineQuoteScope,resolveOfflineQuoteSelection,makeOfflineLinkedQuoteCollector,db,ownerUid,approvalId,makeOfflineFixtureReviewJournal,makePacket,sanitizeScoreboard,now=Date.now,reserve,fetchCatalogue,fetchOdds,readPrivateEvidence,waitBetweenRequests=async()=>{}}={}){
 const denied=()=>Object.freeze({status:'DENIED'});
 if(enabled!==true)return async()=>denied();
 if(!scope||Object.getPrototypeOf(scope)!==Object.prototype||Reflect.ownKeys(scope).length!==fields.length||!fields.every(k=>Object.hasOwn(scope,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(scope,k),'value')&&['string','number'].includes(typeof scope[k])))throw TypeError('Invalid scope');
 const pinned=Object.freeze({...scope});
 if([normalizeOfflineQuoteScope,resolveOfflineQuoteSelection,makeOfflineLinkedQuoteCollector,reserve,fetchCatalogue,fetchOdds,readPrivateEvidence,waitBetweenRequests].some(f=>typeof f!=='function'))throw TypeError('Trusted dependencies required');
 const normalized=normalizeOfflineQuoteScope(pinned);
 if(!normalized)throw TypeError('Invalid scope');
 const authorize=makeFixtureBoundAuthorization({enabled:true,expectedFixtureId,scope:pinned,normalizeOfflineQuoteScope,db,ownerUid,approvalId,makeOfflineFixtureReviewJournal,makePacket,sanitizeScoreboard,now});
 return async request=>{
  if((await authorize(request)).status!=='CLAIMED')return denied();
  // The actual collector must reserve before accessing either injected fetch.
  // A fresh instance is created only AFTER successful commit; no replay/retry.
  let reservationStarted=false,reserved=false,catalogue=null,catUsed=false,oddsUsed=false;
  try {
   const collector=makeOfflineLinkedQuoteCollector({enabled:true,ownerUid,db,now,trustedQuoteScope:pinned,readPrivateEvidence,waitBetweenRequests,
    async reserve(n){
     if(reservationStarted||n!==2)throw Error('Unexpected reservation');
     reservationStarted=true;
     await reserve(n);
     reserved=true;
    },
    async fetchCatalogue(){if(!reserved||catUsed)throw Error('Catalogue unavailable');catUsed=true;catalogue=structuredClone(await fetchCatalogue());return structuredClone(catalogue);},
    async fetchOdds(){if(!reserved||!catalogue||oddsUsed)throw Error('League unavailable');oddsUsed=true;const odds=structuredClone(await fetchOdds());const selection=resolveOfflineQuoteSelection(normalized,catalogue,odds);if(!selection||selection.fixtureId!==expectedFixtureId)throw Error('Authorized fixture/selection unavailable');return odds;}
   });
   const result=await collector({auth:{uid:ownerUid,token:{email_verified:true}},data:{}});
   return Object.freeze({status:result==='LINKED_UNREVIEWED'?'LINKED_UNREVIEWED':'UNLINKED'});
  }catch{return Object.freeze({status:'ATTEMPT_FAILED'});}
 };
}
module.exports={makeFixtureBoundCollection};
