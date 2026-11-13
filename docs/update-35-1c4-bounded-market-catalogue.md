# Update 35.1C4 — Bounded official market-catalogue response

## Verified failure

On 13 November 2026 at 15:08:56 UTC, a separately authorized manual NBA market audit failed with the safe log warning **CATALOGUE_FETCH / RESPONSE_TOO_LARGE**. The global OddsPapi markets endpoint exceeded the old shared **12 MiB decoded JSON response limit**, so the audit aborted before attempting league odds. This is a confirmed byte-limit failure, not proof that later catalogue mapping will succeed, and not proof of any specific billing amount.

## Scope

1. Keep the pre-existing **12 MiB** decoded-response limit for every current league-odds and feasibility diagnostic call.
2. Introduce a distinct **32 MiB** decoded JSON ceiling only for the manual audit of the official global markets catalogue.
3. Reuse the exact existing bounded streaming reader, with two fixed-cap wrappers. No caller can choose an arbitrary unbounded size. An oversized declared Content-Length is rejected early, and streamed decoded bytes are always counted even when Content-Length is absent, compressed, or falsely low. Cancel oversized streams, reject malformed or incomplete JSON.
4. Select the larger reader only for the exact /v4/markets path in the existing oddsPapiNbaMarketAudit helper. The /v4/odds-by-tournaments response still uses 12 MiB.

The **32 MiB** cap is provisional, **not an observed actual response size** and not a guarantee of success on a future authorized audit. Increased JSON memory is bounded but could still require monitoring; keep 512 MiB Firebase function memory unchanged unless a separate problem is demonstrated.

## Invariants

- Preserve the **50,000-definition** catalogue ceiling and strict sport, league, period, family, handicap and outcome-ID verification. Also preserve 250 fixtures, 18,000 market objects and 180,000 selections limits.
- Preserve 35-second upstream timeout; 120-second callable timeout; 12-hour in-memory catalogue and 15-minute snapshot caching; 1.2-second provider cooldown; single-flight; no retries or polling; the server-side transactional **6/UTC-day** quota reservation and up-to-two-reservation cold start.
- Preserve owner-only verified authentication, server-only secrets, generic UI errors, existing fixed-code safe diagnostic warnings, Firestore security, ESPN identity verification and all unrelated frontend/backend features.
- Do not record raw market responses, odds, player names or other sensitive provider data. This feature reports aggregate research diagnostic counts only and does not verify individual bookmaker prices or model accuracy.
- No changes to the user-visible frontend or to the endpoints/parameters sent to OddsPapi. PR #16 and PR #17 remain held.

## Offline tests

- A >12 MiB synthetic JSON catalogue fails with the old odds reader but is accepted by the catalogue-specific reader.
- Oversized declared Content-Length is rejected before body reads; streamed bytes >32 MiB are rejected despite false low header.
- HTTP errors, malformed JSON and absent body fail closed.
- The original manual runner can consume a synthetic >12 MiB catalogue, still reserves 2 before any injected fetch, calls one catalogue and one league mock, preserves exact mapping and serves subsequent cache hits without requests.
- Static wiring tests ensure only /v4/markets gets the higher fixed cap, and the shared NBA odds reader remains 12 MiB. Existing 67 tests remain part of CI.
- Verify Node 22 backend syntax and all tests in GitHub Actions. Never claim test success before CI reports it.

## Limitations and release gates

The full market catalogue may still exceed **32 MiB**, have more than **50,000** entries, or have no eligible exact NBA player-prop market IDs. Those conditions must continue to fail closed without any second provider call. There is no claim of verified bookmaker offers or profitability.

**This is a DRAFT PR only**. Offline development is authorized; **merge, Firebase deployment and paid OddsPapi retesting are NOT approved**. A separately approved future Firebase deployment must target **only** functions:oddsPapiNbaMarketAudit. Never blanket deploy functions from main: production oddsPapiAccountPreflight remains present although its source is in held PR #17. All 13 production functions must remain.

The previous two manual audits were single-use approvals already spent. The second audit probably reserved another two diagnostic slots on 13 November 2026 UTC; verify daily reservation and separate owner approval before contemplating another live click.