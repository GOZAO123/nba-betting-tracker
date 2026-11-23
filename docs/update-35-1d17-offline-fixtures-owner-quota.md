# Issue #97 — Disconnected owner/approval/quota fixtures orchestrator

**Draft-only; no live callable, deployment, network call, Firestore write,
IAM change, permit creation, scheduler or user-facing control.** This feature
extends the offline foundation merged at `b557902c8b5b80e0c749eed9ad23b151bb2105e7`
(PR #104) and keeps `functions/index.js` and the existing deployed
`oddsPapiCollectOneQuote` unchanged.

## Scope

`functions/offline-manual-fixtures-collector.js` exports
`makeOfflineManualFixturesCollector`, **disabled unless trusted backend code
passes `enabled:true`**. It is not imported by production. A future
separately approved backend caller must supply the exact Firebase owner UID,
server-generated 32-character hex `approvalId`, Admin Firestore getter,
the existing `reserveDiagnosticRequests(1)` callback, protected credential
reader and trusted HTTP implementation. Browser request data cannot set the
fixture, user UID, quota, provider URL, approval or other parameters.

An enabled attempt enforces this order:

1. Require verified exact Firebase owner and **empty** payload before any
   Firestore/secret/provider access.
2. Atomically claim an existing, server-provisioned approval at
   `_internal/fixtureTeamDiscovery/approvals/<id>`; exactly
   `issuedAtMs`, `expiresAtMs`, `claimedAtMs:null`, and at most
   15 minutes lifetime. No method to create this approval is supplied.
   Missing, malformed, expired, future-issued and claimed approvals reject.
   **An approval is consumed even when later steps fail.**
3. Call the trusted **shared** Firebase transactional diagnostic
   `reserveDiagnosticRequests(1)`; validate UTC-day reservation receipt
   `{utcDay,remaining}`. Reject quota failures or bad receipts before
   any API key retrieval. No reservation is refunded, even on errors.
   The server still enforces **six** metered requests reserved per UTC day
   across every diagnostic; this module does not replace that guard.
4. After successful reservation only, call the already merged, fixed-origin
   `GET /v4/fixtures` transport **once**, with 4MiB size/35s time limits,
   fixed NBA scheduled/Betano filters, redirect denial and no retry.
5. Generate a fresh backend opaque snapshot reference and UTC capture time.
   Use D17's strict normalization and the create-only Admin evidence store.
   Pass a private, invocation-local object-identity receipt to the store;
   it is never supplied by an untrusted caller. No raw provider response,
   price, API key or extra fixture fields are persisted.
6. Return **only** `{status:"STORED_UNREVIEWED"}` or
   `{status:"NO_STORABLE_FIXTURES"}`. Sanitized errors cannot expose
   keys, provider IDs/names, raw payloads or internal document paths.

The result is an **UNREVIEWED_PROVIDER_TEAM_NAMES** source observation,
**not** an approved ESPN team mapping, player-prop price, validated
bookmaker offer, AI selection, or research ledger record. Genuine
OddsPapi response compatibility has not been observed.

## Offline validation

`functions/offline-manual-fixtures-collector.test.js` supplies an entirely
synthetic Admin transaction facade, quota receipt, fixture response, and
HTTP transport. Checks disabled behavior, invalid callers/payloads,
expired/malformed/replayed approvals, single success, quota denial and
malformed quota receipts, delayed secret read, sanitized provider and
persistence failures, fake source mismatch, private schema and absence
of any `index.js` import. The existing backend Node.js 22 CI runs these
tests and the existing Firestore/Auth emulator rehearsal. A passing existing
emulator rehearsal **does not** mean this new runner was exercised in an
emulator; it requires its own follow-up.

Remaining release gates:

- A future independently reviewed, **disabled-by-default callable** that
  injects real trusted dependencies; separate server-side **approval
  provisioning** with bounded time and correct owner authorization.
- Genuine concurrent-claim and new-schema custody tests using Firestore/Auth
  emulators rather than only synthetic transaction fakes.
- Real provider response shape/cost plan and existing UTC-day reservation
  budget check before any separately owner-approved paid invocation.
- Independent ESPN event/team corroboration and explicit human-reviewed
  two-way provider↔ESPN team assignment, with revocation and no inference
  from time or name coincidence.
- Production database-specific runtime IAM, billing and targeted rollback.
  Keep collector disabled; **never** deploy all Cloud Functions or
  automatically poll OddsPapi.

**Merge, deployment, permit provisioning, enabling and metered request each
require separate explicit owner approval.** No production action is requested
or authorized by this offline draft.
