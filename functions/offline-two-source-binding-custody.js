"use strict";

// Issue #97 D21 — DISCONNECTED create-only two-source binding custody.
// No callable, browser writer, network, actual provider authentication,
// Firestore SDK import, IAM change or production activation.
// Future trusted backend must provide real owner authority AND independent
// source-origin attestations. These injected functions are NOT proof alone.
const {isDeepStrictEqual}=require("node:util");
const {validateOfflineFixtureTeamEvidenceReceipt}=
  require("./offline-fixtures-evidence-firestore");
const {sanitizeOfflineEspnScoreboard}=
  require("./offline-espn-scoreboard-custody");
const {makeOfflineFixtureEspnReviewPacket}=
  require("./offline-fixture-espn-review-packet");

const ROOT="_internal/teamReview/sourceBindings/";
const PROVIDER_ROOT="_internal/teamEvidence/fixtureTeamSnapshots/";
const ESPN_ROOT="_internal/teamReview/espnSnapshots/";
const FID=/^[A-Za-z0-9._:-]{1,120}$/;
const PROVIDER=/^ODDSPAPI_FIXTURES_[A-F0-9]{32}$/;
const ESPN=/^ESPN_[A-Z0-9_-]{6,88}$/;
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const PROVIDER_KEYS=["schemaVersion","source","status","reference",
  "capturedAt","totalFixtures","acceptedFixtures","skippedOutsideWindow",
  "records","digest","receivedAt"];
const ESPN_KEYS=["schemaVersion","source","reference","capturedAt","scoreboard"];
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const exact=(x,fields)=>obj(x)&&
  Object.keys(x).sort().join("|")===[...fields].sort().join("|");
const validTime=x=>typeof x==="string"&&UTC.test(x)&&
  Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
const status=x=>Object.freeze({status:x});

function makeOfflineTwoSourceBindingCustody({
  db,authorizeBinding,attestSourceOrigins,now=Date.now
}={}){
  if(typeof db?.doc!=="function"||
     typeof db?.runTransaction!=="function"||
     typeof authorizeBinding!=="function"||
     typeof attestSourceOrigins!=="function"||
     typeof now!=="function")
    throw new TypeError("Trusted source binding dependencies required.");

  async function bindSources(input,token){
    if(!exact(input,["fixtureId","providerReference","espnReference"])||
       typeof input.fixtureId!=="string"||!FID.test(input.fixtureId)||
       typeof input.providerReference!=="string"||
       !PROVIDER.test(input.providerReference)||
       typeof input.espnReference!=="string"||
       !ESPN.test(input.espnReference))
      return status("INVALID_REQUEST");

    const clock=now();
    if(!Number.isSafeInteger(clock)||clock<0)return status("INVALID_REQUEST");
    // Authorization must come from the backend, not an input assertion.
    const proposal=Object.freeze({...input});
    try{
      if(await authorizeBinding(token,proposal)!==true)
        return status("DENIED");
    }catch(_){return status("DENIED");}

    try {
      const paths=[
        ROOT+input.fixtureId,
        PROVIDER_ROOT+input.providerReference,
        ESPN_ROOT+input.espnReference
      ];
      const refs=paths.map(path=>{
        const ref=db.doc(path);
        if(ref?.path!==path)throw Error("Invalid internal path");
        return ref;
      });
      return status(await db.runTransaction(async tx=>{
        if(typeof tx?.get!=="function"||typeof tx?.create!=="function")
          throw Error("Invalid Admin transaction");
        // Every source and the binding itself are read before ANY write.
        const [existing,provider,espn]=await Promise.all(
          refs.map(ref=>tx.get(ref))
        );
        if(!existing||typeof existing.exists!=="boolean"||
           !provider||typeof provider.exists!=="boolean"||
           !espn||typeof espn.exists!=="boolean")
          throw Error("Invalid source snapshot");
        if(existing.exists)return "REPLAY_BLOCKED";
        if(!provider.exists||!espn.exists)return "SOURCE_UNAVAILABLE";
        const p=provider.data(),e=espn.data();
        if(!exact(p,PROVIDER_KEYS)||!exact(e,ESPN_KEYS)||
           !validTime(p.receivedAt)||
           Date.parse(p.receivedAt)>clock||
           Date.parse(p.receivedAt)<Date.parse(p.capturedAt)||
           p.reference!==input.providerReference||
           e.schemaVersion!==1||
           e.source!=="ESPN_NBA_SCOREBOARD"||
           e.reference!==input.espnReference||
           !validTime(e.capturedAt)||
           Date.parse(e.capturedAt)>clock)
          return "SOURCE_UNAVAILABLE";
        const {receivedAt,...receipt}=p;
        // Recheck receipt's own frozen digest, fixture/team IDs, names and
        // timestamps without a second provider read or any paid request.
        const sourceAt=Date.parse(receipt.capturedAt);
        if(!Number.isSafeInteger(sourceAt)||
           !validateOfflineFixtureTeamEvidenceReceipt(receipt,sourceAt))
          return "SOURCE_UNAVAILABLE";
        const normalized=sanitizeOfflineEspnScoreboard(e.scoreboard);
        if(!normalized||!isDeepStrictEqual(normalized,e.scoreboard))
          return "SOURCE_UNAVAILABLE";

        const packet=makeOfflineFixtureEspnReviewPacket({
          fixtureId:input.fixtureId,
          providerReceipt:receipt,
          espnScoreboard:e.scoreboard,
          espnMetadata:{
            reference:e.reference,capturedAt:e.capturedAt
          },
          now:clock
        });
        if(!packet)return "SOURCE_UNAVAILABLE";
        // The verifier MUST independently attest that these particular
        // frozen source digests came from protected trusted captures.
        // It MUST be idempotent/read-only for Firestore transaction retries.
        const proof=Object.freeze({
          fixtureId:input.fixtureId,
          providerReference:p.reference,
          providerDigest:packet.provider.snapshotDigest,
          espnReference:e.reference,
          espnDigest:packet.espn.digest,
          packetDigest:packet.packetDigest
        });
        try {
          if(await attestSourceOrigins(token,proof)!==true)
            return "SOURCE_UNAVAILABLE";
        }catch(_){return "SOURCE_UNAVAILABLE";}

        tx.create(refs[0],{
          schemaVersion:1,
          fixtureId:input.fixtureId,
          providerReference:p.reference,
          espnReference:e.reference,
          providerDigest:packet.provider.snapshotDigest,
          espnDigest:packet.espn.digest,
          packetDigest:packet.packetDigest
        });
        return "STORED";
      },{maxAttempts:5}));
    }catch(_){return status("STORE_UNAVAILABLE");}
  }

  return Object.freeze({bindSources});
}

module.exports={makeOfflineTwoSourceBindingCustody};
