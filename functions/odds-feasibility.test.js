"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { summariseLeagueOdds, readLimitedJson, makeFeasibilityRunner } = require("./odds-feasibility");
const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const iso = offset => new Date(NOW + offset).toISOString();
const selection = (overrides = {}) => ({
  active: true, playerName: "Synthetic Player", price: 1.88,
  changedAt: iso(-4 * 60 * 1000), mainLine: true, ...overrides
});
function game(overrides = {}) {
  return {
    fixtureId: "fake01", tournamentId: 132, sportId: 11, hasOdds: true,
    startTime: iso(6 * 3600000),
    bookmakerOdds: { "betano.pt": { bookmakerIsActive: true, suspended: false,
      markets: { "0001": { marketActive: true, outcomes: {
        "over": { players: { "101": selection() } },
        "under": { players: { "101": selection({ price: 1.93, changedAt: iso(-20 * 60 * 1000) }) } }
      } } }
    } }, ...overrides
  };
}

test("counts synthetic provider entries without treating market IDs as verified props", () => {
  const s = summariseLeagueOdds([game()], NOW);
  assert.equal(s.totalFixtures, 1);
  assert.equal(s.activeBookmakerFixtures, 1);
  assert.equal(s.activeMarkets, 1);
  assert.equal(s.activeNamedEntries, 2);
  assert.equal(s.uniqueUnverifiedNames, 1);
  assert.equal(s.mainLineEntries, 2);
  assert.equal(s.fresh15m, 1);
  assert.equal(s.older15m, 1);
  assert.deepEqual(s.verifiedMarketFamilies, []);
  assert.equal(s.mappingStatus, "NOT_VERIFIED");
  assert.deepEqual(s.unverifiedMarketIdSamples, ["0001"]);
  assert.equal(s.earliestStart, iso(6 * 3600000));
});

test("accepts empty valid array or fixture envelope", () => {
  for (const data of [[], { data: [] }, { fixtures: [] }]) {
    assert.equal(summariseLeagueOdds(data, NOW).totalFixtures, 0);
  }
  assert.throws(() => summariseLeagueOdds({ status: "failure" }, NOW), /Unexpected/);
});

test("excludes invalid team\/league, duplicate, outside-window and missing odds fixtures", () => {
  const s = summariseLeagueOdds([
    game(), game(), game({ fixtureId: "badLeague", tournamentId: 999 }),
    game({ fixtureId: "past", startTime: iso(-5000000) }),
    game({ fixtureId: "far", startTime: iso(80 * 3600000) }),
    game({ fixtureId: "none", hasOdds: false }),
    game({ fixtureId: "wrongBook", bookmakerOdds: { "betano": {} } }),
    game({ fixtureId: "suspended", bookmakerOdds: { "betano.pt": {
      bookmakerIsActive: true, suspended: true, markets: {}
    } } }),
    game({ fixtureId: "inactiveBook", bookmakerOdds: { "betano.pt": {
      bookmakerIsActive: false, suspended: false, markets: {}
    } } })
  ], NOW);
  assert.equal(s.activeNamedEntries, 2);
  assert.equal(s.exclusionCounts.duplicateFixture, 1);
  assert.equal(s.exclusionCounts.invalidFixture, 1);
  assert.equal(s.exclusionCounts.outsideWindow, 2);
  assert.equal(s.exclusionCounts.noOdds, 1);
  assert.equal(s.exclusionCounts.missingBookmaker, 1);
  assert.equal(s.exclusionCounts.suspendedBookmaker, 2);
});

test("rejects inactive, nameless, invalid priced, and invalid timestamp entries", () => {
  const entries = {
    "1": selection({ active: false }),
    "2": selection({ playerName: null }),
    "3": selection({ price: "1.99" }),
    "4": selection({ changedAt: "invalid" }),
    "5": selection({ changedAt: null }),
    "6": selection({ changedAt: iso(30 * 60 * 1000) }),
    "0": selection()
  };
  const s = summariseLeagueOdds([game({ bookmakerOdds: { "betano.pt": {
    bookmakerIsActive: true, suspended: false,
    markets: { "999": { marketActive: false, outcomes: {} }, "888": {
      marketActive: true, outcomes: { "3": { players: entries } }
    } }
  } } })], NOW);
  assert.equal(s.activeNamedEntries, 3);
  assert.equal(s.exclusionCounts.inactiveMarkets, 1);
  assert.equal(s.exclusionCounts.inactiveSelections, 1);
  assert.equal(s.exclusionCounts.missingPlayerNames, 2);
  assert.equal(s.exclusionCounts.invalidPrices, 1);
  assert.equal(s.exclusionCounts.invalidTimestamps, 2);
  assert.equal(s.missingChangedAt, 1);
  assert.equal(s.fresh15m, 0);
});

test("fails closed for excessive fixtures\/markets\/entries", () => {
  const g = game();
  assert.throws(() => summariseLeagueOdds(Array.from({ length: 251 }, (_, i) => ({
    ...g, fixtureId: String(i)
  })), NOW), /oversized/);
  const markets = Object.fromEntries(Array.from({ length: 18001 }, (_, i) => [String(i), {
    marketActive: false, outcomes: {}
  }]));
  assert.throws(() => summariseLeagueOdds([game({ bookmakerOdds: {
    "betano.pt": { bookmakerIsActive: true, suspended: false, markets }
  } })], NOW), /market response exceeds/);
  const players = Object.fromEntries(Array.from({ length: 180001 }, (_, i) => [String(i+1), { active: false }]));
  assert.throws(() => summariseLeagueOdds([game({ bookmakerOdds: {
    "betano.pt": { bookmakerIsActive: true, suspended: false,
      markets: { "0": { marketActive: true, outcomes: { "0": { players } } } } }
  } })], NOW), /selection response exceeds/);
});

test("reads stream with strict decoded byte limits and errors fail closed", async () => {
  const response = new Response(JSON.stringify([game()]));
  assert.equal((await readLimitedJson(response)).length, 1);
  await assert.rejects(readLimitedJson(new Response("{}", { status: 429 })), /HTTP failure/);
  await assert.rejects(readLimitedJson({ ok: true, headers: { get: () => "13000000" },
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([123,125])); c.close(); } })
  }), /safe byte limit/);
  await assert.rejects(readLimitedJson(new Response("not JSON")), /Unexpected token|JSON/);
  // Test large streamed body with false declared content length.
  const oversized = new ReadableStream({ start(c) {
    c.enqueue(new Uint8Array(13 * 1024 * 1024)); c.close();
  }});
  await assert.rejects(readLimitedJson({ ok: true, headers: { get: () => "10" }, body: oversized }), /safe byte limit/);
});

test("owner verification, reservation before provider, cache and concurrent clicks", async () => {
  const steps = [];
  let fetches = 0, reserves = 0;
  let resolveFetch;
  const later = new Promise(resolve => { resolveFetch = resolve; });
  const run = makeFeasibilityRunner({ ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { steps.push("reserve"); reserves += n; },
    fetchOdds: async () => { steps.push("fetch"); fetches++; return later; }
  });
  for (const auth of [null, { uid: "other", token: { email_verified: true } },
    { uid: "fake-owner", token: { email_verified: false } }]) {
    await assert.rejects(run({ auth }), { code: "permission-denied" });
  }
  const request = { auth: { uid: "fake-owner", token: { email_verified: true } } };
  const a = run(request), b = run(request);
  resolveFetch([game()]);
  const [first, concurrent] = await Promise.all([a, b]);
  assert.equal(reserves, 1);
  assert.equal(fetches, 1);
  assert.deepEqual(steps, ["reserve", "fetch"]);
  assert.equal(first.cached, false);
  assert.equal(first.requestsUsedOnThisClick, 1);
  assert.equal(concurrent.cached, true);
  assert.equal(concurrent.requestsUsedOnThisClick, 0);
  const again = await run(request);
  assert.equal(again.cached, true);
  assert.equal(again.requestsUsedOnThisClick, 0);
  assert.equal(reserves, 1);
});

test("quota failure causes zero provider calls; provider error is not retried", async () => {
  const request = { auth: { uid: "fake-owner", token: { email_verified: true } } };
  let calls = 0;
  const blocked = makeFeasibilityRunner({ ownerUid: "fake-owner",
    reserve: async () => { throw Error("quota exhausted"); },
    fetchOdds: async () => { calls++; return []; }
  });
  await assert.rejects(blocked(request), /quota exhausted/);
  assert.equal(calls, 0);
  const failed = makeFeasibilityRunner({ ownerUid: "fake-owner",
    reserve: async () => {}, fetchOdds: async () => { calls++; throw Error("provider unavailable"); }
  });
  await assert.rejects(failed(request), /provider unavailable/);
  assert.equal(calls, 1);
});
