"use strict";

// Update 35.1D15.32 — OFFLINE, default-disabled, trusted backend composition.
// Binds D8's one-time private original OddsPapi league response/fixture receipt
// to D15.31's strict create-only Admin-style unreviewed quote evidence store.
// No Firebase initialization, transport, API key, HTTP, callable, schedules,
// browser access, polling or paid provider calls in this module.
const { makeOfflineManualEvidenceAudit } = require("./manual-evidence-receipt");
const { makeOfflineFirestoreQuoteEvidenceStore } =
  require("./offline-quote-evidence-firestore");

const { makeOfflinePlayerReceiptLink } = require("./offline-player-receipt-link");

const KEYS=Object.freeze([
  "enabled","ownerUid","reserve","fetchCatalogue","fetchOdds","db",
  "trustedQuoteSelection","trustedQuoteScope","waitBetweenRequests","now","onFailure",
  "onEvidenceOutcome","onQuoteOutcome","readPrivateEvidence"
]);
const META_KEYS=Object.freeze([
  "capturedAt","digest","fixtureId","marketId","providerPlayerId",
  "reference","source"
]);
const SOURCE="ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const SAFE_STATUSES=Object.freeze([
  "STORED","REPLAY_BLOCKED","DENIED","INVALID_QUOTE","UNAVAILABLE"
]);
const obj=x=>x!==null && typeof x==="object" && !Array.isArray(x);
const exact=(x,keys)=>obj(x) &&
  Object.keys(x).sort().join("|") === [...keys].sort().join("|");

function makeOfflineManualQuotePersistence(config={}) {
  if (!obj(config) || Object.keys(config).some(k=>!KEYS.includes(k)) ||
      (config.enabled!==undefined && typeof config.enabled!=="boolean"))
    throw new TypeError("Invalid offline quote persistence configuration.");

  // Default-disabled even if supplied with working backend dependencies.
  // A client cannot turn this mode on by passing request.data.
  if (config.enabled!==true) {
    return Object.freeze(async function disabled() {
      const err=new Error("Offline quote persistence is disabled.");
      err.code="failed-precondition";
      throw err;
    });
  }

  const {
    ownerUid,reserve,fetchCatalogue,fetchOdds,db,trustedQuoteSelection,trustedQuoteScope,
    waitBetweenRequests=async()=>{},now=Date.now,onFailure=()=>{},
    onEvidenceOutcome=null,onQuoteOutcome=null,readPrivateEvidence=null
  }=config;
  if (typeof ownerUid!=="string" || ownerUid.length===0 ||
      [reserve,fetchCatalogue,fetchOdds,waitBetweenRequests,now,onFailure]
        .some(x=>typeof x!=="function") ||
      !db || typeof db.doc!=="function" ||
      typeof db.runTransaction!=="function" ||
      (onEvidenceOutcome!==null && typeof onEvidenceOutcome!=="function") ||
      (onQuoteOutcome!==null && typeof onQuoteOutcome!=="function") ||
      (readPrivateEvidence!==null && typeof readPrivateEvidence!=="function"))
    throw new TypeError("Missing trusted backend quote integration dependencies.");

  let active=null;
  // This callback is owned by the same server-side factory. It cannot be
  // supplied in browser request data or invoked via the returned audit runner.
  const quoteStore=makeOfflineFirestoreQuoteEvidenceStore({
    db,now,
    isTrustedQuoteReceipt:async(token,metadata)=>{
      const scope=active;
      if (!scope || token!==scope.token || scope.claimed ||
          !exact(metadata,META_KEYS) ||
          META_KEYS.some(key=>metadata[key]!==scope.metadata[key]))
        return false;
      scope.claimed=true; // one use before any transaction work
      return true;
    }
  });

  const review=readPrivateEvidence && makeOfflinePlayerReceiptLink({
    now,readPrivateEvidence,
    isTrustedInternalReview:(token,selection)=>
      active?.token===token && active.claimed &&
      selection.sourceReference===active.metadata.reference &&
      ["fixtureId","marketId","providerPlayerId"].every(key=>
        selection[key]===active.metadata[key])
  });

  const trustedQuoteSink=async quote=>{
    if (active) return; // never grant overlapping in-flight capabilities
    const token=Object.freeze({});
    const metadata=Object.freeze({
      source:quote?.source,
      reference:quote?.sourceReference,
      capturedAt:quote?.capturedAt,
      fixtureId:quote?.fixtureId,
      marketId:quote?.marketId,
      providerPlayerId:quote?.providerPlayerId,
      digest:quote?.digest
    });
    if (metadata.source!==SOURCE) return;
    active={token,metadata,claimed:false};
    let status="UNAVAILABLE";
    try {
      // D8 executes this only after its own authenticated fixture-only
      // source receipt transaction returned STORED.
      const result=await quoteStore.store(quote,token);
      if (result && SAFE_STATUSES.includes(result.status) &&
          Object.keys(result).length===1) status=result.status;
      if (review && status==="STORED") {
        status="UNLINKED";
        const {fixtureId,marketId,providerPlayerId,reference,digest}=metadata;
        const linked=await review({
          fixtureId,marketId,providerPlayerId,sourceReference:reference
        },token);
        if (linked?.status==="UNREVIEWED_RECEIPT_LINK_ONLY" &&
            linked.quoteDigest===digest) status="LINKED_UNREVIEWED";
      }
    } catch (_) {
      // No provider retries, no raw provider data or private error forwarding.
    } finally {
      active=null; // delete in-process capability even after failures
    }
    if (onQuoteOutcome) {
      try { await onQuoteOutcome(Object.freeze({status})); }
      catch (_) { /* monitoring cannot retry or fail the ordinary audit */ }
    }
  };

  const audit=makeOfflineManualEvidenceAudit({
    ownerUid,reserve,fetchCatalogue,fetchOdds,db,waitBetweenRequests,
    now,onFailure,onEvidenceOutcome,trustedQuoteSelection,trustedQuoteScope,
    onTrustedQuote:trustedQuoteSink
  });
  // The only exposed interface is D8's parameterless owner-gated manual audit.
  // Never return the store, receipt callback, private token or transport.
  return Object.freeze(audit);
}

module.exports={makeOfflineManualQuotePersistence};
