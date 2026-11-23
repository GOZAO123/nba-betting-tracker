# Issue #97 / D22 — Private post-commit ESPN source-reference handoff

**Scope:** disconnected D20 acquisition adapter enhancement and D21
composition test. No production import, Firebase deployment, paid
OddsPapi API request, real ESPN HTTP request, IAM grant, public
endpoint, frontend change, rules change or background polling.

## Verified base

The owner approved and merged D21 draft PR #116 to GitHub `main`
`b47708fe6d19e5296d559b04f19bf4d1ed464ae1` after the checked
five-file change and three green CI workflows (Node.js backend
709/709, Firebase/Auth emulator 9/9, source safety). D21's
`makeOfflineTwoSourceBindingCustody` enforces a private three-document
transaction and refuses unreviewed team mapping approval, but D20
only returns a status after storing an ESPN snapshot, keeping its
generated reference inaccessible to the trusted D21 caller.

## Change

D20's existing
`makeOfflineFixedEspnScoreboardAcquisition({db,fetchImpl,now,makeSignal})`
now accepts an **optional trusted constructor dependency**:
`deliverPrivateReceipt`. This is a backend-injected function, NOT
a callback supplied by an authenticated website user or request
payload; production still needs a separate secure caller and
authorization mechanism.

When an **explicitly triggered** D20 acquisition succeeds:

1. The original D20 fixed-host HTTPS scoreboard GET, stream caps,
   strict canonical ESPN sanitizer and unique pregame event guards
   run unchanged. The existing D19 Admin Firestore transaction
   creates exactly one protected allowlisted scoreboard source.
2. **Only after** D19 reports `STORED`, and after the source transaction
   commits, D20 invokes the optional private sink **once** with a
   frozen object containing exactly `source`, `reference` and
   `capturedAt`. No raw ESPN payload, event ID, source digest,
   provider ID, browser token or bookmaker offer is delivered.
3. A private sink returning literal `true` acknowledges receipt.
   D20 still returns **only `{status:"STORED"}`** to its caller.
   If the sink rejects, throws, or returns an ambiguous value,
   D20 returns **`{status:"STORED_HANDOFF_UNCONFIRMED"}`**. This
   explicitly distinguishes a completed source write from an
   unconfirmed private handoff; the system never treats this as a
   failed source fetch or an authorization to repeat it.
4. If input, ESPN HTTP/JSON verification, or D19 Firestore storage
   fails, the private sink is never invoked. A source-observation
   failure cannot supply a forged backend reference.
5. Omitting the private sink preserves D20's previous status-only
   semantics and existing D20 tests. Nonfunction sink values fail
   construction before making any request.

Only the internal constructor-time backend has access to the
private sink/receipt. No public API returns it. An untrusted future
backend cannot turn a fake fetch or a fake callback into genuine
ESPN provenance: **origin attestation remains a separate blocker**.
The callback must never be forwarded to browser code or built from
request-supplied functions.

## Verification

Additional synthetic Node.js tests prove:
- The callback is invoked only **after** source commit, with exactly
  three allowlisted frozen fields.
- No receipt fields leak to the status-only return.
- A committed source survives a rejected, malformed or throwing
  private callback with `STORED_HANDOFF_UNCONFIRMED`, one HTTP
  fetch and no new attempt.
- No callback on early rejection, invalid ESPN transport or failed
  Firestore commit.
- Constructor injection is validated, D20 default mode works
  unchanged, and the module stays unimported in production.

One new actual Firestore/Auth emulator scenario exercises
D20 -> private callback -> existing D21 source-binding custody
using **synthetic ESPN and provider evidence only**. It checks
private source storage, binding without journal/global ID mapping,
status-only output, and client GET/PATCH denial for both documents.
This exercise is not a live source-origin proof.

## Remaining release gates

The verified live backend does not yet implement a trusted owner
invocation that supplies authenticated ESPN transport dependencies.
The independent provider receipt reference must also originate
from an authenticated D17 owner-controlled provider capture.
A source-observation chain from two forged test adapters is
self-consistent, not independently authentic.

Other unresolved gates remain: genuine NBA fixture/team ID
compatibility, correctly scoped database-specific runtime IAM,
owner approval of provider subscription/quota request and cost
risk, initial global registry completeness/migration, emergency
fail-closed review revocation for stale/corrupt original evidence,
live ESPNs shape verification, and targeted rollback.

**PR merge, any Firebase production deployment, IAM change,
live ESPN capture, private source permit or paid OddsPapi
request still require separate owner approval.**
