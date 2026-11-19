# Update 35.1D15.10 — Secret Manager metadata quota: offline feasibility spike

> **NO PRODUCTION AUTHORITY.** This is a source-only, no-network prototype.
> Do not create a Secret Manager resource, grant IAM permissions, change the
> Firestore counter, deploy a Cloud Run service, enable a diagnostic, or invoke
> OddsPapi without separately scoped owner approval.

## Baseline and purpose

- Owner-approved PR #60 merged as GitHub `main`
  `b0a46cbadc6a16e3d99a5a9fb9e86bb1eaa72b4f`.
- Current real provider budget is **only** the existing Firestore
  `_internal/oddsPapiDailyDiagnosticBudget`, six upstream reservations per
  UTC day, shared by all manually triggered OddsPapi diagnostics.
- The identity-schema diagnostic remains **disabled** and uses its separate
  `nba-identity-schema` service account without Firestore database IAM.
  The existing live audit and previously owner-verified 15 Functions must be
  preserved; PR #16/#17 remain held.
- D15.9 determined that ordinary Firestore Admin SDK database IAM cannot
  grant a new broker access to **only one document**. Named Firestore databases
  have no independent free tier. An existing default Compute runtime also
  has previously verified project-level `Editor (Legacy)` authority.
- This spike explores a **different backing store** that might let a
  broker reserve a shared quota with IAM on just one resource, rather
  than on the database containing the protected research ledger.

## Newly researched alternative: Secret Manager metadata, not secret versions

Google Cloud documentation confirms:

1. A Secret Manager `Secret` has **metadata** (including annotations and an
   `etag`), independent from secret **versions** containing sensitive data.
   It can be created **with zero versions**.
2. `GetSecret` reads metadata and `UpdateSecret` with
   `updateMask.paths=["annotations"]` updates annotations. An included
   `secret.etag` enables optimistic concurrency control. A stale ETag
   fails with `FAILED_PRECONDITION` / HTTP 400; missing ETag bypasses the
   compare-and-swap protection. The prototype **requires** an ETag.
3. Secret Manager pricing currently lists **management operations as free**,
   with billing primarily for **active secret versions**, **access-version
   operations**, and rotation notifications. A dedicated *metadata-only*
   secret with **no versions** may avoid marginal Secret Manager charges.
   This does **not** guarantee €0 Cloud Run, networking, Cloud Build or
   future SKU charges, nor confirm billing on the owner's account.
4. IAM permissions can be bound at the individual Secret resource. A
   candidate **custom role** granting only
   `secretmanager.secrets.get` and `secretmanager.secrets.update`
   *on the dedicated quota secret* appears feasible. This is NOT a live
   attestation: independently verify exact custom-role support and whether
   the runtime can read/update annotations without project-level data
   permissions. Do not grant `secretmanager.versions.access`, broad
   Secret Manager Admin, `Editor`, or any Firestore data role.

The new quota metadata resource is **not** the existing
`ODDSPAPI_API_KEY` secret and must not carry an API key, credential,
private token, owner UID, player identity, offer or research record.
Only the non-sensitive UTC day, reservation count, limit and schema version
would be stored as a single annotation.

**This is a hypothesis worth validating, not a deployment decision.**
Secret Manager is designed for secrets, not as a general database. Its
ETag semantics, specific IAM resource binding, write-rate limits, metadata
immutability assumptions, auditability, and implementation/operating risks
must be accepted before adoption. The global secret
`UpdateSecret` rate has a soft limit of **2 requests/second**; keeping a
conservative manual six-reservations-per-day budget is consistent with
that intended workload, but concurrent ETag conflicts must fail closed
and should never trigger paid provider requests.

## D15.10 offline code contract

New pure module `functions/offline-identity-quota-secret-metadata.js`
exports `makeOfflineSecretMetadataQuotaReservation({getSecret,updateSecret,now})`.

- Fixed resource:
  `projects/nba-betting-tracker-3979d/secrets/NBA_DIAGNOSTIC_QUOTA_STATE`
  (**name only; no resource has been created**).
- A single annotation `nba_diagnostic_budget_v1` contains
  `{"schemaVersion":1,"utcDay":"YYYY-MM-DD","reserved":0..6,"limit":6}`.
  All fields are verified and malformed, missing or future-day states
  fail **closed**. The broker does **not** auto-create or auto-initialize it.
- Accepts only amount `1` or `2` to support all existing manual provider
  probes, not just the new one-request diagnostic; the choice must come
  from a trusted backend runner, **never a browser request**.
- On every attempt: read one metadata object and its ETag, compute a
  conservative UTC-day reservation, PATCH `annotations` using the exact
  ETag, and accept **only** a matching acknowledged response with a new
  ETag. Never retry any failed or ambiguous write automatically.
- Concurrent requests with the same old ETag yield at most **one**
  committed update. Conflict errors block the paid request; the user
  can separately review and manually retry if appropriate.
- A transaction may commit before response loss. An uncertain outcome
  **must not** authorize an upstream provider call. An unused reservation
  is the conservative outcome.
- The module is not imported by `functions/index.js`, not invoked by
  backend or frontend code, and adds **no** SDK dependency, token request,
  Secret Manager API call, Firestore permission or cloud resource.

Synthetic regression tests cover amounts 1/2, the six-slot ceiling,
mixed callers, concurrent ETag conflicts, corrupt data, UTC rollover,
missing resource, malformed response, aborted/failed metadata writes and
production isolation. Synthetic ETag behavior is **not** proof of the
real service's API or IAM semantics.

## Critical migration hazard — two independent quota authorities

**Do not enable this new counter alongside any existing provider diagnostic
that still reserves only Firestore.** Two separate six-slot counters could
collectively permit more than six upstream calls in a UTC day.

The deployed backend currently invokes `reserveDiagnosticRequests`
in multiple legacy manual diagnostics, and in both the classic market
audit and the gated new identity schema runner. Every deployed revision
that can contact a paid upstream endpoint must be inventoried, including
functions deployed from source absent on GitHub main.

Possible later cutover, requiring a separate owner-approved, tested design:

1. Inventory **all** live paid upstream callers and how they reserve.
   Do not assume the GitHub entrypoint describes all 15 deployed revisions.
2. Design a **fail-closed transition**: legacy callers must retain the
   existing Firestore six-slot guard and additionally reserve against
   the new ETag authority *before* any provider request while the dedicated
   identity diagnostic stays disabled. Firestore remains the historical
   cap during staged deployments; failed new reservations must block calls.
3. Verify every live paid caller now enforces the new shared authority.
   A single forgotten Firestore-only revision breaks the global guarantee.
4. Initialize metadata while paid calls are frozen, conservatively to
   **reserved=6 for the current UTC day**. Never assume existing spending
   is zero or reset the counter without evidence. Confirm no independent
   counter can send paid calls before relaxing freeze.
5. After a new UTC day, test one real **provider-free** reservation using
   owner-authorized IAM and check metadata receipts, idempotency limits,
   ETag conflicts, counter readbacks, denial/rollback and cost reports.
6. Only then separately approve enabling the dedicated identity diagnostic
   and exactly one manually initiated paid identity-schema request.
7. Keep the Firestore guard if it provides an additional conservative
   cap, but the new resource must be the **single authoritative shared**
   quota for every provider call. A partial migration is BLOCKED.

No cross-resource atomic commit is assumed. Dual reservation can spend
an extra unused slot but cannot authorize an unreserved provider request
if every caller follows the new shared authority.

## Security release blockers

- IAM secret-level **get+update only** policy, project principal audits,
  no Firebase/Firestore IAM grant and no privilege inheritance surprises.
- Cloud Run Invoker service-only role, Google-signed ID token verification
  by the broker, no service-account key files, raw HTTP body limits,
  no token/secret logging, and a pinned audited Node 22 package/lockfile.
- Verify Secret Manager ETag semantics and exact effective role in a
  separate, approved **provider-free** test. An actual metadata write is
  a cloud mutation and must receive explicit owner approval.
- Billing report and budget alerts. Metadata calls are documented as
  free management operations, but Cloud Run and build artifacts may charge.
- Full legacy diagnostic inventory and cutover plan; deny all paid calls
  until one authority covers every relevant deployed revision.
- D12 provider-evidence release remains intentionally **BLOCKED**,
  independent of this research spike.

## Official references

- https://docs.cloud.google.com/secret-manager/docs/etags
- https://docs.cloud.google.com/secret-manager/docs/creating-and-managing-annotations
- https://docs.cloud.google.com/secret-manager/docs/access-control
- https://docs.cloud.google.com/secret-manager/quotas
- https://cloud.google.com/secret-manager/pricing
- https://docs.cloud.google.com/secret-manager/docs/overview
- https://firebase.google.com/docs/firestore/security/iam
