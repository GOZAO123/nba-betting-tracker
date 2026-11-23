# Issue #97 / D18 — Firestore review journal atomicity rehearsal

**Scope:** disconnected, offline-only Firestore Admin transaction adapter plus
synthetic Firestore/Auth emulator test. No live Firebase deployment, provider
request, permit, secret, callable, IAM change, production data write, client
UI or scheduled operation.

## Baseline

PR #108 was explicitly owner-approved and squash-merged into `main` at
`4dac7b509466be105fdbf85f6fc1e6365a26176e`, with 3/3 pre-merge
CI workflows passing. It added an offline source-aware human review gate
from independent `ODDSPAPI_V4_FIXTURES` and `ESPN_NBA_SCOREBOARD`
observations; it did **not** provide a Firestore-backed decision journal.
Its test double could not prove transaction isolation or browser access
rules. The production D3 reviewed team manifest is still empty.

## New disconnected Admin journal

`functions/offline-fixtures-review-journal-firestore.js` supplies a
trusted-backend adapter for the new gate's `loadHistory` and
`appendDecision` hooks, requiring an injected Admin Firestore `db`.
It is **not** imported by `functions/index.js`.

For each validated fixture ID it uses the fixed private paths:

- Head: `_internal/teamReview/fixtureJournals/<fixtureId>`
- Create-only event: `_internal/teamReview/fixtureJournals/<fixtureId>/events/000001`,
  then `000002` for a valid revocation, etc.

`appendDecision` runs a real Firestore transaction: read the current
head; check exact fixture, bound 64-character packet digest, expected
revision and previous event fingerprint; reject invalid transitions and
replay; then **create** the next event document and create/update the
single head within the same transaction. There are no functions for
event updates/deletes, arbitrary paths, cross-fixture approvals or client
writes. Events are checked again when read, with a 32-revision cap.
Malformed or incomplete journals fail closed; no event or source body is
logged or returned to an untrusted browser.

The adapter does **not** authenticate an ESPN response, an OddsPapi
source receipt or reviewer identity itself. The trusted owner-first
review gate and independently verified backend source loaders are
still mandatory. On a first approval, this implementation pins the
packet digest from the gate's authenticated backend source read, but
it does **not yet atomically re-read both source records in the same
Firestore transaction**. Production source-to-journal custody/consistency
must be reviewed separately before enabling any live approval. Global
cross-fixture participant↔ESPN team bijection remains another
separate release gate.

## Emulator acceptance

Append one synthetic scenario to the existing
`functions/one-quote-rehearsal.js` harness; use only
`demo-nba-quote-rehearsal` and Firebase Firestore/Auth emulators.
No real HTTP is sent to OddsPapi or ESPN.

1. Two independent review-gate instances race to approve one fixture
   from immutable synthetic provider and ESPN evidence. Exactly one
   transaction commits revision 1, and the other is rejected.
2. The approved, explicit two-ID pairing resolves through the existing
   D3 resolver inside this offline gate; global default approved
   manifest remains empty.
3. Replay is denied; a new timestamped explicit REVOKE writes an
   immutable second event, increments the head to revision 2 and
   immediately disables resolution.
4. Auth-emulator browser reads and direct PATCH requests to both
   private head and event document paths are denied by existing
   Firestore rules. No rule changes required.
5. Independently altering the saved event fingerprint in an emulator
   Admin context causes journal loading to fail closed. The test does
   not endorse such destructive behavior in production.
6. Existing one-quote, fixture discovery and privacy emulator
   regressions remain green.

## Further blocks

- **Production:** trusted two-source Admin loader, immutable ESPN
  observation custody, same-transaction source binding, globally
  consistent mapping review, database-specific IAM, billing and
  provider response compatibility.
- **Approvals:** distinct owner consent for merging this PR,
  provisioning any real permit, enabling/deploying functions, changing
  IAM, or making a paid OddsPapi request.
- No automatic provider polling or production full-function deployment.

CI must pass Node.js 22 syntax/regression tests, source-safety and
the complete Firestore/Auth emulator rehearsal including the new
D18 journal race. The emulator is not a live runtime IAM test.
