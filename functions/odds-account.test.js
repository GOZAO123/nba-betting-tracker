"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { summarizeOddsAccount } = require("./odds-account");

function account(sub = {}, extra = {}) {
  return {
    api_key: "DO-NOT-LEAK-KEY", email: "secret@example.test",
    current_subscription_id: "private-subscription-id",
    subscriptions: [{
      subscription_id: "private-subscription-id", is_active: true,
      request_limit: 250, request_count: 13, price: 0, auto_renew: false,
      sport_ids: [10, 11], bookmakers: {
        "betano.pt": { has_live_odds: false, has_player_props: true },
        "betano": { has_player_props: false }
      },
      customer_id: "SENSITIVE", ...sub
    }], ...extra
  };
}

test("unmetered account summary is a strict allowlist and keeps only entitlements", () => {
  const data = summarizeOddsAccount(account());
  assert.deepEqual(data, {
    status: "ok", monthlyLimit: 250, monthlyUsed: 13, monthlyRemaining: 237,
    priceStatus: "zero-reported", autoRenew: false, nbaBasketballIncluded: true,
    betanoPtListed: true, betanoPtPlayerProps: true, genericBetanoListed: true
  });
  const serialized = JSON.stringify(data);
  for (const forbidden of ["DO-NOT-LEAK-KEY", "secret@example.test",
    "private-subscription-id", "SENSITIVE", "api_key", "subscription_id"])
    assert.equal(serialized.includes(forbidden), false);
});

test("generic Betano does not imply Betano Portugal player-prop entitlement", () => {
  const data = summarizeOddsAccount(account({
    bookmakers: { betano: { has_player_props: true } }
  }));
  assert.equal(data.betanoPtListed, false);
  assert.equal(data.betanoPtPlayerProps, null);
  assert.equal(data.genericBetanoListed, true);
});

test("unknown price, missing props flag and missing basketball are reported honestly", () => {
  const data = summarizeOddsAccount(account({
    price: null, auto_renew: null, sport_ids: [], bookmakers: {"betano.pt": {}}
  }));
  assert.equal(data.priceStatus, "unknown");
  assert.equal(data.autoRenew, null);
  assert.equal(data.nbaBasketballIncluded, false);
  assert.equal(data.betanoPtListed, true);
  assert.equal(data.betanoPtPlayerProps, null);
});

test("counter data is bounded and missing fields never fabricate allowance", () => {
  let data = summarizeOddsAccount(account({request_limit: 2, request_count: 4}));
  assert.equal(data.monthlyRemaining, 0);
  data = summarizeOddsAccount(account({request_limit: "250", request_count: -1}));
  assert.equal(data.monthlyLimit, null);
  assert.equal(data.monthlyUsed, null);
  assert.equal(data.monthlyRemaining, null);
});

test("ambiguous or absent active subscription is not guessed", () => {
  const a = account();
  a.subscriptions.push({...a.subscriptions[0], subscription_id: "other", is_active: true});
  const data = summarizeOddsAccount(a);
  assert.equal(data.status, "ok");
  const missing = summarizeOddsAccount(account({}, {current_subscription_id: "missing"}));
  assert.equal(missing.status, "subscription-unavailable");
  assert.equal(missing.monthlyRemaining, null);
  assert.equal(summarizeOddsAccount(account({is_active: false})).status, "subscription-unavailable");
  assert.throws(() => summarizeOddsAccount({api_key: "x"}));
});

test("backend callable only addresses the provider's unmetered account endpoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const begin = source.indexOf("exports.oddsPapiAccountPreflight =");
  const end = source.indexOf("exports.oddsBackendStatus =", begin);
  assert.ok(begin > 0 && end > begin, "account callable is isolated before existing odds diagnostics");
  const callable = source.slice(begin, end);
  assert.match(callable, /\/v4\/account/);
  assert.doesNotMatch(callable, /reserveDiagnosticRequests|\/v4\/odds|\/v4\/markets|transaction\.set|runTransaction/);
  assert.match(callable, /request\.auth/);
  assert.match(callable, /summarizeOddsAccount/);
  assert.doesNotMatch(callable, /return\s+(response|payload|account)\b/);
});
