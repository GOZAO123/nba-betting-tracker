# Issue #97 — Provider-to-ESPN team identity: offline routing decision

**Status: design-only, no implementation or deployment.** This document is not an
authorization to request OddsPapi data, provision permits, change IAM, enable a
callable, write production Firestore, or merge future code. The deployed
`oddsPapiCollectOneQuote` remains disabled at the last verified checkpoint.

## Verified starting state — 23 Nov 2026

- `main` at `54dca9d94e9206785ddb312af5beeaffdb547da1`
  includes PR #100's disconnected `offline-manual-identity-discovery.js`
  and PR #101's passing synthetic Firestore/Auth emulator race test.
- Current one-request discovery consumes
  `GET /v4/odds-by-tournaments?tournamentIds=132&bookmaker=betano.pt`.
  Its D5/D7 persisted evidence contains `fixtureId`, `startTime`,
  two `participantIds`, capture time and integrity digests, but **no
  independently verified corresponding team names**.
- The D4 evidence and review library requires two distinct genuine source
  observations, a human-reviewed **2×2 provider-ID ↔ ESPN-team-ID pairing**,
  and immutable revocable review history. The production D3 reviewed team
  manifest is empty. Matching schedules or team names alone is never an
  authorization to resolve a provider ID.
- Owner Cloud Shell read of
  `_internal/teamEvidence/providerSnapshots` returned no documents.
  Database-specific effective production-runtime Firestore IAM remains open.
- Previously photographed Betano PTS prices are manual observations only.
  No live OddsPapi fixture identity, player market or price has been verified.

## Official API documentation reviewed (public web pages only)

These pages were read without calling the OddsPapi API or using the API key:

- `https://oddspapi.io/en/docs/get-odds-by-tournaments` — odds league
  response documents fixture and participant IDs; the published sample does
  not establish human-readable team labels for this endpoint.
- `https://oddspapi.io/en/docs/get-fixtures` — `GET /v4/fixtures`
  documents `fixtureId`, `participant1Id`, `participant2Id`,
  `participant1Name`, `participant2Name`, `startTime`, sport/tournament
  IDs and bookmaker `hasOdds` filtering.
- `https://oddspapi.io/en/docs/get-participants` — `GET /v4/participants`
  with `sportId=11&language=en` documents a map of provider participant
  IDs to display names.
- `https://oddspapi.io/en/docs/requests-and-quota` — both `fixtures`
  and `participants`, as well as `odds-by-tournaments` and `markets`,
  consume one **provider subscription quota request** per call. This is
  separate from the application's own six-reservations-per-UTC-day guard.
  Nothing establishes a free or guaranteed price for a call.

Official *examples* are not independent verification of real NBA or
Betano Portugal coverage; exact shape, ID validity, current plan entitlement
and provider rate limits must be checked separately with owner approval.

## Candidate architectures — no live access

### A. First read `GET /v4/fixtures` (preferred for minimum reserved slots)

A distinct future, default-off backend-only fixture identity adapter could
reserve **one** shared-budget slot, then perform at most one manual fixed-origin
`GET /v4/fixtures?tournamentId=132&language=en&statusId=0` request, subject
to final parameter and rate-limit review.

- Preserve a versioned, immutable, **UNREVIEWED** source receipt with only
  fixture ID, participant IDs and corresponding provider-observed team labels,
  source timestamps and checksum. Do not reuse the existing D5/D7 evidence
  schema by stuffing in new fields.
- Reject missing, duplicated or contradictory fixture/team IDs; ambiguous
  team labels; unexpected sport/tournament/status; near-tipoff, stale or
  excessively distant events; oversized envelopes. Do not infer valid NBA
  IDs from documentation examples or public screenshots.
- Independently fetch/inspect one ESPN event from a trusted backend source,
  validate explicit ESPN home/away team IDs and both labels, and require
  owner review of the **exact ordered two-way pairing** before a D4/D3 bridge
  can be trusted. Never approve by kickoff time alone.
- `hasOdds=true` is not proof of a Betano NBA player-points market or a
  specific bookmaker offer. Keep line, price, bookmaker and ESPN-player
  verification separate and unreviewed until a distinct collector attempt.

If only one identity request plus a cold one-quote collection are later
approved, expected *reservations* are **1 + 2 = 3 out of 6**, assuming no
other diagnostic reservations intervened. This does **not** mean the current
D16 discovery runner is activated or used: it would remain available as an
inert fallback.

### B. Retain current D16 league discovery + `GET /v4/participants`

The already merged D16 runner reserves one league-odds request and persists
unreviewed fixture IDs. A **separate** trusted, manually approved request
to `/v4/participants?sportId=11&language=en` could resolve each exact
numeric ID to a source name with a new immutable provider-name receipt.
The two receipts must be independently bound to the same IDs and corroborated
against ESPN before any reviewed crosswalk.

This preserves more existing code but needs **2 identity-stage reservations**
(league + participants), then **2 more** for a separately approved cold
one-quote attempt, totaling **up to 4/6 reserved slots**. Retain fixed-host
transport, protected keys, response-size limits, single-use approvals and
no retries/polling. The new endpoint needs an independently reviewed adapter
and correct quota reservation; its public documented shape is not live proof.

**Decision:** Prefer A for lower cost *if* offline review can establish a
safe versioned receipt and test real response compatibility under later
explicit owner authorization. Keep B as a fallback. Do not deploy an API
endpoint merely because it is documented.

## Non-negotiable security gates before any production use

1. **Separate owner approval** for designing/merging an adapter, its
   individually targeted deployment, provisioning a specific short-lived
   one-use approval, enabling it, and each billable provider attempt. Distinct
   approval still required for the existing one-quote collector and disabling
   it after a test. No scheduled or automatic provider requests.
2. Reserve from the **same Firestore UTC-day budget**, fail closed on
   unavailable/bad quota state, never refund reserved slots, and never
   retrieve the API key before successful reservation. Never exceed six
   upstream reservations per day, including other diagnostics.
3. Version and privately store original provider-name evidence with an
   authenticated backend receipt; enforce create-only and immutable data
   provenance. Do not expose entire participant catalogues or provider
   IDs/names in unauthenticated browsers or logs.
4. Bound and sanitize the ESPN comparison, prove that no conflicting event
   or same-time matchup can be silently selected, and never reuse a reviewed
   pairing after a revocation, changed participant identity or expired fixture.
5. Test with synthetic D5/D4/D3 evidence and Firestore/Auth emulators,
   including malformed source, duplicate ID, contradictory names, stale
   timestamps, same-time double-header ambiguity, concurrent approvals,
   quota failures, permission denial and replay.
6. Review Firebase region, service account, current function inventory,
   database-specific effective IAM, actual provider plan cost and rollback.
   **No project-wide functions deployment.**
7. Live provider response compatibility and NBA Betano market eligibility
   remain unverified until a future separately authorized request. The
   observed screenshots and historical prices must not be promoted to a
   bookmaker-verified quote, research record or recommendation.

## Next implementation scope (only with separate review)

Build and test *one* disconnected adapter for option A. It should consume
injected fixture JSON, apply strict provenance and identity checks, and
produce a private unreviewed receipt; do not add a Firebase export or operator
UI. Then separately design the owner-reviewed ESPN pairing process using
the existing D4/D3 gates rather than duplicating them. Neither step implies
approval for a billable call.
