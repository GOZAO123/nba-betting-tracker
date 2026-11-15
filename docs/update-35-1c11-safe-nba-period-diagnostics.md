# Update 35.1C11 — Safe NBA period diagnostics (offline-only draft)

## Verified basis — 15 November 2026

The single explicitly approved live 35.1C10 audit returned `CATALOGUE_VALIDATE / NO_ELIGIBLE_CATALOGUE_MARKETS` against a global catalogue containing 70,742 definitions. The bounded eligibility funnel found 8,883 sport 11 definitions, 440 true player props, 248 supported exact NBA market-family names, and **0 passing the period gate**. The owner verified the 15 November UTC Firestore guard had `reserved=2` of `limit=6` and the unmetered provider account check went from 20/250 to **21/250 used** after that single audit. The stored reservation count is deliberately conservative; it is not a monthly request count.

The preexisting validator accepts missing/null `period` or exactly `"fulltime"`. Public provider documentation for NBA states that `"result"` settles the whole game including overtime, `"fulltime"` is regulation-only, and named quarter/half periods settle partial games:

- https://oddspapi.io/blog/nba-second-half-odds-api/
- https://oddspapi.io/us/docs/get-markets

The public documentation does **not** prove what the 248 live eligible-family definitions contained; these remain unknown until a separately authorized live diagnostic.

## Change scope

The pure offline catalogue analyzer now counts one of six fixed period categories for each first-seen ID that passes all three preceding filters: sport 11, `playerProp===true`, and one of the eight exact supported NBA market-family names. This is **before** period acceptance and before late duplicate-ID quarantine:

| Fixed diagnostic key | Meaning |
| --- | --- |
| `missingOrNull` | Absent/null period; currently accepted |
| `exactFulltime` | Exact string `fulltime`; currently accepted |
| `exactResult` | Exact string `result`; **not accepted** |
| `knownPartial` | Exact documented basketball first-half, second-half, and quarter clocks; **not accepted** |
| `otherString` | Any other string, without recording its value |
| `nonString` | Any other non-null value type |

The six counts are a partition of the existing `catalogueEligibility.familyExact` stage, and `missingOrNull + exactFulltime === catalogueEligibility.periodAllowed`. The parser freezes the fixed numeric summary and never collects raw period strings in its result.

The manual runner accepts the new `cataloguePeriod` object **only** when reporting the existing `CATALOGUE_VALIDATE / NO_ELIGIBLE_CATALOGUE_MARKETS` failure. It sanitizes against a fixed six-field allowlist, independently checks every field is an integer from 0 through 250000, and verifies both invariants against the existing sanitized eleven-stage eligibility funnel. If validation fails, only the new period detail is suppressed; the existing safe funnel remains. All other safe stage/reason codes retain previous behavior. The production callable's logger is updated to emit the sanitized field conditionally.

**The actual eligibility rule stays byte-for-byte unchanged.** No new accepted period values, paid requests, automatic retries, polling, research writes, odd or player records, wider market matching or changes to caches, size limits, quotas, owner authentication, deployment configuration, UI, ESPN or capture/settlement.

## Offline acceptance tests

- Synthetic absent/null, exact `fulltime`, `result`, documented partial, unknown string and non-string period examples classify into fixed bins.
- `result` remains rejected and the manual runner stops before any second upstream odds fetch.
- Buckets are frozen, partitioned, allowlisted and bounded; injected secret keys and strings never enter logs; malformed count sums or type/range mismatches suppress only the new section.
- Existing protected global cross-sport duplicate quarantine, 250k global catalogue ceiling, 50k NBA eligible subset ceiling, authentication, two-slot reservation, zero automatic retries, existing caches and safe log schema continue to pass all Node 22 tests.

## Operational gates

**This is a GitHub draft-only offline change.** Do not merge into `main` or deploy any Firebase Functions without distinct explicit owner approval; PRs #16 and #17 remain held. No live OddsPapi request is authorized for this work. A later live diagnosis requires new approval after fresh read-only UTC-day Firestore budget and unmetered account checks. Any eventual deployment must target `functions:oddsPapiNbaMarketAudit` **only**, because the separately deployed `oddsPapiAccountPreflight` is absent from `main` while held PR #17 remains unmerged.

The goal is to establish the provider's actual period categories before any separately reviewed change to strict market eligibility or any claim about Betano Portugal offers.
