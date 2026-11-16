"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeLeagueMarketAuditRunner, safeAuditFailure } = require("./league-market-audit-runner");
const NOW = Date.parse("2026-11-13T11:29:00.000Z");
const iso = minutes => new Date(NOW + minutes * 60000).toISOString();
const CATALOGUE = [{
  marketId: 101, sportId: 11, playerProp: true,
  marketName: "Over Under Player Points (incl. overtime)",
  period: "result", handicap: 20.5,
  outcomes: [{ outcomeId: 201, outcomeName: "Over" }, { outcomeId: 202, outcomeName: "Under" }]
}];
const ODDS = [{
  fixtureId: "synthetic1", tournamentId: 132, sportId: 11, hasOdds: true,
  startTime: iso(140), bookmakerOdds: { "betano.pt": {
    bookmakerIsActive: true, suspended: false,
    markets: { "101": { marketActive: true, outcomes: {
      "201": { players: { "301": {
        playerName: "Synthetic Player", price: 1.87, active: true, changedAt: iso(-3)
      } } }
    } } }
  } }
}];
const owner = { auth: { uid: "fake-owner", token: { email_verified: true } }, data: {} };
const FAMILIES = ["PTS", "REB", "AST", "3PT", "PR", "PA", "RA", "PRA"];
const emptyFamilyCounts = () => Object.fromEntries(FAMILIES.map(family => [family, {
  definitions: 0, missingOrNull: 0, exactFulltime: 0, exactResult: 0,
  knownPartial: 0, otherString: 0, nonString: 0,
  halfPointLineIndependent: 0, overUnderPairIndependent: 0,
  lineAndPairIndependent: 0, resultLineAndPairIndependent: 0
}]));
function setup(opts = {}) {
  let ticks = NOW, requests = 0, reserved = 0, catalogues = 0, odds = 0, waits = 0;
  const events = [];
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => ticks,
    reserve: async n => { events.push("reserve:" + n); reserved += n; if (opts.rejectReservation) throw Error("limit"); },
    fetchCatalogue: async () => { events.push("catalogue"); requests++; catalogues++; return opts.catalogue ?? CATALOGUE; },
    waitBetweenRequests: async () => { events.push("wait"); waits++; },
    fetchOdds: async () => { events.push("odds"); requests++; odds++; if (opts.rejectOdds) throw Error("provider failure"); return opts.odds ?? ODDS; }
  });
  return { run, advance: n => { ticks += n; }, events,
    metrics: () => ({ requests, reserved, catalogues, odds, waits }) };
}

test("fresh manual invocation reserves two before requests and returns aggregate only", async () => {
  const s = setup(), r = await s.run(owner);
  assert.deepEqual(s.events, ["reserve:2", "catalogue", "wait", "odds"]);
  assert.equal(r.requestsUsedOnThisClick, 2);
  assert.equal(r.cached, false);
  assert.equal(r.catalogueCached, false);
  assert.equal(r.activePriceEntries, 1);
  assert.equal(r.families.find(x => x.family === "PTS").fresh15m, 1);
  assert.equal(r.playerIdentity, "NOT_ESPN_VERIFIED");
  assert.equal(r.pricesBookmakerVerified, false);
  assert.equal(r.researchSaved, false);
  assert.ok(!JSON.stringify(r).includes("Synthetic Player"));
  assert.ok(!JSON.stringify(r).includes("1.87"));
  assert.equal(r.diagnosticVersion, "35.1C-MANUAL");
});

test("15-minute snapshot re-use is zero-call; stale snapshot reuses 12h catalogue for one request", async () => {
  const s = setup();
  await s.run(owner);
  s.advance(8 * 60000);
  const cached = await s.run(owner);
  assert.equal(cached.cached, true);
  assert.equal(cached.requestsUsedOnThisClick, 0);
  s.advance(8 * 60000);
  const refreshed = await s.run(owner);
  assert.equal(refreshed.catalogueCached, true);
  assert.equal(refreshed.requestsUsedOnThisClick, 1);
  assert.deepEqual(s.events, ["reserve:2", "catalogue", "wait", "odds", "reserve:1", "odds"]);
  assert.deepEqual(s.metrics(), { requests: 3, reserved: 3, catalogues: 1, odds: 2, waits: 1 });
});

test("the catalogue TTL causes two fresh calls again after expiry", async () => {
  const s = setup();
  await s.run(owner);
  s.advance(12 * 3600000 + 1);
  const r = await s.run(owner);
  assert.equal(r.catalogueCached, false);
  assert.equal(r.requestsUsedOnThisClick, 2);
  assert.equal(s.metrics().catalogues, 2);
  assert.equal(s.metrics().reserved, 4);
});

test("rejects unauthorized/anonymous/unverified and data overrides before any reserve", async () => {
  const s = setup();
  for (const request of [null, {}, { auth: { uid: "fake-owner" } },
    { auth: { uid: "other", token: { email_verified: true } }, data: {} },
    { auth: { uid: "fake-owner", token: { email_verified: false } }, data: {} }]) {
    await assert.rejects(s.run(request), /verified owner/);
  }
  await assert.rejects(s.run({ ...owner, data: { force: true } }), /no parameters/);
  await assert.rejects(s.run({ ...owner, data: [] }), /no parameters/);
  assert.deepEqual(s.metrics(), { requests: 0, reserved: 0, catalogues: 0, odds: 0, waits: 0 });
});

test("reservation failure fails closed and never calls provider", async () => {
  const s = setup({ rejectReservation: true });
  await assert.rejects(s.run(owner), /limit/);
  assert.deepEqual(s.events, ["reserve:2"]);
  assert.equal(s.metrics().requests, 0);
});

test("unusable catalogue avoids second provider call and no report is cached", async () => {
  const s = setup({ catalogue: [] });
  await assert.rejects(s.run(owner), /no usable/);
  assert.deepEqual(s.events, ["reserve:2", "catalogue"]);
  assert.equal(s.metrics().odds, 0);
  assert.equal(s.metrics().reserved, 2);
});

test("no retries after upstream error; catalogue is retained and next manual attempt needs one reservation", async () => {
  let fail = true, reserveCount = 0, catalogueCount = 0, oddsCount = 0;
  const run = makeLeagueMarketAuditRunner({ ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserveCount += n; },
    fetchCatalogue: async () => { catalogueCount++; return CATALOGUE; },
    fetchOdds: async () => { oddsCount++; if (fail) throw Error("no service"); return ODDS; }
  });
  await assert.rejects(run(owner), /no service/);
  assert.equal(oddsCount, 1);
  fail = false;
  const good = await run(owner);
  assert.equal(good.requestsUsedOnThisClick, 1);
  assert.equal(reserveCount, 3);
  assert.equal(catalogueCount, 1);
  assert.equal(oddsCount, 2);
});

test("concurrent clicks share one flight even with two upstream requests", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let reserves = 0, catalogueCount = 0, oddsCount = 0;
  const run = makeLeagueMarketAuditRunner({ ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserves += n; },
    fetchCatalogue: async () => { catalogueCount++; await blocked; return CATALOGUE; },
    fetchOdds: async () => { oddsCount++; return ODDS; }
  });
  const a = run(owner), b = run(owner);
  release();
  const [first, second] = await Promise.all([a,b]);
  assert.equal(first.requestsUsedOnThisClick, 2);
  assert.equal(second.requestsUsedOnThisClick, 0);
  assert.equal(second.cached, true);
  assert.equal(reserves, 2);
  assert.equal(catalogueCount, 1);
  assert.equal(oddsCount, 1);
});

test("bad fixture payload rejects safely and does not poison 15-minute cache", async () => {
  const s = setup({ odds: {} });
  await assert.rejects(s.run(owner), /fixtures/);
  assert.equal(s.metrics().reserved, 2);
  await assert.rejects(s.run(owner), /fixtures/);
  assert.equal(s.metrics().reserved, 3); // Catalogue was valid, second run costs one slot.
});

test("production wiring remains a named owner-only callable with two fixed endpoints", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const start = src.indexOf("// Update 35.1C2 — deliberately manual");
  const end = src.indexOf("function ledgerAssertOwner(request)", start);
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.match(block, /exports\.oddsPapiNbaMarketAudit = onCall/);
  assert.match(block, /ownerUid: LEDGER_OWNER/);
  assert.match(block, /reserve: reserveDiagnosticRequests/);
  assert.match(block, /maxInstances: 1, concurrency: 1/);
  assert.match(block, /request\.auth\.token\?\.email_verified !== true/);
  assert.match(block, /\/v4\/markets/);
  assert.match(block, /\/v4\/odds-by-tournaments/);
  assert.match(block, /bookmaker: "betano.pt"/);
  assert.match(block, /readLimitedJson\(response\)/);
  assert.doesNotMatch(block, /setInterval|onSchedule|setDoc|updateDoc|addDoc|ledgerCaptureProspective/);
  assert.equal((block.match(/await fetch\(/g)||[]).length, 1);
});

test("diagnostic failure reports only fixed stages and codes, never provider text", () => {
  const sensitive = "raw-api-key-player-quoted-odds-account-user-id";
  const examples = [
    ["BUDGET_RESERVE", Object.assign(Error(sensitive), { code: "resource-exhausted" }), "DAILY_BUDGET_BLOCKED"],
    ["BUDGET_RESERVE", Error(sensitive), "BUDGET_UNAVAILABLE"],
    ["CATALOGUE_FETCH", Error("Provider response exceeds safe byte limit."), "RESPONSE_TOO_LARGE"],
    ["LEAGUE_FETCH", Error("OddsPapi HTTP failure; a quota call may have been consumed."), "UPSTREAM_HTTP_ERROR"],
    ["CATALOGUE_FETCH", Error("Provider response is not safely streamable."), "RESPONSE_NOT_STREAMABLE"],
    ["CATALOGUE_FETCH", new SyntaxError(sensitive), "RESPONSE_JSON_INVALID"],
    ["LEAGUE_FETCH", Object.assign(Error(sensitive), { name: "TimeoutError" }), "UPSTREAM_TIMEOUT"],
    ["CATALOGUE_FETCH", Error(sensitive), "UPSTREAM_OTHER_FAILURE"],
    ["CATALOGUE_VALIDATE", Error("Invalid catalogue data shape."), "CATALOGUE_FORMAT_INVALID"],
    ["CATALOGUE_VALIDATE", Error("Global catalogue processing ceiling exceeded."), "CATALOGUE_GLOBAL_COUNT_LIMIT"],
    ["CATALOGUE_VALIDATE", Error("NBA catalogue subset processing ceiling exceeded."), "CATALOGUE_NBA_SUBSET_LIMIT"],
    ["CATALOGUE_VALIDATE", Error("Invalid or oversized catalogue definition count."), "CATALOGUE_COUNT_LIMIT"],
    ["CATALOGUE_VALIDATE", Error("Invalid or oversized catalogue data."), "CATALOGUE_FORMAT_OR_COUNT_LIMIT"],
    ["CATALOGUE_VALIDATE", Error("Official catalogue has no usable NBA full-game player-prop definitions."), "NO_ELIGIBLE_CATALOGUE_MARKETS"],
    ["CATALOGUE_VALIDATE", Error(sensitive), "CATALOGUE_VALIDATION_FAILED"],
    ["LEAGUE_ANALYZE", Error("Invalid or oversized fixtures data."), "FIXTURE_FORMAT_OR_COUNT_LIMIT"],
    ["LEAGUE_ANALYZE", Error("Market processing ceiling exceeded."), "MARKET_PROCESSING_LIMIT"],
    ["LEAGUE_ANALYZE", Error("Selection processing ceiling exceeded."), "SELECTION_PROCESSING_LIMIT"],
    ["LEAGUE_ANALYZE", Error(sensitive), "LEAGUE_VALIDATION_FAILED"],
    ["COOLDOWN", Error(sensitive), "COOLDOWN_FAILED"],
    ["ANY_UNTRUSTED_STAGE", Error(sensitive), "OTHER_FAILURE"]
  ];
  for (const [stage, error, reason] of examples) {
    const diagnostic = safeAuditFailure(stage, error);
    assert.deepEqual(diagnostic, {
      stage: stage === "ANY_UNTRUSTED_STAGE" ? "UNKNOWN_STAGE" : stage,
      reason
    });
    assert.equal(Object.isFrozen(diagnostic), true);
    assert.doesNotMatch(JSON.stringify(diagnostic), /raw-api-key|player|quoted|odds|account-user-id/i);
    assert.equal(Object.keys(diagnostic).length, 2);
  }
});

test("first upstream rejection reports catalogue fetch stage once and never triggers league request", async () => {
  const messages = [], secret = "provider-secret-full-url-and-player-name";
  let reserved = 0, oddsRequests = 0;
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserved += n; },
    fetchCatalogue: async () => { throw new Error(secret); },
    fetchOdds: async () => { oddsRequests++; return ODDS; },
    onFailure: info => messages.push(info)
  });
  await assert.rejects(run(owner), error => error.message === secret);
  assert.equal(reserved, 2);
  assert.equal(oddsRequests, 0);
  assert.deepEqual(messages, [{ stage: "CATALOGUE_FETCH", reason: "UPSTREAM_OTHER_FAILURE" }]);
  assert.doesNotMatch(JSON.stringify(messages), /provider-secret|full-url|player-name/);
});

test("zero eligible catalogue markets are logged separately from fetch, without a second provider request", async () => {
  const messages = [];
  let fetches = 0;
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async () => {},
    fetchCatalogue: async () => [],
    fetchOdds: async () => { fetches++; return ODDS; },
    onFailure: value => messages.push(value)
  });
  await assert.rejects(run(owner), /no usable/);
  assert.equal(fetches, 0);
  assert.deepEqual(messages, [{
    stage: "CATALOGUE_VALIDATE", reason: "NO_ELIGIBLE_CATALOGUE_MARKETS",
    catalogueEligibility: {
      totalDefinitions: 0, validIds: 0, firstSeenIds: 0,
      sport11: 0, propTrue: 0, familyExact: 0,
      periodAllowed: 0, halfPointLine: 0, overUnderPair: 0,
      eligibleIds: 0, duplicateIds: 0
    },
    cataloguePeriod: {
      missingOrNull: 0, exactFulltime: 0, exactResult: 0,
      knownPartial: 0, otherString: 0, nonString: 0
    },
    catalogueFamilies: emptyFamilyCounts()
  }]);
  assert.ok(Object.isFrozen(messages[0].catalogueEligibility));
  assert.ok(Object.isFrozen(messages[0].cataloguePeriod));
  assert.ok(Object.isFrozen(messages[0].catalogueFamilies));
});

test("malformed but bounded catalogue logs per-stage counts, never provider text or prices", async () => {
  const warnings = [];
  let reserved = 0, catalogueCalls = 0, oddsCalls = 0;
  const variations = [
    { ...CATALOGUE[0], marketName: "private-provider-market-secret" },
    { ...CATALOGUE[0], marketId: 102, handicap: 20 },
    { ...CATALOGUE[0], marketId: 103, outcomes: [{ outcomeId: 201, outcomeName: "Over" }] }
  ];
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserved += n; },
    fetchCatalogue: async () => { catalogueCalls++; return variations; },
    fetchOdds: async () => { oddsCalls++; return ODDS; },
    onFailure: info => warnings.push(info)
  });
  await assert.rejects(run(owner), /no usable/);
  assert.equal(reserved, 2);
  assert.equal(catalogueCalls, 1);
  assert.equal(oddsCalls, 0);
  assert.deepEqual(warnings, [{
    stage: "CATALOGUE_VALIDATE", reason: "NO_ELIGIBLE_CATALOGUE_MARKETS",
    catalogueEligibility: {
      totalDefinitions: 3, validIds: 3, firstSeenIds: 3,
      sport11: 3, propTrue: 3, familyExact: 2,
      periodAllowed: 2, halfPointLine: 1, overUnderPair: 0,
      eligibleIds: 0, duplicateIds: 0
    },
    cataloguePeriod: {
      missingOrNull: 0, exactFulltime: 0, exactResult: 2,
      knownPartial: 0, otherString: 0, nonString: 0
    },
    catalogueFamilies: {
      ...emptyFamilyCounts(),
      PTS: {
        definitions: 2, missingOrNull: 0, exactFulltime: 0,
        exactResult: 2, knownPartial: 0, otherString: 0, nonString: 0,
        halfPointLineIndependent: 1, overUnderPairIndependent: 1,
        lineAndPairIndependent: 0, resultLineAndPairIndependent: 0
      }
    }
  }]);
  assert.doesNotMatch(JSON.stringify(warnings), /private-provider-market-secret|120000|fixtureId|marketId|playerName|price/);
});

test("regulation, partial and unknown periods fail closed before any odds request", async () => {
  const reports = [];
  let reserved = 0, catalogueCalls = 0, oddsCalls = 0;
  const unknown = "secret-period-value";
  const candidates = [
    { ...CATALOGUE[0], marketId: 900001, period: "fulltime" },
    { ...CATALOGUE[0], marketId: 900002, period: "p1" },
    { ...CATALOGUE[0], marketId: 900003, period: unknown }
  ];
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserved += n; },
    fetchCatalogue: async () => { catalogueCalls++; return candidates; },
    fetchOdds: async () => { oddsCalls++; throw Error("must not fetch odds"); },
    onFailure: value => reports.push(value)
  });
  await assert.rejects(run(owner), /no usable/);
  assert.equal(reserved, 2);
  assert.equal(catalogueCalls, 1);
  assert.equal(oddsCalls, 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].stage, "CATALOGUE_VALIDATE");
  assert.equal(reports[0].reason, "NO_ELIGIBLE_CATALOGUE_MARKETS");
  assert.equal(reports[0].catalogueEligibility.familyExact, 3);
  assert.equal(reports[0].catalogueEligibility.periodAllowed, 0);
  assert.deepEqual(reports[0].cataloguePeriod, {
    missingOrNull: 0, exactFulltime: 1, exactResult: 0,
    knownPartial: 1, otherString: 1, nonString: 0
  });
  assert.doesNotMatch(JSON.stringify(reports),
    /secret-period-value|marketId|outcomeId|playerName|apiKey|price/i);
});

test("eligibility logging accepts only bounded fixed numeric keys", () => {
  const error = new Error("Official catalogue has no usable NBA full-game player-prop definitions.");
  const good = {
    totalDefinitions: 9, validIds: 8, firstSeenIds: 7,
    sport11: 6, propTrue: 5, familyExact: 4,
    periodAllowed: 3, halfPointLine: 2, overUnderPair: 1,
    eligibleIds: 0, duplicateIds: 1
  };
  const safe = safeAuditFailure("CATALOGUE_VALIDATE", error,
    { ...good, apiKey: "private-key", marketId: "private-id", price: 2.15 });
  assert.deepEqual(safe.catalogueEligibility, good);
  assert.ok(Object.isFrozen(safe.catalogueEligibility));
  assert.doesNotMatch(JSON.stringify(safe), /private-key|private-id|apiKey|marketId|price/);
  const bad = safeAuditFailure("CATALOGUE_VALIDATE", error,
    { ...good, sport11: "6" });
  assert.deepEqual(bad, { stage: "CATALOGUE_VALIDATE", reason: "NO_ELIGIBLE_CATALOGUE_MARKETS" });
  const tooLarge = safeAuditFailure("CATALOGUE_VALIDATE", error,
    { ...good, sport11: 250001 });
  assert.equal(tooLarge.catalogueEligibility, undefined);
  const elsewhere = safeAuditFailure("LEAGUE_ANALYZE", error, good);
  assert.equal(elsewhere.catalogueEligibility, undefined);
});

test("period logging requires bounded fixed keys and exact-result funnel agreement", () => {
  const error = Error("Official catalogue has no usable NBA full-game player-prop definitions.");
  const eligibility = {
    totalDefinitions: 9, validIds: 8, firstSeenIds: 7,
    sport11: 6, propTrue: 5, familyExact: 4,
    periodAllowed: 1, halfPointLine: 2, overUnderPair: 1,
    eligibleIds: 0, duplicateIds: 1
  };
  const period = {
    missingOrNull: 1, exactFulltime: 2, exactResult: 1,
    knownPartial: 0, otherString: 0, nonString: 0
  };
  const good = safeAuditFailure("CATALOGUE_VALIDATE", error, eligibility,
    { ...period, secretPeriod: "private raw string", apiKey: "never-log" });
  assert.deepEqual(good.cataloguePeriod, period);
  assert.ok(Object.isFrozen(good.cataloguePeriod));
  assert.doesNotMatch(JSON.stringify(good), /private raw string|secretPeriod|apiKey|never-log/);
  const badType = safeAuditFailure("CATALOGUE_VALIDATE", error, eligibility,
    { ...period, exactResult: "1" });
  const badSize = safeAuditFailure("CATALOGUE_VALIDATE", error, eligibility,
    { ...period, exactResult: 250001 });
  const wrongSum = safeAuditFailure("CATALOGUE_VALIDATE", error, eligibility,
    { ...period, knownPartial: 1 });
  const wrongPeriodGate = safeAuditFailure("CATALOGUE_VALIDATE", error, eligibility,
    { ...period, exactResult: 0, exactFulltime: 3 });
  for (const report of [badType, badSize, wrongSum, wrongPeriodGate]) {
    assert.deepEqual(report.catalogueEligibility, eligibility);
    assert.equal(report.cataloguePeriod, undefined);
  }
  assert.equal(safeAuditFailure("LEAGUE_FETCH", error, eligibility, period).cataloguePeriod, undefined);
  assert.equal(safeAuditFailure("CATALOGUE_VALIDATE", error, null, period).cataloguePeriod, undefined);
});

test("eight result-period families reach one offline league snapshot under existing two-slot reservation", async () => {
  const names = [
    "Over Under Player Points (incl. overtime)",
    "Over Under Player Rebounds (incl. overtime)",
    "Over Under Player Assists (incl. overtime)",
    "Over Under Player 3 Point FG (incl. overtime)",
    "Over Under Player Points + Rebounds (incl. overtime)",
    "Over Under Player Points + Assists (incl. overtime)",
    "Over Under Player Assists + Rebounds (incl. overtime)",
    "Over Under Player Points + Assists + Rebounds (incl. overtime)"
  ];
  const definitions = names.map((marketName, i) => ({
    ...CATALOGUE[0], marketId: 920000 + i, marketName
  }));
  const markets = Object.fromEntries(definitions.map(def => [
    String(def.marketId), ODDS[0].bookmakerOdds["betano.pt"].markets["101"]
  ]));
  const odds = [{
    ...ODDS[0], bookmakerOdds: { "betano.pt": {
      ...ODDS[0].bookmakerOdds["betano.pt"], markets
    } }
  }];
  const state = setup({ catalogue: definitions, odds });
  const report = await state.run(owner);
  assert.deepEqual(state.events, ["reserve:2", "catalogue", "wait", "odds"]);
  assert.equal(report.eligibleCatalogueMarketIds, 8);
  assert.equal(report.catalogueEligibility.periodAllowed, 8);
  assert.equal(report.catalogueEligibility.halfPointLine, 8);
  assert.equal(report.catalogueEligibility.overUnderPair, 8);
  assert.equal(report.matchedMarketObjects, 8);
  assert.equal(report.activePriceEntries, 8);
  assert.equal(report.cataloguePeriod.exactResult, 8);
  assert.deepEqual(report.families.map(x => x.family), FAMILIES);
  assert.equal(report.requestsUsedOnThisClick, 2);
  assert.equal(report.researchSaved, false);
  assert.doesNotMatch(JSON.stringify(report), /Synthetic Player|privateApiKey|marketId|"price"/);
});

test("all eight family summaries are logged after one synthetic catalogue-only failure", async () => {
  const names = [
    "Over Under Player Points (incl. overtime)",
    "Over Under Player Rebounds (incl. overtime)",
    "Over Under Player Assists (incl. overtime)",
    "Over Under Player 3 Point FG (incl. overtime)",
    "Over Under Player Points + Rebounds (incl. overtime)",
    "Over Under Player Points + Assists (incl. overtime)",
    "Over Under Player Assists + Rebounds (incl. overtime)",
    "Over Under Player Points + Assists + Rebounds (incl. overtime)"
  ];
  const definitions = names.map((marketName, i) => ({
    ...CATALOGUE[0], marketId: 910000 + i,
    marketName, period: "fulltime", privateApiKey: "should-never-leak"
  }));
  const warnings = [];
  let reservations = 0, catalogues = 0, odds = 0;
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async count => { reservations += count; },
    fetchCatalogue: async () => { catalogues++; return definitions; },
    fetchOdds: async () => { odds++; throw Error("must-not-request-odds"); },
    onFailure: info => warnings.push(info)
  });
  await assert.rejects(run(owner), /no usable/);
  assert.equal(reservations, 2);
  assert.equal(catalogues, 1);
  assert.equal(odds, 0);
  assert.equal(warnings.length, 1);
  const diagnostic = warnings[0];
  assert.equal(diagnostic.reason, "NO_ELIGIBLE_CATALOGUE_MARKETS");
  assert.equal(diagnostic.catalogueEligibility.familyExact, 8);
  assert.equal(diagnostic.catalogueEligibility.periodAllowed, 0);
  assert.deepEqual(diagnostic.cataloguePeriod, {
    missingOrNull: 0, exactFulltime: 8, exactResult: 0,
    knownPartial: 0, otherString: 0, nonString: 0
  });
  assert.deepEqual(Object.keys(diagnostic.catalogueFamilies), FAMILIES);
  for (const family of FAMILIES) {
    const c = diagnostic.catalogueFamilies[family];
    assert.equal(c.definitions, 1);
    assert.equal(c.exactFulltime, 1);
    assert.equal(c.exactResult, 0);
    assert.equal(c.halfPointLineIndependent, 1);
    assert.equal(c.overUnderPairIndependent, 1);
    assert.equal(c.lineAndPairIndependent, 1);
    assert.equal(c.resultLineAndPairIndependent, 0);
    assert.ok(Object.isFrozen(c));
  }
  assert.ok(Object.isFrozen(diagnostic.catalogueFamilies));
  assert.doesNotMatch(JSON.stringify(warnings),
    /should-never-leak|privateApiKey|marketId|playerName|secret|price|should-never-leak/i);
});

test("family log sanitizer rejects malformed counts and drops injected metadata", () => {
  const error = Error("Official catalogue has no usable NBA full-game player-prop definitions.");
  const eligibility = {
    totalDefinitions: 4, validIds: 4, firstSeenIds: 4,
    sport11: 4, propTrue: 4, familyExact: 4, periodAllowed: 1,
    halfPointLine: 0, overUnderPair: 0, eligibleIds: 0, duplicateIds: 0
  };
  const periods = {
    missingOrNull: 1, exactFulltime: 2, exactResult: 1,
    knownPartial: 0, otherString: 0, nonString: 0
  };
  const families = emptyFamilyCounts();
  families.PTS = { ...families.PTS, definitions: 4,
    missingOrNull: 1, exactFulltime: 2, exactResult: 1,
    apiKey: "private-key-in-extra-field" };
  families.NON_CANONICAL_FAMILY = { note: "private-provider-string" };
  const good = safeAuditFailure("CATALOGUE_VALIDATE", error, eligibility, periods, families);
  assert.equal(good.catalogueFamilies.PTS.definitions, 4);
  assert.equal(good.catalogueFamilies.PTS.exactResult, 1);
  assert.deepEqual(Object.keys(good.catalogueFamilies), FAMILIES);
  assert.ok(Object.isFrozen(good.catalogueFamilies.PTS));
  assert.doesNotMatch(JSON.stringify(good),
    /private-key-in-extra-field|private-provider-string|apiKey|NON_CANONICAL_FAMILY/);
  const invalid = [
    { ...families, PTS: { ...families.PTS, exactResult: 250001 } },
    { ...families, PTS: { ...families.PTS, exactResult: "1" } },
    { ...families, PTS: { ...families.PTS, missingOrNull: 0 } },
    { ...families, PTS: { ...families.PTS, halfPointLineIndependent: 5 } },
    { ...families, PTS: { ...families.PTS, lineAndPairIndependent: 1 } },
    { ...families, PTS: { ...families.PTS, resultLineAndPairIndependent: 1 } },
    { ...families, REB: null }
  ];
  for (const bad of invalid) {
    const safe = safeAuditFailure("CATALOGUE_VALIDATE", error, eligibility, periods, bad);
    assert.deepEqual(safe.cataloguePeriod, periods);
    assert.equal(safe.catalogueFamilies, undefined);
  }
  assert.equal(safeAuditFailure("CATALOGUE_VALIDATE", error, eligibility, null, families).catalogueFamilies, undefined);
  assert.equal(safeAuditFailure("LEAGUE_FETCH", error, eligibility, periods, families).catalogueFamilies, undefined);
});

test("global scan ceiling fails closed before a second upstream request", async () => {
  const messages = [];
  let reserved = 0, catalogueCalls = 0, oddsCalls = 0;
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserved += n; },
    fetchCatalogue: async () => { catalogueCalls++; return new Array(250001).fill(null); },
    fetchOdds: async () => { oddsCalls++; return ODDS; },
    onFailure: entry => messages.push(entry)
  });
  await assert.rejects(run(owner), /Global catalogue processing ceiling exceeded/);
  assert.equal(reserved, 2);
  assert.equal(catalogueCalls, 1);
  assert.equal(oddsCalls, 0);
  assert.deepEqual(messages, [
    { stage: "CATALOGUE_VALIDATE", reason: "CATALOGUE_GLOBAL_COUNT_LIMIT" }
  ]);
});

test("large global catalogue with small NBA subset reaches the league snapshot and zero-call cache", async () => {
  const global = new Array(75000).fill(null);
  global.push(...CATALOGUE);
  let reserved = 0, catalogueCalls = 0, oddsCalls = 0;
  const warnings = [];
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserved += n; },
    fetchCatalogue: async () => { catalogueCalls++; return global; },
    fetchOdds: async () => { oddsCalls++; return ODDS; },
    waitBetweenRequests: async () => {},
    onFailure: info => warnings.push(info)
  });
  const report = await run(owner);
  assert.equal(report.totalCatalogueDefinitions, 75001);
  assert.equal(report.eligibleCatalogueMarketIds, 1);
  assert.equal(report.activePriceEntries, 1);
  assert.equal(report.requestsUsedOnThisClick, 2);
  assert.equal(reserved, 2);
  assert.equal(catalogueCalls, 1);
  assert.equal(oddsCalls, 1);
  assert.deepEqual(warnings, []);
  const cached = await run(owner);
  assert.equal(cached.cached, true);
  assert.equal(cached.requestsUsedOnThisClick, 0);
  assert.equal(reserved, 2);
  assert.equal(catalogueCalls, 1);
  assert.equal(oddsCalls, 1);
});

test("eligible NBA subset ceiling logs safe reason and skips league odds", async () => {
  const template = CATALOGUE[0];
  const nba = Array.from({ length: 50001 }, (_, i) => ({ ...template, marketId: i + 800000 }));
  let reserved = 0, oddsCalls = 0;
  const warnings = [];
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserved += n; },
    fetchCatalogue: async () => nba,
    fetchOdds: async () => { oddsCalls++; return ODDS; },
    onFailure: x => warnings.push(x)
  });
  await assert.rejects(run(owner), /NBA catalogue subset processing ceiling exceeded/);
  assert.equal(reserved, 2);
  assert.equal(oddsCalls, 0);
  assert.deepEqual(warnings, [
    { stage: "CATALOGUE_VALIDATE", reason: "CATALOGUE_NBA_SUBSET_LIMIT" }
  ]);
});

test("malformed catalogue shape logs only its fixed reason and never requests league odds", async () => {
  const reports = [];
  let reserved = 0, catalogueCalls = 0, oddsCalls = 0;
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserved += n; },
    fetchCatalogue: async () => { catalogueCalls++; return { unexpected: "private provider payload" }; },
    fetchOdds: async () => { oddsCalls++; return ODDS; },
    onFailure: item => reports.push(item)
  });
  await assert.rejects(run(owner), /Invalid catalogue data shape/);
  assert.equal(reserved, 2);
  assert.equal(catalogueCalls, 1);
  assert.equal(oddsCalls, 0);
  assert.deepEqual(reports, [
    { stage: "CATALOGUE_VALIDATE", reason: "CATALOGUE_FORMAT_INVALID" }
  ]);
  assert.doesNotMatch(JSON.stringify(reports), /private provider payload/);
});

test("reservation and second-fetch failure are distinguished and no automatic retries occur", async () => {
  const reports = [];
  const denied = Object.assign(Error("confidential budget record"), { code: "resource-exhausted" });
  const blocked = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async () => { throw denied; },
    fetchCatalogue: async () => { throw Error("must not reach"); },
    fetchOdds: async () => { throw Error("must not reach"); },
    onFailure: report => reports.push(report)
  });
  await assert.rejects(blocked(owner), error => error === denied);
  assert.deepEqual(reports, [{ stage: "BUDGET_RESERVE", reason: "DAILY_BUDGET_BLOCKED" }]);

  let catalogueCount = 0, oddsCount = 0, reserveCount = 0;
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserveCount += n; },
    fetchCatalogue: async () => { catalogueCount++; return CATALOGUE; },
    fetchOdds: async () => { oddsCount++; throw new Error("OddsPapi HTTP failure; a quota call may have been consumed."); },
    onFailure: value => reports.push(value)
  });
  await assert.rejects(run(owner), /HTTP failure/);
  assert.equal(catalogueCount, 1);
  assert.equal(oddsCount, 1);
  assert.equal(reserveCount, 2);
  assert.deepEqual(reports[1], { stage: "LEAGUE_FETCH", reason: "UPSTREAM_HTTP_ERROR" });
});

test("invalid fixture response has league analyze classification and cache remains unavailable", async () => {
  const reports = [], s = setup();
  let catalogueCount = 0, oddsCount = 0;
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async () => {},
    fetchCatalogue: async () => { catalogueCount++; return CATALOGUE; },
    fetchOdds: async () => { oddsCount++; return {}; },
    onFailure: value => reports.push(value)
  });
  await assert.rejects(run(owner), /fixtures/);
  await assert.rejects(run(owner), /fixtures/);
  assert.equal(catalogueCount, 1);
  assert.equal(oddsCount, 2);
  assert.deepEqual(reports, [
    { stage: "LEAGUE_ANALYZE", reason: "FIXTURE_FORMAT_OR_COUNT_LIMIT" },
    { stage: "LEAGUE_ANALYZE", reason: "FIXTURE_FORMAT_OR_COUNT_LIMIT" }
  ]);
});

test("success and rejected callers are silent; callback exceptions cannot hide original error", async () => {
  const reports = [];
  const good = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async () => {}, fetchCatalogue: async () => CATALOGUE,
    fetchOdds: async () => ODDS, onFailure: v => reports.push(v)
  });
  await assert.rejects(good({ ...owner, data: { override: true } }), /no parameters/);
  await good(owner);
  await good(owner); // cache hit
  assert.deepEqual(reports, []);

  const original = new Error("original network exception");
  const bad = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async () => {}, fetchCatalogue: async () => { throw original; },
    fetchOdds: async () => ODDS,
    onFailure: () => { throw new Error("logger unavailable"); }
  });
  await assert.rejects(bad(owner), e => e === original);
});

test("two simultaneous callers share one fixed-code failure report and one reservation", async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const reports = [];
  let reservations = 0, catalogues = 0;
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reservations += n; },
    fetchCatalogue: async () => { catalogues++; await wait; throw Error("internal-secret-quote"); },
    fetchOdds: async () => ODDS,
    onFailure: value => reports.push(value)
  });
  const first = run(owner), second = run(owner);
  release();
  await Promise.all([
    assert.rejects(first, /internal-secret-quote/),
    assert.rejects(second, /internal-secret-quote/)
  ]);
  assert.equal(reservations, 2);
  assert.equal(catalogues, 1);
  assert.deepEqual(reports, [{ stage: "CATALOGUE_FETCH", reason: "UPSTREAM_OTHER_FAILURE" }]);
});

test("production audit wiring logs only sanitized diagnostic and preserves manual limits", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const start = src.indexOf("// Update 35.1C2 — deliberately manual");
  const end = src.indexOf("function ledgerAssertOwner(request)", start);
  assert.ok(start > 0 && end > start);
  const audit = src.slice(start, end);
  assert.match(audit, /onFailure: \(\{ stage, reason, catalogueEligibility, cataloguePeriod, catalogueFamilies \}\) =>/);
  assert.match(audit, /console\.warn\("NBA market audit safe failure",/);
  assert.match(audit, /catalogueEligibility \? \{/);
  assert.match(audit, /\.\.\.\(cataloguePeriod \? \{ cataloguePeriod \} : \{\}\)/);
  assert.match(audit, /\.\.\.\(catalogueFamilies \? \{ catalogueFamilies \} : \{\}\)/);
  assert.match(audit, /reserve: reserveDiagnosticRequests/);
  assert.match(audit, /maxInstances: 1, concurrency: 1/);
  assert.match(audit, /path === "\/v4\/markets" \? readMarketCatalogueJson\(response\) : readLimitedJson\(response\)/);
  assert.doesNotMatch(audit, /console\.(log|error|debug)\(/);
  assert.doesNotMatch(audit, /setInterval|onSchedule|setDoc|addDoc/);
});

test("large but bounded official catalogue passes the manual runner without relaxing quota guards", async () => {
  const { readMarketCatalogueJson } = require("./odds-feasibility");
  const raw = JSON.stringify([{ ...CATALOGUE[0], unusedPadding: "a".repeat(12 * 1024 * 1024) }]);
  assert.ok(Buffer.byteLength(raw) > 12 * 1024 * 1024);
  let reserved = 0, catalogueCalls = 0, oddsCalls = 0;
  const reports = [];
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "fake-owner", now: () => NOW,
    reserve: async n => { reserved += n; },
    fetchCatalogue: async () => { catalogueCalls++; return readMarketCatalogueJson(new Response(raw)); },
    fetchOdds: async () => { oddsCalls++; return ODDS; },
    onFailure: issue => reports.push(issue)
  });
  const result = await run(owner);
  assert.equal(reserved, 2);
  assert.equal(catalogueCalls, 1);
  assert.equal(oddsCalls, 1);
  assert.equal(result.eligibleCatalogueMarketIds, 1);
  assert.equal(result.matchedMarketObjects, 1);
  assert.equal(result.requestsUsedOnThisClick, 2);
  assert.deepEqual(reports, []);
  assert.equal((await run(owner)).requestsUsedOnThisClick, 0);
  assert.equal(reserved, 2);
  assert.equal(catalogueCalls, 1);
  assert.equal(oddsCalls, 1);
  assert.doesNotMatch(JSON.stringify(result), /unusedPadding|Synthetic Player/);
});

test("production audit alone selects the larger market reader and retains 12 MiB odds reader", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const shared = fs.readFileSync(path.join(__dirname, "odds-feasibility.js"), "utf8");
  const start = src.indexOf("// Update 35.1C2 — deliberately manual");
  const end = src.indexOf("function ledgerAssertOwner(request)", start);
  const audit = src.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(audit, /path === "\/v4\/markets" \? readMarketCatalogueJson\(response\) : readLimitedJson\(response\)/);
  assert.match(audit, /fetchCatalogue: \(\) => fetchLeagueAuditJson\("\/v4\/markets", \{ language: "en" \}\)/);
  assert.match(audit, /fetchOdds: \(\) => fetchLeagueAuditJson\("\/v4\/odds-by-tournaments"/);
  assert.match(shared, /const MAX_RESPONSE_BYTES = 12 \* 1024 \* 1024/);
  assert.match(shared, /const MAX_CATALOGUE_RESPONSE_BYTES = 32 \* 1024 \* 1024/);
  assert.match(shared, /const readLimitedJson = response => readJsonWithByteLimit\(response, MAX_RESPONSE_BYTES\)/);
  assert.match(shared, /readJsonWithByteLimit\(response, MAX_CATALOGUE_RESPONSE_BYTES\)/);
  assert.doesNotMatch(audit, /setInterval|onSchedule|setDoc|updateDoc|addDoc/);
});
