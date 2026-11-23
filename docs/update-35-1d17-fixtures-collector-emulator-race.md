# Issue #97 / Update 35.1D17 — Firebase emulator fixture-discovery race

**Status: synthetic emulator-only follow-up to merged PR #105.** No
production callable, import, deployment, provisioned permit, IAM change,
live Firestore document, provider API request, client UI, scheduled task or
automatic polling.

The owner approved the merge of PR #105 to `main` at
`aa55c380456ce08ea4d32e5f34e1be692806fcb6` on 23 November 2026.
Its disconnected `offline-manual-fixtures-collector.js` now needs a true
Firestore/Admin + Auth emulator rehearsal beyond synthetic transaction fakes.

## Acceptance criteria

The test added to `functions/one-quote-rehearsal.js` uses only the
project-independent `demo-nba-quote-rehearsal` Firebase emulator project,
isolated synthetic permits and an injected local `fetchImpl` whose only
output is an in-memory fixture JSON array. **It never calls OddsPapi**.

1. Two separate enabled factory instances concurrently attempt the same
   15-minute fixed-path approval. Exactly **one** Firestore transaction
   claims it; the other fails with `failed-precondition`. A subsequent
   replay also fails.
2. The winning invocation commits **one** reservation against an isolated
   emulator budget using a Firestore transaction, returns a current UTC-day
   receipt and **only then** reads a synthetic API key. The fixture
   transport makes exactly one injected request with fixed NBA/Betano
   parameters. No retries, parallel paid requests or additional permits.
3. The strict source extractor and new private custody module perform
   the actual Admin Firestore create-only transaction and write **one**
   `UNREVIEWED_PROVIDER_TEAM_NAMES` document under
   `_internal/teamEvidence/fixtureTeamSnapshots/`. No raw provider
   object, quote, key, price, official ESPN identity or approved mapping
   may be persisted or returned.
4. An Auth-emulator client cannot read or update the private evidence via
   Firestore REST API; the previously stored receipt remains unchanged.
5. Invalid owner and caller payloads cause no side effects. A separate
   valid approval with denied budget is consumed without secret reads or
   injected provider requests.
6. Preserve previous one-quote and D16 emulator tests. The workflow
   reuses the existing `One-quote emulator rehearsal` GitHub Action and
   its pinned Node 22 / Java 21 / Firebase CLI 15.35.0 environment.

## Validation and limits

- Existing backend Node.js 22 syntax + regression checks and D15.38
  source-safety must remain green.
- The existing `One-quote emulator rehearsal` workflow must pass with
  the newly appended **real emulator** integration test.
- This is **not** a production service IAM test, provider-schema
  attestation, confirmed Betano player market, legitimate provider
  participant-to-ESPN mapping, paid call approval or Firebase release.
- All permit IDs, team IDs, names, fixture dates and credentials used
  in the test are explicitly synthetic and isolated from production.
- A future independent owner review of the exact two-way source IDs,
  authenticated D4 revision journal and ERP/crosswalk is still necessary,
  together with database-specific IAM, billing, quota and rollback review.
- Retain `functions/index.js`, Firestore rules, browser behavior, the
  production collector's disabled checkpoint and the six/UTC-day guard.
  No project-wide Firebase deploy.
- Owner approval is required separately for **merging this PR** or
  any future permit, IAM modification, deployment, activation or paid
  OddsPapi request.
