"use strict";

// Issue #97 D18: DISCONNECTED Admin Firestore review journal.
// Event documents are create-only; the fixed head is a transactional CAS.
// No Firebase SDK import, production entrypoint, HTTP or credential access.
// Backend MUST authenticate owner, original source custody and exact packet
// digest separately; this adapter alone cannot establish source provenance.
const {createHash}=require("node:crypto");

const ROOT="_internal/teamReview/fixtureJournals/";
const FID=/^[A-Za-z0-9._:-]{1,120}$/;
const HASH=/^[a-f0-9]{64}$/;
const REF=/^[A-Z][A-Z0-9_-]{5,95}$/;
const ID=/^[1-9][0-9]{0,15}$/;
const MAX=32;
const EXACT_EVENT=["schemaVersion","fixtureId","revision","action",
  "reviewedAt","packetDigest","reviewMethod","reviewerReference",
  "pairs","eventDigest"];
const EXACT_HEAD=["schemaVersion","fixtureId","packetDigest",
  "revision","lastAction","latestEventDigest","updatedAt"];
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const exact=(x,keys)=>obj(x)&&
  Object.keys(x).sort().join("|")===[...keys].sort().join("|");
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const eventId=n=>String(n).padStart(6,"0");
const eventPath=(fixtureId,revision)=>ROOT+fixtureId+"/events/"+eventId(revision);
function validEvent(event,fixtureId,expectedRevision,packetDigest) {
  if(!exact(event,EXACT_EVENT)||event.schemaVersion!==1||
    event.fixtureId!==fixtureId||event.revision!==expectedRevision+1||
    event.packetDigest!==packetDigest||
    event.reviewMethod!=="MANUAL_TWO_SOURCE_FIXTURES_ID_REVIEW"||
    !REF.test(event.reviewerReference)||
    !["APPROVE","REJECT","REVOKE"].includes(event.action)||
    typeof event.reviewedAt!=="string"||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.reviewedAt)||
    !Number.isFinite(Date.parse(event.reviewedAt))||
    !HASH.test(event.eventDigest))return false;
  if(event.action==="APPROVE") {
    if(!Array.isArray(event.pairs)||event.pairs.length!==2)return false;
    const a=new Set(),b=new Set();
    for(const p of event.pairs) {
      if(!exact(p,["providerParticipantId","espnTeamId"])||
        typeof p.providerParticipantId!=="string"||
        typeof p.espnTeamId!=="string"||
        !ID.test(p.providerParticipantId)||!ID.test(p.espnTeamId)||
        a.has(p.providerParticipantId)||b.has(p.espnTeamId))return false;
      a.add(p.providerParticipantId);b.add(p.espnTeamId);
    }
  } else if(event.pairs!==null)return false;
  const {eventDigest,...base}=event;
  return sha(base)===eventDigest;
}
function validHead(head,fixtureId) {
  return exact(head,EXACT_HEAD)&&head.schemaVersion===1&&
    head.fixtureId===fixtureId&&
    HASH.test(head.packetDigest)&&HASH.test(head.latestEventDigest)&&
    Number.isSafeInteger(head.revision)&&head.revision>0&&
    head.revision<=MAX &&
    ["APPROVE","REJECT","REVOKE"].includes(head.lastAction)&&
    typeof head.updatedAt==="string"&&
    Number.isFinite(Date.parse(head.updatedAt));
}
function makeOfflineFixtureReviewJournal({db,globalGuard=null}={}) {
  if(typeof db?.doc!=="function" ||
     typeof db?.runTransaction!=="function" ||
     typeof db?.getAll!=="function" ||
     (globalGuard!==null && typeof globalGuard!=="function"))
    throw new TypeError("Trusted Admin Firestore dependencies required.");

  async function appendDecision({fixtureId,expectedRevision,packetDigest,event}={}) {
    if(typeof fixtureId!=="string"||!FID.test(fixtureId)||
      !Number.isSafeInteger(expectedRevision)||expectedRevision<0||
      expectedRevision>=MAX||typeof packetDigest!=="string"||
      !HASH.test(packetDigest)||
      !validEvent(event,fixtureId,expectedRevision,packetDigest))
      return false;
    const headRef=db.doc(ROOT+fixtureId);
    const nextRef=db.doc(eventPath(fixtureId,expectedRevision+1));
    if(headRef?.path!==ROOT+fixtureId||
      nextRef?.path!==eventPath(fixtureId,expectedRevision+1))
      return false;

    try {
      return await db.runTransaction(async tx=>{
        let previousEvent=null;
        const old=await tx.get(headRef);
        const head=old?.exists ? old.data() : null;
        if(expectedRevision===0) {
          if(head||event.action==="REVOKE")return false;
        } else {
          if(!validHead(head,fixtureId)||
            head.revision!==expectedRevision||
            head.packetDigest!==packetDigest||
            (head.lastAction!=="APPROVE"||event.action!=="REVOKE")||
            head.updatedAt>=event.reviewedAt)return false;
          const previous=await tx.get(db.doc(eventPath(fixtureId,expectedRevision)));
          if(!previous?.exists ||
            !validEvent(previous.data(),fixtureId,expectedRevision-1,packetDigest)||
            previous.data().eventDigest!==head.latestEventDigest)
            return false;
          previousEvent=previous.data();
        }
        // D18 optional write-side global ID arbitration. It runs INSIDE
        // this transaction, before any journal or registry writes.
        // The factory stays backwards compatible with offline rehearsals;
        // production must use the separate guard-required factory.
        if(globalGuard &&
          await globalGuard({tx,fixtureId,event,previousEvent})!==true)
          return false;
        const newHead={
          schemaVersion:1,fixtureId,packetDigest,
          revision:expectedRevision+1,lastAction:event.action,
          latestEventDigest:event.eventDigest,updatedAt:event.reviewedAt
        };
        tx.create(nextRef,event);
        if(expectedRevision===0)tx.create(headRef,newHead);
        else tx.update(headRef,newHead);
        return true;
      },{maxAttempts:5});
    } catch(_){return false;}
  }

  async function loadHistory(fixtureId) {
    if(typeof fixtureId!=="string"||!FID.test(fixtureId))
      throw new Error("Invalid review fixture.");
    const snapshot=await db.doc(ROOT+fixtureId).get();
    if(!snapshot?.exists)return [];
    const head=snapshot.data();
    if(!validHead(head,fixtureId))
      throw new Error("Invalid private review head.");
    const refs=Array.from({length:head.revision},(_,i)=>
      db.doc(eventPath(fixtureId,i+1)));
    const docs=await db.getAll(...refs);
    if(!Array.isArray(docs)||docs.length!==head.revision)
      throw new Error("Incomplete review journal.");
    const events=docs.map((s,i)=>{
      const event=s?.exists?s.data():null;
      if(!validEvent(event,fixtureId,i,head.packetDigest))
        throw new Error("Invalid review event.");
      return event;
    });
    if(events.at(-1).eventDigest!==head.latestEventDigest ||
      events.at(-1).action!==head.lastAction ||
      events.at(-1).reviewedAt!==head.updatedAt)
      throw new Error("Review journal head mismatch.");
    return events;
  }
  return Object.freeze({appendDecision,loadHistory});
}

module.exports={makeOfflineFixtureReviewJournal};
