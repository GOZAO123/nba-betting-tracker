# Update 35.1D15.27 — Offline unreviewed player quote snapshot

**Status: DRAFT / OFFLINE-ONLY. Not production collection, ledger storage, quote approval, model validation, or deployment authorization.**

## Scope and architecture

This incremental change adds a **pure, backend-only** helper `functions/provider-player-quote-snapshot.js` and disconnected tests. It consumes already-supplied complete provider league fixtures and the official catalogue, using `officialCatalogueMap` for exactly the eight existing full-game (including overtime) market families. It never retrieves live provider data or accesses Firebase. No existing production `functions/index.js` export, IAM, Firestore rule, client code, diagnostic budget, secret, deployment configuration or scheduled job changes.

Given a unique fixture ID, an exact provider player ID, and a single known catalogue market ID, the helper may return a deeply frozen `UNREVIEWED_PROVIDER_QUOTE` value containing:

- The original numeric prices from both provider-reported Over and Under sides, their exact outcome IDs, source `changedAt` values, original player name and provider player ID;
- Source reference and server-supplied capture time, unique NBA fixture ID and kickoff, provider participant IDs, attributed source key `betano.pt`, market family/half-point line and the result-period inference from the official catalogue;
- Fresh-vs-stale and descriptive main-line flag status, plus a deterministic SHA-256 digest to detect later changes. This is **not an authenticity signature**, not price verification, and not a Betano bookmaker observation obtained directly from Betano;
- Permanent `bookmakerVerified:false`, `espnPlayerVerified:false`, `autoLineSelected:false`, `captureAllowed:false` flags. Even two explicit provider main-line flags do **not** permit selection or research capture.

Missing/duplicate fixture IDs, conflicting same-family/same-line active market IDs, unknown catalogue IDs, unapproved market periods, malformed/incomplete outcome pairs, mismatched player names, invalid price/timestamps, inactive bookmaker and out-of-window game/capture times are rejected. **Stale original provider quotes are preserved but explicitly labeled stale**, never approved.

## Trust boundary and limitations

The input `snapshotReference` resembles the existing `ODDSPAPI_MANUAL_` receipt syntax but the string itself is **not authenticated**. This helper intentionally has no ability to prove it was supplied by the trusted manual backend receipt or sourced from an actual paid provider response. A future owner-only backend integration must bind the content digest and receipt to the original one-time backend-fetched source, independently verify real event/team/player identity and preserve protected quote records with create-only transactions before any release. In particular, do not expose these raw values to an unauthenticated browser or treat them as verified Betano odds.

The existing fixture-only provider evidence store is **not** modified or repurposed to hold quotes, and the protected research ledger is **not** written. No real bookmaker quote was observed, selected or frozen by this PR. All test examples are artificial and must not be reported as genuine offers.

## Test acceptance

Execute from a checkout with Node.js 22:

```sh
node --check functions/provider-player-quote-snapshot.js
node --check functions/provider-player-quote-snapshot.test.js
node --test functions/provider-player-quote-snapshot.test.js
npm run lint --prefix functions
npm test --prefix functions
```

The dedicated scoped CI workflow performs the syntax and new synthetic tests. Existing backend CI runs unchanged and is expected to remain green. Tests use only Node built-ins and existing locally checked-out catalogue matching code.

## Release blockers unchanged

Real OddsPapi player schema and actual provider-side timestamps/flags, independent ESPN athlete ID crosswalk, trusted receipt binding to original backend transport and secure create-only quote storage, source/config rollback, least-privilege IAM and owner approvals all remain outstanding. Current production runs 15 Functions while GitHub exports 14; preserve the separately deployed preflight callable. Do not blanket-deploy or activate disabled production provider evidence. Do not poll OddsPapi or incur paid calls.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
