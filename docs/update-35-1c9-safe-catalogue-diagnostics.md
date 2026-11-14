# Update 35.1C9 — Safe, aggregate-only NBA catalogue eligibility funnel

## Source evidence and scope

On 14 November 2026 an explicitly approved manual audit of the targeted 35.1C7 backend returned Cloud Run's fixed diagnostic **`CATALOGUE_VALIDATE / NO_ELIGIBLE_CATALOGUE_MARKETS`** at **12:07:02.608Z**. This confirms the bounded global catalogue passed structural/count validation but produced zero **strictly eligible** NBA markets in the existing mapping. It **does not** establish that the provider has no NBA player props, no available Betano Portugal markets, or that bookmaker lines or prices are verified.

The user then verified Firestore's 14 November UTC guard: `utcDay=2026-11-14`, `limit=6`, `reserved=6`, `lastReservedAt=2026-11-14T12:07:01.245Z`. There is **zero remaining server-enforced diagnostic budget** for that UTC day. The most recent separately verified, unmetered provider account check *before* that final test showed monthly used 19/250 and remaining 231. **Actual monthly usage after that final test has not yet been rechecked.**

## Design

Implement only a **sequential eligibility funnel**, with these predefined integer counters:

1. `totalDefinitions` — bounded provider catalogue array length (up to 250,000).
2. `validIds` — rows with valid numeric market IDs, including duplicate rows.
3. `firstSeenIds` — valid market IDs on first appearance only.
4. `sport11` — first-seen IDs with exactly the existing NBA basketball sport ID.
5. `propTrue` — those also carrying the existing strict boolean player-prop marker.
6. `familyExact` — those matching one of the existing eight **exact** English market-family names.
7. `periodAllowed` — those with an accepted optional full-time period.
8. `halfPointLine` — those with an accepted positive half-point handicap.
9. `overUnderPair` — those with exactly two distinct valid Over/Under outcome IDs.
10. `eligibleIds` — final eligible IDs **after all duplicate-ID quarantine**.
11. `duplicateIds` — distinct globally repeated market IDs, irrespective of sport.

Stages `firstSeenIds` through `overUnderPair` are **sequential and pre-quarantine**, so a late cross-sport duplicate can make `eligibleIds` lower than `overUnderPair`. This distinction is documented and regression-tested.

The offline pure helper emits counters as a frozen numeric object in the aggregate-only report. The manual runner logs these counters **only when** the failure is exactly `CATALOGUE_VALIDATE / NO_ELIGIBLE_CATALOGUE_MARKETS`, and only after validating every fixed-schema field is a safe integer in [0, 250000]. Any partial or malformed counter object is omitted. The production function's existing safe logger receives this strictly sanitized object, never any provider records or error objects.

**No changes** to strict matching, eligibility, outcomes, bookmaker identity, line checks, ID quarantine, request limits, server-side diagnostic quota reservations, 12h/15min caches, 32 MiB / 12 MiB response ceilings, automatic polling, Firestore writes, ESPN identity checks, authentication or secret handling.

## Acceptance criteria (offline only)

- Synthetic catalogues with an intentionally failed row at each gate produce the expected exact funnel counts, including late cross-sport duplicate quarantining.
- The no-eligible runner rejects before the second provider request and emits only fixed-code stage/reason and sanitized aggregate counters.
- Malformed / oversized / adversarial diagnostic objects never leak raw fields; other error stages retain the historical two-field safe category.
- No raw market names/IDs, bookmaker prices, athlete names, credentials, URLs, raw provider payloads or other private context appear in the safe log object.
- Existing 35.1C7 catalogue scan bounds, eight market families, record integrity and security tests stay green in the full Node 22 backend regression suite.
- Test and document through GitHub draft PR and CI; do not claim success before results are confirmed.

## Operational release gates

This PR is **OFFLINE DRAFT ONLY**. The user's current authorization allows no metered OddsPapi request, production Firebase deployment, merge into `main`, destructive changes or broader Firebase deployment.

Before **any subsequent live test**, a new separate owner approval is mandatory; independently check the UTC daily budget, then unmetered account quota. On 14 November the daily budget is **6/6**, so there must be no more attempts that UTC day. A later production deployment, if explicitly approved, must target **only** `functions:oddsPapiNbaMarketAudit` because the separately deployed `oddsPapiAccountPreflight` is still sourced from held PR #17. PRs #16/#17 remain held.
