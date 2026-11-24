"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const expected = {
  ready: true, provider: "OddsPapi", oddsConnected: false,
  message: "Authenticated Firebase backend is ready. OddsPapi connection test is available separately."
};

// Execute the shared entrypoint with actual local helper modules, but fake
// Firebase registration and prohibit protected-resource interfaces.
function load() {
  const effects = [];
  let initialized = 0;
  const exports = {};
  const blocked = name => () => {
    effects.push(name);
    throw new Error("Unexpected protected interface: " + name);
  };
  class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const register = (options, handler) => ({ options, handler });
  const modules = {
    "firebase-functions/v2/https": { onCall: register, HttpsError },
    "firebase-functions/v2/scheduler": { onSchedule: register },
    "firebase-admin/app": { initializeApp: () => { initialized++; } },
    "firebase-admin/firestore": { getFirestore: blocked("Firestore"),
      Timestamp: {}, FieldValue: {} },
    "firebase-functions/params": { defineSecret: () => ({ value: blocked("secret") }) }
  };
  vm.runInNewContext(source, {
    exports, require: name => {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name.startsWith("./")) return require(name);
      throw new Error("Unexpected entrypoint import: " + name);
    },
    fetch: blocked("fetch"), setTimeout: blocked("timer"),
    setInterval: blocked("interval"), clearTimeout: blocked("clearTimeout"),
    process: { env: Object.freeze({}) }, URL, Date, console,
    AbortController, TextEncoder, TextDecoder
  }, { filename: "index.js" });
  return { exports, effects, initialized };
}

test("52C startup and status registration use dedicated identity only", () => {
  const x = load();
  assert.equal(x.initialized, 1);
  assert.equal(Object.keys(x.exports).length, 15);
  assert.equal(x.exports.oddsPapiAccountPreflight, undefined);
  assert.deepEqual(Object.keys(x.exports).filter(k => x.exports[k].options.serviceAccount).sort(),
    ["oddsBackendStatus", "oddsPapiNbaIdentitySchemaDiagnostic"]);
  assert.deepEqual(JSON.parse(JSON.stringify(x.exports.oddsBackendStatus.options)), {
    region: "europe-west1", maxInstances: 2, enforceAppCheck: false,
    serviceAccount: "nba-status-runtime@nba-betting-tracker-3979d.iam.gserviceaccount.com"
  });
  assert.deepEqual(x.effects, []);
});

test("52C unauthenticated callable rejected with unchanged error", async () => {
  const x = load();
  for (const request of [{}, {auth:null}]) {
    await assert.rejects(x.exports.oddsBackendStatus.handler(request),
      {code:"unauthenticated", message:"Sign in to check the odds backend."});
  }
  assert.deepEqual(x.effects, []);
});

test("52C ordinary authenticated users retain exact response without protected I/O", async () => {
  const x = load();
  for (const auth of [{uid:"synthetic-user",token:{email_verified:false}},
    {uid:"another-user",token:{email_verified:true}}]) {
    const result = await x.exports.oddsBackendStatus.handler({auth,data:{enabled:true}});
    assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
  }
  assert.deepEqual(x.effects, []);
});

test("52C existing safety invariants remain in source", () => {
  assert.match(source, /const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;/);
  assert.match(source, /const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
  assert.match(source, /const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
  assert.doesNotMatch(source, /\bsetGlobalOptions\s*\(/);
  assert.match(source, /enabled:process\.env\.ODDSPAPI_ONE_QUOTE_ENABLED/);
});
