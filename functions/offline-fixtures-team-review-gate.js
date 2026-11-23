"use strict";

// Issue #97 / D18: DISCONNECTED, source-aware manual review for the NEW
// /v4/fixtures + independent ESPN packet. Never import from functions/index.js.
// No network, credential, Firebase SDK, Firestore access, approval endpoint,
// scheduled work or browser permission is included in this library.
const {createHash}=require("node:crypto");
const {makeOfflineFixtureEspnReviewPacket}=
  require("./offline-fixture-espn-review-packet");
const {makeReviewedTeamBridgeResolver}=require("./offer-team-crosswalk");

const MINUTE=60_000, HOUR=60*MINUTE;
const REVIEW_METHOD="MANUAL_TWO_SOURCE_FIXTURES_ID_REVIEW";
const FID=/^[A-Za-z0-9._:-]{1,120}$/;
const ID=/^[1-9][0-9]{0,15}$/;
const REFERENCE=/^[A-Z][A-Z0-9_-]{5,95}$/;
const HEX=/^[a-f0-9]{64}$/;
const obj=x=>x!==null && typeof x==="object" && !Array.isArray(x);
const exact=(x,keys)=>obj(x) &&
  Object.keys(x).sort().join("|") === [...keys].sort().join("|");
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const parse=x=>typeof x==="string" && Number.isFinite(Date.parse(x)) ?
  Date.parse(x) : NaN;

const HISTORY_KEYS=["schemaVersion","fixtureId","revision","action",
  "reviewedAt","packetDigest","reviewMethod","reviewerReference",
  "pairs","eventDigest"];
const PAIR_KEYS=["providerParticipantId","espnTeamId"];

function checkedPairs(pairs,packet) {
  if(!Array.isArray(pairs)||pairs.length!==2)return null;
  const expectedProviders=new Set(packet.provider.participants.map(p=>p.participantId));
  const expectedEspn=new Set([packet.espn.home.teamId,packet.espn.away.teamId]);
  const seenP=new Set(),seenE=new Set(),rows=[];
  for(const row of pairs) {
    if(!exact(row,PAIR_KEYS) ||
        typeof row.providerParticipantId!=="string" ||
        typeof row.espnTeamId!=="string" ||
        !ID.test(row.providerParticipantId) || !ID.test(row.espnTeamId) ||
        !expectedProviders.has(row.providerParticipantId) ||
        !expectedEspn.has(row.espnTeamId) ||
        seenP.has(row.providerParticipantId) || seenE.has(row.espnTeamId))
      return null;
    seenP.add(row.providerParticipantId);
    seenE.add(row.espnTeamId);
    rows.push(Object.freeze({...row}));
  }
  return seenP.size===2 && seenE.size===2 ? Object.freeze(rows) : null;
}
function checkedHistory(history,packet,now) {
  if(!Array.isArray(history) || history.length>32 ||
      !Number.isSafeInteger(now)) return null;
  const start=parse(packet.provider.startTime);
  const captured=Math.max(parse(packet.provider.capturedAt),
    parse(packet.espn.capturedAt));
  if(!Number.isFinite(start) || !Number.isFinite(captured))return null;
  let last=0,status="PENDING_REVIEW",revision=0,approved=null,pairs=null;
  for(const row of history) {
    if(!exact(row,HISTORY_KEYS)||row.schemaVersion!==1 ||
       row.fixtureId!==packet.provider.fixtureId ||
       row.revision!==revision+1 ||
       row.packetDigest!==packet.packetDigest ||
       row.reviewMethod!==REVIEW_METHOD ||
       !REFERENCE.test(row.reviewerReference) ||
       !HEX.test(row.eventDigest))return null;
    const {eventDigest,...base}=row;
    if(eventDigest!==sha(base))return null;
    const stamp=parse(row.reviewedAt);
    if(!Number.isFinite(stamp)||stamp<captured ||
        stamp<last || (revision>0 && stamp<=last) ||
        stamp>now || stamp>=start-5*MINUTE)return null;

    if(status==="PENDING_REVIEW" && row.action==="APPROVE") {
      pairs=checkedPairs(row.pairs,packet);
      if(!pairs)return null;
      status="APPROVED";
      approved=row;
    } else if(status==="PENDING_REVIEW" && row.action==="REJECT" &&
              row.pairs===null) status="REJECTED";
    else if(status==="APPROVED" && row.action==="REVOKE" &&
            row.pairs===null)status="REVOKED";
    else return null;
    last=stamp;revision++;
  }
  return {status,revision,pairs,approved};
}
function buildManifest(packet,state,now) {
  if(!state || state.status!=="APPROVED" || !state.approved ||
      !state.pairs || !Number.isSafeInteger(now))return null;
  const reviewed=parse(state.approved.reviewedAt);
  const expires=Math.min(parse(packet.provider.startTime)-5*MINUTE,
    reviewed+48*HOUR);
  if(!Number.isFinite(expires) || now<reviewed || now>=expires)return null;
  const manifest={
    schemaVersion:1,providerFixtureId:packet.provider.fixtureId,
    providerStartTime:packet.provider.startTime,
    espnEventId:packet.espn.eventId,
    reviewMethod:"MANUAL_TWO_SOURCE_ID_REVIEW",
    reviewStatus:"APPROVED",
    reviewedAt:state.approved.reviewedAt,
    validUntil:new Date(expires).toISOString(),
    evidence:{
      providerReference:packet.provider.reference,
      espnReference:packet.espn.reference
    },
    teams:state.pairs.map(p=>({...p}))
  };
  return Object.freeze(manifest);
}

// loadEvidence MUST use authenticated backend-owned provider/ESPN sources,
// not client-supplied JSON; appendDecision MUST be an atomic revision+digest
// compare-and-set in a protected append-only journal. This factory cannot
// attest to server identity or the atomicity of injected adapters.
function makeOfflineFixturesTeamReviewGate({
  authorize,loadEvidence,loadHistory,appendDecision,now=Date.now
}={}) {
  if([authorize,loadEvidence,loadHistory,appendDecision,now]
    .some(fn=>typeof fn!=="function"))
    throw new TypeError("Missing trusted review dependencies.");

  async function load(fixtureId,tick) {
    const evidence=await loadEvidence(fixtureId);
    if(!exact(evidence,["providerReceipt","espnScoreboard","espnMetadata"]))
      return null;
    return makeOfflineFixtureEspnReviewPacket({
      fixtureId,...evidence,now:tick
    });
  }
  async function submit(auth,request) {
    let owner;
    try{owner=await authorize(auth);}catch(_){return {status:"DENIED"};}
    if(!exact(owner,["allowed","reviewerReference"])||
        owner.allowed!==true ||
        typeof owner.reviewerReference!=="string" ||
        !REFERENCE.test(owner.reviewerReference))
      return {status:"DENIED"};

    const action=request?.action;
    if(!obj(request)||!FID.test(request.fixtureId)||
        !["APPROVE","REJECT","REVOKE"].includes(action) ||
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision<0||request.expectedRevision>31 ||
        !exact(request,action==="APPROVE" ?
          ["fixtureId","action","expectedRevision","pairs"] :
          ["fixtureId","action","expectedRevision"]))
      return {status:"INVALID_REQUEST"};
    const tick=now();
    if(!Number.isSafeInteger(tick)||tick<0)return {status:"UNAVAILABLE"};

    let packet,history;
    try{
      packet=await load(request.fixtureId,tick);
      if(!packet)return {status:"EVIDENCE_UNAVAILABLE"};
      history=await loadHistory(request.fixtureId);
    }catch(_){return {status:"UNAVAILABLE"};}
    const state=checkedHistory(history,packet,tick);
    if(!state)return {status:"REVIEW_HISTORY_INVALID"};
    if(state.revision!==request.expectedRevision)
      return {status:"REVISION_CONFLICT"};
    if((action!=="REVOKE" && state.status!=="PENDING_REVIEW")||
        (action==="REVOKE" && state.status!=="APPROVED"))
      return {status:"INVALID_TRANSITION"};

    const pairs=action==="APPROVE" ? checkedPairs(request.pairs,packet) : null;
    if(action==="APPROVE" && !pairs)return {status:"INVALID_PAIRS"};
    const base={
      schemaVersion:1,fixtureId:packet.provider.fixtureId,
      revision:state.revision+1,action,
      reviewedAt:new Date(tick).toISOString(),
      packetDigest:packet.packetDigest,
      reviewMethod:REVIEW_METHOD,
      reviewerReference:owner.reviewerReference,
      pairs:pairs ? pairs.map(x=>({...x})) : null
    };
    const event=Object.freeze({...base,eventDigest:sha(base)});
    try{
      const committed=await appendDecision({
        fixtureId:base.fixtureId,
        expectedRevision:state.revision,
        packetDigest:packet.packetDigest,
        event
      });
      if(committed!==true)return {status:"REVISION_CONFLICT"};
    }catch(_){return {status:"UNAVAILABLE"};}
    return {status:action==="APPROVE"?"APPROVED":
      action==="REJECT"?"REJECTED":"REVOKED",revision:base.revision};
  }

  async function resolve(query) {
    if(!exact(query,["fixtureId","participant1Id","participant2Id","startTime"])||
       !FID.test(query.fixtureId)||
       !ID.test(query.participant1Id)||!ID.test(query.participant2Id)||
       query.participant1Id===query.participant2Id)return null;
    const tick=now();
    if(!Number.isSafeInteger(tick)||tick<0)return null;
    try {
      const packet=await load(query.fixtureId,tick);
      if(!packet || packet.provider.startTime!==query.startTime)return null;
      const state=checkedHistory(await loadHistory(query.fixtureId),packet,tick);
      const manifest=buildManifest(packet,state,tick);
      // Same D3 resolver as existing D4, not a new authorizing crosswalk.
      // Global cross-fixture ID conflict checking remains a release gate.
      return manifest ?
        makeReviewedTeamBridgeResolver([manifest],()=>tick)(query) : null;
    }catch(_){return null;}
  }
  return Object.freeze({submit,resolve});
}


// Pure verification for a complete, privately loaded review snapshot.
// Does NOT attest to source provenance or authenticate the review journal.
// It deliberately reuses the identical D18 history/manifest validation
// used by the manual review gate; no second approval policy is invented.
function inspectOfflineSourceBoundTeamReview(input) {
  try {
    if(!exact(input,["fixtureId","providerReceipt","espnScoreboard",
      "espnMetadata","history","now"])) return null;
    const {fixtureId,providerReceipt,espnScoreboard,espnMetadata,history,now}=input;
    if(typeof fixtureId!=="string" || !FID.test(fixtureId) ||
       !Array.isArray(history) || !Number.isSafeInteger(now) || now<0)
      return null;
    const packet=makeOfflineFixtureEspnReviewPacket({
      fixtureId,providerReceipt,espnScoreboard,espnMetadata,now
    });
    if(!packet)return null;
    const state=checkedHistory(history,packet,now);
    if(!state)return null;
    const manifest=buildManifest(packet,state,now);
    // An approved record that cannot still resolve is NOT silently
    // treated as unreviewed, omitted, or exempt from the global gate.
    if(state.status==="APPROVED" && !manifest)return null;
    return Object.freeze({status:state.status,manifest});
  } catch (_) {return null;}
}

module.exports={makeOfflineFixturesTeamReviewGate,
  inspectOfflineSourceBoundTeamReview};
