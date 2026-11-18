# Update 35.1D15 — Manual one-call identity-schema diagnostic (HARD-DISABLED)

**Scope:** One narrowly scoped backend diagnostic route, prepared for a separately approved manual provider observation. It is NOT enabled, deployed, merged, scheduled, or authorized for a paid API invocation by creating this PR.

## Why D15 exists

The existing market audit validates the entire `/v4/markets` catalogue before fetching `/v4/odds-by-tournaments`. Previous genuine manual diagnostics ended in `CATALOGUE_VALIDATE / NO_ELIGIBLE_CATALOGUE_MARKETS`. The D11 enabled-integration prototype reused that sequence, so it could consume reserved provider slots while **never reaching the fixture identity fields** needed to validate the D5 extractor. More offline-only market catalogue heuristics do not resolve this blocker.

OddsPapi's [public GET `odds-by-tournaments` documentation](https://oddspapi.io/en/docs/get-odds-by-tournaments) describes `fixtureId`, `participant1Id`, `participant2Id`, `sportId`, `tournamentId`, `statusId`, `hasOdds`, `startTime` and `bookmakerOdds`. Documentation examples are NOT independently observed NBA / Betano responses. Actual endpoint envelopes and account/bookmaker coverage still need one explicitly authorized observation. The single-fixture object displayed in the public example must not be assumed to be the shape of the full league response.

## Implemented, still disabled

- `manual-identity-shape-probe.js` is a pure, backend-injected manual diagnostic runner. An authenticated, email-verified exact owner and an empty callable payload are required **before** any reservation or provider HTTP. No new callable, button, scheduler, client switch, or environment activation is introduced.
- Uses the **existing** D11/D9 fixed-host, redirect-denied, response-size-limited `fetchOdds` transport, but **does not request the global market catalogue**. It performs **exactly one** `reserveDiagnosticRequests(1)` using the existing server-enforced six reservations per UTC day, then at most **one** `/v4/odds-by-tournaments` HTTP request. The inner diagnostic transport reads the key after reservation; the existing outer callable independently checks secret availability after authorization and before invoking the runner. That precheck does not make an upstream provider request. An error is not retried or refunded.
- Analyses the in-memory response with existing D13 `inspectOfflineProviderIdentityShape` and D5 extraction checks. Rejection reasons and counts only; max 250 fixtures and 64 accepted; invalid/ambiguous shapes fail closed. It never returns raw fixtures, player/team/participant IDs, prices, odds, names, secret keys or source URLs.
- Response is explicitly `PROVIDER_IDENTITY_SHAPE_ONLY`; `teamMappingApproved:false`, `bookmakerOddsVerified:false`, `researchSaved:false`. It does not read/write Firestore, authorize mappings, choose main lines, record observations or rate bets. A 15-minute in-process cache and concurrent-call deduplication avoid repeated reservations for an immediate manual repeat.
- D11 integrates `identityOnly:true` as a **trusted backend-only** selection. D14's existing dispatch passes this selection for a potential **future** enabled route, but `NBA_PROVIDER_EVIDENCE_ENABLED = false` remains a **literal backend false**. As a result the deployed/default path still uses the **exact legacy audit function reference** without loading D11 or the diagnostic. Existing D11 two-request evidence-storage test mode is preserved when `identityOnly` is absent.
- No SDK, Firestore rules, frontend, quotas, IAM roles, functions inventory, or other source behavior is intentionally changed. Unit tests use only synthetic HTTP and Firestore spies.

## Future approval checkpoints — not actions for this PR

1. Re-review exact reviewed source and GitHub CI; separately approve merging D15 if desired. A GitHub PR merge is NOT a Firebase deployment.
2. If contemplating a live trial, first check current billing/account quota, production Function inventory (14 including separately deployed account preflight), existing server UTC-day reserved slots, and the preserved revision rollback plan. **Never deploy all Functions.**
3. Obtain a **separate explicit owner approval** for the exact named Function deployment **and** another specific approval for any manual metered OddsPapi invocation (one possible upstream request), plus any live Firestore write. Do not imply the free trial or €0 billed amount means future API requests are free.
4. The identity-only probe does not require the previously ineligible market catalogue. However, any actual response that is incompatible with D13/D5 remains a BLOCKED diagnostic: **do not retry paid requests blindly**. Existing evidence-storage and manual team-review contracts require further independently reviewed implementation and authorization.
5. Independently corroborate future real provider participants with ESPN scoreboard/events/rosters, require explicit two-way human approval/revocation, and do not present selection recommendations or profitability claims from these diagnostics.

## Acceptance checks

- Node.js 22 backend syntax/lint; all existing tests plus D15 new offline tests.
- Hard-disabled dispatch still returns the identical legacy runner; no added scheduled work or automatic OddsPapi polling.
- In mock enabled `identityOnly` mode: correct owner-only check, exactly one reservation **before** secret read, one fixed-host league request, zero market catalogue requests, zero Firebase reads/writes.
- Cached/concurrent calls do not consume additional quota; budget denial prevents provider access; errors are sanitized; unsupported/malformed source envelopes fail closed.
- Offline D12 preflight remains `BLOCKED`, and D3 reviewed mapping manifest remains empty.
