"use strict";

// Issue #97 D19: disconnected, create-only ESPN NBA scoreboard custody.
// The caller MUST independently authenticate a server-side, fixed-host ESPN
// fetch and supply an opaque capture token. Neither this helper nor a hash
// establishes actual ESPN provenance. No network, Firebase imports, callable,
// scheduler, or browser-accessible entry point.
const {createHash}=require("node:crypto");
const ROOT="_internal/teamReview/espnSnapshots/";
const REF=/^ESPN_[A-Z0-9_-]{6,88}$/;
const ID=/^[1-9][0-9]{0,15}$/;
const UTC=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAX_EVENTS=40;
const MAX_RAW_BYTES=4*1024*1024;
const MAX_AGE=5*60000;
const object=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const exact=(x,fields)=>object(x)&&
  Object.keys(x).sort().join("|")===[...fields].sort().join("|");
const iso=x=>typeof x==="string" && UTC.test(x) &&
  Number.isFinite(Date.parse(x)) &&
  new Date(Date.parse(x)).toISOString()===x;
const safeId=x=> (typeof x==="string"||typeof x==="number") &&
  ID.test(String(x)) ? String(x) : null;
const safeName=x=>typeof x==="string" &&
  x.length>=2&&x.length<=100&&x===x.trim()&&
  x.normalize("NFC")===x&&
  !/[\p{C}<>]/u.test(x)&&
  Buffer.byteLength(x,"utf8")<=160 ? x : null;
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");

function sanitizeOfflineEspnScoreboard(raw) {
  try {
    if(!object(raw)||!Array.isArray(raw.events)||
       raw.events.length<1||raw.events.length>MAX_EVENTS ||
       Buffer.byteLength(JSON.stringify(raw),"utf8")>MAX_RAW_BYTES)
      return null;
    const seen=new Set(),out=[];
    for(const e of raw.events) {
      const eventId=safeId(e?.id);
      const date=e?.date;
      const state=e?.status?.type?.state;
      const season=e?.season?.type;
      if(!eventId||seen.has(eventId)||!iso(date)||
         !["pre","in","post"].includes(state)||
         !Number.isInteger(season)||season<1||season>4||
         !Array.isArray(e?.competitions)||
         e.competitions.length!==1) return null;
      seen.add(eventId);
      const members=e.competitions[0]?.competitors;
      if(!Array.isArray(members)||members.length!==2)return null;
      const normalized=[];
      for(const c of members) {
        if(!["home","away"].includes(c?.homeAway))return null;
        const id=safeId(c?.team?.id);
        const displayName=safeName(c?.team?.displayName);
        if(!id||!displayName)return null;
        normalized.push(Object.freeze({
          homeAway:c.homeAway,
          team:Object.freeze({id,displayName})
        }));
      }
      if(normalized[0].homeAway===normalized[1].homeAway||
         normalized[0].team.id===normalized[1].team.id||
         normalized[0].team.displayName.toLocaleLowerCase("en")===
         normalized[1].team.displayName.toLocaleLowerCase("en"))
        return null;
      out.push(Object.freeze({
        id:eventId,date,
        season:Object.freeze({type:season}),
        status:Object.freeze({type:Object.freeze({state})}),
        competitions:Object.freeze([Object.freeze({
          competitors:Object.freeze(normalized)
        })])
      }));
    }
    return Object.freeze({events:Object.freeze(out)});
  } catch(_){return null;}
}
function makeOfflineEspnScoreboardCustody({
  db,attestCapture,now=Date.now
}={}) {
  if(typeof db?.doc!=="function"||
     typeof db?.runTransaction!=="function"||
     typeof attestCapture!=="function"||
     typeof now!=="function")
    throw new TypeError("Trusted ESPN scoreboard custody dependencies required.");

  async function storeCapture(raw,metadata,token) {
    const tick=now();
    if(!Number.isSafeInteger(tick)||tick<0||
       !exact(metadata,["reference","capturedAt"])||
       typeof metadata.reference!=="string"||
       !REF.test(metadata.reference)||
       !iso(metadata.capturedAt)) return Object.freeze({status:"INVALID_CAPTURE"});
    const taken=Date.parse(metadata.capturedAt);
    if(taken>tick||tick-taken>MAX_AGE)
      return Object.freeze({status:"INVALID_CAPTURE"});
    const scoreboard=sanitizeOfflineEspnScoreboard(raw);
    if(!scoreboard)return Object.freeze({status:"INVALID_CAPTURE"});
    const digest=hash([
      "ESPN_NBA_SCOREBOARD",metadata.reference,metadata.capturedAt,scoreboard
    ]);
    let trusted=false;
    try {
      trusted=await attestCapture(token,Object.freeze({
        source:"ESPN_NBA_SCOREBOARD",
        reference:metadata.reference,
        capturedAt:metadata.capturedAt,
        digest
      }))===true;
    }catch(_){}
    if(!trusted)return Object.freeze({status:"DENIED"});
    try {
      const location=ROOT+metadata.reference;
      const ref=db.doc(location);
      if(ref?.path!==location)return Object.freeze({status:"STORE_UNAVAILABLE"});
      return Object.freeze(await db.runTransaction(async tx=>{
        if(typeof tx?.get!=="function"||typeof tx?.create!=="function")
          throw Error("Invalid transaction");
        const existing=await tx.get(ref);
        if(!existing||typeof existing.exists!=="boolean")
          throw Error("Missing snapshot");
        if(existing.exists)return {status:"REPLAY_BLOCKED"};
        tx.create(ref,{
          schemaVersion:1,
          source:"ESPN_NBA_SCOREBOARD",
          reference:metadata.reference,
          capturedAt:metadata.capturedAt,
          scoreboard
        });
        return {status:"STORED"};
      },{maxAttempts:5}));
    }catch(_){return Object.freeze({status:"STORE_UNAVAILABLE"});}
  }
  return Object.freeze({storeCapture});
}
module.exports={sanitizeOfflineEspnScoreboard,
  makeOfflineEspnScoreboardCustody};
