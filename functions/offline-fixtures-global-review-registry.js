"use strict";

// Issue #97 / D18: OFFLINE write-side global team-ID arbitration.
// This is a required-integration wrapper around the existing D18 journal;
// separate ID registry documents are updated INSIDE the same transaction
// as the immutable review event and CAS head. No Firebase imports, live
// function exports, client writes, network requests or automatic approvals.
const {makeOfflineFixtureReviewJournal}=
  require("./offline-fixtures-review-journal-firestore");

const PROVIDERS="_internal/teamReview/globalProviderIds/";
const ESPN="_internal/teamReview/globalEspnIds/";
const ID=/^[1-9][0-9]{0,15}$/;
const FID=/^[A-Za-z0-9._:-]{1,120}$/;
const MAX=128;
const KEYS=["schemaVersion","providerParticipantId","espnTeamId","fixtureIds"];
const obj=x=>x!==null && typeof x==="object" && !Array.isArray(x);
const exact=(x,fields)=>obj(x) &&
  Object.keys(x).sort().join("|")===[...fields].sort().join("|");
const uniqueSorted=ids=>Array.isArray(ids) && ids.length>0 &&
  ids.length<=MAX &&
  ids.every((id,i)=>typeof id==="string" && FID.test(id) &&
    (i===0 || ids[i-1]<id));
const sortedPlus=(ids,fixture)=>[...ids,fixture].sort();
const sortedWithout=(ids,fixture)=>ids.filter(x=>x!==fixture);

function checkRegistry(row, pair) {
  return exact(row,KEYS) && row.schemaVersion===1 &&
    row.providerParticipantId===pair.providerParticipantId &&
    row.espnTeamId===pair.espnTeamId &&
    uniqueSorted(row.fixtureIds);
}
function makeOfflineGlobalIdGuard(db) {
  return async function globalGuard({tx,fixtureId,event,previousEvent}) {
    if(!FID.test(fixtureId) || !obj(event) ||
       !["APPROVE","REJECT","REVOKE"].includes(event.action))return false;
    if(event.action==="REJECT")return previousEvent===null;
    const revoking=event.action==="REVOKE";
    if(revoking && (previousEvent?.action!=="APPROVE" ||
       !Array.isArray(previousEvent.pairs)))return false;
    const pairs=revoking?previousEvent.pairs:event.pairs;
    if(!Array.isArray(pairs)||pairs.length!==2)return false;

    const positions=[],seenPaths=new Set();
    for(const pair of pairs) {
      if(!exact(pair,["providerParticipantId","espnTeamId"])||
         !ID.test(pair.providerParticipantId) ||
         !ID.test(pair.espnTeamId))return false;
      for(const registryPath of [
        PROVIDERS+pair.providerParticipantId,ESPN+pair.espnTeamId
      ]) {
        if(seenPaths.has(registryPath))return false;
        seenPaths.add(registryPath);
        const ref=db.doc(registryPath);
        if(ref?.path!==registryPath)return false;
        positions.push({ref,pair});
      }
    }
    // ALL Firestore transaction reads precede writes. A simultaneous
    // approval of another fixture touching the same team-ID docs must
    // retry and recheck the mapping against the committed registry.
    const snapshots=await Promise.all(positions.map(({ref})=>tx.get(ref)));
    const writes=[];
    for(let i=0;i<positions.length;i++) {
      const {ref,pair}=positions[i],snap=snapshots[i];
      if(!snap || typeof snap.exists!=="boolean")return false;
      const present=snap.exists;
      const saved=present?snap.data():null;
      if(present && !checkRegistry(saved,pair))return false;
      if(revoking) {
        if(!present || !saved.fixtureIds.includes(fixtureId))return false;
        const remaining=sortedWithout(saved.fixtureIds,fixtureId);
        writes.push({ref,action:remaining.length?"update":"delete",
          value:remaining.length?{...saved,fixtureIds:remaining}:null});
      } else {
        if(present && saved.fixtureIds.includes(fixtureId))return false;
        const ids=present?sortedPlus(saved.fixtureIds,fixtureId):[fixtureId];
        if(ids.length>MAX)return false;
        writes.push({ref,action:present?"update":"create",value:{
          schemaVersion:1,
          providerParticipantId:pair.providerParticipantId,
          espnTeamId:pair.espnTeamId,fixtureIds:ids
        }});
      }
    }
    for(const write of writes) {
      if(write.action==="create")tx.create(write.ref,write.value);
      else if(write.action==="update")tx.update(write.ref,write.value);
      else tx.delete(write.ref);
    }
    return true;
  };
}

function makeOfflineGloballyGuardedReviewJournal({db}={}) {
  if(typeof db?.doc!=="function" ||
     typeof db?.runTransaction!=="function" ||
     typeof db?.getAll!=="function")
    throw new TypeError("Trusted Admin Firestore required.");
  // This wrapper cannot accidentally omit the required global guard.
  return makeOfflineFixtureReviewJournal({
    db,globalGuard:makeOfflineGlobalIdGuard(db)
  });
}
// Export the same protected registry guard for the strictly source-bound
// offline wrapper. Existing globally guarded factory behavior is unchanged.
module.exports={makeOfflineGloballyGuardedReviewJournal,makeOfflineGlobalIdGuard};
