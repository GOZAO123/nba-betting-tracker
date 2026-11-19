# Update 35.1D15.11 — Unified quota cutover contract and source inventory

> **OFFLINE SECURITY ENGINEERING ONLY.** No merge approval, cloud deployment,
> IAM mutation, new Secret Manager resource, Firestore write, paid OddsPapi
> request, real token, or operational migration is implied. Source review is
> not attestation of the owner's deployed infrastructure.

## Baseline

- Owner-approved D15.10 PR #61 merged at GitHub main
  `e229ed5cc480980f59af4ca4a06f9af02a34624a`.
- The only live six-per-UTC-day paid-provider guard is the Firestore
  transaction on `_internal/oddsPapiDailyDiagnosticBudget`.
- The proposed alternative is an **unwired, metadata-only Secret Manager
  resource** with a single annotation and ETag compare-and-swap. Its code is
  synthetic and has **not** been tested against live Google IAM, API behavior
  or billing.
- The 15 production Functions and the original market audit revision were
  last verified by the owner after D15.2. GitHub source does **not** attest
  present deployed revisions. The dedicated identity-schema diagnostic is
  backend/UI hard-disabled; the separately deployed
  `oddsPapiAccountPreflight` source is not necessarily present on main.
- Research Firestore records must remain inaccessible to the dedicated
  identity runtime. Never grant it database-wide Firestore IAM.
- The D12 general evidence-release preflight remains **BLOCKED**.

## Source inventory: eight existing paid-provider diagnostic paths

This snapshot was read from actual `functions/index.js`, not invented.
A repository-only inventory still needs live revision confirmation.

| Exported callable | Reservation attachment | Max reserved slots per cold click |
| --- | --- | ---: |
| `oddsPapiTournamentProbe` | Direct `reserveDiagnosticRequests(1)` | 1 |
| `oddsPapiNbaOddsProbe` | Direct `reserveDiagnosticRequests(1)` | 1 |
| `oddsPapiDetailedPropsProbe` | Direct `reserveDiagnosticRequests(2)` | 2 |
| `oddsPapiMarketCatalogProbe` | Direct `reserveDiagnosticRequests(1)` | 1 |
| `oddsPapiVerifiedPropsProbe` | Direct `reserveDiagnosticRequests(2)` | 2 |
| `oddsPapiNbaFeasibilityProbe` | `makeFeasibilityRunner({reserve: reserveDiagnosticRequests})` | 1 (review runner separately) |
| `oddsPapiNbaMarketAudit` | `makeLeagueMarketAuditRunner({reserve: reserveDiagnosticRequests})`; D14 routed runner disabled | Up to 2 (review runner separately) |
| `oddsPapiNbaIdentitySchemaDiagnostic` | `makeManualAuditEvidenceDispatch({reserveDiagnosticRequests, identityOnly:true})`; backend disabled | At most 1 when enabled, separately approved |

The `oddsBackendStatus` callable does not use a paid provider
reservation. **The separately deployed `oddsPapiAccountPreflight`
must be inspected live**; its source is held and it is intended to use an
unmetered account endpoint. Do not infer that every possible provider
request appears in this GitHub snapshot. Inspect actual current Cloud
Functions, revisions, scheduled jobs, existing other source branches and
provider-account usage before any change.

## Pure new components

1. `functions/offline-identity-quota-dual-guard.js` exports
   `makeOfflineDualQuotaGuard({reserveFirestore,reserveMetadata,now})`.
   It requires a trusted backend-selected amount **exactly 1 or 2**,
   reads the UTC day, reserves the **existing Firestore** guard first,
   checks its acknowledgement, then reserves the new ETag metadata guard,
   checks its acknowledgement and revalidates the day. Every receipt
   must have the exact `{utcDay,remaining}` schema and must not imply
   more than six slots per UTC day.
2. If either backend fails, is corrupt, times out, changes day, or
   returns an uncertain receipt, **NO paid upstream call is authorized**.
   The first reservation may have been spent even if the second fails;
   no automatic retry, refund, alternative budget, or provider request
   follows. The helper returns the **minimum** available remaining
   slots for the common UTC day only after both acknowledgements succeed.
3. `functions/offline-identity-quota-caller-inventory.js` inspects an
   explicit eight-function **source** inventory, direct and delegated
   quota paths, existing six-slot guard, original Firestore budget doc,
   and literal disabled feature switches. It returns `BLOCKED`,
   `cutoverReady:false`, `providerRequestAllowed:false` **always**,
   even when the checked-out source matches perfectly; the unknown
   actual deployed revisions and account preflight never become
   automatically verified.
4. Two synthetic test modules prove no automatic HTTP/provider activity,
   invalid-amount short-circuit, fail-closed missing or malformed
   receipts, deadline/day mismatch, concurrent synthetic ceilings, source
   drift, unknown added Functions and preserved hard-disable switches.
5. `functions/package.json` adds only offline Node22 lint/test wiring.
   No new installed dependencies or production imports.

## Provider-free transition sequence — REQUIRES SEPARATE OWNER APPROVALS

**Stage 0 — Source review only, present state:** No change to old
Firestore quota; metadata prototype remains unregistered. No provider
request occurs and neither source module is a live authority.

**Stage 1 — Production inventory and billing proof (READ ONLY):**
Owner verifies the current 15 Functions, all relevant active Cloud Run
revisions, their runtime identities, deployed unmetered preflight,
existing default-database shared budget document, Secret Manager
permissions and billing. Confirm any other consumers of the OddsPapi
secret/account outside GitHub source. Record all names without exposing
credentials, service-account keys or the owner UID.

**Stage 2 — Explicitly approved quota resource/IAM setup:**
First verify the documented `secretmanager.secrets.get` and
`secretmanager.secrets.update` custom role can truly be scoped to
the **one dedicated** metadata-only Secret. Verify zero versions, no
`versions.access`, the Cloud Run identity, and ETag write behavior;
a simulated ETag failure is not live Google API evidence. Cloud cost and
rollbacks need approval. Creation, IAM and actual metadata mutation
require distinct owner decisions.

**Stage 3 — Freeze paid provider calls and coordinate a dual guard:**
During a separately authorized and reversible transition, legacy
callers retain the six-slot Firestore guard **AND must also** reserve
from the new metadata authority before any paid fetch. The old quota
guard runs first; if either reserve fails, provider is blocked.
Deploy each scoped callable separately, ensuring no old active revision
or overlooked callable can access OddsPapi under Firestore-only rules.
The existing disabled identity diagnostic **must remain disabled**.
Reserve the metadata day at `reserved:6` (fail-closed) while historical
spend is unknown, until a new UTC day and reviewed state; never reset
daily allowance to zero just because a new storage resource was created.
Never allow independently active six-slot authorities.

**Stage 4 — Provider-free acceptance:** After **all** paid callers
are dual-guarded, verify no request can bypass either guard, wrong
principal/audience denied, real ETag conflict, ambiguous commit,
UTC rollover, no seventh slot, billing and rollback. Real reservation
writes consume internal slots even if no OddsPapi request occurs;
these require explicit owner consent. A real Cloud Run signed-token
rehearsal and a diagnostic enabled/deployed are different approvals.

**Stage 5 — Only when the shared authority is established:**
A future dedicated runtime without Firestore permissions may call the
private broker to reserve only metadata quota. This is safe only once
**every paid consumer** also reserves from that same metadata quota,
so no old/forgotten Firestore-only caller can spend independently.
The six-slot limit remains a software guard, not an OddsPapi-enforced cap.
Separately approve one manual, at-most-one-upstream-request identity
schema diagnostic. Do **not** automatically poll OddsPapi. Inspect safe
player/event shape evidence before revisiting the two-request full NBA
market audit.

### Failure / rollback matrix

| Failure | Safe behavior |
| --- | --- |
| Firestore transaction unavailable or exhausted | Refuse provider request, do not touch metadata |
| Metadata ETag collision, IAM denial, unavailable, or exhausted | Treat old Firestore slot as spent; refuse provider, do not retry |
| Ambiguous Firestore/metadata commit | No success receipt, provider blocked; investigate manually |
| UTC date changes across two reservations | Both may be spent, provider blocked |
| Known source caller missing a quota attachment | Block cutover until reviewed |
| Any live paid caller lacks new metadata guard | **Stop rollout**; do not enable metadata-only diagnostic |
| New metadata resource unavailable after dual rollout | Fail closed; never switch back to old-only unless all metadata-only callers are independently disabled, with owner-approved rollback |
| D12 evidence gate still BLOCKED | Do not claim approved real bookmaker evidence or audited profitability |

## Architectural cautions

- A separate metadata-only Secret with **zero versions** has promising
  resource-scoped IAM and no management-operation billing according to
  Google documentation, but **the actual custom role, ETag semantics,
  metadata-only creation and costs remain unverified live**.
  A broker Cloud Run service and builds may incur charges.
- This is **not the final deployment plan**, and a dual guard would add
  one conservative reservation operation per provider click.
  The old backend service account previously had broad project-level
  privileges; the broker must NOT reuse that identity.
- If the owner rejects the complexity or cost of a metadata authority,
  revisit other safer designs instead of deploying an insecure default
  Firestore account. Do not compromise protected research documents.
- Do not use `firebase deploy --only functions` globally; GitHub main
  may omit the existing separately deployed account-preflight source.
- Never include secrets, raw provider odds, UID or private user data in
  logs or GitHub issue comments.

## Official reference links

- https://docs.cloud.google.com/secret-manager/docs/etags
- https://docs.cloud.google.com/secret-manager/docs/creating-and-managing-annotations
- https://docs.cloud.google.com/secret-manager/docs/access-control
- https://cloud.google.com/secret-manager/pricing
- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- https://firebase.google.com/docs/firestore/security/iam
