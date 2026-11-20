"use strict";

// D15.22. Disconnected unit exercise of REAL firebase-tools@15.28.2
// selector, codebase grouping, filter-integrity and release planner modules.
// No firebase executable, deploy/dry-run, live credentials, Firebase project,
// production inventory discovery, or upstream provider is accessed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Deny ordinary Node networking BEFORE importing Firebase CLI libraries.
// Public npm installation is outside this interception, and this is not
// an operating-system-level network sandbox.
let networkAttempts = 0;
function denyNetwork() {
  networkAttempts++;
  throw new Error("D15.22 blocked a network attempt");
}
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
net.Socket.prototype.connect = denyNetwork;
net.connect = denyNetwork;
net.createConnection = denyNetwork;
tls.connect = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
dns.lookup = denyNetwork;
dns.resolve = denyNetwork;
globalThis.fetch = denyNetwork;

const cliHelper = require("firebase-tools/lib/deploy/functions/functionsDeployHelper");
const cliBackend = require("firebase-tools/lib/deploy/functions/backend");
const cliPrepare = require("firebase-tools/lib/deploy/functions/prepare");
const cliValidate = require("firebase-tools/lib/deploy/functions/validate");
const cliPlanner = require("firebase-tools/lib/deploy/functions/release/planner");
const { SOURCE_NAMES, EXPECTED, PREFLIGHT } =
  require("./offline-production-function-inventory");

const PROJECT = "offline-fixture-only";
const REGION = "europe-west1";
const TARGET = "oddsBackendStatus";
const EXACT_ONLY = "functions:default:oddsBackendStatus";
const CODEBASE = "default";
const SOURCE_TEXT = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const FIREBASE_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, "../firebase.json"), "utf8"));

function installedVersion(name, entry, level) {
  const resolved = path.resolve(path.dirname(require.resolve(entry)), level);
  return JSON.parse(fs.readFileSync(resolved, "utf8")).version;
}

function sourceExportNames() {
  return [...SOURCE_TEXT.matchAll(
    /exports\.([A-Za-z0-9_]+)\s*=\s*(?:onCall|onSchedule|onRequest)\s*\(/g
  )].map(m => m[1]).sort();
}

function config() {
  assert.equal(FIREBASE_JSON.functions.length, 1);
  assert.equal(FIREBASE_JSON.functions[0].source, "functions");
  assert.equal(FIREBASE_JSON.functions[0].codebase, CODEBASE);
  return [{ source: "functions", codebase: CODEBASE }];
}

// Synthetic endpoint metadata: no real principal, secret or actual cloud ID.
function endpoint(name, modifications = {}) {
  const scheduled = name === "ledgerAutoSettleProspective";
  const trigger = scheduled
    ? { scheduleTrigger: { schedule: "0 6 * * *", timeZone: "Etc/UTC" } }
    : { callableTrigger: {} };
  return {
    id: name,
    entryPoint: name,
    project: PROJECT,
    region: REGION,
    codebase: CODEBASE,
    platform: "gcfv2",
    runtime: "nodejs22",
    state: "ACTIVE",
    availableMemoryMb: 256,
    hash: name === TARGET ? "synthetic-existing-hash" : "synthetic-unchanged-hash",
    labels: { "deployment-tool": "cli-firebase", "firebase-functions-codebase": CODEBASE },
    ...trigger,
    ...modifications,
  };
}

function fixtures(opts = {}) {
  // Desired inventory contains only the 14 repository exports. Actual production
  // inventory is NOT fetched: this is a user-described 15-endpoint simulation.
  const wantEndpoints = SOURCE_NAMES.map(n => endpoint(n, {
    hash: n === TARGET ? "synthetic-proposed-hash" : "synthetic-unchanged-hash",
  }));
  const haveEndpoints = EXPECTED.map(n => endpoint(n));
  const status = haveEndpoints.find(e => e.id === TARGET);
  if (opts.statusRegion) status.region = opts.statusRegion;
  if (opts.statusCodebase) status.codebase = opts.statusCodebase;
  if (opts.statusTrigger === "scheduled") {
    delete status.callableTrigger;
    status.scheduleTrigger = { schedule: "0 6 * * *" };
  }
  if (opts.statusRuntime) status.runtime = opts.statusRuntime;
  if (opts.statusPlatform) status.platform = opts.statusPlatform;
  if (opts.removeStatus) haveEndpoints.splice(haveEndpoints.indexOf(status), 1);
  if (opts.removePreflight) {
    const index = haveEndpoints.findIndex(e => e.id === PREFLIGHT);
    haveEndpoints.splice(index, 1);
  }
  if (opts.extra) {
    haveEndpoints.push(endpoint("syntheticUnexpectedFunction", {
      labels: { "deployment-tool": "cli-firebase" }
    }));
  }
  if (opts.unmanagedPreflight) {
    haveEndpoints.find(e => e.id === PREFLIGHT).labels = {
      "deployment-tool": "synthetic-non-firebase"
    };
  }
  return {
    want: cliBackend.of(...wantEndpoints),
    have: cliBackend.of(...haveEndpoints),
  };
}

function names(backend) {
  return cliBackend.allEndpoints(backend).map(e => e.id).sort();
}

function parsedFilters(only) {
  return cliHelper.getEndpointFilters({ only }, config());
}

// This invokes the REAL CLI planner. We do not call CLI commands or
// fabricate deletion calculations. Plan is in-memory only and never applied.
async function rawPlan(fixture, only) {
  const filters = parsedFilters(only);
  const wantBackends = { [CODEBASE]: fixture.want };
  cliValidate.checkFiltersIntegrity(wantBackends, filters);
  cliPrepare.updateEndpointTargetedStatus(wantBackends, filters || []);
  const grouped = cliHelper.groupEndpointsByCodebase(
    wantBackends, cliBackend.allEndpoints(fixture.have)
  );
  return cliPlanner.createDeploymentPlan({
    wantBackend: fixture.want,
    haveBackend: grouped[CODEBASE],
    codebase: CODEBASE,
    projectId: PROJECT,
    filters,
  });
}

function operations(plan) {
  const changesets = Object.values(plan.regionalChangesets);
  return {
    create: changesets.flatMap(x => x.endpointsToCreate.map(e => e.id)).sort(),
    update: changesets.flatMap(x => x.endpointsToUpdate.map(e => e.endpoint.id)).sort(),
    delete: changesets.flatMap(x => x.endpointsToDelete.map(e => e.id)).sort(),
    skip: changesets.flatMap(x => x.endpointsToSkip.map(e => e.id)).sort(),
    recreate: changesets.flatMap(x => x.endpointsToUpdate
      .filter(e => e.deleteAndRecreate).map(e => e.endpoint.id)).sort(),
  };
}

function assertCanonicalInventories(fixture) {
  assert.deepEqual(sourceExportNames(), [...SOURCE_NAMES].sort(),
    "Repository export set has drifted");
  assert.equal(SOURCE_NAMES.length, 14);
  assert.equal(EXPECTED.length, 15);
  assert.equal(SOURCE_NAMES.includes(PREFLIGHT), false);
  assert.deepEqual(names(fixture.want), [...SOURCE_NAMES].sort(),
    "Desired source inventory must be exactly 14 exports");
  assert.deepEqual(names(fixture.have), [...EXPECTED].sort(),
    "Any unknown, missing or duplicate production Function blocks approval");
  for (const e of [
    ...cliBackend.allEndpoints(fixture.want), ...cliBackend.allEndpoints(fixture.have)
  ]) {
    assert.equal(e.project, PROJECT);
    assert.equal(e.region, REGION, "Unexpected region blocks the review");
    assert.equal(e.codebase, CODEBASE, "Unexpected codebase blocks the review");
    assert.equal(e.platform, "gcfv2", "Unexpected generation blocks the review");
    assert.equal(e.runtime, "nodejs22", "Unexpected runtime blocks the review");
    assert.equal(Boolean(e.scheduleTrigger),
      e.id === "ledgerAutoSettleProspective", "Unexpected trigger blocks the review");
    assert.equal(Boolean(e.callableTrigger),
      e.id !== "ledgerAutoSettleProspective", "Unexpected trigger blocks the review");
  }
}

async function requireTargetOnlyPlan(fixture, only) {
  // Project-specific fail-closed policy ON TOP of the Firebase CLI semantics.
  // Other CLI-valid selectors are not approved by this policy.
  assert.equal(only, EXACT_ONLY,
    "Missing, broad, ambiguous or incorrect --only target is forbidden");
  assertCanonicalInventories(fixture);
  const filters = parsedFilters(only);
  assert.deepEqual(filters, [{ codebase: CODEBASE, idChunks: [TARGET] }]);
  assert.deepEqual(cliBackend.allEndpoints(fixture.want)
    .filter(e => cliHelper.endpointMatchesAnyFilter(e, filters))
    .map(e => e.id), [TARGET]);
  const plan = await rawPlan(fixture, only);
  assert.deepEqual(operations(plan), {
    create: [], update: [TARGET], delete: [], skip: [], recreate: [],
  }, "Target-only plan must not create, delete or touch any other endpoint");
  assert.deepEqual(names(plan.plannedBackend), [TARGET]);
  assert.deepEqual(plan.secretAccessPlan, {});
  assert.equal(plan.serviceAccountToCreate, undefined);
  assert.equal(plan.serviceAccountToDelete, undefined);
  assert.equal(plan.rolesToAdd, undefined);
  assert.equal(plan.rolesToRemove, undefined);
  // Passing this offline policy does NOT authorize a live deployment.
  return { status: "BLOCKED", releaseReady: false,
    paidProviderAllowed: false, cloudChangesAuthorized: false, plan };
}

test("D15.22 uses pinned real Firebase CLI on Node 22 and the repository's source list", () => {
  assert.equal(process.versions.node.split(".")[0], "22");
  assert.equal(installedVersion("firebase-tools",
    "firebase-tools", "../package.json"), "15.28.2");
  assert.equal(typeof cliPlanner.createDeploymentPlan, "function");
  assert.equal(typeof cliHelper.getEndpointFilters, "function");
  assert.equal(typeof cliPrepare.updateEndpointTargetedStatus, "function");
  assert.deepEqual(sourceExportNames(), [...SOURCE_NAMES].sort());
  assert.equal(FIREBASE_JSON.functions[0].codebase, CODEBASE);
});

test("D15.22 exact codebase-targeted 14/15 plan only updates status", async () => {
  const fixture = fixtures();
  const result = await requireTargetOnlyPlan(fixture, EXACT_ONLY);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.releaseReady, false);
  assert.equal(result.paidProviderAllowed, false);
  assert.equal(result.cloudChangesAuthorized, false);
  assert.ok(names(fixture.have).includes(PREFLIGHT));
});

test("D15.22 Firebase CLI explicitly excludes the preflight and scheduled settlement", async () => {
  const plan = await rawPlan(fixtures(), EXACT_ONLY);
  assert.deepEqual(operations(plan), {
    create: [], update: [TARGET], delete: [], skip: [], recreate: [],
  });
  assert.equal(names(plan.plannedBackend).includes(PREFLIGHT), false);
  assert.equal(names(plan.plannedBackend).includes("ledgerAutoSettleProspective"), false);
});

test("D15.22 accidental unfiltered deployment exposes missing managed preflight deletion", async () => {
  const plan = await rawPlan(fixtures(), undefined);
  const result = operations(plan);
  assert.ok(result.delete.includes(PREFLIGHT),
    "CLI must expose the synthetic managed preflight as a delete candidate");
  assert.equal(result.update.includes(TARGET), true);
  await assert.rejects(requireTargetOnlyPlan(fixtures(), undefined));
});

test("D15.22 bare functions and codebase-wide selector fail closed", async () => {
  for (const selector of ["functions", "functions:default"]) {
    const plan = await rawPlan(fixtures(), selector);
    assert.ok(operations(plan).delete.includes(PREFLIGHT));
    await assert.rejects(requireTargetOnlyPlan(fixtures(), selector));
  }
});

test("D15.22 unqualified status selector is CLI-valid but disallowed by exact-policy gate", async () => {
  const plan = await rawPlan(fixtures(), "functions:oddsBackendStatus");
  assert.deepEqual(operations(plan).update, [TARGET]);
  assert.deepEqual(operations(plan).delete, []);
  await assert.rejects(requireTargetOnlyPlan(fixtures(), "functions:oddsBackendStatus"));
});

test("D15.22 missing, incorrect or surplus target selectors are rejected", async () => {
  for (const only of [
    "", "hosting", "functions:default:missingFunction",
    "functions:default:oddsBackendStat",
    "functions:default:oddsPapiAccountPreflight",
    EXACT_ONLY + ",functions:default:ledgerAutoSettleProspective",
    EXACT_ONLY + ",functions:default:oddsPapiAccountPreflight",
    "functions:another-codebase:oddsBackendStatus",
  ]) {
    await assert.rejects(requireTargetOnlyPlan(fixtures(), only));
  }
  assert.throws(() => cliValidate.checkFiltersIntegrity(
    { default: fixtures().want },
    parsedFilters("functions:default:oddsPapiAccountPreflight")
  ));
});

test("D15.22 mismatch of status region would imply create/delete, and is blocked", async () => {
  const fixture = fixtures({ statusRegion: "us-central1" });
  const plan = await rawPlan(fixture, EXACT_ONLY);
  assert.deepEqual(operations(plan).create, [TARGET]);
  assert.deepEqual(operations(plan).delete, [TARGET]);
  await assert.rejects(requireTargetOnlyPlan(fixtures({ statusRegion: "us-central1" }), EXACT_ONLY));
});

test("D15.22 missing source-matched status candidate would create and is blocked", async () => {
  const fixture = fixtures({ removeStatus: true });
  const plan = await rawPlan(fixture, EXACT_ONLY);
  assert.deepEqual(operations(plan).create, [TARGET]);
  await assert.rejects(requireTargetOnlyPlan(fixtures({ removeStatus: true }), EXACT_ONLY));
});

test("D15.22 cross-codebase collision and runtime drift fail closed", async () => {
  for (const options of [
    { statusCodebase: "another-codebase" },
    { statusRuntime: "nodejs20" },
    { statusPlatform: "gcfv1" },
  ]) {
    await assert.rejects(requireTargetOnlyPlan(fixtures(options), EXACT_ONLY));
  }
});

test("D15.22 incompatible callable/scheduled identity fails closed", async () => {
  await assert.rejects(requireTargetOnlyPlan(fixtures({ statusTrigger: "scheduled" }), EXACT_ONLY));
  await assert.rejects(rawPlan(fixtures({ statusTrigger: "scheduled" }), EXACT_ONLY));
});

test("D15.22 unexpected extra or missing preflight cannot pass inventory guard", async () => {
  await assert.rejects(requireTargetOnlyPlan(fixtures({ extra: true }), EXACT_ONLY));
  await assert.rejects(requireTargetOnlyPlan(fixtures({ removePreflight: true }), EXACT_ONLY));
  const extraPlan = await rawPlan(fixtures({ extra: true }), EXACT_ONLY);
  assert.deepEqual(operations(extraPlan).delete, [],
    "A correctly scoped target ignores an unknown synthetic 16th Function");
});

test("D15.22 Firebase-managed label affects blanket-delete candidates, not approval", async () => {
  const unmanaged = fixtures({ unmanagedPreflight: true });
  const unfiltered = await rawPlan(unmanaged, undefined);
  assert.equal(operations(unfiltered).delete.includes(PREFLIGHT), false);
  const targeted = await requireTargetOnlyPlan(fixtures({ unmanagedPreflight: true }), EXACT_ONLY);
  assert.equal(targeted.cloudChangesAuthorized, false);
});

test("D15.22 planning stayed offline with no attempted Node transports", () => {
  assert.equal(networkAttempts, 0);
});
