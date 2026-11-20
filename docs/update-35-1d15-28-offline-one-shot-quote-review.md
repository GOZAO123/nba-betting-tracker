# Update 35.1D15.28 — Offline one-shot quote-source review

**Status: DRAFT / OFFLINE. Not an authenticated live OddsPapi receipt, producer-side attestation, Firestore persistence, rollout, or permission to collect paid API odds.**

## Narrow addition

This update introduces `makeOfflineOneShotQuoteReview` as a tiny disconnected adapter around the pre-existing pure `freezeUnreviewedProviderPlayerPair` (merged D15.27). The adapter has no Firebase, network or browser integration. The backend must inject a `takeBackendOwnedSource` function; only that callback can provide the original full `catalogue`, original `leagueOdds`, source `snapshotReference`, backend `capturedAt`, and numeric `fetchedAt` time. A hypothetical signed-in owner passes exactly three string/numeric selectors: provider fixture ID, market ID and provider player ID. **The browser cannot supply any provider response, price, source reference, ESPN proof or claim of verified identity to this adapter.**

The adapter checks owner UID and verified email before calling the injected source callback. It strictly checks selector shape, uses a two-minute window from `fetchedAt` to review, prevents concurrent claims with a one-use flag set before the first await, and permanently consumes the in-memory session even on errors. It composes the existing strict quote snapshot helper, which returns only immutable `UNREVIEWED_PROVIDER_QUOTE` values with false bookmaker/player-verification, auto-selection and capture flags. Failures return `null` with no raw provider data, secret values or exception messages. A permitted source callback is **not invoked automatically** and is not wired to production.

## Critical non-goals and residual risks

- **This is not yet integrated with D8's real manual source receipt.** The existing `manual-evidence-receipt.js` verifies the provider fixture evidence once, but does not expose trusted raw quote data or prove an actual player quote source to D15.28. An actual production integration must bind to the exact authorized backend transport and not allow a caller to fabricate a source or an approval.
- A backend-injected callback is trusted by construction of this *test harness*; the adapter cannot prove the callback performed an actual OddsPapi request or respected the six-reservation guard. A plausible receipt string alone is never authenticated.
- The one-shot consumed flag is **per factory instance**. Separate sessions can reuse a source if the future backend allows it. Durable anti-replay, trusted receipt/captured-at cryptographic binding, immutable create-only quote storage and settlement integration remain unimplemented.
- Original provider quotes are **not direct Betano bookmaker observations**, independent ESPN player IDs are not verified, provider main-line flags remain descriptive only, and no automatic pick or expected value claim is made.
- No existing Firestore ledger, fixture evidence store, Firebase function, IAM binding, scheduling, service-account role, quota, production secret, frontend, or rules are changed. The unmerged PR #73 stack is unaffected, and no automatic OddsPapi polling is introduced.

## Disconnected acceptance and tests

The test file uses only artificial NBA fixtures, teams, player IDs, bookmaker fields and quotes. It checks owner and email gates, browser proof/price injection, strict selectors, exactly one source claim, simultaneous requests, failed callback/no retries, expired and future receipts, missing or spoofed source, invalid provider side pairs, original-quote immutability, and the explicitly **unresolved cross-session replay** risk. Nothing invokes a live endpoint or writes to Firestore.

From a Node.js 22 checkout:

```sh
node --check functions/offline-one-shot-quote-review.js
node --check functions/offline-one-shot-quote-review.test.js
node --test functions/offline-one-shot-quote-review.test.js
npm run lint --prefix functions
npm test --prefix functions
```

Dedicated PR CI runs the new synthetic tests; the existing backend CI runs regression independently. No dependency installation is needed for the focused test.

## Release remains blocked

The first genuinely trusted player-level capture needs independently observed OddsPapi response shape, reviewed ESPN player/team/event IDs, exact existing manual reservation/receipt wiring, server-only create-only protected storage with global replay controls, a proven single-target rollback, least-privilege IAM review and separate owner approval for provider calls and production changes. Preserve all 15 production Functions including the separately deployed preflight callable; never blanket-deploy.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
