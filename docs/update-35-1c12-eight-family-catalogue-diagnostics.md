# Update 35.1C12 — Eight-family NBA catalogue diagnostics

## Source evidence and intent

On 15 November 2026, the owner-approved 35.1C10 live OddsPapi audit reported 70,742 global catalogue definitions, 8,883 `sportId=11`, 440 `playerProp=true`, **248 exact family-name matches** across the application's eight supported NBA player-prop families, and **0 matching its strict period gate**. It logged no raw market IDs, offers, athlete data or period values. A later unmetered account check confirmed 21/250 monthly requests used (from 20/250 immediately before the audit); Firestore confirmed 2/6 reserved for UTC 15 November. Do not assume either usage number remains current at a later test.

Update 35.1C11 added six privacy-safe period buckets and was squash-merged to `main` as `d8b43615b0e2dd4fd23d955f346f13f4c40fef2a`. **It has not been deployed to production Firebase.** The real period distribution among those 248 live definitions remains unknown.

To avoid spending one request per supported family, C12 extends the *same bounded, single catalogue scan* to diagnose all eight fixed families (PTS, REB, AST, 3PT, PR, PA, RA and PRA) simultaneously. The audit function **still may use up to two upstream calls** if catalogue validation succeeds, but if no eligible market survives it fails before fetching league odds.

## Implementation

The pure offline analyser produces an additional frozen `catalogueFamilies` object, keyed only by the eight fixed family abbreviations. Each entry counts, **for first-seen valid IDs that already passed sport 11, true player-prop, and exact supported family name**:

- `definitions`: family total before period gating and late global cross-sport duplicate-ID quarantine.
- The six fixed period bins from C11: `missingOrNull`, `exactFulltime`, `exactResult`, `knownPartial`, `otherString`, `nonString`.
- `halfPointLineIndependent`: positive finite number ≤1000 on a half-point (not whole number), **regardless of period validity**.
- `overUnderPairIndependent`: exactly two distinct valid outcome IDs with one exact `Over` and one exact `Under`, **regardless of period or line**.
- `lineAndPairIndependent`: intersection of both above structural conditions.
- `resultLineAndPairIndependent`: subset of line-and-pair-valid definitions whose period is exactly the provider label `result` (still **rejected by the unchanged live validator**).

All checks use the exact existing strict half-point and Over/Under predicates, shared with the actual sequential validator; the matcher continues enforcing *missing/null or exactly `fulltime` only*. A shape-compatible `result` definition **is not marked eligible** by this diagnostic. Later duplicate-ID quarantine still removes ambiguous IDs from the actual mapping. The eight-family summary counts are **pre-quarantine** and must not be mistaken for final eligible IDs.

The manual runner exposes `catalogueFamilies` only for **`CATALOGUE_VALIDATE / NO_ELIGIBLE_CATALOGUE_MARKETS`**, after validating all 88 fixed integer fields (8 families × 11 counts, each 0..250000). A malformed entry suppresses the whole new family summary without affecting the previously validated 11-stage funnel or six period bins.

The runner also checks invariants: every family's period bins sum to `definitions`; independent line and pair counts cannot exceed family definitions; the intersection cannot exceed either constituent; `resultLineAndPairIndependent` cannot exceed either `exactResult` or the intersection; totals over all families equal the preexisting `familyExact` count and six `cataloguePeriod` buckets. Unknown extra keys or raw provider strings cannot enter the output.

The existing authenticated manual callable's safe logger adds this **sanitized**, fixed-schema summary conditionally. No other failure type emits it; no raw market names, IDs, odds, player names, query strings, API keys, owner identifiers or exception objects are recorded in safe diagnostics.

## Boundaries and validation

- No new eligible market family, period, handicap, outcome or sportsbook mapping.
- No change to owner authentication, Firestore security rules, research records, ESPN identity checks, capture/settlement logic, 250,000 global definition/50,000 NBA subset limits, 32 MiB catalogue / 12 MiB odds download caps, caching, six UTC-day reservations, paid-request budget, timeouts, request endpoints, UI, polling, scheduling or retries.
- Tests use synthetic examples for all eight families, independent later checks despite invalid periods, unknown provider strings, missing periods, frozen values, late cross-sport duplicate IDs, malformed/partial/injected counters and one catalogue failure with **zero** odds fetches. Run Node.js 22 syntax and the full offline backend regression suite.
- **Offline-only draft PR.** No merge or production Firebase deployment without new, separate owner authorization. Held PRs #16/#17 remain unmerged. Any later deployment must target only `functions:oddsPapiNbaMarketAudit` because `oddsPapiAccountPreflight` is deployed but its source remains in held PR #17. Any later metered audit separately requires explicit approval, a fresh read-only Firestore UTC budget check, and unmetered monthly account preflight.

These diagnostics establish catalogue shape compatibility, **not live Betano.pt market availability**, independent bookmaker-price validation, or a betting edge.
