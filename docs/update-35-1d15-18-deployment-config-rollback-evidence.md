# Update 35.1D15.18 — Isolated deployment-configuration and rollback-readiness review

> **OFFLINE / DOCUMENTATION-ONLY REVIEW — NOT RELEASE AUTHORIZATION.**
> Nothing in this review authorizes merging [draft PR #67](https://github.com/GOZAO123/nba-betting-tracker/pull/67),
> creating or changing an IAM principal, enabling APIs, deploying/dry-running a
> Firebase project, reading source archives/secrets, changing Cloud Run traffic,
> deleting/replacing a Function, or invoking OddsPapi. Release gates stay
> `releaseReady:false`, `paidProviderAllowed:false` and `cloudChangesAuthorized:false`.

## Evidence checked (20 November 2026)

- GitHub `main`: `c508c6e27c1d42c699ffd6b0cffb59be6c18fce9`,
  the merged documentation-only D15.16 plan.
- PR #67 remains **DRAFT, OPEN, UNMERGED** at
  `0cd9de7dfe9da9dd8d61bf7382b95d596b7c4324`.
  Its five-file diff adds one status-only parameter expression, five
  isolated synthetic tests, one updated legacy identity-scope regression,
  test wiring and documentation.
- The GitHub Actions Node 22 backend job for that PR head reports
  **592 passed, 0 failed**. This verifies syntax and disconnected tests,
  **not** actual Firebase SDK parameter resolution, a manifest generated
  by a real installed SDK, the local Firebase CLI version, IAM or rollback.
- `functions/package.json` declares Node 22, `firebase-functions: ^6.0.0`,
  `firebase-admin: ^13.0.0`; it does **not** pin `firebase-tools`.
  The tracked repository tree has no functions package lock; exact locally
  installed SDK and CLI versions have not been established by this review.
- `functions/.gitignore` ignores `.env` and `.env.*`; Firebase's CLI
  can write parameter values into `functions/.env.<project>` during deploy.
  Existing ignore rules help prevent accidental Git commits, **not**
  unauthorized local value propagation or disclosure in logs.
- `firebase.json` has a single Functions codebase named `default`.
  Source `main` exports **14** Functions, and prior owner-observed production
  inventory has **15**, including the separately deployed
  `oddsPapiAccountPreflight` absent from `main`. This makes any blanket
  Functions deploy categorically unsafe.
- Earlier read-only Cloud Shell evidence for `oddsBackendStatus`: current
  active revision `oddsbackendstatus-00008-xec` at 100% traffic,
  default-compute execution identity, direct `allUsers` Cloud Run Invoker,
  `ALLOW_ALL` ingress, 60-second timeout, 2 maximum instances and
  concurrency 80. Seven plain environment-variable names were counted:
  five recognized, two nonstandard, zero regex-pattern hits. Their
  values and deployment relevance are **not** verified.
- Refer to [D15.16 runbook](update-35-1d15-16-status-least-privilege-pilot-runbook.md),
  [D15.14 dependency matrix](update-35-1d15-14-offline-iam-dependency-matrix.md)
  and [issue #1](https://github.com/GOZAO123/nba-betting-tracker/issues/1)
  for detailed owner-observed metadata and limitations.

This review used GitHub source, existing CI evidence and public Firebase/
Google Cloud documentation only. It performed **no** production Cloud Shell
checks, source-archive metadata/GET, credential fetch, callable invocation,
Firestore write, deployment or billable provider request.

## Parameter compatibility: verified contract versus unverified deployment

**PR #67 source proposal:** `functions/index.js` declares
`defineString("ODDS_BACKEND_STATUS_SERVICE_ACCOUNT")` with no default, then
passes the **parameter expression** directly as the `serviceAccount` option
to `exports.oddsBackendStatus` only. The status response and Firebase auth
guard remain unchanged; no principal address is hardcoded.

**Supported at API/documentation level:**
- Firebase Functions v2 `HttpsOptions.serviceAccount` has type
  `string | Expression<string> | ResetValue`.
- Firebase describes using parameter expressions directly in runtime options
  rather than calling `.value()` in module global scope.
- Firebase CLI issue firebase-tools **#5224** recorded historic failure for
  parameterized service accounts. Fix PR **#8366** was merged on
  **26 March 2025**, specifically addressing shorthand/parameterized
  service accounts. Older bug reports should not be presented as proof
  that the latest CLI still fails.

**Still UNKNOWN for this project:**
1. Actual owner-PC `firebase.cmd --version` and installed
   `firebase-functions` version that will discover the source.
   Do not assume the computer uses the latest release.
2. The metadata/manifest output using the **actual** Node 22 SDK+CLI:
   exactly one status endpoint should resolve to the expected deployment
   service account value; remaining endpoints must not gain it.
   The isolated tests in PR #67 deliberately **do not** import the SDK.
3. Whether a missing required parameter prompts during any targeted
   deploy of a different Function because the CLI discovers the whole
   `default` codebase; do not assert it only affects the status pilot.
4. SDK/CLI normalization of the service account string and exact
   deployment permission checks. Do not infer successful `actAs`/IAM
   behavior from a type declaration or the old bug fix.
5. Whether a future status-only deployment would preserve **all**
   unexpressed live settings (60-second timeout, 80 concurrency,
   public Invoker and ingress, seven plain env values, scaling,
   exact trigger/region and codebase). A source/options diff alone
   does not prove all of these will remain intact.

**Fail closed:** do not add a source default to default compute, do not
use a broad global `setGlobalOptions` service account, and do not
write an unapproved principal identifier to public GitHub, CI or issues.
Validation of the final value must be performed privately at the
owner-approved provisioning/release stage. No separate IAM grant should
be improvised to make a failed deploy pass.

## Safety of possible validation methods

| Method | Can establish | Authorization / risk |
| --- | --- | --- |
| Repository source review and current Node 22 synthetic tests | Static identity-option scope, unchanged handler contract, broad regression coverage | **Completed** for PR #67; does not establish actual CLI/SDK behavior |
| **Local, disconnected SDK-only metadata probe** in a temporary scratch copy using pinned package versions | Parameter discovery/manifest and absence of extra status-side resources, without an authenticated deployment | **Recommended next validation** if dependencies can be installed safely and tests run with no project credentials, no secret values and no network/provider calls; script must not initialize production SDK credentials or run deployment |
| Read-only local `firebase.cmd --version` and locally installed package version lookup | Exact tool versions | Owner-PC step later if necessary; no Cloud Shell or authenticated project operations required; do not publish sensitive environment details |
| `firebase deploy --dry-run` against production | Potentially validates more configuration | **NOT APPROVED / NOT SAFE TO ASSUME READ-ONLY**. Firebase CLI warns dry-run may **enable APIs** on target project; may prompt/write local `.env` parameter values and still interacts with target project. Do not run merely to verify this plan |
| Isolated staging project / authorized test identity | Stronger deployment/IAM permission evidence and actual rollback rehearsal | Separate explicit approval for project, resources, costs and all operations; not performed |
| Production single-Function deployment or live auth test | Actual production behavior only after controlled rollout | **NOT APPROVED**; require full release gates first |

A **pure local mock** of the new `serviceAccount` option is useful
regression coverage, but must **never** be labeled a Firebase CLI dry-run,
full deployment proof, or proof of effective runtime IAM.

## Rollback-readiness: status BLOCKED

**Current known evidence:** The referenced Cloud Build succeeded; active
revision, traffic share, container fingerprint, configured/resolved
Cloud Storage source references and resolved generation were previously
observed. **This is not** a verified, downloadable source backup, a
reproducible build, source-to-image equivalence, or a working rollback.

**Required target-only recoverability proof, in order:**

1. **Source authenticity:** securely locate and verify the *exact* old
   deployed source and dependencies for the pilot; compare intended commit,
   runtime code and build result **without** publishing source archive
   paths/contents, secret versions, service-account identifiers or the
   owner's UID. Inspecting archive/object availability or content can
   incur cost and needs advance approval.
2. **Configuration snapshot:** privately capture prior Cloud Functions
   v2 and Cloud Run revisions, runtime identity, invoker policy, ingress,
   concurrency, timeout, instance count, environment name/classification,
   secret references, build/image digest and traffic. Do not publish raw
   environment values or principal names.
3. **Restoration mechanism:** design and rehearse a narrowly scoped
   restore of the exact **single pilot** with its old source and runtime
   identity. Distinguish a Firebase-managed Functions redeployment from
   a Cloud Run revision traffic shift; the latter can restore routed
   traffic yet fail to align the Cloud Functions control-plane
   configuration, and **is not accepted as the sole rollback**.
4. **Reverification:** restore owner-approved callable behavior and
   verify status response/auth, old service identity/configuration,
   15-function inventory and preflight preservation, and billable
   resource exposure. Stop if any discrepancy.
5. **Never** use full Functions deploy, `--force`, default-compute Editor
   removal, a broad IAM grant or new OddsPapi call as a recovery shortcut.

**Rollback release gate = NOT MET.** This review cannot make it pass:
production source archive retrieval, an isolated live rehearsal and
effective IAM evidence are deliberately outside authorized scope.

## Additional blockers to leave explicit

- A recent firebase-tools **#10507** concerns service-agent/default-compute
  checks during custom-service-account deployments under specific
  circumstances. It does **not** prove this project's callable will fail
  (its default compute account still exists), but it reinforces the need
  to check real managed-service/deployer permission paths.
- The 15-function inventory check and frozen six-per-UTC-day Firestore
  upstream budget are **not** permissions to deploy or run paid tests.
- Google Sign-In, callable authentication (any signed-in user, not
  owner-only), current `allUsers` Cloud Run ingress, App Check disabled,
  Firestore research ledger protections, Scheduler OIDC identity,
  ESPN identity matching, Lisbon HH:mm, 06:00 checklist reset and Android/
  desktop behavior remain untouched by this review.
- Billing still requires a fresh, approved look; historical €0 net cost
  and a €1 alert-only budget do **not** establish zero total cloud cost.

## Stop/go acceptance checklist for a later change

- [x] Documented code/source evidence and PR #67 CI success.
- [x] Verified documentation-level expression compatibility and
      2025 firebase-tools issue resolution.
- [x] Identified local CLI version and env/parameter-discovery unknowns.
- [x] Identified dry-run API-enablement side-effect risk.
- [ ] Actual local dependency-pinned Firebase metadata discovery with
      exact endpoint/parameter resolution and sanitized output.
- [ ] Verified current deployed pilot source and reproducible old restore.
- [ ] Rehearsed a target-only rollback in an explicitly approved
      isolated/staging environment.
- [ ] Verified effective runtime/deployer IAM (including inheritance,
      deny policies, boundaries and deployer `actAs`).
- [ ] Privately resolved two unclassified live environment variables.
- [ ] Predeployment exact 15/15 inventory and cost review.
- [ ] Separate owner approvals for any merge, IAM/account creation,
      test, deployment, archive read or future provider request.

**Decision:** Keep PR #67 **DRAFT and UNMERGED**. This D15.18 review should
be a **separate documentation-only draft PR**, so it does not change
the approved 592/592 test head or create accidental production wiring.
A safe future local metadata harness may be proposed in another
separately approved offline step; never silently promote the current
source PR into a deployable release.

## Public references

- Firebase parameter docs: https://firebase.google.com/docs/functions/config-env
- Firebase HTTPS options: https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.https.httpsoptions
- Firebase tools bug and fix: https://github.com/firebase/firebase-tools/issues/5224 and https://github.com/firebase/firebase-tools/pull/8366
- Firebase deployment dry-run caveat:
  https://github.com/firebase/firebase-tools/blob/main/src/commands/deploy.ts
- Firebase source codebase / deletion policy:
  https://firebase.google.com/docs/functions/organize-functions
- Firebase function release management:
  https://firebase.google.com/docs/functions/manage-functions
- Cloud Run revision and traffic rollback:
  https://docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration
- Firebase-tools managed service identity caveat:
  https://github.com/firebase/firebase-tools/issues/10507
