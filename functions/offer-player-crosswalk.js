"use strict";

// Update 35.1D15.36 — OFFLINE, manually reviewed provider player-ID ↔ ESPN
// athlete-ID bridge. Do not infer an athlete ID from normalized names.
// Source references and a digest are consistency assertions, NOT signatures.
// This module has no network, Firebase, browser, provider or production hooks.
const MAX_ROWS=128, MAX_ROSTER=30;
const MINUTE=60000, MAX_AGE=48*60*MINUTE;
const MAX_VALID=72*60*MINUTE;
const RECORD_KEYS=["espn","provider","reviewMethod","reviewStatus",
  "reviewedAt","schemaVersion","validUntil"];
const PROVIDER_KEYS=["fixtureId","participantId","playerId","playerName",
  "quoteDigest","sourceReference","startTime"];
const ESPN_KEYS=["athleteId","displayName","eventId","reference","teamId"];
const QUERY_KEYS=["espnRoster","quote","reviewedTeamBridge"];
const SOURCE="ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const exact=(x,allowed)=>obj(x)&&
  Object.keys(x).sort().join("|")===[...allowed].sort().join("|");
const id=x=>(typeof x==="string"||typeof x==="number")&&
  /^[1-9][0-9]{0,15}$/.test(String(x))?String(x):null;
const fixture=x=>typeof x==="string"&&
  /^[A-Za-z0-9._:-]{1,120}$/.test(x)?x:null;
const ref=x=>typeof x==="string"&&
  /^[A-Za-z0-9._:/-]{6,160}$/.test(x)?x:null;
const time=x=>typeof x==="string"&&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x)&&
  Number.isFinite(Date.parse(x))?Date.parse(x):NaN;
const safeName=x=>typeof x==="string"&&x.trim().length>0&&
  x.length<=100&&!/[\u0000-\u001f\u007f]/.test(x)?
  x.trim().normalize("NFC").replace(/\s+/gu," "):null;

function checkedRow(row) {
  if(!exact(row,RECORD_KEYS)||row.schemaVersion!==1||
     row.reviewMethod!=="MANUAL_TWO_SOURCE_PLAYER_ID_REVIEW"||
     !["APPROVED","REVOKED"].includes(row.reviewStatus)||
     !exact(row.provider,PROVIDER_KEYS)||!exact(row.espn,ESPN_KEYS))
    return null;
  const p=row.provider,e=row.espn;
  const fixtureId=fixture(p.fixtureId),participantId=id(p.participantId),
    playerId=id(p.playerId),athleteId=id(e.athleteId),
    teamId=id(e.teamId),eventId=id(e.eventId);
  const providerName=safeName(p.playerName),espnName=safeName(e.displayName);
  const providerRef=ref(p.sourceReference),espnRef=ref(e.reference);
  const start=time(p.startTime),reviewed=time(row.reviewedAt),
    until=time(row.validUntil);
  if(!fixtureId||!participantId||!playerId||!athleteId||!teamId||!eventId||
     !providerName||!espnName||
     !/^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(providerRef||"")||
     !/^ESPN_[A-Za-z0-9_:/-]{4,150}$/.test(espnRef||"")||
     !/^[a-f0-9]{64}$/.test(p.quoteDigest)||
     ![start,reviewed,until].every(Number.isFinite)||
     reviewed>=start-5*MINUTE||until<=reviewed||
     until>start-5*MINUTE||until-reviewed>MAX_VALID)
    return null;
  return Object.freeze({
    fixtureId,start,reviewed,until,providerRef,digest:p.quoteDigest,
    participantId,playerId,providerName,
    eventId,teamId,athleteId,espnName,
    status:row.reviewStatus
  });
}
function checkedTeamBridge(raw,quote) {
  if(!exact(raw,["espnEventId","teamBridge"])||
     !id(raw.espnEventId)||!Array.isArray(raw.teamBridge)||
     raw.teamBridge.length!==2||!Array.isArray(quote.providerParticipantIds)||
     quote.providerParticipantIds.length!==2)return null;
  const byProvider=new Map(),espnTeams=new Set();
  for(const pair of raw.teamBridge) {
    if(!exact(pair,["espnTeamId","providerParticipantId"]))return null;
    const p=id(pair.providerParticipantId),e=id(pair.espnTeamId);
    if(!p||!e||byProvider.has(p)||espnTeams.has(e))return null;
    byProvider.set(p,e);espnTeams.add(e);
  }
  const participants=quote.providerParticipantIds.map(id);
  if(!participants[0]||!participants[1]||participants[0]===participants[1]||
     !participants.every(p=>byProvider.has(p)))return null;
  return {eventId:id(raw.espnEventId),byProvider};
}
function checkedRoster(raw) {
  if(!exact(raw,["athletes","teamId"])||!id(raw.teamId)||
     !Array.isArray(raw.athletes)||raw.athletes.length<1||
     raw.athletes.length>MAX_ROSTER)return null;
  const seenIds=new Set(),seenNames=new Set(),athletes=new Map();
  for(const person of raw.athletes) {
    if(!exact(person,["displayName","id"]))return null;
    const athleteId=id(person.id),displayName=safeName(person.displayName);
    if(!athleteId||!displayName||seenIds.has(athleteId)||
       seenNames.has(displayName))return null;
    seenIds.add(athleteId);seenNames.add(displayName);
    athletes.set(athleteId,displayName);
  }
  return {teamId:id(raw.teamId),athletes};
}
function checkedQuote(quote) {
  if(!obj(quote)||quote.schemaVersion!==1||
     quote.status!=="UNREVIEWED_PROVIDER_QUOTE"||
     quote.source!==SOURCE||quote.attributedBookmaker!=="betano.pt"||
     quote.bookmakerVerified!==false||quote.espnPlayerVerified!==false||
     quote.autoLineSelected!==false||quote.captureAllowed!==false||
     !fixture(quote.fixtureId)||!id(quote.providerPlayerId)||
     !safeName(quote.providerPlayerName)||
     !/^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(quote.sourceReference)||
     !/^[a-f0-9]{64}$/.test(quote.digest)||
     !Number.isFinite(time(quote.startTime))||
     !Number.isFinite(time(quote.capturedAt)))return null;
  return quote;
}

// Both the stored record and query evidence MUST be constructed by trusted
// backend sources. This function does not authenticate them. It is a strict
// consistency gate until the actual provider/ESPN evidence is independently
// reviewed and the sealed backend sources are integrated.
function makeReviewedPlayerBridgeResolver(records,clock=Date.now) {
  const deny=()=>null;
  if(!Array.isArray(records)||records.length>MAX_ROWS||
     typeof clock!=="function")return deny;
  let rows;
  try{
    rows=new Map();
    const providerToEspn=new Map(),espnToProvider=new Map();
    for(const raw of records) {
      const r=checkedRow(raw);
      if(!r)return deny;
      const key=[r.fixtureId,r.providerRef,r.playerId].join("|");
      if(rows.has(key))return deny; // even APPROVED and REVOKED conflict
      if((providerToEspn.has(r.playerId)&&providerToEspn.get(r.playerId)!==r.athleteId)||
         (espnToProvider.has(r.athleteId)&&espnToProvider.get(r.athleteId)!==r.playerId))
        return deny;
      providerToEspn.set(r.playerId,r.athleteId);
      espnToProvider.set(r.athleteId,r.playerId);
      rows.set(key,r);
    }
  }catch(_){return deny;}

  return function resolveReviewedPlayer(query) {
    try{
      if(!exact(query,QUERY_KEYS))return null;
      const quote=checkedQuote(query.quote);
      if(!quote)return null;
      const bridge=checkedTeamBridge(query.reviewedTeamBridge,quote),
        roster=checkedRoster(query.espnRoster);
      if(!bridge||!roster)return null;
      const key=[quote.fixtureId,quote.sourceReference,
        id(quote.providerPlayerId)].join("|");
      const row=rows.get(key);
      if(!row||row.status!=="APPROVED"||
         row.digest!==quote.digest||
         row.providerName!==safeName(quote.providerPlayerName)||
         row.start!==time(quote.startTime)||
         row.eventId!==bridge.eventId||
         !quote.providerParticipantIds.map(id).includes(row.participantId)||
         bridge.byProvider.get(row.participantId)!==row.teamId||
         roster.teamId!==row.teamId||
         roster.athletes.get(row.athleteId)!==row.espnName)
        return null;
      const now=clock(),captured=time(quote.capturedAt);
      if(!Number.isSafeInteger(now)||now<row.reviewed||
         now>row.until||now-row.reviewed>MAX_AGE||
         now>=row.start-5*MINUTE||
         !Number.isFinite(captured)||captured>row.reviewed||
         row.reviewed-captured>MAX_AGE)return null;
      // Same fields as the reviewedAthleteBridge input to offer-matching.js.
      // "REVIEW_ASSERTION_ONLY" is not authenticated Betano/ESPN provenance.
      return Object.freeze({
        providerPlayerId:row.playerId,
        espnAthleteId:row.athleteId,espnTeamId:row.teamId,
        athleteMatch:"REVIEW_ASSERTION_ONLY",
        bookmakerVerified:false,autoLineSelected:false,captureAllowed:false
      });
    }catch(_){return null;}
  };
}

// No authentic provider↔ESPN player-ID evidence was saved by the Nov 20 UI
// preview. In particular, do not insert a Dyson Daniels pair based on name.
const SERVER_REVIEWED_PLAYER_MANIFEST=Object.freeze([]);
const getReviewedPlayerBridge=
  makeReviewedPlayerBridgeResolver(SERVER_REVIEWED_PLAYER_MANIFEST);

module.exports={
  makeReviewedPlayerBridgeResolver,getReviewedPlayerBridge
};
