# Update 35.1D14 — Disabled-by-default production integration routing

**Implementation state:** GitHub-only candidate for the existing `oddsPapiNbaMarketAudit` callable. **No Firebase deployment, paid OddsPapi request, live ESPN request, or production Firestore read/write was authorized or performed.** The user last reported Firebase billing at €0; this change does not independently audit or alter account billing.

## Starting point and rationale

Verified `main=3dc852fae7002bcd6e3e71e2b54bf093f81b9c9e` includes D5–D13. D11 composes the vetted, owner-only, quota-reserved manual audit, fixed-host transport, authenticated one-use source receipt, immutable Admin-style Firestore create-only storage and limited backend-only outcomes. D12's release preflight remains **BLOCKED** because real OddsPapi source fields and independent ESPN team mapping have not been established. Current production callable `oddsPapiNbaMarketAudit` exists, but does not connect D11.

D14 is the minimum **reviewable source-code wiring**, not authorization to enable or deploy evidence collection.

## Code changes

- `functions/manual-audit-evidence-dispatch.js` adds `makeManualAuditEvidenceDispatch(config)`. Only allowlisted trusted configuration is accepted. With missing/false `enabled`, it returns the **identical original audit runner function** without loading D11, making any new secret lookup, quota reservation, HTTP call, Firestore access or telemetry operation. With a literal backend `enabled:true`, the function lazily instantiates the existing D11 integration factory. The only exported function is the factory, **not a callable or direct paid endpoint**.
- In `functions/index.js`, the existing `oddsPapiNbaMarketAudit` retains its name, `europe-west1` region, secret binding, verified owner check, same user request semantics, `maxInstances:1`, `concurrency:1`, 120-second timeout, 512 MiB memory and the existing `runNbaMarketAudit` code. The new `NBA_PROVIDER_EVIDENCE_ENABLED = false` switch is a **hard-coded literal**, never a user argument or environment/remote flag. `runNbaMarketAuditRouted` equals the original runner in the default state. The trusted backend dependency descriptors are supplied only for a **future separately reviewed enabled implementation**. The original 1,200 ms provider cooldown and existing transactional six-upstream-reservations-per-UTC-day guard are passed to D11; no provider polling, extra fetch or paid request is introduced now.
- For a future explicit enabling change, the D11 path uses `getProviderApiKey: () => oddsPapiKey.value()`, the backend `fetch`, `getFirestore` Admin database, existing reservation guard, and **fixed-enum-only** backend failure/status callbacks. Raw provider IDs, player names, odds, source text, credentials and owner UID are not logged or returned by these callbacks. The enabled path is **mock tested, not live validated**; it remains off.
- D12 preflight now recognizes the D14 routed integration as `PRODUCTION_INTEGRATION_REQUIRES_SEPARATE_REVIEW` (rather than incorrectly saying not wired) and flags any missing/changed backend false switch, legacy fallback, import or routed invocation with `PRODUCTION_EVIDENCE_DISABLED_GATE_NOT_VERIFIED`. It remains **BLOCKED** even when all static tests pass. The original D12 and D10 tests are updated to keep these safety invariants.

## Verification and risk boundaries

Run Node.js 22 syntax/lint, every preexisting test (368), and D14's new synthetic dispatch tests. Tests assert the **actual original function is returned by reference** when disabled, owner/client-parameter gate, fixed origin, quota before secret, cache/concurrent click behavior, no extra paid request, sanitized outcomes, no Firestore without usable participant IDs, fail-closed provider/storage errors, immutable unreviewed snapshots, no browser write-rule change, and a literal disabled switch in `functions/index.js`.

**D14 is not permission to deploy.** Although the new source defaults off, deploying a Cloud Function may still incur Firebase cost and could replace a currently working deployed revision. The repository contains held draft PRs #16/#17 with source not necessarily present in `main` but with independently deployed Functions; never use a project-wide Firebase Functions deploy.

### Separate production approval gates

1. Owner reviews and explicitly approves **merging the D14 PR only**. Merging is not deployment; no browser or Android test is required until something actually changes in production.
2. Before any real deployment, separately approve an exact **single named Function** and a rollback plan after comparing live `functions:list` inventory, effective source, secret binding, IAM, budget and zero-spend assumptions. Take a snapshot of the deployed function's configuration/code identity; confirm deploying that function does not silently roll back another feature. Keep `NBA_PROVIDER_EVIDENCE_ENABLED` literally `false` for a disabled-route-only rollout.
3. A **future distinct PR/approval** would be necessary to switch `NBA_PROVIDER_EVIDENCE_ENABLED` to `true`. That change would permit backend Firestore snapshot reads/writes after one manually triggered owner-only provider fetch, which could incur charges. It must preserve the six-slot UTC reservation, one/two requests per manually authorized audit (catalogue cache-dependent), 1,200 ms cooldown, endpoint bounds and no retries; require separate permission for the actual metered request.
4. If/when approved, verify source field compatibility and storage outcome with exactly one controlled manual action, no blind retry or inferred IDs. Independent ESPN event/team evidence and manual revocable 2×2 mapping remain required before enabling automatic matching, line choice or research capture.

Do not present a mock `STORED` outcome as a real provider observation, Betano offer, approved mapping, model edge or audited ROI. D3 reviewed manifest remains EMPTY; D12 preflight remains BLOCKED until the independent live evidence and approvals exist.

## Exact intended file scope

`functions/index.js`, `functions/manual-audit-evidence-dispatch.js`, `functions/manual-audit-evidence-dispatch.test.js`, `functions/evidence-release-preflight.js`, `functions/evidence-release-preflight.test.js`, `functions/manual-evidence-outcome.test.js`, `functions/package.json`, and this documentation. No Firestore rules, frontend, automatic settlement, research ledger, credentials, dependencies or quota values changed.
