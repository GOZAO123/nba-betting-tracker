"use strict";

// D15.37 — DISCONNECTED, read-only cross-check of the two existing private,
// create-only D8 fixture and D15.30 quote receipts. This is NOT provenance
// authentication: a SHA-256 digest only checks consistency of stored claims.
// All dependencies and the reviewer token must come from trusted backend code.
const { createHash } = require("node:crypto");
const { captureProviderFixture } = require("./offer-team-evidence");

const SOURCE="ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const TEAM_PATH="_internal/teamEvidence/providerSnapshots/";
const QUOTE_PATH="_internal/quoteEvidence/providerObservations/";
const FAMILY=["PTS","REB","AST","3PT","PR","PA","RA","PRA"];
const MIN=60000,MAX_HORIZON=72*60*MIN;
const SELECTOR=["fixtureId","marketId","providerPlayerId","sourceReference"];
const BATCH_KEYS=["schemaVersion","source","status","reference","capturedAt",
  "receivedAt","totalFixtures","acceptedFixtures","rejectedFixtures",
  "digest","records"];
const ROW_KEYS=["schemaVersion","source","reference","capturedAt","fixtureId",
  "startTime","participantIds","digest"];
const STORED_QUOTE_KEYS=["schemaVersion","source","status","receivedAt","quote"];
const QUOTE_KEYS=["schemaVersion","status","source","attributedBookmaker",
  "sourceReference","capturedAt","fixtureId","startTime","providerParticipantIds",
  "providerPlayerId","providerPlayerName","marketId","family","line",
  "outcomes","freshness","mainLineEvidence","digest","bookmakerVerified",
  "espnPlayerVerified","autoLineSelected","captureAllowed"];
const SIDE_KEYS=["outcomeId","price","changedAt","mainLineFlag"];
const object=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const exact=(x,fields)=>object(x)&&
  Object.keys(x).sort().join("|")===[...fields].sort().join("|");
const id=x=>typeof x==="string"&&/^[1-9][0-9]{0,15}$/.test(x);
const fixture=x=>typeof x==="string"&&/^[A-Za-z0-9._:-]{1,120}$/.test(x);
const ref=x=>typeof x==="string"&&/^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(x);
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const date=x=>typeof x==="string"&&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x)&&
  Number.isFinite(Date.parse(x))?Date.parse(x):NaN;
const digest=x=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x);
const name=x=>typeof x==="string"&&x.trim()!==""&&x.length<=100&&
  !/[\u0000-\u001f\u007f]/.test(x);

function originalFixture(doc,reference,fixtureId,now) {
  if(!exact(doc,BATCH_KEYS)||doc.schemaVersion!==1||
     doc.source!==SOURCE||doc.status!=="UNREVIEWED_PROVIDER_EVIDENCE"||
     doc.reference!==reference||!digest(doc.digest)||
     !Number.isSafeInteger(doc.totalFixtures)||doc.totalFixtures<1||
     doc.totalFixtures>250||
     !Number.isSafeInteger(doc.acceptedFixtures)||doc.acceptedFixtures<1||
     doc.acceptedFixtures>64||
     !Number.isSafeInteger(doc.rejectedFixtures)||doc.rejectedFixtures<0||
     doc.acceptedFixtures+doc.rejectedFixtures!==doc.totalFixtures||
     !Array.isArray(doc.records)||doc.records.length!==doc.acceptedFixtures)
    return null;
  const captured=date(doc.capturedAt),received=date(doc.receivedAt);
  if(!Number.isFinite(captured)||!Number.isFinite(received)||
     captured>received||received-captured>5*MIN||received>now)return null;
  let found=null;
  const seen=new Set(),tuples=[];
  for(const r of doc.records) {
    if(!exact(r,ROW_KEYS)||r.schemaVersion!==1||r.source!==SOURCE||
       r.reference!==reference||r.capturedAt!==doc.capturedAt||
       !fixture(r.fixtureId)||seen.has(r.fixtureId)||
       !Array.isArray(r.participantIds)||r.participantIds.length!==2||
       !r.participantIds.every(id)||r.participantIds[0]===r.participantIds[1]||
       !digest(r.digest))return null;
    const start=date(r.startTime);
    if(!Number.isFinite(start)||start<=received+5*MIN||
       start>received+MAX_HORIZON)return null;
    // Reuse the existing D4 production-independent canonical fixture digest.
    const canonical=captureProviderFixture({
      fixtureId:r.fixtureId,startTime:r.startTime,sportId:11,
      tournamentId:132,statusId:0,hasOdds:true,
      participant1Id:r.participantIds[0],participant2Id:r.participantIds[1]
    },{reference,capturedAt:doc.capturedAt});
    if(!canonical||canonical.digest!==r.digest)return null;
    tuples.push([r.fixtureId,r.startTime,...r.participantIds,r.digest]);
    seen.add(r.fixtureId);
    if(r.fixtureId===fixtureId)found=r;
  }
  if(sha([reference,doc.capturedAt,doc.totalFixtures,doc.acceptedFixtures,
    doc.rejectedFixtures,tuples])!==doc.digest)return null;
  return found;
}

function originalQuote(doc,path,now) {
  if(!exact(doc,STORED_QUOTE_KEYS)||doc.schemaVersion!==1||
     doc.source!==SOURCE||doc.status!=="UNREVIEWED_QUOTE_EVIDENCE"||
     !exact(doc.quote,QUOTE_KEYS))return null;
  const q=doc.quote;
  if(q.schemaVersion!==1||q.status!=="UNREVIEWED_PROVIDER_QUOTE"||
     q.source!==SOURCE||q.attributedBookmaker!=="betano.pt"||
     !ref(q.sourceReference)||!fixture(q.fixtureId)||
     !id(q.marketId)||!id(q.providerPlayerId)||!name(q.providerPlayerName)||
     !Array.isArray(q.providerParticipantIds)||
     q.providerParticipantIds.length!==2||
     !q.providerParticipantIds.every(id)||
     q.providerParticipantIds[0]===q.providerParticipantIds[1]||
     !FAMILY.includes(q.family)||typeof q.line!=="number"||
     !Number.isFinite(q.line)||q.line<=0||q.line>1000||
     !Number.isInteger(q.line*2)||Number.isInteger(q.line)||
     !exact(q.outcomes,["Over","Under"])||
     !digest(q.digest)||q.bookmakerVerified!==false||
     q.espnPlayerVerified!==false||q.autoLineSelected!==false||
     q.captureAllowed!==false)return null;
  const captured=date(q.capturedAt),received=date(doc.receivedAt),
    start=date(q.startTime);
  if(![captured,received,start].every(Number.isFinite)||
     captured>received||received-captured>5*MIN||received>now||
     start<=received+5*MIN||start>received+MAX_HORIZON)return null;
  const sides={},flags=[];
  let fresh=true;
  for(const side of ["Over","Under"]) {
    const s=q.outcomes[side];
    if(!exact(s,SIDE_KEYS)||!id(s.outcomeId)||
       typeof s.price!=="number"||!Number.isFinite(s.price)||
       s.price<=1||s.price>1000||
       ![true,false,null].includes(s.mainLineFlag))return null;
    const changed=date(s.changedAt);
    if(!Number.isFinite(changed)||changed>captured+2*MIN)return null;
    fresh=fresh&&captured-changed<=15*MIN;
    flags.push(s.mainLineFlag);
    sides[side]={outcomeId:s.outcomeId,price:s.price,
      changedAt:s.changedAt,mainLineFlag:s.mainLineFlag};
  }
  if(sides.Over.outcomeId===sides.Under.outcomeId)return null;
  const main=flags.every(f=>f===true)?"BOTH_EXPLICIT_FLAGS_UNVERIFIED":
    flags.some(f=>f===true)?"CONFLICTING_FLAGS":"NO_EXPLICIT_FLAGS";
  if(q.mainLineEvidence!==main||
     q.freshness!==(fresh?"FRESH_WITHIN_15_MIN":"STALE_PROVIDER_TIMESTAMP"))
    return null;
  const canonical=[SOURCE,q.sourceReference,q.capturedAt,q.fixtureId,q.startTime,
    ...q.providerParticipantIds,q.providerPlayerId,q.providerPlayerName,
    q.marketId,q.family,q.line,sides.Over,sides.Under];
  if(sha(canonical)!==q.digest||path!==QUOTE_PATH+sha([
    q.sourceReference,q.fixtureId,q.providerPlayerId,q.marketId
  ]))return null;
  return q;
}

// Internal-only lookup. A future caller must provide private Admin reads and
// an unforgeable, backend-created reviewer capability, not request.data.
// Neither source strings nor hashes prove OddsPapi, ESPN or Betano authenticity.
// No prices, personal names, research writes, or source records are logged.
function makeOfflinePlayerReceiptLink({
  readPrivateEvidence,isTrustedInternalReview,now=Date.now
}={}) {
  if([readPrivateEvidence,isTrustedInternalReview,now]
    .some(fn=>typeof fn!=="function"))
    throw new TypeError("Missing private evidence review dependencies.");
  return Object.freeze(async function review(selection,token) {
    try {
      if(!exact(selection,SELECTOR)||!fixture(selection.fixtureId)||
         !id(selection.marketId)||!id(selection.providerPlayerId)||
         !ref(selection.sourceReference)||!object(token))return null;
      const tick=now();
      if(!Number.isSafeInteger(tick)||tick<0)return null;
      const metadata=Object.freeze({...selection});
      if(await isTrustedInternalReview(token,metadata)!==true)return null;
      const quotePath=QUOTE_PATH+sha([selection.sourceReference,
        selection.fixtureId,selection.providerPlayerId,selection.marketId]);
      const quoteDoc=await readPrivateEvidence(quotePath);
      const q=originalQuote(quoteDoc,quotePath,tick);
      if(!q||q.fixtureId!==selection.fixtureId||
         q.sourceReference!==selection.sourceReference||
         q.providerPlayerId!==selection.providerPlayerId||
         q.marketId!==selection.marketId)return null;
      const batch=await readPrivateEvidence(TEAM_PATH+selection.sourceReference);
      const fixtureRow=originalFixture(batch,selection.sourceReference,
        selection.fixtureId,tick);
      if(!fixtureRow||fixtureRow.capturedAt!==q.capturedAt||
         fixtureRow.startTime!==q.startTime||
         fixtureRow.participantIds[0]!==q.providerParticipantIds[0]||
         fixtureRow.participantIds[1]!==q.providerParticipantIds[1]||
         date(batch.receivedAt)>date(quoteDoc.receivedAt))return null;
      // Offline linkage is not a player identity approval or bookie evidence.
      return Object.freeze({
        status:"UNREVIEWED_RECEIPT_LINK_ONLY",source:SOURCE,
        sourceReference:q.sourceReference,capturedAt:q.capturedAt,
        fixtureId:q.fixtureId,startTime:q.startTime,
        providerParticipantIds:Object.freeze([...q.providerParticipantIds]),
        providerPlayerId:q.providerPlayerId,
        providerPlayerName:q.providerPlayerName,
        marketId:q.marketId,quoteDigest:q.digest,
        fixtureDigest:fixtureRow.digest,
        bookmakerVerified:false,espnPlayerVerified:false,
        autoLineSelected:false,captureAllowed:false
      });
    }catch(_){return null;}
  });
}

module.exports={makeOfflinePlayerReceiptLink};
