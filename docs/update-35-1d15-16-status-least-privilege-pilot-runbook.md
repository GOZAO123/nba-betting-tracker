# Update 35.1D15.16 — Offline least-privilege status pilot and release-safety runbook

> **DRAFT DESIGN ONLY — NOT DEPLOYMENT INSTRUCTIONS OR PRODUCTION APPROVAL.**
> Preparing, reviewing or merging this document does **not** authorize service-account creation,
> role grants/revocations, changing invocation permissions, Cloud Functions/Cloud Run deployments,
> traffic shifts, secret/archive access, paid provider requests, or removal of default compute Editor.
> No automatic provider polling. Keep `releaseReady:false`, `paidProviderAllowed:false` and
> `cloudChangesAuthorized:false` until separate evidence and explicit owner approval exist.

## Scope, inputs, and evidence labels

**Only proposed pilot:** existing Firebase v2 callable `oddsBackendStatus` in `functions/index.js`.
This milestone **does not edit the handler, Firebase configuration, runtime identity, IAM,
frontend, billing, quota code, Firestore data/rules, or any deployed Function**.

Reviewed on 19 November 2026 against GitHub `main` at
`ebbf18329b7e7f5039724be95051f0955f812e14`, issue #1,
[D15.14's IAM dependency matrix](update-35-1d15-14-offline-iam-dependency-matrix.md),
and [issue #1 D15.15/D15.16 evidence](https://github.com/GOZAO123/nba-betting-tracker/issues/1#issuecomment-7022852444).

- **SOURCE:** current `main` exports **14** Functions. The status handler checks Firebase callable
  `request.auth` (any authenticated user, **not** owner-only), returns static
  `ready/provider/oddsConnected/message` fields, and makes **no direct**
  Firestore, Secret Manager or OddsPapi calls. `enforceAppCheck:false`.
  The shared module imports Firebase Admin and calls `initializeApp()` at load;
  source-level absence of reads in this handler is **not** full evidence of
  every startup/runtime dependency.
- **OWNER-OBSERVED PRODUCTION (19 Nov):** 15 deployed Functions, including separately
  deployed `oddsPapiAccountPreflight` **absent from `main`** (open draft PR #17 is
  **not** deployed-source attestation). The status pilot is ACTIVE on
  `oddsbackendstatus-00008-xec` at 100% traffic, Node.js 22, `europe-west1`,
  and runs as default compute with project-level legacy Editor.
  Pilot Cloud Run direct `roles/run.invoker` allows `allUsers` unconditionally,
  ingress `ALLOW_ALL`, max instances 2, concurrency 80, timeout 60 seconds,
  no explicit minimum instances, no VPC connector, unspecified VPC egress,
  zero secret environment/volume references, and seven plain environment names:
  5 recognized, 2 unclassified, none matched the conservative sensitive-name patterns.
  No environment values were reviewed/published. **Public invocation at IAM layer
  does not prove Firebase callable authentication bypass.**
- **OWNER-OBSERVED BUILD METADATA:** successful referenced build, consistent
  configured/resolved source-storage identifiers, recorded source generation and active
  image SHA-256 fingerprint. **NOT VERIFIED:** original archive availability and
  contents, reproducible source-to-image equivalence, production source-to-`main`
  equality, or a tested rollback. The unmerged preflight PR is not proof of
  its live source or owner guard.
- **OTHER PRODUCTION EVIDENCE:** the scheduled settlement has its own
  OIDC-authenticated Scheduler invoker pathway; its runtime, invocation and
  permissions are distinct. The default compute identity's Editor role and
  existing secret access must remain unchanged. D15.15 did **not** fully
  attest effective inherited/conditional/deny/PAB access.
- **COST BOUNDARY:** prior reported net Google Cloud cost was €0 for a
  historical window, and an existing €1 budget is alert-only. No claim
  of ongoing zero costs or of a hard spending cap. Even metadata/source
  archive checks can have billable aspects depending on the service.

Evidence categories: **SOURCE** = reviewed repository code; **OWNER-OBSERVED** =
read-only Cloud Shell/console output documented in issue #1; **PROPOSED** =
unimplemented migration hypothesis; **UNKNOWN** = a mandatory release blocker.
Do not promote one category to another.

## Recommended minimum IAM, separated by trust boundary

| Boundary | Proposed pilot treatment | Verification requirement |
| --- | --- | --- |
| **Runtime execution identity** | New *dedicated*, user-managed status-only service account; no downloaded keys and **no application-data IAM grants** | Verify no inherited/project/folder/org, database, secret, or unrelated effective privileges; confirm the handler and startup work without protected-resource access. Zero application-data roles is the **target**, not a proven present fact |
| **Runtime Firestore** | No `roles/datastore.user`, database privileges, or Admin SDK ledger/quota access | Synthetic test must catch any accidental reads/writes; browser Firestore Rules do not constrain Admin SDK IAM credentials |
| **Runtime Secret Manager** | No secret accessor/admin roles; no provider key mount or environment binding | Compare deployed secret references and source options; do not read secret values |
| **Runtime Cloud Run Invoker** | No `roles/run.invoker` grant to runtime account merely because it runs the handler | Runtime service identity does not substitute for caller invocation permissions |
| **Build and deploy principal** | Preserve managed build/service agents; if required, propose **scoped** `iam.serviceAccounts.actAs` / `roles/iam.serviceAccountUser` **on the new account only** for the authorized deployment principal | Separately review the true actor and effective permissions before any grant. Never grant Service Account User to the runtime account as an execution role |
| **Client invocation** | Preserve existing direct Cloud Run `allUsers` invoker and `ALLOW_ALL` ingress *during this identity-only pilot* | Verify Firebase callable authentication independently. Do **not** change to authenticated Cloud Run IAM invocation before proving browser Firebase SDK compatibility |
| **Other Functions / Scheduler** | **No IAM, runtime, traffic, secret or deployment changes** | Reconcile all 15 production functions; scheduled settlement retains its distinct OIDC invocation contract |

This proposal neither narrows the handler from signed-in users to owner-only nor enables App Check.
Either change would be a **separate** behavior/security decision and regression milestone.
No assumption that the new runtime needs blanket Cloud Logging, project Viewer, Editor,
Firestore, or Secret Manager permissions: identify and justify any nonzero role individually.

## Hard invariants and stop conditions

1. `oddsPapiAccountPreflight` is separately deployed and missing from `main`.
   **Never** execute a blanket `firebase deploy --only functions` or allow Firebase
   CLI to delete or rewrite it. Preserve all 15 Functions.
2. Never remove default compute's legacy Editor or existing secret grants.
   Existing consumers may still require them. A successful status pilot does
   **not** authorize global privilege removal.
3. Existing server-enforced **six** upstream OddsPapi diagnostics per UTC day
   stays the sole production quota authority. Keep identity/evidence flags
   disabled and do not split paid callers across quota systems, introduce
   polling or invoke paid provider endpoints.
4. Preserve Google Sign-In, Firestore checklist/cloud sync, research ledger
   capture/settlement and browser-write deny, ESPN identity verification,
   Android/desktop/viewport, Lisbon HH:mm and the 06:00 checklist reset.
5. No credentials, keys, UID, principal addresses, environment values,
   source archive paths, secret version IDs, or sensitive raw IAM policies
   in public PR/comments. Store operational comparison evidence privately.
6. **STOP** if source authenticity, exact target-only deployment boundaries,
   adequate rollback, effective IAM, billing/cost review, or any owner
   approval is missing. Do not resolve a failed least-privilege test by
   silently granting Editor or bypassing callable authentication.
7. Treat "one instance" or "max instances" as concurrency limits only,
   **not** a total request-rate guard or spending cap.

## Pre-change comparison checklist (design; NOT performed)

Prepare a **private, sanitized** matrix before a future rollout:

| Attribute | Current owner-observed pilot baseline | Requirement before release |
| --- | --- | --- |
| Source / build | Successful build and image digest; exact source equivalence **UNKNOWN** | Pin intended checked-in source and independently establish a recoverable matching rollback artifact; image digest alone is insufficient |
| Revision / traffic | `oddsbackendstatus-00008-xec`, 100% | Record currently active revision, traffic, deployable source and exact restore mechanism |
| Runtime | Default compute / project Editor | Compare with intended dedicated identity, with effective grants and deny/PAB checked privately |
| Region / Node | `europe-west1` / Node 22 | Unchanged |
| Trigger / callable response | Firebase callable; authenticated users receive static schema | Unchanged; no owner-only or App Check switch in this pilot |
| Cloud Run invoker / ingress | Direct `allUsers`, `ALLOW_ALL` | Unchanged during pilot |
| Scaling / timeout | Max 2; concurrency 80; 60s; minimum unspecified | Preserve observed live behavior (not merely source defaults); investigate any Firebase-managed default drift |
| Secret references / VPC | Zero secrets; no VPC connector; egress unspecified | No new secret/VPC dependency; compare revised service configuration |
| Plain environment | Seven names; two unclassified; values not reviewed | Determine startup/runtime relevance privately, without posting values or assuming a benign name proves benign contents |
| Other production Functions | 15 active; separate preflight | Same inventory and untouched identities, revisions, traffic, secret mappings, IAM and Scheduler integration |
| Cost / quota | Historical €0 net snapshot; six/day guard | Fresh scoped billing/risk review; no OddsPapi upstream requests |

**Source-recovery gate:** An existing revision identifier, image fingerprint or a
Google Cloud source-generation reference is **not** a working backup.
Before any deployment approval, verify that a known-good *exact* pilot
source/configuration can actually be restored using a **target-only** path.
If inspecting source object availability/content could incur cost,
request explicit cost approval first; don't fetch it implicitly.
Do not publish any recovered source archive.

## Staged future sequence — every mutation needs its own approval

**Stage 0 — evidence and recovery (no change):**
Resolve production deployed-source versus repository discrepancies, unclassified
environment dependencies, effective IAM (including inherited roles, conditions,
denies and principal access boundaries), build/deployer requirements, and cost
exposure. Define source-based *single-target* restoration and verify it under
an appropriately authorized isolated/staging process. Cloud Run revision
traffic manipulation is only a fallback candidate after proving it is
supported for this Firebase-managed Function and does not cause
Cloud Functions configuration drift. If unverified, **stop**.

**Stage 1 — IAM proposal (separate owner approval):**
Provision one dedicated user-managed pilot account **only**; do not create a
key or project-level binding. Separately approve any precisely scoped
`actAs` grant to the genuine deployer. Do not touch existing service accounts.

**Stage 2 — implementation (separate owner approval):**
In a reviewable PR, add a per-handler `serviceAccount` runtime option **only**
to `exports.oddsBackendStatus` in `functions/index.js`. Do not use global
`setGlobalOptions` or import/activate quota broker functionality; do not
change auth, response, ingress, scaling, Firestore rules, schedules or
frontend. Review source diff and static safety assertions.

**Stage 3 — offline and isolated validation (no paid requests):**
Run synthetic auth/response and absence-of-I/O tests; ensure Node 22 syntax,
backend/frontend regressions and inventory invariants pass. Test candidate
runtime without protected Google resource access in an isolated,
owner-authorized environment. Document actual commands, output, sample counts
and limitations; never claim a test was run if only specified here.

**Stage 4 — deployment approval (separate explicit owner decision):**
Confirm exact branch/commit, proven rollback, billing, configuration delta,
IAM delta and 15-function preservation. Obtain authorization specifically for
a deployment targeting **only** `functions:oddsBackendStatus` in the Firebase
`default` codebase and correct project. Inspect the resolved deployment
operation/preview; abort on any proposed deletion, additional Function
update, secret modification, unexpected account change or `--force` request.
This document intentionally includes **no paste-and-run production deploy command**.

**Stage 5 — approved live acceptance (separate test approval):**
Inspect changed pilot revision and runtime while verifying the other 14
are unchanged. Through an authorized Firebase callable test path, confirm
the same output schema for a signed-in user and rejection for
unauthenticated callers; public Cloud Run IAM alone must not be treated
as an application-auth test. Check for startup/permissions errors,
unexpected retries, logs with sensitive values, provider/quota activity,
cold-start or billing surprises. If the pilot is not wired into the current
frontend, record that explicitly rather than claiming Android/desktop UI
verification. Confirm Google Sign-In and the existing UI with the owner
where applicable. No live OddsPapi call is permitted by this stage.

**Stage 6 — failure/rollback (separate owner-approved action):**
On any mismatch, stop further changes, preserve diagnostics with redaction,
and execute only the **preverified, single-pilot rollback** (old source +
runtime identity, service configuration and invocation behavior), followed
by the same 15-function and auth checks. Do not restore by blanket deploy,
remove the separate preflight, grant Editor to the new account, change
traffic ad hoc, or revoke Editor from the legacy account. If there is
no tested rollback, do not begin Stage 4.

## Offline tests / evidence to attach to the later implementation PR

**Commands for a genuine local checkout at the reviewed commit, on Node 22:**

```powershell
npm.cmd --prefix .\functions run lint
npm.cmd --prefix .\functions test
node --test tests/research-dashboard.test.cjs
npm.cmd --prefix .\functions run preflight:evidence
```

`preflight:evidence` must remain **BLOCKED**, with its expected nonzero exit;
it must not be disguised as a successful release authorization.
The existing backend GitHub Actions workflow triggers on `functions/**`
changes, **not** on this documentation-only file. Thus creating this PR
does not by itself provide fresh Node test results.

**Tests to add/review only in the separately approved implementation:**

- Reject missing Firebase authentication; accept a synthetic valid
  Firebase-authenticated request; assert the existing static status schema
  and message are exactly preserved. Do not silently convert this to
  owner-only or require App Check.
- Instrument/stub data and network interfaces: zero Firestore Admin
  data calls, Secret Manager reads, OddsPapi fetches, scheduled calls,
  credential reads, or new per-request provider quota reservations
  from the status handler and its startup pathway.
- AST/source-level guard: per-handler `serviceAccount` applies only to
  `oddsBackendStatus`; no other `exports` config changed and no
  global runtime option introduced.
- Existing shared quota constant remains six; both disabled diagnostics
  remain literal false; no unreviewed new upstream caller/polling.
- Offline production inventory: source still exports 14 while verified
  deployment inventory remains 15 (including the separate preflight);
  reject a changed/missing preflight rather than auto-reconciling it.
- Frozen research ledger/ESPN/DNP/identity and Firestore browser-write
  denial regressions remain intact; no frontend HTML/viewport changes.
- No secrets, UID, principal addresses, private archive identifiers, or
  unredacted environment/IAM values introduced in diff, fixtures or logs.

**Validation acceptance:** document the exact commit, commands, Node version,
test counts and failures, confirmed no external paid calls, security proof
boundaries, and any test not runnable offline. Only a subsequently
authorized live acceptance can verify effective runtime permissions.

## Approval and evidence ledger

| Action | Status / required authorization |
| --- | --- |
| Create this **documentation-only branch and draft PR** | **Explicitly approved** by owner, 19 Nov 2026 |
| Merge this documentation PR | **NOT approved** |
| Implement/change pilot runtime option | **NOT approved** |
| Create service account or grant `actAs` | **NOT approved**; distinct IAM approvals |
| Read potentially billable source archive/object | **NOT approved**; cost authorization required |
| Deploy pilot to Firebase/Cloud Run | **NOT approved**; independent production approval |
| Run live callable/auth tests or Cloud Run traffic changes | **NOT approved**; independent scoped approval |
| Change Scheduler, quotas, paid callers or secret access | **NOT approved** |
| Remove default compute Editor / delete any Function | **PROHIBITED** pending broader independently verified migration and separate explicit approval |
| Perform real OddsPapi upstream calls | **NOT approved**; no automatic polling |

Release result remains **BLOCKED**. The next decision after review is whether
to approve a *separate* minimal implementation PR with deterministic tests;
do not equate design approval with rollout permission.
