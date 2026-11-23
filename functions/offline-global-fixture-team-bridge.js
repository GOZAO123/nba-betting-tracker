"use strict";

// Issue #97 D18: disconnected global cross-fixture team-ID consistency gate.
// Consumes ONLY a server-authenticated COMPLETE, bounded review snapshot.
// It never fetches provider/ESPN data, accesses Firebase, writes a journal,
// auto-approves a pair, or modifies the production D3 empty manifest.
const {makeReviewedTeamBridgeResolver}=
  require("./offer-team-crosswalk");
const {inspectOfflineSourceBoundTeamReview}=
  require("./offline-fixtures-team-review-gate");

const MAX=128;
const QUERY_KEYS=["fixtureId","participant1Id","participant2Id","startTime"];
const SOURCE_KEYS=["fixtureId","providerReceipt","espnScoreboard",
  "espnMetadata","history"];
const SNAPSHOT_KEYS=["complete","records"];
const FID=/^[A-Za-z0-9._:-]{1,120}$/;
const ID=/^[1-9][0-9]{0,15}$/;
const obj=x=>x!==null && typeof x==="object" && !Array.isArray(x);
const exact=(x,keys)=>obj(x) &&
  Object.keys(x).sort().join("|")===[...keys].sort().join("|");

// The trusted backend MUST atomically assemble every currently relevant
// review from protected source/journal custody, and prove completeness in
// isTrustedCompleteSet. A client-provided complete:true is NOT proof.
// This helper is read-side fail-closed only; write-side global arbitration
// and same-transaction source provenance remain separate release gates.
function makeOfflineGlobalFixtureTeamBridge({
  loadCompleteReviewSet,isTrustedCompleteSet,now=Date.now
}={}) {
  if([loadCompleteReviewSet,isTrustedCompleteSet,now]
    .some(fn=>typeof fn!=="function"))
    throw new TypeError("Missing trusted complete-set dependencies.");

  async function resolve(query) {
    if(!exact(query,QUERY_KEYS)||
       typeof query.fixtureId!=="string" || !FID.test(query.fixtureId) ||
       typeof query.participant1Id!=="string" ||
       typeof query.participant2Id!=="string" ||
       !ID.test(query.participant1Id)||!ID.test(query.participant2Id)||
       query.participant1Id===query.participant2Id ||
       typeof query.startTime!=="string")
      return null;
    try {
      const tick=now();
      if(!Number.isSafeInteger(tick)||tick<0)return null;
      const snapshot=await loadCompleteReviewSet();
      if(!exact(snapshot,SNAPSHOT_KEYS) ||
         snapshot.complete!==true ||
         !Array.isArray(snapshot.records) ||
         snapshot.records.length>MAX)
        return null;
      if(await isTrustedCompleteSet(snapshot,tick)!==true)return null;

      const approved=[],seen=new Set();
      for(const entry of snapshot.records) {
        if(!exact(entry,SOURCE_KEYS) ||
           typeof entry.fixtureId!=="string" ||
           !FID.test(entry.fixtureId) ||
           seen.has(entry.fixtureId))
          return null;
        seen.add(entry.fixtureId);
        const reviewed=inspectOfflineSourceBoundTeamReview({
          ...entry,now:tick
        });
        // Never drop an invalid journal or an expired APPROVED fixture.
        // REJECTED / REVOKED / PENDING are valid but non-authorizing.
        if(!reviewed)return null;
        if(reviewed.status==="APPROVED") {
          if(!reviewed.manifest)return null;
          approved.push(reviewed.manifest);
        } else if(!["PENDING_REVIEW","REJECTED","REVOKED"]
          .includes(reviewed.status))return null;
      }

      // Existing D3 resolver validates the ENTIRE approved list before
      // resolving the requested fixture. A different fixture with the same
      // provider ID mapped to a different ESPN ID, or vice versa, poisons
      // all queries, not merely the conflicting row.
      return makeReviewedTeamBridgeResolver(approved,()=>tick)(query);
    } catch (_) {
      return null;
    }
  }
  return Object.freeze({resolve});
}
module.exports={makeOfflineGlobalFixtureTeamBridge};
