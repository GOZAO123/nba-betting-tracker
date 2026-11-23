# Issue #97 — Offline manual fixture-identity discovery draft

**Status: draft, deliberately disconnected.** No Firebase export, deployed function,
Cloud IAM/Firestore change, provider credential, real permit, live read/write,
OddsPapi request, scheduler or UI is created by this change. The production
`functions/index.js` and the existing disabled `oddsPapiCollectOneQuote` are
unchanged. Do **not** merge or deploy without separate owner approval.

## Purpose and known evidence gap

The deployed one-quote collector requires a trusted `participant1Id`,
`participant2Id` and exact `startTime` in its server-owned quote scope. Betano
screenshots provide player, PTS line, Over/Under prices and bookmaker context,
**not** OddsPapi participant IDs. The default reviewed team manifest remains
empty, and the 23 Nov 2026 operator read showed no documents under
`_internal/teamEvidence/providerSnapshots`. The existing hard-disabled
identity-shape callable returns counts, not the required IDs. Neither ESPN
kickoff times nor matching names are substitutes for source identifiers.

## Proposed backend-only contract

The new `functions/offline-manual-identity-discovery.js` exports one factory,
`makeOfflineManualIdentityDiscovery`, **disabled by default** and **not imported
by production code**. Future separately approved trusted wiring must supply:

- `enabled: true` only through reviewed backend source (no user or env switch),
  the exact verified owner, and a server-selected 32-hex-character `approvalId`
- A trusted Admin Firestore database and a separately approved provisioning
  process that creates one expiring permit at
  `_internal/identityDiscovery/approvals/<id>` with precisely
  `issuedAtMs`, `expiresAtMs` and `claimedAtMs: null`, lifetime at most 15 min
- The existing transactional `reserveDiagnosticRequests(1)` (shared limit 6
  upstream reservations per UTC day), protected provider secret reader, and
  fixed, redirect-denied OddsPapi HTTP adapter
- A future dedicated callable enforcing the same owner and empty-payload
  requirements before forwarding to this module; no such callable exists yet

An authorized attempt atomically **claims** the permit before spending budget.
The permit is consumed even if quota, provider or storage fails. It then
reserves **exactly one slot**, verifies a reservation receipt, and makes at
most one fixed `GET /v4/odds-by-tournaments` request for tournament 132 and
`betano.pt`; it never requests the market catalogue or retries. Secret access
is delayed until after the reservation.

D5's `extractManualProviderIdentityBatch` only accepts complete future NBA
fixture evidence with active bookmaker containers, rejects duplicated or
ambiguous IDs, and caps processing. D6/D7's existing trusted create-only
Firestore evidence store persists a *sanitized* `UNREVIEWED_PROVIDER_EVIDENCE`
snapshot under `_internal/teamEvidence/providerSnapshots/...`. The backend
checks an in-process one-use source receipt before writing. **No player names,
prices, odds, raw provider payloads, credentials or fixture IDs are returned**:
only `STORED_UNREVIEWED` or `NO_STORABLE_FIXTURES`. Errors are sanitized and
never trigger automatic retries.

This is NOT a player-ID crosswalk, market eligibility check, or approved
OddsPapi-to-ESPN mapping. A human must independently verify the two teams
against an ESPN event and explicitly approve the pair in a separate reviewed
backend process; no timestamp-only match or automatic team approval is allowed.
The player quote collector remains disabled and requires its own fresh permit,
quote scope, quota reservation and explicit per-step approvals.

## Review and remaining release blockers

1. **No operational activation:** retain disconnected status; inspect that
   `index.js`, frontend, Firestore rules, existing callable exports and
   production quota logic are unchanged.
2. **Synthetic regression:** `node --check` for the new files and
   `node --test functions/offline-manual-identity-discovery.test.js`; verify
   no side effects for disabled/unauthorized/invalid data, expired/replayed
   permits, quota denial, failed HTTP and malformed/duplicate fixtures; success
   writes only fixed-path sanitized unreviewed evidence in a fake Admin store.
3. **Future emulator test:** exercise concurrent permit claims and D6/D7
   transaction rules against the Firestore/Auth emulators before production
   integration; unit fake transactions do not prove live IAM or concurrency.
4. **Real schema/IAM:** database-specific effective runtime permissions are
   unverified, and current provider responses, the account's billing/allowance,
   market availability and ESPN team crosswalk remain unverified. A provider
   request (even one) requires new explicit paid-request approval.
5. **Quota accounting:** an identity attempt may consume one reserved slot;
   the one-quote collector may reserve two more in a separate attempt. Always
   re-read UTC-day quota, do not infer availability from an earlier day's
   document, and do not refund unused reservations.
6. **Operator approval:** explicit consent required separately for any future
   permit provisioning, IAM change, API enabling, targeted deployment,
   enablement, metered invocation or subsequent disabling. Do not deploy all
   functions or modify legacy `oddsBackendStatus`.

This draft does not choose a live fixture. The prior Luka Dončić, Donovan
Mitchell and Tyrese Maxey screenshot prices are **manual observations only**;
those offers may change or expire, and they are not OddsPapi verified.
