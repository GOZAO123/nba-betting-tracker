# Update 35.1D15.38 — Player collection source-only release hold

**Status: draft, disconnected and permanently BLOCKED.** This update does **not** certify a real OddsPapi player ID, Betano bookmaker odds, an ESPN athlete ID, or live deployed Cloud Function source. It performs no Firebase, provider or billing operation. No production deployment, GitHub merge, source archive inspection, privileged IAM call or paid diagnostic is approved here.

## Current state verified before implementation

- 20 November 2026 main: 42055bece8fa104f270af3ec8a478afaffe0cf31, PR #85 merged. D15.37 added an offline private quote/fixture consistency join; D15.36 added an offline, default-denying reviewed player-ID mapping gate. Neither is production-wired or contains real approved player mappings.
- Existing D15.33 source-only quote preflight and D15.11 paid caller source-inventory checks already distinguish local source compatibility from authentic production attestations. D15.38 reuses them and adds guards for the newer player review and receipt-link modules.
- Draft PR #73 remains an older, stacked, unmerged metadata-review proposal. This PR does not merge, modify, depend on, or duplicate that stack. Its sample owner-supplied data must never be confused with independently authenticated live Functions/IAM evidence.
- Existing production has 15 deployed functions according to prior owner inventory; current repository source exports 14 and the separately deployed account preflight does not have equivalent source in main. All target-only release protections remain necessary. No blanket Functions deployment.

## Scope of this PR

Four added files only:

1. functions/offline-player-collection-source-preflight.js — pure Node 22 source-only checker taking 12 required checked-out repository text strings. Exact allowlist, byte bounds and exception sanitization; no client JSON, environment variables or credentials accepted as evidence.
2. functions/offline-player-collection-source-preflight.test.js — synthetic source-mutation regressions for forbidden production imports, six-per-UTC-day quota and manual diagnostics, empty approved player manifest, no quote/identity capture promotions, immutable authorized selectors and fixed private receipt paths, default-off quote pipeline, create-only storage and browser write-denial.
3. .github/workflows/offline-player-collection-source-preflight.yml — scoped Node 22 no-install CI, no live APIs.
4. This runbook.

The checker reuses the existing D15.33 quote collection preflight and D15.11 source-side paid-caller inventory, then adds guards for D15.36/D15.37. A clean sourceGuardFindings array means only that this limited textual scan found no named regressions. Regular expressions are defense-in-depth, not proof of runtime behavior, binary equivalence or independently authenticated cloud configuration. The response ALWAYS has status BLOCKED, releaseReady false, paidProviderAllowed false, cloudChangesAuthorized false.

External blockers remain present regardless of source text: exact deployed source/container equivalence, effective IAM permissions and impersonation, separate preflight source, provider plan and billing costs, genuine protected original player-ID quote receipt, independently reviewed ESPN identity, primary-line/Betano price verification, target-only rollback rehearsal and separate owner approvals.

## How to validate offline

Run these from repository root, using Node 22:

    node --check functions/offline-player-collection-source-preflight.js
    node --check functions/offline-player-collection-source-preflight.test.js
    node --test functions/offline-player-collection-source-preflight.test.js functions/offline-quote-collection-preflight.test.js functions/offline-player-receipt-link.test.js functions/offer-player-crosswalk.test.js
    npm run lint --prefix functions
    npm test --prefix functions

Do NOT substitute a live OddsPapi or Firestore call as a test. The Node test fixtures are synthetic; existing CI will run backend regression tests as well. Review CI on the exact PR head before any merge decision.

## Future controlled, separately approved verification

Real source/IAM/cost attestations must be made in a distinct, owner-controlled, sanitized read-only audit, ideally with pinned function/service revisions and independently verified source fingerprints. Do not copy raw IAM principals, source archive URLs, environment values, credentials or secret versions into GitHub comments or chat. Provider account costs and request quotas require explicit evidence and owner permission. Only after those checks, and an expressly approved, safe, target-only rollout/rollback, could a limited manual capture be considered. No new API request is authorized by development of this preflight.

**Current release state: BLOCKED.**
