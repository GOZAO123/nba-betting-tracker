# Update 35.1D11 — Fail-closed backend integration readiness gate (OFFLINE)

**Status:** Inert backend-only implementation and synthetic tests. No production Cloud Function uses this module. No provider or ESPN requests, Firebase deployment, production Firestore operations, browser changes, automatic polling, model changes, capture or settlement.

## Why D11

At merged main `ed504d2ec81887586d813f54444665a7f63fad58`, the validated D5–D10 foundation has complementary components: D8 owner-authenticated parameterless manual audit and server-side quota reservation; D9 strict fixed-origin OddsPapi transport; D6/D7 immutable Admin-style source storage; D10 limited backend-only result signals. These have not been combined into an explicitly disabled-by-default integration boundary. In particular, source receipt authenticity still depends on a **trusted backend-owned** fetch and the existing quota guard.

The owner previously verified project billing displayed €0. This update only edits GitHub source and runs offline CI; it does not verify or affect Firebase account charges.

## New integration factory

`functions/manual-evidence-integration.js` exports `makeOfflineManualEvidenceIntegration(config)`.

- **Default off:** `enabled` must equal literal boolean `true` in **backend construction configuration** to instantiate the enabled pipeline; absent or `false` produces a frozen runner that rejects with `failed-precondition` before attempting auth, quota, secret access, transport, logging or Firestore. A browser/request cannot set `enabled` or pass any other override; D8 still rejects nonempty client request data.
- **Trusted dependency contract:** Enabled construction requires `ownerUid`, `reserveDiagnosticRequests`, `getProviderApiKey`, `fetchImpl`, `getFirestore`, `waitBetweenRequests` and a backend clock; optional `onFailure`, `onEvidenceOutcome`, `makeSignal`. Unknown config keys are rejected. These functions are accepted only from trusted server code; the factory does **not authenticate them** independently.
- **No eager operations:** Import and construction never request a provider key, open HTTP, reserve quota, create documents or initialize Firestore. A lazy cached Admin-style database facade is resolved only when D5 has actual validated evidence ready to store, and the same database instance supplies both document references and transactions. Missing/stale/duplicated identity records do not cause unnecessary Firestore initialization.
- **Fixed HTTP / manual cap:** D9 accepts the protected secret only at invocation and limits requests to the exact HTTPS catalogue and league endpoints, including NBA tournament 132 and `betano.pt`; no redirects, retries or browser-supplied URLs. D8 requires the verified owner and **existing transactional six-reservation-requests-per-UTC-day guard** before any fetch. Cold catalogue+league incurs two reserved slots, later league-only one, and concurrent/cached clicks share work. D11 does **not implement a new spend guard**.
- **Trusted immutable receipt:** D8 binds the single-use in-memory receipt to the same authenticated and quota-reserved manually fetched league response; D6/D7 allowlisted provider-ID records are only created by a backend Admin transaction with a create-only path. D10's optional backend-only status output is a fixed enum with no raw IDs/odds/player names/credentials/errors. No source evidence is promoted to a reviewed ESPN crosswalk.
- **Safe surface:** The factory exports only one owner-gated `run(request)` function, not raw `fetchOdds`, `getApiKey`, evidence token, storage adapter or manual enable control. `functions/index.js` remains unchanged and **does not import D11**. The live audit and all app behavior therefore remain unchanged.

## Verified limitations and explicit rollout gates

This is a **composition and readiness test**, not production authorization. The injected `getProviderApiKey` and `fetchImpl` must be trusted backend-sourced in any future integration; `enabled:true` in backend source alone is not sufficient proof of owner authorization. `waitBetweenRequests` is a required injected function and **must implement the provider's minimum cooldown** (existing 1,200 ms) when connected to production. The real `getFirestore` must return one correctly configured Admin database, using IAM and default-deny browser rules.

New tests validate default-disable behavior, permission denial before provider secret, daily budget cap, fixed URLs, cache/concurrency reuse, no database initialization without usable team IDs, immutable snapshot storage, failure isolation, and no raw metadata returned to the user. All effects are synthetic; real Firebase/IAM, live provider payload compatibility, production cost and browser behavior are **not** tested by these mocks.

- Intended **four-file diff**: `functions/manual-evidence-integration.js`, `functions/manual-evidence-integration.test.js`, `functions/package.json`, and this document.
- Node 22 lint + **307 existing tests and 21 D11 synthetic tests**.
- PR stays **OPEN/DRAFT/UNMERGED** until explicit owner approval for this particular PR. Merging will not deploy.
- **Separate explicit owner authorization required before** any targeted Firebase deployment, enabling runtime behavior, production Firestore write, paid OddsPapi request or ESPN call. No automatic OddsPapi polling. Do not deploy all Firebase functions while PR #17 preflight source is separately held.
- Actual bookmaker snapshot schema may omit sport/status/participant fields; D5 fails closed rather than guessing. Real ESPN scoreboard evidence, explicit 2×2 human-reviewed provider ↔ ESPN team mapping, revocation-safe history and verified Betano lines remain future milestones. Do not claim independently validated model EV, ROI or bookmaker prices.

**Additional-spend commitment:** This offline branch creates **zero incremental provider API requests and zero Firebase production operations**. Any future live Firestore transaction may consume billable usage and must be separately approved.
