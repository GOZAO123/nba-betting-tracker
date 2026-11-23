# Issue #97 — D18: Offline two-source NBA team identity review packet

**Status: offline, disconnected, no live identity verification.** This update
creates a review-only evidence presentation artifact for two independently
collected backend sources. It does NOT introduce a Firebase callable, an
owner-facing page, a Firestore writer, a provider or ESPN fetch, a team
mapping approval, a production deployment or a paid OddsPapi request.

## Starting state

After PR #106, `main` is
`8f4d0dc04dfd6cfb799015f43d4af5a9c5dbf043`. The unreviewed
OddsPapi `GET /v4/fixtures` source receipts contain fixture ID, two
provider participant IDs and **provider-observed** team names, source
timestamps and digests in schema `ODDSPAPI_V4_FIXTURES`. A Firestore/Admin
create-only store protects them from browser writes. The existing D4
team-review library supports revisioned approval, rejection and revocation,
but its provider capture helpers were designed for
`ODDSPAPI_V4_ODDS_BY_TOURNAMENTS`. **Do not mislabel the new fixtures
observations as the old odds-league source.**

The existing D3 approved team manifest is **EMPTY**. Real provider IDs,
actual NBA response compatibility, owner review, live Firestore IAM and
paid-provider allowance remain unverified.

## New source-preserving, review-only helper

`functions/offline-fixture-espn-review-packet.js` exports
`makeOfflineFixtureEspnReviewPacket(input)` and does not fetch data or
access Firestore. The input must be assembled by a future trusted backend
that separately obtains the exact private, strict fixture source **receipt**
(`receivedAt` storage wrapper excluded) and authenticates independent ESPN
NBA scoreboard provenance. A backend loader must use a fixed Admin document
path and retain source-reference and digest checks. Browser-supplied input
could forge both sources and must **never** be trusted.

The helper invokes the same strict source-receipt verifier used by the D17
private custody implementation, but validates the saved receipt at its
**original capture time** so a legitimate older receipt is not accidentally
rejected by the five-minute ingestion-freshness rule. It separately requires
both sources to be no older than 30 minutes at packet creation. It pins the
chosen exact fixture ID, validates its future kickoff (>5 minutes, <=72h),
and requires ESPN capture within 30 minutes of the provider observation.

For the ESPN source, reuse D4's `captureEspnEvent` validator with
server-supplied opaque source reference and capture timestamp. It accepts
**exactly one** distinct, upcoming, preseason-excluded NBA regular-season
scheduled event in a bounded scoreboard whose tipoff is within five minutes
of the provider fixture. It rejects no-match or multiple same-time
matches rather than guessing. It then allowlists the independently sourced
home/away ESPN team IDs and official display names. Provider participant
names remain distinct from ESPN names and no participant is silently assigned
to either ESPN team based on name similarity or order.

The returned deeply frozen, SHA-256-bound packet contains:
- `status: "EVIDENCE_READY_FOR_MANUAL_REVIEW"`
- the provider snapshot and row digests, original source reference,
  capture time, exact fixture ID, kickoff, participant IDs and names
- the independent ESPN event ID, kickoff, source reference/digest and
  official home/away ESPN team IDs and names
- `approved:false`, `reviewRequired:true`,
  `reviewedPairs:null` and a `packetDigest`

**Digests are integrity checks, NOT genuine source attestation or owner
approval.** A packet is NOT a D4 candidate, reviewed D3 manifest, server
crosswalk, player identity, betting market or price confirmation. It does
not change any ledger or betting model.

## Why the D4 approval gate is deliberately unchanged

D4 fingerprints an `ODDSPAPI_V4_ODDS_BY_TOURNAMENTS` observation. Treating
the `/v4/fixtures` receipt as that source would corrupt provenance. A
separate later code review must extend the D4 gate with a source-aware
candidate schema that binds **both source digests and the packet digest**
to an append-only, revision-checked, explicitly human-approved 2x2 mapping.
Approvals must be invalidated when source IDs/names, exact event, timestamps,
digest or review state changes. Revocation must remain immediate. Do not
reuse D4's existing approval path until these conditions are implemented
and tested independently.

## Validation

The synthetic test file covers distinct source labels, immutable packets,
side-by-side team IDs/names but no assignment, invalid and tampered
provider receipts, raw-source-field injection, missing fixture ID,
stale/future sources, same-tipoff ESPN collisions, ambiguous/in-progress/
postseason event rejection, spoofed ESPN names, disagreeing naming
conventions and packet-digest changes. It also verifies the production
`functions/index.js` remains disconnected.

CI runs Node.js 22 syntax and backend tests, D15.38 source-safety and the
existing Firestore/Auth emulator rehearsal. The latter checks previously
merged collector custody but does NOT execute the new packet builder in
a production backend. No live provider or ESPN request is involved.

## Subsequent, separately authorized milestone

Design a source-aware D4 review candidate and append-only owner-approved
crosswalk using the two genuine backend receipts and this bound packet;
rehearse stale/revoked/mismatched identities and concurrent review
decisions against Firestore/Auth emulators. **Only then** consider an
owner-gated read-only review interface and a separately approved controlled
production evidence capture. Database IAM, provider plan/charge verification
and exact current NBA fixture data still need independent confirmation.

No merge, Firebase deployment, permit provisioning, enablement, IAM change
or metered request is implied by this draft. Each requires distinct
explicit owner approval. Do not enable automatic OddsPapi polling.
