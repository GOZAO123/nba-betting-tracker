# Update 35.1D15.19 — Disconnected real-SDK status manifest probe

> **STACKED DRAFT PR; OFFLINE-ONLY TEST EXECUTION.**
> No production IAM/service-account modification, Firebase deployment,
> dry-run, Cloud Run traffic change, Cloud source-archive inspection,
> Firestore mutation, live callable invocation or paid OddsPapi call.
> Keep `releaseReady:false`, `paidProviderAllowed:false`,
> `cloudChangesAuthorized:false`. Passing SDK metadata tests is NOT
> deployment authorization.

## Base and change scope

This draft branch is **based on [draft PR #67](https://github.com/GOZAO123/nba-betting-tracker/pull/67)**
at `0cd9de7dfe9da9dd8d61bf7382b95d596b7c4324`, **not on `main`**.
A stacked PR targeted at that branch shows only D15.19 work. Do not
merge either PR without explicit further approval, and do not mistake
a future stacked-PR merge for approval to ship PR #67 to `main`.
Documentation-only [draft PR #68](https://github.com/GOZAO123/nba-betting-tracker/pull/68)
remains separate and unmerged.

Files added:
1. `functions/status-sdk-manifest-probe.test.js`: six Node.js tests
   that load **real `firebase-functions` v6.4.0** and extract exactly
   the status parameter declaration and `oddsBackendStatus` callable
   block **from PR #67's actual `functions/index.js`**. The test does
   not import or start the whole production module.
2. `.github/workflows/offline-status-sdk-manifest.yml`: dedicated
   GitHub Actions job on Node 22. It installs **exact public npm
   versions** `firebase-functions@6.4.0` and `firebase-admin@13.4.0`
   with `--no-save --package-lock=false --ignore-scripts --no-audit
   --no-fund`; then runs the isolated test with Google/Firebase
   project and credential environment variables cleared. It checks
   that Git tracked files remain untouched and no `functions/.env*`
   files appeared. The workflow is triggered only for the new test
   or workflow path, and allows `contents: read`.
3. This document.

There is **no change** to `functions/index.js`, `functions/package.json`,
existing 592-test backend CI registration, frontend, Firestore,
production identity options or Firebase config in D15.19. GitHub
Actions may consume normal runner minutes; the test's network
interception starts **after** its public npm dependencies have
been downloaded. Do **not** describe the entire GitHub Actions
workflow as air-gapped or without external network use.

## What the real SDK test does

- Uses Firebase Functions' real `defineString` and `onCall`
  functions, not mocked SDK equivalents.
- Confirms the single parameter registration has type `string`,
  has **no source default**, and serializes as the parameter
  expression `params.ODDS_BACKEND_STATUS_SERVICE_ACCOUNT`.
- Confirms the proposed callable's SDK `__endpoint` metadata
  binds the exact parameter expression to the
  `serviceAccountEmail` field, the same `europe-west1` region,
  `gcfv2` platform and two maximum instances.
- Confirms an unrelated synthetic callable does **not** acquire
  the status parameter globally.
- Supplies only a synthetic, non-cloud email-like value to
  `StringParam.value()` and verifies it reads that synthetic
  runtime value, without invoking any Firebase API or contacting
  a project.
- Verifies the actual SDK's `.run()` direct-handler path returns
  the original static status for a synthetic authenticated user
  and rejects a missing authentication object.
- Before loading Firebase SDK, overrides ordinary Node `net`,
  `tls`, `http`, `https`, DNS and `fetch` paths to count-and-deny
  network attempts, then asserts zero observed attempts.
  This is a **code-level guard**, not OS firewall isolation or
  a proof about every possible native/child-process route.

### Critical negative finding

The Firebase SDK's `StringParam.value()` **does not itself reject**
a missing runtime environment variable; in v6.4.0 it evaluates
to an empty string. "No source default" therefore means the
Firebase CLI is **expected to prompt or require configuration
during a later deploy**, **not** that the SDK guarantees
fail-closed operation at runtime. The current parameter also
does not validate the supplied principal, its effective IAM,
or prevent configuration with an over-privileged account.
**No synthetic value from this test can be copied into a
production deployment.**

The SDK endpoint metadata's `serviceAccountEmail` expression
does **not** prove the Firebase CLI will correctly substitute
a concrete identity, prompt only the target Function, preserve
all other configuration, or grant the deployer `actAs`.

## Test/result ledger

| Check | Evidence / status |
| --- | --- |
| Previous D15.17 disconnected Node 22 source tests | **592/592 passed**, GitHub Actions run 44644832160; does not test the real SDK |
| D15.19 pinned real-SDK endpoint metadata | Await actual dedicated GitHub Actions result for this PR; do not claim success before the job completes |
| D15.19 isolation / no network attempts | Verified only to the degree explicitly instrumented by this test after npm installation |
| Actual owner-PC Firebase CLI version | **UNKNOWN**; `firebase-tools` is not pinned in the production repository |
| Real Firebase CLI discovery/prompt and deploy manifest substitution | **NOT TESTED**; no `firebase deploy` or `firebase deploy --dry-run` |
| Real identity creation, IAM, billing, live callable | **NOT TESTED / NOT AUTHORIZED** |
| Old deployed source and target-only rollback rehearsal | **BLOCKED**; old build image/source metadata is not an attested backup |
| Production 15/15 inventory | Only prior owner-observed snapshot; must be verified again before any future authorized deployment |

## Stop conditions and future approvals

- **All 15 live Functions must remain intact.** Source `main`
  exports 14 while `oddsPapiAccountPreflight` was separately
  deployed and is absent from the current repository source.
  A blanket Functions deploy, delete/`--force`, or release based
  solely on source exports is unsafe.
- Leave default compute Editor unchanged; do not grant
  unconditional Editor to a proposed new account. Any service
  account creation and tightly scoped deployer
  `iam.serviceAccounts.actAs` need separate explicit approval.
- Preserve callable authentication, current Cloud Run public
  Invoker/ingress boundary, the six-upstream-requests-per-UTC-day
  transactional provider limit, both disabled diagnostics,
  Google sign-in, ledger security, Scheduler OIDC and current
  Android/desktop/ESPN/Lisbon-time behavior.
- Preserve CI and PR #67 **unmerged**. Existing
  [D15.18 review](https://github.com/GOZAO123/nba-betting-tracker/pull/68)
  requires a production source archive/provenance match,
  verified target-only rollback, current effective IAM
  (including inherited roles, denies, policy boundaries),
  classification of two unrecognized pilot environment names,
  current billing and owner-specific deployment approval.
- No credentials, owner UID, production service-account address,
  secret version, environment value or private archive path
  is printed by this probe. Stop and investigate if SDK/package
  installation, source parsing or network denial reports errors.

**Outcome:** D15.19 is test-evidence gathering only. Even if
every SDK metadata check passes, the broader release verdict
remains **BLOCKED**. A new owner approval will be required
before any merge or new production-facing action.

## Public SDK references

- Firebase Functions v6.4.0 status registration/manifest source:
  https://github.com/firebase/firebase-functions/tree/v6.4.0/src
- Firebase parameter options and required env configuration:
  https://firebase.google.com/docs/functions/config-env
- Firebase v2 HTTPS `serviceAccount` expression support:
  https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.https.httpsoptions
- Firebase CLI deployment effects and implicit deletion:
  https://firebase.google.com/docs/functions/organize-functions
