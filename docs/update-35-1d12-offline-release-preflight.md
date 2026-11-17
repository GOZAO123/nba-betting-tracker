# Update 35.1D12 — Offline release preflight and targeted-deployment safety

**Purpose:** Avoid enabling the D5–D11 provider-evidence chain without verifying the remaining non-code authorization and source-identity requirements. This update is offline, read-only and explicitly **blocks** release. It neither queries Firebase/OddsPapi/ESPN nor writes production data.

## Verified starting state

At `main=bb35b496f712effe5ab97b657d68fb6f38da3a24`, D11 is merged and 328/328 Node 22 backend tests pass. The backend-only evidence integration is intentionally **not imported into production `functions/index.js`**, D3 reviewed mappings are empty, Firestore rules deny browser research writes and the server holds six upstream OddsPapi diagnostic reservations per UTC day. Held draft PRs #16/#17 contain source not necessarily synchronized with live Firebase deployment.

The prior `functions/README.md` contained a broad `firebase deploy --only functions` example. A project-wide deploy is unsafe while `main` and the independently deployed Functions differ; it could replace/delete an existing function unintentionally.

## New offline preflight

`functions/evidence-release-preflight.js` exports a pure `offlineEvidenceReleasePreflight(files)` analyzer and optionally runs as a **local read-only CLI** via `npm run preflight:evidence`. The five inputs are checked-out text of production `index.js`, `firestore.rules`, D3 team crosswalk, D11 integration factory and backend README. The CLI never imports production `index.js` (which would initialize Firebase), opens a network connection, reads secrets or triggers any function or provider.

It checks for:
- Six-request daily quota and backend transactional reservation code; weakening or disappearance is flagged.
- Default-deny browser Firestore research writes, no broad permissive recursive rule; unexpected modifications are flagged.
- D11's explicit default-disabled gate; unexpected production wiring is flagged for fresh review rather than treated as approval.
- Current empty D3 reviewed team manifest; an unexpected nonempty manifest is **not** treated as verified.
- Documentation instructing a broad Functions deployment rather than an individually approved named-function deployment.

Additionally, these real-world **external gates stay BLOCKED unconditionally**: actual OddsPapi source-field compatibility, independent ESPN-team evidence, deployed Firebase IAM/billing verification, explicit owner deployment approval and explicit owner-paid-provider-request approval.

Output consists only of `status=BLOCKED`, `releaseReady=false` and a bounded list of static blocker codes, never any project credentials, owner UID, raw provider IDs, fixture timestamps or source excerpts. The local CLI intentionally exits with **code 2** to prevent mistaken use as a passing deployment gate. A passed unit test means this safety mechanism is working, **not** that the production release is approved.

## README safety correction

`functions/README.md` now recommends local lint, test and blocked preflight only. It removes the broad deployment instruction and shows a *clearly non-executable pending approval*, **targeted** function-name example. No commands are executed by a documentation change. A deployment would still require separate owner approval, review of current live function inventory and exact source/secret compatibility, plus rollback plan; never deploy all functions while PR #17 remains held.

## Validation and cost

- Exact five-file diff: `functions/evidence-release-preflight.js`, `functions/evidence-release-preflight.test.js`, `functions/README.md`, `functions/package.json` and this document.
- Node 22 syntax/lint + **328 existing tests and 18 new D12 synthetic/static tests** (guard weakening, unsafe rules, incorrect wiring, altered mapping manifest, broad deploy command, malformed input, CLI exit and private output).
- No code changes to `functions/index.js`, Firestore rules, frontend, odds transport, backend quota, existing functions, package dependencies or model estimates.
- No live data reads/writes, Firebase deployment, ESPN or paid OddsPapi requests; **zero incremental metered usage for this update**. The owner's earlier Firebase billing check was €0, but this CI is not an independent cost audit.
- PR remains DRAFT/UNMERGED until separately authorized. A GitHub merge is not a Firebase deployment or permission for live OddsPapi calls.

**Limitations:** Static file inspection cannot independently establish production IAM, current deployed Cloud Functions, provider API response shape, Firebase billing, human approval, reviewed ESPN mappings or real Betano prices. It is conservative and intentionally cannot authorize a release automatically. A later planned milestone should prepare a one-function rollout proposal with measured cost ceiling, owner/manual action, rollback and user validation, before any actual metered observation is approved.
