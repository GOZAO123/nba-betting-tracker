"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
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

test("DNP, not-Final, postponed, player/team mismatch leave every entry pending", async () => {
  for (const cause of ["DNP", "not Final", "postponed", "wrong team", "wrong athlete"]) {
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
