"use strict";

// D15 — OFFLINE, backend-only, MANUAL identity-shape diagnostic.
// A future separately approved enabled dispatch may use exactly ONE
// league endpoint request without requiring an eligible market catalogue.
// This is never an identity approval, a verified bookmaker offer, or a write.
const { inspectOfflineProviderIdentityShape } =
  require("./provider-schema-readiness");

const CACHE_MS = 15 * 60 * 1000;
const safeError = message => {
  const error = new Error(message);
  error.code = "unavailable";
  return error;
};

function makeOfflineManualIdentityShapeProbe({
  ownerUid, reserve, fetchOdds, now = Date.now
} = {}) {
  if (typeof ownerUid !== "string" || ownerUid.length === 0 ||
      [reserve, fetchOdds, now].some(fn => typeof fn !== "function"))
    throw new TypeError("Missing trusted manual identity-shape dependencies.");

  let snapshot = null, snapshotAt = 0, inFlight = null;
  return async function inspect(request) {
    // Authentication and parameterlessness BEFORE cache, quota or HTTP access.
    if (!request?.auth || request.auth.uid !== ownerUid ||
        request.auth.token?.email_verified !== true) {
      const error = new Error("Only the verified owner may inspect identity format.");
      error.code = "permission-denied";
      throw error;
    }
    let argumentsValid = false;
    try {
      const data = request.data;
      argumentsValid = data == null ||
        (typeof data === "object" && !Array.isArray(data) &&
          Object.keys(data).length === 0);
    } catch (_) { /* Untrusted getters fail closed. */ }
    if (!argumentsValid) {
      const error = new Error("Manual identity-shape probe accepts no parameters.");
      error.code = "invalid-argument";
      throw error;
    }
    let tick;
    try { tick = now(); } catch (_) {
      throw safeError("Manual identity-shape clock unavailable.");
    }
    if (!Number.isSafeInteger(tick) || tick < 0)
      throw safeError("Manual identity-shape clock unavailable.");
    if (snapshot && tick >= snapshotAt && tick - snapshotAt < CACHE_MS)
      return {...snapshot, cached: true, requestsUsedOnThisClick: 0};
    if (inFlight)
      return inFlight.then(result =>
        ({...result, cached: true, requestsUsedOnThisClick: 0}));

    inFlight = (async () => {
      // One UTC-day reservation before secret access or the single paid fetch.
      try { await reserve(1); }
      catch (_) { throw safeError("Manual identity-shape budget unavailable."); }

      let response;
      try { response = await fetchOdds(); }
      catch (_) {
        throw safeError("Manual identity-shape response unavailable; a reservation may have been consumed.");
      }

      let capturedAt, observedAt;
      try {
        observedAt = now();
        if (!Number.isSafeInteger(observedAt) || observedAt < tick)
          throw Error("Invalid clock");
        capturedAt = new Date(observedAt).toISOString();
      } catch (_) {
        throw safeError("Manual identity-shape clock unavailable; a reservation may have been consumed.");
      }
      // D13 is the fixed-category diagnostic; D5 is its final identity-shape
      // authority. No raw provider fixture, player, team, line or price escapes.
      const shape = inspectOfflineProviderIdentityShape(response, capturedAt);
      snapshot = Object.freeze({
        diagnostic: "PROVIDER_IDENTITY_SHAPE_ONLY",
        shapeStatus: shape.status,
        reason: shape.reason,
        totalFixtures: shape.totalFixtures,
        acceptedFixtures: shape.acceptedFixtures,
        rejectedFixtures: shape.rejectedFixtures,
        reasonCounts: shape.reasonCounts,
        teamMappingApproved: false,
        identityVerified: false,
        releaseReady: false,
        bookmakerOddsVerified: false,
        researchSaved: false
      });
      snapshotAt = observedAt;
      return {...snapshot, cached: false, requestsUsedOnThisClick: 1};
    })();
    try { return await inFlight; }
    finally { inFlight = null; }
  };
}

module.exports = { makeOfflineManualIdentityShapeProbe };
