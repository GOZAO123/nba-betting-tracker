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
// Single operation deadline starts BEFORE Google token discovery. Authentication
// APIs need not support AbortSignal: when the deadline fires we stop awaiting
// their results and MUST NOT begin HTTP even if a token resolves later.
function withinDeadline(signal,action){
  if(signal.aborted)return Promise.reject(failure());
  return new Promise((resolve,reject)=>{
    let settled=false;
    const cleanup=()=>{
      signal.removeEventListener("abort",onAbort);
      settled=true;
    };
    const onAbort=()=>{
      if(settled)return;
      cleanup();
      reject(failure());
    };
    signal.addEventListener("abort",onAbort,{once:true});
    if(signal.aborted){onAbort();return;}
    Promise.resolve().then(()=>{
      if(signal.aborted)throw failure();
      return action();
    }).then(value=>{
      if(settled)return;
      cleanup();
      resolve(value);
    },error=>{
      if(settled)return;
      cleanup();
      reject(error);
    });
  });
}
async function parseBoundedAck(response,audience,signal){
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
  // Abort the body stream as well as fetch. A timed-out broker reply can
  // NEVER authorize a paid provider request, even if the socket hangs.
  const abortBody=()=>{try{void reader.cancel().catch(()=>{});}catch(_){}};
  signal.addEventListener("abort",abortBody,{once:true});
  if(signal.aborted)abortBody();
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
    signal.removeEventListener("abort",abortBody);
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
      // Deadline is shared by credential discovery, token refresh, HTTP and
      // response streaming. It is NOT recreated after obtaining the token.
      const signal=makeSignal();
      if(!signal||typeof signal.aborted!=="boolean"||
         typeof signal.addEventListener!=="function"||
         typeof signal.removeEventListener!=="function")throw failure();
      const authClient=await withinDeadline(signal,
        ()=>getIdTokenClient(audience));
      if(!authClient||typeof authClient.getRequestHeaders!=="function")
        throw failure();
      // Deliberately don't use authClient.request/fetch: a library might
      // transparently retry on 401/403. Only one explicit fetch follows.
      const headers=await withinDeadline(signal,
        ()=>authClient.getRequestHeaders(audience));
      const token=bearerToken(headers);
      if(!token)throw failure();
      const response=await withinDeadline(signal,()=>fetchImpl(audience,{
        method:"POST",redirect:"error",cache:"no-store",signal,
        headers:Object.freeze({
          Authorization:"Bearer "+token,
          "Content-Type":"application/json",
          Accept:"application/json"
        }),
        body:REQUEST_BODY
      }));
      return await withinDeadline(signal,
        ()=>parseBoundedAck(response,audience,signal));
    }catch(_){
      // Timeout after Firestore commit may have spent a slot. Never retry,
      // refund, log secrets or allow a provider call on an ambiguous reply.
      throw failure();
    }
  });
}
module.exports=Object.freeze({makeOfflineIdentityQuotaCaller});
