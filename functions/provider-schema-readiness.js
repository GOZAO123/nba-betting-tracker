"use strict";

// D13 OFFLINE diagnostic of an ALREADY-SUPPLIED league response shape.
// No HTTP, logging, secret, Firebase initialization, storage or approval.
// The strict D5 extractor remains the sole acceptance authority.
const { extractManualProviderIdentityBatch } =
  require("./provider-evidence-acquisition");
const { captureProviderFixture } = require("./offer-team-evidence");

const MAX_FIXTURES = 250;
const MAX_ACCEPTED = 64;
const MIN = 60 * 1000, MAX_HORIZON = 72 * 60 * MIN;
const EXAMPLE_REFERENCE = "ODDSPAPI_SCHEMA_PREFLIGHT_001";
const REASONS = Object.freeze([
  "FIXTURE_INVALID",
  "DUPLICATE_FIXTURE_ID",
  "BETANO_OFFER_UNAVAILABLE",
  "START_TIME_INVALID_OR_OUT_OF_WINDOW",
  "NBA_SPORT_NOT_CONFIRMED",
  "NBA_TOURNAMENT_NOT_CONFIRMED",
  "SCHEDULED_STATUS_NOT_CONFIRMED",
  "HAS_ODDS_FLAG_NOT_CONFIRMED",
  "FIXTURE_ID_INVALID",
  "PARTICIPANT_IDS_INVALID",
  "PARTICIPANT_IDS_DUPLICATE",
  "OTHER_D4_REJECTION"
]);

const object=x=>x!==null && typeof x==="object" && !Array.isArray(x);
const id=x=>(typeof x==="string"||typeof x==="number") &&
  /^[1-9][0-9]{0,15}$/.test(String(x))?String(x):null;
const fixtureId=x=>typeof x==="string" &&
  /^[A-Za-z0-9._:-]{1,120}$/.test(x);
const parseTime=x=>typeof x==="string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x))?Date.parse(x):NaN;
const emptyCounts=()=>Object.fromEntries(REASONS.map(reason=>[reason,0]));

function blocked(code, total=0) {
  return Object.freeze({
    status:"BLOCKED", sampleOnly:true, liveProviderVerified:false,
    releaseReady:false, reason:code,
    totalFixtures:total, acceptedFixtures:0, rejectedFixtures:0,
    reasonCounts:Object.freeze(emptyCounts())
  });
}

// Returns a fixed-category aggregate only; NO source value, identifier,
// fixture time, bookie line, odds, key or exception can leave this function.
// SAMPLE_COMPATIBLE is about supplied input shape, NEVER production readiness.
function inspectOfflineProviderIdentityShape(payload,capturedAt) {
  try {
    const capturedMs=parseTime(capturedAt);
    if(!Number.isFinite(capturedMs))
      return blocked("INVALID_CAPTURE_TIME");
    const fixtures=Array.isArray(payload)?payload:
      Array.isArray(payload?.data)?payload.data:
      Array.isArray(payload?.fixtures)?payload.fixtures:null;
    if(!fixtures) return blocked("INVALID_RESPONSE_SHAPE");
    if(fixtures.length>MAX_FIXTURES)
      return blocked("FIXTURE_COUNT_LIMIT");
    if(fixtures.length===0) return blocked("EMPTY_FIXTURE_SAMPLE");

    const seen=new Set(),duplicate=new Set();
    for(const row of fixtures) {
      const key=typeof row?.fixtureId==="string"?row.fixtureId:null;
      if(key) {
        if(seen.has(key))duplicate.add(key);
        seen.add(key);
      }
    }
    const counts=emptyCounts();
    let candidates=0;
    for(const row of fixtures) {
      let reason=null;
      if(!object(row)) reason="FIXTURE_INVALID";
      else if(duplicate.has(row.fixtureId)) reason="DUPLICATE_FIXTURE_ID";
      else {
        const book=row.bookmakerOdds?.["betano.pt"];
        if(!object(book)||book.bookmakerIsActive!==true||
           book.suspended===true||!object(book.markets))
          reason="BETANO_OFFER_UNAVAILABLE";
        else {
          const start=parseTime(row.startTime);
          if(!Number.isFinite(start) || start<=capturedMs+5*MIN ||
             start>capturedMs+MAX_HORIZON)
            reason="START_TIME_INVALID_OR_OUT_OF_WINDOW";
          else if(row.sportId!=11) reason="NBA_SPORT_NOT_CONFIRMED";
          else if(row.tournamentId!=132) reason="NBA_TOURNAMENT_NOT_CONFIRMED";
          else if(row.statusId!==0) reason="SCHEDULED_STATUS_NOT_CONFIRMED";
          else if(row.hasOdds!==true) reason="HAS_ODDS_FLAG_NOT_CONFIRMED";
          else if(!fixtureId(row.fixtureId)) reason="FIXTURE_ID_INVALID";
          else {
            const a=id(row.participant1Id),b=id(row.participant2Id);
            if(!a||!b) reason="PARTICIPANT_IDS_INVALID";
            else if(a===b) reason="PARTICIPANT_IDS_DUPLICATE";
            else if(!captureProviderFixture(row,{
              reference:EXAMPLE_REFERENCE,capturedAt
            })) reason="OTHER_D4_REJECTION";
          }
        }
      }
      if(reason) counts[reason]++;
      else candidates++;
    }
    const rejected=fixtures.length-candidates;
    // D5 is authoritative. A local diagnostic disagreement (or its 64-row
    // retention ceiling) must NEVER be presented as accepted evidence.
    if(candidates>MAX_ACCEPTED)
      return blocked("D5_ACCEPTED_COUNT_LIMIT",fixtures.length);
    const batch=extractManualProviderIdentityBatch(payload,capturedAt);
    if(!batch || batch.acceptedFixtures!==candidates ||
       batch.rejectedFixtures!==rejected ||
       batch.totalFixtures!==fixtures.length)
      return blocked("D5_COMPATIBILITY_INCONSISTENT",fixtures.length);

    return Object.freeze({
      status:candidates===0?"BLOCKED":
        rejected>0?"PARTIAL_SAMPLE":"SAMPLE_COMPATIBLE",
      sampleOnly:true,liveProviderVerified:false,releaseReady:false,
      reason:candidates===0?"NO_ACCEPTED_FIXTURES":"NONE",
      totalFixtures:fixtures.length,
      acceptedFixtures:candidates,
      rejectedFixtures:rejected,
      reasonCounts:Object.freeze(counts)
    });
  } catch (_) {
    // Getter traps, circular source objects and malformed responses fail safe.
    return blocked("DIAGNOSTIC_INPUT_UNAVAILABLE");
  }
}

module.exports={inspectOfflineProviderIdentityShape};
