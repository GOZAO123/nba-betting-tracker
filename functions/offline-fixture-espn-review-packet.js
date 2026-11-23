"use strict";

// Issue #97 D18: disconnected TWO-SOURCE review packet from independently
// acquired OddsPapi /v4/fixtures evidence and ESPN NBA scoreboard data.
// This is not a provider-to-ESPN crosswalk and NEVER approves a pairing.
// No network, Firebase, customer data, quotas, or side effects on import/call.
const {createHash}=require("node:crypto");
const {validateOfflineFixtureTeamEvidenceReceipt}=
  require("./offline-fixtures-evidence-firestore");
const {captureEspnEvent}=require("./offer-team-evidence");

const MINUTE=60000;
const MAX_AGE=30*MINUTE;
const MAX_EVENTS=40;
const FIXTURE_ID=/^[A-Za-z0-9._:-]{1,120}$/;
const REF=/^ESPN_[A-Z0-9_-]{6,88}$/;
const ID=/^[1-9][0-9]{0,15}$/;
const exact=(x,keys)=>x!==null && typeof x==="object" &&
  !Array.isArray(x) &&
  Object.keys(x).sort().join("|") === [...keys].sort().join("|");
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const safeName=x=>typeof x==="string" && x.length>=2 && x.length<=100 &&
  x===x.trim() && x.normalize("NFC")===x &&
  !/[\p{C}<>]/u.test(x) && Buffer.byteLength(x,"utf8")<=160 ?
  x : null;
const time=x=>typeof x==="string" && Number.isFinite(Date.parse(x)) ?
  Date.parse(x) : NaN;
const freeze=o=>Object.freeze(o);

// Input MUST originate from a trusted server-side Firestore/Admin receipt
// loader and independent fixed-host ESPN transport in future wiring.
// Even valid hashes cannot authenticate a browser-supplied receipt or ESPN
// payload. This helper deliberately returns NO D4 authorization object.
function makeOfflineFixtureEspnReviewPacket(input) {
  try {
    if(!exact(input,["fixtureId","providerReceipt","espnScoreboard",
      "espnMetadata","now"]) ||
      !Number.isSafeInteger(input.now) || input.now<0 ||
      typeof input.fixtureId!=="string" || !FIXTURE_ID.test(input.fixtureId))
      return null;

    const {fixtureId,providerReceipt,espnScoreboard,espnMetadata,now}=input;
    const providerCapture=time(providerReceipt?.capturedAt);
    if(!Number.isFinite(providerCapture) || providerCapture>now ||
      now-providerCapture>MAX_AGE) return null;

    // Validation clock is ANCHORED at original capture, not review time:
    // source receipt may have been held privately for several minutes.
    // No mutated/wrong-schema/signed-by-user document is trusted here.
    const verified=validateOfflineFixtureTeamEvidenceReceipt(
      providerReceipt,providerCapture
    );
    if(!verified) return null;
    const matching=verified.records.filter(r=>r.fixtureId===fixtureId);
    if(matching.length!==1)return null;
    const row=matching[0];
    if(time(row.startTime)<=now+5*MINUTE ||
      time(row.startTime)>now+72*60*MINUTE) return null;

    if(!exact(espnMetadata,["reference","capturedAt"]) ||
      typeof espnMetadata.reference!=="string" ||
      !REF.test(espnMetadata.reference)) return null;
    const espnCapture=time(espnMetadata.capturedAt);
    if(!Number.isFinite(espnCapture) || espnCapture>now ||
      now-espnCapture>MAX_AGE ||
      Math.abs(espnCapture-providerCapture)>MAX_AGE ||
      espnMetadata.reference===verified.reference) return null;

    // D4 refuses scoreboard ambiguity: ZERO or MULTIPLE independently
    // scheduled games within five minutes never select a candidate.
    const espn=captureEspnEvent(espnScoreboard,row.startTime,espnMetadata);
    if(!espn || !Array.isArray(espnScoreboard?.events) ||
      espnScoreboard.events.length>MAX_EVENTS) return null;
    const match=espnScoreboard.events.filter(
      e=>String(e?.id)===espn.eventId
    );
    if(match.length!==1) return null;
    const competitors=match[0].competitions?.[0]?.competitors;
    if(!Array.isArray(competitors)||competitors.length!==2)return null;
    const home=competitors.find(c=>c?.homeAway==="home");
    const away=competitors.find(c=>c?.homeAway==="away");
    if(!home||!away||
      String(home.team?.id)!==espn.homeTeamId ||
      String(away.team?.id)!==espn.awayTeamId ||
      !ID.test(espn.homeTeamId)||!ID.test(espn.awayTeamId))
      return null;
    const homeName=safeName(home.team.displayName);
    const awayName=safeName(away.team.displayName);
    if(!homeName||!awayName ||
      homeName.normalize("NFKC").toLowerCase()===
      awayName.normalize("NFKC").toLowerCase()) return null;

    const provider=freeze({
      source:"ODDSPAPI_V4_FIXTURES",
      reference:verified.reference,capturedAt:verified.capturedAt,
      fixtureId:row.fixtureId,startTime:row.startTime,
      snapshotDigest:verified.digest,recordDigest:row.digest,
      participants:freeze([
        freeze({participantId:row.participant1Id,displayName:row.participant1Name}),
        freeze({participantId:row.participant2Id,displayName:row.participant2Name})
      ])
    });
    const espnRecord=freeze({
      source:"ESPN_NBA_SCOREBOARD",reference:espn.reference,
      capturedAt:espn.capturedAt,digest:espn.digest,
      eventId:espn.eventId,startTime:espn.startTime,
      home:freeze({teamId:espn.homeTeamId,displayName:homeName}),
      away:freeze({teamId:espn.awayTeamId,displayName:awayName})
    });
    const base={
      schemaVersion:1,
      status:"EVIDENCE_READY_FOR_MANUAL_REVIEW",
      reviewRequired:true,
      provider,espn:espnRecord,
      reviewedPairs:null,
      approved:false
    };
    // Integrity pin for a later *separately authorized* backend review.
    // It is not proof of genuine capture, reviewer identity, or approval.
    return freeze({...base,packetDigest:hash(base)});
  } catch (_) {
    return null;
  }
}

module.exports={makeOfflineFixtureEspnReviewPacket};
