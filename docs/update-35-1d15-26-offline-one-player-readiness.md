# Update 35.1D15.26 — Disconnected one-player evidence rehearsal

**Status: OFFLINE TEST HARNESS ONLY. Not a production feature, source-mapping approval, or release authorization.**

This change adds a single Node.js 22 test file and a narrowly scoped GitHub Actions job. It composes **existing** audited offline modules: the backend-owned reviewed team-crosswalk resolver, ESPN scoreboard/roster inspection adapter, strict player-offer matcher and provider fixture provenance extractor. Every league fixture, player, team, scorecard and quote in the test is **synthetic**, never a bookmaker observation.

## Acceptance / verification

- One scheduled NBA fixture (sport 11, tournament 132), one provider player, one PTS 18.5 result-period market, and two explicit Over/Under outcomes under the provider source key `betano.pt`.
- Synthetic approved reviewed mapping of both provider participant IDs to the pinned ESPN event and its two ESPN teams. ESPN path reading is injected, strictly bounded to one scoreboard plus two rosters and never accesses an external network.
- The nominal valid synthetic pair returns `REVIEW_CANDIDATES_ONLY`, `EXACT_NAME_ONLY_NOT_VERIFIED` and `NO_EXPLICIT_MAIN_LINE`; it **never** turns name equality into independently verified player identity, a bookmaker-confirmed quote or permission to capture.
- Empty/revoked/duplicate reviewed mappings, browser-supplied identity proofs, duplicate ESPN events, ambiguous player names, missing Over/Under, wrong/suspended bookmaker, stale quote timestamps, mismatched Over/Under player names and duplicated lines are rejected or explicitly flagged.
- Both explicit main-line flags yield `EXPLICIT_MAIN_LINE_REVIEW_REQUIRED`, **not** automatic main-line selection.
- Existing fixture-only provenance extractor retains the original synthetic capture timestamp, source reference and fixture start with no player odds or prices; it is not a player-offer ledger and does not freeze bookmaker observations. This remaining functionality must be designed and independently verified before a real capture path is enabled.
- Zero actual provider requests, Firebase operations, research writes, quota reservations, live ESPN requests or secret reads. No new `index.js` export and no client changes.

## Reproduce

From an existing checkout at the proposed PR commit:

```sh
node --check functions/one-player-readiness.test.js
node --test functions/one-player-readiness.test.js
npm run lint --prefix functions
npm test --prefix functions
```

The existing backend CI continues to run its former suite; the new scoped job executes the new test file explicitly without modifying `package.json` or requiring network access inside the test itself. GitHub checkout and Node setup are ordinary GitHub Actions infrastructure, not OddsPapi calls.

## Production hold / remaining blockers

The real provider schema, independent ESPN player-ID bridge, reviewed real fixture/team mappings, complete original bookmaker quote retention and frozen line/price evidence remain **unverified**. Neither the historical pinned Update 33.3 ZIP nor today's `main` constitutes a tested single-target rollback. All 15 deployed Functions must remain intact, including the separately deployed preflight function absent from GitHub `main` exports. No blanket Functions deployment, provider polling, provider call, secret access, IAM changes, merges or runtime releases are authorized by this PR.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
