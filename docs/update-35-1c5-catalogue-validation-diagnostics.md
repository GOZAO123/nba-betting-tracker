# Update 35.1C5 — Safe catalogue validation failure classification (offline draft)

## Evidence from the 14 November 2026 owner-authorized test

- The owner explicitly ran **one** manual audit. Firestore's server-side UTC-day transaction reserved **2 of 6** diagnostic slots at 09:46:53 UTC.
- The callable returned `functions/unavailable`, and scoped Cloud Run logging at 09:46:55 UTC recorded `CATALOGUE_VALIDATE / CATALOGUE_FORMAT_OR_COUNT_LIMIT`.
- The earlier `CATALOGUE_FETCH / RESPONSE_TOO_LARGE` failure did not recur. The 32 MiB bounded catalogue reader passed the payload to validation.
- An unmetered `/v4/account` read before the test showed 17/250 monthly calls; a second unmetered read after showed **18/250**. Exactly one additional provider request was counted. The runner aborted before the NBA league odds call.
- The existing safe log merged two possibilities: unexpected top-level JSON structure, or >50,000 catalogue definitions. **The actual cause of this particular historical failure remains unknown**. No raw provider response was retained or logged.

## Narrow change

- Keep the original JSON envelope acceptance: array, `{data: array}`, or the already-supported fixture alternative. Reject invalid catalogue structure with an internal static error distinct from over-limit catalogue count.
- Keep the **50,000-definition maximum** (inclusive), even though the catalogue JSON cap is 32 MiB.
- Map the two static internal catalogue errors to separate allowlisted safe warnings: `CATALOGUE_FORMAT_INVALID` and `CATALOGUE_COUNT_LIMIT`. Preserve the legacy `CATALOGUE_FORMAT_OR_COUNT_LIMIT` category for compatibility with older test/injected errors.
- Do not log entry counts, market IDs, provider payloads, URLs, secrets, player identities, prices, or raw exception messages. The existing public callable response remains generic.
- Keep the **32 MiB catalogue / 12 MiB odds** byte ceilings, strict market identity checks, 2 maximum UTC-day reservations per cold audit, 6-slot/day server transaction, one manual invocation, owner-only authentication, caches, timeout, and no retries/polling.
- No frontend change and no change to other Firebase functions or Firestore rules.

## Deterministic offline checks

- Invalid catalogue wrappers fail with the new shape-only error and fixed-code warning.
- Exactly 50,000 definitions are accepted for validation, while 50,001 are rejected before league odds.
- A rejected catalogue reserves the two diagnostic slots before first fetch as before; there is **no second upstream league-odds request**, even if a malformed response is returned.
- Warning payloads expose only `{stage,reason}` allowlisted strings. Existing successful catalogue, snapshot cache, quota, authentication and fixture tests remain in the full Node 22 backend suite.

## Release gates

This is an **offline-only draft for review**. It cannot retrospectively tell which branch caused the live failure. No paid OddsPapi call, production deployment, merge, or Firestore write is authorized. Future live testing needs a fresh **separate** user approval after merge and **targeted-only** deployment of `functions:oddsPapiNbaMarketAudit`.

Never blanket deploy Cloud Functions while the separately deployed `oddsPapiAccountPreflight` source remains held in draft PR #17. Keep PR #16 held as well.
