"use strict";

// Update 35.1D15.26: disconnected one-event/one-player evidence rehearsal.
// All fixture/ESPN/bookmaker data here is SYNTHETIC. This test performs no
// HTTP calls, Firebase operations, provider quota reservations or capture.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeReviewedTeamBridgeResolver, getReviewedTeamBridge } =
  require("./offer-team-crosswalk");
const { inspectWithServerEspnEvidence } =
  require("./offer-espn-evidence");
const { extractManualProviderIdentityBatch } =
  require("./provider-evidence-acquisition");

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const iso = minutes => new Date(NOW + minutes * 60000).toISOString();
const PLAYER = "93001";
const ATHLETE = "Synthetic Example Player";
const MARKET = "91001", OVER = "92001", UNDER = "92002";
const FIXTURE = "synthetic-offline-fixture-001";

function definition(marketId = Number(MARKET), line = 18.5) {
  return {
    marketId, sportId: 11, playerProp: true, period: "result",
    marketName: "Over Under Player Points (incl. overtime)", handicap: line,
    outcomes: [
      { outcomeId: marketId + 1000, outcomeName: "Over" },
      { outcomeId: marketId + 1001, outcomeName: "Under" }
    ]
  };
}
function quote(overrides = {}) {
  return { active: true, price: 1.88, playerName: ATHLETE,
    changedAt: iso(-2), mainLine: false, ...overrides };
}
function marketFor(d) {
  const [over, under] = d.outcomes.map(row => String(row.outcomeId));
  return { marketActive: true, outcomes: {
    [over]: { players: { [PLAYER]: quote() } },
    [under]: { players: { [PLAYER]: quote({ price: 1.91 }) } }
  } };
}
function fixture() {
  const d = definition();
  return {
    fixtureId: FIXTURE, sportId: 11, tournamentId: 132,
    participant1Id: "5001", participant2Id: "5002",
    statusId: 0, hasOdds: true, startTime: iso(180),
    bookmakerOdds: { "betano.pt": {
      bookmakerIsActive: true, suspended: false,
      markets: { [MARKET]: marketFor(d) }
    } }
  };
}
function reviewedRecord(overrides = {}) {
  return {
    schemaVersion: 1, providerFixtureId: FIXTURE,
    providerStartTime: iso(180), espnEventId: "40101010",
    reviewMethod: "MANUAL_TWO_SOURCE_ID_REVIEW",
    reviewStatus: "APPROVED", reviewedAt: iso(-25), validUntil: iso(60),
    evidence: { providerReference: "SYNTHETIC_PROVIDER_REF_001",
      espnReference: "SYNTHETIC_ESPN_REF_001" },
    teams: [
      { providerParticipantId: "5001", espnTeamId: "1001" },
      { providerParticipantId: "5002", espnTeamId: "1002" }
    ],
    ...overrides
  };
}
function scheduledGame() {
  return {
    id: "40101010", date: iso(180), season: { type: 2 },
    status: { type: { state: "pre", name: "STATUS_SCHEDULED" } },
    competitions: [{ date: iso(180), competitors: [
      { homeAway: "home", team: { id: "1001", displayName: "Synthetic Home" } },
      { homeAway: "away", team: { id: "1002", displayName: "Synthetic Away" } }
    ] }]
  };
}
function roster(team) {
  return { team: { id: team, displayName: team === "1001" ?
    "Synthetic Home" : "Synthetic Away" },
  athletes: team === "1001" ?
    [{ id: "7001", displayName: ATHLETE }] :
    [{ id: "7002", displayName: "Other Synthetic Player" }] };
}
function scenario(mutate = () => {}, reviewedRows = [reviewedRecord()]) {
  const input = { catalogue: [definition()], fixture: fixture(), providerPlayerId: PLAYER };
  const scoreboard = { events: [scheduledGame()] };
  const rosters = { "1001": roster("1001"), "1002": roster("1002") };
  const effects = { espnReads: [], providerReads: 0, dbWrites: 0, reserves: 0 };
  const getReviewedTeamBridge = makeReviewedTeamBridgeResolver(reviewedRows, () => NOW);
  const context = { input, scoreboard, rosters, effects };
  mutate(context);
  const dependencies = {
    now: NOW, getReviewedTeamBridge,
    fetchEspn: async pathname => {
      effects.espnReads.push(pathname);
      if (pathname === "scoreboard?dates=20261118") return scoreboard;
      const team = /^teams\/(1001|1002)\/roster$/.exec(pathname)?.[1];
      if (team) return rosters[team];
      throw Error("UNEXPECTED_SYNTHETIC_ESPN_REQUEST");
    }
  };
  return { ...context, run: () => inspectWithServerEspnEvidence(input, dependencies) };
}
const pts = report => report.families.find(f => f.market === "PTS");
function assertReadOnly(report, scenarioState) {
  assert.deepEqual([report.autoLineSelected, report.captureAllowed, report.bookmakerVerified],
    [false, false, false]);
  assert.deepEqual([scenarioState.effects.providerReads, scenarioState.effects.dbWrites,
    scenarioState.effects.reserves], [0, 0, 0]);
  // Do not expose raw offered odds, market/player IDs, or provider names.
  assert.doesNotMatch(JSON.stringify(report),
    /Synthetic Example Player|93001|91001|92001|1\.88|1\.91|SYNTHETIC_PROVIDER_REF/);
}

test("D15.26 one game + player + paired Betano PTS stays review-only, with 3 ESPN reads", async () => {
  const s = scenario();
  const report = await s.run();
  assert.equal(report.status, "REVIEW_CANDIDATES_ONLY");
  assert.equal(report.eventMatched, true);
  assert.equal(report.athleteMatch, "EXACT_NAME_ONLY_NOT_VERIFIED");
  assert.deepEqual(s.effects.espnReads, ["scoreboard?dates=20261118",
    "teams/1001/roster", "teams/1002/roster"]);
  assert.equal(report.families.length, 8);
  assert.deepEqual([pts(report).pairedLines, pts(report).freshPairs,
    pts(report).explicitMainPairs, pts(report).decision],
    [1, 1, 0, "NO_EXPLICIT_MAIN_LINE"]);
  assertReadOnly(report, s);
});

test("D15.26 default shipped team crosswalk remains empty and refuses invented identities", async () => {
  const s = scenario();
  assert.equal(getReviewedTeamBridge({fixtureId:FIXTURE, participant1Id:"5001",
    participant2Id:"5002",startTime:iso(180)}),null);
  const report = await inspectWithServerEspnEvidence(s.input, {
    now: NOW, getReviewedTeamBridge, fetchEspn: async () => {
      throw Error("ESPN MUST NOT BE CONTACTED");
    }
  });
  assert.equal(report.status, "REVIEWED_TEAM_BRIDGE_UNAVAILABLE");
  assertReadOnly(report, s);
});

test("D15.26 revoked, duplicated, or absent trusted reviews block before ESPN reads", async () => {
  for (const reviews of [[], [reviewedRecord({reviewStatus:"REVOKED"})],
    [reviewedRecord(), reviewedRecord()]]) {
    const s = scenario(() => {}, reviews);
    const out = await s.run();
    assert.equal(out.status, "REVIEWED_TEAM_BRIDGE_UNAVAILABLE");
    assert.deepEqual(s.effects.espnReads, []);
    assertReadOnly(out,s);
  }
});

test("D15.26 client-supplied ESPN proofs are rejected without reading ESPN", async () => {
  for (const injected of ["espnEvent", "rosters", "teamBridge", "reviewedAthleteBridge"]) {
    const s = scenario(({input}) => {input[injected] = {claimedVerified:true};});
    const out = await s.run();
    assert.equal(out.status, "INVALID_INPUT");
    assert.deepEqual(s.effects.espnReads, []);
    assertReadOnly(out,s);
  }
});

test("D15.26 duplicated ESPN game is not first-match-wins", async () => {
  const s = scenario(({scoreboard}) => {scoreboard.events.push(scheduledGame());});
  const out = await s.run();
  assert.equal(out.status, "ESPN_EVENT_NOT_UNIQUELY_VERIFIED");
  assert.deepEqual(s.effects.espnReads,["scoreboard?dates=20261118"]);
  assertReadOnly(out,s);
});

test("D15.26 duplicate player names across rosters cannot verify identity", async () => {
  const s = scenario(({rosters}) => {rosters["1002"].athletes[0].displayName = ATHLETE;});
  const out = await s.run();
  assert.equal(out.status, "AMBIGUOUS_ESPN_NAME");
  assertReadOnly(out,s);
});

test("D15.26 incomplete Over/Under pair cannot become an offer", async () => {
  const s = scenario(({input}) => {
    delete input.fixture.bookmakerOdds["betano.pt"].markets[MARKET].outcomes[UNDER];
  });
  const out = await s.run();
  assert.equal(out.status, "NO_VALID_PROVIDER_PLAYER_PAIR");
  assertReadOnly(out,s);
});

test("D15.26 suspended or missing Betano PT source rejects before ESPN", async () => {
  for (const kind of ["suspended", "missing"]) {
    const s = scenario(({input}) => {
      const books = input.fixture.bookmakerOdds;
      if (kind === "suspended") books["betano.pt"].suspended = true;
      else {books["other.example"] = books["betano.pt"]; delete books["betano.pt"];}
    });
    const out = await s.run();
    assert.equal(out.status, "INVALID_PROVIDER_FIXTURE");
    assert.deepEqual(s.effects.espnReads,[]);
    assertReadOnly(out,s);
  }
});

test("D15.26 stale paired timestamps cannot be promoted to fresh evidence", async () => {
  const s = scenario(({input}) => {
    const outcomes = input.fixture.bookmakerOdds["betano.pt"].markets[MARKET].outcomes;
    outcomes[OVER].players[PLAYER].changedAt = iso(-30);
    outcomes[UNDER].players[PLAYER].changedAt = iso(-30);
  });
  const out = await s.run();
  assert.equal(out.status,"REVIEW_CANDIDATES_ONLY");
  assert.deepEqual([pts(out).pairedLines,pts(out).freshPairs,pts(out).stalePairs,
    pts(out).decision],[1,0,1,"STALE_ONLY"]);
  assertReadOnly(out,s);
});

test("D15.26 conflicting player-side names are quarantined", async () => {
  const s = scenario(({input}) => {
    const outcomes = input.fixture.bookmakerOdds["betano.pt"].markets[MARKET].outcomes;
    outcomes[UNDER].players[PLAYER].playerName = "Different Synthetic Player";
  });
  const out = await s.run();
  assert.equal(out.status,"PROVIDER_PLAYER_NAME_CONFLICT");
  assertReadOnly(out,s);
});

test("D15.26 duplicate same-family half-point lines require review", async () => {
  const s = scenario(({input}) => {
    const d = definition(91002,18.5);
    input.catalogue.push(d);
    input.fixture.bookmakerOdds["betano.pt"].markets["91002"] = marketFor(d);
  });
  const out = await s.run();
  assert.equal(out.status,"REVIEW_CANDIDATES_ONLY");
  assert.equal(pts(out).decision,"AMBIGUOUS_DUPLICATE_LINE");
  assertReadOnly(out,s);
});

test("D15.26 even a single explicitly flagged main line is NOT authorized capture", async () => {
  const s = scenario(({input}) => {
    const outcomes = input.fixture.bookmakerOdds["betano.pt"].markets[MARKET].outcomes;
    outcomes[OVER].players[PLAYER].mainLine = true;
    outcomes[UNDER].players[PLAYER].mainLine = true;
  });
  const out = await s.run();
  assert.equal(out.status,"REVIEW_CANDIDATES_ONLY");
  assert.equal(pts(out).decision,"EXPLICIT_MAIN_LINE_REVIEW_REQUIRED");
  assertReadOnly(out,s);
});

test("D15.26 frozen fixture provenance is unreviewed and never includes prices", () => {
  const s = scenario();
  const at = iso(0);
  const snapshot = extractManualProviderIdentityBatch([s.input.fixture],at);
  assert.equal(snapshot.status,"UNREVIEWED_PROVIDER_EVIDENCE");
  assert.equal(snapshot.capturedAt,at);
  assert.equal(snapshot.records.length,1);
  assert.equal(snapshot.records[0].fixtureId,FIXTURE);
  assert.equal(snapshot.records[0].startTime,iso(180));
  assert.match(snapshot.snapshotReference,/^ODDSPAPI_MANUAL_[A-F0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(snapshot),/1\.88|1\.91|93001|Synthetic Example Player/);
  assert.deepEqual([s.effects.providerReads,s.effects.dbWrites,s.effects.reserves],[0,0,0]);
});

test("D15.26 synthetic rehearsal is not wired into production or polling", () => {
  const prod = fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const current = fs.readFileSync(__filename,"utf8");
  assert.doesNotMatch(prod,/one-player-readiness|D15\.26/);
  assert.doesNotMatch(current,/require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(current,/(?:setInterval|setTimeout|onCall|onSchedule)\s*\(/);
});
