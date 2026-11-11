# Codex and contributor guidance — NBA Betting Tracker

This repository is an **existing, working application**, not a greenfield project. Make incremental, testable changes. Never restart, rewrite, or reorganize it without a demonstrated need and approval.

## Before changing anything

1. Inspect the latest `main` branch, relevant source files, recent commits, and [development issue #1](https://github.com/GOZAO123/nba-betting-tracker/issues/1). That issue records verified milestones and outstanding tests; some older checklist entries are superseded by later updates.
2. Identify one narrowly scoped feature or bug and explain its impact and risks.
3. Prefer a feature branch and a reviewable pull request for implementation work. Do not merge significant changes into `main` without review.
4. Review the diff, run relevant tests, and report exact checks and limitations. Never claim a test passed if it was not run.
5. Update issue #1 with meaningful milestones and remaining problems. Wait for the owner's live-device test results before the next substantial feature.

## Architecture and invariants

- Frontend: `index.html` (HTML/CSS/JavaScript), GitHub Pages, Firebase Authentication (Google sign-in), Firestore checklist sync, ESPN schedules/rosters/game logs/box scores.
- Backend: `functions/index.js`, Firebase Cloud Functions **Node.js 22**, region `europe-west1`, Firebase Admin SDK, manually triggered OddsPapi diagnostics.
- Firebase project: `nba-betting-tracker-3979d`. This identifier is **not permission** to access or deploy production.
- Preserve desktop and Android behavior, existing viewport/zoom rules, Google sign-in, cloud synchronization, ESPN identity checks, and functional paths unrelated to the task.
- Display dates and times in **Europe/Lisbon**, 24-hour **HH:mm**. The NBA checklist day rolls over at **06:00 Lisbon time**, not midnight.
- Avoid unnecessary ESPN/Firestore requests; cache and bound operations appropriately.

## Security and API cost controls

- **Never** expose, log, commit, or ask for Firebase credentials, private keys, API secrets, or the owner's UID.
- **Never** perform production Firebase deployments, destructive changes, or live Firestore writes without the owner's explicit approval. Use mocks, synthetic fixtures, emulator tests, and read-only inspection for development.
- Firestore browser rules allow owner access to `users/{uid}/data/checklist` and **read-only** access to `users/{uid}/propResearchLedger/{recordId}`. Preserve the denial of browser ledger creates, updates, and deletes. Do not add a broad overlapping Firestore allow rule.
- The trusted backend callables `ledgerCaptureProspective` and `ledgerSettleProspective` are the only supported research capture/settlement paths. Preserve server timestamps, pre-tip-off guards, owner authentication/authorization, exact ESPN event/team/athlete checks, transactions, and frozen original fields.
- Never introduce automatic OddsPapi polling. The server-enforced **six upstream OddsPapi requests per UTC day** diagnostic budget must remain intact. Do not initiate paid upstream requests or schedule bookmaker data collection without explicit authorization.
- Do not treat Codex GitHub access as access to the user's Windows computer, Firebase console, production credentials, or actual bookmaker account.

## Research and statistical integrity

- Supported markets: `PTS`, `REB`, `AST`, `3PT`, `PR`, `PA`, `RA`, `PRA`.
- Prospective offers are manually observed Betano quotes; they are **not independently bookmaker-verified**. Frozen model estimates are experimental and **not calibrated against verified historical Betano odds**.
- Never fabricate odds, sportsbook availability, player statistics, NBA outcomes, model accuracy, proven betting edges, expected value, or ROI.
- Keep original odds, market/line/side, player identity, frozen estimate, capture receipt and settlement provenance intact. Report legacy vs trusted-backend records separately when relevant.
- Settlement must safely handle DNP, missing or contradictory ESPN stats, postponed/rescheduled games, missing minutes, non-Final status, and ID mismatches. Fail closed rather than turning missing information into a loss.
- Model validation must be chronological and out of sample; display sample sizes, selection bias, correlation across markets, uncertainty and calibration limitations. Brier score alone is not audited profitability.

## Validation before proposing integration

- For backend edits: run `npm run lint --prefix functions` (currently `node --check index.js`), and targeted deterministic tests for parsing, identity validation, authorization, idempotency, and transaction invariants.
- For frontend edits: syntax-check **all inline JavaScript scripts** (including module scripts), check startup initialization order, DOM selectors, sign-in and checklist paths, and review mobile/desktop layout behavior. A previous initialization-order regression caused a blank application screen.
- Never use real OddsPapi requests, production writes, or a Firebase deployment as an automated test.
- Clearly distinguish tests actually executed from steps still requiring a browser, Firebase emulator, or owner-run live verification.
- Use minimal, security-preserving diffs. Do not change unrelated code or regenerate large files merely for formatting.

## Development state and next steps

As of **11 November 2026**, the user verified two saved prospective records visibly `SETTLED` in the app: Jalen Brunson (PTS Over 26.5, ESPN final 23, loss) and Ajay Mitchell (PTS Over 20.5, ESPN final 14, loss). The UI displayed two completed comparisons with an exploratory Brier score of 0.1976. These are **two observations only**, not evidence of forecasting quality. See issue #1 for subsequent changes.

Planned incremental milestones (verify against issue #1 before implementation):
1. **34.6:** secure, bounded, low-cost ESPN-only automatic settlement of pending records; idempotent, failure-safe, and no OddsPapi calls.
2. **34.7:** research dashboard with honest sample-size/calibration diagnostics.
3. **35.0:** scalable prospective research collection only after provider cost, authorization, and provenance controls are agreed.

When working with Codex, supply acceptance criteria, test requirements, and a summary of files changed, risks, and manual test instructions. Production deployment is always a separate, explicit owner-approved action.
