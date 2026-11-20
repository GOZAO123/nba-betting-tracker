"use strict";

// Update 35.1D15.28 — OFFLINE, single-use server-side quote-source boundary.
// No HTTP, callable, credentials, quota reservation, Firebase or persistence.
// This adapter does NOT authenticate a real OddsPapi fetch: the future
// production backend MUST supply takeBackendOwnedSource from its existing
// verified one-time manual receipt, not from a browser or reusable cache.
const { freezeUnreviewedProviderPlayerPair } =
  require("./provider-player-quote-snapshot");

const RECEIPT_AGE_MS = 2 * 60 * 1000;
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (x, allowed) => object(x) &&
  Object.keys(x).sort().join("|") === allowed.join("|");
const id = x => (typeof x === "string" || typeof x === "number") &&
  /^[1-9][0-9]{0,15}$/.test(String(x));
const fixtureId = x => typeof x === "string" &&
  /^[A-Za-z0-9._:-]{1,120}$/.test(x);
const timestamp = x => typeof x === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;

const SELECTOR_KEYS = Object.freeze(["fixtureId","marketId","providerPlayerId"]);
const SOURCE_KEYS = Object.freeze([
  "capturedAt","catalogue","fetchedAt","leagueOdds","snapshotReference"
]);

// Only the server's dependency may return source data; request.data contains
// selectors only. The in-process one-shot gate prevents duplicate concurrent
// consumption; it does NOT prevent replay across independently created
// sessions. No returned quote is verified or eligible for betting capture.
function makeOfflineOneShotQuoteReview({
  ownerUid, takeBackendOwnedSource, now = Date.now
} = {}) {
  if (typeof ownerUid !== "string" || !ownerUid ||
      typeof takeBackendOwnedSource !== "function" || typeof now !== "function")
    throw new TypeError("Missing backend-owned quote source dependencies.");

  let consumed = false;

  const review = async request => {
    try {
      if (!object(request) || !object(request.auth) ||
          request.auth.uid !== ownerUid ||
          request.auth.token?.email_verified !== true ||
          !keys(request.data, SELECTOR_KEYS) ||
          !fixtureId(request.data.fixtureId) ||
          !id(request.data.marketId) ||
          !id(request.data.providerPlayerId)) return null;

      // Claim before asynchronous work; even failures and concurrent requests
      // cannot reuse this manual receipt or request an implicit retry.
      if (consumed) return null;
      consumed = true;

      const current = now();
      if (!Number.isSafeInteger(current) || current < 0) return null;
      const source = await takeBackendOwnedSource();
      if (!keys(source, SOURCE_KEYS) ||
          !Number.isSafeInteger(source.fetchedAt) ||
          source.fetchedAt < 0 || source.fetchedAt > current ||
          current - source.fetchedAt > RECEIPT_AGE_MS) return null;
      const captured = timestamp(source.capturedAt);
      if (!Number.isFinite(captured) || captured < source.fetchedAt ||
          captured > current ||
          captured - source.fetchedAt > RECEIPT_AGE_MS) return null;

      // Critically: no market, fixture, odds, receipt ID or timestamp is
      // copied from request.data. Only the backend source object supplies it.
      return freezeUnreviewedProviderPlayerPair({
        catalogue: source.catalogue,
        leagueOdds: source.leagueOdds,
        snapshotReference: source.snapshotReference,
        capturedAt: source.capturedAt,
        now: current,
        fixtureId: request.data.fixtureId,
        marketId: request.data.marketId,
        providerPlayerId: request.data.providerPlayerId
      });
    } catch (_) {
      // Never reflect raw provider errors, account identifiers or quote data.
      return null;
    }
  };
  return Object.freeze(review);
}

module.exports = { makeOfflineOneShotQuoteReview };
