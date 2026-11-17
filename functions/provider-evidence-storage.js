"use strict";

// D6 OFFLINE contract only: immutable, backend-authorized storage of the
// already-sanitized D5 provider identity batch. NO Firebase SDK/network/UI.
const { createHash } = require("node:crypto");
const { captureProviderFixture } = require("./offer-team-evidence");

const SOURCE = "ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const PREFIX = "_internal/teamEvidence/providerSnapshots/";
const MAX_RECORDS = 64, MAX_FIXTURES = 250;
const FIVE_MIN = 5 * 60 * 1000, HORIZON = 72 * 60 * 60 * 1000;
const SNAPSHOT_KEYS = ["schemaVersion","source","status","snapshotReference",
  "capturedAt","totalFixtures","acceptedFixtures","rejectedFixtures","records"];
const RECORD_KEYS = ["schemaVersion","source","reference","capturedAt",
  "fixtureId","startTime","participantIds","digest"];
const STORED_KEYS = ["schemaVersion","source","status","reference",
  "capturedAt","receivedAt","totalFixtures","acceptedFixtures",
  "rejectedFixtures","digest","records"];

const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x, fields) => object(x) &&
  Object.keys(x).sort().join("|") === [...fields].sort().join("|");
const timestamp = x => typeof x === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
const digest = x => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const reference = x => typeof x === "string" &&
  /^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(x);

function normalizeBatch(batch, now) {
  if (!exact(batch,SNAPSHOT_KEYS) || batch.schemaVersion !== 1 ||
      batch.source !== SOURCE || batch.status !== "UNREVIEWED_PROVIDER_EVIDENCE" ||
      !reference(batch.snapshotReference) ||
      !Number.isSafeInteger(now)) return null;
  const captured = timestamp(batch.capturedAt);
  if (!Number.isFinite(captured) || captured > now || now - captured > FIVE_MIN ||
      !Number.isSafeInteger(batch.totalFixtures) || batch.totalFixtures < 1 ||
      batch.totalFixtures > MAX_FIXTURES ||
      !Number.isSafeInteger(batch.acceptedFixtures) || batch.acceptedFixtures < 1 ||
      batch.acceptedFixtures > MAX_RECORDS ||
      !Number.isSafeInteger(batch.rejectedFixtures) || batch.rejectedFixtures < 0 ||
      batch.acceptedFixtures + batch.rejectedFixtures !== batch.totalFixtures ||
      !Array.isArray(batch.records) || batch.records.length !== batch.acceptedFixtures)
    return null;

  const seen = new Set(), records = [];
  for (const row of batch.records) {
    if (!exact(row,RECORD_KEYS) || row.schemaVersion !== 1 ||
        row.source !== SOURCE ||
        row.reference !== batch.snapshotReference ||
        row.capturedAt !== batch.capturedAt ||
        !Array.isArray(row.participantIds) || row.participantIds.length !== 2 ||
        !row.participantIds.every(x=>typeof x === "string") ||
        typeof row.fixtureId !== "string" || seen.has(row.fixtureId))
      return null;

    // Recreate the D4 normalized record, including its SHA-256 fingerprint,
    // using ONLY allowlisted fields; never accept injected names/prices/keys.
    const expected = captureProviderFixture({
      fixtureId:row.fixtureId, startTime:row.startTime,
      sportId:11, tournamentId:132, statusId:0, hasOdds:true,
      participant1Id:row.participantIds[0],
      participant2Id:row.participantIds[1]
    }, {reference:batch.snapshotReference,capturedAt:batch.capturedAt});
    const start = timestamp(row.startTime);
    if (!expected || expected.digest !== row.digest ||
        !Number.isFinite(start) || start <= now + FIVE_MIN ||
        start > now + HORIZON) return null;
    seen.add(row.fixtureId);
    records.push({
      schemaVersion:1,source:SOURCE,reference:batch.snapshotReference,
      capturedAt:batch.capturedAt,fixtureId:expected.fixtureId,
      startTime:expected.startTime,participantIds:[...expected.participantIds],
      digest:expected.digest
    });
  }
  // Preserve source fixture order; a changed order under the same receipt is
  // a conflicting immutable observation, not a silent update.
  const fields=[batch.snapshotReference,batch.capturedAt,batch.totalFixtures,
    batch.acceptedFixtures,batch.rejectedFixtures,
    records.map(x=>[x.fixtureId,x.startTime,...x.participantIds,x.digest])];
  return Object.freeze({
    schemaVersion:1,source:SOURCE,status:"UNREVIEWED_PROVIDER_EVIDENCE",
    reference:batch.snapshotReference,capturedAt:batch.capturedAt,
    receivedAt:new Date(now).toISOString(),
    totalFixtures:batch.totalFixtures,acceptedFixtures:records.length,
    rejectedFixtures:batch.rejectedFixtures,digest:digest(fields),
    records:records.map(row=>Object.freeze({...row,
      participantIds:Object.freeze(row.participantIds)}))
  });
}
function sameStoredSnapshot(previous, next) {
  if (!exact(previous,STORED_KEYS) ||
      previous.schemaVersion!==1 || previous.source!==SOURCE ||
      previous.status!=="UNREVIEWED_PROVIDER_EVIDENCE" ||
      previous.reference!==next.reference ||
      previous.capturedAt!==next.capturedAt ||
      !Number.isFinite(timestamp(previous.receivedAt)) ||
      previous.totalFixtures!==next.totalFixtures ||
      previous.acceptedFixtures!==next.acceptedFixtures ||
      previous.rejectedFixtures!==next.rejectedFixtures ||
      previous.digest!==next.digest) return false;
  // Firestore may reorder map keys when reading a stored document. Compare
  // exact allowlisted values by position, not object serialization order.
  if (!Array.isArray(previous.records) ||
      previous.records.length!==next.records.length) return false;
  return previous.records.every((row,i)=>{
    const target=next.records[i];
    return exact(row,RECORD_KEYS) &&
      row.schemaVersion===target.schemaVersion &&
      row.source===target.source && row.reference===target.reference &&
      row.capturedAt===target.capturedAt && row.fixtureId===target.fixtureId &&
      row.startTime===target.startTime && row.digest===target.digest &&
      Array.isArray(row.participantIds) && row.participantIds.length===2 &&
      row.participantIds[0]===target.participantIds[0] &&
      row.participantIds[1]===target.participantIds[1];
  });
}

// runTransaction(callback) must be an authenticated backend-owned Firestore
// transaction wrapper exposing tx.read(path) and tx.create(path, document).
// read may return null for absent documents. create MUST be create-only,
// atomic, and never replace an existing path. No client-supplied paths.
// isTrustedManualReceipt MUST verify an actual backend-authorized provider
// response, not a forged client token or untrusted checksum.
function makeOfflineProviderEvidenceStore({
  isTrustedManualReceipt, runTransaction, now=Date.now
}={}) {
  if (![isTrustedManualReceipt,runTransaction,now].every(x=>typeof x==="function"))
    throw new TypeError("Missing trusted storage dependencies.");

  async function storeBatch(batch, receipt) {
    let tick;
    try { tick=now(); } catch (_) { return Object.freeze({status:"UNAVAILABLE"}); }
    let record;
    try { record=normalizeBatch(batch,tick); }
    catch (_) { return Object.freeze({status:"INVALID_BATCH"}); }
    if (!record) return Object.freeze({status:"INVALID_BATCH"});
    let trusted=false;
    try {
      trusted=(await isTrustedManualReceipt(receipt,Object.freeze({
        source:SOURCE,reference:record.reference,capturedAt:record.capturedAt
      })))===true;
    } catch (_) { /* deny without leaking error or reading storage */ }
    if (!trusted) return Object.freeze({status:"DENIED"});

    const path=PREFIX+record.reference;
    try {
      const status=await runTransaction(async tx=>{
        if (!tx || typeof tx.read!=="function" ||
            typeof tx.create!=="function") throw Error("Invalid backend transaction");
        const previous=await tx.read(path);
        if (previous!==null && previous!==undefined)
          return sameStoredSnapshot(previous,record) ? "ALREADY_STORED" : "CONFLICT";
        await tx.create(path,record);
        return "STORED";
      });
      if (!["STORED","ALREADY_STORED","CONFLICT"].includes(status))
        return Object.freeze({status:"UNAVAILABLE"});
      return Object.freeze({status});
    } catch (_) {
      return Object.freeze({status:"UNAVAILABLE"});
    }
  }
  return Object.freeze({storeBatch});
}

module.exports={makeOfflineProviderEvidenceStore};
