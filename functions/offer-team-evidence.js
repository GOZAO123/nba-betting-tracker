"use strict";

// Update 35.1D4 — OFFLINE evidence and approval-state foundation.
// No HTTP/Firestore/client/callable integration. All adapters must be backend-owned.
const { createHash } = require("node:crypto");
const { makeReviewedTeamBridgeResolver } = require("./offer-team-crosswalk");
const MIN = 60000, HOUR = 60 * MIN, MAX_AGE = 48 * HOUR;
const fixtureId = x => typeof x === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(x) ? x : null;
const id = x => (typeof x === "string" || typeof x === "number") &&
  /^[1-9][0-9]{0,15}$/.test(String(x)) ? String(x) : null;
const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (o, ks) => obj(o) &&
  Object.keys(o).sort().join("|") === [...ks].sort().join("|");
const time = x => typeof x === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
// References are opaque server-generated IDs, never URLs or query strings.
const ref = x => typeof x === "string" &&
  /^[A-Z][A-Z0-9_-]{5,95}$/.test(x) ? x : null;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const SOURCE_P = "ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const SOURCE_E = "ESPN_NBA_SCOREBOARD";
const evidenceKeys = ["schemaVersion","source","reference","capturedAt","fixtureId",
  "startTime","participantIds","digest"];
const espnKeys = ["schemaVersion","source","reference","capturedAt","eventId",
  "startTime","homeTeamId","awayTeamId","digest"];
const candidateKeys = ["schemaVersion","fixtureId","startTime","eventId","participantIds",
  "espnTeamIds","providerCapturedAt","espnCapturedAt","evidence","candidateDigest"];
const historyKeys = ["schemaVersion","fixtureId","revision","action","reviewedAt",
  "candidateDigest","reviewMethod","reviewerReference","pairs"];

function fingerprintProvider(x) {
  return digest([x.source,x.reference,x.capturedAt,x.fixtureId,x.startTime,...x.participantIds]);
}
function fingerprintEspn(x) {
  return digest([x.source,x.reference,x.capturedAt,x.eventId,x.startTime,
    x.homeTeamId,x.awayTeamId]);
}
function captureProviderFixture(fixture, metadata) {
  if (!obj(fixture) || !exact(metadata,["reference","capturedAt"]) ||
      !ref(metadata.reference) || !Number.isFinite(time(metadata.capturedAt)) ||
      fixture.sportId != 11 || fixture.tournamentId != 132 ||
      fixture.statusId !== 0 || fixture.hasOdds !== true ||
      !fixtureId(fixture.fixtureId) || !Number.isFinite(time(fixture.startTime))) return null;
  const a=id(fixture.participant1Id),b=id(fixture.participant2Id);
  if (!a || !b || a===b) return null;
  const row={schemaVersion:1,source:SOURCE_P,reference:metadata.reference,
    capturedAt:metadata.capturedAt,fixtureId:fixture.fixtureId,
    startTime:fixture.startTime,participantIds:[a,b]};
  return Object.freeze({...row,participantIds:Object.freeze(row.participantIds),
    digest:fingerprintProvider(row)});
}
function captureEspnEvent(scoreboard, providerStart, metadata) {
  if (!exact(metadata,["reference","capturedAt"]) ||
      !ref(metadata.reference) || !Number.isFinite(time(metadata.capturedAt)) ||
      !Number.isFinite(time(providerStart)) ||
      !Array.isArray(scoreboard?.events) || scoreboard.events.length > 40) return null;
  const found=[];
  for (const event of scoreboard.events) {
    if (!id(event?.id) || !Number.isFinite(time(event?.date)) ||
        Math.abs(time(event.date)-time(providerStart))>5*MIN ||
        event.status?.type?.state!=="pre" || Number(event.season?.type)!==2 ||
        !Array.isArray(event.competitions) || event.competitions.length!==1) continue;
    const members=event.competitions[0]?.competitors;
    if (!Array.isArray(members) || members.length!==2) continue;
    const home=members.filter(c=>c?.homeAway==="home"),
      away=members.filter(c=>c?.homeAway==="away");
    if (home.length!==1 || away.length!==1 ||
        !id(home[0]?.team?.id) || !id(away[0]?.team?.id) ||
        id(home[0].team.id)===id(away[0].team.id)) continue;
    const row={schemaVersion:1,source:SOURCE_E,reference:metadata.reference,
      capturedAt:metadata.capturedAt,eventId:id(event.id),startTime:event.date,
      homeTeamId:id(home[0].team.id),awayTeamId:id(away[0].team.id)};
    found.push(Object.freeze({...row,digest:fingerprintEspn(row)}));
  }
  return found.length===1?found[0]:null;
}
function validEvidencePair(p,e,now) {
  if (!exact(p,evidenceKeys) || !exact(e,espnKeys) ||
      p.schemaVersion!==1 || e.schemaVersion!==1 ||
      p.source!==SOURCE_P || e.source!==SOURCE_E ||
      !ref(p.reference) || !ref(e.reference) || p.reference===e.reference ||
      !fixtureId(p.fixtureId) || !id(e.eventId) ||
      !Array.isArray(p.participantIds) || p.participantIds.length!==2 ||
      !id(p.participantIds[0]) || !id(p.participantIds[1]) ||
      String(p.participantIds[0])===String(p.participantIds[1]) ||
      !id(e.homeTeamId) || !id(e.awayTeamId) ||
      String(e.homeTeamId)===String(e.awayTeamId) ||
      !/^[a-f0-9]{64}$/.test(p.digest) || !/^[a-f0-9]{64}$/.test(e.digest) ||
      p.digest!==fingerprintProvider(p) || e.digest!==fingerprintEspn(e)) return false;
  const start=time(p.startTime),es=time(e.startTime),
    pc=time(p.capturedAt),ec=time(e.capturedAt);
  return [start,es,pc,ec,now].every(Number.isFinite) &&
    Number.isSafeInteger(now) && Math.abs(start-es)<=5*MIN &&
    Math.abs(pc-ec)<=30*MIN &&
    pc<=now && ec<=now && pc>=now-MAX_AGE && ec>=now-MAX_AGE &&
    start>now+5*MIN && start<=now+72*HOUR &&
    pc<start && ec<start;
}
function makePendingTeamCandidate(provider,espn,now) {
  if (!validEvidencePair(provider,espn,now)) return null;
  const row={schemaVersion:1,fixtureId:provider.fixtureId,
    startTime:provider.startTime,eventId:espn.eventId,
    participantIds:[...provider.participantIds],
    espnTeamIds:[espn.homeTeamId,espn.awayTeamId],
    providerCapturedAt:provider.capturedAt,espnCapturedAt:espn.capturedAt,
    evidence:{providerReference:provider.reference,espnReference:espn.reference,
      providerDigest:provider.digest,espnDigest:espn.digest}};
  const signature=digest(row);
  return Object.freeze({...row,participantIds:Object.freeze(row.participantIds),
    espnTeamIds:Object.freeze(row.espnTeamIds),evidence:Object.freeze(row.evidence),
    candidateDigest:signature});
}
function validCandidate(row,now) {
  if (!exact(row,candidateKeys) || row.schemaVersion!==1 ||
      !fixtureId(row.fixtureId) || !id(row.eventId) ||
      !Array.isArray(row.participantIds) || row.participantIds.length!==2 ||
      !Array.isArray(row.espnTeamIds) || row.espnTeamIds.length!==2 ||
      !row.participantIds.every(id) || !row.espnTeamIds.every(id) ||
      new Set(row.participantIds.map(String)).size!==2 ||
      new Set(row.espnTeamIds.map(String)).size!==2 ||
      !exact(row.evidence,["providerReference","espnReference","providerDigest","espnDigest"]) ||
      !ref(row.evidence.providerReference) || !ref(row.evidence.espnReference) ||
      !["providerDigest","espnDigest"].every(k=>/^[a-f0-9]{64}$/.test(row.evidence[k])) ||
      !Number.isFinite(time(row.startTime)) ||
      !Number.isFinite(time(row.providerCapturedAt)) ||
      !Number.isFinite(time(row.espnCapturedAt)) ||
      !Number.isSafeInteger(now) || time(row.startTime)<=now+5*MIN ||
      time(row.startTime)>now+72*HOUR ||
      [row.providerCapturedAt,row.espnCapturedAt].some(t =>
        time(t)>now || time(t)<now-MAX_AGE)) return false;
  const {candidateDigest,...rest}=row;
  return typeof candidateDigest==="string" && candidateDigest===digest(rest);
}
function checkedPairs(pairs,candidate) {
  if (!Array.isArray(pairs) || pairs.length!==2) return null;
  const a=new Set(candidate.participantIds.map(String)),
    b=new Set(candidate.espnTeamIds.map(String)),seenA=new Set(),seenB=new Set(),result=[];
  for (const pair of pairs) {
    if (!exact(pair,["providerParticipantId","espnTeamId"])) return null;
    const p=id(pair.providerParticipantId),e=id(pair.espnTeamId);
    if (!p || !e || !a.has(p) || !b.has(e) || seenA.has(p) || seenB.has(e)) return null;
    seenA.add(p);seenB.add(e);
    result.push({providerParticipantId:p,espnTeamId:e});
  }
  return seenA.size===2 && seenB.size===2 ? result : null;
}
function checkedHistory(rows,candidate,now) {
  if (!Array.isArray(rows) || rows.length>32) return null;
  let previousAt=0,revision=0,state="PENDING_REVIEW",pairs=null;
  for (const row of rows) {
    if (!exact(row,historyKeys) || row.schemaVersion!==1 ||
        row.fixtureId!==candidate.fixtureId || row.revision!==revision+1 ||
        row.candidateDigest!==candidate.candidateDigest ||
        row.reviewMethod!=="MANUAL_TWO_SOURCE_ID_REVIEW" ||
        !ref(row.reviewerReference) ||
        !Number.isFinite(time(row.reviewedAt)) ||
        (previousAt>0 && time(row.reviewedAt)<=previousAt) || time(row.reviewedAt)>now ||
        time(row.reviewedAt)<Math.max(time(candidate.providerCapturedAt),
          time(candidate.espnCapturedAt)) ||
        time(row.reviewedAt)>=time(candidate.startTime)-5*MIN) return null;
    if (row.action==="APPROVE" && state==="PENDING_REVIEW") {
      pairs=checkedPairs(row.pairs,candidate);
      if (!pairs) return null;
      state="APPROVED";
    } else if (row.action==="REJECT" && state==="PENDING_REVIEW" &&
               row.pairs===null) state="REJECTED";
    else if (row.action==="REVOKE" && state==="APPROVED" &&
             row.pairs===null) state="REVOKED";
    else return null;
    previousAt=time(row.reviewedAt);
    revision++;
  }
  return {state,pairs,revision:rows.length,approvedEvent:rows.find(r=>r.action==="APPROVE")||null};
}
function reviewedManifestRow(candidate,history,now) {
  const state=checkedHistory(history,candidate,now);
  if (!state || state.state!=="APPROVED" || !validCandidate(candidate,now)) return null;
  const reviewed=time(state.approvedEvent.reviewedAt);
  const until=Math.min(time(candidate.startTime)-5*MIN,reviewed+MAX_AGE);
  if (until<=now || until<=reviewed) return null;
  const row={schemaVersion:1,providerFixtureId:candidate.fixtureId,
    providerStartTime:candidate.startTime,espnEventId:candidate.eventId,
    reviewMethod:"MANUAL_TWO_SOURCE_ID_REVIEW",reviewStatus:"APPROVED",
    reviewedAt:state.approvedEvent.reviewedAt,validUntil:new Date(until).toISOString(),
    evidence:{providerReference:candidate.evidence.providerReference,
      espnReference:candidate.evidence.espnReference},teams:state.pairs};
  const bridge=makeReviewedTeamBridgeResolver([row],()=>now)({
    fixtureId:row.providerFixtureId,participant1Id:candidate.participantIds[0],
    participant2Id:candidate.participantIds[1],startTime:row.providerStartTime
  });
  return bridge ? row : null;
}

// Caller supplies ALL adapters from trusted backend code. Never pass browser
// objects as loadCandidate/history, or trust this factory as authentication proof.
// appendDecision must be an atomic, append-only compare-and-set in production.
function makeOfflineTeamReviewGate({authorize,loadCandidate,loadHistory,
  appendDecision,now=Date.now}={}) {
  if (![authorize,loadCandidate,loadHistory,appendDecision,now]
    .every(fn=>typeof fn==="function")) throw new TypeError("Missing server adapters.");
  async function submit(auth,request) {
    // Authorization before any data load; no UID or evidence returned to clients.
    let approval;
    try { approval=await authorize(auth); } catch (_) { return {status:"DENIED"}; }
    if (!exact(approval,["allowed","reviewerReference"]) ||
        approval.allowed!==true || !ref(approval.reviewerReference))
      return {status:"DENIED"};
    if (!obj(request) || !fixtureId(request.fixtureId) ||
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision<0 || request.expectedRevision>32 ||
        !["APPROVE","REJECT","REVOKE"].includes(request.action) ||
        !exact(request,request.action==="APPROVE" ?
          ["fixtureId","action","expectedRevision","pairs"] :
          ["fixtureId","action","expectedRevision"])) return {status:"INVALID_REQUEST"};
    const tick=now();
    if (!Number.isSafeInteger(tick)) return {status:"UNAVAILABLE"};
    let candidate,history;
    try {
      candidate=await loadCandidate(request.fixtureId);
      history=await loadHistory(request.fixtureId);
    } catch (_) {return {status:"UNAVAILABLE"};}
    if (!validCandidate(candidate,tick)) return {status:"EVIDENCE_UNAVAILABLE"};
    const state=checkedHistory(history,candidate,tick);
    if (!state) return {status:"REVIEW_HISTORY_INVALID"};
    if (state.revision!==request.expectedRevision) return {status:"REVISION_CONFLICT"};
    if ((request.action==="APPROVE"||request.action==="REJECT") &&
        state.state!=="PENDING_REVIEW" ||
        request.action==="REVOKE" && state.state!=="APPROVED")
      return {status:"INVALID_TRANSITION"};
    const pairs=request.action==="APPROVE" ? checkedPairs(request.pairs,candidate) : null;
    if (request.action==="APPROVE" && !pairs) return {status:"INVALID_PAIRS"};
    const event={schemaVersion:1,fixtureId:candidate.fixtureId,
      revision:state.revision+1,action:request.action,
      reviewedAt:new Date(tick).toISOString(),candidateDigest:candidate.candidateDigest,
      reviewMethod:"MANUAL_TWO_SOURCE_ID_REVIEW",
      reviewerReference:approval.reviewerReference,pairs};
    try {
      // Backend append MUST recheck revision and candidateDigest atomically.
      if (await appendDecision({fixtureId:candidate.fixtureId,
        expectedRevision:state.revision,candidateDigest:candidate.candidateDigest,
        event})!==true) return {status:"REVISION_CONFLICT"};
    } catch (_) {return {status:"UNAVAILABLE"};}
    return {status:request.action==="APPROVE"?"APPROVED":
      request.action==="REVOKE"?"REVOKED":"REJECTED",revision:event.revision};
  }
  async function resolve(fixtureQuery) {
    if (!exact(fixtureQuery,["fixtureId","participant1Id","participant2Id","startTime"]) ||
        !fixtureId(fixtureQuery.fixtureId)) return null;
    const tick=now();
    if (!Number.isSafeInteger(tick)) return null;
    let candidate,history;
    try {
      candidate=await loadCandidate(fixtureQuery.fixtureId);
      history=await loadHistory(fixtureQuery.fixtureId);
    } catch (_) {return null;}
    const row=reviewedManifestRow(candidate,history,tick);
    return row ? makeReviewedTeamBridgeResolver([row],()=>tick)(fixtureQuery) : null;
  }
  return Object.freeze({submit,resolve});
}
module.exports={captureProviderFixture,captureEspnEvent,makePendingTeamCandidate,
  reviewedManifestRow,makeOfflineTeamReviewGate};
