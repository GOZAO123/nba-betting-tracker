# Update 35.2B — Loaded-only research coverage and data quality

## Scope
Add a **frontend-only, read-only** Research Data Quality section to the existing Prospective Ledger dashboard. It computes all values from `ledgerRows` already fetched by the owner-initiated Firestore pagination (50 records at a time), and updates after each explicit page load.

No Cloud Functions or Firestore rules changes. No new Firebase/ESPN/OddsPapi reads, paid requests, scheduled polling, background refresh, data mutation or settlement calls. Existing Google sign-in, checklist, performance dashboard, CSV export, captured price/probability records and desktop/Android viewport must remain unchanged.

## Metrics, caveats and layout
The new section uses the existing responsive 4/2-column KPI design and `researchCreate` text nodes (not HTML injection). It displays:
- Unique **ESPN game IDs**, **athlete IDs**, **team IDs** and distinct **Europe/Lisbon calendar game dates** (not the checklist's 06:00 day).
- Count of research market families represented out of the eight supported: PTS, REB, AST, 3PT, PR, PA, RA, PRA.
- Combined **top-three-game share** to illustrate correlated observations (not independent betting samples), with a warning when >=50%.
- Optional details tables for market distribution and three largest game concentrations. These are distributions of recorded, manually selected observations—not the number of bookmaker offers available.
- Local structural warnings for malformed/missing identity, server receipts, late capture timestamps, odds/line/market, frozen experimental estimates, duplicate event/player/market/line/side and settled results with missing outcome fields. They are **not independently verified market quotes**.
- A review-only panel for **PENDING** entries whose scheduled tip-off occurred at least 24 hours ago, listing player/team, market, side, line and elapsed hours. This does **not** invoke a live settlement request or infer DNP, a scored zero, loss, push, refund or verified bookmaker void.

All counters and warnings apply **only to loaded pages**. The existing query orders by `clientCapturedMs` and omits records without that field, so exhausting pagination does not establish a certified historical archive. Missing ESPN data and manual selection bias remain material limitations.

## Existing Paul George case
The 13 Nov 2026 verified owner export contained one historical pending **Paul George**, Celtics @ Raptors (event 401909968, 12 Nov 00:00 Lisbon). Prior issue #1 investigation found ESPN's final box score and event roster omitted his athlete row; manual trusted settlement correctly refused to treat his rebounds as zero or infer a DNP. Official NBA game details and recap identify him as inactive due to illness, but the deployed **ESPN-only** server rules do not accept an outside-source assertion and must remain fail-closed.

35.2B only **surfaces** the stale pending row for review. It does **not resolve or mutate** it. A separate owner-reviewed backend exception workflow would need independently verifiable official NBA game-specific inactive evidence, strict ESPN event/team/athlete identity cross-checking, immutable audit provenance, idempotency, rejection of partial/conflicting sources, and separately approved Firebase production deployment. Draft PR #16 (blocked NBA Stats/CDN fallback) remains held and must not be merged casually. Explicitly call any verified nonparticipation *research no-action*, not a Betano-confirmed void.

## Test acceptance
1. Node 22 parse of all inline JavaScript scripts (including ES modules); old initialization-order and mobile viewport checks.
2. Six new deterministic synthetic coverage tests: 31 records across 8 games/29 players/12 teams/8 markets, top-game concentration, old pending vs DNP, age threshold, invalid/missing/duplicate rows, empty/partial pages and side-effect guards.
3. Existing research-dashboard, CSV-export, capture/settlement and frontend regression suite remains green.
4. Review modified paths (frontend, tests, docs only), exact commit SHA and successful GitHub Actions run before any approval to merge.
5. Owner manually validates on Windows and Android **after** a separately approved merge: new stats should show 31 loaded records, 8 games, 29 players, 12 teams, 8 markets, 3 Lisbon calendar game dates, top-three-game share **19/31 = 61.3%** and exactly one overdue pending Paul George entry, assuming the source ledger has not changed meanwhile. New stats must not alter the 30 settled / 1 pending performance dashboard or CSV export.
6. Never claim model calibration/ROI or a verified bookmaker result from these numbers.

**No permission is implied to merge, deploy Firebase, invoke OddsPapi, or settle the Paul George record.**
