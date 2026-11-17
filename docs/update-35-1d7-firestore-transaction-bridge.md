# Update 35.1D7 — Offline Firestore Admin transaction bridge

**Development state:** Backend-only, offline adapter; no production wiring, deployment, Firestore calls, OddsPapi requests, ESPN requests, client UI or betting capture. The owner independently confirmed their project's billing dashboard showed **€0** before D7 began; this branch makes no operational calls to the project.

## Starting point and intent

Main `250a7b803b9c02599cb5714894cece2b861d83fd` includes D5 optional sanitized evidence extraction from a *manually authorized, already-fetched* provider response and D6 immutable snapshot storage. Production `functions/index.js` supplies no evidence callback, and no genuine provider-to-ESPN mappings are approved. D6 defined a `runTransaction` contract but had no Firebase Admin-compatible adapter.

D7 creates the missing **inert, injectable transaction bridge**, not a deployed Cloud Function. It is tested with a local in-memory fake of the Firestore Admin transaction API.

## Contract

`functions/provider-evidence-firestore.js` exports:

- `makeOfflineFirestoreEvidenceTransaction(db)`: accepts only a backend-owned Admin-style object with `doc(path)` and `runTransaction(callback)`. It exposes a restricted transaction with exactly one `read(path)` and at most one `create(path, sanitizedDoc)` on the **same path**, after an absent-document read. Firestore's real transaction must guarantee atomic create-only commit; a mock does not establish Firestore permissions.
- `makeOfflineFirestoreProviderEvidenceStore({db,isTrustedManualReceipt,now})`: composes the above adapter with the existing D6 `makeOfflineProviderEvidenceStore`. The backend callback `isTrustedManualReceipt` remains required. It must independently authenticate a real manually approved provider fetch; neither a D5 batch, receipt label nor SHA-256 digest is independent provenance proof. This module does **not** automatically attest a receipt.

The adapter permits only `_internal/teamEvidence/providerSnapshots/ODDSPAPI_MANUAL_<32 uppercase hex>` (internal four-segment Firestore document path), rejects arbitrary document paths, and constrains created documents to D6 allowlisted fields, source, version, status `UNREVIEWED_PROVIDER_EVIDENCE`, record hashes and reference. It does not accept or return raw odds, player names, credentials, bookmaker lines or approved identity mappings.

When a trusted caller *eventually* uses the adapter, D6 checks authorization **before** any transaction: first write performs an atomic read and create-only write; an identical retry performs a read but no write; conflicting content cannot overwrite. Firestore may rerun its transaction callback under contention. It is therefore essential that the callback have no external side effects and that source receipts not be consumed irreversibly within a retryable transaction. D6 performs validation before entering it. The tests explicitly simulate transaction callback retries and concurrent callers.

The existing `firestore.rules` default-deny browser access to the internal path; no new client access rules are added. Future production use requires a separately reviewed backend ownership/IAM check, secure source receipt validation, least-privilege access and bounded data retention. The Admin SDK bypasses client security rules, so **correct server authorization is mandatory**.

## €0 additional-spend safety

D7 uses repository edits and GitHub Actions Node 22 tests only. It neither imports nor initializes Firebase and never instantiates a real database. Consequently, it issues no live reads, writes or paid OddsPapi calls. This does not independently verify other ongoing project charges, even though the owner reports €0 currently.

Future actual Firestore transactions can count toward reads/writes and may be billable; **production deployment and real data collection require new explicit owner approval**. Keep the existing six-reserved-OddsPapi-upstream-requests-per-UTC-day guard and never poll paid endpoints. Deploying all Firebase Functions is prohibited while account preflight source is still held separately in draft PR #17.

## Acceptance and deliberately deferred work

- Node.js 22 backend syntax/lint and 217 prior tests + 21 D7 synthetic cases: path traversal rejection, one-read/one-create enforcement, fingerprint/field minimization, owner-provenance callback denial before reads, exact idempotence, concurrent collisions, Firestore field-order tolerance, transaction-retry simulation and storage failures.
- Review exactly four paths: new module and its tests, `functions/package.json`, and this document. No `functions/index.js`, Firestore rules, diagnostics, quotas, frontend or external dependencies changed.
- Keep the PR draft and unmerged until the owner explicitly authorizes the particular PR. Do not deploy Firebase or initiate live OddsPapi/ESPN calls from this review.
- **Next separate phase:** authenticating the manual-fetch source receipt and securely wiring the sink to the existing owner-only audit. Later, independent ESPN team/event evidence and explicit review/revocation are required before enabling actual provider↔ESPN mapping; do not infer teams or Betano main lines from names or timestamps.
