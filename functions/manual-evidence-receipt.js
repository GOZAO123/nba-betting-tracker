"use strict";

// D8 OFFLINE orchestration only: no Firebase initialization, network,
// callable, quota source, credentials, paid request or production wiring.
// All effects are supplied by trusted backend adapters.
const { makeLeagueMarketAuditRunner } = require("./league-market-audit-runner");
const { extractManualProviderIdentityBatch } = require("./provider-evidence-acquisition");
const { makeOfflineFirestoreProviderEvidenceStore } = require("./provider-evidence-firestore");
const { freezeUnreviewedProviderPlayerPair, normalizeOfflineQuoteScope,
  resolveOfflineQuoteSelection } =
  require("./provider-player-quote-snapshot");

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
  onEvidenceOutcome=null, trustedQuoteSelection=null, trustedQuoteScope=null, onTrustedQuote=null
}={}) {
  if (typeof ownerUid!=="string" || !ownerUid ||
      [reserve,fetchCatalogue,fetchOdds,waitBetweenRequests,onFailure,now]
        .some(fn=>typeof fn!=="function") ||
      (onEvidenceOutcome!==null && typeof onEvidenceOutcome!=="function"))
    throw new TypeError("Missing trusted manual audit dependencies.");

  // Opt-in offline-only: the selection and private quote callback must both be
  // constructed on the trusted backend. Never accept request.data selectors.
  const quoteEnabled=trustedQuoteSelection!==null || trustedQuoteScope!==null ||
    onTrustedQuote!==null;
  const scope=trustedQuoteScope===null ? null : normalizeOfflineQuoteScope(trustedQuoteScope);
  const selectorValid=trustedQuoteSelection && obj(trustedQuoteSelection) &&
    Object.keys(trustedQuoteSelection).sort().join("|") ===
      "fixtureId|marketId|providerPlayerId" &&
    typeof trustedQuoteSelection.fixtureId==="string" &&
    /^[A-Za-z0-9._:-]{1,120}$/.test(trustedQuoteSelection.fixtureId) &&
    [trustedQuoteSelection.marketId,trustedQuoteSelection.providerPlayerId]
      .every(x=>(typeof x==="string" || typeof x==="number") &&
        /^[1-9][0-9]{0,15}$/.test(String(x)));
  if (quoteEnabled && (typeof onTrustedQuote!=="function" ||
      (trustedQuoteScope===null ? !selectorValid : !scope || trustedQuoteSelection!==null)))
    throw new TypeError("Invalid trusted quote review dependencies.");
  const selection=selectorValid ? Object.freeze({
    fixtureId:trustedQuoteSelection.fixtureId,
    marketId:String(trustedQuoteSelection.marketId),
    providerPlayerId:String(trustedQuoteSelection.providerPlayerId)
  }) : null;

  const tick=()=>{
    const x=now();
    if (!Number.isSafeInteger(x) || x<0) throw Error("Invalid backend time");
    return x;
  };
  let permit=null, receipt=null, active=null, reserving=false, fetching=false;
  let trustedCatalogue=null; // reuse existing runner's manual catalogue call
  const trustedFetchCatalogue=async()=>{
    const definitions=await fetchCatalogue();
    if (quoteEnabled) trustedCatalogue=definitions;
    return definitions;
  };
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
          source={fetchedAt:at,identity:identityOf(snapshot),
            ...(quoteEnabled ? {odds,catalogue:trustedCatalogue} : {})};
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
    // Freeze only one backend-selected original quote, while still holding the
    // exact authorized league payload and validated one-use fixture receipt.
    // A candidate is unreviewed; it cannot select odds or write research.
    let quote=null;
    if (quoteEnabled && source.catalogue) {
      try {
        const resolved=selection ?? resolveOfflineQuoteSelection(
          scope,source.catalogue,source.odds);
        if (resolved) quote=freezeUnreviewedProviderPlayerPair({
          catalogue:source.catalogue,leagueOdds:source.odds,
          snapshotReference:batch.snapshotReference,capturedAt:batch.capturedAt,
          now:tick(),...resolved
        });
      } catch (_) { /* never fail ordinary fixture evidence */ }
    }
    // Unforgeable in-memory object identity, not a client or server ID string.
    const token=Object.freeze({});
    active={token,reference,capturedAt:batch.capturedAt,
      fetchedAt:source.fetchedAt};
    try {
      const outcome=await store.storeBatch(batch,token);
      // No quote callback on failed, conflicted, denied or repeated evidence.
      // Never let the private sink affect the ordinary audit or cause a retry.
      if (quote && outcome?.status==="STORED") {
        try { await onTrustedQuote(quote); }
        catch (_) { /* quote sink errors are deliberately isolated */ }
      }
      return outcome;
    } catch (_) {
      return Object.freeze({status:"UNAVAILABLE"});
    } finally {active=null;}
  };
  return makeLeagueMarketAuditRunner({
    ownerUid,reserve:safeReserve,fetchCatalogue:trustedFetchCatalogue,
    fetchOdds:trustedFetchOdds,
    waitBetweenRequests,onFailure,now:tick,onProviderEvidence,
    onEvidenceOutcome
  });
}
module.exports={makeOfflineManualEvidenceAudit};
