# Update 35.1D17 — Offline OddsPapi fixtures team-name evidence

**Scope:** Disconnected source-normalization stage for Issue #97. No Firebase
deployment, production export, Firestore write, secrets, API key, OddsPapi call,
permit, scheduler, polling, browser surface or research ledger operation.
Neither `functions/index.js` nor the deployed `oddsPapiCollectOneQuote` is
modified. The earlier D16 odds-league discovery core remains unchanged.

## Why a separate extractor is needed

D16 `/v4/odds-by-tournaments` captures legitimate provider fixture and
participant identifiers but does **not** retain corresponding team labels.
D4's `makePendingTeamCandidate` and `makeOfflineTeamReviewGate` already
enforce immutable, explicitly reviewed two-way provider↔ESPN ID pairing. An
unverified timestamp match or a name guessed from a client screenshot must
never be treated as a reviewed ESPN mapping.

The public [OddsPapi fixtures endpoint documentation]
(https://oddspapi.io/en/docs/get-fixtures) describes
`GET /v4/fixtures` with `fixtureId`, `participant1Id`,
`participant1Name`, `participant2Id`, `participant2Name`,
`startTime`, `updatedAt`, `sportId`, `tournamentId`,
`statusId` and `hasOdds`. Public examples are not a live NBA schema
attestation. Each call is metered according to the official
[quota documentation](https://oddspapi.io/en/docs/requests-and-quota).
**No call was made or authorized during this change.**

## Implemented code (offline only)

`functions/offline-fixture-team-evidence.js` exports
`extractOfflineFixtureTeamEvidence(payload, metadata, now)`. It consumes an
**already fetched** array plus a separately trusted backend source reference
and capture timestamp; it does not fetch, authorize, or store anything.

It accepts only an explicit NBA sport 11 / tournament 132, not-started
`statusId=0`, `hasOdds=true`, valid fixture ID, two distinct positive numeric
participant IDs, exact provider-observed team labels, valid UTC fixture and
update timestamps, and a near-future window (>5 minutes and <=72 hours).
The capture timestamp must be within the previous five minutes; the source
reference must match the separate `ODDSPAPI_FIXTURES_<32 uppercase hex>`
namespace. Any missing, malformed, inconsistent or repeated fixture ID
rejects the whole snapshot. The same numeric team ID cannot carry conflicting
names, and identical normalized names cannot be assigned to different IDs
within a snapshot.

A maximum of 250 fixtures is inspected. No more than 64 valid near-term
fixtures can be retained; larger snapshots fail closed rather than silently
truncating. Fixtures outside the time window are counted but not stored.
No odds, prices, provider keys, event labels, raw provider JSON or secondary
source fields survive allowlist normalization.

Output is a deeply immutable, digest-bearing
`UNREVIEWED_PROVIDER_TEAM_NAMES` receipt (schema v1, source
`ODDSPAPI_V4_FIXTURES`, snapshot reference, capture time, count metadata,
per-fixture IDs/names/timestamps and SHA-256 integrity digests).
**Digests and backend-supplied metadata are not proof of genuine provider
origin.** The backend must authenticate the separately approved fixed-host
request and persist its response via future reviewable create-only custody.
This new source schema is NOT silently substituted for D5/D7's existing
`ODDSPAPI_V4_ODDS_BY_TOURNAMENTS` storage schema.

No ESPN event or team ID is included in this receipt; even two events at
the same kickoff are unreviewed independent provider observations.
Do not accept this output as a reviewed D4 manifest, betting signal,
bookmaker offer confirmation, player identification or ledger capture.

## Validation / guards

- `node --check functions/offline-fixture-team-evidence.js`
- `node --check functions/offline-fixture-team-evidence.test.js`
- `node --test functions/offline-fixture-team-evidence.test.js`
- `npm run lint --prefix functions` and `npm test --prefix functions`
- GitHub's existing backend/source-safety + one-quote-emulator workflows

Targeted synthetic tests cover: valid source receipt, no raw odds or secrets,
metadata freshness, ID/name consistency, bad sport/tournament/status,
missing/duplicate IDs, Unicode/control strings, invalid dates, past/near
and far future fixtures, 250/64 caps, conflicting participant names,
multiple fixtures at same timestamp, tampering fingerprints and absence
of production wiring.

## Remaining work — no authorization implied

A future separate offline PR must construct a fixed-origin, one-call
`GET /v4/fixtures` transport with explicit permit claim, one transactional
slot reservation before API key access, bounded response parsing and no retries.
Then a separately reviewed, immutable backend custody adapter can store
this new source schema. The current D4 review gate must be reused for independent
ESPN corroboration and explicit two-way pairing with revocation, never
infer provider-to-ESPN IDs from names or kickoff time alone.

Runtime Firestore IAM, account charges/allowance, actual NBA/Betano response
shape, review operator identity, model/quote eligibility and live IDs remain
unverified. Any later merge, targeted deployment, permit, enablement,
paid provider request, or cleanup requires its own explicit owner approval.
