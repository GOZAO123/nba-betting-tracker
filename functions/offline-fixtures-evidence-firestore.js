"use strict";

// Issue #97 D17 — disconnected Admin-SDK-style create-only fixture receipt
// custody. No Firebase import, production export, client writer, or network.
// Unlike D7 odds-league fixture storage, this is a separate versioned source
// with provider-observed team names; it never approves an ESPN team mapping.
const {createHash}=require("node:crypto");
const {extractOfflineFixtureTeamEvidence}=
  require("./offline-fixture-team-evidence");

const PREFIX="_internal/teamEvidence/fixtureTeamSnapshots/";
const REFERENCE=/^ODDSPAPI_FIXTURES_[A-F0-9]{32}$/;
const SNAPSHOT_KEYS=["schemaVersion","source","status","reference",
  "capturedAt","totalFixtures","acceptedFixtures","skippedOutsideWindow",
  "records","digest"];
const RECORD_KEYS=["schemaVersion","source","reference","capturedAt",
  "fixtureId","startTime","updatedAt","participant1Id","participant1Name",
  "participant2Id","participant2Name","digest"];
const object=x=>x!==null && typeof x==="object" && !Array.isArray(x);
const hasKeys=(x,keys)=>object(x) &&
  Object.keys(x).sort().join("|") === [...keys].sort().join("|");
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");

function normalizedSourceReceipt(receipt,now) {
  try {
    if (!hasKeys(receipt,SNAPSHOT_KEYS) ||
        receipt.schemaVersion!==1 ||
        receipt.source!=="ODDSPAPI_V4_FIXTURES" ||
        receipt.status!=="UNREVIEWED_PROVIDER_TEAM_NAMES" ||
        typeof receipt.reference!=="string" ||
        !REFERENCE.test(receipt.reference) ||
        !Number.isSafeInteger(receipt.totalFixtures) ||
        !Number.isSafeInteger(receipt.acceptedFixtures) ||
        !Number.isSafeInteger(receipt.skippedOutsideWindow) ||
        receipt.totalFixtures<1 || receipt.totalFixtures>250 ||
        receipt.acceptedFixtures<1 || receipt.acceptedFixtures>64 ||
        receipt.skippedOutsideWindow<0 ||
        receipt.totalFixtures !==
          receipt.acceptedFixtures + receipt.skippedOutsideWindow ||
        !Array.isArray(receipt.records) ||
        receipt.records.length!==receipt.acceptedFixtures ||
        typeof receipt.digest!=="string" ||
        !/^[a-f0-9]{64}$/.test(receipt.digest) ||
        !Number.isSafeInteger(now)) return null;

    const reconstructed=[];
    for(const row of receipt.records) {
      if(!hasKeys(row,RECORD_KEYS) ||
          row.schemaVersion!==1 ||
          row.source!==receipt.source ||
          row.reference!==receipt.reference ||
          row.capturedAt!==receipt.capturedAt ||
          typeof row.digest!=="string" ||
          !/^[a-f0-9]{64}$/.test(row.digest)) return null;
      reconstructed.push({
        fixtureId:row.fixtureId,startTime:row.startTime,
        updatedAt:row.updatedAt,
        sportId:11,tournamentId:132,statusId:0,hasOdds:true,
        participant1Id:row.participant1Id,
        participant1Name:row.participant1Name,
        participant2Id:row.participant2Id,
        participant2Name:row.participant2Name
      });
    }
    const normalized=extractOfflineFixtureTeamEvidence(reconstructed,{
      reference:receipt.reference,capturedAt:receipt.capturedAt
    },now);
    if (!normalized || normalized.records.length!==receipt.records.length)
      return null;

    for (let i=0;i<receipt.records.length;i++) {
      const actual=receipt.records[i],expected=normalized.records[i];
      for(const field of RECORD_KEYS) {
        if(actual[field]!==expected[field]) return null;
      }
    }
    const expectedDigest=hash([
      receipt.source,receipt.reference,receipt.capturedAt,
      receipt.totalFixtures,receipt.acceptedFixtures,
      receipt.skippedOutsideWindow,normalized.records.map(x=>x.digest)
    ]);
    return expectedDigest===receipt.digest ? receipt : null;
  } catch (_) {return null;}
}

function makeOfflineFixtureTeamEvidenceStore({
  db,isTrustedReceipt,now=Date.now
}={}) {
  if (!db || typeof db.doc!=="function" ||
      typeof db.runTransaction!=="function" ||
      typeof isTrustedReceipt!=="function" ||
      typeof now!=="function")
    throw new TypeError("Missing trusted fixture custody dependencies.");

  async function storeReceipt(receipt,token) {
    const tick=now();
    const safe=normalizedSourceReceipt(receipt,tick);
    if (!safe) return Object.freeze({status:"INVALID_EVIDENCE"});

    let trusted=false;
    try {
      trusted=await isTrustedReceipt(token,Object.freeze({
        source:safe.source,reference:safe.reference,
        capturedAt:safe.capturedAt,digest:safe.digest
      }))===true;
    } catch (_) { /* untrusted caller never gains custody access */ }
    if(!trusted) return Object.freeze({status:"DENIED"});

    try {
      const path=PREFIX+safe.reference;
      const ref=db.doc(path);
      if(ref?.path!==path)throw Error("Invalid Admin path.");
      return Object.freeze(await db.runTransaction(async tx=>{
        if(typeof tx?.get!=="function" || typeof tx?.create!=="function")
          throw Error("Invalid transaction.");
        const snap=await tx.get(ref);
        if(!snap || typeof snap.exists!=="boolean")
          throw Error("Invalid document response.");
        if(snap.exists) return {status:"REPLAY_BLOCKED"};
        await tx.create(ref,{
          ...safe,receivedAt:new Date(tick).toISOString()
        });
        return {status:"STORED"};
      }));
    } catch (_) {
      return Object.freeze({status:"STORE_UNAVAILABLE"});
    }
  }
  return Object.freeze({storeReceipt});
}

// Read-only verification helper for trusted backend review adapters. This checks
// canonical shape/digests, NOT actual provider provenance or reviewer authority.
module.exports={makeOfflineFixtureTeamEvidenceStore,
  validateOfflineFixtureTeamEvidenceReceipt:normalizedSourceReceipt};
