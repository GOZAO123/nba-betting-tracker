"use strict";

// Manual-only audit orchestration; all effects are injected and tested offline.
// No Firebase, credentials, HTTP, timers or scheduled work is performed here.
const { auditOfficialLeagueProps } = require("./league-market-audit");
const CATALOGUE_TTL_MS = 12 * 60 * 60 * 1000;
const SNAPSHOT_TTL_MS = 15 * 60 * 1000;

function makeLeagueMarketAuditRunner({
  ownerUid, reserve, fetchCatalogue, fetchOdds, waitBetweenRequests = async () => {},
  now = Date.now
}) {
  if (!ownerUid || typeof reserve !== "function" ||
      typeof fetchCatalogue !== "function" || typeof fetchOdds !== "function" ||
      typeof waitBetweenRequests !== "function" || typeof now !== "function") {
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
      // Reserve maximum potential upstream calls in existing transactional 6/day guard.
      // Reservations are not refunded if a request fails or is skipped.
      await reserve(catalogueValid ? 1 : 2);
      let definitions = catalogue;
      let used = 0;
      if (!catalogueValid) {
        definitions = await fetchCatalogue();
        used++;
        // Fail closed before a second metered request if metadata is unusable.
        const meta = auditOfficialLeagueProps(definitions, [], now());
        if (meta.totalCatalogueDefinitions === 0 || meta.eligibleCatalogueMarketIds === 0)
          throw new Error("Official catalogue has no usable NBA full-game player-prop definitions.");
        catalogue = definitions;
        catalogueAt = now();
        // Respect the provider's per-endpoint cooldown without retrying requests.
        await waitBetweenRequests();
      }
      const odds = await fetchOdds();
      used++;
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
    })();
    try { return await inFlight; }
    finally { inFlight = null; }
  };
}

module.exports = { makeLeagueMarketAuditRunner };
