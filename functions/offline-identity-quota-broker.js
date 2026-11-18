"use strict";

// D15.4 OFFLINE-ONLY protocol. Not imported by production Firebase exports.
// The future authenticated HTTPS adapter must supply trusted, ID-token-verified
// caller identity. Never trust an identity string from HTTP body or headers.
// No Firebase, Firestore, secret, network, scheduler or provider imports.
const OPERATION="RESERVE_IDENTITY_SCHEMA_ONE_SLOT";
const PROTOCOL_VERSION=1;
const SUCCESS=Object.freeze({status:"RESERVED",protocolVersion:PROTOCOL_VERSION});
const DENIED=Object.freeze({status:"DENIED"});
const INVALID=Object.freeze({status:"INVALID_REQUEST"});
const UNAVAILABLE=Object.freeze({status:"BUDGET_UNAVAILABLE"});
const isRecord=x=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
  (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);

function validEnvelope(request){
  try {
    if(!isRecord(request)||request.method!=="POST")return false;
    const query=request.query;
    if(query!==undefined&&query!==null&&
       (!isRecord(query)||Object.keys(query).length!==0))return false;
    const body=request.body;
    if(!isRecord(body))return false;
    const keys=Object.keys(body);
    return keys.length===2&&keys.includes("operation")&&
      keys.includes("protocolVersion")&&body.operation===OPERATION&&
      body.protocolVersion===PROTOCOL_VERSION;
  }catch(_){return false;}
}
function validTrustedReceipt(receipt){
  try{
    if(!isRecord(receipt))return false;
    const {utcDay,remaining}=receipt;
    return typeof utcDay==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(utcDay)&&
      Number.isSafeInteger(remaining)&&remaining>=0&&remaining<=5;
  }catch(_){return false;}
}
function isStrictReservationAck(result){
  try{
    return isRecord(result)&&Object.keys(result).length===2&&
      result.status==="RESERVED"&&result.protocolVersion===PROTOCOL_VERSION;
  }catch(_){return false;}
}
function makeOfflineIdentityQuotaBroker({expectedCaller,verifyCaller,reserve}={}){
  if(typeof expectedCaller!=="string"||!expectedCaller||
     typeof verifyCaller!=="function"||typeof reserve!=="function")
    throw new TypeError("Missing trusted offline quota broker adapters.");
  return Object.freeze(async(request,verifiedTransportContext)=>{
    // A future authenticated ingress MUST populate verifiedTransportContext
    // from cryptographic verification/IAM, not any untrusted user input.
    let caller=null;
    try{caller=await verifyCaller(verifiedTransportContext);}catch(_){}
    if(caller!==expectedCaller)return DENIED;
    if(!validEnvelope(request))return INVALID;
    // No client-provided amount, UID, document, date or retry; ONE slot only.
    try{
      const receipt=await reserve(1);
      if(!validTrustedReceipt(receipt))return UNAVAILABLE;
      return SUCCESS;
    }catch(_){
      // Even if commit succeeded before timeout, never auto-retry.
      return UNAVAILABLE;
    }
  });
}
module.exports=Object.freeze({
  OPERATION,PROTOCOL_VERSION,makeOfflineIdentityQuotaBroker,
  isStrictReservationAck
});
