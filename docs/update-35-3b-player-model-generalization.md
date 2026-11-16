# Update 35.3B — Player-level robustness diagnostics

**Status: draft PR, unmerged.** No production Firebase deployment or paid provider calls.

The existing manually triggered 6–12 player cohort tests two frozen historical models against synthetic reference lines. Pooled Brier scores can hide a single athlete dominating apparent improvement. This update reuses exactly those completed ESPN histories, with no new requests, no extra buttons, and no changes to production research estimates.

A new collapsed report shows paired current-versus-minutes-aware error by exact ESPN athlete ID and team, alongside supported player count, missing candidate coverage and leave-one-player-out sensitivity. Complete comparisons require all requested players, two teams, ≥12 paired forecasts/player, ≥120 paired total, no missing challenger probabilities and no malformed or duplicate player/timestamp entries. A model that looks better in aggregate but loses its advantage after removing one player is explicitly **not consistent**.

Existing cross-season comparisons are now blocked unless both manually triggered completed-season analyses contain exactly the same unique numeric ESPN athlete IDs. This does not make them an untouched prospective validation.

Offline synthetic tests cover fragile pooled improvement, missing challenger forecasts, duplicate/incorrect identities, cross-season ID matching and no requests/writes in the diagnostic. Existing frontend CI checks all inline JavaScript and regressions.

**Limitations:** Reference lines are synthetic, not independently verified historical Betano offers. Game and market outcomes are correlated. This is exploratory model robustness, not demonstrated future accuracy, calibration, positive EV or audited ROI. No candidate is automatically promoted. Merge requires separate owner approval; Android/desktop testing follows. Tonight's 35.1C15 targeted Firebase audit deployment remains separate.
