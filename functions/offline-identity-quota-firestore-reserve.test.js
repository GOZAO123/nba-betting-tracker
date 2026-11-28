"use strict";

const assert = require("node:assert/strict");
const {test} = require("node:test");
const {
  BUDGET_PATH, makeOfflineSharedBudgetReservation
} = require("./offline-identity-quota-firestore-reserve");

const day = "2026-11-28";
const now = Date.parse(day + "T23:59:59.950Z");
const record = (reserved, utcDay = day) => ({utcDay, reserved, limit: 6});

function fixture(initial) {
  const state = {saved: initial, tick: now, committed: 0, attempts: 0, reads: 0};
  const db = {
    doc(path) {
      assert.equal(path, BUDGET_PATH);
      return {path};
    },
    async runTransaction(work, options) {
      assert.deepEqual(options, {maxAttempts: 5});
      let proposed;
      let receipt;
      for (let retry = 0; retry <= Number(Boolean(state.retry)); retry++) {
        proposed = undefined;
        state.attempts++;
        receipt = await work({
          async get(ref) {
            assert.equal(ref.path, BUDGET_PATH);
            state.reads++;
            state.afterRead?.();
            return {exists: state.saved !== undefined, data: () => state.saved};
          },
          set(ref, next) {
            assert.equal(ref.path, BUDGET_PATH);
            assert.equal(proposed, undefined);
            proposed = next;
          }
        });
        if (state.retry && retry === 0) state.beforeRetry?.();
      }
      state.beforeCommit?.();
      state.saved = proposed;
      state.committed++;
      state.afterCommit?.();
      return state.replaceReceipt ? state.replaceReceipt(receipt) : receipt;
    }
  };
  const reserve = makeOfflineSharedBudgetReservation({getFirestore: () => db, now: () => state.tick});
  return {state, db, reserve};
}

test("one-slot and two-slot calls share a single six-slot record", async () => {
  const {state, reserve} = fixture();
  assert.deepEqual(await reserve(1), {utcDay: day, remaining: 5});
  assert.deepEqual(await reserve(2), {utcDay: day, remaining: 3});
  assert.deepEqual(await reserve(2), {utcDay: day, remaining: 1});
  await assert.rejects(reserve(2), /unavailable/);
  assert.equal(state.saved.reserved, 5);
  assert.deepEqual(await reserve(1), {utcDay: day, remaining: 0});
  await assert.rejects(reserve(1), /unavailable/);
  assert.deepEqual(state.saved, {...record(6), lastReservedAt: new Date(now).toISOString()});
  assert.equal(state.committed, 4);
});

test("invalid amounts and clocks stop before database work", async () => {
  const {state, reserve} = fixture();
  for (const value of [null, "2", 0, -1, 1.5, 3, NaN]) await assert.rejects(reserve(value));
  for (const tick of [NaN, -1, 1.5, 8640000000000001, Date.parse("+010000-01-01")]) {
    state.tick = tick;
    await assert.rejects(reserve(2));
  }
  assert.equal(state.attempts, 0);
});

for (const [name, prior] of [
  ["negative count", record(-1)], ["fractional count", record(1.5)],
  ["excess count", record(7)], ["incorrect limit", {...record(1), limit: 5}],
  ["future day", record(1, "2026-11-29")], ["invalid calendar day", record(1, "2026-02-29")],
  ["malformed older count", record("1", "2026-11-27")],
  ["malformed older timestamp", {...record(2, "2026-11-27"), lastReservedAt: "invalid"}],
  ["timestamp disagrees with stored day", {...record(2, "2026-11-27"), lastReservedAt: day + "T00:00:00.000Z"}]
]) {
  test(name + " fails closed without modifying the record", async () => {
    const {state, reserve} = fixture(prior);
    await assert.rejects(reserve(2), /unavailable/);
    assert.deepEqual(state.saved, prior);
    assert.equal(state.committed, 0);
  });
}

test("a valid old record resets at UTC midnight", async () => {
  const {state, reserve} = fixture(record(6));
  state.tick += 50;
  assert.deepEqual(await reserve(2), {utcDay: "2026-11-29", remaining: 4});
  assert.deepEqual(state.saved, {...record(2, "2026-11-29"), lastReservedAt: "2026-11-29T00:00:00.000Z"});
});

test("transaction retry re-reads the counter and writes once", async () => {
  const {state, reserve} = fixture(record(1));
  state.retry = true;
  state.beforeRetry = () => { state.saved = record(4); };
  assert.deepEqual(await reserve(2), {utcDay: day, remaining: 0});
  assert.equal(state.reads, 2);
  assert.equal(state.committed, 1);
  assert.equal(state.saved.reserved, 6);
});

test("a retry after UTC midnight cannot write the prior day", async () => {
  const {state, reserve} = fixture(record(1));
  state.retry = true;
  state.beforeRetry = () => { state.tick += 50; };
  await assert.rejects(reserve(2), /unavailable/);
  assert.equal(state.committed, 0);
  assert.deepEqual(state.saved, record(1));
});

test("clock regression, elapsed permit and UTC rollover during the read deny without writing", async () => {
  for (const delta of [-1, 30, 50]) {
    const {state, reserve} = fixture();
    state.afterRead = () => { state.tick += delta; };
    await assert.rejects(reserve(2, {claimedAtMs: now, expiresAtMs: now + 30}), /unavailable/);
    assert.equal(state.committed, 0);
  }
});

test("acknowledgement after the deadline or UTC rollover fails closed after persistence", async () => {
  for (const delta of [30, 50]) {
    const {state, reserve} = fixture();
    state.afterCommit = () => { state.tick += delta; };
    await assert.rejects(reserve(2, {claimedAtMs: now, expiresAtMs: now + (delta === 30 ? 30 : 100)}), /unavailable/);
    assert.equal(state.saved.reserved, 2);
    assert.equal(state.committed, 1);
  }
});

test("a prior-day claimed window cannot start a fresh reservation", async () => {
  const {state, reserve} = fixture();
  state.tick += 50;
  await assert.rejects(reserve(2, {claimedAtMs: now, expiresAtMs: now + 100}), /unavailable/);
  assert.equal(state.attempts, 0);
});

test("abort versus lost acknowledgement preserve their distinct counter states", async () => {
  for (const stage of ["beforeCommit", "afterCommit"]) {
    const {state, reserve} = fixture(record(1));
    state[stage] = () => { throw Error("Synthetic failure"); };
    await assert.rejects(reserve(2), /unavailable/);
    assert.equal(state.attempts, 1);
    assert.equal(state.saved.reserved, stage === "beforeCommit" ? 1 : 3);
  }
});

test("missing, malformed and fabricated acknowledgements never count as a receipt", async () => {
  for (const value of [undefined, true, {utcDay: day, remaining: 4}, {utcDay: day, remaining: 5}]) {
    const {state, reserve} = fixture();
    state.replaceReceipt = () => value;
    await assert.rejects(reserve(2), /unavailable/);
    assert.equal(state.saved.reserved, 2);
    assert.equal(state.attempts, 1);
  }
});
