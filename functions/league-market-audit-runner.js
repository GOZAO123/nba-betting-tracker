"use strict";

// Manual-only audit orchestration; all effects are injected and tested offline.
// No Firebase, credentials, HTTP, timers or scheduled work is performed here.
const { auditOfficialLeagueProps } = require("./league-market-audit");
const CATALOGUE_TTL_MS = 12 * 60 * 60 * 1000;
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;

// Only fixed vocabulary is emitted. Never log Error objects, provider text,
// request URLs, credentials, market IDs, prices or account identifiers.
const SAFE_AUDIT_STAGES = Object.freeze([
  "BUDGET_RESERVE", "CATALOGUE_FETCH", "CATALOGUE_VALIDATE",
  "COOLDOWN", "LEAGUE_FETCH", "LEAGUE_ANALYZE"
]);
function safeAuditFailure(stage, error) {
  const safeStage = SAFE_AUDIT_STAGES.includes(stage) ? stage : "UNKNOWN_STAGE";
  const message = typeof error?.message === "string" ? error.message : "";
  const name = typeof error?.name === "string" ? error.name : "";
  let reason = "OTHER_FAILURE";
  if (safeStage === "BUDGET_RESERVE") {
    reason = error?.code === "resource-exhausted" ?
      "DAILY_BUDGET_BLOCKED" : "BUDGET_UNAVAILABLE";
  } else if (safeStage === "CATALOGUE_FETCH" || safeStage === "LEAGUE_FETCH") {
    if (message === "Provider response exceeds safe byte limit.") reason = "RESPONSE_TOO_LARGE";
    else if (message === "OddsPapi HTTP failure; a quota call may have been consumed.")
      reason = "UPSTREAM_HTTP_ERROR";
    else if (message === "Provider response is not safely streamable.")
      reason = "RESPONSE_NOT_STREAMABLE";
    else if (name === "SyntaxError") reason = "RESPONSE_JSON_INVALID";
    else if (name === "AbortError" || name === "TimeoutError") reason = "UPSTREAM_TIMEOUT";
    else reason = "UPSTREAM_OTHER_FAILURE";
  } else if (safeStage === "CATALOGUE_VALIDATE") {
    if (message === "Invalid catalogue data shape.")
      reason = "CATALOGUE_FORMAT_INVALID";
    else if (message === "Global catalogue processing ceiling exceeded.")
      reason = "CATALOGUE_GLOBAL_COUNT_LIMIT";
    else if (message === "NBA catalogue subset processing ceiling exceeded.")
      reason = "CATALOGUE_NBA_SUBSET_LIMIT";
    // Historical 35.1C5 code for the old global 50k ceiling.
    else if (message === "Invalid or oversized catalogue definition count.")
      reason = "CATALOGUE_COUNT_LIMIT";
    // Preserve the historical combined reason for compatibility with old injected errors.
    else if (message === "Invalid or oversized catalogue data.")
      reason = "CATALOGUE_FORMAT_OR_COUNT_LIMIT";
    else if (message === "Official catalogue has no usable NBA full-game player-prop definitions.")
      reason = "NO_ELIGIBLE_CATALOGUE_MARKETS";
    else reason = "CATALOGUE_VALIDATION_FAILED";
  } else if (safeStage === "LEAGUE_ANALYZE") {
    if (message === "Invalid or oversized fixtures data.")
      reason = "FIXTURE_FORMAT_OR_COUNT_LIMIT";
    else if (message === "Market processing ceiling exceeded.")
      reason = "MARKET_PROCESSING_LIMIT";
    else if (message === "Selection processing ceiling exceeded.")
      reason = "SELECTION_PROCESSING_LIMIT";
    else reason = "LEAGUE_VALIDATION_FAILED";
  } else if (safeStage === "COOLDOWN") {
    reason = "COOLDOWN_FAILED";
  }
  return Object.freeze({ stage: safeStage, reason });
}

function makeLeagueMarketAuditRunner({
  ownerUid, reserve, fetchCatalogue, fetchOdds, waitBetweenRequests = async () => {},
  now = Date.now, onFailure = () => {}
}) {
  if (!ownerUid || typeof reserve !== "function" ||
      typeof fetchCatalogue !== "function" || typeof fetchOdds !== "function" ||
      typeof waitBetweenRequests !== "function" || typeof now !== "function" ||
      typeof onFailure !== "function") {
    throw new Error("Missing league market audit dependencies.");
  }
  let catalogue = null, catalogueAt = 0;
  let snapshot = null, snapshotAt = 0, inFlight = null;
  return async function run(request) {
    if (!request?.auth || request.auth.uid !== ownerUid ||
        request.auth.token?.email_verified !== true) {
      const error = new Error("Only the verified owner may run this manual audit.");
      error.code = "permission-denied";
      throw error;
    }
    if (request.data != null &&
        (typeof request.data !== "object" || Array.isArray(request.data) ||
         Object.keys(request.data).length !== 0)) {
      const error = new Error("This diagnostic accepts no parameters.");
      error.code = "invalid-argument";
      throw error;
    }
    const tick = now();
    if (snapshot && tick >= snapshotAt && tick - snapshotAt < SNAPSHOT_TTL_MS) {
      return { ...snapshot, cached: true, requestsUsedOnThisClick: 0 };
    }
    if (inFlight) {
      return inFlight.then(data => ({ ...data, cached: true, requestsUsedOnThisClick: 0 }));
    }
    const catalogueValid = catalogue !== null && tick >= catalogueAt &&
      tick - catalogueAt < CATALOGUE_TTL_MS;
    inFlight = (async () => {
      let stage = "BUDGET_RESERVE";
      try {
        // Reserve maximum potential upstream calls in existing transactional 6/day guard.
        // Reservations are not refunded if a request fails or is skipped.
        await reserve(catalogueValid ? 1 : 2);
        let definitions = catalogue;
        let used = 0;
        if (!catalogueValid) {
          stage = "CATALOGUE_FETCH";
          definitions = await fetchCatalogue();
          used++;
          stage = "CATALOGUE_VALIDATE";
          // Fail closed before a second metered request if metadata is unusable.
          const meta = auditOfficialLeagueProps(definitions, [], now());
          if (meta.totalCatalogueDefinitions === 0 || meta.eligibleCatalogueMarketIds === 0)
            throw new Error("Official catalogue has no usable NBA full-game player-prop definitions.");
          catalogue = definitions;
          catalogueAt = now();
          // Respect the provider's per-endpoint cooldown without retrying requests.
          stage = "COOLDOWN";
          await waitBetweenRequests();
        }
        stage = "LEAGUE_FETCH";
        const odds = await fetchOdds();
        used++;
        stage = "LEAGUE_ANALYZE";
        const report = auditOfficialLeagueProps(definitions, odds, now());
        const data = {
          ...report,
          diagnosticVersion: "35.1C-MANUAL",
          analysis: "READ_ONLY_PROVIDER_SNAPSHOT_NOT_BOOKMAKER_VERIFIED",
          receivedAt: new Date(now()).toISOString(),
          cached: false,
          catalogueCached: catalogueValid,
          requestsUsedOnThisClick: used
        };
        snapshot = data;
        snapshotAt = now();
        return data;
      } catch (error) {
        // Emit one minimal static category; callback errors cannot replace the
        // original exception or introduce a second upstream request.
        try { onFailure(safeAuditFailure(stage, error)); } catch (_) { /* fail closed */ }
        throw error;
      }
    })();
    try { return await inFlight; }
    finally { inFlight = null; }
  };
}

module.exports = { makeLeagueMarketAuditRunner, safeAuditFailure };
