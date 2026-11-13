# Update 35.1C2 — Manual read-only league prop market audit (draft)

## Purpose and existing state

- The owner-approved 35.1B preview returned **597 unmapped market IDs**, **1,907 active market objects**, **1,592 named entries** across **8 active Betano PT fixture objects**, in one metered league request on 13 November 2026. It did not save the raw response. Those historical totals cannot be retroactively remapped.
- Update 35.1C (#20) added a pure synthetic-tested catalogue-to-league matching helper, `functions/league-market-audit.js`.
- This draft connects that helper to a **new, manually triggered, owner-only Firebase callable**, `oddsPapiNbaMarketAudit`, and a separate Developer tools button. It does NOT change the existing one-request coverage preview or ledger.

## Fixed provider requests and costs

Only after explicit owner confirmation in the UI, and only if Firebase authorization and six-request UTC-day budget reservation succeed:

1. `GET https://api.oddspapi.io/v4/markets?language=en` — **one metered request**, global official catalogue.
2. `GET https://api.oddspapi.io/v4/odds-by-tournaments?tournamentIds=132&bookmaker=betano.pt&language=en&verbosity=3` — **one metered request**, single bookmaker's NBA league snapshot.

A cold function instance reserves **2** diagnostic slots transactionally before either network call, against the **unchanged server-enforced limit of 6/UTC day**. On failure, unspent reservations are conservatively not refunded. Only **one attempt per endpoint**, with no retries or automatic polling; fixed URLs/params (client cannot choose endpoints). A 1.2-second delay follows the catalogue request to respect its documented 1-second cooldown.

Within the *same live function instance*, the validated official catalogue may be reused for up to **12 hours** (so a later explicitly approved fresh league audit uses **1 request**, reserving 1 slot). A successful aggregate snapshot is cached for **15 minutes** (repeat click uses **0 requests**). These in-memory caches are best-effort and can disappear on instance restart: **never assume a click will be free**. All live uses still require separate user approval, even with a free subscription. The frontend confirmation warns about **up to two quota-consuming requests**.

Both payloads are stream-read with a decoded size limit of **12 MiB each** using the existing reviewed `readLimitedJson` helper; 35-second timeout per upstream fetch; any oversized, malformed, failed, or inconsistent data fails closed. Responses from the server contain only summary totals and **eight market-family rows**: official market-ID matches, provider active entries, freshness and explicit primary-line flags. No raw bookmaker prices, player names/IDs, quote line values, provider secrets, or full market definitions are returned.

## Important interpretation limitations

- Matching an active market ID to an official catalogue definition establishes **provider metadata compatibility only**. This is **not independent verification of actual current Betano.pt quotes**, ESPN identity, player participation, bookmaker bet availability, or betting profitability.
- Eligible families: PTS, REB, AST, 3PT, PR, PA, RA and PRA, using exact **full-game including overtime** `playerProp=true` definitions, positive half-point lines and two uniquely identified Over/Under outcomes. Unknown/duplicate catalogue IDs, non-NBA games, inactive bookmaker/markets/selections, nonnumeric prices and unusable timestamps are handled conservatively. Zero matching data can mean unavailable OR unmapped/filtered; not proof of absence.
- Provider timestamps are reported as recent (within 15 min), older, or missing/invalid. No result is stored as an offer or sent to the research ledger. ESPN roster checks remain a **separate manual action**.
- This draft does not claim source data from the previous 35.1B request. Any new live execution fetches a *new* provider snapshot.

## Validation and release gates

- New pure runner and tests cover owner authorization, rejected user parameters, shared Firestore quota reservation before upstream calls, cache expiry, single-flight behavior, non-retry, invalid catalogue, provider failures and returned summary privacy. Test against real repo with GitHub Actions and full regression checks before review.
- Frontend handler displays only safe text via `textContent`, requires user confirmation, disables duplicate clicks, validates response shape and displays Europe/Lisbon 24-hour times. Preserve mobile/desktop layout/zoom and existing checklist/Google sign-in.
- **No changes to Firestore security rules, scheduled jobs or research capture/settlement.**
- **Never deploy all Firebase Functions from `main`:** the existing deployed `oddsPapiAccountPreflight` callable source is still exclusively on unmerged PR #17. After a distinct explicit deployment approval, use **only** `firebase.cmd deploy --only functions:oddsPapiNbaMarketAudit --project nba-betting-tracker-3979d` from the reviewed commit, then verify all previously deployed functions remain. Do not merge PR #16 or #17.
- PR merge, targeted Firebase deployment, and **each first live metered OddsPapi test** require **separate explicit owner approvals**. No API request or deployment is performed by creating or reviewing this draft.

References: https://oddspapi.io/en/docs/get-markets · https://oddspapi.io/us/docs/get-odds-by-tournaments · https://oddspapi.io/us/docs/requests-and-quota
