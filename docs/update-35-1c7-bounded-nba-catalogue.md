# Update 35.1C7 — Bounded global catalogue scan for exact NBA player-prop market IDs (offline draft)

## Confirmed evidence

On 14 November 2026 the owner separately authorized one manual NBA market audit after the 35.1C5 diagnostic deployment. Scoped Google Cloud logs at **10:46:12 UTC** returned the fixed-code warning `CATALOGUE_VALIDATE / CATALOGUE_COUNT_LIMIT`. The downloaded `/v4/markets` array **exceeded the old 50,000 global definition ceiling**. This is not evidence of the exact catalogue count, an NBA-specific count, a Betano Portugal offer, or useful player odds.

The separate unmetered `/v4/account` check after the test confirmed **19 used / 250 allowed, 231 remaining**, versus 18 used previously: one additional monthly provider request was counted. The runner failed before requesting league odds. The transactional diagnostic guard had reserved 2/6 on the day before this test; the post-test Firestore reservation count was not independently rechecked.

## Design and justification

Previously, the 50,000 limit was applied to **all sports globally before the NBA filter**, rejecting a legitimate large global catalogue even if just eight relevant NBA market definitions existed.

- Keep the **32 MiB maximum decoded JSON response** from `/v4/markets` and 512 MiB callable memory. Do not enlarge the provider response reader; `/v4/odds-by-tournaments` retains **12 MiB**. The API request shape, timeout, cooldown, reservations and cache are untouched.
- Introduce a separate **250,000 global definition scan ceiling** (provisional operational safety bound, **not** a measured catalogue size). Reject larger arrays before processing entries, with `CATALOGUE_GLOBAL_COUNT_LIMIT`.
- Retain **50,000 as the cap on unique, precisely eligible NBA full-game player-prop definitions**, checked only after exact sport, playerProp, family name, period, positive half-point handicap, and two Over/Under outcome-ID checks. Reject overflow with `CATALOGUE_NBA_SUBSET_LIMIT`. NBA remains restricted to existing eight supported market families.
- Preserve the existing global `seen` ID set and duplicate-ID quarantine so that **even a duplicate declared under a different sport** invalidates a conflicting candidate NBA market ID. The global set is capped at 250,000 scanned definitions; the retained NBA map is capped at 50,000. No market/price/player data is added to logs.
- Retain legacy `CATALOGUE_COUNT_LIMIT` mapping for old injected errors to avoid changing historical diagnostic semantics. New classifications are fixed safe strings only.
- Keep all aggregate output and independent verification caveats unchanged: matching an official ID does not establish a current bookmaker offer, ESPN player identity, or a validated predictive edge.

This is a finite two-tier scan, **not unbounded processing** or a guarantee that the unknown actual OddsPapi catalogue will fit within 250,000 definitions. No provider payload was stored and no actual market ID or price was used to write these tests.

## Offline acceptance tests

- Synthetic global catalogue with **75,009** definitions and eight NBA candidates succeeds; a cross-sport duplicate ID is quarantined even if it appears earlier. Check exact market mapping and aggregate counts.
- Global limit: **250,000** entries accepted, **250,001** fail closed before league odds.
- Eligible NBA subset: **50,000** distinct valid definitions accepted, **50,001** fail closed before league odds, independent of global length.
- Runner synthetic **75,001**-entry catalogue completes one eligible league snapshot, reserves exactly two slots and serves subsequent cached result with zero further requests.
- Static failures emit only `CATALOGUE_GLOBAL_COUNT_LIMIT` or `CATALOGUE_NBA_SUBSET_LIMIT`, no user-provided payload in logs. Existing owner authentication, single-flight, quota, cache, error and response-reader tests remain in the complete Node 22 backend suite.
- Run Node 22 syntax/lint and all backend regression tests; **do not claim they passed until CI confirms**.

## Strict release gates

**Draft-only offline implementation**. No paid OddsPapi calls, production Firebase deployment, commit to `main`, Firestore changes, or GitHub Pages changes are authorized by the user's permission to proceed with the offline fix. Approval to merge this PR must be explicit and separate from any later targeted production deployment. Any later manual audit requires yet another explicit approval, after checking the provider monthly usage and six/UTC-day diagnostic budget.

PR #16 and PR #17 remain held/unmerged. A later deployment must target **only** `functions:oddsPapiNbaMarketAudit`, never blanket-deploy functions while `oddsPapiAccountPreflight` is separately deployed from held source.
