"use strict";

// D15.5: OFFLINE-ONLY authenticated ingress boundary. No HTTP handler is
// exported or registered, no Google verifier imported, and no live services.
// A future owner-approved adapter must inject a REAL cryptographic Google
// ID-token verifier and separately enforce Cloud Run Invoker IAM on the service.
const {makeOfflineIdentityQuotaBroker} = require("./offline-identity-quota-broker");
const DENIED=Object.freeze({status:"DENIED"});
const isRecord=x=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
  (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const isServiceAccount=x=>typeof x==="string"&&
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9][a-z0-9-]*\.iam\.gserviceaccount\.com$/.test(x);
function validAudience(raw){
  try{
    if(typeof raw!=="string"||!raw||raw.length>200)return false;
    const u=new URL(raw);
    return u.protocol==="https:"&&u.hostname.endsWith(".run.app")&&
      u.hostname.length>8&&u.username===""&&u.password===""&&
      u.port===""&&u.pathname==="/"&&u.search===""&&u.hash===""&&
      raw===u.origin;
  }catch(_){return false;}
}
function readAuthHeader(request){
  try{
    const h=request?.headers;
    if(!isRecord(h))return null;
    const pairs=Object.entries(h);
    if(pairs.some(([k])=>k.toLowerCase()==="x-serverless-authorization"))
      return null; // Signature is stripped by Cloud Run for this header.
    const auth=pairs.filter(([k])=>k.toLowerCase()==="authorization");
    const types=pairs.filter(([k])=>k.toLowerCase()==="content-type");
    if(auth.length!==1||types.length!==1||
       types[0][1]!=="application/json")return null;
    const value=auth[0][1];
    if(typeof value!=="string"||value.length>8200)return null;
    const match=/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(value);
    return match&&match[1].length<=8192?match[1]:null;
  }catch(_){return null;}
}
function validVerifiedClaims(claims,expectedCaller,audience,now){
  try{
    return isRecord(claims)&&claims.email===expectedCaller&&
      claims.email_verified===true&&claims.aud===audience&&
      (claims.iss==="https://accounts.google.com"||claims.iss==="accounts.google.com")&&
      typeof claims.sub==="string"&&claims.sub.length>0&&
      Number.isSafeInteger(claims.exp)&&claims.exp>Math.floor(now/1000);
  }catch(_){return false;}
}
function boundedBody(request){
  // Defense in depth only: the FUTURE HTTP adapter must impose a RAW byte
  // limit before JSON parsing. A declared Content-Length is never sufficient.
  try{
    const serialized=JSON.stringify(request?.body);
    return typeof serialized==="string"&&Buffer.byteLength(serialized,"utf8")<=256;
  }catch(_){return false;}
}
function makeOfflineAuthenticatedQuotaIngress({
  audience,expectedCaller,verifyIdToken,reserve,now=()=>Date.now()
}={}){
  if(!validAudience(audience)||!isServiceAccount(expectedCaller)||
     typeof verifyIdToken!=="function"||typeof reserve!=="function"||
     typeof now!=="function")
    throw new TypeError("Invalid trusted offline authenticated-ingress configuration.");
  const broker=makeOfflineIdentityQuotaBroker({
    expectedCaller, reserve,
    // Only the enclosing ingress builds this context after verification.
    verifyCaller:async trustedContext=>trustedContext?.verifiedPrincipal||null
  });
  return Object.freeze(async request=>{
    const token=readAuthHeader(request);
    if(!token||!boundedBody(request))return DENIED;
    try{
      // verifyIdToken MUST cryptographically verify the signature, audience,
      // expiry and Google issuer. Merely decoding JWT data is NOT sufficient.
      const claims=await verifyIdToken(token,audience);
      if(!validVerifiedClaims(claims,expectedCaller,audience,now()))return DENIED;
      const trustedContext=Object.freeze({verifiedPrincipal:claims.email});
      return await broker({
        method:request.method,query:request.query,body:request.body
      },trustedContext);
    }catch(_){
      // Never reflect tokens, verifier failures or Firestore exceptions.
      return DENIED;
    }
  });
}
module.exports=Object.freeze({makeOfflineAuthenticatedQuotaIngress});
