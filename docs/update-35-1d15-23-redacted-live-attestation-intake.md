# Update 35.1D15.23 — Offline redacted live-metadata evidence intake

> **DRAFT / OFFLINE-ONLY. NOT A CLOUD REVIEW OR DEPLOYMENT APPROVAL.**
> This milestone creates an intake validator for a possible *future*, separately
> authorized read-only owner observation. It does not look up project metadata,
> use Firebase/gcloud commands, read source archives or secrets, grant IAM,
> deploy/dry-run, merge a PR, invoke callables or contact OddsPapi.
>
> Always: `releaseReady:false`, `paidProviderAllowed:false`,
> `cloudChangesAuthorized:false`.

## Starting state, stack and purpose

- Started 20 November 2026. `main` verified at
  `c508c6e27c1d42c699ffd6b0cffb59be6c18fce9`.
- This PR stacks on [draft #72](https://github.com/GOZAO123/nba-betting-tracker/pull/72)
  head `5b434b6463e92ad38bc84d814dbf9950271a90b2`.
  #72 stacks on still-draft #71 → #70 → #69 → #67;
  independent documentation-only #68 is separate and unmerged.
- D15.12's existing `firebase functions:list` table validator verifies 15 known names,
  runtime, region and triggers from owner-pasted read-only output. D15.22 invokes
  the **real pinned Firebase CLI** target filtering and deletion planner, but with
  synthetic 14/15 inventories; it does NOT attest actual remote metadata.
- **D15.23 addresses only the evidence intake gap:** accept a strictly
  **redacted**, **manually supplied**, fresh classification of Function metadata.
  It intentionally does *not* accept raw `gcloud functions describe`,
  Cloud Run YAML, IAM policy or `firebase` JSON, any of which may include
  environment values, resource/principal identifiers or secrets.

Files added relative to PR #72:
1. `functions/offline-live-attestation-review.js` — pure Node parser; cross-checks
   the existing canonical 14/15 names, source export list and hard-disabled
   diagnostic/six-per-UTC-day cap.
2. `functions/offline-live-attestation-cli.js` — stdin-only CLI with bounded
   input and sanitized JSON output; does not write files, read arbitrary paths,
   query credentials or access production.
3. `functions/offline-live-attestation-review.test.js` — structural, drift,
   malicious-content, timestamp and redaction regressions.
4. `.github/workflows/offline-live-attestation-intake.yml` — Node 22,
   read-only permissions, no `npm install` and no Firebase/Google command.
5. This document.

No edits to `functions/index.js`, `firebase.json`, `functions/package.json`,
existing Functions, Firestore rules, client, quota, scheduled ESPN settlement
or service-account configuration.

## Evidence contract (no sensitive data)

Input is **not** a raw Google Cloud response. It is a small allowlisted
JSON summary that must be prepared **locally** from a separate approved
read-only review. Its only root fields are:

```json
{
  "schemaVersion": "d15.23/v1",
  "observedAtUtc": "YYYY-MM-DDTHH:mm:ssZ",
  "method": "owner-readonly-console-summary",
  "functions": []
}
```

The `functions` array must contain **exactly 15 objects**, one per known
deployed Function. Each row has exactly these allowlisted fields:

```json
{
  "id": "oddsBackendStatus",
  "generation": "v2",
  "region": "europe-west1",
  "runtime": "nodejs22",
  "trigger": "callable",
  "state": "ACTIVE",
  "codebase": "default",
  "firebaseManaged": "yes",
  "runtimeIdentity": "default-compute",
  "revisionTraffic": "single-100"
}
```

**Examples are fictional structural illustrations, not current cloud
attestations.** Each actual field must be explicitly observed rather than
filled in from this example, source expectations or past screenshots.

Accepted root `method`: `owner-readonly-console-summary` or
`owner-readonly-cli-summary`. This field is self-reported and is
**not a cryptographically verified provenance statement**.

- `codebase`: preserve the **raw observed classification**. Explicit `default`
  or observed `unlabeled` are accepted for the Firebase **default** codebase:
  pinned `firebase-tools@15.28.2` omits the label when writing the default
  codebase and interprets its absence as `default` when reading.
  **Unknown, empty, omitted, non-default or unobserved labels still block.**
  Never fill `unlabeled` merely because a label was not inspected.
  [CLI reading](https://github.com/firebase/firebase-tools/blob/v15.28.2/src/gcp/cloudfunctions.ts#L593)
  and [writing](https://github.com/firebase/firebase-tools/blob/v15.28.2/src/gcp/cloudfunctions.ts#L724-L731).
- `firebaseManaged`: source-backed 14 Functions require a verified
  `yes`. Separately deployed `oddsPapiAccountPreflight` may be
  `yes` or `no` **only if observed**, and either case leaves the
  blanket-deployment prohibition in force; unknown blocks.
- `runtimeIdentity`: `default-compute` for 14 previously observed
  Functions, `dedicated` for the hard-disabled
  `oddsPapiNbaIdentitySchemaDiagnostic`. Do NOT supply principal emails,
  UID, project number or service account details.
- `revisionTraffic`: `single-100` only if actual revision traffic
  shows a single active 100% revision. Unknown/split blocks; do not
  invent or reveal revision IDs/hashes.
- `observedAtUtc`: canonical UTC timestamp, no older than 24 hours
  and no more than five minutes in the future. These are freshness
  checks against local machine time, not proof of the cloud clock.

Rejects missing/duplicate/unknown function names, extra 16th Function,
region/runtime/generation/trigger/state/codebase/identity/management/traffic
drift, malformed/stale summary, unrecognized fields and quota/source drift.
Unknown function names and unexpected raw values are **never echoed**.
There is no support for an `environmentVariables`,
`serviceAccountEmail`, `sourceArchiveUrl`, `revisionName`, `rawLabels`
or credentials field. If these appear, review blocks.

### How to use in a *future separately authorized* PC session

**No production command is approved by this PR.** When the user separately
authorizes a read-only metadata session, carefully inspect the Firebase
Functions and Cloud Run *metadata only* and prepare a 15-row, fully
redacted JSON summary in a temporary **local** file outside the Git
checkout. **Never paste raw environment variables, full service-account
emails, IAM bindings, keys, project numbers, revision source downloads or
raw Cloud Run YAML into GitHub or chat.**

Only after the validator is present in an explicitly chosen local checkout,
the owner can run this **local-only** Node command from the repository root:

```powershell
Get-Content -Raw -Encoding UTF8 "PATH_TO_PRIVATE_REDACTED_SUMMARY.json" |
  node .\functions\offline-live-attestation-cli.js
```

The path is a placeholder, not a real user file. Do not check that
temporary JSON file into Git or upload it to chat. The script reads
stdin and the local `functions/index.js` source, prints allowlisted
counts and known mismatched function names, never raw source values,
and does not store evidence. Exit 0 means that the **shape and
expected values of the supplied summary matched**; it does **not**
authorize any deployment. Exit 2 means a local review failed.
Even a passing summary always reports `status:BLOCKED` and all
three release gates false. If any field cannot be safely observed,
use `unknown` where applicable and accept BLOCKED.

## What cannot be claimed from this milestone

- No fresh live 15/15 metadata has been inspected during this update.
- The owner-supplied JSON may be inaccurate or fabricated. The
  script cannot prove the origin, freshness or authenticity of manual
  claims, beyond validating its supplied timestamp.
- Codebase/management classification may be absent, inconsistent or
  different in deployed raw labels. Do not treat this validator as
  independent verification of those labels.
- It cannot verify effective IAM inheritance/denies, deployer
  `actAs`, Cloud Run Invoker, application Firebase Auth, secret bindings,
  protected Firestore access, source equivalence, archival recovery,
  private environments or exact revision/config rollback.
- Node syntax/tests and read-only CI are not evidence of production
  deployment success. No deployment or production dry run has occurred.
- **D15.24 read-only owner observation (20 November 2026):** both
  `oddsPapiAccountPreflight` and `oddsBackendStatus` reported
  `firebaseManaged:yes`, `codebase:unlabeled`,
  `runtimeIdentity:default-compute`, active Node 22 in `europe-west1`,
  and exactly one Cloud Run revision traffic entry with 100% allocation.
  No raw principal or revision was retained. This is **two of 15** Functions
  and is not a complete revision inventory or source provenance attestation.
  D15.22's blanket deletion finding is still **synthetic**, and the
  separately deployed preflight remains at risk from an inappropriate
  unfiltered deployment. Neither live Function was changed.
- Current costs, billing and provider expense remain unverified by this
  offline stage. No OddsPapi requests were made.

The next decision after an independently authorized fresh read-only
metadata review would be whether to approve a **separate**, bounded
source/config rollback and effective-IAM evidence plan. A production
`firebase deploy --dry-run` is **not** a substitute; Firebase may
enable APIs during its deployment lifecycle.

Preserve all 15 deployed Functions, the separately deployed preflight,
the scheduled ESPN settlement, Google sign-in, protected research ledger,
Android/desktop viewport behavior, Lisbon HH:mm and 06:00 checklist
reset, hard-disabled diagnostics and maximum **six upstream OddsPapi
diagnostic requests per UTC day**. Do not remove default Compute Editor,
adjust Cloud Run ingress/public Invoker or change any IAM without
separate explicit approval.

## D15.24 narrow correction — observed default-codebase label

The owner independently ran read-only, redacted `gcloud functions describe`
and `gcloud run services describe` commands on 20 November 2026 for only
`oddsBackendStatus` and `oddsPapiAccountPreflight`. Both returned
`codebase:"unlabeled"`, `firebaseManaged:"yes"`, default Compute
identity classification, active Node 22/`europe-west1`, and
`revisionTraffic:"single-100"`. Actual service names, emails, secrets
and revision IDs were not included in the shared evidence.

The earlier D15.23 validator erroneously required the raw label to be the
literal `default`. Pinned Firebase CLI code explicitly treats a missing
`firebase-functions-codebase` label as the default and does not write
that label for default deployments. The corrected validator preserves
`unlabeled` as the observed raw classification and accepts it for
shape checks **only**. Missing `codebase` key, `null`, `unknown`, empty
string and non-default labels continue to fail closed; no release gate
can become true. The synthetic D15.22 planner already models the CLI's
normalized `default` codebase, so this correction does not alter
D15.22, Firebase CLI deploy behavior, or any live Function.

The other 13 deployed Functions' current raw codebase labels and Cloud Run
traffic have **not** been inspected in this D15.24 session. Do not build
a 15/15 report using hypothetical values. Effective IAM, source fingerprint,
rollback archives, billing and approval remain separate blockers.

D15.24 corrected validator CI [#44713016657](https://github.com/GOZAO123/nba-betting-tracker/actions/runs/44713016657)
**SUCCESS: 25/25 tests passed**, covering explicit unlabeled-default metadata for
both observed Functions plus continued rejection of unknown/non-default/missing
labels. Backend [#44713016638](https://github.com/GOZAO123/nba-betting-tracker/actions/runs/44713016638)
**SUCCESS: 592/592 passed**, Node.js 22 syntax and regressions. This is offline
validation only; no production deployment or external provider request.

## CI evidence

- D15.22 parent: [30/30 pinned CLI discovery/planner tests](https://github.com/GOZAO123/nba-betting-tracker/actions/runs/44707392027),
  [592/592 backend regression](https://github.com/GOZAO123/nba-betting-tracker/actions/runs/44707392005).
- D15.23 Node 22 redacted intake tests: [workflow #44709297462](https://github.com/GOZAO123/nba-betting-tracker/actions/runs/44709297462) **SUCCESS — 22/22 passed**, syntax checks passed, no npm installation, no Firebase environment artifacts or tracked edits.
- D15.23 backend regression: [workflow #44709297362](https://github.com/GOZAO123/nba-betting-tracker/actions/runs/44709297362) **SUCCESS — 592/592 passed**, syntax lint passed.

First D15.23 intake workflow [#44709183690](https://github.com/GOZAO123/nba-betting-tracker/actions/runs/44709183690) failed three tests (19/22) because its test helper expected `Object.freeze` to survive `JSON.stringify`/`JSON.parse` across a spawned CLI process. Commit `38a12a4c82ba73cb5b6798b566aff34e3affd5cc` corrected **the tests only**, checking immutability on in-process objects and all release gates on CLI JSON. Both follow-up CI runs passed. This was not a production/cloud failure.

**Release verdict: BLOCKED.**
