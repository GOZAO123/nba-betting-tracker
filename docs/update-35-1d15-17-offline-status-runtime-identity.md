# Update 35.1D15.17 — Offline status runtime-identity implementation and tests

> **UNMERGED, UNDEPLOYED SOURCE PROPOSAL.** The owner authorized this offline-only
> implementation/testing phase, **not** merging, service-account creation, IAM
> changes, Firebase/Cloud Run deployment, live requests, source-archive reads
> or paid OddsPapi requests. The release gates remain `releaseReady:false`,
> `paidProviderAllowed:false`, `cloudChangesAuthorized:false`.

## Source baseline and deliberate scope

GitHub `main` at start: `c508c6e27c1d42c699ffd6b0cffb59be6c18fce9`,
after the documentation-only [D15.16 runbook](update-35-1d15-16-status-least-privilege-pilot-runbook.md)
was merged. Review [issue #1](https://github.com/GOZAO123/nba-betting-tracker/issues/1)
for owner-observed evidence and outstanding production blockers.

This draft changes only:
1. `functions/index.js`: declare a **required, default-free, deploy-time**
   Firebase string parameter `ODDS_BACKEND_STATUS_SERVICE_ACCOUNT` and reference
   the resulting expression via `serviceAccount` **only in**
   `exports.oddsBackendStatus` (existing region/max instances/App Check
   settings, Firebase `request.auth` and response remain unchanged).
2. `functions/status-runtime-identity.test.js`: disconnected Node 22 tests
   to check the required parameter and scope, unchanged callable auth/response
   in an isolated VM, absence of handler provider/Firestore/secret I/O,
   unchanged inventory/quota/flags, and an adverse synthetic I/O fixture.
3. `functions/package.json`: register the new test in existing backend
   syntax/Node test scripts; no dependency upgrades.
4. This documentation.

**No service-account address, user identity, UID, credential or environment
value is hardcoded.** The parameter has **no default and no fallback** to the
Editor-privileged compute identity in source. Its actual value must be
proposed privately and checked against a subsequently provisioned, isolated
identity **only after a separate approval**. This source change does not create
a Google Cloud resource, attach a runtime identity in production, or guarantee
the supplied address is least-privileged.

Firebase supports per-Function `serviceAccount` as a string or string
expression; required Firebase configuration parameters must be supplied at
deployment time. References:
- https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.https.httpsoptions
- https://firebase.google.com/docs/functions/config-env

## Hard blocker before merging or deploying

**Do not merge this PR just because offline tests pass.** Adding a required
Firebase deploy-time parameter can affect future Functions CLI source
discovery/deployment, even when only one handler references it. Its behavior
with this project's precise Firebase CLI version, existing codebase, active
Cloud Functions/Cloud Run configuration, and separately deployed preflight
has **not** been verified in a safe deployment environment.

No real service account exists merely because the source references one.
The current production `oddsBackendStatus` still executes under the existing
runtime identity. The old account's Editor grant must remain intact.

Before contemplating merge or targeted deployment, **all** of the following
must be resolved separately:
- Attest exact active deployed source, a recoverable matching pilot build/config
  and a tested **target-only** rollback. Image digest/source generation alone
  do not establish source equivalence or a usable rollback.
- Verify project/folder/org effective IAM (including inherited roles, denies,
  conditions and principal access boundaries), authorized deployer
  `iam.serviceAccounts.actAs`, managed build agents, and pilot startup
  dependency behavior under zero application-data IAM grants.
- Classify two previously unrecognized pilot plain environment variables
  privately without exposing their names or values in public issues.
- Preserve 15 existing production Functions: repo `main` exports 14,
  while `oddsPapiAccountPreflight` is **separately deployed and absent from
  `main`**. Never deploy all Functions or allow an accidental deletion.
  Unmerged preflight PR #17 is **not** deployed-source attestation.
- Preserve direct Cloud Run `allUsers` Invoker and `ALLOW_ALL` ingress
  initially; callable Firebase Authentication and public Cloud Run IAM
  invocation are separate. Do not make the status callable owner-only or
  enable App Check as an incidental change.
- Preserve all other runtime/deployment/invocation identities, including
  Scheduler's separate OIDC service account. Never remove default compute
  Editor until independent downstream migrations are proven and authorized.
- Preserve the transactional **six upstream OddsPapi requests per UTC day**
  production guard; identity-schema and provider-evidence flags remain false.
  No automatic provider polling or live paid API requests.
- Review cost/budget exposure, including any future staging, creation,
  deployment and archive metadata operations. The historical €0 net snapshot
  and €1 alert budget do not guarantee a hard zero-cost cap.

**A future release is blocked unless the owner separately approves**
the candidate IAM resource, any needed scoped deployer permission, an
explicitly enumerated target-only deployment, accepted rollback and live
test plan, and any potentially billable external operation. No deployment
commands are provided as an automatic runbook.

## Offline validation and exact limits

On a true checkout with Node 22, the implementation branch is intended
to run:

```powershell
npm.cmd --prefix .\functions run lint
npm.cmd --prefix .\functions test
node --test tests/research-dashboard.test.cjs
npm.cmd --prefix .\functions run preflight:evidence
```

The last command **must remain BLOCKED** (expected nonzero exit, not release
authorization). A documentation-only runbook does not grant a waiver to the
remaining preflight gates.

Unit tests use a **sandboxed, synthetic extraction of the status handler**,
rather than importing `functions/index.js` with real Firebase/Google APIs.
That can establish handler-level contract properties and absence of calls
within that isolated source block, **not** real Firebase SDK parameter
resolution, full-module startup side effects, effective IAM or actual deployed
Firebase callable behavior. The full backend test run helps detect unrelated
source regressions but does not replace live evidence.

The GitHub backend workflow is scoped to `functions/**` and therefore
should run for this PR; record its actual status separately. If CI fails,
do not merge or suppress it. Verification on Android/desktop and live
authentication must be separately owner-approved after safe rollback is
proven; do not claim those checks passed offline.

## Future release decision gates

| Milestone | Status |
| --- | --- |
| Create offline implementation branch and draft PR | Approved for preparation |
| Run offline tests and review GitHub diff | Authorized |
| Merge source-changing PR | **Not authorized** |
| Create dedicated runtime service account or grant `actAs` | **Not authorized** |
| Deploy or roll back any production Function | **Not authorized** |
| Inspect billable archive/source objects, run live callable or provider tests | **Not authorized** |
| Remove legacy default compute Editor or alter preflight | **Not authorized** |

**Release verdict: BLOCKED.** Retain `releaseReady:false`,
`paidProviderAllowed:false` and `cloudChangesAuthorized:false`.
