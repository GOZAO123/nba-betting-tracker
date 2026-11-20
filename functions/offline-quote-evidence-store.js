"use strict";

// Update 35.1D15.30 — OFFLINE ONLY. Strict, backend-owned create-only
// persistence contract for already-frozen UNREVIEWED_PROVIDER_QUOTE records.
// No Firebase SDK, Firestore connection, HTTP, owner UID, tokens, or writes
// until a separately authenticated backend supplies both injected callbacks.
// This helper does NOT authenticate the source, bookie, ESPN player or quote.
const { createHash } = require("node:crypto");

const SOURCE = "ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const PREFIX = "_internal/quoteEvidence/providerObservations/";
const FAMILIES = Object.freeze(["PTS","REB","AST","3PT","PR","PA","RA","PRA"]);
const FIVE_MIN = 5 * 60000, HORIZON = 72 * 60 * 60000;
const FRESH_MS = 15 * 60000;
const QUOTE_KEYS = Object.freeze([
  "schemaVersion","status","source","attributedBookmaker",
  "sourceReference","capturedAt","fixtureId","startTime",
  "providerParticipantIds","providerPlayerId","providerPlayerName",
  "marketId","family","line","outcomes","freshness",
  "mainLineEvidence","digest","bookmakerVerified","espnPlayerVerified",
  "autoLineSelected","captureAllowed"
]);
const SIDE_KEYS = Object.freeze(["outcomeId","price","changedAt","mainLineFlag"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, allowed) => object(value) &&
  Object.keys(value).sort().join("|") === [...allowed].sort().join("|");
const identifier = value => typeof value === "string" &&
  /^[1-9][0-9]{0,15}$/.test(value);
const fixtureId = value => typeof value === "string" &&
  /^[A-Za-z0-9._:-]{1,120}$/.test(value);
const name = value => typeof value === "string" && value.trim() !== "" &&
  value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = value => typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Normalization intentionally recreates the D15.27 canonical tuple and its
// property order; Firestore may reorder stored object keys on reading.
// SHA256 checks consistency, NOT independent source authenticity.
function normalizeQuote(value, now) {
  if (!exact(value, QUOTE_KEYS) || !Number.isSafeInteger(now) || now < 0 ||
      value.schemaVersion !== 1 || value.status !== "UNREVIEWED_PROVIDER_QUOTE" ||
      value.source !== SOURCE || value.attributedBookmaker !== "betano.pt" ||
      !/^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(value.sourceReference) ||
      !fixtureId(value.fixtureId) || !identifier(value.providerPlayerId) ||
      !identifier(value.marketId) || !name(value.providerPlayerName) ||
      !Array.isArray(value.providerParticipantIds) ||
      value.providerParticipantIds.length !== 2 ||
      !value.providerParticipantIds.every(identifier) ||
      value.providerParticipantIds[0] === value.providerParticipantIds[1] ||
      !FAMILIES.includes(value.family) ||
      typeof value.line !== "number" || !Number.isFinite(value.line) ||
      value.line <= 0 || value.line > 1000 ||
      !Number.isInteger(value.line * 2) || Number.isInteger(value.line) ||
      value.bookmakerVerified !== false || value.espnPlayerVerified !== false ||
      value.autoLineSelected !== false || value.captureAllowed !== false ||
      !exact(value.outcomes, ["Over","Under"])) return null;

  const captured = timestamp(value.capturedAt);
  const kickoff = timestamp(value.startTime);
  if (!Number.isFinite(captured) || captured > now || now - captured > FIVE_MIN ||
      !Number.isFinite(kickoff) || kickoff <= now + FIVE_MIN ||
      kickoff > now + HORIZON) return null;
  const sides = {};
  const flags = [];
  let fresh = true;
  for (const side of ["Over","Under"]) {
    const entry = value.outcomes[side];
    if (!exact(entry,SIDE_KEYS) || !identifier(entry.outcomeId) ||
        typeof entry.price !== "number" || !Number.isFinite(entry.price) ||
        entry.price <= 1 || entry.price > 1000 ||
        ![true,false,null].includes(entry.mainLineFlag)) return null;
    const changed = timestamp(entry.changedAt);
    if (!Number.isFinite(changed) || changed > captured + 2 * 60000) return null;
    fresh = fresh && captured - changed <= FRESH_MS;
    flags.push(entry.mainLineFlag);
    sides[side] = Object.freeze({
      outcomeId: entry.outcomeId, price: entry.price,
      changedAt: entry.changedAt, mainLineFlag: entry.mainLineFlag
    });
  }
  if (sides.Over.outcomeId === sides.Under.outcomeId) return null;
  const evidence = flags.every(flag => flag === true) ?
    "BOTH_EXPLICIT_FLAGS_UNVERIFIED" :
    flags.some(flag => flag === true) ? "CONFLICTING_FLAGS" :
    "NO_EXPLICIT_FLAGS";
  if (value.mainLineEvidence !== evidence ||
      value.freshness !== (fresh ? "FRESH_WITHIN_15_MIN" : "STALE_PROVIDER_TIMESTAMP"))
    return null;

  const tuple = [
    SOURCE,value.sourceReference,value.capturedAt,value.fixtureId,value.startTime,
    value.providerParticipantIds[0],value.providerParticipantIds[1],
    value.providerPlayerId,value.providerPlayerName,value.marketId,
    value.family,value.line,sides.Over,sides.Under
  ];
  const digest = hash(tuple);
  if (value.digest !== digest) return null;
  const quote = Object.freeze({
    schemaVersion:1,status:"UNREVIEWED_PROVIDER_QUOTE",
    source:SOURCE,attributedBookmaker:"betano.pt",
    sourceReference:value.sourceReference,capturedAt:value.capturedAt,
    fixtureId:value.fixtureId,startTime:value.startTime,
    providerParticipantIds:Object.freeze([...value.providerParticipantIds]),
    providerPlayerId:value.providerPlayerId,
    providerPlayerName:value.providerPlayerName,
    marketId:value.marketId,family:value.family,line:value.line,
    outcomes:Object.freeze(sides),freshness:value.freshness,
    mainLineEvidence:evidence,digest,
    bookmakerVerified:false,espnPlayerVerified:false,
    autoLineSelected:false,captureAllowed:false
  });
  return quote;
}

// runTransaction MUST be an authenticated backend-owned atomic transaction
// exposing tx.read(path) and tx.create(path,doc). The latter MUST create-only.
// isTrustedQuoteReceipt MUST validate an UNFORGEABLE backend-generated token
// bound to this exact original manual fetch and digest. No string-only trust.
// Constructor and module import are inert: no Firebase initialization.
function makeOfflineQuoteEvidenceStore({
  isTrustedQuoteReceipt, runTransaction, now=Date.now
}={}) {
  if ([isTrustedQuoteReceipt,runTransaction,now].some(fn=>typeof fn!=="function"))
    throw new TypeError("Missing trusted quote storage dependencies.");

  const store = async (snapshot, token) => {
    let tick, quote;
    try {
      tick=now();
      quote=normalizeQuote(snapshot,tick);
    } catch (_) { return Object.freeze({status:"INVALID_QUOTE"}); }
    if (!quote) return Object.freeze({status:"INVALID_QUOTE"});
    let authorized = false;
    try {
      authorized = (await isTrustedQuoteReceipt(token,Object.freeze({
        source:SOURCE,reference:quote.sourceReference,
        capturedAt:quote.capturedAt,fixtureId:quote.fixtureId,
        marketId:quote.marketId,providerPlayerId:quote.providerPlayerId,
        digest:quote.digest
      }))) === true;
    } catch (_) { /* never reveal source or token failure */ }
    if (!authorized) return Object.freeze({status:"DENIED"});

    // Path reveals no player ID, name, prices or raw provider strings.
    // The same source+fixture+player+market can never be overwritten.
    const documentId = hash([
      quote.sourceReference,quote.fixtureId,quote.providerPlayerId,quote.marketId
    ]);
    const target = PREFIX + documentId;
    const record = Object.freeze({
      schemaVersion:1,status:"UNREVIEWED_QUOTE_EVIDENCE",
      source:SOURCE,receivedAt:new Date(tick).toISOString(),
      quote
    });
    try {
      const outcome=await runTransaction(async tx=>{
        if (!tx || typeof tx.read!=="function" ||
            typeof tx.create!=="function")
          throw Error("Untrusted transaction facade");
        const previous=await tx.read(target);
        if (previous!==null && previous!==undefined)
          return "REPLAY_BLOCKED";
        await tx.create(target,record);
        return "STORED";
      });
      return Object.freeze({status: ["STORED","REPLAY_BLOCKED"].includes(outcome) ?
        outcome : "UNAVAILABLE"});
    } catch (_) {
      return Object.freeze({status:"UNAVAILABLE"});
    }
  };
  return Object.freeze({store});
}

module.exports={makeOfflineQuoteEvidenceStore};
