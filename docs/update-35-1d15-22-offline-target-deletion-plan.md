# Update 35.1D15.22 — Offline Firebase CLI target filtering and deletion planning

> **DRAFT / DISCONNECTED EVIDENCE ONLY. No production approval.**
> Never run `firebase deploy` or `firebase deploy --dry-run` against the real project for this review. No merge, Function deployment/deletion, IAM, service-account provisioning, secret/archive access, live provider call or cloud resource change is authorized.
>
> Gates remain `releaseReady:false`, `paidProviderAllowed:false`, `cloudChangesAuthorized:false`.

## Scope and stacked dependencies

- Child of still-draft/unmerged [PR #71](https://github.com/GOZAO123/nba-betting-tracker/pull/71), whose head at branch creation was `0e46604d7f3584200b218575a69f088469b58d2d`.
- #71 stacks on #70, #69 and #67; #68 remains an independent unmerged draft.
- GitHub `main` at review start: `c508c6e27c1d42c699ffd6b0cffb59be6c18fce9`.
- Three added files, with **no changes** to `functions/index.js`, `functions/package.json`, `firebase.json`, Firebase rules, mobile/desktop UI, ledger, scheduler or existing quotas:
  1. `functions/status-target-deletion-plan.test.js`
  2. `.github/workflows/offline-status-target-deletion-plan.yml`
  3. This document.

## Precisely what the pinned CLI does

The public [Firebase CLI `v15.28.2` source](https://github.com/firebase/firebase-tools/tree/v15.28.2/src/deploy/functions) demonstrates the following—not inferred from a mock:

1. `prepare.ts` parses `--only` via `getEndpointFilters`, then prepares the codebase before applying `updateEndpointTargetedStatus` and `validate.checkFiltersIntegrity`. This occurs after other preparation operations that can access cloud APIs; **do not run the deploy command as a test**.
2. `functionsDeployHelper.ts` parses `functions:default:oddsBackendStatus` into a codebase and exact name chunks. Matching supports function-group prefixes separated by hyphens; a broad or ambiguous selector must not be treated as synonymous with a strict single-function policy.
3. `groupEndpointsByCodebase` assigns existing functions to a desired codebase by full resource name and then by codebase annotation. A name/region/codebase mismatch can affect the inventory being compared.
4. `release/planner.ts` `createDeploymentPlan` filters **both desired and existing** backends before `calculateChangesets`: existing endpoints are retained when they match a desired endpoint OR match the explicit selector. Consequently, with the exact target filter and matching identities, unrelated existing endpoints—including the separately deployed preflight—are not selected for deletion.
5. Without filtering, an existing endpoint missing from source can appear in `endpointsToDelete` when `deploymentTool.isFirebaseManaged(labels)` evaluates true. Whether the deployed preflight actually has such a label is **not independently attested**. Never assume that a blanket deployment is safe simply because a prompt may appear.
6. The planner can produce `deleteAndRecreate` for certain incompatible update transitions. The project-specific gate rejects this as well as explicit deletion, unexpected create, IAM-change fields and unrelated updates.

Source references:
- [`functionsDeployHelper.ts`](https://github.com/firebase/firebase-tools/blob/v15.28.2/src/deploy/functions/functionsDeployHelper.ts)
- [`prepare.ts`](https://github.com/firebase/firebase-tools/blob/v15.28.2/src/deploy/functions/prepare.ts)
- [`validate.ts`](https://github.com/firebase/firebase-tools/blob/v15.28.2/src/deploy/functions/validate.ts)
- [`release/planner.ts`](https://github.com/firebase/firebase-tools/blob/v15.28.2/src/deploy/functions/release/planner.ts)
- [`deploymentTool.ts`](https://github.com/firebase/firebase-tools/blob/v15.28.2/src/deploymentTool.ts)
- [`release/index.ts`](https://github.com/firebase/firebase-tools/blob/v15.28.2/src/deploy/functions/release/index.ts)

These observations are version-specific. Future Firebase CLI updates require a new review; tests pin **`firebase-tools@15.28.2`**, **`firebase-functions@6.4.0`**, **`firebase-admin@13.4.0`** and Node.js 22.

## Synthetic 14-versus-15 rehearsal

The existing in-repository D15.12 inventory definitions provide the 14 source names and the separately deployed preflight name. The test independently checks the proposed `functions/index.js` exports against those definitions and the existing `firebase.json` default codebase. It then builds **synthetic** Firebase CLI backend Endpoint objects: 14 desired, 15 existing, all assigned an invented project ID, `europe-west1`, Node 22 and gcfv2. It marks the extra preflight as Firebase-managed for the important negative blanket-deletion rehearsal.

The test invokes the **actual installed** Firebase CLI:
- `getEndpointFilters` and `endpointMatchesAnyFilter`;
- `validate.checkFiltersIntegrity`;
- `prepare.updateEndpointTargetedStatus`;
- `groupEndpointsByCodebase`;
- `release/planner.createDeploymentPlan`, including its real changeset and deletion-candidate logic.

The policy **over and above** Firebase CLI must see the exact selector string `functions:default:oddsBackendStatus`, the canonical 14/15 inventories with matched identity metadata, exactly one status update, zero creates/deletes/recreates/skips or other endpoint updates, no secret/IAM change delta and the same single planned backend. It refuses missing, broad, unqualified, incorrect, or multi-function selectors even when Firebase CLI would accept them.

Adversarial scenarios include unfiltered and codebase-wide deployments, an unmanaged preflight label, an extra 16th Function, missing preflight, missing/renamed target, incorrect region, codebase, generation, Node runtime or trigger, ambiguous selectors, and a mismatched status region that can be interpreted as a **create in one region plus delete in another**. All bad cases must be rejected by the project-specific gate. Successful simulation still returns **BLOCKED** as the release verdict.

## Evidence and limitations

| Evidence | Result |
| --- | --- |
| Prior D15.21: complete 14-export SDK-to-CLI discovery | Verified **16/16** in PR #71 CI |
| Prior D15.21: Node 22 backend regression | Verified **592/592** in PR #71 CI |
| D15.22: real pinned CLI selector/grouping/planner with synthetic inventories | **Pending GitHub Actions** |
| D15.22: existing SDK and CLI discovery regressions | **Pending GitHub Actions** |
| D15.22: backend Node 22 regressions | **Pending GitHub Actions** |
| Live function inventory/config/labels; production deployment target behavior | **NOT TESTED; BLOCKED** |

The test does not run `firebase` or any deployment command, does not contact the real Firebase project, and does not load Google credentials, Function secrets or production archive/source. It blocks ordinary Node network interfaces during test execution; npm downloads public dependencies before the test, and this is **not an OS network isolation guarantee**. Other cloud service paths, local CLI configuration/env prompts, API enablement and IAM calls made by actual `prepare` are outside this test. The preflight's production codebase labels and deployed source are **not verified**. In reality, all 15 actual deployed configurations and effective IAM must be independently attested.

**Not proved:** any actual successful target-only deployment, rollback, unchanged Cloud Run traffic/Invoker/ingress, exact original source/config recoverability, billing, runtime identity, `actAs`, source archive equivalence, live secret bindings, other regional/cloud drift, or that current GitHub source matches all deployed Functions. CLI behavior could differ with future versions, environment settings or changes to the remote inventory. A green offline plan is evidence for future review only, **not release authorization**.

## Remaining release blockers and future decision

- Obtain separately approved, **read-only** attestation of all 15 deployed Functions, including preflight, codebase labels, runtime/region/trigger and status deployed-source equivalence; reject unexpected additional Functions.
- Independently verify pilot IAM, inherited/deny policies, build/deployer permissions, unknown environment variables and actual rollback source/config without reading private archives absent approval.
- Confirm owner-PC CLI version and a source-backed, target-specific rollback protocol, permissions and cost/billing posture. Do not try a production dry run just to obtain this evidence: Firebase's dry-run may enable APIs.
- Keep the existing compute Editor role untouched pending separately approved migration. Preserve preflight, scheduled ESPN settlement, Google sign-in, Firestore protections, desktop/Android behavior, Lisbon time and daily 06:00 reset.
- Keep hard-disabled diagnostic guards, no automatic OddsPapi polling, and the server-enforced six upstream diagnostic requests per UTC day. Do not make paid provider requests.

**Production verdict stays `BLOCKED`.** An owner-approved production deployment is a separate future decision, not implied by this PR.
