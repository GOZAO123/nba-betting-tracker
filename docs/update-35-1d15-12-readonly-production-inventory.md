# Update 35.1D15.12 — Read-only production Functions inventory checkpoint

> **OFFLINE REVIEW CODE ONLY.** No Firebase deployment, IAM changes,
> Cloud Run service, Firestore/Secret Manager reads or writes, provider API
> requests, authentication tokens or paid OddsPapi requests were performed.
> **No live inventory was collected during this PR.**

## Current verified development state

- Starting GitHub `main` after owner-approved PR #62:
  `ab289bd796f39ccb49e15264c6a00c4df3001b43`.
- D15.11 added disconnected dual-Firestore/Secret-Manager quota helpers
  and a static source inventory of five direct and three delegated
  paid OddsPapi diagnostic pathways. They are **not deployed**.
- The existing Firestore transaction under
  `_internal/oddsPapiDailyDiagnosticBudget` remains the single *live*
  six-upstream-requests-per-UTC-day quota authority.
- The backend diagnostic and evidence gates stay literal false:
  `NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false` and
  `NBA_PROVIDER_EVIDENCE_ENABLED = false`. The D12 provider-evidence
  release preflight is still **BLOCKED**.
- The last 15 deployed Functions were verified by the owner after
  the disabled D15.2 deployment. Their **current revisions and IAM
  policies have not yet been independently rechecked**.
- Repository `functions/index.js` currently exports **14** Functions.
  The fifteenth, `oddsPapiAccountPreflight`, was separately deployed
  and its source is intentionally held in an unmerged PR. A global
  `firebase deploy --only functions` risks deleting it—do not run that.

## Purpose of this one-feature milestone

Prevent a partial quota cutover based on stale remembered Functions
or on GitHub source alone. The new offline checker validates a **pasted
Firebase CLI read-only inventory**, not actual permissions, provider use
or a deployed revision's source code.

New files:
- `functions/offline-production-function-inventory.js`: pure parser
  for the existing six-column `firebase functions:list` table
  (`Function | Version | Trigger | Location | Memory | Runtime`). Requires
  exactly 15 expected names (the 14 GitHub exports plus the known separately
  deployed preflight), generation 2, `nodejs22`,
  `europe-west1`, normal callable/scheduled triggers, and known memory
  sizes. Rejects duplicate, missing, unknown, renamed, unsupported and
  inconsistent rows; checks the **actual checked-out source exports and
  literal six-slot quota/disabled flags**. No network or SDK.
- `functions/offline-production-inventory-cli.js`: offline,
  **stdin-only** Node22 script to read the CLI table and local
  `functions/index.js`. Only prints allowlisted report fields and
  blocker codes; **never echoes an unexpected raw row**, credentials,
  UID, token, IAM principal, or other pasted text. No artifacts are saved.
- `functions/offline-production-function-inventory.test.js`:
  19 synthetic and source-regression tests: 14+1 correct inventory,
  absent preflight/diagnostic, new/unexpected exports, duplicate rows,
  wrong runtime/region/trigger, disabled flag or quota drift, unsafe
  console text, sanitized CLI behavior and strict no-cloud-I/O isolation.
- `functions/package.json`: add only Node22 syntax and regression test
  wiring. No dependency update or production entrypoint import.
- This document: exact read-only PC steps and future IAM proof checklist.

**It never issues an authorization receipt.** Even a perfectly
matching 15/15 inventory returns `status:"BLOCKED"`,
`releaseReady:false`, `paidProviderAllowed:false` and
`cloudChangesAuthorized:false`, because the following independent
evidence is still missing:

1. Live Cloud Run revisions/traffic and all other paid provider callers.
2. Actual service account identities, Cloud Run Invoker policies and
   default Firestore database IAM; browser Security Rules do not
   constrain server Admin SDK credentials.
3. Separately deployed account-preflight source and live behavior
   (intended **unmetered** only).
4. Real Secret Manager resource-scoped metadata `get/update` IAM,
   ETag CAS behavior and a safe all-callers migration.
5. Billing/cost report, rollback and explicit separate owner approval.

## When the user is at the PC: read-only inventory, one action at a time

**Do not execute these steps automatically or during this PR.** First
ensure a local checkout is on the intended GitHub `main` and includes
this future, separately approved/merged checker. Verify there are no
uncommitted changes before updating local source.

From Windows PowerShell in the **repository root**, first confirm
UTF-8 for the current PowerShell session. Then use the read-only pipeline:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
firebase.cmd functions:list --project nba-betting-tracker-3979d |
  node .\functions\offline-production-inventory-cli.js
```

**D15.12A colour-output correction:** The owner independently verified
the 15/15 live inventory on 19 November 2026, but the original parser
returned 0/15 because `firebase.cmd functions:list` emits ANSI SGR
colours (e.g. `ESC[90m`) around otherwise valid UTF-8 box-drawing
characters. Re-running the same pipeline after stripping **only** ANSI
SGR formatting in PowerShell produced `inventoryMatches:true`,
`observedCount:15`, `missing:[]`, `mismatched:[]`,
`unexpectedCount:0`, while `status:BLOCKED` remained correct.

This small code correction strips bounded ANSI **SGR colour attributes**
inside the offline parser, with additional regression tests for the
colour-coded stream and deliberate rejection of unrelated ANSI
terminal controls. It does **not** convert malformed byte encoding;
if the text still contains mojibake such as `Γöé`, configure
`[Console]::OutputEncoding` and `$OutputEncoding` above. No need to
strip formatting in a separate PowerShell `ForEach-Object` after
the corrected checker is locally updated from an owner-approved merge.
This is a review-tool fix only; it is not a deployment authorization.

This calls only **Firebase's administrative list endpoint**; it is NOT
an OddsPapi provider endpoint and does not deploy Functions or make
Firestore data queries. The Node process reads stdin locally and
prints only structural booleans, counts, **known function names if
missing or mismatched**, unknown-row **count** (never unknown row text)
and fixed blocker codes. No owner UID, API keys, token, IAM policy or
provider quote is needed. A matching inventory exits with code `0`
even though the rollout remains BLOCKED; an inconsistent or malformed
table exits `2`. **Exit code 0 is not production readiness.**

If the Firebase CLI changes its table format when piped to Node, stop
and ask for a review of the output shape. Do not bypass the check or
paste raw credentials to compensate. Pasting only the native Firebase
Functions list screenshot into chat is also an acceptable first step.

### After a matching 15/15 table — separately authorized READ-ONLY checks

The owner should inspect, without copying sensitive principals into
GitHub, each deployed Cloud Run service's revision/traffic and whether
the original `oddsPapiNbaMarketAudit` revision remains untouched.
The identity-schema diagnostic must still be hard-disabled in the
deployed revision, not only in local `main`. Confirm the preflight
remains independently deployed.

For a proposed **new** broker resource, review Google Cloud Console
Secret Manager resource IAM at the *single quota secret* level, not
the project, and verify no effective Firestore data access for the
dedicated identity account. Existing API-key secret permissions are
different; do not reuse or expose that secret. Since the quota metadata
secret has **not been created**, its current nonexistence is expected.

Inspect current billing and budget alerts in the Firebase/Google Cloud
Console before approving creation of any new resource. An unmetered
administrative list is not proof of €0 total cloud cost.

## Release and migration gates preserved

- No change to the previous D15.10 Secret Manager metadata hypothesis
  or D15.11 offline dual-reservation behavior.
- Do NOT enable metadata-only reservations or the one-request identity
  diagnostic until *every* live paid provider caller has adopted the
  same shared authority; old Firestore-only callers cannot coexist with
  new metadata-only callers under independently reset limits.
- All real service/IAM creation, budget writes and targeted deployments
  require separate owner authorization. Each metered provider request
  requires its own explicit approval and must reserve quota first.
- The full NBA market audit remains deferred until player/event identity
  and line selection evidence justify another two upstream requests.
- Keep research records protected from browser writes and do not grant a
  new broker Firestore database-wide IAM role. Preserve Android/desktop
  behavior, Lisbon HH:mm and the checklist 06:00 reset.

## Useful references

- https://firebase.google.com/docs/cli
- https://firebase.google.com/docs/functions/manage-functions
- https://cloud.google.com/run/docs/managing/revisions
- https://cloud.google.com/secret-manager/docs/access-control
- https://firebase.google.com/docs/firestore/security/iam
