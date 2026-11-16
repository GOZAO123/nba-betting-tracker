# Update 35.3A — Pre-game minutes/role shift research

Status: **Draft PR, not approved for merge or deployment**.

## Scope
The app already has an unvalidated 12-game prospective heuristic and a separate experimental minutes-aware backtest challenger. This update adds an **offline, historical** way to investigate when the challenger helps or hurts instead of promoting it based on overall historical error alone.

- Only the **12 games before each held-out game** contribute to its minutes signal: mean minutes in the newest four versus all twelve. A fixed 15% threshold classifies an upward or downward change; otherwise stable. Missing/invalid minutes fail closed.
- The existing minutes-aware candidate **retains the exact same probability formula** and synthetic reference line. Production model, ledger snapshots, ESPN identity checking, and settlement remain unchanged.
- A collapsed **Minutes / role-shift research** report appears after an existing manually launched single-player or six-player cohort backtest, using the **already fetched** ESPN history. Its per-market table reports up/down minutes trends, candidate missing-minute coverage, and **paired** current-versus-challenger Brier score only on the exact same held-out games with changed minutes.
- Fewer than 30 paired shifted rows are labeled **Sparse (<30)**. Even larger groups are descriptive only and can contain correlated outcomes.
- Strictly chronological test inputs exclude invalid dates and skip a game with the same timestamp as its predecessor. A target game's actual minutes and score never influence its own forecast.
- No additional API requests, no new Firebase operations, no bookmaker calls, no new buttons, no automatic polling, no authorization changes and no effect on frozen research records.

## Limitations
Historical lines used for these tests are **synthetic** reference thresholds, not independently verified Betano observations. These diagnostics do not establish calibrated accuracy, EV, audited ROI or betting profitability. Up/down is a trend known before tipoff, **not** a reliable prediction of future minutes. Model selection must later be validated on untouched chronological data and independent bookmaker evidence, with sample size and selection bias disclosed.

## Verification
Deterministic synthetic tests cover exact prior-game windows, valid/invalid minutes, unchanged challenger probability formula, withheld target-game data, missing candidate coverage, paired Brier scores, insufficient samples, same-timestamp rejection and no network/writes in the render path. Existing GitHub frontend CI checks all inline scripts and research regression tests.

## Approval gates
Review draft PR and CI. Do not merge without separate owner permission. After any later approved merge, owner tests on Android and desktop. Tonight's separate 35.1C15 Firebase release remains independent.
