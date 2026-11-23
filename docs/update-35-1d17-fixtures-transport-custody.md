# Issue #97 / D17 — Offline fixed fixtures transport and private custody

**Scope:** disconnected two-component backend foundation only. The change
does not import either component into production `functions/index.js`, create
a callable, schedule provider polling, deploy Firebase, provision approvals,
read live Firestore, spend an OddsPapi request or enable `oddsPapiCollectOneQuote`.

## Existing source

PR #103 merged at `5bca58dcf6c6c11688fd4a0c3d2db8dedcf9b540`
and added `extractOfflineFixtureTeamEvidence`, a strict source-only
normalizer for an already-fetched `GET /v4/fixtures` response. It returns
unreviewed NBA fixture ID, participant IDs, names and timestamps, not any
approved provider/ESPN crosswalk or Betano-verified player market.

Official endpoint docs:
- https://oddspapi.io/en/docs/get-fixtures — `GET /v4/fixtures`
  accepts `tournamentId`, `sportId`, `statusId`, `hasOdds`,
  `bookmakers`, `language`. This call is quota-counted. Fixtures
  include provider team names/IDs and `updatedAt`.
- https://oddspapi.io/en/docs/requests-and-quota — an endpoint request
  may count against provider plan quota even if it returns an error.
  The application's transactional six-per-UTC-day guard is separate.

This PR uses documentation as a design contract, **not** proof of the
actual NBA/Betano response shape or current subscription allowance.

## What the code provides

### `offline-fixtures-fixed-transport.js`

The factory requires injected backend-owned `getApiKey` and `fetchImpl`
callbacks, and exposes `fetchFixtures()`. Construction performs no side
effects. Explicit invocation creates at most **one** HTTP request to
`https://api.oddspapi.io/v4/fixtures` with fixed fields:
`sportId=11&tournamentId=132&language=en&statusId=0&hasOdds=true&bookmakers=betano.pt`.
It never accepts caller-selected URLs, books, fixtures or query params.

It denies redirects, wrong response URLs, non-JSON or non-array envelopes,
streams over 4 MiB, invalid UTF-8/JSON, over 250 fixture objects and
excessively chunked responses. The timeout is 35 seconds with no retries.
Errors are fixed strings; never log HTTP bodies, provider URLs or the API key.
**This helper does NOT enforce owner checks or the daily quota by itself.**
A future trusted orchestrator MUST atomically claim an explicit short-lived
permit and invoke the existing `reserveDiagnosticRequests(1)` with verified
receipt **before** calling `fetchFixtures()`, and must not retry.

### `offline-fixtures-evidence-firestore.js`

The factory requires an injected backend Admin `db`, a trusted source
receipt authenticator and a server clock. It validates the exact unreviewed
source receipt contract, re-extracts its records to reject altered fields,
recomputes the canonical digests and checks count relationships/freshness.
A hash does not prove source authenticity: an independently authenticated
server-side **one-use opaque receipt token** is necessary before any DB
operation. The helper cannot be called by an untrusted browser today.

A successful call writes only via Admin `db.runTransaction`, reading the
single fixed destination
`_internal/teamEvidence/fixtureTeamSnapshots/<ODDSPAPI_FIXTURES_...>`
then using **create-only** if absent. Existing documents reject replay;
failures return sanitized status. No update, delete or raw provider payload
storage is supported. Existing Firestore browser rules deny this path.

This is a new source schema, intentionally separate from the existing
`_internal/teamEvidence/providerSnapshots` odds-league evidence. No team
approval or ESPN player identity is inferred.

## Checks and release gates

`functions/offline-fixtures-transport-custody.test.js` uses injected
synthetic transport and Firestore Admin-style transaction fakes. It verifies:
fixed URL/headers/credential encoding, lazy secret access, response-size,
response-origin and redirect checks, no retries, sanitized errors, strict
receipt hashes, create-only replay, tampering rejection, fixed private
paths and default-disabled production wiring. Both new modules and test are
registered in the standard Node.js 22 `functions/package.json` checks.

**Still unimplemented:** trusted owner-only callable/orchestrator, approved
permit provisioning, reservation-before-secret integration, genuine provider
response attestations, Firebase emulator integration of this new schema,
human-reviewed ESPN team crosswalk and revocation, and precise production
database IAM/billing review. Those require separate development/reviews and
distinct owner approval before **any** future merge, permit, deployment,
enablement or paid provider request. Never deploy all Functions or introduce
automatic OddsPapi polling. Keep the one-quote collector disabled.
