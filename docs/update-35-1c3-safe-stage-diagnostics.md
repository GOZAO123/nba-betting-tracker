# Update 35.1C3 — Safe manual-audit failure diagnostics (draft)

## Why this exists

The first owner-approved 35.1C2 league market audit was triggered once on 13 November 2026 and returned `functions/unavailable`, while Firebase logs displayed no safe explanation. The owner verified the existing server-only daily guard at **3/6 requests reserved**, last reservation **12:39:44 UTC**, and separately checked the **unmetered** account endpoint: provider monthly usage **16/250** (previously 14/250). Assuming no other provider usage, that is consistent with the failed audit reaching the *first* metered upstream call, but does **not prove** which endpoint failed or why. No live prop markets were verified.

## Minimal change

The existing, manually triggered owner-only `oddsPapiNbaMarketAudit` callable now emits **one safe warning** if its internal runner fails after authorization. The warning has exactly two sanitized fields, `stage` and `reason`, both selected exclusively from a fixed enumerated vocabulary. Neither the thrown exception nor the provider response is logged.

Stages:

- `BUDGET_RESERVE` — checking / reserving the existing transactional 6-upstream-calls-per-UTC-day guard
- `CATALOGUE_FETCH` — retrieving and decoding official `/v4/markets`
- `CATALOGUE_VALIDATE` — rejecting unsupported, missing or oversized official definitions
- `COOLDOWN` — existing 1.2-second pause before the second request
- `LEAGUE_FETCH` — retrieving and decoding the fixed `/v4/odds-by-tournaments` league snapshot
- `LEAGUE_ANALYZE` — validating and aggregating exact market-ID matches

Reason codes include `RESPONSE_TOO_LARGE`, `UPSTREAM_HTTP_ERROR`, `RESPONSE_NOT_STREAMABLE`, `RESPONSE_JSON_INVALID`, `UPSTREAM_TIMEOUT`, `CATALOGUE_FORMAT_OR_COUNT_LIMIT`, `NO_ELIGIBLE_CATALOGUE_MARKETS`, `FIXTURE_FORMAT_OR_COUNT_LIMIT`, `MARKET_PROCESSING_LIMIT`, `SELECTION_PROCESSING_LIMIT` and safe generic fallbacks. These are **diagnostic categories**, not evidence of provider billing, exact endpoint response, or independently verified bookmaker pricing.

The existing Firebase callable still replies with its generic `functions/unavailable` message to the browser. To inspect the *server-only* category after a separately authorized future test, read scoped Firebase logs:

`firebase.cmd functions:log --only oddsPapiNbaMarketAudit --project nba-betting-tracker-3979d --lines 40`

Only the `NBA market audit safe failure` warning and its two enum fields should be shared; the Firebase CLI may also print surrounding system audit events with personal emails, IP addresses, OAuth IDs and service details — **redact those**.

## Safety and performance invariants

- No automatic OddsPapi polling, no change to UI, endpoint paths/parameters, API secrets, player/bookmaker data, research ledger, Firestore rules, cached quote behavior or settlement.
- Existing owner authentication and verified-email checks remain. Invalid/anonymous calls are rejected *before* any upstream work; these calls intentionally do not create new diagnostic logs.
- On cold-instance manual invocation, the same **two** daily budget slots are reserved *before* the first upstream attempt; up to two monthly requests can be charged. In-memory 12-hour market catalogue and 15-minute aggregate caches are unchanged. No retries and no refunding reservations.
- Keep existing **12 MiB decoded response cap**, **50,000 market-catalogue entry cap**, **250 fixture cap**, market/selection ceilings and 35-second per-request timeout. This PR does not guess the actual failure or relax any limit.
- Logs exclude provider response text, URLs and query strings, API keys, full `Error` objects, user identity, player names/IDs, odds, bet lines and prices. Error telemetry callback failures must never hide the original error or trigger new requests.
- No frontend changes; existing GitHub Pages app and Android/desktop zoom behavior remain untouched.

## Verification and release gate

Deterministic offline tests cover all enum mappings (including untrusted error text), budget denial, first upstream failure, empty and 50,001-row oversized catalogues, second upstream HTTP failure, invalid fixture response, logger failure, successful cache/no extra logs, and simultaneous callers emitting only one diagnostic. Existing end-to-end mock tests, lint, and GitHub CI must pass before review.

**This is a draft PR, not deployment authorization.** Development and tests make **zero** provider requests. PR merge, production Firebase deploy and any new metered audit click each require separate explicit owner approvals. If deployment is authorized, deploy **only** `functions:oddsPapiNbaMarketAudit`; a blanket `functions` deploy from `main` could remove live `oddsPapiAccountPreflight` because that source is still held in unmerged PR #17. PR #16 also remains on hold.

Further live-audit retries are **not** authorized by the approval to develop this offline diagnostic fix. The most recently observed provider monthly balance was **234 remaining**, and the last known daily reservation was **3 of 6** on 13 November 2026 UTC.
