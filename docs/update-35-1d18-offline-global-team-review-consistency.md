# Issue #97 / D18 — Offline global reviewed-team identity consistency

**Scope:** one disconnected, read-side validation safeguard. No Firebase
function export, Firestore queries, production database writes, browser UI,
permitted live review, provider call, secret, scheduled task, IAM change,
or deployment. The default D3 approved team manifest remains EMPTY.

## Baseline and safety motivation

With explicit owner approval, PR #109 was merged into `main` at
`e4529bc4d25dc7dee22eafa351bc6a47b44d7bde`. Its synthetic
Firestore/Auth emulators proved two competing D18 reviews cannot claim
the same fixture revision and that revocation denies further resolution.
It did not address conflicting **different** fixtures, whose separate
review journals can each individually be valid yet contradict one another.

A dangerous hypothetical: one approved fixture states provider
participant ID 5001 maps to ESPN team ID 14, while another states 5001
maps to ESPN team 16. A single-fixture resolver might accept both.
The same is true when two different provider IDs map to the same ESPN
team ID. Neither conflict can safely produce an authorized crosswalk.

## New disconnected read-side gate

`functions/offline-global-fixture-team-bridge.js` exports
`makeOfflineGlobalFixtureTeamBridge({loadCompleteReviewSet,
isTrustedCompleteSet,now})`, whose `resolve(query)`:

1. Refuses malformed or client-expanded fixture queries **before**
   loading sensitive private records.
2. Calls an injected, trusted backend loader **once** for a bounded
   `{complete:true,records:[...]}` snapshot with at most 128 fixtures.
   Every record must include exactly the fixture ID, protected
   OddsPapi /fixtures receipt, independent ESPN scoreboard observation,
   ESPN source metadata, and the complete append-only decision journal.
   Duplicate IDs or any malformed record reject the WHOLE snapshot.
3. Requires an independently injected
   `isTrustedCompleteSet(snapshot,tick)` callback to return the literal
   boolean `true`; a bare `complete:true` flag is **NOT** proof of
   completeness. The real backend must validate its Admin Firestore
   read scope, authentication, source provenance, absence of omitted
   relevant fixtures and a consistent read version.
4. Verifies each record through the **same** D18 source-aware packet,
   decision fingerprint/chronology and revision gate. A tampered,
   stale or previously approved but no longer resolvable record
   invalidates the whole set. The new exported read-only D18 helper
   `inspectOfflineSourceBoundTeamReview` shares that logic rather than
   inventing a second review policy.
5. Includes ONLY valid, still-active, explicitly APPROVED records in
   a bounded D3 manifest. PENDING, REJECTED and REVOKED records remain
   nonauthorizing and cannot contribute active mappings.
6. Reuses D3's **existing whole-set**
   `makeReviewedTeamBridgeResolver`. It rejects a provider participant
   ID mapped to two different ESPN team IDs, an ESPN team ID mapped from
   two different provider IDs, duplicate fixtures or malformed manifests.
   **All queries return null** when any conflicting approved mapping
   is present. It never silently chooses the first fixture.

The returned mapping is an offline, trusted-backend-only test result,
NOT authorization for the currently deployed collector, not a genuinely
reviewed NBA provider mapping and not proof that a bookmaker offer exists.
Hashes detect accidental or malicious changes but do not attest to
original API provenance. No actual NBA ID appears in these tests.

## Validation

Node.js 22 synthetic tests include:

- Two compatible reviewed fixtures; the same provider ID keeps its
  exact ESPN ID across both
- Cross-fixture provider→ESPN disagreement blocks **both** queries
- Cross-fixture many-to-one ESPN collision blocks **both** queries
- Duplicate fixture, malformed/incomplete, oversized and untrusted
  snapshots deny all mapping
- Revoked/rejected or pending fixtures cannot authorize a bridge or
  poison otherwise valid active mappings
- Altered source labels/IDs/digests or tampered event history invalidate
  the whole set
- Stale source, invalid query, client-injected fields and error handling
- No import into production `functions/index.js`; app defaults
  and existing reviewed manifest unchanged

The backend syntax/regression and source-safety GitHub workflows must
pass, along with the existing one-quote Firestore/Auth emulator suite.
That emulator does **not** yet test this new global read barrier or
concurrent approvals of **different** fixtures.

## Explicit limitations and next security gates

**Read-side protection is not write-side global arbitration.** In a
real deployment, another review transaction could commit while a
complete-set snapshot is being read; omitting an approved fixture from
the trusted loader could also hide a conflict. A future Admin-backed
implementation must ensure complete, consistent, source-authenticated
read snapshots and an atomic global ID registry or equivalent review
transaction that rejects contradictory approvals **when committed**.

The existing D18 journal also still lacks same-transaction validation
against independently authenticated provider and ESPN source records.
No production runtime IAM, provider account allowance/pricing, current
NBA fixture response/IDs or live ESPN confirmation has been verified.
Any future merge, targeted Firebase deploy, permit creation, activation,
IAM modification or paid OddsPapi request requires separate owner
approval. Preserve six reserved upstream requests per UTC day; no
automatic OddsPapi polling.
