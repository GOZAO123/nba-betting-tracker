# Update 35.1D15.29 — Disconnected D8 receipt-bound original quote callback

**Status: DRAFT / OFFLINE ONLY. No production quote collection, migration, release or new paid API calls.**

## What changed

One optional, off-by-default extension to the existing offline `makeOfflineManualEvidenceAudit` in `functions/manual-evidence-receipt.js`. The existing authenticated, parameterless owner-only D8 runner already reserves 1 or 2 OddsPapi diagnostic slots through its injected server guard, retrieves the official catalogue and NBA league response once, validates the aggregate and fixture-only batch, and writes a protected fixture identity receipt using an injected transactional Firestore backend.

With **both** `trustedQuoteSelection` (exact fixture ID, provider player ID, market ID) **and** `onTrustedQuote` (a private trusted backend callback) configured at factory construction time, D8 can now derive one original unreviewed player quote pair from the exact same existing manual league response and the previously checked catalogue. The backend-selected identifiers cannot come from a browser request: the public manual audit runner still rejects request data. D8 compares the one-time evidence batch against its private source identity and timing before creating the quote, and emits the deeply frozen D15.27 `UNREVIEWED_PROVIDER_QUOTE` only after the preexisting create-only fixture evidence store reports `STORED`. Any quote failure or callback exception is isolated from the regular aggregate audit and must not trigger an extra provider call, quota reservation or automatic retry.

The original fixture-only evidence store remains unchanged and does NOT store player prices. The quote is sent only to an injected private callback in the **offline test harness**. The ordinary report still contains aggregate-only data and never exposes provider names, market IDs, player IDs, raw odds, error messages or credentials.

## Trust and safety

- This is stronger **in-process source provenance** than a made-up receipt string: the quote is constructed within the existing D8 reserved manual flow using the exact previously fetched original league response and the same fixture batch reference ultimately stored by D8. The caller cannot substitute the provider response or receipt through `request.data`.
- Still **not** independently attested live provider origin, original Betano bookmaker price, ESPN player identity, globally replay-resistant receipt, secure stored quote ledger, or an audited betting offer. A trusted callback could leak data if future production wiring were careless; do not expose the private callback to an arbitrary client or logger.
- The callback is **not** routed through `manual-evidence-integration.js` (its allowlist intentionally excludes both options), and `functions/index.js` never loads this path. Production remains unchanged and provider diagnostics stay disabled by default.
- No brand-new HTTP transport, quota source, Firestore collection, browser writes, permissions, IAM changes, automatic polling, timers or deploy commands were introduced. Preserve all fifteen live Functions and the source/production inventory mismatch; no blanket Functions deployment.
- Global cross-session replay prevention, independent real ESPN athlete mapping, protected create-only storage of quote snapshots, quote/receipt audit reconciliation, actual provider shape validation and a rehearsed targeted rollback are separate blockers.

## Tests

The focused synthetic tests cover the original D8 receipt-to-quote source identity and source reference equivalence, one upstream league request, unchanged two-slot budget reserve, owner and email checks, browser override rejection, disabled-by-default operation, response privacy, deep quote immutability, cache and simultaneous calls, catalogue re-use, missing Over/Under, wrong player selector, invalid fixture, failed Firestore transaction, private quote callback failure and budget denial.

Execute on Node 22 checkout:

```sh
node --check functions/manual-evidence-receipt.js
node --check functions/manual-evidence-receipt-quote.test.js
node --test functions/manual-evidence-receipt.test.js functions/manual-evidence-receipt-quote.test.js
npm run lint --prefix functions
npm test --prefix functions
```

The new workflow executes focused and existing D8 tests in a disconnected Node 22 environment. Existing backend CI runs unchanged. **All test data is synthetic**. No real bookmaker odds are captured or verified by this milestone.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
