# Update 35.1D15.2 — dedicated runtime identity preflight (NOT deployed)

## Decision and scope

The existing `oddsPapiNbaMarketAudit` Cloud Run revision
`oddspapinbamarketaudit-00010-tof` remains at 100% traffic and runs as the
project's default Compute Engine service account. A read-only owner screenshot
confirmed that account has project-wide `Editor (Legacy)` and direct
`Secret Manager Secret Accessor` access to `ODDSPAPI_API_KEY`.
This is unnecessarily broad for the **new** identity-schema callable.

D15.2 changes exactly one runtime option in `functions/index.js`:
`oddsPapiNbaIdentitySchemaDiagnostic` selects a dedicated, user-managed
service account `nba-identity-schema@nba-betting-tracker-3979d.iam.gserviceaccount.com`
using the Firebase 2nd-gen `onCall` **per-function** `serviceAccount` option.
The account does **not** yet exist merely because code names it. Its creation
and IAM grants require a **different, explicit owner authorization**.

No global runtime option is changed. All other function identities, legacy
audit routing, Google sign-in, research ledger and Firestore rules remain
unaltered. The backend gate
`NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false`, frontend gate
`NBA_IDENTITY_SCHEMA_UI_ENABLED = false`, and legacy
`NBA_PROVIDER_EVIDENCE_ENABLED = false` remain unchanged.

## Two-phase IAM plan (review BEFORE doing anything in Google Cloud)

**Phase A — disabled-only rollout; after separate IAM and deployment approvals**

1. Create *only* the named user-managed service account in the existing
   Google Cloud project. Do **not** create/download JSON service-account
   keys. It must have **no** project-wide `Owner`, `Editor`, `Firebase Admin`,
   or `Secret Manager Admin` role.
2. Ensure the deployment actor / relevant Google-managed deployment service
   agents can impersonate/attach this account as required by Firebase 2nd-gen
   deployment. Grant `Service Account User` only where needed for deployment,
   **not** to the runtime account itself. Inspect effective permissions.
3. Permit the dedicated runtime identity to read **only**
   `ODDSPAPI_API_KEY` via secret-level
   `roles/secretmanager.secretAccessor`. Do not use project-wide
   Secret Accessor. Verify the secret has an enabled version without viewing
   its value. The existing account's secret access must remain untouched.
4. Initially give **no** Firestore data permission to the new identity.
   Because the callable's owner-checked backend flag is literally false,
   it rejects before secret lookup, budget reservation, or database access.
   (Confirm Firebase's deployment service/secret binding requirements
   separately before authorizing the deploy.)
5. Before any deployment, verify the entire 14-function inventory, current
   known-good audit revision/traffic, budget and billing, and the new
   account's actual grants. Deploy **only**
   `functions:oddsPapiNbaIdentitySchemaDiagnostic`, never the whole codebase.
   Do not use `--force`. Deployment/creation is not authorized by this file.

**Phase B — later enabled diagnostic; separately reviewed and approved**

6. The *enabled* runner needs Admin SDK read/write transactions on the
   single budget document `_internal/oddsPapiDailyDiagnosticBudget`
   to enforce the shared **six upstream requests per UTC day**. No
   `runTransaction` privilege means the request must fail closed.
7. Before enabling it, design and verify suitable **database-scoped**
   Firestore IAM permissions. `roles/datastore.user` is a supported
   coarse-grained read/write role, **but it allows access to all documents
   in the permitted database**, not just the budget document. Firestore
   document Security Rules **do not restrict Admin SDK IAM callers**.
   Review a custom IAM role with only the necessary Firestore transaction,
   document read and write permissions if practicable; test permissions in
   an isolated/emulated environment before production activation. Per-database
   IAM conditions may narrow the *database*, not the document path.
8. The enabled path must still preserve verified-owner-only access, strict
   empty request data, fixed provider origin and tournament/bookmaker,
   server quota reservation, zero automatic polling and sanitized output.
   Obtain **separate approvals** for backend enabling, frontend enabling,
   and **each real metered provider test**.

## Rollback and isolation

- The new named callable is not yet deployed. Failure to provision its
  dedicated identity is a **stop**, not permission to fall back to the
  broad default compute identity.
- During initial disabled-only deployment, preserve all 14 existing
  Functions, especially `oddsPapiAccountPreflight` (live but absent
  from `main`) and the old market-audit revision receiving 100% traffic.
- If new deployment or IAM verification fails, **stop**. Do not change
  audit traffic, rotate secrets, broaden roles or delete services. Plan
  an explicit, owner-approved rollback for the new named callable only.
  A rollback has not been rehearsed in production.
- The Google Cloud billing report for the project showed EUR 0.00 net
  for 1–18 Nov 2026 after savings, **not** a promise of zero future costs.
  New service-account/role configuration and Cloud Run deploy cost/risk
  need fresh confirmation before approval.
- The existing D12 `preflight:evidence` remains intentionally
  `BLOCKED` (`releaseReady:false`, exit 2); this D15.2 change
  **does not** override the general evidence-release gates.

## Offline validation

Use Node.js 22 and run:

```powershell
npm.cmd --prefix .\functions run lint
npm.cmd --prefix .\functions test
node --test tests/research-dashboard.test.cjs
npm.cmd --prefix .\functions run preflight:evidence
```

Expect the preflight to remain BLOCKED; do not normalize its nonzero exit
status to success. These checks use synthetic provider responses only.
A passing test does not verify live IAM bindings or authorize deployment.

Authoritative references:
- https://firebase.google.com/docs/functions/manage-functions
- https://firebase.google.com/docs/firestore/security/iam
- https://firebase.google.com/docs/firestore/manage-databases
