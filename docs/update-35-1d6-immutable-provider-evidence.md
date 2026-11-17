# Update 35.1D6 — Offline immutable provider evidence storage and provenance

**Status: offline foundation, not deployed.** No production Firebase Functions wiring, Firestore reads or writes, OddsPapi/ESPN requests, scheduled polling, application screens, model changes or betting recommendations.

## Cost and verified baseline

Starting from merged main `eac741e0231c7cb7b688e9892ef255908360e06d` (D5), the existing manual OddsPapi audit can optionally supply an **already fetched** response to a disabled-by-default D5 evidence extractor. Production `functions/index.js` does not enable the callback. No provider participant IDs from the historical aggregate audit can be recovered. This PR remains **offline**, so implementation and CI introduce no incremental metered OddsPapi requests or production Firestore operations. Existing account-level Firebase billing has not been independently audited; future live Firestore transactions may consume read/write quota and must be separately approved.

## Narrow D6 storage contract

`functions/provider-evidence-storage.js` exports `makeOfflineProviderEvidenceStore({isTrustedManualReceipt,runTransaction,now})`. The factory exposes only `storeBatch(batch,receipt)`, and its caller must be trusted backend code. It does not import Firebase Admin SDK, open a network connection, write a document directly, or export a callable.

- Accept only the exact D5 allowlisted `UNREVIEWED_PROVIDER_EVIDENCE` batch schema: 1–64 accepted records out of at most 250 provider fixtures, strict source/status, safe source receipt, consistent counts, single captured timestamp no more than five minutes old and not in the future.
- Validate every fixture against the canonical D4 fingerprint by reconstructing its normalized record from **allowlisted** IDs, exact future kickoff (>5min, ≤72h) and receipt; reject duplicate fixture IDs, altered fingerprints, unexpected extra fields and all names, odds, credentials, line or approval claims.
- Require `isTrustedManualReceipt(receipt,{source,reference,capturedAt}) === true` before **any** database transaction. The backend implementation of this callback **must authenticate an actual owner-approved/manual provider fetch**, rather than trusting client-supplied tokens, hashes or method names. A deterministic checksum is tamper detection, not independently authenticated source provenance.
- Through a supplied transaction wrapper `runTransaction(async tx => ...)`, read a **fixed backend-only document path** `_internal/teamEvidence/providerSnapshots/<opaque-snapshot-reference>`. If absent, create the immutable batch in one create-only write; exact replays return `ALREADY_STORED` without another write; conflicting contents under the same reference return `CONFLICT` and never overwrite.
- The transaction wrapper must implement `tx.read(path)` and `tx.create(path,doc)` as **atomic transaction** operations, with create-only semantics and no replacement. This is an interface/contract in D6, not a production Firestore adapter. No browser-controlled collection path or arbitrary source field can change it.
- Stored data are limited to source, receipt ID, captured/received timestamps, non-approving status, counts, normalized fixture IDs, participant IDs, kickoff, and SHA-256 fingerprints. No ESPN event ID, team pair assignment, player/offer/market/price, API key, owner UID, model score, capture or settlement is stored.
- Failures have fixed status values: `INVALID_BATCH`, `DENIED`, `UNAVAILABLE`, `STORED`, `ALREADY_STORED`, `CONFLICT`. No raw error text or source records are returned in responses. The helper does not retry a provider request.

## Trust boundaries and next stage

This offline helper is **not authentication**: an unsafe injected `isTrustedManualReceipt` callback or non-atomic storage wrapper can break guarantees. A future separately reviewed production integration must bind the receipt to the existing manually invoked, budget-reserved owner-only odds fetch, use Firebase Admin SDK transactions with a no-overwrite document create and strict server IAM, and decide bounded retention. Existing Firestore rules default-deny browser access to `_internal`; do not add any browser allow rules.

The D6 document is a **provider observation only**, not an ESPN event identity, verified bookmaker offer, reviewed crosswalk or approved player. Subsequent stages must independently corroborate ESPN evidence, persist review history with authenticated owner decisions and compare-and-swap revisions, and ensure revoked mappings cannot remain in caches. The D3 default reviewed manifest stays empty. Never infer a main betting line from unflagged entries.

## Acceptance and rollout restrictions

- Node 22 lint and all 197 existing tests plus 18 D6 synthetic tests, including idempotency, concurrent collisions, tampering, receipt refusal, provenance minimization and storage faults.
- Review exactly four changed files: new storage module, its test, backend package scripts and this document. No `index.js`, frontend, Firestore rules, diagnostic quota or secrets changes.
- Keep feature PR draft/unmerged until owner explicitly authorizes merging **that PR only**.
- No production deploy, real Firestore write, ESPN fetch, or metered OddsPapi request under this approval. Never deploy all functions while separately deployed account preflight source is absent from `main` due to draft PR #17.
- Keep the six-upstream-reservations-per-UTC-day guard and no automatic polling intact.

ESPN-only broader-team/player AST model generalization remains a separate, non-production research goal.
