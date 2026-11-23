# Issue #97 / D19 — Offline create-only ESPN scoreboard evidence custody

**Scope:** one disconnected, synthetic backend custody primitive. No live ESPN
request, Firebase deployment, production read/write, permit, IAM change,
browser UI, callable, schedule, OddsPapi request, or automatic polling.
Owner-approved PR #112 was merged to `main` at
`1bcbb3ab86e7bc26fe7a3e52e68e8ba98302f77d` with three green
checks; that PR's source-bound review guard was verified with only
synthetic ESPN source documents.

## Why this follows D18

PR #112's review transaction rereads the provider fixture evidence,
a privately pinned source binding, and the ESPN scoreboard snapshot.
But the actual ESPN snapshot had previously been **created directly by
the emulator test**, with no create-only capture adapter. This draft
adds the missing private storage primitive for already-acquired ESPN
scoreboards. It does **not** add a trusted source transport or a
source-binding provisioner.

## New disconnected backend contract

`functions/offline-espn-scoreboard-custody.js` exports:

- `sanitizeOfflineEspnScoreboard(raw)`, a pure, reject-on-ambiguity
  allowlist that accepts 1–40 NBA scoreboard events with canonical UTC
  dates, valid ID shapes, event status/season, one competition and
  exactly two distinct home/away teams. It keeps **all** supplied
  events, including same-time games, so a D18 verifier cannot falsely
  infer uniqueness by silently dropping an event.
- `makeOfflineEspnScoreboardCustody({db,attestCapture,now})`, which
  provides `storeCapture(raw,metadata,token)`. All dependencies
  must be injected by a future trusted backend; construction has no
  side effects.

For each valid raw payload, the helper first discards all unrelated
fields (ESPN statistics, network headers, opaque response data,
bookmaker-like odds and secrets), caps JSON input at 4 MiB, checks
a canonical `ESPN_...` source reference and capture time no more
than five minutes old, and calculates a digest of its **sanitized**
output. It requires a separate backend-owned
`attestCapture(token,{source,reference,capturedAt,digest})`
callback to return exact boolean `true` **before** opening Firestore.
A browser-supplied or copied hash/token is NOT proof of genuine ESPN
origin. Only a backend-controlled, one-use, fixed-host acquisition
workflow can implement that future attestation safely.

A successful Admin Firestore transaction uses exactly the private
document `_internal/teamReview/espnSnapshots/<reference>`.
It checks non-existence then uses **create only**, with these exact
fields:

```text
schemaVersion: 1
source: "ESPN_NBA_SCOREBOARD"
reference: <trusted ESPN opaque reference>
capturedAt: <canonical UTC timestamp>
scoreboard: { events: [allowlisted ESPN event rows] }
```

This matches the previously merged D18 review transaction's expected
five-field source shape. No client write rules, update/delete function,
source-binding writer or exposed event/team mapping is added.
A duplicate source reference returns `REPLAY_BLOCKED` and cannot
overwrite the original. Errors are sanitized; raw ESPN bodies, tokens,
team IDs, source digests and arbitrary Firestore paths are never
returned or logged.

## Checks and limitations

The new offline unit suite validates:
- Strict source metadata and source age; lazy/inert construction
- All-or-nothing input validation, conflicting or malformed teams,
  duplicate event IDs, oversized scoreboard and unsafe labels
- No silent removal of simultaneous events
- Exact allowlisted data, no raw fields/secret storage
- Server-only token attestation before any DB operations, replay denial
- Direct compatibility with the existing D18 source-review packet
- No production imports or loosened Firestore browser rules

A new Firestore/Auth emulator case adds two competing creates, a
protected source snapshot, replay denial, synthetic D18 review packet
interoperability and browser GET/PATCH denial for both existing and
nonexistent private records. The emulator is isolated in
`demo-nba-quote-rehearsal`; all fixture/ESPN IDs are invented solely
for security testing.

The ESPN origin and exact live scoreboard schema have NOT been verified
here: the test supplies an in-memory synthetic API-like object. A
future narrowly scoped **fixed-host ESPN capture transport** and
authenticated, single-use source token are needed before these records
can be regarded as independently genuine. This artifact intentionally
stores a **derived allowlisted observation**, not a raw original HTTP
response; any source-custody design must state that distinction.

Further unimplemented gates: trusted source-binding create-only
provisioning tying provider and ESPN independently authenticated
receipts, global journal/registry reconciliation before any
production migration, emergency fail-closed revocation when source
freshness lapses, actual OddsPapi participant identities and Betano
availability, effective production database-specific IAM and billing
review. No real offers or proven betting outcomes are implied.

**Separate owner approval is required for merging this PR, every
production Firebase deployment, live source capture, permit, IAM
change, activation and any metered OddsPapi request.** Keep the
existing deployed collector disabled and never automatically poll
OddsPapi.
