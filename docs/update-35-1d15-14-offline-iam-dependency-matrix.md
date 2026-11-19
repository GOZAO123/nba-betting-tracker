# Update 35.1D15.14 — Offline production IAM dependency matrix

> **DESIGN / SOURCE REVIEW ONLY — NO PRODUCTION AUTHORIZATION.** This update does not deploy Functions, invoke callables, read or write live Firestore data, contact OddsPapi, modify IAM/Cloud Run/Scheduler/Secret Manager, or change billing. It does not authorize future changes. Retain `releaseReady:false`, `paidProviderAllowed:false`, and `cloudChangesAuthorized:false`.

## Baseline and evidence boundaries (19 November 2026)

- Repository baseline: GitHub `main` commit `4cbcf9513630ec599f91db7b894c62a246507ffa` (Update 35.1D15.12A). `functions/index.js` exports **14 Functions**; `oddsPapiAccountPreflight` is a **15th, separately deployed Function**, absent from `main`. A blanket `firebase deploy --only functions` risks deleting it.
- Owner's read-only `firebase functions:list` plus local offline checker matched **15/15** Node.js 22, second-generation, `europe-west1` services, without an unexpected entry. This is an *inventory* check, not an authorization.
- Owner inspected active Cloud Run revision YAML of all 15 services: **14 use the default compute execution account**, and only `oddsPapiNbaIdentitySchemaDiagnostic` uses a dedicated execution account. The former has a project-level **Editor (Legacy)** IAM binding. The dedicated account has an observed resource-scoped Secret Manager Secret Accessor binding on the *existing* OddsPapi key. Do not publish principal emails or project numbers.
- The owner previously observed that the independently deployed account preflight is owner-authenticated and calls the intended `/v4/account` endpoint. Its exact deployable source is **not** in `main`, and we have not produced a reproducible source-to-revision attestation.
- The deployed identity-schema diagnostic has literal `NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false` and `NBA_PROVIDER_EVIDENCE_ENABLED = false`. Do not enable either flag.
- Owner-led Cloud Run Source checks verified the reserve-before-fetch order for seven active paid diagnostic/probe callers; this is deployed-source evidence, **not a live request or complete proof of cross-revision enforcement**. GitHub helpers have also been inspected. No OddsPapi request was made during the checks.
- Billing snapshot for 1–19 November 2026 showed **€0.00 net Google Cloud cost after credits/savings**; the existing **€1 monthly budget is alert-only, not a hard cap**. This does not establish permanent €0 costs or provider-side billing status.

**Evidence labels:** `SRC` = reviewed `main` source and helper code; `OWN` = owner-observed deployed revision/console evidence; `OPEN` = not independently attested; `PLAN` = proposed future requirement, **not** an observed existing IAM binding. Every row needs a fresh deployed-source/revision and effective-IAM comparison before any migration.

## Execution identity versus invocation identity

These are distinct. The **runtime service account** is used by Admin SDK and secret access *inside* a Function. The **invoker identity/policy** controls whether requests can reach Cloud Run. Firebase callable `request.auth` and the in-handler owner checks are a further application-level boundary; do not treat the Cloud Run Security toggle alone as proof that an endpoint is private. The **Cloud Scheduler calling identity** for the scheduled Function is distinct from its runtime identity. The **deployment/build service agents** are distinct again. Never grant their permissions indiscriminately to the Function's runtime account.

The observed preflight Security UI showed an `allUsers` invoker grant despite a “Require authentication” selection. Effective access and the callable's Firebase Auth/owner check must be evaluated together; removing `allUsers` without a validated callable authentication plan could break clients.

## 15-service source-level dependency matrix

| Active Function | Trigger and source path | Data / external dependency observed or expected | IAM target to **investigate**, not grant | Runtime observed |
| --- | --- | --- | --- | --- |
| `oddsBackendStatus` | Callable; `functions/index.js` | `SRC` authenticated status response only; **no direct Firestore query, secret read or provider fetch in handler** | `PLAN` start with no application database/secret role; independently verify callable invocation | Default compute |
| `oddsPapiTournamentProbe` | Callable; `index.js` | `SRC/OWN` OddsPapi key secret; shared Firestore daily reservation transaction; outbound `/v4/tournaments`; one slot | `PLAN` read existing single secret; transact quota record; HTTPS egress | Default compute |
| `oddsPapiNbaOddsProbe` | Callable; `index.js` | `SRC/OWN` key + same Firestore quota transaction; `/v4/odds-by-tournaments`; one slot | Same provider-quota dependency set | Default compute |
| `oddsPapiDetailedPropsProbe` | Callable; `index.js` | `SRC/OWN` key + same quota transaction; bounded provider helper; two slots upfront | Same provider-quota dependency set | Default compute |
| `oddsPapiMarketCatalogProbe` | Callable; `index.js` | `SRC/OWN` key + same quota transaction; `/v4/markets`; one slot | Same provider-quota dependency set | Default compute |
| `oddsPapiVerifiedPropsProbe` | Callable; `index.js` | `SRC/OWN` key + same quota transaction; bounded catalogue and NBA odds lookups; two slots upfront | Same provider-quota dependency set | Default compute |
| `oddsPapiNbaFeasibilityProbe` | Callable; `index.js` + `odds-feasibility.js` | `SRC/OWN` key + injected `reserveDiagnosticRequests` before one league odds fetch | Same provider-quota dependency set; verify delegated path | Default compute |
| `oddsPapiNbaMarketAudit` | Callable; `index.js` + `league-market-audit-runner.js` | `SRC/OWN` key + injected reserve (one or two slots), optional catalogue and NBA odds; evidence flag false | Same provider-quota dependency set; verify fail-closed path and disabled evidence flag | Default compute |
| `oddsPapiAccountPreflight` | Callable; **separately deployed, not exported by `main`** | `OWN` owner-authenticated, intended unmetered `/v4/account` request; actual secret binding and full source provenance must be reattested | `PLAN` existing key-secret access only **if** confirmed; no Firestore role without direct evidence | Default compute |
| `oddsPapiNbaIdentitySchemaDiagnostic` | Callable; `index.js` + `manual-identity-shape-callable.js` | `SRC/OWN` **hard-disabled** handler; key secret mounted/bound; dedicated identity has observed secret-scoped accessor. Future provider/Firestore adapters remain disabled | Preserve current disabled state and dedicated identity; **do not broaden to Firestore or enable diagnostics** | Dedicated |
| `ledgerCaptureProspective` | Callable; `index.js` | `SRC` Firestore ledger transaction read/create; ESPN scoreboard and roster verification | `PLAN` ledger collection read/create/transaction capability; HTTPS ESPN; no OddsPapi secret | Default compute |
| `ledgerBatchCaptureProspective` | Callable; `index.js` + `batch-capture.js` | `SRC` bounded multi-row reuse of trusted ESPN verification and Firestore capture transactions | Same ledger capture capability; preserve 20-row and event/team caps | Default compute |
| `ledgerSettleProspective` | Callable; `index.js` | `SRC` Firestore ledger read + immutable-field checked transaction update; ESPN final summary | `PLAN` ledger read/update/transaction capability; no OddsPapi secret | Default compute |
| `ledgerAutoSettleProspective` | **Scheduled**; `index.js` + `auto-settlement.js` | `SRC` Firestore `pending` query and idempotent ledger update transactions; ESPN Final lookup; scheduled `0 12 * * *`, timezone `Europe/Lisbon` | `PLAN` ledger query/update capability for **runtime**; separately verify Scheduler-to-Cloud-Run **invoker** permission | Default compute |
| `ledgerReconcileReviewedInactive` | Callable; `index.js` + `reconcile-reviewed-inactive.js` | `SRC` fixed reviewed case, Firestore ledger read/transaction update; ESPN Final verification | `PLAN` ledger read/update/transaction; no OddsPapi secret | Default compute |

The Firestore **Admin SDK uses IAM**, not browser Firestore Security Rules. The current rule denying browser research-ledger writes must remain unchanged. Research ledger and provider quota operations are distinct data sets; do not assume a simple collection-only IAM grant exists. A candidate role such as `roles/datastore.user` must be vetted against the actual *database-level* IAM model and its granted permissions before approval. Do not grant project-wide Editor or broad Firestore access to a new quota broker. Existing browser Google sign-in and checklist synchronization are outside this server-runtime change and must remain intact.

**Current live quota authority:** the shared transactional Firestore document `_internal/oddsPapiDailyDiagnosticBudget`, maximum **six reservations per UTC day**, conservatively reserved before upstream calls; failures are charged and Firestore failure blocks provider access. A future Secret Manager metadata/CAS authority is **not deployed**. Never split the live callers between independent quota authorities; do not create or update quota secrets in this milestone.

## Read-only evidence required before proposing ANY permission change

1. **Deployed provenance:** For every active service, record revision ID, traffic share, runtime identity and deployed-source fingerprint in a **private** checklist. Source comparisons must distinguish `main` from the separately deployed preflight. Re-check the identity diagnostic's two literal disabled flags. Do not paste API keys, OAuth tokens, owner UID, service-account emails or raw environment values into issues.
2. **Effective runtime IAM:** Read only project, inherited, database/resource-scoped and Secret Manager **existing-key** grants. Establish which callers actually need Firestore read/query/create/update/transactions versus key read. Evidence of a project-level Editor role is not evidence that revoking it is safe.
3. **Invocation permissions:** Separately inspect Cloud Run invoker policies, the callable's Firebase Auth/owner checks, and the Scheduler job's calling principal. Record effective `allUsers` behavior where present. Do not toggle authentication or invoker permissions in this phase.
4. **Managed service dependencies:** Account for Firebase/Cloud Run service agents, Cloud Build/deploy identities, logging and secret-version bindings without assuming they are runtime roles. Record the existing key's *permission* and version reference only; **never view its value**. Do not create a new quota secret.
5. **Cost / rollback:** Recheck billing project scope, €1 alert-only budget and possible provider-side costs before any rollout; record a known-good active revision and an explicitly tested rollback path per Function.

**Open blocker:** Google Cloud and Firebase console observations above do not by themselves provide a complete effective-IAM policy or independently demonstrate that proposed granular roles will function. A least-privilege policy is a hypothesis pending those proofs.

## Proposed migration order (design only)

1. **Phase A: low-risk pilot candidate — `oddsBackendStatus`.** Source does not directly access Firestore, secret value or paid provider endpoints. In a separately approved staging/emulated environment, validate it with a narrow dedicated identity and expected callable authentication; monitor backend status from desktop and Android. This is **not** permission to deploy or alter IAM today.
2. **Phase B: research callable Functions.** Inventory required Firestore operations; simulate read/create/update/transaction permissions against synthetic/emulator data, including duplicate capture, freeze invariants, ESPN identity mismatch, missing final/DNP and rollback. Keep production owner auth intact; migrate one callable per independent approval.
3. **Phase C: scheduled auto-settlement.** Review Scheduler's **invoker** separately from runtime data permissions. Confirm schedule stays `12:00 Europe/Lisbon` and capture/settlement remains idempotent and bounded. Migrate only with owner-approved monitoring and rollback.
4. **Phase D: provider diagnostics and separately deployed preflight.** Prove exact Secret Manager resource-scope access and shared Firestore quota transactions; test fail-closed/over-limit behavior with mocks, no live OddsPapi calls. Preserve all seven paid callers on the current single quota authority throughout. Treat independently deployed preflight as a special source-preservation risk. Keep identity-schema diagnostic disabled and dedicated; separately review before changing it.
5. **Phase E: retire legacy Editor ONLY after all dependencies are migrated and independently verified**, including any non-Function consumers of the same default account. Confirm effective permissions, billing and rollback before a separately authorized IAM removal. A successful pilot is not proof that Editor can be removed globally.

**Rollback principle:** Before each future authorized change, retain the previous runtime identity, active revision/configuration, required IAM bindings and a bounded test checklist. Revert *the targeted Function* only if regression occurs, using an approved mechanism validated for Firebase-managed Cloud Run services. Do not broadly redeploy all Functions from `main` while preflight source is absent.

## Acceptance checks and release gates

- [x] Cross-checked `functions/index.js`: exactly 14 exported callable/scheduled handlers; the fifteenth preflight is intentionally not in `main`. Matched known inventory names without copying secrets.
- [x] Mapped all 15 owner-observed runtime identities: 14 default compute, 1 dedicated; identified project-level Editor as a **risk**, not proof of excess use.
- [x] Marked source-derived Firestore / Secret Manager / Scheduler / ESPN / OddsPapi dependencies separately from proposed IAM privileges. No live invocation used.
- [x] Preserved disabled identity-diagnostic/evidence flags and existing Firestore six-per-UTC-day live quota authority.
- [ ] **BLOCKED:** independently attested full deployed source and effective IAM including preflight, Cloud Run invocation and Scheduler caller identity.
- [ ] **BLOCKED:** least-privilege role trial, staged test, budget/cost review, owner approvals, and rollback evidence.

**Release verdict: BLOCKED.** No production behavior is changed by this documentation-only proposal. Maintain `releaseReady:false`, `paidProviderAllowed:false` and `cloudChangesAuthorized:false`.
