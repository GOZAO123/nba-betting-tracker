"use strict";

// Update 35.1B — pure, bounded diagnostic. Never persists or exposes raw odds.
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_FIXTURES = 250;
const MAX_MARKETS = 18000;
const MAX_ENTRIES = 180000;
const WINDOW_MS = 72 * 60 * 60 * 1000;
const FRESH_MS = 15 * 60 * 1000;
const CACHE_MS = 15 * 60 * 1000;

function recordObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fixtureArray(payload) {
  const fixtures = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.fixtures) ? payload.fixtures : null;
  if (!fixtures || fixtures.length > MAX_FIXTURES) {
    throw new Error("Unexpected or oversized NBA league fixture response.");
  }
  return fixtures;
}

function summariseLeagueOdds(payload, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Invalid snapshot time.");
  const fixtures = fixtureArray(payload);
  const counts = {
    outsideWindow: 0, invalidFixture: 0, duplicateFixture: 0,
    noOdds: 0, missingBookmaker: 0, suspendedBookmaker: 0,
    inactiveMarkets: 0, inactiveSelections: 0, missingPlayerNames: 0,
    invalidPrices: 0, invalidTimestamps: 0
  };
  const uniqueFixtures = new Set(), namedPlayers = new Set(), activeIds = new Set();
  const result = {
    status: "ok", diagnosticVersion: "35.1B", source: "OddsPapi v4 league odds",
    tournamentId: 132, bookmaker: "betano.pt", horizonHours: 72,
    receivedAt: new Date(now).toISOString(), totalFixtures: fixtures.length,
    upcomingWithinWindow: 0, fixturesWithOdds: 0, activeBookmakerFixtures: 0,
    activeMarkets: 0, distinctMarketIds: 0, activeNamedEntries: 0,
    uniqueUnverifiedNames: 0, mainLineEntries: 0,
    fresh15m: 0, older15m: 0, missingChangedAt: 0,
    earliestStart: null, latestStart: null,
    unverifiedMarketIdSamples: [], exclusionCounts: counts,
    verifiedMarketFamilies: [], mappingStatus: "NOT_VERIFIED",
    requestsUsedOnThisClick: 1, cached: false,
    note: "Market IDs, player identities, Betano Portugal price accuracy and all eight prop families are NOT verified. These are untrusted provider data counts, not bookmaker-verified offers or research records. Nothing was saved."
  };
  let marketVisits = 0, entryVisits = 0;
  let earliest = Infinity, latest = -Infinity;
  for (const fixture of fixtures) {
    if (!recordObject(fixture) || !fixture.fixtureId ||
        (fixture.tournamentId != null && Number(fixture.tournamentId) !== 132) ||
        (fixture.sportId != null && Number(fixture.sportId) !== 11)) {
      counts.invalidFixture++; continue;
    }
    const fid = String(fixture.fixtureId);
    if (uniqueFixtures.has(fid)) { counts.duplicateFixture++; continue; }
    uniqueFixtures.add(fid);
    const start = Date.parse(fixture.startTime);
    if (!Number.isFinite(start) || start <= now + 5 * 60000 || start > now + WINDOW_MS) {
      counts.outsideWindow++; continue;
    }
    result.upcomingWithinWindow++;
    earliest = Math.min(earliest, start);
    latest = Math.max(latest, start);
    if (fixture.hasOdds !== true) { counts.noOdds++; continue; }
    result.fixturesWithOdds++;
    const book = fixture.bookmakerOdds?.["betano.pt"];
    if (!recordObject(book)) { counts.missingBookmaker++; continue; }
    if (book.suspended === true || book.bookmakerIsActive !== true) {
      counts.suspendedBookmaker++; continue;
    }
    result.activeBookmakerFixtures++;
    if (!recordObject(book.markets)) continue;
    for (const [marketId, market] of Object.entries(book.markets)) {
      if (++marketVisits > MAX_MARKETS) throw new Error("NBA market response exceeds safe processing limit.");
      if (!recordObject(market) || market.marketActive !== true) {
        counts.inactiveMarkets++; continue;
      }
      result.activeMarkets++;
      activeIds.add(String(marketId).slice(0, 36));
      if (!recordObject(market.outcomes)) continue;
      for (const outcome of Object.values(market.outcomes)) {
        if (!recordObject(outcome) || !recordObject(outcome.players)) continue;
        for (const [playerId, entry] of Object.entries(outcome.players)) {
          if (++entryVisits > MAX_ENTRIES) throw new Error("NBA selection response exceeds safe processing limit.");
          if (!recordObject(entry) || entry.active !== true) { counts.inactiveSelections++; continue; }
          const name = typeof entry.playerName === "string" ? entry.playerName.trim() : "";
          if (!name || name.length > 100 || playerId === "0") {
            counts.missingPlayerNames++; continue;
          }
          if (typeof entry.price !== "number" || !Number.isFinite(entry.price) ||
              entry.price <= 1 || entry.price > 1000) {
            counts.invalidPrices++; continue;
          }
          result.activeNamedEntries++;
          if (entry.mainLine === true) result.mainLineEntries++;
          namedPlayers.add(name.toLocaleLowerCase("en-US"));
          if (!entry.changedAt) result.missingChangedAt++;
          else {
            const changed = typeof entry.changedAt === "string" ? Date.parse(entry.changedAt) : NaN;
            if (!Number.isFinite(changed) || changed > now + 2 * 60000) counts.invalidTimestamps++;
            else if (now - changed <= FRESH_MS) result.fresh15m++;
            else result.older15m++;
          }
        }
      }
    }
  }
  result.distinctMarketIds = activeIds.size;
  result.uniqueUnverifiedNames = namedPlayers.size;
  result.unverifiedMarketIdSamples = [...activeIds].sort().slice(0, 8);
  if (earliest !== Infinity) {
    result.earliestStart = new Date(earliest).toISOString();
    result.latestStart = new Date(latest).toISOString();
  }
  return result;
}

// Fully bound the *decoded* response body, regardless of Content-Length header.
async function readLimitedJson(response) {
  if (!response?.ok) throw new Error("OddsPapi HTTP failure; a quota call may have been consumed.");
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new Error("Provider response is not safely streamable.");
  }
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body.cancel?.();
    throw new Error("Provider response exceeds safe byte limit.");
  }
  const reader = response.body.getReader();
  let bytes = 0, raw = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Provider response exceeds safe byte limit.");
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    return JSON.parse(raw);
  } finally {
    if (bytes > MAX_RESPONSE_BYTES) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Injected dependencies enable offline tests of authentication, quota, and
// single-flight behaviour without importing Firebase or contacting OddsPapi.
function makeFeasibilityRunner({ ownerUid, reserve, fetchOdds, now = Date.now }) {
  if (!ownerUid || typeof reserve !== "function" || typeof fetchOdds !== "function") {
    throw new Error("Missing feasibility security dependencies.");
  }
  let cached = null, cachedAt = 0, pending = null;
  return async function check(request) {
    if (!request?.auth || request.auth.uid !== ownerUid || request.auth.token?.email_verified !== true) {
      const error = new Error("Only the verified owner can run the OddsPapi diagnostic.");
      error.code = "permission-denied";
      throw error;
    }
    const tick = now();
    if (cached && tick - cachedAt >= 0 && tick - cachedAt < CACHE_MS) {
      return { ...cached, cached: true, requestsUsedOnThisClick: 0 };
    }
    if (pending) {
      return pending.then(result => ({ ...result, cached: true, requestsUsedOnThisClick: 0 }));
    }
    pending = (async () => {
      // This is the only allowed provider call; reserve first and never retry.
      await reserve(1);
      const payload = await fetchOdds();
      const result = summariseLeagueOdds(payload, now());
      cached = result;
      cachedAt = now();
      return result;
    })();
    try { return await pending; }
    finally { pending = null; }
  };
}

module.exports = { summariseLeagueOdds, readLimitedJson, makeFeasibilityRunner };
