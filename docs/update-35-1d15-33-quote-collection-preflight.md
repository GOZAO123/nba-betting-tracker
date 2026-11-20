# Update 35.1D15.33 — Offline fail-closed quote collection preflight

**Status: OFFLINE TEST / DRAFT ONLY. Never authorizes a production Firebase deployment, actual OddsPapi requests, live Firestore storage, odds capture, a Betano offer claim, or betting recommendations.**

## Purpose and scope

After D15.32 linked the private original D8 manual receipt to a mock create-only quote transaction, the next useful question is not whether more synthetic evidence can be stored; it is **what still prevents a first trustworthy real-provider test**. This narrow read-only preflight reuses the existing `offlineEvidenceReleasePreflight` (D12), and checks only new source-level quote-collection wiring safety. It adds a new module, tests, CI and this document. It does **not** change any existing code, backend function export, Firebase rules, client, IAM policy, secret or billing configuration.

The preflight takes exactly ten checked-out local source strings: production `functions/index.js`, `firestore.rules`, reviewed team crosswalk, existing production integration, `functions/README.md`, private D8 receipt source, D15.27 quote snapshot, D15.30 quote store, D15.31 Admin transaction facade and D15.32 disabled composition. It checks that:

- The private quote pipeline is not accidentally wired into existing production index or the deployed integration allowlist, and the backend flag remains literal false;
- The optional D8 quote callback still requires a `STORED` fixture receipt before revealing an unreviewed quote to its private sink;
- The quote snapshot continues to explicitly deny bookmaker verification, ESPN player verification, auto-line selection and capture;
- The quote-store interface still requires receipt validation and read/create-only replay handling, and the Admin transaction facade remains restricted to its deterministic internal path;
- Existing D12 six-per-UTC-day transactional quota, browser-write protections, disabled evidence path, targeted-only release guidance and reviewed-crosswalk checks remain in force.

These are **static regression checks only**, not source-to-binary, provider schema, IAM or actual database proofs. A passing source signature can be forged or superficially copied; absence of a source warning does not mean the system is safe to deploy or ready to collect. The preflight is intentionally hard-coded to return `status:BLOCKED`, `releaseReady:false`, `paidProviderAllowed:false` and `cloudChangesAuthorized:false` even if every source signature matches. Only allowlisted blocker codes are emitted; source files, credentials, runtime identities, raw prices or private errors are never printed.

## Actual remaining evidence gates

| Gate | Current evidence | Still required before a real collection test |
|---|---|---|
| Live OddsPapi player-quote shape and Betano Portugal attribution | Synthetic schema tests only; old bounded diagnostic code exists | Separately owner-approved **manual** bounded API call under six UTC-day diagnostic reservations and provider-plan constraints, with safe aggregate results and no automatic polling |
| Independent ESPN athlete/event/team identity | Existing ESPN modules and synthetic crosswalk tests; reviewed team manifest empty | Independently reviewed genuine source-to-ESPN team/event/player mappings and mismatch handling; never infer player ID from name alone |
| Original source receipt and quote storage | D8+D15.32 disconnected original-fetch and private callback with mock transactions | Attest actual deployed backend source and server-only capability, durable replay controls, actual create-only Admin isolation, privacy and quote retention |
| Firebase IAM and cost | Previous owner-observed snapshots; no current all-services attestation | Verify effective least-privilege grants and service account scope, provider quota and cloud costs before requesting paid traffic |
| Target-only deployment and rollback | 15 live Functions vs 14 source exports; original historical source fingerprint evidence | Reproducible single-function release and proven known-good rollback without touching separately deployed preflight or scheduler |
| Authorization | Offline code changes and PR merge individually authorized | Separate explicit owner approvals for any Firebase production change and each priced provider diagnostic |

## Offline validation

Run on Node 22 against an existing checked-out repository (no SDK initialization or provider calls):

```sh
node --check functions/offline-quote-collection-preflight.js
node --check functions/offline-quote-collection-preflight.test.js
node --test functions/offline-quote-collection-preflight.test.js
node functions/offline-quote-collection-preflight.js
```

The final read-only CLI is **expected to exit 2** and print only static blockers, not source content. Exit 2 means release intentionally blocked, **not a test failure**. A separate scoped GitHub Actions job runs the new tests; the existing 587-test backend workflow must remain green.

## Release safeguards

Never blanket-deploy Firebase Functions while deployed 15 includes separately managed preflight absent from GitHub 14 exports. Keep Google sign-in, ESPN identity protection, Lisbon 24-hour times and 06:00 checklist reset unchanged. Do not let this preflight enable production code, issue HTTP requests, access secrets, write Firestore, expose the owner's UID, or schedule automatic OddsPapi polling. Model probabilities and historic hit rates remain experimentally uncalibrated to independently verified Betano odds.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
