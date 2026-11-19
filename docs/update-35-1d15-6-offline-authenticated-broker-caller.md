# Update 35.1D15.6 — offline authenticated quota-broker caller

> **OFFLINE / UNDEPLOYED:** This milestone does not import a Google
> authentication library, issue a real token, open a real network connection,
> modify IAM, or authorize paid OddsPapi requests. No production caller is
> wired to this module. Do not merge or deploy without separate owner approval.

## Verified development baseline

- Starting GitHub `main`: `34963eb60a45ee68b5499e26e385f2fcc3b56274`
  (D15.5 approved merge). The previous 15 production Cloud Functions,
  dedicated disabled diagnostic and original market audit remain unchanged.
- `functions/index.js` continues to hard-disable
  `NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false` and
  `NBA_PROVIDER_EVIDENCE_ENABLED = false`. Frontend UI gate is still OFF.
- Existing `_internal/oddsPapiDailyDiagnosticBudget` transaction remains
  the single authoritative, shared **six upstream requests per UTC day**
  reservation counter. Do not create an independent counter.
- D12 general provider-evidence release preflight remains deliberately
  **BLOCKED**. This branch does not bypass or satisfy those release gates.

## What D15.6 adds

The new pure module
`functions/offline-identity-quota-caller.js` exports
`makeOfflineIdentityQuotaCaller({audience,getIdTokenClient,fetchImpl,makeSignal})`.
It is disconnected from `functions/index.js` and cannot run in production
without new, separately approved integration work.

It accepts the same one-slot `reserve(1)` signature already used by the
existing identity-schema runner. It is designed to be injected later into the
trusted backend evidence adapter after a separate security review; browser
request bodies cannot select a broker URL or quota amount.

### Trusted future authentication integration

In a **future owner-approved implementation**, the runtime on the existing
dedicated `nba-identity-schema` service account would use Google's
keyless Application Default Credentials and obtain an ID-token client via
`GoogleAuth().getIdTokenClient(targetAudience)`. The target audience must
be the **exact root** of the private Cloud Run broker service, for example
`https://service-name-xxxxx.a.run.app`, as a **trusted configuration value**.

The caller uses the ID-token client's `getRequestHeaders(audience)` rather
than its authenticated `request()` or `fetch()` helpers. It passes only
the Authorization bearer header from those headers to one explicitly injected
Node.js Fetch call. This avoids relying on an auth HTTP client's default
retries or 401/403 replay behavior. The client never logs, returns or embeds
the token in any URL.

**No actual `google-auth-library` dependency or Google API call is added
in D15.6.** The tests inject synthetic clients and JWT-shaped fake strings.
Real ID token acquisition may itself involve metadata/auth requests; that is
not an OddsPapi call. Before production, separately verify token authenticity,
expiry, audience, audience canonicalization, actual Google auth library
behavior, timeout behavior and service-specific Cloud Run Invoker policy.

### Single HTTP attempt and strict acknowledgement

After a trusted, valid invocation of `reserve(1)`, the caller makes a
single HTTPS request to the **pinned, canonical broker root URL**:

```http
POST / HTTP/1.1
Authorization: Bearer <redacted Google-signed ID token>
Content-Type: application/json
Accept: application/json

{"operation":"RESERVE_IDENTITY_SCHEMA_ONE_SLOT","protocolVersion":1}
```

The URL must be canonical HTTPS, `*.run.app`, with no credentials, non-default
port, query, fragment or path. No redirects (`redirect: "error"`), no
application retry loop, no user-supplied endpoint, and no automatic polling.

The caller uses a 6000 ms HTTP AbortSignal after acquiring auth headers.
It accepts only **HTTP 200**, a non-redirected response from the same URL,
an exact JSON content type and a **streamed maximum of 256 response bytes**.
The response must be precisely:

```json
{"status":"RESERVED","protocolVersion":1}
```

A 2xx with extra fields, a `BUDGET_UNAVAILABLE` payload, malformed JSON,
a redirect, 401/403/429/5xx, bad content type, oversized stream, aborted
connection, or uncertain commit becomes a **fixed, redacted `unavailable`
error**. Crucially, the caller never retries the HTTP reservation and the
identity-schema diagnostic must never issue a paid provider call unless the
reservation is confirmed. An ambiguous reservation may cost one unused quota
slot, which is preferable to unaccounted paid requests.

The caller validates amount **exactly 1** before obtaining an ID token.
The trusted broker, in turn, validates the signed caller identity and uses the
same existing six-request/day Firestore transaction as the original probes.
Neither module changes Firestore permissions or accesses the research ledger.

## Remaining threats and production blockers

This is **not yet a secure deployed connection**. The following still
require separate development, review and owner authorization:

- A real Google authentication library adapter with no service-account
  JSON keys, verified token audience and carefully bounded token-acquisition
  timeout. The D15.6 HTTP timeout applies **after** token acquisition;
  a whole-operation deadline remains to be designed.
- A private Cloud Run broker with only service-specific
  `roles/run.invoker` for the dedicated identity-schema service account;
  never grant `allUsers` or `allAuthenticatedUsers`.
- A real broker-side cryptographic token verifier, raw request-byte bounds
  before JSON parsing, safe HTTP mapping and no credential-bearing logs.
  D15.5's injected verifier is not a replacement for signed JWT verification.
- Broker-side Firestore Admin SDK transaction implementation, IAM permission
  design and denial tests. A custom role on the shared default database
  still cannot be restricted to one document; the broker runtime compromise
  could expose other permitted research documents.
- User-approved IAM changes, service creation, narrowly targeted deployments,
  cost/billing checks and separately approved individual paid provider calls.
  The existing dedicated diagnostic has access to the OddsPapi secret;
  an application-side request counter is **not** a provider-enforced spend cap.
- The existing live `oddsPapiAccountPreflight` source is not necessarily in
  `main`; do **not** use a whole-functions Firebase deployment.
- The production response body/status must be checked against a real Cloud Run
  handler in an authorized, **provider-free** integration rehearsal. Fake
  responses and self-signed test tokens prove no actual IAM behavior.

## Offline validation

- Backend test suite adds 17 synthetic tests to the previous 451:
  expected **468/468** if no regressions. Tests verify pinned audience and
  single POST, Google-style header interface, invalid-amount fast fail,
  invalid URL, token acquisition failures, spoofed headers, HTTP errors,
  redirect and content-type rejection, streaming byte bounds, malformed ACK,
  abort/no retry, synthetic D15.5 ingress roundtrip, and production isolation.
- The syntax lint script must check both new files; no new dependency is
  required. CI pass is still NOT proof of IAM or deployment readiness.
- Existing frontend source unchanged; prior 106/106 frontend validation
  remains the most recent separate verified frontend baseline.
- D12 `npm run preflight:evidence` must remain `BLOCKED`,
  `releaseReady:false`, exit 2. Do not suppress that exit code.

## Primary references

- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- https://googleapis.dev/nodejs/google-auth-library/latest/classes/GoogleAuth.html
- https://googleapis.dev/nodejs/google-auth-library/latest/classes/IdTokenClient.html
- https://undici.nodejs.org/api/Fetch
- https://firebase.google.com/docs/firestore/security/iam
