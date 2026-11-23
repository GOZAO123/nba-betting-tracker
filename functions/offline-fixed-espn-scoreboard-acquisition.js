"use strict";

// Issue #97 D20 — DISCONNECTED ESPN NBA scoreboard acquisition + custody.
// No default HTTP client, callable export, schedule, browser input, Firebase
// import or automatic polling. The future backend must supply fetchImpl and
// a server-verified fixture start. ESPN provenance is conditional on that
// trusted backend boundary; tests use only a synthetic fetch implementation.
const {randomBytes,createHash}=require("node:crypto");
const {makeOfflineEspnScoreboardCustody,
  sanitizeOfflineEspnScoreboard}=require("./offline-espn-scoreboard-custody");

const PREFIX="https://site.api.espn.com/apis/site/v2/sports/basketball/nba/";
const BYTES=4*1024*1024, CHUNKS=8192, TIMEOUT=12000;
const HOUR=3600000, MINUTE=60000;
const JSON_TYPE=/^application\/(?:json|[a-z0-9._-]+\+json)(?:\s*;\s*charset=utf-8)?$/i;
const UTC_DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/;
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const safeError=()=>Object.freeze({status:"ESPN_CAPTURE_UNAVAILABLE"});
const object=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);

function canonicalDate(source){
  if(typeof source!=="string"||!UTC_DATE.test(source))return null;
  const ms=Date.parse(source);
  return Number.isFinite(ms)?new Date(ms).toISOString():null;
}
function normalizeScoreboard(raw){
  if(!object(raw)||!Array.isArray(raw.events)||raw.events.length>40)
    return null;
  const shaped={
    events:raw.events.map(e=>object(e)?
      {...e,date:canonicalDate(e.date)}:e)
  };
  return sanitizeOfflineEspnScoreboard(shaped);
}
async function readJson(response,expected){
  if(!response||response.ok!==true||response.redirected!==false||
     response.url!==expected||!response.headers||
     typeof response.headers.get!=="function"||
     !JSON_TYPE.test(response.headers.get("content-type")||"")||
     typeof response.body?.getReader!=="function")
    throw Error("Response rejected");
  const declared=response.headers.get("content-length");
  if(declared!==null&&(!/^\d+$/.test(declared)||
     !Number.isSafeInteger(Number(declared))||
     Number(declared)>BYTES))throw Error("Response length rejected");
  const reader=response.body.getReader();
  const parts=[];let size=0,chunks=0;
  try {
    while(true){
      const next=await reader.read();
      if(next.done)break;
      if(!(next.value instanceof Uint8Array)||
         ++chunks>CHUNKS||size+next.value.byteLength>BYTES)
        throw Error("Response byte cap");
      parts.push(Buffer.from(next.value));
      size+=next.value.byteLength;
    }
  }catch(_){
    try{await reader.cancel();}catch(_){}
    throw Error("Response stream rejected");
  }
  if(!size)throw Error("Empty ESPN response");
  return JSON.parse(Buffer.concat(parts,size).toString("utf8"));
}

function makeOfflineFixedEspnScoreboardAcquisition({
  db,fetchImpl,now=Date.now,
  makeSignal=()=>AbortSignal.timeout(TIMEOUT)
}={}){
  if(typeof db?.doc!=="function"||
     typeof db?.runTransaction!=="function"||
     typeof fetchImpl!=="function"||
     typeof now!=="function"||
     typeof makeSignal!=="function")
    throw new TypeError("Trusted ESPN acquisition dependencies required.");

  async function captureForFixtureStart(startMs){
    const begun=now();
    if(!Number.isSafeInteger(begun)||begun<0||
       !Number.isSafeInteger(startMs)||
       startMs<=begun+5*MINUTE||
       startMs>begun+72*HOUR)
      return Object.freeze({status:"INVALID_FIXTURE_START"});
    try {
      // The endpoint and NBA calendar day are constructed ONLY here.
      // No client-selected URL, host, ESPN event, ID or query parameter.
      const parts=new Intl.DateTimeFormat("en-US",{
        timeZone:"America/New_York",
        year:"numeric",month:"2-digit",day:"2-digit"
      }).formatToParts(new Date(startMs));
      const lookup=k=>parts.find(x=>x.type===k)?.value;
      const day=lookup("year")+lookup("month")+lookup("day");
      if(!/^\d{8}$/.test(day))return safeError();
      const endpoint=PREFIX+"scoreboard?dates="+day;
      const signal=makeSignal();
      if(!signal||typeof signal.aborted!=="boolean"||signal.aborted)
        return safeError();
      const response=await fetchImpl(endpoint,{
        method:"GET",headers:{Accept:"application/json"},
        redirect:"error",cache:"no-store",signal
      });
      const raw=await readJson(response,endpoint);
      const scoreboard=normalizeScoreboard(raw);
      const finished=now();
      if(!scoreboard||!Number.isSafeInteger(finished)||
         finished<begun||finished-begun>TIMEOUT)
        return safeError();
      // The intended fixture is still unreviewed: require exactly ONE
      // pregame regular-season ESPN event near its independently supplied
      // tipoff, without inferring provider-to-ESPN team identity.
      const matches=scoreboard.events.filter(e=>
        e.status.type.state==="pre" && e.season.type===2 &&
        Math.abs(Date.parse(e.date)-startMs)<=5*MINUTE);
      if(matches.length!==1)return safeError();

      const reference="ESPN_CAPTURE_"+randomBytes(16).toString("hex").toUpperCase();
      const capturedAt=new Date(finished).toISOString();
      const digest=hash(["ESPN_NBA_SCOREBOARD",reference,capturedAt,scoreboard]);
      // One-use, opaque capability created AFTER a valid fixed-host fetch.
      // The caller never receives this token or its hash. The token only
      // authorizes the already acquired and normalized observation.
      const token=Object.freeze({});
      let consumed=false;
      const custody=makeOfflineEspnScoreboardCustody({
        db,now:()=>finished,
        attestCapture:async (attempt,pin)=>{
          if(consumed||attempt!==token||
             pin.source!=="ESPN_NBA_SCOREBOARD"||
             pin.reference!==reference||
             pin.capturedAt!==capturedAt||pin.digest!==digest)
            return false;
          consumed=true;
          return true;
        }
      });
      const stored=await custody.storeCapture(scoreboard,{
        reference,capturedAt
      },token);
      // Only status-only results cross the trusted backend boundary.
      return Object.freeze({status:stored.status});
    }catch(_){return safeError();}
  }
  return Object.freeze({captureForFixtureStart});
}
module.exports={makeOfflineFixedEspnScoreboardAcquisition};
