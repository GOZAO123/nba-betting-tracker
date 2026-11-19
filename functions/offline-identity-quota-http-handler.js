"use strict";

// D15.8 UNWIRED Node HTTP broker boundary. Not registered by Firebase,
// Cloud Run, a server listener, or the frontend. Reads bytes from an incoming
// stream with a strict bound BEFORE JSON parsing; only a canonical fixed
// protocol body is accepted. IAM must separately reject unauthorized callers.
const {makeOfflineAuthenticatedQuotaIngress}=
  require("./offline-identity-quota-ingress");
const {OPERATION,PROTOCOL_VERSION}=
  require("./offline-identity-quota-broker");
const BODY=Buffer.from(JSON.stringify({operation:OPERATION,
  protocolVersion:PROTOCOL_VERSION}),"utf8");
const MAX_REQUEST_BYTES=256;
const TIMEOUT_MS=6000;
const INVALID=Object.freeze({status:"INVALID_REQUEST"});
const UNAVAILABLE=Object.freeze({status:"BUDGET_UNAVAILABLE"});
function trustedHeaders(request){
  const raw=request?.rawHeaders;
  if(!Array.isArray(raw)||raw.length%2!==0||raw.length>128)return null;
  const found=Object.create(null);
  const watched=new Set(["authorization","content-type","content-length",
    "transfer-encoding","x-serverless-authorization"]);
  for(let i=0;i<raw.length;i+=2){
    const name=raw[i],value=raw[i+1];
    if(typeof name!=="string"||typeof value!=="string"||
       name.length>100||value.length>8200)return null;
    const key=name.toLowerCase();
    if(!/^[a-z0-9-]+$/.test(key))return null;
    if(watched.has(key)&&Object.prototype.hasOwnProperty.call(found,key))
      return null;
    if(watched.has(key))found[key]=value;
  }
  if(!found.authorization||found["content-type"]!=="application/json"||
     found["x-serverless-authorization"]!==undefined||
     found["content-length"]!==undefined&&
       (!/^(?:0|[1-9][0-9]*)$/.test(found["content-length"])||
        Number(found["content-length"])>MAX_REQUEST_BYTES)||
     found["transfer-encoding"]!==undefined&&
       found["content-length"]!==undefined)return null;
  return found;
}
async function boundedRaw(request){
  if(!request||typeof request[Symbol.asyncIterator]!=="function")
    return null;
  let parts=[],size=0;
  for await(const fragment of request){
    if(!Buffer.isBuffer(fragment)&&!(fragment instanceof Uint8Array))
      return null;
    size+=fragment.byteLength;
    if(size>MAX_REQUEST_BYTES)return null;
    parts.push(Buffer.from(fragment));
  }
  return Buffer.concat(parts,size);
}
function withDeadline(signal,operation){
  if(signal.aborted)return Promise.reject(new Error("deadline"));
  return new Promise((resolve,reject)=>{
    let finished=false;
    const cleanup=()=>{finished=true;signal.removeEventListener("abort",onAbort);};
    const onAbort=()=>{if(finished)return;cleanup();reject(new Error("deadline"));};
    signal.addEventListener("abort",onAbort,{once:true});
    if(signal.aborted){onAbort();return;}
    Promise.resolve().then(operation).then(result=>{
      if(finished)return;cleanup();resolve(result);
    },error=>{if(finished)return;cleanup();reject(error);});
  });
}
function reply(response,status,result){
  const data=JSON.stringify(result);
  response.statusCode=status;
  response.setHeader("Content-Type","application/json");
  response.setHeader("Cache-Control","no-store");
  response.setHeader("Content-Length",Buffer.byteLength(data,"utf8"));
  response.setHeader("X-Content-Type-Options","nosniff");
  response.end(data);
}
function makeOfflinePrivateQuotaHttpHandler({audience,expectedCaller,
  verifyIdToken,reserve,makeSignal=()=>AbortSignal.timeout(TIMEOUT_MS)}={}){
  if(typeof makeSignal!=="function")
    throw new TypeError("Invalid private broker deadline adapter.");
  const ingress=makeOfflineAuthenticatedQuotaIngress({
    audience,expectedCaller,verifyIdToken,reserve
  });
  return Object.freeze(async function handle(request,response){
    let signal;
    try{
      if(request?.method!=="POST"||request.url!=="/"){
        reply(response,405,INVALID);return;
      }
      const headers=trustedHeaders(request);
      if(!headers){reply(response,403,{status:"DENIED"});return;}
      signal=makeSignal();
      if(!signal||typeof signal.aborted!=="boolean"||
         typeof signal.addEventListener!=="function"||
         typeof signal.removeEventListener!=="function")throw Error("deadline");
      const bytes=await withDeadline(signal,()=>boundedRaw(request));
      if(!bytes||!bytes.equals(BODY)||
         headers["content-length"]!==undefined&&
         Number(headers["content-length"])!==bytes.length){
        reply(response,400,INVALID);return;
      }
      const outcome=await withDeadline(signal,()=>ingress({
        method:"POST",query:{},body:{
          operation:OPERATION,protocolVersion:PROTOCOL_VERSION
        },
        headers:{
          authorization:headers.authorization,
          "content-type":headers["content-type"]
        }
      }));
      const status=outcome.status==="RESERVED"?200:
        outcome.status==="DENIED"?403:
        outcome.status==="INVALID_REQUEST"?400:503;
      reply(response,status,outcome);
    }catch(_){
      // Even if Firestore commits after a deadline, DO NOT send success.
      reply(response,503,UNAVAILABLE);
    }
  });
}
module.exports=Object.freeze({makeOfflinePrivateQuotaHttpHandler});
