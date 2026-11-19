# Update 35.1D15.9 — quota authority and IAM isolation decision

**STATUS: OFFLINE SECURITY REVIEW. No release authorization.** This document
and accompanying static review gate are **not** production IAM evidence.
No merge, cloud deployment, Firestore mutation, provider call or change in
spending limit is authorized by this work.

## Verified source baseline

- Current `main` after approved PR #59:
  `836be12b92184b1fec6d3e64a6267329c39e073a`.
- `functions/index.js` keeps one authoritative document:
  `_internal/oddsPapiDailyDiagnosticBudget` in Firestore `(default)`,
  transactional `reserveDiagnosticRequests(amount)` with
  `ODDSPAPI_REQUESTS_PER_UTC_DAY = 6` and UTC day rollover.
- The original `oddsPapiNbaMarketAudit` is deployed and callable; its
  old two-request manual audit and the prospective capture/settlement
  Functions must not be broken. The newly deployed
  `oddsPapiNbaIdentitySchemaDiagnostic` remains backend and UI
  disabled. 15 deployed Functions were **previously** owner-verified.
- The D15.4–D15.8 quota broker code is **unwired**: no private Cloud Run
  service, IAM grant or direct Firestore broker runtime has been created.
  `functions/index.js`, the live UI, Firebase rules and onCall code remain
  unchanged by D15.9.
- D12 general provider evidence release preflight remains **BLOCKED**.
  The existing prospective research ledger is protected against direct
  browser writes; none of this milestone relaxes that protection.

## Confirmed limitations from Google documentation

1. Firestore server SDKs authenticate using Google IAM and **bypass browser
   Firestore Security Rules**. Granting a broker runtime a database-scoped
   role that includes `datastore.entities.get` and
   `datastore.entities.create/update` permits equivalent operations on
   other documents covered by that role, including protected research
   records in the same database. Restricting IAM to database resource
   `(default)` is **not** an IAM permission restricted to
   `_internal/oddsPapiDailyDiagnosticBudget`. Do not infer safety from
   the broker code only referencing one path.
2. Firestore allows one database per project to receive the free tier.
   A second named database can incur charges even with only a few daily
   writes. **No new database may be created merely to try the design**
   without an owner-approved cost assessment.
3. Google recommends private service-to-service Cloud Run authentication
   with a Google-signed identity token and receiving-service-scoped
   `roles/run.invoker` granted only to the caller's service account.
   Those safeguards protect the HTTP entrance but do **not** solve a
   broker's backend Firestore privileges.
4. The unmetered preflight endpoint must not be confused with a full
   bookmaker/provider audit. The final real NBA market audit on
   16 November 2026 already established eight market families and
   1,512 named price entries, with zero main-line flags. The next
   provider call should be a **separately approved one-request identity
   schema diagnostic**, after safe integration—not another aggregate
   market audit now.

## Three architecture options and disposition

| Option | Research-ledger risk | Cost / integration impact | Decision |
| --- | --- | --- | --- |
| **A. New broker service account with Firestore write/read IAM on `(default)`** | A compromise of the account could access **other** documents covered by IAM, including research ledger records | Adds service/runtime and IAM footprint | **REJECT for now** — no document-scoped IAM |
| **B. Reuse the already privileged default budget-owner runtime identity** | Avoids **another** database IAM grant but creates a new request surface on an identity previously verified with project `Editor (Legacy)` | Avoids second database, but may expand project-wide compromise impact | **REJECT for now** pending privilege reduction, isolation and endpoint risk review |
| **C. Isolated named Firestore quota database** | Better database-level separation for a future quota-only runtime if **IAM scoped correctly**; no automatic research access | No free-tier guarantee; requires a coordinated safe migration of **all paid diagnostic consumers** | **PREFERRED SECURITY DIRECTION to investigate**, not approved or ready |

**Do not choose C solely on technical isolation:** the project prioritizes
approximately €0 spending and the current app already has working data.
A new database with an independent counter would create a **split-brain**
budget: legacy audit could spend up to six requests on the old counter
while the diagnostic could reserve six more on the new one. That is
unacceptable. An approved migration would require a documented freeze
of all paid provider calls, a complete inventory of every quota consumer,
a coordinated cutover, rollback conditions, and a single authoritative
counter before unfreezing. Cross-database Firestore transactions must
not be assumed atomic.

### Interim decision

**Keep every diagnostic gate disabled, do not grant the new broker
Firestore IAM and do not create a second database.** Continue with
provider-free review and staged secure code only. We need one explicit
owner architecture/cost decision before any cloud setup. No amount of
synthetic test success substitutes for that approval.

## Offline guard added in this milestone

`functions/offline-identity-quota-topology-review.js` and its tests
are source-only. `assessOfflineQuotaTopology` accepts one of the
known topologies and a **source snapshot** and returns:

- `status: "BLOCKED"`, `releaseReady: false`,
  `providerRequestAllowed: false` — **always**, regardless of any
  supplied boolean "review evidence".
- Explicit blockers for invalid or missing shared six-slot transaction,
  disabled backend flags, pinned diagnostic runtime identity, or if
  disconnected code is imported into `functions/index.js`.
- Topology-specific blocker codes: research-data exposure on default
  database, existing Editor runtime risk, or named-database costs,
  shared-counter migration and non-atomic cutover.
- Independent mandatory owner deployment/IAM/billing authorization,
  signed-token verification and provider-free rehearsal blockers.
- No Firebase/Admin/GoogleAuth import, network access, IAM mutation,
  provider key access, schedule, secret use, Firestore query or write.
  It is a decision-support review, **not** a live authorization system.

Passing a source-only test does not prove actual production IAM, price,
deployed revision or live budget state. A future deploy must independently
attest all those through the owner's read-only console/CLI checks.

## Google authentication dependency review

The official `google-auth-library` package currently reports a
v11.3.4 release in November 2026; Node.js 22 is a supported active
runtime in Google's client-library lifecycle guidance. Its
`OAuth2Client.verifyIdToken` and
`GoogleAuth.getIdTokenClient` interfaces fit the offline adapters, but
**this is not a full dependency/security audit**.

Before producing an executable private broker build:

- Pin an **exact, freshly checked** direct version in a separately
  reviewed broker package rather than adding an unbounded dependency
  to all existing Firebase Functions.
- Generate and review its reproducible `package-lock.json`;
  inspect `npm audit --omit=dev`, transitive advisories, Node22
  compatibility and any certificate-fetch/metadata network behavior.
- Verify exact Cloud Run forwarded Authorization header, signed token
  audience/issuer/email/expiry and IAM denial using a separately
  approved provider-free rehearsal.
- Reject service-account key files and avoid passing credentials from
  browsers. Use the metadata-backed dedicated runtime identity.
- No dependency upgrade, version change, lockfile or deployment was
  made in D15.9.

## Required next-session decisions

1. Keep `main`, backend identity diagnostic and UI stable. If approved,
   merge only the source-only D15.9 architecture gate.
2. Independently assess named-database per-operation costs and security
   compared with reducing default-runtime privileges. Get the owner's
   decision before committing to a topology.
3. In a separately reviewed follow-up, prepare a minimal native broker
   package plus exact pinned auth dependency/lockfile and a rollout/rollback
   runbook, with **no production deploy** until cost/IAM approved.
4. Only after explicit owner IAM/deploy approval and billing verification,
   perform a **provider-free** Cloud Run IAM/Google token rehearsal.
   Note that a real successful budget reservation will mutate the daily
   quota document; it requires a separate scoped permission.
5. After independent provider-request approval, one manual OddsPapi
   identity-schema request; then address exact ESPN mapping and line
   selection before considering another full market audit.

## References

- https://firebase.google.com/docs/firestore/security/iam
- https://firebase.google.com/docs/firestore/manage-databases
- https://firebase.google.com/docs/firestore/pricing
- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- https://www.npmjs.com/package/google-auth-library
- https://googleapis.dev/nodejs/google-auth-library/latest/classes/OAuth2Client.html
