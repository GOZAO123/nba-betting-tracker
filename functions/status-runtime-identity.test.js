"use strict";

// D15.17: disconnected status callable/identity tests; do not load index.js,
// Firebase SDK credentials, Admin SDK services or network clients.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const PARAM = "ODDS_BACKEND_STATUS_SERVICE_ACCOUNT";
const EXPRESSION = Object.freeze({ kind: "synthetic-required-deployment-expression" });
const STATUS_START = "exports.oddsBackendStatus = onCall(";

function statusBlock(source = SOURCE) {
  const start = source.indexOf(STATUS_START);
  assert.ok(start >= 0, "Expected exactly one status export");
  assert.equal(source.indexOf(STATUS_START, start + STATUS_START.length), -1);
  const stop = source.indexOf("\n);\n", start);
  assert.ok(stop > start, "Expected status export to end before next Function");
  return source.slice(start, stop + "\n);".length);
}

function captureIsolatedStatus(source = SOURCE) {
  const exports = {};
  let registrations = 0;
  let protectedResourceRequests = 0;
  class HttpsError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const denyResource = () => {
    protectedResourceRequests += 1;
    throw new Error("Status attempted protected-resource access");
  };
  // No require(), process, credentials or real transport in this VM.
  vm.runInNewContext(statusBlock(source), {
    exports,
    HttpsError,
    oddsBackendStatusServiceAccount: EXPRESSION,
    onCall(options, handler) {
      registrations += 1;
      return { options, handler };
    },
    getFirestore: denyResource,
    fetch: denyResource,
    oddsPapiKey: { value: denyResource },
    reserveDiagnosticRequests: denyResource
  }, { timeout: 1000 });
  assert.equal(registrations, 1);
  return {
    callable: exports.oddsBackendStatus,
    requests: () => protectedResourceRequests
  };
}

test("D15.17 requires a deploy-time status identity parameter with no fallback", () => {
  assert.match(SOURCE, /const \{ defineSecret, defineString \} = require\("firebase-functions\/params"\);/);
  assert.match(
    SOURCE,
    /const oddsBackendStatusServiceAccount = defineString\("ODDS_BACKEND_STATUS_SERVICE_ACCOUNT"\);/
  );
  assert.equal(SOURCE.split('defineString("' + PARAM + '")').length - 1, 1);
  assert.doesNotMatch(SOURCE, /defineString\("ODDS_BACKEND_STATUS_SERVICE_ACCOUNT",/);
  assert.doesNotMatch(
    SOURCE,
    /const oddsBackendStatusServiceAccount\s*=\s*(?:process\.env|["']|.*\|\|)/
  );
  assert.equal((SOURCE.match(/serviceAccount:\s*oddsBackendStatusServiceAccount\b/g) || []).length, 1);
  const remainder = SOURCE.replace(statusBlock(), "");
  assert.doesNotMatch(remainder, /serviceAccount:\s*oddsBackendStatusServiceAccount\b/);
  assert.doesNotMatch(statusBlock(), /serviceAccount:\s*["']/);
});

test("D15.17 status callable preserves its options, schema and Firebase auth boundary", async () => {
  const { callable, requests } = captureIsolatedStatus();
  assert.ok(callable);
  assert.deepEqual(
    JSON.parse(JSON.stringify(callable.options)),
    {
      region: "europe-west1",
      maxInstances: 2,
      enforceAppCheck: false,
      serviceAccount: EXPRESSION
    }
  );
  assert.equal(callable.options.serviceAccount, EXPRESSION);
  assert.equal(Object.prototype.hasOwnProperty.call(callable.options, "secrets"), false);
  await assert.rejects(
    callable.handler({ auth: null }),
    error => error instanceof Error &&
      error.code === "unauthenticated" &&
      error.message === "Sign in to check the odds backend."
  );
  const result = await callable.handler({ auth: { uid: "synthetic-signed-in-user" } });
  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    {
      ready: true,
      provider: "OddsPapi",
      oddsConnected: false,
      message: "Authenticated Firebase backend is ready. OddsPapi connection test is available separately."
    }
  );
  assert.equal(requests(), 0, "Status callable must not access any protected resources");
});

test("D15.17 status handler has no provider, Firestore or secret operations", () => {
  const block = statusBlock();
  for (const disallowed of [
    /\bfetch\s*\(/, /\bgetFirestore\s*\(/, /\brunTransaction\s*\(/,
    /\breserveDiagnosticRequests\s*\(/, /\boddsPapiKey\b/,
    /\bsecrets\s*:/, /\bgetSecret\b/, /\bonSchedule\s*\(/
  ]) {
    assert.doesNotMatch(block, disallowed);
  }
});

test("D15.17 unchanged export inventory, quota and disabled feature guards", () => {
  const names = [...SOURCE.matchAll(
    /exports\.([A-Za-z0-9_]+)\s*=\s*(?:onCall|onSchedule|onRequest)\s*\(/g
  )].map(m => m[1]);
  assert.equal(names.length, 14);
  assert.equal(new Set(names).size, 14);
  assert.ok(names.includes("oddsBackendStatus"));
  assert.ok(names.includes("ledgerAutoSettleProspective"));
  assert.ok(names.includes("oddsPapiNbaIdentitySchemaDiagnostic"));
  assert.ok(!names.includes("oddsPapiAccountPreflight"), "Separately deployed preflight is not in main");
  assert.match(SOURCE, /const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;/);
  assert.match(SOURCE, /const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;/);
  assert.match(SOURCE, /const NBA_PROVIDER_EVIDENCE_ENABLED = false;/);
});

test("D15.17 synthetic drift fixture detects altered handler scope and side effects", async () => {
  const changedOption = statusBlock().replace(
    "serviceAccount: oddsBackendStatusServiceAccount",
    'serviceAccount: "synthetic-unapproved-runtime"'
  );
  const changedCall = statusBlock().replace(
    "if (!request.auth) {",
    "await fetch('https://invalid.local'); if (!request.auth) {"
  );
  assert.doesNotMatch(changedOption, /serviceAccount:\s*oddsBackendStatusServiceAccount\b/);
  const { callable, requests } = captureIsolatedStatus(
    SOURCE.replace(statusBlock(), changedCall)
  );
  await assert.rejects(callable.handler({ auth: {} }), /protected-resource access/);
  assert.equal(requests(), 1);
});
