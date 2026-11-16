# Update 35.1C15 — NBA result-period eligibility (offline proposal)

## Evidence and decision
The owner-approved manual audit of 2026-11-16 00:10 UTC found 248 matching catalogue definitions across the eight NBA player-prop families, all with exact `period: "result"` and independently valid half-point lines and Over/Under pairs. This is a **global market catalogue**, not proof of active Betano Portugal offers. The provider's NBA period guide describes `result` as full game **including overtime** and `fulltime` as regulation only: https://oddspapi.io/blog/nba-second-half-odds-api/

## Scope
- Require **exact** `period === "result"` when mapping NBA player-prop catalogue entries. Reject missing/null, `fulltime`, partial-game, unknown and non-string values.
- Keep exact eight overtime-suffixed market names, sport 11, `playerProp === true`, valid half-point handicap, exact Over/Under outcome IDs and duplicate-ID quarantine.
- Align sanitized period diagnostic invariant: `catalogueEligibility.periodAllowed === cataloguePeriod.exactResult`; preserve fixed family matrix and no raw provider data.
- Offline regression cases cover all eight families, period negatives, diagnostics, security/authorization, request reservation and failure/no-second-request paths. Verify that existing ESPN Final extraction uses the complete final player box score (including a synthetic overtime final) across eight markets.
- Do **not** change production `functions/index.js`, callable routes, Firebase authorization, backend research writes, auto-settlement, Firestore rules, quota reservations or scheduler.

## Safety boundaries
Preserve the existing 32 MiB catalogue and 12 MiB league-odds read caps; 250,000 global/50,000 eligible-NBA catalogue count caps; market/fixture/player processing limits; 512 MiB callable memory; owner-only authentication; server-enforced six diagnostic slots per UTC day; 12-hour catalogue and 15-minute snapshot cache; no polling or automatic retry. Offline tests use injected synthetic data and **zero** OddsPapi requests.

## Deployment and open questions
This is code-only, draft-PR review. No merge, Firebase deploy, live audit or paid provider call is approved by this PR. Previously deployed preflight is sourced from held PR #17: **never deploy all functions from `main`**. Separately authorize any targeted deployment; after a future fresh budget/quota check and separate explicit owner consent for a metered request, confirm whether any of these globally defined markets have **active** `betano.pt` offers. Validate ESPN overtime coverage against independently verified real game records in future research-quality work. No claim of calibrated probability, betting edge or ROI.
