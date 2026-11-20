"use strict";

// D15.21: import the real Firebase Functions SDK's *wire* exporter, then the
// real Firebase CLI v15.28.2 v1alpha1 parser and noninteractive resolver.
// Evaluate the actual proposed index.js only inside a restricted, disconnected
// VM: real SDK registration; mocked Admin and trusted helper modules.
// NEVER load the actual Node module, real Admin SDK, Firebase CLI command
// entrypoint, deployment service, remote credentials or production project.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// No network should be opened in the execution process. This interception
// does not guarantee OS-level isolation, and public npm installation occurs
// before this test starts.
let blockedNetwork = 0;
function rejectNetwork() {
  blockedNetwork++;
  throw new Error("D15.21 attempted network request (blocked)");
}
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
net.Socket.prototype.connect = rejectNetwork;
net.connect = rejectNetwork;
net.createConnection = rejectNetwork;
tls.connect = rejectNetwork;
http.request = rejectNetwork;
http.get = rejectNetwork;
https.request = rejectNetwork;
https.get = rejectNetwork;
dns.lookup = rejectNetwork;
dns.resolve = rejectNetwork;
globalThis.fetch = rejectNetwork;

const sdkHttps = require("firebase-functions/v2/https");
const sdkScheduler = require("firebase-functions/v2/scheduler");
const sdkParams = require("firebase-functions/params");
const sdkPath = path.resolve(path.dirname(require.resolve("firebase-functions/params")), "..");
const sdkLoader = require(path.join(sdkPath, "runtime", "loader.js"));
const sdkManifest = require(path.join(sdkPath, "runtime", "manifest.js"));
const cliWire = require("firebase-tools/lib/deploy/functions/runtimes/discovery/v1alpha1");
const cliBuild = require("firebase-tools/lib/deploy/functions/build");

const INDEX = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const NAME = "ODDS_BACKEND_STATUS_SERVICE_ACCOUNT";
const SYNTHETIC_VALUE = "status-only@offline.invalid";
const PROJECT = "offline-fixture-only";
const EXPECTED = [
  "oddsBackendStatus",
  "oddsPapiTournamentProbe",
  "oddsPapiNbaOddsProbe",
  "oddsPapiDetailedPropsProbe",
  "oddsPapiMarketCatalogProbe",
  "oddsPapiVerifiedPropsProbe",
  "oddsPapiNbaFeasibilityProbe",
  "oddsPapiNbaMarketAudit",
  "oddsPapiNbaIdentitySchemaDiagnostic",
  "ledgerCaptureProspective",
  "ledgerBatchCaptureProspective",
  "ledgerSettleProspective",
  "ledgerAutoSettleProspective",
  "ledgerReconcileReviewedInactive"
].sort();

let fakeAppInit = 0;
let accessedProtectedResource = 0;
function forbidAccess() {
  accessedProtectedResource++;
  throw new Error("D15.21 attempted forbidden protected-resource access");
}
const inertRunner = () => async () => {
  throw new Error("D15.21 mocked runner must never execute");
};
const helperModules = Object.freeze({
  "./odds-feasibility": {
    makeFeasibilityRunner: inertRunner,
    readLimitedJson: forbidAccess,
    readMarketCatalogueJson: forbidAccess,
  },
  "./league-market-audit-runner": { makeLeagueMarketAuditRunner: inertRunner },
  "./manual-audit-evidence-dispatch": { makeManualAuditEvidenceDispatch: inertRunner },
  "./manual-identity-shape-callable": { makeManualIdentityShapeCallable: inertRunner },
  "./batch-capture": { runBatchCapture: forbidAccess, MAX_BATCH_CAPTURE_ITEMS: 20 },
  "./auto-settlement": { runAutomaticSettlement: forbidAccess },
  "./reconcile-reviewed-inactive": {
    REVIEWED_CASE: Object.freeze({ recordId: "synthetic-only" }),
    reconcileReviewedInactive: forbidAccess
  }
});
function controlledRequire(moduleName) {
  if (moduleName === "firebase-functions/v2/https") return sdkHttps;
  if (moduleName === "firebase-functions/v2/scheduler") return sdkScheduler;
  if (moduleName === "firebase-functions/params") return sdkParams;
  if (moduleName === "firebase-admin/app") {
    return { initializeApp() { fakeAppInit++; return {}; } };
  }
  if (moduleName === "firebase-admin/firestore") {
    return {
      getFirestore: forbidAccess,
      Timestamp: { now: forbidAccess, fromMillis: forbidAccess },
      FieldValue: { serverTimestamp: forbidAccess }
    };
  }
  if (Object.prototype.hasOwnProperty.call(helperModules, moduleName)) {
    return helperModules[moduleName];
  }
  throw new Error("D15.21 unexpected import in source (offline discovery blocked)");
}

const sandbox = { exports: {}, require: controlledRequire, console: {
  log() {}, warn() {}, info() {}, error() {}
} };
vm.runInNewContext(INDEX, sandbox, { timeout: 5000, filename: "offline-index-review.js" });
const moduleExports = sandbox.exports;
const endpoints = {};
const requiredAPIs = [];
const extensions = {};
sdkLoader.extractStack(moduleExports, endpoints, requiredAPIs, extensions);
const sdkStack = {
  specVersion: "v1alpha1",
  endpoints,
  requiredAPIs: sdkLoader.mergeRequiredAPIs(requiredAPIs),
  extensions,
  params: sdkParams.declaredParams.map(p => p.toSpec())
};

// This is the same SDK conversion called by its discovery output endpoint.
// No manually remapped serviceAccountEmail -> serviceAccount is permitted.
const wireManifest = JSON.parse(JSON.stringify(sdkManifest.stackToWire(sdkStack)));
const wireJsonText = JSON.stringify(wireManifest);
const actualBuild = cliWire.buildFromV1Alpha1(wireManifest, PROJECT, "europe-west1", "nodejs22");
const discoveredNames = Object.keys(actualBuild.endpoints).sort();

async function resolveWithoutSecrets(userEnvs) {
  return cliBuild.resolveBackend({
    build: actualBuild,
    firebaseConfig: { projectId: PROJECT },
    userEnvs,
    codebase: "default",
    nonInteractive: true,
    isEmulator: true // Avoid any Secret Manager lookups; no secret value supplied.
  });
}

test("D15.21 evaluates actual 14-Function module in isolation with real SDK", () => {
  assert.equal(process.versions.node.split(".")[0], "22");
  assert.deepEqual(Object.keys(moduleExports).sort(), EXPECTED);
  assert.deepEqual(Object.keys(endpoints).sort(), EXPECTED);
  assert.deepEqual(discoveredNames, EXPECTED);
  assert.equal(fakeAppInit, 1, "Only a mocked Firebase initializeApp may be called");
  assert.equal(accessedProtectedResource, 0);
  assert.deepEqual(Object.keys(extensions), []);
  assert.ok(!discoveredNames.includes("oddsPapiAccountPreflight"),
    "Separately deployed preflight is absent from the repository source");
  assert.equal(discoveredNames.filter(n => n === "ledgerAutoSettleProspective").length, 1);
});

test("D15.21 real SDK wire format is parsed by real CLI without manual field mapping", () => {
  assert.equal(wireManifest.specVersion, "v1alpha1");
  assert.equal(wireManifest.endpoints.oddsBackendStatus.serviceAccountEmail,
    "{{ params." + NAME + " }}");
  assert.equal(actualBuild.endpoints.oddsBackendStatus.serviceAccount,
    "{{ params." + NAME + " }}");
  assert.deepEqual(wireManifest.params.filter(p => p.name === NAME).map(p => p.type),
    ["string"]);
  assert.equal(Object.prototype.hasOwnProperty.call(
    wireManifest.params.find(p => p.name === NAME), "default"), false);
  assert.ok(wireManifest.params.some(p => p.name === "ODDSPAPI_API_KEY" && p.type === "secret"));
  assert.equal(wireJsonText.includes(SYNTHETIC_VALUE), false);
});

test("D15.21 discovered complete codebase resolves status identity only", async () => {
  const { backend, envs, secretRefs } = await resolveWithoutSecrets({
    [NAME]: SYNTHETIC_VALUE
  });
  assert.deepEqual(secretRefs, {});
  const perRegion = backend.endpoints["europe-west1"];
  assert.ok(perRegion);
  assert.deepEqual(Object.keys(perRegion).sort(), EXPECTED);
  assert.equal(perRegion.oddsBackendStatus.serviceAccount, SYNTHETIC_VALUE);
  assert.equal(envs[NAME].asString(), SYNTHETIC_VALUE);
  const others = EXPECTED.filter(n =>
    n !== "oddsBackendStatus" && n !== "oddsPapiNbaIdentitySchemaDiagnostic");
  for (const n of others) {
    assert.notEqual(perRegion[n].serviceAccount, SYNTHETIC_VALUE);
    assert.ok(perRegion[n].serviceAccount == null,
      "No other Function should acquire a new explicit runtime identity: " + n);
  }
  assert.ok(typeof perRegion.oddsPapiNbaIdentitySchemaDiagnostic.serviceAccount === "string",
    "Preserve separately pinned disabled diagnostic identity");
  assert.notEqual(perRegion.oddsPapiNbaIdentitySchemaDiagnostic.serviceAccount, SYNTHETIC_VALUE);
  assert.ok(perRegion.ledgerAutoSettleProspective.scheduleTrigger,
    "Preserve scheduled settlement trigger");
  assert.equal(perRegion.oddsBackendStatus.platform, "gcfv2");
  assert.equal(perRegion.oddsBackendStatus.maxInstances, 2);
});

test("D15.21 required status param is discovered for whole codebase, not just one target", async () => {
  await assert.rejects(
    resolveWithoutSecrets({}),
    e => /non-interactive mode/i.test(e.message) && e.message.includes(NAME)
  );
  // The param is registered at *codebase* discovery scope. This is a
  // pre-deployment risk for any targeted CLI deploy of this codebase.
  assert.equal(actualBuild.params.filter(p => p.name === NAME).length, 1);
  assert.equal(actualBuild.endpoints.oddsBackendStatus.entryPoint, "oddsBackendStatus");
});

test("D15.21 real manifest and CLI discovery used no cloud/provider resources", () => {
  assert.equal(blockedNetwork, 0);
  assert.equal(accessedProtectedResource, 0);
});
