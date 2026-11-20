# Update 35.1D15.31 — Disconnected quote-evidence Firebase Admin transaction adapter

**Status: DRAFT / OFFLINE ONLY. No production Firebase initialization, deployment, Firestore writes, paid OddsPapi calls, research capture, or bookmaker authentication.**

## Scope

This update adds a strict **injected** Firebase Admin-style transaction facade for the D15.30 `makeOfflineQuoteEvidenceStore`. The goal is to reuse the existing D7 fixture-evidence transaction conventions without modifying the working fixture store or the protected research ledger. It adds `functions/offline-quote-evidence-firestore.js`, a synthetic Node 22 test file, a separate GitHub Actions workflow and this runbook. No pre-existing source, Firestore rules, client or production callable files are changed.

`makeOfflineFirestoreQuoteTransaction(db)` expects a backend-owned Admin Database-shaped object with `db.doc(path)` and `db.runTransaction(async transaction => ...)`, and a transaction with `get(ref)` and `create(ref, record)`. It does **not** instantiate Firebase, fetch provider odds, or connect to the network. Construction has no side effects. The facade verifies the one fixed internal path `_internal/quoteEvidence/providerObservations/<SHA256>`, permits one read, at most one create on the exact previously read absent path, checks exact field allowlists, recomputes canonical quote/source fingerprints and the deterministic document path, rejects all verified/betting-capture claims, and rejects false `STORED` or `REPLAY_BLOCKED` transaction returns. Even if an existing document is malformed, it must never be overwritten.

`makeOfflineFirestoreQuoteEvidenceStore({db,isTrustedQuoteReceipt,now})` composes that facade with the existing D15.30 private quote evidence store. The injected `isTrustedQuoteReceipt` is **required** to independently authenticate a backend-generated, fetch-bound, unforgeable receipt. Tests simulate this with an in-memory object identity and matching digest; the adapter does **not** establish that a real OddsPapi fetch or Betano price was observed.

## Test acceptance and limits

21 synthetic tests exercise an inert constructor, one exact authorized create, replay and concurrent one-winner semantics, forged/denied source receipt, altered quote and digest, bad Firestore reference, malformed Admin get/transaction, failed read/create/commit, multi-path/multi-read/multi-create manipulation, false success/replay returns, private source field leakage and unchanged production wiring. The test database is a serialized in-memory mock; real Cloud Firestore transaction retries, deployed service-account IAM, quota policy and browser rule enforcement are **not attested**.

Run on a Node.js 22 checkout:

```sh
node --check functions/offline-quote-evidence-firestore.js
node --check functions/offline-quote-evidence-firestore.test.js
node --test functions/offline-quote-evidence-firestore.test.js
npm run lint --prefix functions
npm test --prefix functions
```

The new focused workflow runs syntax checks and all 21 synthetic tests; the original backend regression workflow remains unchanged. Existing package scripts are not rewritten.

## Security and release constraints

- The original D8 quote callback remains offline and default-disabled; **no** link from that callback to this store is installed in production. Never capture unreviewed quotes as approved bookmaker offers, return prices to the browser, or modify the settled research ledger.
- The private evidence path is denied to direct clients by existing Firestore rules' default-deny behavior, but that and actual Admin IAM must be validated independently before any production use. Admin SDK bypasses browser rules and depends on service-account authority.
- A legitimate existing receipt is mandatory. SHA-256 is only a consistency check; both the source receipt and the backend storage authorization must be evaluated independently. Cross-reference anti-replay, authoritatively reviewed ESPN athlete mapping, authentic live provider field shape and a tested target-only rollback remain unresolved.
- Production has 15 Firebase Functions whereas current repository exports 14; preserve the separately deployed preflight. Do not run blanket deploy, enable automatic polling or increase the six upstream diagnostic reservations per UTC day. No API, Firebase or billing changes are authorized by this draft.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
