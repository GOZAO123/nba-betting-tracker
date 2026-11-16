# Update 35.3C — Team-balanced historical research gate

**Status: draft PR. No merge, Firebase deployment or provider calls approved.**

## Motivation
The existing six-player cohort contains three New York Knicks and three Denver Nuggets. Its pooled Brier score is appearance-weighted and therefore gives more influence to athletes who have more usable games. Even the promising historical assists result does not prove that the experimental model works across other NBA teams, future seasons or real Betano prices.

## Narrow read-only change
- Reuse the predictions from the **existing, manually triggered** six-to-twelve-player ESPN cohort. No extra requests, buttons, account permissions, backend services or saved records.
- For each of the eight markets, score the current baseline and existing minutes-aware candidate on **identical held-out game outcomes**. First average squared error per ESPN athlete, next average those means equally within each team, then average each team equally. Display **candidate minus current Brier** (negative = lower historical error).
- Require all requested athletes with unique exact ESPN IDs and team matches, at least 12 paired forecasts per athlete, at least max(120, requested × 12) total, and zero missing candidate estimates, invalid values or duplicated athlete/timestamp outcomes before showing numeric comparisons.
- Label the standard two-team cohort **Need ≥3 teams**, rather than mistaking a high observation count for population-level representativeness. With at least three teams but fewer than two sampled athletes in any team, label **Need ≥2 players/team**. Even complete broad groups are **Descriptive only**, not approved for model promotion.
- Show a collapsed, mobile-scrollable **AI research · Team-balanced evidence** panel in the existing cohort result. Grouping does not make the selected teams random or observations independent.
- Preserve the production 12-game model, candidate coefficients, all exact athlete identity checks, user authentication, Firestore records, secure settlement, OddsPapi limits, ESPN request caps and manual triggering.

## Limits
This is concentration/sensitivity analysis of selected, correlated games using **synthetic** historical reference lines. It is not a true independent holdout, validated Betano bookmaker price sample, calibrated forecasting result, expected-value estimate or audited ROI. Future improvement must add predeclared broader sampling and untouched prospective outcomes before any model switch.

## Validation and gate
Six deterministic synthetic tests verify (1) equal-team averaging reverses a misleading appearance-pooled result, (2) two-team-only limitation, (3) missing estimates and sparse athletes, (4) duplicate/identity/invalid data protection, (5) minimum two athletes per team and (6) no network/write calls from renderer. Existing Node 22 frontend CI must pass all inline JavaScript and regression tests.

Owner must separately approve the draft PR merge. After an approved merge, run the existing cohort backtest on Android/desktop, expand the new panel and verify coverage warning and calculations. Tonight's targeted 35.1C15 Firebase deployment is a separate, explicitly approved activity.
