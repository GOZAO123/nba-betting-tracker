# Update 35.2C — One-case official NBA reviewed nonparticipation reconciliation (draft)

## Existing evidence and exact case

**Existing Firestore observation remains PENDING until separately approved rollout and owner click.** Verified original owner-exported CSV (13 November 2026) identifies one prospective trusted-backend record:
- Record: `401909968_4251_REB_4p5_Under`
- ESPN event: `401909968`; athlete: `4251`; Boston Celtics ESPN team: `2`
- Boston Celtics @ Toronto Raptors, scheduled 12 November 2026 00:00 Europe/Lisbon (`1794441600000` ms)
- REB Under 4.5; original bookmaker quote and model snapshot are preserved in Firestore, **not** embedded in the public source manifest

Official evidence **manually reviewed** from authoritative public sources:
1. [NBA Injury Report: 11/11/26 04:00 PM ET](https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-11-11_04_00PM.pdf), page 1. Exact game `11/11/2026 07:00 (ET) BOS@TOR`; `Boston Celtics · George, Paul · Out · Injury/Illness - Illness`. **This was issued before tip-off**.
2. [NBA game recap BOS @ TOR (NBA game ID 0022600219)](https://www.nba.com/game/bos-vs-tor-0022600219), postgame article states Paul George sat out due to illness; game was Final (BOS 98, TOR 93).
3. Prior owner read-only ESPN Final boxscore and event-specific roster queries found **no Paul George row**. Missing ESPN data alone is *not* a DNP signal. The standard ESPN-only settlement appropriately refused to score a zero or infer no-action.

**Major integrity limitation:** the new backend does **not** fetch, parse, fingerprint or cryptographically authenticate official NBA evidence at runtime. It uses these exactly documented, manually reviewed, source-specific assertions hard-coded and versioned in the reviewed repository commit. The backend *does* independently fetch and recheck the **ESPN Final** and verifies that the athlete ID is absent from a populated, matching team box score. Do not describe this as live NBA API verification. If a source changes, authoritative evidence conflicts, the source review is withdrawn, or ESPN identity data becomes contradictory, stop rollout or refuse reconciliation.

## Security and write model

- New callable `ledgerReconcileReviewedInactive` is **authenticated owner + verified-email only**, `europe-west1`, manual click only, single-concurrent-instance, no scheduler, no OddsPapi, no paid requests, no general DNP override.
- Callable accepts **exactly one key**: `{recordId:"401909968_4251_REB_4p5_Under"}`. Pure module also requires strict fixed ESPN event/player/team/home/away/date/market/line/side match, schema v2 trusted backend capture, valid original Firestore capture timestamp over five minutes before tip-off, and an unscored pending observation.
- One read-only ESPN `summary?event=` request is made **only when owner clicks**. Requires exact Final event ID, scheduled time ±2 minutes, home/away/team IDs, populated team athlete stats, and complete absence of target athlete ID across all ESPN boxscore groups. If ESPN provides a target athlete row (played **or** explicit DNP), this *exception* refuses; use normal ESPN-based settlement instead.
- Firestore Admin SDK uses a transaction with the shared **frozenFieldsMatch** full-field guard, exact original timestamp, pending state and race/idempotency checks. It updates **only** status, reason, null resultStat/resultWon, trusted settlement timestamp/source and structured `reconciliationEvidence`. Original odds, experimental estimates, capture receipt, ESPN IDs, market/side/line, samples and observed price timestamp remain unchanged.
- New `voidReason = NBA_OFFICIAL_REVIEWED_INACTIVE` distinct from `ESPN_EXPLICIT_DNP`; remains research **DNP / NO ACTION**, *not independently confirmed Betano settlement or a sportsbook refund*. No prediction outcome is scored and experimental Brier/win rate are unaffected. Repeated owner click is idempotent; no repeated ESPN fetch when already reconciled.
- Structured evidence contains version, exact official report + postgame URLs, source method, NBA event ID, and reverified ESPN Final identifiers; preserved within server-controlled document. Loaded-only CSV grows from 47 to **51 columns**, adding four separate evidence source/method/URL fields. Existing 47 original fields retain their order and values; older records export blank evidence fields.
- Frontend adds an explicit **Review NBA inactive evidence** button only on the exact pending Paul George entry, requires an additional confirmation warning about human-reviewed sources and non-Betano void semantics. No generic mark-DNP button, no automatic retry or capture. Existing mobile/desktop viewport and sign-in are untouched.

## Required test and integration gates

1. Node 22 syntax checks and deterministic offline unit tests for mismatched identity, receipt, raw outcome, ESPN Final missing/team/fixture conflict, played player, DNP row conflict, missing stats, duplicate requests, concurrency, immutable model/price fields, one authorized record only and server-side source disclosures.
2. Full backend and frontend regressions on CI. All source tests must be synthetic. Do not use live Firestore writes, production Firebase or OddsPapi for tests.
3. Review three backend affected files, two frontend affected files and this document as a single, isolated **draft PR**. Confirm no changes to normal manual/scheduled settlement.
4. **Production rollout requires TWO separate explicit owner approvals:** reviewed GitHub merge, and targeted Firebase deploy of **only** `functions:ledgerReconcileReviewedInactive` (do not blanket deploy; preflight source is held in unmerged PR #17). GitHub Pages frontend requires a coordinated rollout because the button is wired to the callable. Do not deploy merely because tests pass.
5. Owner PC read-only `firebase.cmd functions:list` after any approved narrow deploy (expected function count 14 if the prior 13 remain). Owner then deliberately clicks the specific review button **once** after verifying the observed source. If callable fails, leave PENDING and show safe error; no raw Firestore writes.
6. After one confirmed trusted server receipt, reload ledger: expected **31 loaded / 30 settled / 0 pending / 1 DNP no-action**, prior **13 wins / 17 losses / experimental Brier 0.2434 unchanged**, and evidence/source visible in raw structured record and export; amounts depend on no unrelated intervening changes. Repeat-click behavior is idempotent; Windows and Android smoke tests required.
7. Record milestone, source/verification limitations, deployment, and UI test evidence in issue #1. Do **not** merge PR #16 or #17, change owner permissions, or run OddsPapi.

This is a **single reviewed case**, not generalized official-NBA automatic settlement. Future nonparticipant exceptions require separately source-reviewed manifests and a trustworthy, accessible game-specific feed before scaling.
