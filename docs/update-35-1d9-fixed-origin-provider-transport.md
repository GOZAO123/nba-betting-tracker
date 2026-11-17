# Update 35.1D9 — Fixed-origin, bounded manual OddsPapi transport (offline)

**Status:** Offline-only implementation and synthetic tests. No production `functions/index.js` changes, deployment, live OddsPapi/ESPN requests, real Firestore reads/writes, new callable, schedule, bookmaker polling, price output, settlement or front-end change.

## Verified starting state

Merged `main` commit `1c95dab504df8fcf6d7e5850d4b1d0a65e1703e9` contains D8's owner-only, quota-reserved, manually invoked source receipt and immutable evidence storage composition. This composition still relies on **injected** provider functions. Production continues to use the previously approved manual aggregate-only audit and **does not enable D8**. Historical audit aggregates contain no recoverable raw provider fixture/participant IDs; D3 approved mappings remain empty.

## D9 scope

`functions/manual-odds-fixed-transport.js` exports `makeOfflineFixedOriginOddsPapiTransport({getApiKey,fetchImpl,makeSignal})`. It performs **no effect at import or construction**. Only when its returned `fetchCatalogue()` or `fetchOdds()` are explicitly invoked does it:

- Read the protected provider secret through a **trusted, injected backend accessor** (never a client argument, environment dump, log or returned result).
- Request **only** HTTPS origin `https://api.oddspapi.io`, using exact paths `/v4/markets` with `language=en`, and `/v4/odds-by-tournaments` with `tournamentIds=132`, `bookmaker=betano.pt`, `language=en`, `verbosity=3`. Each uses only the fixed parameters plus safely URL-encoded `apiKey`. There are no per-call parameters allowing an arbitrary host, league, bookmaker or URL override.
- Use a single GET with `redirect:error`, `cache:no-store`, `credentials:omit`, `Accept:application/json`, and a 35-second abort signal. An injected fetch implementation is required; there is no internal global fetch or ability to run independently of the caller.
- Enforce a streamed **12 MiB** decoded-byte limit on league odds, and **32 MiB** on the market catalogue. Reject non-streamable responses, invalid content types, HTTP failures, redirects, response URL changes, malformed/primitive JSON, invalid streamed byte chunks and large `Content-Length` without following additional links or issuing retries. Size limits match the existing manual audit's intended endpoint-specific ceilings.
- Collapse any provider, secret, stream or fetch error into a constant, non-sensitive failure message. Never return an HTTP body, URL (containing the secret), API key, provider error or external status code on failures. Successful payloads are returned **only to the trusted caller** and are subsequently aggregated/sanitized by the existing audit runner.

D9 does **not** bypass the required authorization and reservation guard: the standalone factory exposes low-level fetch functions to its **trusted server caller**, so the only approved future integration is injecting them into D8's existing verified-owner, zero-request-before-budget-reserve manual wrapper. Tests explicitly verify unauthorized requests and quota failures cannot access the credential or invoke the HTTP callback via this wrapper. Do not publish the low-level transport as a callable, and never invoke directly before a server budget reservation. The fixed-origin HTTP request is an origin-control safeguard, not cryptographic or independent provider identity attestation; the backend configuration, TLS validation and injected dependencies must remain trusted.

## Testing, limitations, and rollout

- Node 22 syntax check and **259 baseline tests + 25 new synthetic D9 tests**. Fakes test exact URLs, query encoding, redirect refusal, safe error messages, byte limits, invalid JSON/stream, no retries, owner/budget gating and D8 compositional compatibility without external network.
- Four-file diff only: new `functions/manual-odds-fixed-transport.js`, new test module, `functions/package.json` and this document. No `functions/index.js`, Firestore security rules, frontend, API quota, secret values, or dependency change.
- Keep PR **draft and unmerged** until separate owner approval. Merging does not authorize Firebase deployment, new live Firestore activity or paid provider requests. Preserve the six-upstream-reservations-per-UTC-day server guard and no automatic polling.
- Provider field compatibility still requires a **separately owner-authorized manual** live test when ready. If the actual provider response lacks the explicit required team participant IDs, source sport/tournament or scheduled status, the downstream D5 extractor fails closed; never guess from names.
- Independent ESPN event/team source evidence, manual 2×2 mapping review, immutable decision journal and revocation remain prerequisites for real matching. No verified Betano prices, valid main lines, audited ROI or model advantage have been established.

The owner previously checked Firebase billing and reported **€0**; this code makes no external network or Firebase calls. That report is separate from any future Firebase or OddsPapi usage charges.
