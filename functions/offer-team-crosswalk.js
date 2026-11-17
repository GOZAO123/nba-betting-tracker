"use strict";

// Update 35.1D3: OFFLINE reviewed fixture/participant -> ESPN-team crosswalk.
// Source records must be approved in backend-controlled code/data, never read
// from user/browser requests. The default production manifest is EMPTY.
const MAX_ROWS = 128, MAX_REVIEW_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_VALIDITY_MS = 72 * 60 * 60 * 1000;
const RECORD_KEYS = Object.freeze(["evidence","espnEventId","providerFixtureId",
  "providerStartTime","reviewMethod","reviewStatus","reviewedAt",
  "schemaVersion","teams","validUntil"]);
const EVIDENCE_KEYS = Object.freeze(["espnReference","providerReference"]);
const TEAM_KEYS = Object.freeze(["espnTeamId","providerParticipantId"]);
const QUERY_KEYS = Object.freeze(["fixtureId","participant1Id","participant2Id","startTime"]);
const id = x => (typeof x === "string" || typeof x === "number") &&
  /^[1-9][0-9]{0,15}$/.test(String(x)) ? String(x) : null;
const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const keysEqual = (o,keys) => obj(o) &&
  Object.keys(o).sort().join("|") === [...keys].sort().join("|");
const fixtureId = x => typeof x === "string" && x.length > 0 &&
  x.length <= 120 && /^[A-Za-z0-9._:-]+$/.test(x) ? x : null;
const sourceRef = x => typeof x === "string" && x.length >= 6 &&
  x.length <= 160 && /^[A-Za-z0-9._:/-]+$/.test(x) ? x : null;
const parseTime = x => typeof x === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
function normalizeRow(row) {
  if (!keysEqual(row,RECORD_KEYS) || row.schemaVersion !== 1 ||
      row.reviewMethod !== "MANUAL_TWO_SOURCE_ID_REVIEW" ||
      !["APPROVED","REVOKED"].includes(row.reviewStatus) ||
      !fixtureId(row.providerFixtureId) || !id(row.espnEventId) ||
      !keysEqual(row.evidence,EVIDENCE_KEYS) ||
      !sourceRef(row.evidence.providerReference) ||
      !sourceRef(row.evidence.espnReference) ||
      !Array.isArray(row.teams) || row.teams.length !== 2) return null;
  const start=parseTime(row.providerStartTime),
    reviewed=parseTime(row.reviewedAt),until=parseTime(row.validUntil);
  if (![start,reviewed,until].every(Number.isFinite) ||
      reviewed>=start || until<=reviewed || until>start ||
      until-reviewed>MAX_VALIDITY_MS) return null;
  const providers=new Set(),espn=new Set(),pairs=[];
  for (const team of row.teams) {
    if (!keysEqual(team,TEAM_KEYS)) return null;
    const p=id(team.providerParticipantId),e=id(team.espnTeamId);
    if (!p || !e || providers.has(p) || espn.has(e)) return null;
    providers.add(p);espn.add(e);
    pairs.push(Object.freeze({providerParticipantId:p,espnTeamId:e}));
  }
  return Object.freeze({fixtureId:row.providerFixtureId,start,reviewed,until,
    eventId:id(row.espnEventId),status:row.reviewStatus,pairs:Object.freeze(pairs)});
}
function makeReviewedTeamBridgeResolver(records,clock=Date.now) {
  // Any malformed row, duplicate fixture, inconsistent global provider/team ID
  // mapping invalidates the whole record set: never choose the first match.
  if (!Array.isArray(records) || records.length>MAX_ROWS ||
      typeof clock!=="function") return ()=>null;
  const fixtures=new Map(),byProvider=new Map(),byEspn=new Map();
  for (const raw of records) {
    const row=normalizeRow(raw);
    if (!row || fixtures.has(row.fixtureId)) return ()=>null;
    fixtures.set(row.fixtureId,row);
    for (const pair of row.pairs) {
      const p=pair.providerParticipantId,e=pair.espnTeamId;
      if ((byProvider.has(p)&&byProvider.get(p)!==e) ||
          (byEspn.has(e)&&byEspn.get(e)!==p)) return ()=>null;
      byProvider.set(p,e);byEspn.set(e,p);
    }
  }
  return function getReviewedTeamBridge(query) {
    if (!keysEqual(query,QUERY_KEYS)) return null;
    const f=fixtureId(query.fixtureId),p1=id(query.participant1Id),
      p2=id(query.participant2Id),start=parseTime(query.startTime);
    if (!f || !p1 || !p2 || p1===p2 || !Number.isFinite(start)) return null;
    const record=fixtures.get(f);
    if (!record || record.status!=="APPROVED" || record.start!==start ||
        !record.pairs.some(pair=>pair.providerParticipantId===p1) ||
        !record.pairs.some(pair=>pair.providerParticipantId===p2)) return null;
    let now;
    try { now=clock(); } catch (_) { return null; }
    if (!Number.isSafeInteger(now) || now<record.reviewed ||
        now>record.until || now-record.reviewed>MAX_REVIEW_AGE_MS ||
        now>=record.start-5*60000) return null;
    return record.pairs.map(pair=>Object.freeze({...pair}));
  };
}

// The real OddsPapi audit retained only aggregate counts. No genuine mapping
// was independently reviewed or captured; do not manufacture identifiers.
const SERVER_REVIEWED_TEAM_MANIFEST = Object.freeze([]);
const getReviewedTeamBridge =
  makeReviewedTeamBridgeResolver(SERVER_REVIEWED_TEAM_MANIFEST);
module.exports = { makeReviewedTeamBridgeResolver, getReviewedTeamBridge };
