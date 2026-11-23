"use strict";

// Issue #97 — DISCONNECTED manual NBA fixture-identity attempt.
// Nothing invokes this factory from the deployed functions/index.js.
// A future trusted backend must inject its real owner UID, server-issued
// approval ID, shared six-per-UTC-day quota reservation and protected secret.
const {randomBytes}=require("node:crypto");
const {makeOfflineFixedFixturesTransport}=
  require("./offline-fixtures-fixed-transport");
const {extractOfflineFixtureTeamEvidence}=
  require("./offline-fixture-team-evidence");
const {makeOfflineFixtureTeamEvidenceStore}=
  require("./offline-fixtures-evidence-firestore");

const APPROVAL_PREFIX="_internal/fixtureTeamDiscovery/approvals/";
const APPROVAL_RE=/^[a-f0-9]{32}$/;
const TTL_MS=15*60*1000;
const fail=(code,message)=>Object.assign(new Error(message),{code});

function makeOfflineManualFixturesCollector({
  enabled=false,ownerUid,approvalId,getDb,reserve,
  getApiKey,fetchImpl,now=Date.now,
  deliverPrivateReceipt=null
}={}) {
  if(enabled!==true) {
    return Object.freeze(async()=>{
      throw fail("failed-precondition","Manual fixture discovery is disabled.");
    });
  }
  if(typeof ownerUid!=="string" || ownerUid.length<1 ||
      typeof approvalId!=="string" || !APPROVAL_RE.test(approvalId) ||
      [getDb,reserve,getApiKey,fetchImpl,now].some(x=>typeof x!=="function") ||
      (deliverPrivateReceipt!==null &&
       typeof deliverPrivateReceipt!=="function"))
    throw new TypeError("Missing trusted fixture-discovery configuration.");

  return Object.freeze(async request=>{
    // Invalid/anonymous callers cannot even inspect an approval or the budget.
    if(!request?.auth || request.auth.uid!==ownerUid ||
        request.auth.token?.email_verified!==true)
      throw fail("permission-denied","Verified owner required.");
    const data=request.data;
    if(!data || Object.getPrototypeOf(data)!==Object.prototype ||
        Reflect.ownKeys(data).length!==0)
      throw fail("invalid-argument","Expected an empty request.");

    // A completely separate one-use approval, with no provisioning endpoint.
    let db;
    try {
      const tick=now();
      if(!Number.isSafeInteger(tick) || tick<0) throw Error("Clock");
      db=getDb();
      if(typeof db?.doc!=="function" ||
          typeof db?.runTransaction!=="function") throw Error("DB");
      const approval=db.doc(APPROVAL_PREFIX+approvalId);
      if(approval?.path!==APPROVAL_PREFIX+approvalId) throw Error("Path");
      const acquired=await db.runTransaction(async tx=>{
        if(typeof tx?.get!=="function" ||
            typeof tx?.update!=="function") throw Error("Transaction");
        const snap=await tx.get(approval);
        const row=snap?.exists===true ? snap.data() : null;
        if(!row || typeof row!=="object" || Array.isArray(row) ||
            Object.keys(row).sort().join("|")!=="claimedAtMs|expiresAtMs|issuedAtMs" ||
            row.claimedAtMs!==null ||
            ![row.issuedAtMs,row.expiresAtMs].every(Number.isSafeInteger) ||
            row.issuedAtMs<0 || row.issuedAtMs>tick ||
            row.expiresAtMs<=tick ||
            row.expiresAtMs-row.issuedAtMs>TTL_MS) return false;
        tx.update(approval,{claimedAtMs:tick});
        return true;
      });
      if(acquired!==true)
        throw fail("failed-precondition","No usable discovery approval.");
    } catch(error) {
      if(error?.code==="failed-precondition") throw error;
      throw fail("unavailable","Discovery approval unavailable.");
    }

    // This approval is CONSUMED even if reservation or provider access fails.
    // Refuse mismatched/malformed reservation receipts before reading secrets.
    try {
      const before=now();
      if(!Number.isSafeInteger(before) || before<0)throw Error("Clock");
      const expectedDay=new Date(before).toISOString().slice(0,10);
      const committed=await reserve(1);
      if(!committed || committed.utcDay!==expectedDay ||
          !Number.isSafeInteger(committed.remaining) ||
          committed.remaining<0 || committed.remaining>5)
        throw Error("Unverified quota receipt.");
    } catch(error) {
      throw fail(error?.code==="resource-exhausted" ?
        "resource-exhausted":"unavailable","Manual discovery quota unavailable.");
    }

    let payload;
    try {
      // Exactly one fixed-host GET, no retries; key resolved only now.
      payload=await makeOfflineFixedFixturesTransport({
        getApiKey,fetchImpl
      }).fetchFixtures();
    } catch(_) {
      throw fail("unavailable","Fixture provider attempt failed.");
    }

    try {
      const tick=now();
      if(!Number.isSafeInteger(tick) || tick<0)throw Error("Clock");
      const metadata=Object.freeze({
        reference:"ODDSPAPI_FIXTURES_"+randomBytes(16).toString("hex").toUpperCase(),
        capturedAt:new Date(tick).toISOString()
      });
      const snapshot=extractOfflineFixtureTeamEvidence(payload,metadata,tick);
      if(!snapshot)return Object.freeze({status:"NO_STORABLE_FIXTURES"});

      // In-process object identity ties the one provider read to its one
      // immutable write. A client cannot supply or reconstruct this token.
      const privateToken=Object.freeze({});
      const store=makeOfflineFixtureTeamEvidenceStore({
        db,now,
        isTrustedReceipt:async (token,receipt)=>
          token===privateToken &&
          receipt?.source===snapshot.source &&
          receipt.reference===snapshot.reference &&
          receipt.capturedAt===snapshot.capturedAt &&
          receipt.digest===snapshot.digest
      });
      const stored=await store.storeReceipt(snapshot,privateToken);
      if(stored?.status!=="STORED")throw Error("Persistence");

      // Optional constructor-injected BACKEND-ONLY reference sink. Invoke
      // exactly once AFTER the protected create-only transaction commits.
      // The browser never supplies this callback or sees this reference.
      // The original approval and paid quota are already consumed.
      if(deliverPrivateReceipt!==null){
        try{
          const acknowledged=await deliverPrivateReceipt(Object.freeze({
            source:"ODDSPAPI_V4_FIXTURES",
            reference:snapshot.reference,
            capturedAt:snapshot.capturedAt
          }));
          if(acknowledged!==true)
            return Object.freeze({
              status:"STORED_UNREVIEWED_HANDOFF_UNCONFIRMED"
            });
        }catch(_){
          // A failed handoff is NOT a failed provider capture. Do not
          // repeat a paid request or hide the committed source evidence.
          return Object.freeze({
            status:"STORED_UNREVIEWED_HANDOFF_UNCONFIRMED"
          });
        }
      }
      // Never expose fixture IDs, team names, provider bodies or receipts.
      return Object.freeze({status:"STORED_UNREVIEWED"});
    } catch(_) {
      throw fail("unavailable","Fixture evidence unavailable.");
    }
  });
}

module.exports={makeOfflineManualFixturesCollector};
