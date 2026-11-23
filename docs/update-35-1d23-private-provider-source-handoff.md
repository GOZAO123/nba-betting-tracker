# Issue #97 / D23 — Private provider fixture evidence-reference handoff

**Status:** offline / disconnected owner-gated prototype. No paid OddsPapi
request, live ESPN request, Firebase deployment, production IAM grant,
credentials, Firestore production write, callable activation, browser
change or automatic polling.

## Verified baseline

The owner approved [PR #117](https://github.com/GOZAO123/nba-betting-tracker/pull/117)
for merge after the exact four-file diff and three green GitHub checks:
Node22 backend **714/714**; Firestore/Auth emulator **10/10**; source
safety PASS. Its squash merge is `2bcceadc22774eb3feab5b25fc1ddf4934f3f823`
on GitHub `main`, independently confirmed. That D22 change gives
the offline ESPN acquisition a trusted-backend post-commit reference
handoff, but the existing D17 manual OddsPapi fixtures collector still
returns only `STORED_UNREVIEWED` even to its private backend caller.

## D23 one-feature change

`functions/offline-manual-fixtures-collector.js` accepts a single
OPTIONAL, constructor-injected backend function:
`deliverPrivateReceipt=null`. The factory remains completely
inert/disabled by default; non-function values are rejected before
an enabled run. **A browser request never supplies the function,
provider URL, fixture ID, receipt reference, or enable flag.**

All original D17 controls are unchanged:

- Authenticated email-verified owner, empty browser request,
  hard-coded server-side one-use permit, and 15-minute permit TTL.
- Atomic Firestore claiming of that permit BEFORE any quota access.
- Exact one-slot reservation in the shared six-requests-per-UTC-day
  server-enforced budget, verified before reading the OddsPapi key.
- Exactly one fixed-host `/v4/fixtures` request using tournament
  132, NBA sport 11, `betano.pt`, with no automatic retries.
- Strict NBA team/participant evidence extraction, 64-record cap,
  one-use source token, exact digest, and protected Admin Firestore
  `tx.create` on the original D17 source receipt, with no raw
  provider odds, unreviewed personal data, credentials or team
  approvals in any client result.

**Only after** the Admin receipt is committed, if a trusted backend
sink was supplied, the collector invokes it once with a frozen object
having EXACTLY three fields:
`{source:"ODDSPAPI_V4_FIXTURES",reference,capturedAt}`.
No provider fixture payload, team/player IDs, price, token, key or
receipt digest is given to the sink. The callback is not available to
browser code.

If it acknowledges with literal `true`, the outward response is
still `{status:"STORED_UNREVIEWED"}`. If delivery throws, rejects,
returns false or a non-boolean, the response is instead
`{status:"STORED_UNREVIEWED_HANDOFF_UNCONFIRMED"}`. This means
**the original receipt IS stored, the paid quota and one-use permit
ARE consumed, but the private reference's delivery is uncertain**.
No failed-delivery path may refund/reconsume quota, retry the provider
fetch, or pretend a stored source is lost. If the original source was
not stored, no sink is called. The sink is not a new public endpoint.

## Synthetic tests and emulator

New cases in the existing D17 Node22 unit suite validate:
- One successful post-commit callback with exactly the frozen
  three-field private reference and status-only result.
- Disabled/default behavior and invalid constructor sink rejection.
- Failed/rejected/throwing callback: retained original source,
  consumed permit, exactly one reservation/provider GET and
  `STORED_UNREVIEWED_HANDOFF_UNCONFIRMED`.
- No callback on wrong owner/invalid fixture, quota denial,
  provider failure or Firestore storage failure.
- No new production import, scheduled task, provider polling, or
  browser payload trust.

The Firestore/Auth emulator adds an isolated synthetic chain:
**D17 owner/permit/quota -> exactly one mock OddsPapi GET ->
private provider receipt handoff -> D20 mock ESPN fixed-origin GET
-> private ESPN reference handoff -> D21 atomic source binding**.
It verifies both private original snapshots exist before their
handoffs, the combined binding is immutable and unreviewed (no D18
journal/global team map), a replayed permit cannot fetch again,
and client Firestore GET/PATCH is denied for all three private docs.

These tests use MOCK HTTP transports and SYNTHETIC source
attestation. They prove code-level execution order and local
Firestore rules, NOT real OddsPapi response shape, authentic ESPN
origin, live team identities, bookmaker availability, verified
prices or working production IAM.

## Remaining release gates

- Production `functions/index.js` **still does not import or
  activate** these D17/D20/D21/D23 modules.
- Actual server-verified owner authorization and source-origin
  attestation must be established; fake injected callbacks do not
  provide authentic provenance. D21's current attestation callback
  must be given a credible and transaction-safe, independently
  recorded original source custody chain.
- The current provider catalogue/fixture schema and actual ESPN
  scoreboard payload have not been independently verified by
  authorized live captures. Provider request costs, account
  entitlements, daily quota, provider-to-ESPN team-ID mapping,
  effective database-specific IAM and targeted rollback still
  block production activation.
- First-run global registry completeness/migration, honest 30-minute
  source freshness, stale approval fail-closed emergency revocation
  and corrupted-source recovery remain unverified.

**Separately approve every future PR merge and every production
Firebase deployment, IAM change, owner provider permit, live ESPN
capture and paid OddsPapi request. No automatic paid polling.**
