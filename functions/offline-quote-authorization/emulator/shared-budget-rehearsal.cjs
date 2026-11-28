"use strict";

const assert = require("node:assert/strict");
const {after, before, test} = require("node:test");
const {PROJECT, assertDemoEnvironment, assertEmulatorsRunning} = require("./environment.cjs");
const {BUDGET_PATH, makeOfflineSharedBudgetReservation} = require("../../offline-identity-quota-firestore-reserve");

assertDemoEnvironment();

const day = "2026-11-28";
const midnight = Date.parse("2026-11-29T00:00:00.000Z");
const beforeMidnight = midnight - 50;
const record = (reserved, utcDay = day) => ({utcDay, reserved, limit: 6});
let app, db, ref, deleteApp, owned;

before(async () => {
  await assertEmulatorsRunning();
  const admin = require("firebase-admin/app");
  deleteApp = admin.deleteApp;
  app = admin.initializeApp({projectId: PROJECT});
  db = require("firebase-admin/firestore").getFirestore(app);
  ref = db.doc(BUDGET_PATH);
  assert.equal((await ref.get()).exists, false, "Refuse to touch an existing counter");
  owned = true;
});

after(async () => {
  try {
    if (owned) {
      await ref.delete();
      assert.equal((await ref.get()).exists, false);
      console.log("Shared synthetic counter cleaned and verified absent");
    }
  } finally {
    try { if (db) await db.terminate(); } finally { if (app) await deleteApp(app); }
  }
});

function adapter(now = () => beforeMidnight, backend = db) {
  return makeOfflineSharedBudgetReservation({getFirestore: () => backend, now});
}

test("missing counter initializes; one and two slots share the record and exact limit", async () => {
  const reserve = adapter();
  assert.deepEqual(await reserve(1), {utcDay: day, remaining: 5});
  assert.deepEqual(await reserve(2), {utcDay: day, remaining: 3});
  assert.deepEqual(await reserve(2), {utcDay: day, remaining: 1});
  const five = (await ref.get()).data();
  await assert.rejects(reserve(2), /unavailable/);
  assert.deepEqual((await ref.get()).data(), five);
  assert.deepEqual(await reserve(1), {utcDay: day, remaining: 0});
  await assert.rejects(reserve(1), /unavailable/);
  assert.deepEqual((await ref.get()).data(), {
    ...record(6), lastReservedAt: new Date(beforeMidnight).toISOString()
  });
});

for (const [label, amounts] of [
  ["one-slot", [1, 1, 1, 1, 1, 1, 1]],
  ["two-slot", [2, 2, 2, 2]],
  ["mixed", [1, 2, 2, 1, 2]]
]) {
  test(label + " concurrency preserves capacity and matches committed receipt totals", async () => {
    await ref.set(record(0));
    const outcomes = await Promise.allSettled(amounts.map(amount => adapter()(amount)));
    const accepted = amounts.filter((_, index) => outcomes[index].status === "fulfilled");
    assert.ok(accepted.length > 0 && accepted.length < amounts.length);
    const persisted = (await ref.get()).data();
    assert.equal(persisted.utcDay, day);
    assert.equal(persisted.limit, 6);
    assert.equal(persisted.reserved, 6);
    assert.equal(persisted.reserved, accepted.reduce((sum, amount) => sum + amount, 0));
    await assert.rejects(adapter()(1), /unavailable/);
    console.log(label + " concurrent counters persisted at " + persisted.reserved + "/6");
  });
}

test("malformed stored numbers, limits, dates and invalid older state fail closed", async () => {
  const reserve = adapter();
  for (const prior of [
    record(-1), record(1.5), record(7), {...record(2), limit: 7},
    record(1, "2026-11-29"), record(1, "2026-02-29"), record("1", "2026-11-27"),
    {...record(1, "2026-11-27"), lastReservedAt: "2026-11-28T00:00:00.000Z"}
  ]) {
    await ref.set(prior);
    await assert.rejects(reserve(2), /unavailable/);
    assert.deepEqual((await ref.get()).data(), prior);
  }
});

test("valid prior day resets at midnight; an expired read does not write old-day quota", async () => {
  let clock = beforeMidnight;
  const delayed = {
    doc: path => db.doc(path),
    runTransaction: (work, options) => db.runTransaction(tx => work({
      async get(ref) {
        const value = await tx.get(ref);
        clock = midnight;
        return value;
      },
      set: (...args) => tx.set(...args)
    }), options)
  };
  // Use a non-exhausted counter so stale time, not capacity, causes the denial.
  await ref.set(record(3));
  await assert.rejects(adapter(() => clock, delayed)(2), /unavailable/);
  assert.deepEqual((await ref.get()).data(), record(3));
  assert.deepEqual(await adapter(() => clock)(2), {utcDay: "2026-11-29", remaining: 4});
  assert.deepEqual((await ref.get()).data(), {
    ...record(2, "2026-11-29"), lastReservedAt: "2026-11-29T00:00:00.000Z"
  });
});

test("SDK retry abandons the first write and commits two slots once", async () => {
  await ref.set(record(0));
  let attempts = 0;
  const backend = {
    doc: path => db.doc(path),
    runTransaction: (work, options) => db.runTransaction(async tx => {
      const proposed = await work(tx);
      if (++attempts === 1) throw Object.assign(Error("Synthetic transient abort"), {code: 10});
      return proposed;
    }, options)
  };
  assert.deepEqual(await adapter(undefined, backend)(2), {utcDay: day, remaining: 4});
  assert.equal(attempts, 2);
  assert.equal((await ref.get()).data().reserved, 2);
});

test("late acknowledgement consumes old-day slots but authorizes no caller", async () => {
  await ref.set(record(0));
  let clock = beforeMidnight;
  const backend = {
    doc: path => db.doc(path),
    async runTransaction(work, options) {
      const result = await db.runTransaction(work, options);
      clock = midnight;
      return result;
    }
  };
  await assert.rejects(adapter(() => clock, backend)(2), /unavailable/);
  assert.equal((await ref.get()).data().reserved, 2);
  assert.equal((await ref.get()).data().utcDay, day);
  await assert.rejects(adapter(() => clock)(2, {claimedAtMs: beforeMidnight, expiresAtMs: midnight+1000}));
  assert.deepEqual(await adapter(() => clock)(1), {utcDay: "2026-11-29", remaining: 5});
  assert.equal((await ref.get()).data().reserved, 1);
});
