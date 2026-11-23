"use strict";

// Issue #97 / D17: strict OFFLINE extraction from an ALREADY-FETCHED,
// independently authorized GET /v4/fixtures response. No provider HTTP,
// Firestore, secrets, approvals, UI or production integration.
//
// The document is UNREVIEWED. Names are provider assertions, NOT an
// independent two-way mapping to ESPN teams or verified bookmaker odds.
const {createHash} = require("node:crypto");

const SOURCE = "ODDSPAPI_V4_FIXTURES";
const STATUS = "UNREVIEWED_PROVIDER_TEAM_NAMES";
const REF_RE = /^ODDSPAPI_FIXTURES_[A-F0-9]{32}$/;
const ID_RE = /^[1-9][0-9]{0,15}$/;
const FIXTURE_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_FIXTURES = 250;
const MAX_RECORDS = 64;
const FIVE_MIN = 5 * 60 * 1000;
const HORIZON = 72 * 60 * 60 * 1000;
const digest = x => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);

function canonicalUtcMs(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    return NaN;
  const ms=Date.parse(value);
  if (!Number.isFinite(ms)) return NaN;
  // Date.parse normalizes invalid calendar dates; refuse those.
  const normalized=value.includes(".") ?
    value.replace(/\.(\d+)Z$/,(_,part)=>"."+part.padEnd(3,"0")+"Z") :
    value.replace(/Z$/,".000Z");
  return new Date(ms).toISOString()===normalized ? ms : NaN;
}
function numericId(value) {
  const id=typeof value==="number" && Number.isSafeInteger(value) ?
    String(value) : typeof value==="string" ? value : "";
  return ID_RE.test(id) ? id : null;
}
function sourceName(value) {
  if (typeof value!=="string" || value.length<2 || value.length>100 ||
      value.trim()!==value || / {2,}/.test(value) ||
      /[\p{C}<>]/u.test(value) || Buffer.byteLength(value,"utf8")>160)
    return null;
  return value;
}
const nameKey = n => n.normalize("NFKC").toLocaleLowerCase("en");

// A future trusted backend must generate 'reference' itself and authenticate
// the provider response. A digest only detects mutation; it does not prove
// provenance and is never an authorization token.
function extractOfflineFixtureTeamEvidence(payload, metadata, now) {
  try {
    if (!Number.isSafeInteger(now) || now<0 ||
        !object(metadata) ||
        Object.keys(metadata).sort().join("|")!=="capturedAt|reference" ||
        typeof metadata.reference!=="string" ||
        !REF_RE.test(metadata.reference))
      return null;

    const capturedMs=canonicalUtcMs(metadata.capturedAt);
    if (!Number.isFinite(capturedMs) ||
        capturedMs>now || now-capturedMs>FIVE_MIN ||
        !Array.isArray(payload) || payload.length<1 ||
        payload.length>MAX_FIXTURES) return null;

    const seenFixtures=new Set();
    const namesById=new Map();
    const idsByName=new Map();
    const rows=[];
    let skippedOutsideWindow=0;

    for (const fixture of payload) {
      if (!object(fixture) ||
          typeof fixture.fixtureId!=="string" ||
          !FIXTURE_RE.test(fixture.fixtureId) ||
          seenFixtures.has(fixture.fixtureId) ||
          fixture.sportId!==11 || fixture.tournamentId!==132 ||
          fixture.statusId!==0 || fixture.hasOdds!==true) return null;
      seenFixtures.add(fixture.fixtureId);

      const startMs=canonicalUtcMs(fixture.startTime);
      const updatedMs=canonicalUtcMs(fixture.updatedAt);
      if (!Number.isFinite(startMs) || !Number.isFinite(updatedMs) ||
          updatedMs>capturedMs+2*60*1000) return null;

      const p1=numericId(fixture.participant1Id);
      const p2=numericId(fixture.participant2Id);
      const n1=sourceName(fixture.participant1Name);
      const n2=sourceName(fixture.participant2Name);
      if (!p1 || !p2 || p1===p2 || !n1 || !n2 ||
          nameKey(n1)===nameKey(n2)) return null;

      // Any conflicting name for the same ID, or same normalized name
      // attached to different IDs, invalidates the WHOLE source snapshot.
      for (const [id,name] of [[p1,n1],[p2,n2]]) {
        const key=nameKey(name);
        if ((namesById.has(id) && namesById.get(id)!==key) ||
            (idsByName.has(key) && idsByName.get(key)!==id)) return null;
        namesById.set(id,key);
        idsByName.set(key,id);
      }

      if (startMs<=now+FIVE_MIN || startMs>now+HORIZON) {
        skippedOutsideWindow++;
        continue;
      }
      if (rows.length>=MAX_RECORDS) return null;

      const row={
        schemaVersion:1,source:SOURCE,reference:metadata.reference,
        capturedAt:metadata.capturedAt,fixtureId:fixture.fixtureId,
        startTime:fixture.startTime,updatedAt:fixture.updatedAt,
        participant1Id:p1,participant1Name:n1,
        participant2Id:p2,participant2Name:n2
      };
      rows.push(Object.freeze({...row,digest:digest([
        SOURCE,row.reference,row.capturedAt,row.fixtureId,row.startTime,
        row.updatedAt,row.participant1Id,row.participant1Name,
        row.participant2Id,row.participant2Name
      ])}));
    }
    if (rows.length===0) return null;
    const result={
      schemaVersion:1,source:SOURCE,status:STATUS,
      reference:metadata.reference,capturedAt:metadata.capturedAt,
      totalFixtures:payload.length,acceptedFixtures:rows.length,
      skippedOutsideWindow,records:Object.freeze(rows)
    };
    return Object.freeze({...result,digest:digest([
      result.source,result.reference,result.capturedAt,result.totalFixtures,
      result.acceptedFixtures,result.skippedOutsideWindow,
      rows.map(row=>row.digest)
    ])});
  } catch (_) {
    // Invalid JSON-like inputs or injected getters are never treated as
    // trusted provider evidence; never reveal their original contents.
    return null;
  }
}

module.exports={extractOfflineFixtureTeamEvidence};
