# Update 35.1C — Offline league market-ID audit (draft foundation)

**Scope:** Pure Node.js helper and synthetic unit tests. Not connected to the live app, Firebase Functions exports, or automatic jobs. No request to OddsPapi, ESPN, or Firestore, and no browser data or research records are written.

## Why

The owner-approved league preview on 13 November 2026 at 11:29 Europe/Lisbon reported 20 provider fixtures, 9 upcoming within 72 hours, 8 active `betano.pt` fixture objects, 1,907 active market objects, 597 **unmapped** distinct market IDs, and 1,592 named active prices. Only 456 of those had `changedAt` within 15 minutes; all player names and prices remain **unverified**. The snapshot displayed aggregate counts; it did not persist the full market catalogue or raw response. These counts cannot retrospectively be matched to the catalogue.

The provider's public v4 documentation confirms that `GET /v4/odds-by-tournaments` supplies market and outcome IDs, while `GET /v4/markets` supplies market ID, full name, player-prop flag, sport, handicap, period, and Over/Under outcome definitions:
- https://oddspapi.io/en/docs/get-markets
- https://oddspapi.io/us/docs/get-odds-by-tournaments
- https://oddspapi.io/blog/json-odds-feed-format-parsing/

## What `auditOfficialLeagueProps` does

Accepts two **independently supplied** in-memory JSON payloads (official definitions and tournament fixture odds) plus an explicit timestamp. The helper itself cannot fetch either payload. It joins by *exact* canonical market ID and outcome ID, and returns only aggregate family counts for the app's eight full-game, including-overtime categories: PTS, REB, AST, 3PT, PR, PA, RA, PRA.

It requires basketball sport 11, exact recognised market names, `playerProp === true`, an allowed fulltime period, non-negative **half-point** handicap, two uniquely mapped Over/Under outcomes, active `betano.pt` bookmaker, active markets and named/active/valid decimal-priced player IDs. A duplicated catalogue market ID is quarantined. It rejects non-NBA, out-of-window, duplicate, suspended and invalid data, with upper limits on fixture, market and selection traversal. Freshness is counted from `changedAt` (<=15 min), separately from stale or missing timestamps; `mainLine === true` is counted but never assumed.

It does **not** return a player name, player ID, decimal price, betting line, raw bookmaker data, API key, or claimed ESPN identity; it does not independently confirm Betano quotes. A catalogue-ID match proves only provider metadata mapping, **not** live bookmaker quote accuracy. The statistics are not a bet-selection or expected-value model.

## Release gates and known limitations

1. Run local syntax check and tests, and GitHub Actions backend/frontend CI. This draft does not add or change an exported Firebase function or change `index.html`.
2. Review exact mapping against **new owner-approved** catalogue and league data when available. There is no historical raw 13-Nov feed saved to analyze offline. Any additional metered provider request needs separate owner approval and must respect the six-upstream-requests/UTC-day backend guard. Do not attempt to re-run the existing live coverage button merely to populate the new offline helper.
3. Plan a separate, narrowly scoped feature to reuse verified metadata in a manually triggered read-only diagnostic, without increasing upstream requests or persisting raw odds. This requires explicit review, tests and permission for any production Firebase deployment.
4. ESPN athlete identity must be matched to an exact team/game roster, with ambiguities excluded, before an offer can be considered research-ready. Retain explicit manual bookmaker quote confirmation and trusted server capture. Avoid repeated ESPN lookups and browser Firestore ledger writes.
5. The `oddsPapiAccountPreflight` function is still deployed from the **unmerged** PR #17 but not present in `main`. Do not deploy all Firebase Functions; only separately approved named deployments until code/deployment state is reconciled.

This draft is intentionally a building block, not a working league-wide verified props preview. Do **not** attribute the seven synthetic tests to a production or independently verified Betano dataset.
