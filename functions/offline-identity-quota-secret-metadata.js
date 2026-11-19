"use strict";

// D15.10 OFFLINE research prototype — NEVER imported by production exports.
// A future privileged broker would use a separate *metadata-only* Secret
// Manager resource, ideally zero SecretVersions, scoped IAM to that one
// secret, and ETag compare-and-swap. Nothing here creates a secret, issues
// an API request or replaces the live Firestore quota.
const RESOURCE_NAME=
  "projects/nba-betting-tracker-3979d/secrets/NBA_DIAGNOSTIC_QUOTA_STATE";
const STATE_KEY="nba_diagnostic_budget_v1";
const LIMIT=6;
const VERSION=1;
const isRecord=x=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
  (Object.getPrototypeOf(x)===Object.prototype||
   Object.getPrototypeOf(x)===null);
const unavailable=()=>new Error("Shared diagnostic metadata quota unavailable.");
function validDay(day){
  if(typeof day!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(day))return false;
  try{return new Date(day+"T00:00:00.000Z").toISOString().slice(0,10)===day;}
  catch(_){return false;}
}
function readState(secret){
  if(!isRecord(secret)||secret.name!==RESOURCE_NAME||
     typeof secret.etag!=="string"||
     secret.etag.length<3||secret.etag.length>200||
     !isRecord(secret.annotations)||
     Object.keys(secret.annotations).length!==1||
     !Object.prototype.hasOwnProperty.call(secret.annotations,STATE_KEY)||
     typeof secret.annotations[STATE_KEY]!=="string"||
     secret.annotations[STATE_KEY].length>300)throw unavailable();
  const state=JSON.parse(secret.annotations[STATE_KEY]);
  if(!isRecord(state)||Object.keys(state).length!==4||
     state.schemaVersion!==VERSION||state.limit!==LIMIT||
     !validDay(state.utcDay)||!Number.isSafeInteger(state.reserved)||
     state.reserved<0||state.reserved>LIMIT)throw unavailable();
  return state;
}
function makeOfflineSecretMetadataQuotaReservation({
  getSecret,updateSecret,now=()=>Date.now()
}={}){
  if(typeof getSecret!=="function"||typeof updateSecret!=="function"||
     typeof now!=="function")
    throw new TypeError("Missing trusted Secret Manager metadata adapters.");
  return Object.freeze(async function reserve(amount){
    // Both the legacy market audit (up to two) and identity diagnostic (one)
    // must eventually use ONE authority; this offline module is NOT the
    // authority while production continues using Firestore.
    if(amount!==1&&amount!==2)throw unavailable();
    try{
      const tick=now();
      if(!Number.isSafeInteger(tick)||tick<0)throw unavailable();
      const day=new Date(tick).toISOString().slice(0,10);
      const old=await getSecret({name:RESOURCE_NAME});
      const state=readState(old);
      if(state.utcDay>day)throw unavailable();
      const previouslyUsed=state.utcDay===day?state.reserved:0;
      const nextCount=previouslyUsed+amount;
      if(nextCount>LIMIT)throw unavailable();
      const nextState={schemaVersion:VERSION,utcDay:day,
        reserved:nextCount,limit:LIMIT};
      const nextAnnotation=JSON.stringify(nextState);
      // Real Secret Manager PATCH with ETag rejects stale state with
      // FAILED_PRECONDITION. NEVER silently retry a failed/ambiguous
      // write, and NEVER issue an upstream provider request without
      // an exact, independently acknowledged update.
      const updated=await updateSecret({
        secret:{
          name:RESOURCE_NAME,
          etag:old.etag,
          annotations:{[STATE_KEY]:nextAnnotation}
        },
        updateMask:{paths:["annotations"]}
      });
      if(!isRecord(updated)||updated.name!==RESOURCE_NAME||
         typeof updated.etag!=="string"||
         updated.etag===old.etag||
         !isRecord(updated.annotations)||
         updated.annotations[STATE_KEY]!==nextAnnotation||
         Object.keys(updated.annotations).length!==1)
        throw unavailable();
      return Object.freeze({utcDay:day,remaining:LIMIT-nextCount});
    }catch(_){
      // Some upstream commits may succeed before an unknown network error.
      // An unused reservation is safer than an unreserved paid API call.
      throw unavailable();
    }
  });
}
module.exports=Object.freeze({
  RESOURCE_NAME,STATE_KEY,LIMIT,
  makeOfflineSecretMetadataQuotaReservation
});
