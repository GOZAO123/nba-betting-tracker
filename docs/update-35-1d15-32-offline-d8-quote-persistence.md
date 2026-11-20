# Update 35.1D15.32 — Offline D8 source receipt → private create-only quote evidence

**DRAFT / OFFLINE ONLY. No Firebase deployment, genuine OddsPapi fetch, betting capture or real Firestore write.**

## One narrow integration

Adds a **separate, default-disabled composition factory** `makeOfflineManualQuotePersistence(config)` in `functions/offline-manual-quote-persistence.js`. It reuses existing reviewed components without changing any of their source: D8's owner-only, parameterless `makeOfflineManualEvidenceAudit`; D15.29's opt-in one-player quote callback after an accepted/stored D8 fixture source receipt; and D15.30/31's strict create-only quote store with injected Firebase Admin-style transaction facade.

Only a **trusted backend constructor**, never browser `request.data`, may set `enabled:true`, inject the existing manual reserve/fetch functions and Admin-shaped database, and supply exactly one fixture/market/provider-player selector. D8 reserves 1 or 2 existing diagnostic slots (catalogue cached vs not) and fetches the provider league response **once**; this composition makes no extra upstream calls. D8 validates the original fixture-only receipt and stores it first in the existing `_internal/teamEvidence/providerSnapshots/` private path. Only if that store returns literal `STORED` does its private quote callback receive an immutable `UNREVIEWED_PROVIDER_QUOTE` generated from the exact D8-held provider payload and catalogue.

Inside the new factory, the callback creates a private **in-memory object-identity token** bound to that quote's exact `source`, source reference, capture timestamp, fixture ID, market ID, provider player ID and SHA-256 digest. The quote-store trust check consumes the capability once, before any transaction. The injected Admin-style store writes a second, **separate** private unreviewed evidence artifact only via an atomic create-only transaction to `_internal/quoteEvidence/providerObservations/<SHA256 key>`. It never touches `propResearchLedger`, never overwrites a prior quote and returns only fixed backend status codes. The optional `onQuoteOutcome` receives an allowlisted `{status}` only, not player, price, key, receipt token or raw error.

Every failure is **fail closed**: unsupported browser arguments are denied before reservation; absent/invalid pair does not create quote evidence; fixture receipt failure blocks quote creation; quote-store read/create failure or monitoring error leaves the original aggregate audit and stored fixture evidence intact without new paid call or retry. Cached and concurrent manual clicks do not fetch or store twice.

## Evidence limits — not a live attestation

- The source/original-quote **in-process linkage** is demonstrated in disconnected synthetic tests. The injected `fetchCatalogue`, `fetchOdds`, reservation and database are simulated and thus do not establish a genuine provider-origin attestation, paid-plan permission, true Firestore IAM or independence of model evaluations.
- A SHA-256 digest detects changed data; it is **not a cryptographic attestation of provider or bookmaker authenticity**. `betano.pt` is only OddsPapi's reported bookmaker attribution, not independently observed Betano.pt odds. The ESPN athlete ID is not independently verified. Quote status remains `UNREVIEWED_QUOTE_EVIDENCE` and all `bookmakerVerified`, `espnPlayerVerified`, `autoLineSelected`, `captureAllowed` fields remain false.
- Cross-session replay using a deliberately forged/new source receipt is not solved by the local in-memory capability alone. Durable create-only keys prevent overwrite only for the exact same receipt + fixture + player + market tuple. Globally authentic provider receipts, Admin IAM, privacy controls, provider shape and full target-only rollback still need independently verified evidence.
- The new factory is `enabled:false` by default, and **neither** `functions/index.js` nor the existing `manual-evidence-integration.js` imports it. No Firebase config, Firestore rules, frontend, cloud service accounts, live 15 Functions or production infrastructure are modified. No automatic polling, new transport or API key access is introduced.

## Offline acceptance

The synthetic test suite covers original provider receipt ↔ quote reference equivalence, ordering of fixture and quote transaction commits, unchanged budget and single-fetch behavior, strict owner verified-email gate, browser-data spoof rejection, disabled default, cache/concurrency, stale catalogue re-use, invalid/missing quote side, fixture/quote transaction failure isolation, safe status monitoring, immutable evidence and no ledger/browser write.

Run on Node.js 22:

```sh
node --check functions/offline-manual-quote-persistence.js
node --check functions/offline-manual-quote-persistence.test.js
node --test functions/offline-manual-quote-persistence.test.js functions/manual-evidence-receipt-quote.test.js
npm run lint --prefix functions
npm test --prefix functions
```

Dedicated GitHub Actions workflow tests this integration with the existing D15.29 receipt assertions. Original backend CI remains unchanged.

## Release hold

No merge until separately approved. No live OddsPapi call or Firebase deployment without separate explicit approval, budget/permissions check, and tested single-target rollback. Production has **15** Functions while source exports **14**, including separately deployed preflight; preserve them all and never blanket deploy. Keep the six requests-per-UTC-day server quota and never enable automatic OddsPapi polling.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
