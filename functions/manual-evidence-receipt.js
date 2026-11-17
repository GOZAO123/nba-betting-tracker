"use strict";

// D8 OFFLINE orchestration only: no Firebase initialization, network,
// callable, quota source, credentials, paid request or production wiring.
// All effects are supplied by trusted backend adapters.
const { makeLeagueMarketAuditRunner } = require("./league-market-audit-runner");
const { extractManualProviderIdentityBatch } = require("./provider-evidence-acquisition");
const { makeOfflineFirestoreProviderEvidenceStore } = require("./provider-evidence-firestore");

const SOURCE = "ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const MAX_RESERVATION_AGE = 5 * 60 * 1000;
const MAX_RECEIPT_DELAY = 2 * 60 * 1000;
const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
function identityOf(batch) {
  if (!obj(batch) || !Array.isArray(batch.records)) return null;
  return {
    total:batch.totalFixtures,
    accepted:batch.acceptedFixtures,
    rejected:batch.rejectedFixtures,
    tuples:batch.records.map(r => [
      r.fixtureId,r.startTime,r.participantIds?.[0],r.participantIds?.[1]
    ])
  };
}
function identitiesEqual(a,b) {
  if (!a || !b || a.total!==b.total || a.accepted!==b.accepted ||
      a.rejected!==b.rejected || a.tuples.length!==b.tuples.length) return false;
  return a.tuples.every((row,i)=>Array.isArray(row) && row.length===4 &&
    row.every((v,k)=>v===b.tuples[i][k]));
}

// Constructs an OWNER-ONLY MANUAL runner with the existing reservation guard.
// The trusted backend MUST inject its actual fixed-host OddsPapi transport,
// real reservation function, owner UID and Admin SDK database when eventually
// reviewed for production. This module itself never calls any endpoint.
function makeOfflineManualEvidenceAudit({
  ownerUid, reserve, fetchCatalogue, fetchOdds, db,
  waitBetweenRequests=async()=>{}, onFailure=()=>{}, now=Date.now,
  onEvidenceOutcome=null
}={}) {
  if (typeof ownerUid!=="string" || !ownerUid ||
      [reserve,fetchCatalogue,fetchOdds,waitBetweenRequests,onFailure,now]
        .some(fn=>typeof fn!=="function") ||
      (onEvidenceOutcome!==null && typeof onEvidenceOutcome!=="function"))
    throw new TypeError("Missing trusted manual audit dependencies.");

  const tick=()=>{
    const x=now();
    if (!Number.isSafeInteger(x) || x<0) throw Error("Invalid backend time");
    return x;
  };
  let permit=null, receipt=null, active=null, reserving=false, fetching=false;
  const store=makeOfflineFirestoreProviderEvidenceStore({
    db, now:tick,
    isTrustedManualReceipt:async(token,metadata)=>{
      const source=active;
      return !!source && token===source.token &&
        metadata?.source===SOURCE &&
        metadata.reference===source.reference &&
        metadata.capturedAt===source.capturedAt &&
        tick()>=source.fetchedAt &&
        tick()-source.fetchedAt<=MAX_RECEIPT_DELAY;
    }
  });
  const safeReserve=async slots=>{
    // Clear any unused/failed evidence, never reuse a previous authorization.
    if (reserving || fetching || active ||
        ![1,2].includes(slots)) throw Error("Reservation unavailable");
    // A previous audit could fail after reservation but before league fetch.
    // Invalidate that unused permission before a NEW backend-reserved run.
    permit=null;
    receipt=null;
    reserving=true;
    try {
      await reserve(slots); // existing backend transactional budget guard
      permit={at:tick()};
    } finally {reserving=false;}
  };
  const trustedFetchOdds=async()=>{
    const allowed=permit;
    permit=null;
    const current=tick();
    if (!allowed || fetching || receipt || active ||
        current<allowed.at || current-allowed.at>MAX_RESERVATION_AGE)
      throw Error("Missing fresh manual reservation");
    fetching=true;
    try {
      const odds=await fetchOdds(); // exactly one existing delegated fetch
      let source=null;
      try {
        const at=tick();
        const snapshot=extractManualProviderIdentityBatch(odds,
          new Date(at).toISOString());
        if (snapshot?.acceptedFixtures>0)
          source={fetchedAt:at,identity:identityOf(snapshot)};
      } catch (_) { /* evidence extraction must not break original audit */ }
      receipt=source;
      return odds; // return unmodified provider data to existing audit
    } finally {fetching=false;}
  };
  const onProviderEvidence=async batch=>{
    const source=receipt;
    receipt=null; // claim once BEFORE any async read/write
    if (!source || active) return Object.freeze({status:"UNAVAILABLE"});
    let capturedAt, reference, valid;
    try {
      const current=tick();
      capturedAt=Date.parse(batch?.capturedAt);
      reference=batch?.snapshotReference;
      valid=Number.isFinite(capturedAt) && capturedAt>=source.fetchedAt &&
        capturedAt<=current && current-source.fetchedAt<=MAX_RECEIPT_DELAY &&
        batch?.source===SOURCE &&
        /^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(reference) &&
        identitiesEqual(source.identity,identityOf(batch));
    } catch (_) { valid=false; }
    if (!valid) return Object.freeze({status:"INVALID_EVIDENCE"});
    // Unforgeable in-memory object identity, not a client or server ID string.
    const token=Object.freeze({});
    active={token,reference,capturedAt:batch.capturedAt,
      fetchedAt:source.fetchedAt};
    try {
      return await store.storeBatch(batch,token);
    } catch (_) {
      return Object.freeze({status:"UNAVAILABLE"});
    } finally {active=null;}
  };
  return makeLeagueMarketAuditRunner({
    ownerUid,reserve:safeReserve,fetchCatalogue,fetchOdds:trustedFetchOdds,
    waitBetweenRequests,onFailure,now:tick,onProviderEvidence,
    onEvidenceOutcome
  });
}
module.exports={makeOfflineManualEvidenceAudit};
