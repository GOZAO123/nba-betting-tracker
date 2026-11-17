# Update 35.1D3 — Reviewed server-owned team crosswalk (offline only)

**Status: DRAFT PR. No production data, live callable, API request, Firebase deployment, Firestore write or capture change.**

## Starting evidence

The 16 Nov 2026 owner-approved OddsPapi audit counted 248 NBA full-game/OT market definitions, 831 mapped market objects and 1,512 active named provider price entries across eight supported families. Its outputs were **aggregate-only**; it did not retain raw fixture participants or verified provider-team identifiers. No real provider↔ESPN team crosswalk is justified from this evidence. Therefore the shipped SERVER_REVIEWED_TEAM_MANIFEST is **empty**.

## Strict backend-controlled fixture review records

The new offline module functions/offer-team-crosswalk.js provides a factory with bounded validation and an empty default resolver. Each schema-version-1 reviewed record must include: a fixed provider fixture ID, exact kickoff timestamp, an ESPN event ID retained as review provenance, two unique provider-participant ↔ ESPN-team ID pairs, APPROVED/REVOKED status, fixed two-source manual review method, reviewed/expiry timestamps, and independent opaque source references for provider/ESPN evidence. These references record *claimed review provenance*, not cryptographic or independent proof of authenticity.

Any malformed row, duplicate fixture, reused provider ID with inconsistent ESPN ID or reused ESPN ID with inconsistent provider ID invalidates the whole manifest. Maximum 128 entries, maximum 72-hour record validity, no review older than 48 hours for an authorized lookup. Expired, revoked, future or near-tipoff approvals are rejected. Query must contain exactly fixtureId, participant1Id, participant2Id and startTime; kickoff must match exactly. No browser-provided name, roster, odds, event or authorizing assertion may override it. The resolver returns only the reviewed ESPN event ID and two ID pairs needed by 35.1D2, with no evidence references, odds or names.

The offline D2 adapter passes the provider kickoff to the reviewed crosswalk lookup *before* any ESPN reads, requires the manifest's exact ESPN event ID to match the official scoreboard game, and rejects bare team-pair arrays. The other team/roster and D1 no-main-line checks remain unchanged.

## Security limits and future milestone

A syntactically valid manifest does not establish a genuine verified team mapping; the trusted backend must obtain and approve real IDs from independent provider and ESPN source records, protect manifest writes and access, audit who approved and when, and verify revocations. The D2 adapter now rejects an ESPN scoreboard event ID that differs from the reviewed manifest event ID. This PR deliberately adds **no real records** and does not connect any code to functions/index.js or accept client-provided manifests. No Firebase deployment, ESPN/OddsPapi calls, automatic line selection, odds verification, model promotion, EV/ROI inference or ledger writes.

## Validation and acceptance

18 synthetic crosswalk tests cover empty default, exact IDs, order independence, kickoff/fixture spoofing, extra browser proof injection, expiry/revocation/future reviews, provenance mistakes, collisions, roster and identity continuation, clock and mutation failures, D2 adapter integration with no network, and absence of any live callable. Run backend Node 22 syntax/lint and all prior regression tests; review exact bounded diff. Require explicit owner approval before merging. Future paid OddsPapi calls and any production deployment require separate approvals.
