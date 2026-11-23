# Issue #97 / D18 — Offline atomic two-source evidence binding

**Status: disconnected synthetic safety implementation, not a production
rollout or authenticity attestation.** The owner approved merging PR #111
at `b3a0f5e06db887f79dae036d3cd61f353be9d50a`. It introduced
transaction-protected provider↔ESPN global ID claims but deliberately
did not read the independently captured source records within the same
review transaction.

## Purpose

A review decision must not commit against provider and ESPN evidence
that has changed after the reviewer saw the packet. Independently valid
SHA-256 strings and an out-of-transaction read are not enough to
guarantee that the decision still refers to the original records.

`functions/offline-fixtures-atomic-source-review-journal.js` adds a
**guard-required, disconnected** wrapper:
`makeOfflineSourceBoundGloballyGuardedReviewJournal({db})`.
It reuses the existing D18 Admin Firestore review CAS journal and the
same D18 global ID arbitration guard; neither is rebuilt or replaced.
It does not import `firebase-admin`, make network requests, create
permits, deploy, or appear in `functions/index.js`.

The wrapper rereads **three fixed private Firestore documents inside
the SAME review transaction**, before any registry/journal writes:

1. Binding: `_internal/teamReview/sourceBindings/<fixtureId>`.
   Required exact fields: `schemaVersion:1`, matching `fixtureId`,
   `providerReference`, `espnReference`, `providerDigest`,
   `espnDigest`, and `packetDigest`. All reference and digest fields
   have strict validated shapes. **No browser-provided binding** is
   accepted by the helper.
2. Provider source:
   `_internal/teamEvidence/fixtureTeamSnapshots/<ODDSPAPI_FIXTURES_...>`.
   This is the already merged D17 create-only provider receipt format,
   with its separate backend `receivedAt` custody field. That wrapper
   is removed from the validation input only; source snapshot fields,
   fixture/participant IDs and names are strictly checked again by
   the existing D17/D18 normalizers.
3. ESPN source:
   `_internal/teamReview/espnSnapshots/<ESPN_...>`, an **offline
   proposed custody schema** with exactly `schemaVersion:1`,
   `source:ESPN_NBA_SCOREBOARD`, matching source reference,
   `capturedAt` and bounded `scoreboard`. There is **no live trusted
   ESPN snapshot writer** in this PR.

The wrapper reconstructs the existing D18 review packet at the
decision timestamp and requires its provider digest, ESPN digest
and full packet digest to exactly equal the binding and the review
event's packet digest. It separately verifies that an APPROVE event's
two manual provider↔ESPN ID pairs are a bijection of the source IDs,
not just syntactically valid numbers. A REVOKE checks the originally
approved pairs; REJECT carries none.

A missing or inconsistent source, binding, revision, packet digest or
pair ID fails closed before any global registry, event or journal write.
Firestore automatically retries transactions whose read documents
change concurrently, enforcing read consistency. The source guard runs
**before** the existing global ID guard so all transaction reads
precede registry and immutable event writes.

The existing `makeOfflineGloballyGuardedReviewJournal` remains
unchanged; the existing global guard is only re-exported so the
new strictly source-bound wrapper can compose it. Production would
have to use the new source-bound wrapper, not a weaker optional path.

## Emulator and regression criteria

The test appended to `functions/one-quote-rehearsal.js` uses only the
`demo-nba-quote-rehearsal` Firestore/Auth emulators and synthetic NBA
IDs and timestamps. Admin SDK writes private **synthetic** source
docs and a binding; there is no real ESPN or OddsPapi HTTP request.
It checks:

- No binding → approval fails with no journal or ID claim.
- Provider digest tampered after the gate's stale-but-valid packet was
  composed → transaction refuses the approval and any ID registry write.
- ESPN home team label tampered in private source document →
  packet recomputation detects the mismatch and refuses approval.
- Identical source/binding/event fingerprints → exactly one approval
  and global ID registry claim, with create-only review event.
- Binding changed before an attempted REVOKE → review transaction
  rejects; restoring the original binding permits a valid revocation.
- Browser/Auth REST GET and PATCH to binding, provider snapshot and
  ESPN observation are denied; no raw bookmaker odds or secret is
  stored in the journal.
- Existing unit/backend/source-safety and previous Firestore/Auth
  emulator regressions must remain green.

## Hard limitations (no permission implied)

The new source-binding document and ESPN snapshot are supplied by
the synthetic test. **Their authentic, immutable, independently
obtained provenance is NOT verified** merely because they live at
private Firestore paths or hash consistently. A future trusted owner-
authorized backend must create those documents through bounded,
source-aware, create-only custody, with attestations that the provider
response and ESPN scoreboard came from the genuine fixed hosts.
Before production, verify the actual provider plan/charges, real
NBA fixture and ESPN ID compatibility, runtime database-specific IAM,
and a source-safe review UI or trusted owner-only endpoint.

This addition does **not** solve potentially corrupt or incomplete
legacy review journals, backfilling the global registry, emergency
revocation when source evidence ages out, or a damaged-registry
repair/rollback plan. The D18 packet is currently freshness-limited
to 30 minutes; long-term revocation requires an explicit fail-closed,
independently reviewed design. Do not silently treat source freshness
as authority to keep old approvals forever.

**Every future PR merge, targeted Firebase deploy, permit provisioning,
production write, IAM change, collector enablement or paid upstream
OddsPapi request requires separate explicit owner approval.** The
existing production collector remains disabled per the last verified
production checkpoint; no fresh production state was read here.
