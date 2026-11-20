# Update 35.1D15.30 — Offline create-only quote evidence store contract

**DRAFT / OFFLINE ONLY. No Firebase configuration, production deployment, paid OddsPapi request, player identity approval, or bookmaker verification.**

## Scope

This feature adds a **new isolated transaction contract**, not a second research ledger. `functions/offline-quote-evidence-store.js` consumes an already-produced `UNREVIEWED_PROVIDER_QUOTE` from Update D15.27/D15.29, strictly checks its exact allowlisted schema and canonical SHA-256 fields, and requires an injected trusted callback to approve the original provider receipt *and exact quote digest*. The callback is an assumed trusted backend dependency, **not** proof of genuine provider origin in these synthetic tests.

When that callback returns literal `true`, an injected backend-owned atomic transaction can read and create one private quote evidence document under `_internal/quoteEvidence/providerObservations/<SHA256(source reference, fixture ID, player ID, market ID)>`. The document retains the original provider-reported quote values (decimal Over/Under prices and timestamps, player/source/market IDs, line and original source reference) with status `UNREVIEWED_QUOTE_EVIDENCE`, server receipt timestamp and all original `bookmakerVerified:false`, `espnPlayerVerified:false`, `autoLineSelected:false`, `captureAllowed:false` assertions. Returned result contains **only** one fixed status code: `STORED`, `REPLAY_BLOCKED`, `DENIED`, `INVALID_QUOTE` or `UNAVAILABLE`.

Repeated/concurrent attempts with the same provider reference, fixture, player and market use the same opaque document path. A present record yields `REPLAY_BLOCKED` and is **never overwritten**, even if a quote digest or price changed. The backend transaction adapter MUST make `create` atomic and create-only. No arbitrary client path can be passed into the helper. A valid distinct original source reference may create another observation: globally forged/reissued receipts remain outside this narrow store's authority.

## Security boundaries

- No Firebase SDK, live Firestore Admin connection, IAM role, scheduled task, HTTP, provider quota adapter or production `functions/index.js` import is added. Importing or constructing this module never invokes an injected dependency. Existing Firestore rules already deny browser writes to all unspecified paths; the new internal path is **not readable or writable by direct browser clients** under the existing deny-by-default rules. Production rules are not modified.
- The stored quote has not been independently verified against Betano Portugal's actual website. Its `attributedBookmaker` is provider supplied, not an independently verified bookmaker offer. SHA-256 merely checks source-data consistency; **it is not an authenticity signature**.
- `isTrustedQuoteReceipt(token, metadata)` MUST be implemented only by a trusted backend service using an unforgeable, source-bound capability established from the exact manually reserved provider fetch. A string receipt and digest must never alone authenticate a real quote. This PR does **not** implement that actual credential/transport integration.
- The injected `runTransaction` contract is validated through a mock. No actual Cloud Firestore transaction, IAM role or replay resistance across independent durable Firebase service instances has been attested. The cryptographically derived document path supplies an offline deterministic key; global replay controls across different forged source references are not implemented.
- This record is a **private unreviewed evidence artifact**, not a bet, recommendation, secure research capture, verified model edge or settlement record. Existing `propResearchLedger` and its protected browser-write semantics are not changed. No new auto-selection or polling.

## Offline validation

The 18 synthetic tests exercise happy-path create, fixed-only return status, duplicate/replay rejection, atomic concurrent attempts, missing/forged token, tampered digests/prices/identities, incomplete/unknown fields, expired timestamps, malformed outcomes and backend errors. All values are artificial. Run Node 22:

```sh
node --check functions/offline-quote-evidence-store.js
node --check functions/offline-quote-evidence-store.test.js
node --test functions/offline-quote-evidence-store.test.js
npm run lint --prefix functions
npm test --prefix functions
```

The dedicated GitHub Actions workflow checks syntax and focused tests. Original backend regression workflow remains unchanged; new tests do not yet alter package scripts.

## Remaining release blockers

Direct production integration, validated manual receipt binding, actual Admin SDK create-only Firestore adapter, independent ESPN event/team/player identity, genuine provider schema observation, proven target-only rollback, least privilege IAM and owner approval for live provider/deployment remain unresolved. Preserve all fifteen production Functions including the separately deployed preflight function absent from the fourteen GitHub source exports. Never blanket deploy or poll OddsPapi; preserve six diagnostic slots per UTC day.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
