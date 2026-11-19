"use strict";

// D15.6 OFFLINE only. NOT imported from functions/index.js, not deployed.
// Trusted future runtime must inject Google's keyless getIdTokenClient(audience)
// and a single-shot HTTP fetch (NOT an automatically retrying auth.request).
const {OPERATION,PROTOCOL_VERSION,isStrictReservationAck}=
  require("./offline-identity-quota-broker");

const RESPONSE_MAX_BYTES=256;
const REQUEST_TIMEOUT_MS=6000;
const REQUEST_BODY=JSON.stringify({
  operation:OPERATION,protocolVersion:PROTOCOL_VERSION
});
const failure=()=>Object.assign(new Error(
  "Private quota reservation unavailable. No provider request authorized."
),{code:"unavailable"});
const invalid=()=>Object.assign(new Error(
  "Private quota reservation accepts exactly one slot."
),{code:"invalid-argument"});

function validAudience(audience){
  try{
    if(typeof audience!=="string"||audience.length>200)return false;
    const u=new URL(audience);
    return u.protocol==="https:"&&u.hostname.endsWith(".run.app")&&
      u.hostname.length>8&&u.username===""&&u.password===""&&
      u.port===""&&u.pathname==="/"&&u.search===""&&u.hash===""&&
      audience===u.origin;
  }catch(_){return false;}
}
function bearerToken(headers){
  try{
    if(!headers||typeof headers!=="object")return null;
    let auth;
    if(typeof headers.get==="function"){
      auth=headers.get("authorization");
    }else{
      const keys=Object.keys(headers).filter(k=>k.toLowerCase()==="authorization");
      if(keys.length!==1)return null;
      auth=headers[keys[0]];
    }
    if(typeof auth!=="string"||auth.length>8200)return null;
    const match=/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(auth);
    return match&&match[1].length<=8192?match[1]:null;
  }catch(_){return null;}
}
async function parseBoundedAck(response,audience){
  if(!response||response.ok!==true||response.status!==200||
     response.redirected!==false||!response.headers||
     typeof response.headers.get!=="function"||
     !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
       response.headers.get("content-type")||"")||
     response.url!==audience&&response.url!==audience+"/"||
     !response.body||typeof response.body.getReader!=="function")throw failure();
  const declared=response.headers.get("content-length");
  if(declared!==null&&declared!==undefined&&
     (!/^\d+$/.test(String(declared))||Number(declared)>RESPONSE_MAX_BYTES))
    throw failure();
  const reader=response.body.getReader();
  let chunks=[],total=0,done=false;
  try{
    while(true){
      const next=await reader.read();
      if(next.done){done=true;break;}
      if(!(next.value instanceof Uint8Array))throw failure();
      total+=next.value.byteLength;
      if(total>RESPONSE_MAX_BYTES)throw failure();
      chunks.push(Buffer.from(next.value));
    }
    if(total===0)throw failure();
    const body=new TextDecoder("utf-8",{fatal:true})
      .decode(Buffer.concat(chunks,total));
    const result=JSON.parse(body);
    if(!isStrictReservationAck(result))throw failure();
    return result;
  }catch(_){throw failure();}
  finally{
    if(!done){try{await reader.cancel();}catch(_){}}
    try{reader.releaseLock();}catch(_){}
  }
}
function makeOfflineIdentityQuotaCaller({audience,getIdTokenClient,fetchImpl,
  makeSignal=()=>AbortSignal.timeout(REQUEST_TIMEOUT_MS)}={}){
  if(!validAudience(audience)||typeof getIdTokenClient!=="function"||
     typeof fetchImpl!=="function"||typeof makeSignal!=="function")
    throw new TypeError("Invalid trusted offline quota caller configuration.");
  return Object.freeze(async function reserve(amount){
    // No authentication, HTTPS, Firebase or paid provider work for an invalid
    // amount. User/browser data cannot set amount, URL or broker audience.
    if(amount!==1)throw invalid();
    try{
      const authClient=await getIdTokenClient(audience);
      if(!authClient||typeof authClient.getRequestHeaders!=="function")
        throw failure();
      // Deliberately don't use authClient.request/fetch: a library might
      // transparently retry on 401/403. Only one explicit fetch follows.
      const headers=await authClient.getRequestHeaders(audience);
      const token=bearerToken(headers);
      if(!token)throw failure();
      const signal=makeSignal();
      if(!signal||typeof signal.aborted!=="boolean")throw failure();
      const response=await fetchImpl(audience,{
        method:"POST",redirect:"error",cache:"no-store",signal,
        headers:Object.freeze({
          Authorization:"Bearer "+token,
          "Content-Type":"application/json",
          Accept:"application/json"
        }),
        body:REQUEST_BODY
      });
      return await parseBoundedAck(response,audience);
    }catch(_){
      // Timeout after Firestore commit may have spent a slot. Never retry,
      // refund, log secrets or allow a provider call on an ambiguous reply.
      throw failure();
    }
  });
}
module.exports=Object.freeze({makeOfflineIdentityQuotaCaller});
