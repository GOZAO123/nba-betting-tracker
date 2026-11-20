# Update 35.1D15.21 — Offline full-codebase Firebase SDK wire discovery

> **DRAFT / OFFLINE-ONLY / NOT A DEPLOYMENT OR MERGE APPROVAL.**
> No Firebase command, service-account provisioning, IAM edits, API
> enablement, production/development-project requests, Cloud Run changes,
> source archives, secret reads, Firestore writes or OddsPapi calls.
> `releaseReady:false`, `paidProviderAllowed:false`,
> `cloudChangesAuthorized:false` remain enforced as release gates.

## Status and exact stacked topology

This proposal is **stacked on unmerged [PR #70](https://github.com/GOZAO123/nba-betting-tracker/pull/70)**,
at previously checked head `61791f85d365babd6feee0dc11e3efc6744dde3e`.
PR #70 is stacked on unmerged [PR #69](https://github.com/GOZAO123/nba-betting-tracker/pull/69),
itself stacked on unmerged runtime-source [PR #67](https://github.com/GOZAO123/nba-betting-tracker/pull/67).
Documentation [PR #68](https://github.com/GOZAO123/nba-betting-tracker/pull/68)
is separate. GitHub `main` at start remains
`c508c6e27c1d42c699ffd6b0cffb59be6c18fce9`.
No parent or current PR can be merged without separate explicit owner approval.

D15.21 adds only:
- `functions/status-wire-discovery.test.js` — five new offline tests.
- `.github/workflows/offline-status-full-discovery.yml` — a
  dedicated Node 22 GitHub Actions check.
- This document.

No edits to `functions/index.js`, `functions/package.json`,
`firebase.json`, frontend, ledger, existing API quota, or rules.
The 15 live production Functions remain untouched.

## Technical advancement over D15.20

D15.20 fed an intentionally **manually translated synthetic
two-endpoint** Build to real CLI library code. This update examines
the **complete source export set** with real SDK registration and
real CLI wire parsing:

1. Load the **actual PR #67 `functions/index.js` text** into a
   restricted Node `vm`, with real pinned
   `firebase-functions@6.4.0` `onCall`, `onSchedule` and
   `defineString`/`defineSecret`. Intercept every `require`:
   only those SDK modules are real; Firebase Admin startup and
   trusted internal helper modules use explicit **inert stubs**.
   Do not import the application module via normal `require`.
   Provider/Firestore I/O is blocked; user-provided secrets and
   Google application credentials are never loaded.
2. Use Firebase's real internal `runtime/loader.extractStack`
   to discover Function exports; rebuild its in-memory stack,
   then run `runtime/manifest.stackToWire`, the same serialization
   step the SDK uses for its discovery endpoint.
3. Use actual `firebase-tools@15.28.2`
   `deploy/functions/runtimes/discovery/v1alpha1.buildFromV1Alpha1`
   on that wire manifest. **No hand-coded renaming** from
   `serviceAccountEmail` to `serviceAccount` in this update.
4. Use the same pinned CLI's `build.resolveBackend` with an
   invented project and synthetic service-account-like string.
   `nonInteractive:true` and `isEmulator:true` prevent missing
   secret references from triggering live Secret Manager calls.
5. Assert **exactly fourteen** source-declared Functions,
   including the scheduled ledger settlement; the separated
   `oddsPapiAccountPreflight` is **not in the source** and is
   **not** created, hidden, or deleted by this test.
6. Check the status option survives
   `SDK onCall → SDK stack extraction → SDK wire serialization
   → CLI v1alpha1 Build → CLI noninteractive parameter
   resolution` and is not applied to unrelated Functions.
   Preserve the pre-existing, hard-disabled identity-schema
   diagnostic's separately explicit identity without displaying
   its principal identifier.
7. Confirm missing `ODDS_BACKEND_STATUS_SERVICE_ACCOUNT`
   rejects the **codebase-wide** non-interactive resolver,
   even though only one Function references the parameter.

The test uses only local files, synthetic values, and local
Node library functions. It blocks ordinary Node network
transports during execution, but **does not** provide a true
OS-level network sandbox. Public npm package installation
still uses the npm registry before the test runs.
No real Firebase CLI deploy command or `--dry-run` is run.

## Correctly bounded claims

Passing this test would establish **offline SDK discovery plus real
CLI wire-parser/resolver compatibility** for a source evaluation
with Admin/trusted helper imports stubbed. It would not establish:

- the actual Firebase CLI's full authenticated deploy lifecycle,
  installed owner-PC Firebase version, local prompts, `.env` files,
  deployment planning, or implicit deletions;
- effective IAM permissions, required deployer/service-agent `actAs`,
  startup behavior with a real isolated identity, or protection
  from an owner-supplied overprivileged account;
- reproducible original deployed source, recoverable complete
  Cloud Functions configuration, staged test, or rehearsed
  single-Function rollback;
- production environment values (including two previously
  unclassified plain variable names), Cloud Run ingress,
  callable Invoker policy, 15/15 preservation, or current costs;
- any actual provider API behavior or bookmaker offer/odds data.

**Important limitation:** The runtime SDK `StringParam.value()`
returns an empty string if its runtime env variable is absent;
successful **CLI noninteractive validation** is not a runtime
fail-closed guarantee. The parameter is discovered for the
**whole codebase**, so future deployment of a different target
may still need its required value. This check makes that
configuration risk explicit, not resolved for production.

## Evidence ledger

| Stage | Validation |
| --- | --- |
| D15.17 source contract and offline backend tests | Previous CI **592/592 pass** on PR #67 |
| D15.19 real Firebase SDK metadata | Previous CI **6/6 pass** on PR #69 |
| D15.20 CLI internal resolver using two synthetic endpoints | Previous CI **5/5 pass** on PR #70 |
| D15.21 real SDK full-module isolated source discovery, wire export, CLI v1alpha1 Build, backend resolver | **Pending new GitHub Actions evidence** |
| D15.21 usual backend Node 22 regressions | **Pending new GitHub Actions evidence** |
| Production runtime identity/IAM/rollback, costs, source attestation | **BLOCKED and not attempted** |

Update the PR and issue only after the actual CI jobs conclude.
A failure is not an authorization to weaken policy checks,
permit real API access or run a deployment for diagnosis.

## Mandatory production protections

All 15 production Functions must remain intact. Do not perform a
blanket `firebase deploy --only functions` or any
`--force` deletion. The separately deployed preflight callable
is not sourced from the current `main`. Preserve existing
default-compute Editor role until an independently approved,
validated replacement and broader audit. Do not modify Google
sign-in, callable authentication, Cloud Run `allUsers` invocation,
Scheduler OIDC, Firebase cloud sync, research ledger rules,
Android/desktop behavior, Lisbon HH:mm times or the 06:00
checklist rollover.

Never increase/bypass the server-enforced **six upstream OddsPapi
diagnostic requests per UTC day**, enable hard-disabled
diagnostics, introduce polling, or spend paid provider requests
without separate explicit owner authorization.

Release may only be considered after **independently approved**
IAM inspection, privately attested deployed source and env
classification, source/config-accurate target-only rollback,
billing review, exact production inventory, and a separate
explicit production deployment approval.

**Release verdict: BLOCKED**, regardless of offline CI success.

## Public library references

- Firebase Functions v6.4.0
  `src/runtime/loader.ts`, `src/runtime/manifest.ts`:
  https://github.com/firebase/firebase-functions/tree/v6.4.0/src/runtime
- Firebase CLI v15.28.2
  `src/deploy/functions/runtimes/discovery/v1alpha1.ts`,
  `src/deploy/functions/build.ts`:
  https://github.com/firebase/firebase-tools/tree/v15.28.2/src/deploy/functions
- Firebase Functions deployment caveats:
  https://firebase.google.com/docs/functions/organize-functions
