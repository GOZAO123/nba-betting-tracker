"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  SCHEMA_VERSION, SOURCE_NAMES, EXPECTED, PREFLIGHT, assessRedactedAttestation
} = require("./offline-live-attestation-review");

const SOURCE = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const CLI = path.join(__dirname, "offline-live-attestation-cli.js");
const NOW = Date.UTC(2026, 10, 20, 9, 10, 0);

function entry(id) {
  return {
    id,
    generation: "v2",
    region: "europe-west1",
    runtime: "nodejs22",
    trigger: id === "ledgerAutoSettleProspective" ? "scheduled" : "callable",
    state: "ACTIVE",
    codebase: "default",
    firebaseManaged: "yes",
    runtimeIdentity: id === "oddsPapiNbaIdentitySchemaDiagnostic"
      ? "dedicated" : "default-compute",
    revisionTraffic: "single-100"
  };
}
function baseline() {
  return {
    schemaVersion: SCHEMA_VERSION,
    observedAtUtc: "2026-11-20T09:09:00Z",
    method: "owner-readonly-cli-summary",
    functions: EXPECTED.map(entry)
  };
}
function assess(data, source = SOURCE, now = NOW) {
  return assessRedactedAttestation(JSON.stringify(data), source, now);
}
function blocked(result, inProcess = true) {
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.releaseReady, false);
  assert.equal(result.paidProviderAllowed, false);
  assert.equal(result.cloudChangesAuthorized, false);
  // JSON.parse of CLI stdout necessarily creates new, non-frozen objects.
  // Object.freeze is a property of the in-process report, not wire JSON.
  if (inProcess) {
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.blockers));
  }
}
function has(result, code) {
  assert.ok(result.blockers.includes(code), JSON.stringify(result.blockers));
}

test("D15.23 canonical 14-source plus separately deployed 15th live summary is never a release approval", () => {
  assert.equal(SOURCE_NAMES.length, 14);
  assert.equal(EXPECTED.length, 15);
  assert.ok(!SOURCE_NAMES.includes(PREFLIGHT));
  const report = assess(baseline());
  blocked(report);
  assert.equal(report.summaryMatches, true);
  assert.equal(report.expectedCount, 15);
  assert.equal(report.observedCount, 15);
  assert.equal(report.unexpectedCount, 0);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.mismatched, []);
  has(report, "REDACTED_SUMMARY_ORIGIN_NOT_INDEPENDENTLY_AUTHENTICATED");
  has(report, "ROLLBACK_SOURCE_AND_CONFIG_NOT_ATTESTED");
  has(report, "OWNER_CLOUD_CHANGE_APPROVAL_NOT_GRANTED");
});

test("D15.23 reviewer summary cannot establish live origin even when entirely fabricated", () => {
  const report = assess(baseline());
  blocked(report);
  assert.equal(report.summaryMatches, true);
  assert.equal(report.releaseReady, false);
});

test("D15.23 separately deployed preflight is mandatory regardless of 14 source exports", () => {
  const data = baseline();
  data.functions = data.functions.filter(row => row.id !== PREFLIGHT);
  const report = assess(data);
  blocked(report);
  assert.equal(report.summaryMatches, false);
  assert.deepEqual(report.missing, [PREFLIGHT]);
  has(report, "FUNCTION_COUNT_MISMATCH");
});

test("D15.23 missing or duplicated scheduled settlement is rejected", () => {
  for (const id of ["ledgerAutoSettleProspective", "oddsBackendStatus"]) {
    const data = baseline();
    const index = data.functions.findIndex(row => row.id === id);
    data.functions[index] = { ...entry("oddsPapiTournamentProbe") };
    const report = assess(data);
    blocked(report);
    assert.equal(report.summaryMatches, false);
    assert.ok(report.missing.includes(id) || report.blockers.includes("DUPLICATE_FUNCTION_METADATA"));
  }
});

test("D15.23 unexpected 16th function name is counted but never echoed", () => {
  const data = baseline();
  const sentinel = "SYNTHETIC_PRIVATE_ACCOUNT_OR_TOKEN_XYZ";
  data.functions.push(entry(sentinel));
  const report = assess(data);
  blocked(report);
  assert.equal(report.summaryMatches, false);
  assert.equal(report.unexpectedCount, 1);
  assert.equal(JSON.stringify(report).includes(sentinel), false);
  has(report, "UNEXPECTED_FUNCTION_PRESENT");
});

test("D15.23 rejects all environment, secret, principal, revision ID and URL fields", () => {
  const badFields = [
    ["serviceAccountEmail", "synthetic-private-principal"],
    ["environmentVariables", { ODDSPAPI_API_KEY: "PRIVATE" }],
    ["sourceArchiveUrl", "https://not-for-output.invalid/token"],
    ["revisionName", "private-revision-sentinel"],
    ["rawLabels", { "deployment-tool": "cli-firebase" }],
  ];
  for (const [key, value] of badFields) {
    const data = baseline();
    data.functions[0][key] = value;
    const report = assess(data);
    blocked(report);
    assert.equal(report.summaryMatches, false);
    has(report, "FUNCTION_METADATA_FIELDS_INVALID");
    assert.equal(JSON.stringify(report).includes(String(value)), false);
    assert.equal(JSON.stringify(report).includes(key), false);
  }
});

test("D15.23 unexpected top-level fields are forbidden, not silently ignored", () => {
  const data = baseline();
  data.credentials = "SYNTHETIC_PRIVATE_TOKEN";
  const report = assess(data);
  blocked(report);
  assert.equal(report.summaryMatches, false);
  has(report, "OFFLINE_ATTESTATION_SCHEMA_INVALID");
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_PRIVATE_TOKEN/);
});

test("D15.23 missing or wrongly typed row fields cannot be treated as evidence", () => {
  const cases = [
    row => { delete row.codebase; },
    row => { row.firebaseManaged = true; },
    row => { row.id = 42; },
    row => { row.revisionTraffic = null; },
  ];
  for (const mutate of cases) {
    const data = baseline();
    mutate(data.functions[0]);
    const report = assess(data);
    blocked(report);
    assert.equal(report.summaryMatches, false);
  }
});

test("D15.23 target and preflight unknown codebase or Firebase ownership fails closed", () => {
  for (const id of ["oddsBackendStatus", PREFLIGHT]) {
    for (const field of ["codebase", "firebaseManaged"]) {
      const data = baseline();
      data.functions.find(row => row.id === id)[field] = "unknown";
      const report = assess(data);
      blocked(report);
      assert.equal(report.summaryMatches, false);
      assert.ok(report.mismatched.includes(id));
    }
  }
});

test("D15.23 source-managed endpoint without Firebase management is a blocker", () => {
  const data = baseline();
  data.functions.find(row => row.id === "oddsBackendStatus").firebaseManaged = "no";
  const report = assess(data);
  blocked(report);
  assert.ok(report.mismatched.includes("oddsBackendStatus"));
});

test("D15.23 preflight with verified non-Firebase-managed label is still BLOCKED", () => {
  const data = baseline();
  data.functions.find(row => row.id === PREFLIGHT).firebaseManaged = "no";
  const report = assess(data);
  blocked(report);
  assert.equal(report.summaryMatches, true);
  has(report, "OWNER_CLOUD_CHANGE_APPROVAL_NOT_GRANTED");
});

test("D15.23 unknown/split revision traffic blocks even with correct names", () => {
  for (const traffic of ["unknown", "split", "0", "99"]) {
    const data = baseline();
    data.functions[0].revisionTraffic = traffic;
    const report = assess(data);
    blocked(report);
    assert.equal(report.summaryMatches, false);
    assert.ok(report.mismatched.includes(data.functions[0].id));
  }
});

test("D15.23 runtime identity or trigger drift blocks, including scheduled job", () => {
  for (const [id, field, value] of [
    ["oddsBackendStatus", "runtimeIdentity", "dedicated"],
    ["oddsPapiNbaIdentitySchemaDiagnostic", "runtimeIdentity", "default-compute"],
    ["ledgerAutoSettleProspective", "trigger", "callable"],
    [PREFLIGHT, "trigger", "scheduled"],
  ]) {
    const data = baseline();
    data.functions.find(row => row.id === id)[field] = value;
    const report = assess(data);
    blocked(report);
    assert.ok(report.mismatched.includes(id));
  }
});

test("D15.23 region/runtime/generation/state drift blocks and never authorizes cloud changes", () => {
  for (const [field, value] of [
    ["region", "us-central1"],
    ["runtime", "nodejs20"],
    ["generation", "v1"],
    ["state", "DELETING"],
  ]) {
    const data = baseline();
    data.functions[0][field] = value;
    const report = assess(data);
    blocked(report);
    assert.equal(report.summaryMatches, false);
  }
});

test("D15.23 invalid, old and future observation timestamps must be rejected", () => {
  for (const stamp of [
    "2026-11-18T08:00:00Z",
    "2026-11-20T09:20:01Z",
    "2026-11-20T09:09:00+00:00",
    "2026-02-30T09:09:00Z",
    "not-an-iso-date",
  ]) {
    const data = baseline();
    data.observedAtUtc = stamp;
    const report = assess(data);
    blocked(report);
    assert.equal(report.summaryMatches, false);
    assert.ok(report.blockers.some(b => b.startsWith("OBSERVATION_")));
  }
});

test("D15.23 missing/invalid method or schema versions are rejected", () => {
  for (const [field, value] of [
    ["schemaVersion", "d15.99/v1"],
    ["method", "synthetic-fixture"],
    ["method", "credentials"],
  ]) {
    const data = baseline();
    data[field] = value;
    const report = assess(data);
    blocked(report);
    assert.equal(report.summaryMatches, false);
    has(report, "OFFLINE_ATTESTATION_SCHEMA_INVALID");
  }
});

test("D15.23 checked-out source drift, disabled feature flags and six-slot diagnostic limit guard", () => {
  for (const source of [
    SOURCE.replace("exports.oddsBackendStatus = onCall(", "exports.statusRenamed = onCall("),
    SOURCE.replace("const NBA_PROVIDER_EVIDENCE_ENABLED = false;", "const NBA_PROVIDER_EVIDENCE_ENABLED = true;"),
    SOURCE.replace("const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;", "const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = true;"),
    SOURCE.replace("const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;", "const ODDSPAPI_REQUESTS_PER_UTC_DAY = 12;"),
  ]) {
    assert.notEqual(source, SOURCE);
    const report = assess(baseline(), source);
    blocked(report);
    assert.equal(report.summaryMatches, false);
    has(report, "SOURCE_OR_SAFETY_GUARDS_DRIFT");
  }
});

test("D15.23 rejects malformed JSON, extra arrays, null and oversized input", () => {
  for (const input of ["", "not json", "null", "[]", "{}", "x".repeat(32001)]) {
    const report = assessRedactedAttestation(input, SOURCE, NOW);
    blocked(report);
    assert.equal(report.summaryMatches, false);
  }
  const tooMany = baseline();
  tooMany.functions = Array.from({ length: 21 }, (_, i) => entry("other_" + i));
  const report = assess(tooMany);
  blocked(report);
  assert.equal(report.summaryMatches, false);
});

test("D15.23 stdin checker reads synthetic redacted input but always reports release BLOCKED", () => {
  const fixture = baseline();
  fixture.observedAtUtc = new Date(Date.now() - 60000).toISOString().slice(0, 19) + "Z";
  const child = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify(fixture), encoding: "utf8", timeout: 6000
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const report = JSON.parse(child.stdout);
  blocked(report, false);
  assert.equal(report.summaryMatches, true);
  assert.equal(report.expectedCount, 15);
  assert.equal(report.cloudChangesAuthorized, false);
});

test("D15.23 stdin checker never reflects raw credential-shaped input or unexpected names", () => {
  const secret = "SYNTHETIC_SECRET_DO_NOT_ECHO_987";
  const fixture = baseline();
  fixture.observedAtUtc = new Date(Date.now() - 60000).toISOString().slice(0, 19) + "Z";
  fixture.functions[0].serviceAccountEmail = secret;
  fixture.functions.push(entry("UNRECOGNIZED_" + secret));
  const child = spawnSync(process.execPath, [CLI], {
    input: JSON.stringify(fixture), encoding: "utf8", timeout: 6000
  });
  assert.equal(child.status, 2, child.stderr);
  assert.doesNotMatch(child.stdout, new RegExp(secret));
  blocked(JSON.parse(child.stdout), false);
});

test("D15.23 stdin checker disallows path arguments and excessive input bytes", () => {
  for (const args of [[CLI, "--read-credentials"], [CLI]]) {
    const child = spawnSync(process.execPath, args, {
      input: args.length === 1 ? "X".repeat(33000) : JSON.stringify(baseline()),
      encoding: "utf8", timeout: 6000
    });
    assert.equal(child.status, 2, child.stderr);
    const report = JSON.parse(child.stdout);
    blocked(report, false);
    assert.equal(report.summaryMatches, false);
    assert.equal(report.cloudChangesAuthorized, false);
  }
});

test("D15.23 review and CLI remain local-only with no Google/Firebase imports or transports", () => {
  const moduleText = fs.readFileSync(path.join(__dirname, "offline-live-attestation-review.js"), "utf8");
  const cliText = fs.readFileSync(CLI, "utf8");
  for (const source of [moduleText, cliText]) {
    assert.doesNotMatch(source, /require\(["'](?:firebase-admin|firebase-tools|google-auth-library)/);
    assert.doesNotMatch(source, /\bfetch\s*\(|\bhttps\.request\s*\(|\bhttp\.request\s*\(/);
    assert.doesNotMatch(source, /\bexecSync\s*\(|\bspawnSync\s*\(/);
  }
});
