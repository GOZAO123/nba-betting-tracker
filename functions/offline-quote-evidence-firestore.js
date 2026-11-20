"use strict";

// Update 35.1D15.31 — OFFLINE ONLY. Firebase Admin-style transaction adapter
// for the existing unreviewed quote store; injected db, NO SDK initialization,
// HTTP, production export, live Firestore, polling, or provider requests.
const { createHash } = require("node:crypto");
const { makeOfflineQuoteEvidenceStore } =
  require("./offline-quote-evidence-store");

const PREFIX = "_internal/quoteEvidence/providerObservations/";
const PATH_RE = /^_internal\/quoteEvidence\/providerObservations\/[a-f0-9]{64}$/;
const SOURCE = "ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const STORED_KEYS = Object.freeze([
  "schemaVersion","status","source","receivedAt","quote"
]);
const QUOTE_KEYS = Object.freeze([
  "schemaVersion","status","source","attributedBookmaker",
  "sourceReference","capturedAt","fixtureId","startTime",
  "providerParticipantIds","providerPlayerId","providerPlayerName",
  "marketId","family","line","outcomes","freshness",
  "mainLineEvidence","digest","bookmakerVerified","espnPlayerVerified",
  "autoLineSelected","captureAllowed"
]);
const SIDE_KEYS = Object.freeze([
  "outcomeId","price","changedAt","mainLineFlag"
]);
const FAMILIES = Object.freeze([
  "PTS","REB","AST","3PT","PR","PA","RA","PRA"
]);
const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x, keys) => obj(x) &&
  Object.keys(x).sort().join("|") === [...keys].sort().join("|");
const ident = x => typeof x === "string" && /^[1-9][0-9]{0,15}$/.test(x);
const fixture = x => typeof x === "string" &&
  /^[A-Za-z0-9._:-]{1,120}$/.test(x);
const dateMs = x => typeof x === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
const sha = fields => createHash("sha256")
  .update(JSON.stringify(fields)).digest("hex");

function checkedDocumentReference(db, path) {
  if (typeof path !== "string" || !PATH_RE.test(path))
    throw Error("Invalid private quote evidence path.");
  const ref = db.doc(path);
  if (!ref || ref.path !== path)
    throw Error("Invalid private quote document reference.");
  return ref;
}

// Defense in depth: refuse unexpected fields or rewritten contents even when
// a future backend callback is incorrectly implemented. Reconstruct D15.27's
// canonical source tuple and deterministic document ID, not an auth signature.
function validCreateDocument(path, document) {
  if (!PATH_RE.test(path) || !exact(document,STORED_KEYS) ||
      document.schemaVersion!==1 ||
      document.status!=="UNREVIEWED_QUOTE_EVIDENCE" ||
      document.source!==SOURCE || !Number.isFinite(dateMs(document.receivedAt)))
    return false;
  const q=document.quote;
  if (!exact(q,QUOTE_KEYS) || q.schemaVersion!==1 ||
      q.status!=="UNREVIEWED_PROVIDER_QUOTE" ||
      q.source!==SOURCE || q.attributedBookmaker!=="betano.pt" ||
      !/^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(q.sourceReference) ||
      !fixture(q.fixtureId) || !ident(q.providerPlayerId) ||
      !ident(q.marketId) || !Array.isArray(q.providerParticipantIds) ||
      q.providerParticipantIds.length!==2 ||
      !q.providerParticipantIds.every(ident) ||
      q.providerParticipantIds[0]===q.providerParticipantIds[1] ||
      typeof q.providerPlayerName!=="string" ||
      q.providerPlayerName.trim()==="" ||
      q.providerPlayerName.length>100 ||
      /[\u0000-\u001f\u007f]/.test(q.providerPlayerName) ||
      !FAMILIES.includes(q.family) ||
      typeof q.line!=="number" || !Number.isFinite(q.line) ||
      q.line<=0 || q.line>1000 || !Number.isInteger(q.line*2) ||
      Number.isInteger(q.line) || !exact(q.outcomes,["Over","Under"]) ||
      q.bookmakerVerified!==false || q.espnPlayerVerified!==false ||
      q.autoLineSelected!==false || q.captureAllowed!==false)
    return false;

  const captured=dateMs(q.capturedAt), start=dateMs(q.startTime),
    received=dateMs(document.receivedAt);
  if (![captured,start,received].every(Number.isFinite) ||
      captured>received || received-captured>5*60000 ||
      start<=received+5*60000 || start>received+72*3600000)
    return false;
  const sides={},flags=[];
  let fresh=true;
  for (const key of ["Over","Under"]) {
    const side=q.outcomes[key];
    if (!exact(side,SIDE_KEYS) || !ident(side.outcomeId) ||
        typeof side.price!=="number" || !Number.isFinite(side.price) ||
        side.price<=1 || side.price>1000 ||
        ![true,false,null].includes(side.mainLineFlag))
      return false;
    const changed=dateMs(side.changedAt);
    if (!Number.isFinite(changed) || changed>captured+2*60000)
      return false;
    fresh=fresh && captured-changed<=15*60000;
    flags.push(side.mainLineFlag);
    sides[key]={
      outcomeId:side.outcomeId,price:side.price,
      changedAt:side.changedAt,mainLineFlag:side.mainLineFlag
    };
  }
  if (sides.Over.outcomeId===sides.Under.outcomeId) return false;
  const flagsStatus=flags.every(x=>x===true) ?
    "BOTH_EXPLICIT_FLAGS_UNVERIFIED" :
    flags.some(x=>x===true) ? "CONFLICTING_FLAGS" : "NO_EXPLICIT_FLAGS";
  if (q.mainLineEvidence!==flagsStatus ||
      q.freshness!==(fresh ? "FRESH_WITHIN_15_MIN" : "STALE_PROVIDER_TIMESTAMP"))
    return false;

  const digest=sha([
    SOURCE,q.sourceReference,q.capturedAt,q.fixtureId,q.startTime,
    q.providerParticipantIds[0],q.providerParticipantIds[1],
    q.providerPlayerId,q.providerPlayerName,q.marketId,q.family,q.line,
    sides.Over,sides.Under
  ]);
  return q.digest===digest && path===PREFIX+sha([
    q.sourceReference,q.fixtureId,q.providerPlayerId,q.marketId
  ]);
}

// Only one Admin get and at most one Admin create on the exact same private
// path, in a single injected db.runTransaction. A transaction callback cannot
// claim success without actually requesting a create, or claim replay without
// observing an existing record. Admin transaction retries remain atomic.
function makeOfflineFirestoreQuoteTransaction(db) {
  if (!db || typeof db.doc!=="function" ||
      typeof db.runTransaction!=="function")
    throw new TypeError("Missing backend Firestore quote dependencies.");

  return async function runQuoteTransaction(callback) {
    if (typeof callback!=="function")
      throw new TypeError("Missing private quote transaction callback.");
    return db.runTransaction(async adminTx=>{
      if (!adminTx || typeof adminTx.get!=="function" ||
          typeof adminTx.create!=="function")
        throw Error("Invalid private quote Admin transaction.");
      let readPath=null,wasAbsent=false,wasPresent=false,created=false;
      const tx=Object.freeze({
        async read(path) {
          if (readPath!==null) throw Error("Multiple quote reads forbidden.");
          const ref=checkedDocumentReference(db,path);
          readPath=path;
          const snapshot=await adminTx.get(ref);
          if (!snapshot || typeof snapshot.exists!=="boolean")
            throw Error("Invalid private quote document snapshot.");
          if (!snapshot.exists) {
            wasAbsent=true;
            return null;
          }
          if (typeof snapshot.data!=="function")
            throw Error("Invalid existing quote document snapshot.");
          const data=snapshot.data();
          if (!obj(data)) throw Error("Invalid existing quote document.");
          wasPresent=true;
          return data;
        },
        async create(path,record) {
          if (created || !wasAbsent || readPath!==path ||
              !validCreateDocument(path,record))
            throw Error("Private quote create forbidden.");
          const ref=checkedDocumentReference(db,path);
          created=true;
          await adminTx.create(ref,record);
        }
      });
      const result=await callback(tx);
      if (result==="STORED" && created && wasAbsent) return result;
      if (result==="REPLAY_BLOCKED" && wasPresent && !created) return result;
      throw Error("Invalid private quote transaction outcome.");
    });
  };
}

function makeOfflineFirestoreQuoteEvidenceStore({
  db,isTrustedQuoteReceipt,now=Date.now
}={}) {
  if (typeof isTrustedQuoteReceipt!=="function" ||
      typeof now!=="function")
    throw new TypeError("Missing trusted quote receipt callback.");
  return makeOfflineQuoteEvidenceStore({
    isTrustedQuoteReceipt,
    runTransaction:makeOfflineFirestoreQuoteTransaction(db),
    now
  });
}

module.exports={
  makeOfflineFirestoreQuoteTransaction,
  makeOfflineFirestoreQuoteEvidenceStore
};
