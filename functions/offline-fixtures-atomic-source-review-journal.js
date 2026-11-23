"use strict";

// Issue #97 D18 — DISCONNECTED source-pinned review journal.
// Every decision re-reads the SAME private provider and ESPN source docs
// within the atomic Firestore transaction used for global ID claims and
// the immutable review event. This is NOT provider-origin authentication,
// a live endpoint, or permission to create a mapping in production.
const {makeOfflineFixtureReviewJournal}=
  require("./offline-fixtures-review-journal-firestore");
const {makeOfflineGlobalIdGuard}=
  require("./offline-fixtures-global-review-registry");
const {makeOfflineFixtureEspnReviewPacket}=
  require("./offline-fixture-espn-review-packet");

const BINDINGS="_internal/teamReview/sourceBindings/";
const PROVIDERS="_internal/teamEvidence/fixtureTeamSnapshots/";
const ESPN="_internal/teamReview/espnSnapshots/";
const FIXTURE=/^[A-Za-z0-9._:-]{1,120}$/;
const PROVIDER_REF=/^ODDSPAPI_FIXTURES_[A-F0-9]{32}$/;
const ESPN_REF=/^ESPN_[A-Z0-9_-]{6,88}$/;
const HASH=/^[a-f0-9]{64}$/;
const BIND_KEYS=["schemaVersion","fixtureId","providerReference",
  "espnReference","providerDigest","espnDigest","packetDigest"];
const ESPN_KEYS=["schemaVersion","source","reference","capturedAt","scoreboard"];
const obj=x=>x!==null && typeof x==="object" && !Array.isArray(x);
const exact=(x,keys)=>obj(x) &&
  Object.keys(x).sort().join("|")===[...keys].sort().join("|");
const pathRef=(db,path)=>{
  const ref=db.doc(path);
  if(ref?.path!==path)throw new Error("Invalid internal source path.");
  return ref;
};

function validateBinding(row,fixtureId) {
  return exact(row,BIND_KEYS) &&
    row.schemaVersion===1 && row.fixtureId===fixtureId &&
    typeof row.providerReference==="string" &&
    PROVIDER_REF.test(row.providerReference) &&
    typeof row.espnReference==="string" &&
    ESPN_REF.test(row.espnReference) &&
    [row.providerDigest,row.espnDigest,row.packetDigest].every(
      d=>typeof d==="string" && HASH.test(d)
    );
}
function validateEspn(row,reference) {
  return exact(row,ESPN_KEYS) && row.schemaVersion===1 &&
    row.source==="ESPN_NBA_SCOREBOARD" &&
    row.reference===reference &&
    typeof row.capturedAt==="string" &&
    obj(row.scoreboard) &&
    Array.isArray(row.scoreboard.events) &&
    row.scoreboard.events.length>0 &&
    row.scoreboard.events.length<=40;
}
function validateProvider(row,reference) {
  if(!obj(row) || typeof row.receivedAt!=="string")return null;
  const {receivedAt,...receipt}=row;
  if(!Number.isFinite(Date.parse(receivedAt)) ||
     receipt.reference!==reference ||
     Object.keys(receipt).length!==10)return null;
  return receipt;
}

function checkSourcePairing(pairs,packet) {
  if(!Array.isArray(pairs)||pairs.length!==2)return false;
  const providers=new Set(packet.provider.participants.map(x=>x.participantId));
  const espn=new Set([packet.espn.home.teamId,packet.espn.away.teamId]);
  for(const pair of pairs) {
    if(!exact(pair,["providerParticipantId","espnTeamId"]) ||
       !providers.delete(pair.providerParticipantId) ||
       !espn.delete(pair.espnTeamId))return false;
  }
  return providers.size===0 && espn.size===0;
}

// Source binding references must be created by a separate authenticated
// backend custody operation, never by the browser. This wrapper does not
// provision any of those docs or import any Firebase SDK.
function makeOfflineSourceBoundGloballyGuardedReviewJournal({db}={}) {
  if(typeof db?.doc!=="function" ||
     typeof db?.runTransaction!=="function" ||
     typeof db?.getAll!=="function")
    throw new TypeError("Trusted Admin Firestore dependencies required.");
  const idGuard=makeOfflineGlobalIdGuard(db);
  const sourceGuard=async ({tx,fixtureId,event,previousEvent})=>{
    if(typeof fixtureId!=="string" || !FIXTURE.test(fixtureId) ||
       typeof event?.packetDigest!=="string" ||
       !HASH.test(event.packetDigest) ||
       typeof event?.reviewedAt!=="string")return false;

    // Firestore transactions read all source documents BEFORE the
    // global registry guard queues any writes.
    const bindingRef=pathRef(db,BINDINGS+fixtureId);
    const bindingSnap=await tx.get(bindingRef);
    if(!bindingSnap?.exists)return false;
    const binding=bindingSnap.data();
    if(!validateBinding(binding,fixtureId) ||
       binding.packetDigest!==event.packetDigest)return false;

    const providerRef=pathRef(db,PROVIDERS+binding.providerReference);
    const espnRef=pathRef(db,ESPN+binding.espnReference);
    const [pSnap,eSnap]=await Promise.all([
      tx.get(providerRef),tx.get(espnRef)
    ]);
    if(!pSnap?.exists||!eSnap?.exists)return false;
    const providerReceipt=validateProvider(
      pSnap.data(),binding.providerReference
    );
    const espnSource=eSnap.data();
    if(!providerReceipt ||
       !validateEspn(espnSource,binding.espnReference))return false;

    const now=Date.parse(event.reviewedAt);
    if(!Number.isSafeInteger(now))return false;
    const packet=makeOfflineFixtureEspnReviewPacket({
      fixtureId,providerReceipt,
      espnScoreboard:espnSource.scoreboard,
      espnMetadata:{
        reference:espnSource.reference,
        capturedAt:espnSource.capturedAt
      },
      now
    });
    return !!packet &&
      packet.provider.snapshotDigest===binding.providerDigest &&
      packet.espn.digest===binding.espnDigest &&
      packet.packetDigest===binding.packetDigest &&
      packet.packetDigest===event.packetDigest &&
      (event.action==="APPROVE" ?
        checkSourcePairing(event.pairs,packet) :
        event.action==="REVOKE" ?
          checkSourcePairing(previousEvent?.pairs,packet) :
          event.action==="REJECT" && event.pairs===null);
  };
  return makeOfflineFixtureReviewJournal({
    db,
    globalGuard:async context=>{
      if(await sourceGuard(context)!==true)return false;
      return await idGuard(context)===true;
    }
  });
}
module.exports={makeOfflineSourceBoundGloballyGuardedReviewJournal};
