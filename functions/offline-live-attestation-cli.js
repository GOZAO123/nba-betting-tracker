"use strict";

// D15.23 local stdin-only intake of an intentionally redacted summary.
// Do NOT pipe raw gcloud/Firebase JSON (which can include secrets, envs, or
// resource identifiers). Never calls Google/Firebase/Cloud Run.
const fs = require("node:fs");
const path = require("node:path");
const { assessRedactedAttestation } = require("./offline-live-attestation-review");

const MAX_BYTES = 32000;
async function main() {
  if (process.argv.length !== 2) throw Error("Unexpected arguments");
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw Error("Input too large");
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks, size).toString("utf8");
  const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const result = assessRedactedAttestation(input, source);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  // Exit 0 means *shape matched*, NEVER permission to deploy.
  process.exitCode = result.summaryMatches ? 0 : 2;
}
main().catch(() => {
  // No parsed input, raw errors, paths or principal identifiers are echoed.
  process.stdout.write(JSON.stringify({
    status: "BLOCKED",
    releaseReady: false,
    paidProviderAllowed: false,
    cloudChangesAuthorized: false,
    summaryMatches: false,
    blockers: ["OFFLINE_ATTESTATION_UNAVAILABLE"]
  }) + "\n");
  process.exitCode = 2;
});
