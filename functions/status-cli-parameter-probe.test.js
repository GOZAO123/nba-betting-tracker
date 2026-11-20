"use strict";

// D15.20: REAL Firebase CLI (firebase-tools v15.28.2) *library functions*
// resolving an offline synthetic endpoint from PR #67's source + SDK.
// Never invoke "firebase", deploy, dry-run, emulator, login or cloud clients.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let attemptedNetworkCalls = 0;
function deniedNetwork() {
  attemptedNetworkCalls++;
  throw new Error("D15.20 forbids network activity during test execution");
}
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
net.Socket.prototype.connect = deniedNetwork;
net.connect = deniedNetwork;
net.createConnection = deniedNetwork;
tls.connect = deniedNetwork;
http.request = deniedNetwork;
http.get = deniedNetwork;
https.request = deniedNetwork;
https.get = deniedNetwork;
dns.lookup = deniedNetwork;
dns.resolve = deniedNetwork;
globalThis.fetch = deniedNetwork;

// Load only locally installed public library modules; no CLI command entrypoint.
const sdkHttps = require("firebase-functions/v2/https");
const sdkParams = require("firebase-functions/params");
const cliBuild = require("firebase-tools/lib/deploy/functions/build");
const cliParams = require("firebase-tools/lib/deploy/functions/params");

const NAME = "ODDS_BACKEND_STATUS_SERVICE_ACCOUNT";
const SYNTHETIC_VALUE = "test-status@offline.invalid";
const SYNTHETIC_PROJECT = "offline-fixture-only";
const INDEX = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

function packageVersion(name) {
  return JSON.parse(
    fs.readFileSync(require.resolve(name + "/package.json"), "utf8")
  ).version;
}

function extractStatus() {
  const declaration =
    'const oddsBackendStatusServiceAccount = defineString("' + NAME + '");';
  assert.equal(INDEX.split(declaration).length - 1, 1);
  assert.equal(INDEX.includes('defineString("' + NAME + '",'), false);
  const first = INDEX.indexOf("exports.oddsBackendStatus = onCall(");
  assert.ok(first >= 0);
  const end = INDEX.indexOf("\n);\n", first);
  assert.ok(end > first);
  const status = INDEX.slice(first, end + 4);
  assert.equal((status.match(/serviceAccount:/g) || []).length, 1);
  const exports = {};
  vm.runInNewContext(declaration + "\n" + status, {
    exports,
    defineString: sdkParams.defineString,
    onCall: sdkHttps.onCall,
    HttpsError: sdkHttps.HttpsError,
  }, { timeout: 2000 });
  const callable = exports.oddsBackendStatus;
  assert.equal(typeof callable, "function");
  const param = sdkParams.declaredParams.filter(p => p.name === NAME);
  assert.equal(param.length, 1);
  return { callable, param: param[0] };
}

const { callable, param } = extractStatus();
const endpoint = callable.__endpoint;
const spec = param.toSpec();

// Translate only the SDK fields relevant to this synthetic CLI-resolver
// fixture: the SDK calls the field serviceAccountEmail; firebase-tools
// Build calls it serviceAccount. This translation deliberately does NOT
// claim to exercise production manifest discovery or the deploy command.
const syntheticBuild = {
  requiredAPIs: [],
  params: [spec],
  endpoints: {
    oddsBackendStatus: {
      entryPoint: "oddsBackendStatus",
      region: endpoint.region,
      platform: endpoint.platform,
      runtime: "nodejs22",
      callableTrigger: endpoint.callableTrigger,
      serviceAccount: endpoint.serviceAccountEmail.toCEL(),
      maxInstances: endpoint.maxInstances,
    },
    untouchedSibling: {
      entryPoint: "untouchedSibling",
      region: ["europe-west1"],
      platform: "gcfv2",
      runtime: "nodejs22",
      callableTrigger: {},
    }
  }
};
const config = { projectId: SYNTHETIC_PROJECT };

function resolve(userEnvs) {
  return cliBuild.resolveBackend({
    build: syntheticBuild,
    firebaseConfig: config,
    userEnvs,
    codebase: "default",
    nonInteractive: true,
    isEmulator: true, // prevents Secret Manager resolution (no secrets here).
  });
}

test("D15.20 runs pinned, real Firebase Tools and Functions packages on Node22", () => {
  assert.equal(process.versions.node.split(".")[0], "22");
  assert.equal(packageVersion("firebase-tools"), "15.28.2");
  assert.equal(packageVersion("firebase-functions"), "6.4.0");
  assert.equal(typeof cliBuild.resolveBackend, "function");
  assert.equal(typeof cliParams.resolveParams, "function");
  assert.equal(spec.name, NAME);
  assert.equal(spec.type, "string");
  assert.equal(Object.prototype.hasOwnProperty.call(spec, "default"), false);
});

test("D15.20 real CLI resolves the SDK CEL param to the synthetic status identity", async () => {
  assert.equal(syntheticBuild.endpoints.oddsBackendStatus.serviceAccount,
    "{{ params." + NAME + " }}");
  const { backend, envs, secretRefs } = await resolve({ [NAME]: SYNTHETIC_VALUE });
  assert.deepEqual(secretRefs, {});
  const perRegion = backend.endpoints["europe-west1"];
  assert.ok(perRegion);
  assert.deepEqual(Object.keys(perRegion).sort(),
    ["oddsBackendStatus", "untouchedSibling"]);
  const status = perRegion.oddsBackendStatus;
  assert.equal(status.serviceAccount, SYNTHETIC_VALUE);
  assert.equal(status.region, "europe-west1");
  assert.equal(status.platform, "gcfv2");
  assert.equal(status.maxInstances, 2);
  assert.ok(status.callableTrigger);
  assert.equal(envs[NAME].asString(), SYNTHETIC_VALUE);
  assert.equal(backend.requiredAPIs.length, 0);
  assert.equal(Object.hasOwn(perRegion.untouchedSibling, "serviceAccount"), false);
});

test("D15.20 missing required param fails non-interactively before a backend is returned", async () => {
  await assert.rejects(
    resolve({}),
    err => /non-interactive mode/i.test(err.message) && err.message.includes(NAME)
  );
});

test("D15.20 one invalid unknown CEL parameter cannot silently adopt identity", () => {
  const broken = {
    ...syntheticBuild,
    endpoints: {
      ...syntheticBuild.endpoints,
      oddsBackendStatus: {
        ...syntheticBuild.endpoints.oddsBackendStatus,
        serviceAccount: "{{ params.UNDEFINED_TEST_IDENTITY }}"
      }
    }
  };
  const knownValue = new cliParams.ParamValue(SYNTHETIC_VALUE, false, {
    string: true, boolean: false, number: false, list: false
  });
  assert.throws(() => cliBuild.toBackend(broken, { [NAME]: knownValue }));
});

test("D15.20 real CLI probe makes no project/network/provider requests", () => {
  assert.equal(attemptedNetworkCalls, 0);
});
