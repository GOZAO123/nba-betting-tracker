"use strict";

// D15.19: Real Firebase Functions v6.4.0 SDK endpoint/parameter metadata test.
// Requires an isolated CI job with public npm packages preinstalled.
// NO Firebase CLI, credentials, project ID, Admin SDK initialization, deployment,
// network access, Firestore, secrets, Cloud Run, or provider requests.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Fail closed before importing the real SDK. The npm dependency-install phase
// is separate; the execution phase denies ordinary Node network transports.
let attemptedNetworkCalls = 0;
function deniedNetwork() {
  attemptedNetworkCalls += 1;
  throw new Error("D15.19 probe forbids all network calls");
}
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
net.Socket.prototype.connect = deniedNetwork;
net.createConnection = deniedNetwork;
net.connect = deniedNetwork;
tls.connect = deniedNetwork;
http.request = deniedNetwork;
http.get = deniedNetwork;
https.request = deniedNetwork;
https.get = deniedNetwork;
dns.lookup = deniedNetwork;
dns.resolve = deniedNetwork;
globalThis.fetch = deniedNetwork;

const PARAM_NAME = "ODDS_BACKEND_STATUS_SERVICE_ACCOUNT";
const SOURCE = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const sdk = require("firebase-functions/v2/https");
const params = require("firebase-functions/params");

function getStatusDeclaration() {
  const decl =
    'const oddsBackendStatusServiceAccount = defineString("' + PARAM_NAME + '");';
  assert.equal(SOURCE.split(decl).length - 1, 1, "Exactly one default-free declaration");
  assert.doesNotMatch(
    SOURCE, /defineString\("ODDS_BACKEND_STATUS_SERVICE_ACCOUNT",/
  );

  const startToken = "exports.oddsBackendStatus = onCall(";
  const start = SOURCE.indexOf(startToken);
  assert.notEqual(start, -1, "Actual pending status callable exists in index.js");
  assert.equal(SOURCE.indexOf(startToken, start + 1), -1);
  const end = SOURCE.indexOf("\n);\n", start);
  assert.ok(end > start, "Cannot isolate status callable safely");
  const handler = SOURCE.slice(start, end + "\n);\n".length);
  return { declaration: decl, handler };
}

function loadActualStatusViaSdk() {
  const { declaration, handler } = getStatusDeclaration();
  const exports = {};
  // No require/process/credentials/network available to the extracted code.
  // Only the real Firebase SDK constructors/functions are injected.
  vm.runInNewContext(declaration + "\n" + handler, {
    exports,
    defineString: params.defineString,
    onCall: sdk.onCall,
    HttpsError: sdk.HttpsError,
  }, { timeout: 2000 });
  assert.equal(typeof exports.oddsBackendStatus, "function");
  assert.equal(typeof exports.oddsBackendStatus.run, "function");
  return exports.oddsBackendStatus;
}

test("D15.19 uses real, version-pinned Firebase SDK on Node 22", () => {
  assert.equal(process.versions.node.split(".")[0], "22");
  const sdkPackage = path.resolve(
    path.dirname(require.resolve("firebase-functions/params")), "../../package.json"
  );
  const version = JSON.parse(fs.readFileSync(sdkPackage, "utf8")).version;
  assert.equal(version, "6.4.0");
  assert.equal(typeof sdk.onCall, "function");
  assert.equal(typeof params.defineString, "function");
});

const functionUnderTest = loadActualStatusViaSdk();
const parameterMatches = params.declaredParams.filter(param => param.name === PARAM_NAME);
assert.equal(parameterMatches.length, 1, "Exactly one status runtime parameter registered");
const serviceAccountParam = parameterMatches[0];

test("D15.19 SDK registers a single string param without source default", () => {
  const spec = serviceAccountParam.toSpec();
  assert.equal(spec.name, PARAM_NAME);
  assert.equal(spec.type, "string");
  assert.equal(Object.prototype.hasOwnProperty.call(spec, "default"), false);
  assert.equal(serviceAccountParam.toString(), "params." + PARAM_NAME);
  assert.equal(
    serviceAccountParam.toCEL(), "{{ params." + PARAM_NAME + " }}"
  );
});

test("D15.19 SDK manifest binds expression only to status callable", () => {
  const endpoint = functionUnderTest.__endpoint;
  assert.equal(endpoint.platform, "gcfv2");
  assert.deepEqual(endpoint.region, ["europe-west1"]);
  assert.equal(endpoint.maxInstances, 2);
  assert.ok(endpoint.callableTrigger);
  assert.equal(endpoint.serviceAccountEmail, serviceAccountParam);
  assert.equal(
    JSON.parse(JSON.stringify({ serviceAccountEmail: endpoint.serviceAccountEmail }))
      .serviceAccountEmail,
    "params." + PARAM_NAME
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(endpoint, "secretEnvironmentVariables"),
    false,
    "Status must not mount the OddsPapi secret"
  );
  const sibling = sdk.onCall({ region: "europe-west1" }, async () => ({ ok: true }));
  assert.notEqual(
    sibling.__endpoint.serviceAccountEmail,
    serviceAccountParam,
    "SDK status parameter must not become a global account option"
  );
});

test("D15.19 SDK parameter resolves only a synthetic runtime value", () => {
  const previous = process.env[PARAM_NAME];
  const dummy = "status-pilot@offline.invalid";
  try {
    process.env[PARAM_NAME] = dummy;
    assert.equal(serviceAccountParam.value(), dummy);
    delete process.env[PARAM_NAME];
    // SDK-side .value() does NOT enforce deploy-time requiredness.
    // This is NOT proof that the Firebase CLI will prompt/fail.
    assert.equal(serviceAccountParam.value(), "");
  } finally {
    if (previous === undefined) delete process.env[PARAM_NAME];
    else process.env[PARAM_NAME] = previous;
  }
});

test("D15.19 actual SDK callable preserves signed-in status behavior", async () => {
  await assert.rejects(
    functionUnderTest.run({ auth: null }),
    err => err.code === "unauthenticated" &&
      err.message === "Sign in to check the odds backend."
  );
  const result = await functionUnderTest.run({ auth: { uid: "synthetic-only" } });
  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    {
      ready: true,
      provider: "OddsPapi",
      oddsConnected: false,
      message: "Authenticated Firebase backend is ready. OddsPapi connection test is available separately."
    }
  );
});

test("D15.19 real SDK probe made zero network requests", () => {
  assert.equal(attemptedNetworkCalls, 0);
});
