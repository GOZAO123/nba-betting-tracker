# Update 35.2A — Loaded-only prospective research CSV export (draft)

## Purpose and non-goals
Add an owner-triggered **local CSV download** of the prospective research records **already loaded** in AI Scanner → Prospective player-prop research ledger. This is a research snapshot for later independent analysis, **not** a verified bookmaker price archive, profitability report, or replacement for server-maintained records.

This is deliberately **frontend-only**: no Firebase Functions or Firestore rule changes, no automatic or new Firestore reads when exporting, no ESPN or OddsPapi requests, no polling, no writes, and no wagering action. It does not authorize merging or deploying the PR.

## Workflow
1. Sign in, open AI Scanner → Prospective player-prop research ledger.
2. Click **↻ Load my cloud ledger**. If older observations matter, deliberately click **Load 50 older records** as many times as required.
3. Click **⬇ Export loaded CSV** to download `nba-research-loaded-only-<UTC timestamp>.csv`.
4. The export button is disabled before data loads, while a ledger page is loading, and after a sign-out/reset. A snapshot is also guarded against account/session changes.

The file is UTF-8 CSV with BOM, comma delimiter, RFC-style quoted cells, CRLF records and fixed column order. Some spreadsheet applications in locales using semicolon delimiters require importing with **comma** explicitly.

## Scope and provenance
Every row is **one currently loaded Firestore document**. This follows the existing 50-record manual cursor pagination; it does **not** fetch anything. Each row has `export_scope=LOADED_RECORDS_ONLY`, `export_loaded_count`, `export_generated_utc`, and `export_more_pages_may_exist`. The last value mirrors the existing pagination heuristic: after exactly 50 records, another explicit page fetch may still be needed to confirm the end.

**Never interpret `export_more_pages_may_exist=false` as an audited complete account archive.** The existing Firestore query orders by `clientCapturedMs`, excluding documents without that field; cloud data can also change while pages are loaded. A later separately reviewed full-archive mechanism would be needed for completeness guarantees.

Columns are allowlisted: record ID, stored schema/capture/source status, ESPN identity and fixture identifiers, line/side/market/manual odds, frozen selected and Over estimates, 12/24 sample counts, timestamps, settlement statistic and win/loss/DNP, and stored source/disclaimer fields. Unrelated document fields, Firebase user identifiers and credentials are never serialized.

Raw fractional stored estimates are kept as fractions (e.g. `0.63`, not `63`); decimal odds remain European decimal numbers. Missing fields are blank, different from `0` and `false`. `derived_eligibility` is explicitly derived using the existing display helper; the original `record_status` is separately preserved. Pending and ESPN explicit-DNP outcomes are not silently scored as losses. The CSV does not claim a Betano-confirmed void.

UTC ISO-8601 timestamps are the canonical times, with a 24-hour Europe/Lisbon readable copy. Original Firestore timestamp seconds and nanoseconds are also exported when available, so sub-millisecond precision is not lost. Legacy records without provenance fields remain blank instead of being labeled as verified-backend captures.

## Security and limitations
- Serialization is from a fixed allowlist (no owner UID, Firebase secrets or accidental future fields).
- Every CSV cell is quoted; leading spreadsheet formula symbols (`=`, `+`, `-`, `@`, including after whitespace/control characters) are neutralized with an apostrophe. Commas, quotes and newlines remain correctly encoded.
- The CSV is downloaded directly to the user's device and does not upload data anywhere.
- Saved bookmaker prices are **manually observed, not independently Betano-verified**. Experimental probabilities are **uncalibrated**, and this export makes no audited ROI, expected-value or proven-edge claim.
- A local CSV file is editable; it does **not** confer cryptographic proof or alter original Firestore records.

## Acceptance criteria and checks
- [ ] Full frontend script parse under Node.js 22, including module scripts.
- [ ] Synthetic offline tests for correct columns/order and legacy/backend provenance.
- [ ] Pending, settled, explicit ESPN DNP, missing value, numeric zero and false survive round-trip.
- [ ] Preserve UTC/Lisbon dates, server timestamp seconds/nanos and fractional milliseconds.
- [ ] Prevent CSV formula injection, handle quoted/multiline cells, never serialize unlisted secrets.
- [ ] Export causes no Firestore/ESPN/OddsPapi calls and does not change the existing paginated query.
- [ ] Existing frontend regression tests remain passing.
- [ ] Owner browser/installed-Windows-app and Android smoke tests **after a separately approved merge/Pages update**: sign-in, ledger load, export after load, correct file content, logout disable, dashboard/checklist unaffected.

No Firebase deploy, no OddsPapi calls, no merge. Do not merge until owner has reviewed the diff and explicitly approved it.
