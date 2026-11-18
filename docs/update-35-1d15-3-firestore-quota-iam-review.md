# Update 35.1D15.3 — Firestore quota IAM security review (OFFLINE ONLY)

> **NO IAM GRANTS, NO FIREBASE DEPLOYMENT, NO ODDS PROVIDER REQUESTS.**
> The candidate permission list below is a review artifact, **not** a role
> creation script or an instruction to attach these permissions in production.

## Verified starting point — 18 November 2026

- GitHub `main` at `c1317cf9eb03a95959ab6b2b92a9b011be065d1b`.
- New `oddsPapiNbaIdentitySchemaDiagnostic` deployed separately as Gen 2 in
  `europe-west1`, under the dedicated `nba-identity-schema` runtime service
  account; backend flag `NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false`.
- Frontend `NBA_IDENTITY_SCHEMA_UI_ENABLED = false`; existing audit's routing
  and `NBA_PROVIDER_EVIDENCE_ENABLED = false` remain unchanged.
- 15 production Functions, including all previous 14. Original
  `oddspapinbamarketaudit-00010-tof` at 100% traffic after deployment.
- Dedicated runtime service account has existing **secret-level** Secret
  Accessor on `ODDSPAPI_API_KEY`; no Firestore data role has been approved.
- Local Windows D15.2 validation: backend 425/425 and frontend 106/106 passed.
  D12 production-evidence release preflight remains deliberately **BLOCKED**.

These are historical owner-verified checkpoints, not a new live IAM audit.

## Exact existing quota dependency (do not migrate casually)

The production `functions/index.js` `reserveDiagnosticRequests(amount)`
uses the Firebase Admin SDK and the **same** budget counter as other legacy
manual diagnostic Functions:

1. Validate a reservation of 1 or 2 calls and compute `utcDay` in UTC.
2. Read **only** `_internal/oddsPapiDailyDiagnosticBudget` in a Firestore
   `runTransaction` callback using `transaction.get(ref)`.
3. Reject corrupt same-day counters and any amount exceeding **6 reserved
   upstream requests per UTC day**.
4. Persist `utcDay`, `reserved`, `limit` and `lastReservedAt` with
   `transaction.set(ref, ...)`; this is an **upsert with no existence
   precondition**, so both document creation and update must be supported.
5. On Firestore errors, fail closed with an `unavailable` error, *before*
   provider transport. Never refund uncertain reservations or retry a paid
   request automatically.

The new callable is **currently hard-disabled** before any secret read,
Firestore operation or HTTP call. Passing the offline test suite is not a
production permission test or an authorization to activate it.

## Candidate minimum Firestore API permissions — NOT APPROVED

Google's documented native Firestore API-to-IAM mapping indicates the
following **candidate** permission set for the existing transaction shape.
The Firestore SDK may have additional metadata/runtime requirements that
must be verified with safe, isolated effective-permission testing.

<!-- CANDIDATE_PERMISSIONS_BEGIN -->
```text
datastore.databases.get
datastore.entities.get
datastore.entities.create
datastore.entities.update
```
<!-- CANDIDATE_PERMISSIONS_END -->

- `datastore.databases.get`: begin/rollback transaction.
- `datastore.entities.get`: read budget document.
- `datastore.entities.create` **and** `datastore.entities.update`: commit an
  unconditional `transaction.set` for a missing or existing document.
- Deliberately **not** included: `datastore.entities.list`,
  `datastore.entities.delete`, broad `roles/datastore.user`, database
  administration and project-wide Owner/Editor.

**Critical limitation:** IAM document-data permissions are not confined to
the specific Firestore path the code uses. On the current shared default
database, these four permissions can permit reading and creating/updating
other documents too, including protected research records. Browser Firestore
Security Rules do **not** constrain server/Admin SDK IAM access. A custom
role is therefore **less broad than `roles/datastore.user`, but is not
document-level least privilege**. Do **not** grant it to the new runtime
identity merely because these four permission names are correct.

## Options and recommendation

| Option | Benefit | Critical cost or security issue | Decision |
| --- | --- | --- | --- |
| Direct custom role on the current `(default)` database | Smallest API permission list for the existing Firestore transaction | Still authorizes operations on other shared-database documents | **Not approved** |
| Separate Firestore budget database, database-scoped IAM | Isolation between quota and research records | Only one Firestore database receives free tier, and moving just this diagnostic would **break the global shared six-request counter** unless all writers migrate | **Do not create** |
| Dedicated server-side budget reservation broker | Dedicated identity could call a narrowly authorized internal service while a trusted backend retains the *existing* shared Firestore counter | Extra identity/authentication, service endpoint, latency, deployment and possible cloud costs; must reject impersonation, forged amounts and replay/duplicate reservations | **Preferred design candidate for a later separately approved update** |
| Leave diagnostic disabled | No new Firestore permissions or provider spend; preserves existing 14 Functions | Cannot collect live identity-schema evidence | **Current safe default** |

A broker, if designed later, must enforce a trusted caller identity, exact
single-request reservation, existing UTC quota transaction, explicit-only
invocation, fixed target origin, no browser-visible credentials and a
strictly scoped service-to-service invocation permission. The broker must not
weaken or redeploy the existing market-audit service or create a second,
unshared six-request budget.

## Offline validation contract

- Source-level tests must keep the dedicated runtime identity and literal
  disabled gate pinned, with the old market audit untouched.
- Tests load the **actual production reservation function** into an isolated
  synthetic Node VM and simulate a Firestore permission denial. It must fail
  closed, without exposing a synthetic backend error.
- Synthetic transaction tests verify the existing 6-slot UTC ceiling and the
  absence of a seventh successful reservation.
- Tests assert the single fixed budget document and exactly the four
  **candidate** permission names above, without granting a real role.
- Firebase emulators and mocked Firestore do **not** prove actual Google Cloud
  IAM authorization; effective privileges require separately approved live
  assessment. Production denial must never be followed by a paid request.
- Regression expectations: existing 425 backend tests + 3 D15.3 tests,
  existing 106 frontend tests, and D12 preflight still
  `BLOCKED`/`releaseReady:false`/exit 2.

## Hard stops and next authorization gates

Do not change `NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED` or the frontend gate,
modify Firestore rules, create another database or service, grant Firestore
roles, deploy Functions, invoke OddsPapi, or merge this review without the
owner's explicit approval of the applicable operation. Any future activation
requires a documented threat model, denial tests, verified IAM and cost
scope, targeted deployment approval, and **separate approval for each paid
provider request**. Preserve the existing D12 BLOCKED state and original
audit revision.

## Authoritative references

- [Firestore native server IAM permissions and method mapping](https://docs.cloud.google.com/firestore/native/docs/security/iam)
- [Firebase: server Admin SDK bypasses Security Rules](https://firebase.google.com/docs/firestore/security/get-started)
- [Firebase Firestore free tier: one database per project](https://firebase.google.com/docs/firestore/pricing)
- [Firebase emulator IAM limitations](https://firebase.google.com/docs/emulator-suite/connect_functions)
