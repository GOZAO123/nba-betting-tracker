"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { auditOfficialLeagueProps } = require("./league-market-audit");

const NOW = Date.parse("2026-11-13T11:29:00.000Z");
const iso = minutes => new Date(NOW + minutes * 60000).toISOString();
const NAMES = [
  "Over Under Player Points (incl. overtime)",
  "Over Under Player Rebounds (incl. overtime)",
  "Over Under Player Assists (incl. overtime)",
  "Over Under Player 3 Point FG (incl. overtime)",
  "Over Under Player Points + Rebounds (incl. overtime)",
  "Over Under Player Points + Assists (incl. overtime)",
  "Over Under Player Assists + Rebounds (incl. overtime)",
  "Over Under Player Points + Assists + Rebounds (incl. overtime)"
];
const definitions = () => NAMES.map((marketName, i) => ({
  marketId: 110000 + i, marketName, sportId: 11, playerProp: true,
  period: "fulltime", handicap: 20.5 + i,
  outcomes: [
    { outcomeId: 120000 + i * 2, outcomeName: "Over" },
    { outcomeId: 120001 + i * 2, outcomeName: "Under" }
  ]
}));
const player = (overrides = {}) => ({
  active: true, playerName: "Synthetic Athlete", price: 1.84,
  changedAt: iso(-4), mainLine: false, ...overrides
});
const market = (i, overrides = {}) => ({
  marketActive: true,
  outcomes: {
    [String(120000 + i * 2)]: { players: { "20001": player() } },
    [String(120001 + i * 2)]: { players: { "20001": player({ price: 1.91, changedAt: iso(-21) }) } }
  }, ...overrides
});
function fixture(markets, overrides = {}) {
  return {
    fixtureId: "f01", tournamentId: 132, sportId: 11, hasOdds: true,
    startTime: iso(360), bookmakerOdds: {
      "betano.pt": { bookmakerIsActive: true, suspended: false, markets }
    }, ...overrides
  };
}

test("maps all eight official full-game overtime families with exact market and outcome IDs", () => {
  const markets = Object.fromEntries(definitions().map((def, i) => [String(def.marketId), market(i)]));
  const report = auditOfficialLeagueProps({ data: definitions() }, { fixtures: [fixture(markets)] }, NOW);
  assert.deepEqual(report.families.map(x => x.family), ["PTS", "REB", "AST", "3PT", "PR", "PA", "RA", "PRA"]);
  assert.equal(report.eligibleCatalogueMarketIds, 8);
  assert.equal(report.eligibleFixtures, 1);
  assert.equal(report.matchedMarketObjects, 8);
  assert.equal(report.activePriceEntries, 16);
  assert.equal(report.fresh15m, 8);
  assert.equal(report.older15m, 8);
  assert.ok(report.families.every(x => x.marketObjects === 1 && x.activePriceEntries === 2));
  assert.equal(report.marketMapping, "CATALOGUE_MATCH_ONLY");
  assert.equal(report.playerIdentity, "NOT_ESPN_VERIFIED");
  assert.equal(report.pricesBookmakerVerified, false);
  assert.equal(report.researchSaved, false);
  const encoded = JSON.stringify(report);
  assert.ok(!encoded.includes("Synthetic Athlete"));
  assert.ok(!encoded.includes('"price"'));
  assert.ok(!encoded.includes('"odds"'));
});

test("fails closed on incorrect sport, wrong period, unsupported names, handicap and ambiguous IDs", () => {
  const d = definitions();
  d[1].sportId = 10;
  d[2].playerProp = false;
  d[3].period = "firsthalf";
  d[4].marketName = "Player Points First Quarter";
  d[5].handicap = 12;
  d[6].outcomes = [ { outcomeId: 120012, outcomeName: "Over" }, { outcomeId: 120013, outcomeName: "Over" } ];
  d.push({ ...d[0] }); // Duplicate official market ID is quarantined.
  const markets = Object.fromEntries(definitions().map((def,i) => [String(def.marketId),market(i)]));
  const x = auditOfficialLeagueProps(d, [fixture(markets)], NOW);
  assert.equal(x.eligibleCatalogueMarketIds, 1);
  assert.equal(x.ambiguousCatalogueMarketIds, 1);
  assert.equal(x.activePriceEntries, 2);
  assert.equal(x.families.find(p => p.family === "PRA").activePriceEntries, 2);
  assert.equal(x.distinctUnmappedMarketIds, 7);
});

test("requires exact outcomes, true active flags, named player, finite decimal prices and non-zero player ID", () => {
  const d = definitions().slice(0, 1);
  const players = {
    "0": player(), "20001": player(), "20002": player({ active: false }),
    "20003": player({ playerName: "" }), "20004": player({ price: "1.88" }),
    "20005": player({ price: 1 }), "20006": player({ changedAt: "bad" }),
    "20007": player({ changedAt: iso(3), mainLine: true }),
    "20008": player({ changedAt: iso(-15), mainLine: true }),
    "20009": player({ changedAt: iso(-16) }),
    "20010": player({ changedAt: null })
  };
  const m = { "110000": { marketActive: true, outcomes: {
    "120000": { players }, "999999": { players: { "20001": player() } }
  } }, "999999": { marketActive: true, outcomes: {} }, "888888": { marketActive: false, outcomes: {} } };
  const x = auditOfficialLeagueProps(d, [fixture(m)], NOW);
  assert.equal(x.activePriceEntries, 6);
  assert.equal(x.fresh15m, 2);
  assert.equal(x.older15m, 1);
  assert.equal(x.missingOrInvalidTimestamp, 3);
  assert.equal(x.mainLineFlagged, 2);
  assert.equal(x.distinctUnmappedMarketIds, 1);
});

test("excludes wrong league, past/far events, suspended/non-exact bookmaker and duplicates", () => {
  const m = { "110000": market(0) };
  const valid = fixture(m);
  const x = auditOfficialLeagueProps(definitions(), [
    valid, valid, fixture(m, { fixtureId: "f02", sportId: 10 }),
    fixture(m, { fixtureId: "f03", tournamentId: 99 }),
    fixture(m, { fixtureId: "f04", startTime: iso(-100) }),
    fixture(m, { fixtureId: "f05", startTime: iso(73 * 60) }),
    fixture(m, { fixtureId: "f06", hasOdds: false }),
    fixture(m, { fixtureId: "f07", bookmakerOdds: { betano: valid.bookmakerOdds["betano.pt"] } }),
    fixture(m, { fixtureId: "f08", bookmakerOdds: { "betano.pt": { ...valid.bookmakerOdds["betano.pt"], suspended: true } } }),
    fixture(m, { fixtureId: "f09", bookmakerOdds: { "betano.pt": { ...valid.bookmakerOdds["betano.pt"], bookmakerIsActive: false } } })
  ], NOW);
  assert.equal(x.totalFixtures, 10);
  assert.equal(x.eligibleFixtures, 4); // valid, wrong book, suspended book, inactive book
  assert.equal(x.activeBookmakerFixtures, 1);
  assert.equal(x.activePriceEntries, 2);
});

test("counts fixture-specific market objects and does not conflate identities across games", () => {
  const same = { "110000": market(0) };
  const x = auditOfficialLeagueProps(definitions(), [
    fixture(same), fixture(same, { fixtureId: "f02" })
  ], NOW);
  assert.equal(x.activeBookmakerFixtures, 2);
  assert.equal(x.matchedMarketObjects, 2);
  assert.equal(x.activePriceEntries, 4);
  assert.equal(x.families[0].marketObjects, 2);
});

test("rejects incomplete and oversized data rather than returning partial claims", () => {
  assert.throws(() => auditOfficialLeagueProps({}, [], NOW), /Invalid catalogue data shape/);
  assert.throws(() => auditOfficialLeagueProps({ data: {} }, [], NOW), /Invalid catalogue data shape/);
  assert.throws(() => auditOfficialLeagueProps([], { no: "fixtures" }, NOW), /fixtures/);
  assert.throws(() => auditOfficialLeagueProps([], [], NaN), /snapshot/);
  assert.throws(() => auditOfficialLeagueProps(Array(250001).fill(null), [], NOW), /Global catalogue processing ceiling/);
  assert.throws(() => auditOfficialLeagueProps([], Array(251).fill(null), NOW), /oversized fixtures/);
  const giantMarkets = Object.fromEntries(Array.from({ length: 18001 }, (_, i) => [String(i + 1), { marketActive: false }]));
  assert.throws(() => auditOfficialLeagueProps(definitions(), [fixture(giantMarkets)], NOW), /Market processing ceiling/);
  const huge = Object.fromEntries(Array.from({ length: 180001 }, (_, i) => [String(i + 1), { active: false }]));
  const tooMany = { "110000": { marketActive: true, outcomes: { "120000": { players: huge } } } };
  assert.throws(() => auditOfficialLeagueProps(definitions(), [fixture(tooMany)], NOW), /Selection processing ceiling/);
});

test("global catalogue over 50k retains only exact NBA markets and quarantines cross-sport duplicates", () => {
  const all = definitions();
  const unrelated = Array.from({ length: 75000 }, (_, i) => ({
    marketId: 900000 + i, sportId: 99, playerProp: false
  }));
  // Even an ineligible foreign-sport duplicate must invalidate the NBA market ID.
  unrelated.push({ marketId: all[0].marketId, sportId: 99, playerProp: false });
  const oddsMarkets = Object.fromEntries(all.map((def, i) => [String(def.marketId), market(i)]));
  const result = auditOfficialLeagueProps({ data: [...unrelated, ...all] },
    [fixture(oddsMarkets)], NOW);
  assert.equal(result.totalCatalogueDefinitions, 75009);
  assert.equal(result.eligibleCatalogueMarketIds, 7);
  assert.equal(result.ambiguousCatalogueMarketIds, 1);
  assert.equal(result.matchedMarketObjects, 7);
  assert.equal(result.activePriceEntries, 14);
  assert.equal(result.distinctUnmappedMarketIds, 1);
});

test("global and NBA-only catalogue processing limits stay separately bounded", () => {
  const atGlobalLimit = auditOfficialLeagueProps({ data: new Array(250000).fill(null) }, [], NOW);
  assert.equal(atGlobalLimit.totalCatalogueDefinitions, 250000);
  assert.equal(atGlobalLimit.eligibleCatalogueMarketIds, 0);
  assert.throws(
    () => auditOfficialLeagueProps({ data: new Array(250001).fill(null) }, [], NOW),
    /Global catalogue processing ceiling exceeded/
  );
  const example = definitions()[0];
  const nba = Array.from({ length: 50000 }, (_, i) => ({ ...example, marketId: 700000 + i }));
  const atNbaLimit = auditOfficialLeagueProps(nba, [], NOW);
  assert.equal(atNbaLimit.totalCatalogueDefinitions, 50000);
  assert.equal(atNbaLimit.eligibleCatalogueMarketIds, 50000);
  assert.throws(
    () => auditOfficialLeagueProps([...nba, { ...example, marketId: 750000 }], [], NOW),
    /NBA catalogue subset processing ceiling exceeded/
  );
});

test("aggregate eligibility funnel identifies the first failed gate and late duplicate quarantine", () => {
  const good = definitions()[0];
  const rows = [
    { ...good, marketId: "invalid-id-not-for-logs" },
    { ...good, marketId: 400001, sportId: 10 },
    { ...good, marketId: 400002, playerProp: false },
    { ...good, marketId: 400003, marketName: "private unsupported market title" },
    { ...good, marketId: 400004, period: "firsthalf" },
    { ...good, marketId: 400005, handicap: 20 },
    { ...good, marketId: 400006, outcomes: [] },
    { ...good, marketId: 400007 },
    // A later unrelated-sport definition quarantines the previously valid ID.
    { ...good, marketId: 400007, sportId: 99 }
  ];
  const report = auditOfficialLeagueProps({ data: rows }, [], NOW);
  assert.deepEqual(report.catalogueEligibility, {
    totalDefinitions: 9, validIds: 8, firstSeenIds: 7,
    sport11: 6, propTrue: 5, familyExact: 4,
    periodAllowed: 3, halfPointLine: 2, overUnderPair: 1,
    eligibleIds: 0, duplicateIds: 1
  });
  assert.equal(report.eligibleCatalogueMarketIds, 0);
  assert.equal(report.ambiguousCatalogueMarketIds, 1);
  assert.ok(Object.isFrozen(report.catalogueEligibility));
  assert.doesNotMatch(JSON.stringify(report.catalogueEligibility),
    /invalid-id|400007|private unsupported|marketName|handicap|outcomeId|price/i);
});

test("timestamps require timezone and provider main-line flags are not inferred", () => {
  const x = auditOfficialLeagueProps(definitions(), [fixture({ "110000": {
    marketActive: true, outcomes: { "120000": { players: {
      "20001": player({ mainLine: undefined, changedAt: "2026-11-13T11:20:00" }),
      "20002": player({ mainLine: false, changedAt: iso(-12) })
    } } }
  } })], NOW);
  assert.equal(x.activePriceEntries, 2);
  assert.equal(x.mainLineFlagged, 0);
  assert.equal(x.missingOrInvalidTimestamp, 1);
  assert.equal(x.fresh15m, 1);
});
