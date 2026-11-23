# Issue #97 — Identity discovery Firestore/Auth emulator concurrency rehearsal

**Scope: offline test-only.** No production entrypoint, Firebase deployment,
actual Firestore data, IAM, Secrets, OddsPapi calls, account costs, UI changes,
provider IDs or betting recommendation is affected.

After the owner-approved merge of offline PR #100 at `2be3460`, the new
discovery factory still needed a true Firestore transaction rehearsal for its
single-use approval. This PR appends one new test to the existing
`functions/one-quote-rehearsal.js` harness so the established
`one-quote-rehearsal.yml` GitHub workflow automatically exercises it with
**Firestore/Auth emulators only**. The integration checks use existing
Node.js 22, Java 21 and Firebase CLI 15.35.0; no new deps or cloud tokens.

## Acceptance checks

1. Two independently constructed, enabled runners contend for the **same**
   synthetic Firestore approval in separate concurrent calls; exactly one
   succeeds, the other receives `failed-precondition`, and replay is denied.
2. Only the winning invocation may reserve **one** request in an isolated
   synthetic budget document, read a synthetic key or fetch from an injected
   in-process `fetchImpl`; the fake provider response is generated locally,
   not sent over the network.
3. A synthetic OddsPapi fixture becomes one immutable, unreviewed, normalized
   document in the existing D5/D7 collection; confirm receipt status and
   participant IDs only within the emulator process, never through UI/logging.
4. Auth emulator client API must deny direct GET to the private evidence doc.
5. Disabled, unauthenticated and malformed-data requests must have no
   approval, quota or transport effects. Quota-denied authorized calls consume
   the permit, do not read the key and do not make a provider request.
6. Keep `functions/index.js`, Firestore rules, live collector settings,
   frontend, functions inventory, production costs and shared quota source
   untouched.

## What this does not prove

- No actual deployed-function execution or database-level IAM was exercised.
- Simulated OddsPapi fixture objects are not evidence of the real provider
  schema, stable IDs, bookmaker price or market availability.
- The manually reviewed provider-to-ESPN team manifest is still empty.
- No approval exists to deploy, create a live permit, enable discovery/collector
  or make even one metered OddsPapi request.
- CI passing does not approve merge or any cloud operation.

## Validation

GitHub's existing `One-quote emulator rehearsal` workflow is the acceptance
gate. It runs the appended test through Firestore/Auth emulators. Backend
syntax/regression checks are also required. The test uses unique synthetic
identifiers and an isolated budget path so existing one-quote cases are
preserved. Existing emulator startup/teardown remains unchanged.

If the emulator test fails, keep the draft open and inspect its logs; never
test this using the real Firebase project or a paid provider endpoint.
