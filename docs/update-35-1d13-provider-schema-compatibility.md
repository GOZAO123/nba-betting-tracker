# Update 35.1D13 — Offline provider identity schema compatibility and one-shot validation plan

**Status: offline-only contract and synthetic verification, not a production source diagnosis.** No Firebase deployment, production Firestore read/write, OddsPapi or ESPN request, source key access, logging, new callable, user interface, automated polling or capture. The existing user-reported Firebase billing balance was €0 before these code-only updates; the project balance was not independently rechecked.

## Why this step matters

Merged `main=10dfce886ba474f8244c7910cf18d109ba2d21d8` includes the D12 static release gate (intentionally BLOCKED), D11 default-disabled integration, D8 one-use backend receipt, D9 fixed-origin transport, D5 strict provider fixture extractor and D4 independently sourced ESPN identity review. A manual aggregate OddsPapi audit can succeed without providing the **explicit** sport/tournament, scheduled status and numeric two-team participant identifiers required to store any provider mapping evidence. Repeated paid requests cannot fix an incompatible response schema.

The original aggregate diagnostics never retained the raw source fields. A new paid/provider request **cannot be inferred to be necessary or cheap from the existing code alone**. The goal here is to define a safe, no-new-request compatibility report and a future stop/go decision.

## New D13 contract

`functions/provider-schema-readiness.js` exports `inspectOfflineProviderIdentityShape(payload,capturedAt)`. The caller supplies an **already available** fixture response as a local/in-memory object and a full ISO timestamp. The utility performs **no fetch or persistence**.

- It supports only the three D5 response envelopes: array, `{data:[...]}` and `{fixtures:[...]}`, capped at **250** entries, and does not traverse raw player odds, lines or individual market prices.
- It independently counts **fixed reason categories** for rejected fixtures (invalid/duplicate fixture ID, unconfirmed NBA sport/tournament/status/has-odds fields, nonexistent/ineligible Betano offer block, invalid kickoff or participant IDs). Every duplicate fixture ID is rejected, not first-wins. It never guesses IDs from a team name or a nearby ESPN kickoff.
- It **calls the existing D5 extractor** on the exact same supplied sample and timestamp as acceptance authority. Its counts must match D5 completely. More than 64 would-be accepted rows, mismatched counts, malformed getter objects, invalid sample bounds or missing timestamps **BLOCK** the diagnosis rather than silently truncate.
- The only output is a frozen, bounded `{status,sampleOnly:true,liveProviderVerified:false,releaseReady:false,reason,totalFixtures,acceptedFixtures,rejectedFixtures,reasonCounts}`, with fixed status/reason strings and numeric counts. **No source participant IDs, fixture IDs, team/athlete names, odds, prices, source URL, secret, timestamps or evidence receipt are returned or logged.**
- `SAMPLE_COMPATIBLE` means **only** that the supplied payload shape would pass the offline D5 identity extractor (not that this shape exists in OddsPapi production, that Betano offers are verified or that deployment is approved). `PARTIAL_SAMPLE` means some would pass; `BLOCKED` means none or a contract issue. **All states retain `releaseReady:false`** and never amend D12's production release preflight.

This is a diagnostic tool for a future owner-approved **single manual observation** and for safe development with synthetic fixtures, not a mechanism to authorize itself.

## Future one-shot field verification — NOT AUTHORIZED YET

1. **Before any live operation**, obtain a fresh owner decision for: one named Firebase Function (if deployment is needed), explicit permission for a production Firestore evidence write, a specific number of metered OddsPapi upstream reservations, and a documented rollback. Never use project-wide `firebase deploy --only functions`; held PR #17 may not match production source. Verify actual Cloud Functions inventory and source before even proposing a targeted deploy.
2. Re-check Firebase Billing and the existing **six upstream reservations per UTC day** across all diagnostics. An uncached manual audit can reserve **up to two upstream requests** (catalogue + league); a valid cached catalogue may need **one**. Reservations are not refunded if a step fails. A valid, recent 15-minute aggregate cache will not fetch again or provide fresh provider IDs retroactively. Exact provider pricing/availability is **not known**; don't assume €0 future charge.
3. Confirm fixed HTTPS `api.oddspapi.io` source, tournament 132, `betano.pt`, full-game/OT semantics, response byte ceilings, no redirect or retry, a **provider-compliant cooldown** when two requests are necessary, and owner-only manual triggering. The D11 composed runtime remains disabled until expressly approved.
4. After the **one authorized** manual fetch, reuse that already-fetched response in memory for aggregate-only D10 `onEvidenceOutcome` and D13 fixed-category diagnostics. Do **not** store raw odds in a browser, issue an extra probe, log provider IDs, or send bookmaker prices/keys to the user. The D13 offline helper is **not wired to production** by this update; such wiring needs separate design/review.
5. **STOP** if required IDs/fields are absent, if source shape is inconsistent, if any safety limit is reached, if no eligible fixture exists, or if the storage outcome is not a verified immutable backend result. Do not retry just to consume remaining quota. A `SAMPLE_COMPATIBLE` / `STORED` outcome still cannot approve provider-to-ESPN team mappings.
6. Separately acquire **independent ESPN event/scoreboard evidence**, verify a unique scheduled regular-season event, and require manual two-way ID pairing and an append-only/revocable owner review before any automated offer matching. Player identity and Betano main-line confirmation remain independent later gates.

## Verification and delivery

- Only four intended paths: `functions/provider-schema-readiness.js`, `functions/provider-schema-readiness.test.js`, `functions/package.json` and this document. Production `functions/index.js`, `firestore.rules`, `functions/README.md`, quota settings, source secrets, HTTP transport and frontend are untouched.
- Node 22 lint plus **346 existing +22 new D13 synthetic tests**. Tests cover all accepted envelope shapes, D5 reconciliation, missing/wrong identity fields, duplicates, missing Betano block, invalid kickoff, 64/250 ceilings, hostile getters, no secret/ID output and no production wiring.
- PR stays **DRAFT/UNMERGED** until the owner explicitly approves **that PR only**; a GitHub merge is not an API invocation or Firebase deployment. **No paid provider call or live storage write is authorized.**
- D12 release preflight must **remain BLOCKED** while actual provider data and independent ESPN identity are absent. A successful CI run is not evidence of a genuine betting edge, calibrated probabilities, verified odds or audited ROI.

**Next possible step after D13 merge:** design a separately reviewed, no-additional-request status-only composition into the owner-authorized manual flow, plus a targeted rollout/rollback checklist. Seek separate explicit approval before enabling any live behavior.
