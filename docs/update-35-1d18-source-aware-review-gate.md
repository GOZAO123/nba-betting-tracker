# Issue #97 — D18 source-aware manual team review gate (offline only)

**Status:** synthetic backend library only. No Firebase endpoint, live
Firestore write, approval UI, IAM change, service deployment, provider call,
permit provisioning, scheduler, or researched bookmaker quote.

## Reviewed baseline

PR #107 merged into `main` at
`8b8a4974cf5c2e0350884097f609c90905feada7`. It added
`makeOfflineFixtureEspnReviewPacket`, preserving the original
`ODDSPAPI_V4_FIXTURES` source, fixture participant IDs and names, and a
separate `ESPN_NBA_SCOREBOARD` event with home/away ESPN IDs. The packet
always has `approved:false`, `reviewedPairs:null`, and a source-bound
packet digest. It does NOT authenticate actual API provenance.

D4's legacy `captureProviderFixture` and review journal remain
unchanged. They cover older `ODDSPAPI_V4_ODDS_BY_TOURNAMENTS` evidence and
must **not** be used to relabel these new /fixtures observations.

## Offline gate

`functions/offline-fixtures-team-review-gate.js` exports
`makeOfflineFixturesTeamReviewGate` using the established D4 pattern
and the existing D3 `makeReviewedTeamBridgeResolver`. Required backend
callbacks: `authorize`, `loadEvidence`, `loadHistory`,
`appendDecision`, `now`.

1. **Authorize before reading evidence:** `authorize(auth)` must
   independently verify the real Firebase owner and supply an opaque,
   backend-controlled `reviewerReference`. No client-provided UID,
   reviewer reference, provider ID, ESPN event, evidence digest or
   bookmaker offer is accepted in a review decision.
2. **Rebuild from independent trusted sources every time:** The
   `loadEvidence(fixtureId)` adapter must return exactly a privately
   stored and authenticated /fixtures receipt, trusted ESPN scoreboard
   response and verified ESPN capture metadata. The D18 packet is
   reconstructed at the current clock from these two source observations.
   No browser object or source checksum alone is authentic proof.
3. **Human-entered bijection:** `submit(auth, {fixtureId,action,
   expectedRevision,pairs?})` permits an `APPROVE` only when
   `pairs` explicitly specifies **both unique provider IDs and both
   unique ESPN IDs** in the reconstructed packet. The gate never guesses
   orientation by name, timestamp or participant order. It supports
   `REJECT` and `REVOKE`.
4. **Immutable review journal contract:** Each review event pins
   the **full packet digest** (which itself binds both sources), exact
   fixture ID, revision, server timestamp, reviewer reference, action,
   reviewed pairs and digest. Reviewer decisions are strictly sequenced
   after source capture and before five minutes to tipoff. Rejection
   prevents later approval on the same evidence; revocation disables
   authorization. `appendDecision` MUST perform an Admin Firestore
   transaction with *atomic append-only compare-and-set* on
   `expectedRevision` and **current packet digest**. The pure
   library's in-memory tests do not prove a production adapter will do so.
5. **Resolution is disconnected:** For a valid non-revoked review,
   `resolve({fixtureId,participant1Id,participant2Id,startTime})`
   rebuilds the current packet and revision journal, derives a D3-compatible
   single-fixture reviewed row, then applies the existing D3 resolver.
   Changed source IDs/names, changed ESPN event, malformed/replayed
   history, near-tipoff, stale source evidence, or invalid query fails
   closed. The **production D3 manifest remains EMPTY**.

Review history, fixture snapshots and ESPN records must never be
writeable by the browser. No app interface or automated approval is
provided. Approval events still contain only synthetic fixtures in tests.

## Independent production gates

- Build a trusted fixed-path Admin provider receipt loader that verifies
  source/schema/digest, and a genuinely independent, fixed-host ESPN
  observation and metadata custody. Do not interpret hashes as origin
  authentication.
- Write a dedicated **Firestore/Auth emulator** test for concurrent
  compare-and-set, read-after-write, tampered source, immediate revocation,
  and prevention of direct client writes. The new unit test's in-memory
  journal is insufficient proof of Firestore atomicity.
- Verify **global** team-ID bijection across ALL approved fixtures
  before any runtime D3 manifest is assembled. The offline
  `resolve` helper only processes one fixture and cannot exclude
  conflicting decisions in other fixtures. Do not wire it into live
  `offer-espn-evidence.js` until this check and authenticated provenance
  exist.
- Verify effective database-scoped runtime IAM, current provider
  subscription costs and allowance, real NBA fixture/schema, and
  a separately approved, disabled-by-default production review workflow.
- Obtain distinct explicit owner approvals for PR merge, any Firebase
  deployment, IAM change, provider permit, activation, and paid request.
  Never enable automatic OddsPapi polling.

## Validation

The new synthetic tests exercise owner-first checks, typed two-way
ID pairing, no name-based inference, altered provider snapshots,
tampered approval history and digests, revision collisions,
rejection/revocation, stale/near-tipoff source evidence, and D3
resolver compatibility without changing its empty production manifest.
CI must pass Node.js 22 backend syntax/regressions, existing D15.38
source-safety and the Firestore/Auth emulator baseline. Existing
emulator tests do not yet exercise this new gate.
