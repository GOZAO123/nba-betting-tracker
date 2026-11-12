"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  eligibleForAutomaticSettlement, frozenFieldsMatch,
  runAutomaticSettlement, MAX_EVENT_AGE_MS, MIN_EVENT_AGE_MS
} = require("./auto-settlement");

const NOW = Date.UTC(2026, 10, 11, 13);
const START = NOW - 5 * 60 * 60 * 1000;
function makeEntry(overrides = {}) {
  return {
    eventId: "401", eventStartMs: START, capturedServerAt: { toMillis: () => START - 60 * 60 * 1000 },
    athleteId: "11", teamId: "2", homeId: "2", awayId: "3", status: "pending",
    market: "PTS", line: 20.5, side: "Over", modelSelected: 0.4,
    modelOver: 0.4, odds: 1.82, player: "Sample Player", team: "Sample Team",
    home: "Home", away: "Away", clientCapturedMs: START - 60 * 60 * 1000,
    hits12: 4, games12: 12, hits24: null, games24: null, ...overrides
  };
}
function createFixture(entries) {
  let changes = 0;
  const rows = entries.map((entry, i) => {
    const state = { ...entry };
    const ref = { path: "users/owner/propResearchLedger/row" + i, state };
    return { ref, data: () => ({ ...entry }) };
  });
  const db = {
    async runTransaction(fn) {
      const tx = {
        async get(ref) { return { exists: true, data: () => ({ ...ref.state }) }; },
        update(ref, patch) { Object.assign(ref.state, patch); changes++; }
      };
      return fn(tx);
    }
  };
  return { rows, db, get changes() { return changes; } };
}
const stamp = () => "server timestamp";

test("eligibility is server-time based and excludes premature, late, invalid or unsafe captures", () => {
  assert.equal(eligibleForAutomaticSettlement(makeEntry(), NOW), true);
  for (const changed of [
    { status: "settled" },
    { status: "void" },
    { eventStartMs: NOW - MIN_EVENT_AGE_MS + 1 },
    { eventStartMs: NOW - MAX_EVENT_AGE_MS - 1 },
    { eventId: "missing id" },
    { capturedServerAt: null },
    { capturedServerAt: { toMillis: () => START - 3 * 60 * 1000 } }
  ]) assert.equal(eligibleForAutomaticSettlement(makeEntry(changed), NOW), false);
  assert.equal(eligibleForAutomaticSettlement(makeEntry(), NOW - 10 * 60 * 60 * 1000), false);
});

test("frozen fields reject changed odds, model, athlete, line and timestamp", () => {
  const before = makeEntry();
  assert.equal(frozenFieldsMatch(before, makeEntry()), true);
  for (const changed of [
    { odds: 2.0 }, { modelSelected: .6 }, { athleteId: "12" },
    { line: 22.5 }, { capturedServerAt: { toMillis: () => START - 20 * 60 * 1000 } }
  ]) assert.equal(frozenFieldsMatch(before, makeEntry(changed)), false);
});

test("same ESPN game is fetched once and settlements only update result fields", async () => {
  const rows = createFixture([
    makeEntry(), makeEntry({ athleteId: "12", line: 30.5, market: "REB" })
  ]);
  let fetches = 0;
  const result = await runAutomaticSettlement({
    snapshots: rows.rows, now: NOW, db: rows.db, serverTimestamp: stamp,
    fetchSummary: async id => { fetches++; return { eventId: id }; },
    extractFinal: (summary, entry) => {
      assert.equal(summary.eventId, "401");
      return { stat: entry.athleteId === "11" ? 25 : 12, won: entry.athleteId === "11" };
    }
  });
  assert.equal(fetches, 1);
  assert.equal(result.settled, 2);
  assert.equal(rows.changes, 2);
  assert.equal(rows.rows[0].ref.state.status, "settled");
  assert.equal(rows.rows[0].ref.state.resultStat, 25);
  assert.equal(rows.rows[0].ref.state.odds, 1.82);
  assert.equal(rows.rows[0].ref.state.modelSelected, 0.4);
  assert.equal(rows.rows[0].ref.state.capturedServerAt.toMillis(), START - 60 * 60 * 1000);
});

test("unverifiable DNP, not-Final, postponed, player/team mismatch leave entries pending", async () => {
  for (const cause of ["DNP without ESPN flag", "not Final", "postponed", "wrong team", "wrong athlete"]) {
    const f = createFixture([makeEntry()]);
    const result = await runAutomaticSettlement({
      snapshots: f.rows, now: NOW, db: f.db, serverTimestamp: stamp,
      fetchSummary: async () => ({ cause }),
      extractFinal: summary => { throw Error(summary.cause); }
    });
    assert.equal(result.unresolved, 1, cause);
    assert.equal(f.changes, 0);
    assert.equal(f.rows[0].ref.state.status, "pending");
  }
});

test("ESPN outage leaves records pending without trying to write", async () => {
  const f = createFixture([makeEntry()]);
  const result = await runAutomaticSettlement({
    snapshots: f.rows, now: NOW, db: f.db, serverTimestamp: stamp,
    fetchSummary: async () => { throw Error("ESPN unavailable"); },
    extractFinal: () => { throw Error("should not validate"); }
  });
  assert.equal(result.unresolved, 1);
  assert.equal(f.changes, 0);
});

test("manual settlement racing scheduled job is idempotent", async () => {
  const f = createFixture([makeEntry()]);
  f.rows[0].ref.state.status = "settled";
  f.rows[0].ref.state.resultStat = 25;
  const result = await runAutomaticSettlement({
    snapshots: f.rows, now: NOW, db: f.db, serverTimestamp: stamp,
    fetchSummary: async () => ({}),
    extractFinal: () => ({ stat: 25, won: true })
  });
  assert.equal(result.alreadySettled, 1);
  assert.equal(f.changes, 0);
});

test("frozen quote mutation between scan and transaction fails closed", async () => {
  const f = createFixture([makeEntry()]);
  f.rows[0].ref.state.odds = 3.4;
  const result = await runAutomaticSettlement({
    snapshots: f.rows, now: NOW, db: f.db, serverTimestamp: stamp,
    fetchSummary: async () => ({}),
    extractFinal: () => ({ stat: 25, won: true })
  });
  assert.equal(result.errors, 1);
  assert.equal(f.changes, 0);
});

test("caps ESPN event requests at 16 and rejects larger overrides", async () => {
  const f = createFixture(Array.from({ length: 18 }, (_, i) =>
    makeEntry({ eventId: String(1000 + i) })));
  let n = 0;
  const result = await runAutomaticSettlement({
    snapshots: f.rows, now: NOW, db: f.db, serverTimestamp: stamp,
    fetchSummary: async () => { n++; return {}; },
    extractFinal: () => ({ stat: 25, won: true })
  });
  assert.equal(n, 16);
  assert.equal(result.truncatedGames, true);
  assert.equal(f.changes, 16);
  await assert.rejects(() => runAutomaticSettlement({
    snapshots: f.rows, now: NOW, db: f.db, serverTimestamp: stamp,
    fetchSummary: async () => ({}), extractFinal: () => ({}), maxEvents: 17
  }));
});

function getProductionExtractor() {
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const first = source.indexOf("function ledgerParseStat(");
  const last = source.indexOf("exports.ledgerSettleProspective=onCall(", first);
  assert.ok(first > 0 && last > first);
  class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  return new Function("HttpsError",
    source.slice(first, last) + "\nreturn ledgerExtractFinalFromEspn;")(HttpsError);
}
function finalBoxscore(athletes, overrides = {}) {
  return {
    header: { id: "401", competitions: [{
      id: "401", date: new Date(START).toISOString(),
      competitors: [{ team: { id: "2" } }, { team: { id: "3" } }],
      status: { type: { state: "post", completed: true, name: "STATUS_FINAL" } }
    }] },
    boxscore: { players: [{
      team: { id: "2" }, statistics: [{
        labels: ["MIN", "PTS", "REB", "AST", "3PT"],
        athletes
      }]
    }] },
    ...overrides
  };
}
function playedPlayer(stats = ["24:20", "25", "5", "6", "1-3"]) {
  return { athlete: { id: "11" }, didNotPlay: false, stats };
}
function dnpPlayer() {
  return { athlete: { id: "11" }, didNotPlay: true, reason: "COACH'S DECISION", stats: [] };
}

test("same production ESPN extractor differentiates explicit DNP, real zero and absent stats", () => {
  const extract = getProductionExtractor();
  assert.deepEqual(extract(finalBoxscore([dnpPlayer()]), makeEntry()), { kind: "dnp" });
  const scored = extract(finalBoxscore([playedPlayer(["20:00", "12", "0", "3", "0-1"])]),
    makeEntry({ market: "REB", line: 0.5, side: "Under" }));
  assert.deepEqual(scored, { stat: 0, won: true });
  assert.throws(() => extract(finalBoxscore([]), makeEntry()), /stat unavailable/);
  assert.throws(() => extract(finalBoxscore([
    { athlete: { id: "11" }, stats: [] }
  ]), makeEntry()), /stat unavailable/);
  assert.throws(() => extract(finalBoxscore([
    { athlete: { id: "99" }, didNotPlay: true }
  ]), makeEntry()), /stat unavailable/);
  assert.throws(() => extract(finalBoxscore([dnpPlayer(), playedPlayer()]),
    makeEntry()), /Conflicting ESPN DNP/);
  assert.throws(() => extract(finalBoxscore([{
    ...dnpPlayer(), stats: ["12:00", "6", "2", "1", "1-3"]
  }]), makeEntry()), /Contradictory ESPN DNP/);
  assert.throws(() => extract(finalBoxscore([dnpPlayer()]),
    makeEntry({line: -1})), /Stored betting line is invalid/);
  const noFinal = finalBoxscore([dnpPlayer()]);
  noFinal.header.competitions[0].status.type.state = "in";
  assert.throws(() => extract(noFinal, makeEntry()), /Game not completed/);
  const wrongGame = finalBoxscore([dnpPlayer()]);
  wrongGame.header.id = "999";
  assert.throws(() => extract(wrongGame, makeEntry()), /event ID mismatch/);
  const wrongTeam = finalBoxscore([dnpPlayer()]);
  wrongTeam.boxscore.players[0].team.id = "3";
  assert.throws(() => extract(wrongTeam, makeEntry()), /box score unavailable/);
});

test("scheduled job marks only explicit DNPs void and excludes score; normal players still settle", async () => {
  const entries = [
    makeEntry({ athleteId: "11", market: "REB", line: 4.5, side: "Under" }),
    makeEntry({ athleteId: "12", market: "PTS" })
  ];
  const f = createFixture(entries);
  let calls = 0;
  const extract = getProductionExtractor();
  const result = await runAutomaticSettlement({
    snapshots: f.rows, now: NOW, db: f.db, serverTimestamp: stamp,
    fetchSummary: async () => {
      calls++;
      return finalBoxscore([dnpPlayer(), {
        athlete: { id: "12" }, didNotPlay: false,
        stats: ["23:00", "22", "3", "2", "1-2"]
      }]);
    },
    extractFinal: extract
  });
  assert.equal(calls, 1);
  assert.deepEqual([result.settled, result.voided, result.unresolved, result.errors], [1, 1, 0, 0]);
  const noAction = f.rows[0].ref.state;
  assert.equal(noAction.status, "void");
  assert.equal(noAction.voidReason, "ESPN_EXPLICIT_DNP");
  assert.equal(noAction.resultStat, null);
  assert.equal(noAction.resultWon, null);
  assert.equal(noAction.odds, 1.82);
  assert.equal(noAction.modelSelected, 0.4);
  assert.equal(noAction.capturedServerAt.toMillis(), START - 60 * 60 * 1000);
  const played = f.rows[1].ref.state;
  assert.equal(played.status, "settled");
  assert.equal(played.resultStat, 22);
  assert.equal(played.resultWon, true);
  assert.equal(eligibleForAutomaticSettlement(noAction, NOW + 86400000), false);
});

test("DNP transaction is idempotent and cannot overwrite manual settlement or changed fields", async () => {
  const f = createFixture([makeEntry()]);
  f.rows[0].ref.state.status = "void";
  const once = await runAutomaticSettlement({
    snapshots: f.rows, now: NOW, db: f.db, serverTimestamp: stamp,
    fetchSummary: async () => ({}), extractFinal: () => ({ kind: "dnp" })
  });
  assert.equal(once.alreadySettled, 1);
  assert.equal(f.changes, 0);
  const changed = createFixture([makeEntry()]);
  changed.rows[0].ref.state.line = 99.5;
  const failed = await runAutomaticSettlement({
    snapshots: changed.rows, now: NOW, db: changed.db, serverTimestamp: stamp,
    fetchSummary: async () => ({}), extractFinal: () => ({ kind: "dnp" })
  });
  assert.equal(failed.errors, 1);
  assert.equal(changed.changes, 0);
  const malformed = createFixture([makeEntry()]);
  const malformedResult = await runAutomaticSettlement({
    snapshots: malformed.rows, now: NOW, db: malformed.db, serverTimestamp: stamp,
    fetchSummary: async () => ({}),
    extractFinal: () => ({ kind: "dnp", stat: 0, won: false })
  });
  assert.equal(malformedResult.errors, 1);
  assert.equal(malformed.changes, 0);
});

test("manual trusted settlement includes server-only DNP transaction and no-action return", () => {
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const start = source.indexOf("exports.ledgerSettleProspective=onCall(");
  const end = source.indexOf("// Update 34.6", start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /ledgerAssertOwner\(request\)/);
  assert.match(block, /ledgerExtractFinalFromEspn\(summary,entry\)/);
  assert.match(block, /result\.kind==="dnp"/);
  assert.match(block, /status:"void",voidReason:"ESPN_EXPLICIT_DNP"/);
  assert.match(block, /resultStat:null,resultWon:null/);
  assert.match(block, /voided:result\.kind==="dnp"/);
  assert.doesNotMatch(block, /oddsPapi|\.collection\("propResearchLedger"\)\.add/i);
});
