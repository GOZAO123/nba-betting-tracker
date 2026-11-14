"use strict";

// Update 35.1C: pure OFFLINE join of independently supplied provider responses.
// No SDK, HTTP request, file I/O, Firestore operation or production callable.
// Never return prices, player names or purported verified sportsbook offers.
const FAMILIES = Object.freeze({
  "Over Under Player Points (incl. overtime)": "PTS",
  "Over Under Player Rebounds (incl. overtime)": "REB",
  "Over Under Player Assists (incl. overtime)": "AST",
  "Over Under Player 3 Point FG (incl. overtime)": "3PT",
  "Over Under Player Points + Rebounds (incl. overtime)": "PR",
  "Over Under Player Points + Assists (incl. overtime)": "PA",
  "Over Under Player Assists + Rebounds (incl. overtime)": "RA",
  "Over Under Player Points + Assists + Rebounds (incl. overtime)": "PRA"
});
const FAMILY_ORDER = Object.freeze(["PTS", "REB", "AST", "3PT", "PR", "PA", "RA", "PRA"]);
const HORIZON_MS = 72 * 60 * 60 * 1000;
const RECENT_MS = 15 * 60 * 1000;
// Bound the global provider scan independently of the exact NBA market subset.
// The decoded upstream response also remains capped at 32 MiB in index.js.
const MAX_GLOBAL_CATALOGUE = 250000;
const MAX_NBA_CATALOGUE = 50000;
const MAX_FIXTURES = 250;
const MAX_MARKETS = 18000;
const MAX_ENTRIES = 180000;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function dataArray(value, name, limit) {
  const arr = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data :
    name === "fixtures" && Array.isArray(value?.fixtures) ? value.fixtures : null;
  if (name === "catalogue") {
    // Distinguish payload shape from count without logging raw provider data.
    // Enforce the global scan ceiling before touching any individual entries.
    if (!arr) throw new Error("Invalid catalogue data shape.");
    if (arr.length > limit) throw new Error("Global catalogue processing ceiling exceeded.");
  } else if (!arr || arr.length > limit) {
    throw new Error("Invalid or oversized " + name + " data.");
  }
  return arr;
}
function identifier(value) {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^[1-9][0-9]{0,15}$/.test(text) ? text : null;
}
function officialCatalogueMap(payload) {
  const definitions = dataArray(payload, "catalogue", MAX_GLOBAL_CATALOGUE);
  // Scan global IDs (bounded above) to quarantine even cross-sport collisions.
  // Retain only the exact eligible NBA market definitions, never raw entries.
  const mapped = new Map(), seen = new Set(), ambiguous = new Set();
  let nbaDefinitions = 0;
  // Sequential, aggregate-only eligibility funnel. These are rows passing each
  // gate on first sight of an ID, before later duplicate-ID quarantine.
  const counts = {
    totalDefinitions: definitions.length,
    validIds: 0, firstSeenIds: 0, sport11: 0, propTrue: 0,
    familyExact: 0, periodAllowed: 0, halfPointLine: 0,
    overUnderPair: 0, eligibleIds: 0, duplicateIds: 0
  };
  for (const def of definitions) {
    if (!object(def)) continue;
    const id = identifier(def.marketId);
    if (!id) continue;
    counts.validIds++;
    // A duplicate ID is ambiguous even if both definitions appear identical.
    if (seen.has(id)) { ambiguous.add(id); mapped.delete(id); continue; }
    seen.add(id);
    counts.firstSeenIds++;
    if (Number(def.sportId) !== 11) continue;
    counts.sport11++;
    if (def.playerProp !== true) continue;
    counts.propTrue++;
    const family = FAMILIES[String(def.marketName || "").trim()];
    if (!family) continue;
    counts.familyExact++;
    if (def.period != null && def.period !== "fulltime") continue;
    counts.periodAllowed++;
    const line = def.handicap;
    if (typeof line !== "number" || !Number.isFinite(line) || line <= 0 ||
        line > 1000 || !Number.isInteger(line * 2) || Number.isInteger(line)) continue;
    counts.halfPointLine++;
    if (!Array.isArray(def.outcomes) || def.outcomes.length !== 2) continue;
    const sides = new Map();
    for (const outcome of def.outcomes) {
      const outcomeId = identifier(outcome?.outcomeId);
      const name = String(outcome?.outcomeName || "").trim();
      if (!outcomeId || (name !== "Over" && name !== "Under") || sides.has(outcomeId)) break;
      sides.set(outcomeId, name);
    }
    if (sides.size !== 2 || new Set(sides.values()).size !== 2) continue;
    counts.overUnderPair++;
    // This is the protected 50,000-entry NBA subset limit, NOT a global cap.
    if (++nbaDefinitions > MAX_NBA_CATALOGUE)
      throw new Error("NBA catalogue subset processing ceiling exceeded.");
    mapped.set(id, { family, outcomeSides: sides });
  }
  // Final eligible count includes late duplicate-ID quarantine, unlike earlier
  // funnel stages. No market IDs, names, outcome IDs, prices or players are kept.
  counts.eligibleIds = mapped.size;
  counts.duplicateIds = ambiguous.size;
  return { mapped, seen, ambiguous, definitions: definitions.length,
    catalogueEligibility: Object.freeze(counts) };
}
function parseProviderTimestamp(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  return Date.parse(value);
}

function auditOfficialLeagueProps(catalogue, leagueOdds, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Invalid snapshot time.");
  const { mapped, ambiguous, definitions, catalogueEligibility } = officialCatalogueMap(catalogue);
  const fixtures = dataArray(leagueOdds, "fixtures", MAX_FIXTURES);
  const families = FAMILY_ORDER.map(family => ({
    family, marketObjects: 0, activePriceEntries: 0, fresh15m: 0,
    older15m: 0, missingOrInvalidTimestamp: 0, mainLineFlagged: 0
  }));
  const byFamily = new Map(families.map(item => [item.family, item]));
  const result = {
    diagnosticVersion: "35.1C-OFFLINE-ONLY", analysis: "SYNTHETIC_OR_EXTERNALLY_SUPPLIED_INPUT",
    totalCatalogueDefinitions: definitions, eligibleCatalogueMarketIds: mapped.size,
    ambiguousCatalogueMarketIds: ambiguous.size, catalogueEligibility,
    totalFixtures: fixtures.length, eligibleFixtures: 0, activeBookmakerFixtures: 0,
    activeMarketObjects: 0, matchedMarketObjects: 0,
    distinctUnmappedMarketIds: 0, activePriceEntries: 0,
    fresh15m: 0, older15m: 0, missingOrInvalidTimestamp: 0,
    mainLineFlagged: 0, families,
    marketMapping: "CATALOGUE_MATCH_ONLY", playerIdentity: "NOT_ESPN_VERIFIED",
    pricesBookmakerVerified: false, researchSaved: false,
    note: "A matching official catalogue ID is not proof of a current Betano Portugal offer, player identity, bookmaker accuracy or model value. No player names, prices, or raw provider records are returned."
  };
  const seenFixtures = new Set(), unmapped = new Set();
  let marketsSeen = 0, entriesSeen = 0;
  for (const fixture of fixtures) {
    if (!object(fixture) || typeof fixture.fixtureId !== "string" || !fixture.fixtureId ||
        (fixture.tournamentId != null && Number(fixture.tournamentId) !== 132) ||
        (fixture.sportId != null && Number(fixture.sportId) !== 11) ||
        seenFixtures.has(fixture.fixtureId)) continue;
    seenFixtures.add(fixture.fixtureId);
    const start = parseProviderTimestamp(fixture.startTime);
    if (!Number.isFinite(start) || start <= now + 5 * 60000 ||
        start > now + HORIZON_MS || fixture.hasOdds !== true) continue;
    result.eligibleFixtures++;
    const book = fixture.bookmakerOdds?.["betano.pt"];
    if (!object(book) || book.bookmakerIsActive !== true || book.suspended === true ||
        !object(book.markets)) continue;
    result.activeBookmakerFixtures++;
    for (const [rawId, market] of Object.entries(book.markets)) {
      if (++marketsSeen > MAX_MARKETS) throw new Error("Market processing ceiling exceeded.");
      if (!object(market) || market.marketActive !== true) continue;
      result.activeMarketObjects++;
      const marketId = identifier(rawId);
      const meta = marketId && mapped.get(marketId);
      if (!meta) { if (marketId) unmapped.add(marketId); continue; }
      result.matchedMarketObjects++;
      const bucket = byFamily.get(meta.family);
      bucket.marketObjects++;
      if (!object(market.outcomes)) continue;
      for (const [outcomeId, outcome] of Object.entries(market.outcomes)) {
        if (!meta.outcomeSides.has(outcomeId) || !object(outcome?.players)) continue;
        for (const [playerId, entry] of Object.entries(outcome.players)) {
          if (++entriesSeen > MAX_ENTRIES) throw new Error("Selection processing ceiling exceeded.");
          if (!identifier(playerId) || !object(entry) || entry.active !== true ||
              typeof entry.playerName !== "string" || !entry.playerName.trim() ||
              entry.playerName.length > 100 || typeof entry.price !== "number" ||
              !Number.isFinite(entry.price) || entry.price <= 1 || entry.price > 1000) continue;
          result.activePriceEntries++; bucket.activePriceEntries++;
          if (entry.mainLine === true) { result.mainLineFlagged++; bucket.mainLineFlagged++; }
          const changed = parseProviderTimestamp(entry.changedAt);
          const metric = !Number.isFinite(changed) || changed > now + 2 * 60000
            ? "missingOrInvalidTimestamp" : now - changed <= RECENT_MS ? "fresh15m" : "older15m";
          result[metric]++; bucket[metric]++;
        }
      }
    }
  }
  result.distinctUnmappedMarketIds = unmapped.size;
  return result;
}

module.exports = { auditOfficialLeagueProps };
