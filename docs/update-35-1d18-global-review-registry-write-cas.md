# Issue #97 / D18 — Offline global team-ID approval write arbitration

**Status:** disconnected, backend-only safeguards and synthetic Firestore/Auth
emulator rehearsal. No Firebase deployment, IAM mutation, paid provider call,
permit provisioning, live data read/write, callable, browser UI, scheduler,
credentials or automatic OddsPapi polling.

## Verified baseline

Owner-approved PR #110 was squash-merged into `main` at
`50397f1501389f20ff6142d3030ee9ffc5d7a54a` on 23 November 2026.
It added a **read-side** global consistency check for a privately verified,
complete set of reviewed fixtures. The production D3 manifest is still
EMPTY. PR #109's journal permits independently approved fixtures but,
before this draft, had no global *write-side* ID arbitration.

## New isolated write-side mechanism

`functions/offline-fixtures-global-review-registry.js` exports
`makeOfflineGloballyGuardedReviewJournal({db})`. It is a separately named
wrapper around the existing D18 `makeOfflineFixtureReviewJournal`. No
production file imports it.

The existing offline journal accepts an **optional injected**
`globalGuard` hook. If present, the hook executes **inside its SAME
Firestore transaction**, after reading the current journal head and
previous event, and before writing the create-only event or revision
head. The optional hook preserves old emulator tests and never
activates global behavior implicitly; **production integration must
use the guard-required wrapper, not the legacy bare factory.**

The wrapper always creates an internal global team-ID guard which
reads/writes four fixed Admin-only registry documents, one for each of
the two provider IDs and two ESPN IDs:

- `_internal/teamReview/globalProviderIds/<providerParticipantId>`
- `_internal/teamReview/globalEspnIds/<espnTeamId>`

Each registry record holds the exact mutually agreed provider ID,
ESPN ID, and a sorted, unique bounded list of fixture IDs which
currently claim that association. All registry reads occur **before**
any writes to meet Firestore transaction requirements. The transaction
atomically updates these registry claims and creates the immutable
journal event/revision head; two competing approvals that touch the
same team ID cannot both commit contradictory mappings.

**APPROVE:** Only a valid D18 human-reviewed 2×2 pairing can claim IDs.
A provider ID cannot point to a different ESPN ID, nor may an ESPN ID
be claimed by a different provider ID. Compatible mappings from
different fixtures share a claim with distinct fixture references,
up to 128 claims per pair. Any corrupt/missing/mismatched registry
record fails closed, never picks the first mapping or silently repairs.

**REJECT:** Does not create or alter registry claims.

**REVOKE:** Uses the originally saved, digest-validated APPROVE event
and removes only that fixture's four registry claims in the same
journal transaction. A claim shared with a second approved fixture
remains locked. Once the last fixture is explicitly revoked, the
provider/ESPN registry records are deleted and a future fresh
approval may claim a different pairing. Replay or invalid transitions
remain blocked by the existing D18 revision CAS.

This only prevents **new conflicting writes through the guarded
factory**. An unauthorized Admin writer, corrupt legacy review
records, or another approval endpoint bypassing the guard would
invalidate its completeness guarantee.

## Validation

The Node.js 22 synthetic unit tests cover missing dependencies,
malformed events and production-disconnection restrictions. One
dedicated Firestore/Auth emulator test added to
`functions/one-quote-rehearsal.js` uses **only synthetic** team IDs,
fixed times and locally injected source JSON to verify:

1. Two different fixtures concurrently attempt contradictory mappings
   for the same provider ID: exactly one succeeds.
2. The loser has no decision head/event and cannot resolve its claim.
3. A compatible fixture can share a global ID claim. Revoking one
   fixture does not free a team ID still claimed by another.
4. Once the last compatible fixture revokes, both registry sides
   release their claims and the formerly blocked conflicting fixture
   may be reviewed afresh.
5. Browser Auth/Firestore REST GET and PATCH requests to both private
   registry types return HTTP 403.
6. A corrupted registry fails closed for a **new** fixture; no
   automatic repair or permission escalation.

All existing GitHub backend syntax/regression, D15.38 source-safety
and Firestore/Auth emulator workflows must remain green. This test
does not consume an actual OddsPapi or ESPN request.

## Unresolved production release blockers

- The guard is currently **opt-in through the separate wrapper**.
  Real integration must mandate it for every approval path and must
  inspect any historical approved journals before initializing the
  registry. An empty registry alone does not prove no legacy mappings.
- Exact independent ESPN and provider source custody, authenticated
  source records and **same-transaction source-digest rechecks** remain
  unimplemented. A valid digest does not authenticate a remote source.
- Registry mutations are not cryptographically linked to independently
  verified team-name records; an Admin actor can tamper. Needs a
  documented migration/rollback and reconciliation protocol before
  any production use.
- Invalid registry state can prevent a review's revocation; emergency
  fail-closed disable/repair procedure must be designed and rehearsed
  before activating a live review service.
- Production database-scoped IAM, current provider plan charges/quota,
  genuine NBA response compatibility, real IDs and authorized human
  review remain unverified.
- Every future merge, targeted deployment, IAM change, permit, real
  provider request, production write or activation requires separate
  explicit owner approval. Do not deploy all Firebase Functions.

No claim of verified OddsPapi participant IDs, Betano player markets,
model edge or betting profitability is made by these tests.
