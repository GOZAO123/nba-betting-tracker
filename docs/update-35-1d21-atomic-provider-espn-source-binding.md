# Issue #97 / D21 — Offline atomic provider ↔ ESPN source binding custody

**Status: synthetic, disconnected backend component, not a production
deployment or permission to spend an OddsPapi slot.** The owner-approved
merge of PR #115 added the D20 offline ESPN fixed-host one-shot adapter
to `main` at `cf155ae741d247f1fee3f12c9495add3eeba3ba5`.
It remains disconnected from deployed `functions/index.js`.

## Purpose and scope

D18's secure review journal requires a private *source binding* at
`_internal/teamReview/sourceBindings/<fixtureId>` which pins two
original observation references and their immutable fingerprints.
Previously this document was created only by a synthetic emulator
setup. D21 adds **the missing create-only, transaction-bound custody
primitive**. It does not authorize any provider-to-ESPN team identity
mapping or alter any existing ledger/review logic.

`functions/offline-two-source-binding-custody.js` exports
`makeOfflineTwoSourceBindingCustody({db,authorizeBinding,
attestSourceOrigins,now})`. Construction is inert and requires
backend-only dependencies, including a Firestore Admin transaction,
trusted server clock, an owner/operation authorization callback,
and a **read-only, retry-safe** independent source-origin attestation
callback. Production must not source the callback or evidence from
browser-provided assertions. Neither a checksum nor a callback name
proves origin. No actual source credential, account, provider call,
Google identity verifier or permit issuer is implemented in D21.

The only action is
`bindSources({fixtureId,providerReference,espnReference},token)`.
The input is strictly shaped and allows **references only**, not
raw observation data, browser-approved team pairs, Firestore paths,
secret tokens or arbitrary authorization booleans.

1. Reject invalid request or clock before any authorization or DB
   access; verify trusted operation token and exact fixed references
   **before any Firestore read**.
2. In one Admin Firestore transaction, read all three protected docs
   **before any write**:
   - `_internal/teamReview/sourceBindings/<fixtureId>`
   - `_internal/teamEvidence/fixtureTeamSnapshots/<ODDSPAPI_FIXTURES_...>`
   - `_internal/teamReview/espnSnapshots/<ESPN_...>`
3. If the binding already exists, reject the replay. If either source
   is absent/corrupt, reject. The provider must match the canonical
   D17 exact receipt format plus backend-received timestamp, and pass
   `validateOfflineFixtureTeamEvidenceReceipt` with original
   record/team-name SHA-256 integrity. The ESPN source must match
   D19's **exact five-field private schema**; its scoreboard must
   already be canonical and strictly equal to the D19 allowlist
   sanitizer's reconstructed output (no raw odds, headers, secret
   fields, additional events, or skipped ambiguous rows).
4. Rebuild the existing D18 two-source review packet **from the
   transaction-read originals**, at trusted server time. All
   original capture timestamps must meet D18's 30-minute
   freshness, independent-source overlap, and unique scheduled
   matchup constraints. The packet remains **unreviewed**.
5. Require a backend-supplied `attestSourceOrigins(token,proof)`
   to return literal `true` for the exact frozen provider and ESPN
   receipt references, both digests, fixture and combined packet
   fingerprint. This verifier must be **pure/retry-safe**: Firestore
   may rerun its transaction callback. A future owner-controlled
   implementation needs authoritative, independently recorded
   capture provenance; two self-consistent hashes are not
   independent proof.
6. Create precisely one private binding document via `tx.create`
   with only these seven fields:

```text
schemaVersion: 1
fixtureId: <server-validated fixture>
providerReference: <trusted original provider receipt ref>
espnReference: <trusted original ESPN snapshot ref>
providerDigest: <D18 provider snapshot digest>
espnDigest: <D18 ESPN observation digest>
packetDigest: <D18 combined packet digest>
```

No automatic ID crosswalk, global registry claim, reviewed event,
quote, model, betting record, provider market, raw source or ESPN
player record is ever created by the binding operation. All results
are fixed status codes, not the IDs/fingerprints. A second or
competing writer cannot replace the first binding. Browser rules
remain unchanged and deny direct `_internal` writes/reads.

## Validation

New synthetic Node22 tests cover strict input and source reference
validation, pre-database authorization, no source proof leakage,
canonical source rechecking, corruption and timestamp blocking,
absent/competing binding, fail-closed attestation, negative clocks,
inert startup, no production import and no added paid request.

The new Firebase Firestore/Auth emulator scenario additionally
checks two concurrent create-only binding attempts; a binding
remaining unreviewed, with no global ID registry or journal event;
source mutation after binding preventing review; a **separately
explicit manual approval** using the existing D18 source-bound
guard producing one journal event/global ID claim; browser GET/PATCH
denied to private bindings. All are synthetic; no live source
or paid API is touched.

## Non-negotiable remaining blockers

- **No live authenticated pair reference handoff:** D20 intentionally
  returns status only and exposes no private ESPN source reference
  even to its caller. A future backend-only custody receipt channel
  must securely propagate its newly generated source reference,
  independently verified provider evidence, and authorization to
  D21. Do not work around this with browser-controlled references.
- Actual fixed-host ESPN observations and D17 provider receipts must
  be independently authenticated before the two backend attestation
  callbacks can be trusted. D21 does not implement a real owner
  credential/token verifier, source permit, or network capture.
- Review freshness expires after 30 minutes under D18. A safe
  emergency revocation and corrupt-source recovery workflow remains
  necessary; never silently keep stale approvals actionable.
- Global registry completeness, existing journal migration and
  real provider↔ESPN participant/fixture ID compatibility remain
  unverified, as do production database-specific runtime IAM,
  provider account costs, quota and targeted rollback.

**PR merge, every production Firebase deployment, live ESPN capture,
backend IAM change, source permit, and any paid OddsPapi request
still require separate owner approval.** Keep the production
collector and identity diagnostic disabled; no automatic provider
polling.
