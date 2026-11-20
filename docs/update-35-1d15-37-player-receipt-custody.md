# Update 35.1D15.37 — Offline original player-ID and quote/fixture receipt custody linkage

**Status: DRAFT / OFFLINE / READ-ONLY. No merge, Firebase deployment, provider request, ESPN request, real player approval, or automatic collection.**

## Existing milestone assets, not newly collected data

Update D15.27 already knows how to freeze a **single backend-selected** OddsPapi-reported Over/Under player quote with its actual providerPlayerId, participant IDs, player name, line, two quoted sides, sourceReference and SHA-256 digest. D15.30–32 already define disconnected, create-only private quote evidence storage after the D8 original fixture receipt has been stored. D15.36 rejects any unreviewed provider-to-ESPN athlete ID mapping. The **20 November live preview was transient**; no actual saved original provider ID or quote/fixture document has been independently demonstrated from that preview, and this update **cannot recover it**.

This update adds a *read-only offline join* for **future** stored, backend-owned quote and fixture evidence records. It fills a specific consistency gap between the two existing private document types without making them authentic source attestations.

## Module and review contract

- New \`functions/offline-player-receipt-link.js\`: \`makeOfflinePlayerReceiptLink({readPrivateEvidence,isTrustedInternalReview,now})\` returns an inert, backend-only, async \`review(selection,token)\` function. No SDK, credentials, HTTP, Firestore initialization, client endpoint or logging. No effect at construction.
- The input selector is strict and tiny: \`{fixtureId,marketId,providerPlayerId,sourceReference}\`. A production integration MUST supply this through a trusted server-only review workflow; NEVER from an arbitrary browser-selected identity or authenticated user claim. The reviewer token must be an unforgeable backend-created capability, checked by the supplied private \`isTrustedInternalReview\` callback; a string/JSON claim is not sufficient.
- It reads **at most two deterministic private documents** via injected \`readPrivateEvidence(path)\`: the original quote document at \`_internal/quoteEvidence/providerObservations/<SHA-256 of [source reference, fixture ID, player ID, market ID]>\`, followed by the corresponding D8 fixture receipt at \`_internal/teamEvidence/providerSnapshots/<source reference>\`. It never accepts a client-provided path. It never creates or updates documents.
- It checks exact schemas and UNREVIEWED status, source constants, timestamps and receipt order; recomputes the *complete* D15.27 quote checksum using the original ordered Over/Under fields, freshness and explicit-main-line flags. It recomputes every D4 fixture-row digest using the **existing canonical \`captureProviderFixture\` helper**, checks duplicate row exclusion, and recomputes the entire stored D6 batch digest. It joins the same reference, capturedAt, fixture ID, kickoff and ordered participant IDs. It fails closed on missing/corrupted/reordered/mixed receipts and callback errors.
- A successful private result retains the provider player ID, original player name, fixture and participant IDs, source reference, market ID and two digests, but **never returns odds prices/side values**. Status is \`UNREVIEWED_RECEIPT_LINK_ONLY\` and \`bookmakerVerified:false\`, \`espnPlayerVerified:false\`, \`autoLineSelected:false\`, \`captureAllowed:false\`. The result must remain private. It cannot become a research ledger record, authenticated ESPN identity or betting opportunity.
- Historical inspection of an already stored document is allowed after the game; this is NOT a fresh capture or permission to ingest stale offers.

## Trust boundaries and remaining blockers

The module cannot prove that the backend injected real OddsPapi HTTP data, that Firestore IAM protected private documents in production, or that any quote equals an independently observed Betano.pt offer. **SHA-256 hashes are consistency checks, not signatures**. It cannot authenticate an ESPN athlete ID or a reviewed bookmaker main line. The caller remains responsible for an owner-gated, audited real source acquisition, exact target-only production rollout and rollback, quota/account billing attestations, secure Admin reads, one-use receipt custody, independent ESPN source review and explicit owner approvals.

Do not wire the reader into \`functions/index.js\`, frontend, Firebase callables, any scheduler or research capture in this milestone. The shipped real player and team review manifests remain empty. The existing six upstream calls per UTC day guard remains unchanged; NO new request is authorized by this update.

## Validation

Node.js 22, using only synthetic source data and existing pure producers:

\`\`\`sh
node --check functions/offline-player-receipt-link.js
node --check functions/offline-player-receipt-link.test.js
node --test functions/offline-player-receipt-link.test.js functions/provider-player-quote-snapshot.test.js functions/provider-evidence-storage.test.js functions/offline-quote-evidence-store.test.js functions/offer-player-crosswalk.test.js
npm run lint --prefix functions
npm test --prefix functions
\`\`\`

The workflow \`.github/workflows/offline-player-receipt-link.yml\` runs the focused tests; the existing backend workflow runs original regression tests. Both must be reviewed on the exact PR head. No browser UI test is needed: this is intentionally disconnected and does not affect desktop/Android behavior.

**Release remains blocked**: \`releaseReady:false\` · \`paidProviderAllowed:false\` · \`cloudChangesAuthorized:false\`.
