# Update 35.1D15.5 — authenticated broker ingress, OFFLINE only

> **No deployment, no IAM changes, no service creation, no OddsPapi requests.**
> This is an unconnected pure Node.js module and synthetic security tests.
> Passing these tests **does not prove a real token signature is verified**.
> Do not enable diagnostic flags or merge without explicit owner approval.

## Existing state and precise scope

Baseline: GitHub main at `a46f4dce7e21a83eaca05062733c38773498d9d0`
(D15.4), with 15 previously verified production Functions. The new identity
diagnostic remains backend/UI disabled and uses dedicated `nba-identity-schema`
runtime identity. The original market audit remains untouched. The D12 general
provider-evidence release preflight remains intentionally **BLOCKED**.

This milestone adds **only** `functions/offline-identity-quota-ingress.js`,
synthetic `functions/offline-identity-quota-ingress.test.js`, this document,
and the corresponding `functions/package.json` offline lint/test wiring.
No `functions/index.js` import, Cloud Run or Firebase export, HTTP listener,
Firestore write adapter, IAM grant, scheduler, network transport or secret
access is introduced. The earlier inert broker protocol from D15.4 is reused.

## Actual Google Cloud security requirements

A future private Cloud Run broker must enforce **two independent gates**:

1. **Cloud Run IAM gate**: Require authentication, remove any `allUsers` and
   `allAuthenticatedUsers` Invoker binding **on the broker only**, and grant
   `roles/run.invoker` on that service only to the existing
   `nba-identity-schema` runtime service account. Do not modify the existing
   publicly invokable Firebase `onCall` endpoints or their compatibility.
2. **Application cryptographic verification**: Require one regular
   `Authorization: Bearer <Google-signed ID token>` on the broker. Use a
   real Google ID-token verification library to validate signature, expiry,
   issuer, audience and subject, then enforce the *exact* expected service
   account email and `email_verified=true`. Do not merely decode a JWT.

Cloud Run documents that `X-Serverless-Authorization` takes precedence over
`Authorization` if both are set and **removes the signature** before the
token reaches the container. This design rejects that alternate header and
requires regular `Authorization` so the future app verifier can validate
the signed token independently. Confirm actual Cloud Run forwarding behavior
in an isolated environment before deploying a broker.

The required token audience is the **exact broker service `*.run.app` URL**,
not the browser URL, the calling Function URL, or a different service.
The broker endpoint URL is not yet known or configured. Do not create service
account keys or download credentials; in Cloud Run use Application Default
Credentials / metadata-based identity through a trusted auth library.

**Critical trust boundary:** the offline module receives a trusted injected
`verifyIdToken(token, audience)` function returning verified claims.
Production must use a cryptographic verifier such as the Google authentication
library; the injected mock used in tests is not authentication. Headers,
request bodies, `X-Caller`, self-declared `email`, or unsigned JWT payloads
can never establish the caller's identity. The existing D15.4 broker helper
receives an internally constructed verified-principal context only after
this ingress completes verification.

## Bounded protocol

- Accept only a single case-insensitive `Authorization` header containing
  a three-section JWT-shaped bearer token, plus
  `Content-Type: application/json`. Refuse duplicate Authorization keys,
  multiple content-types, `X-Serverless-Authorization`, malformed/large
  tokens, and malformed or oversized parsed JSON.
- The original D15.4 broker still accepts only HTTP `POST`, no query
  override, and exact JSON:
  `{"operation":"RESERVE_IDENTITY_SCHEMA_ONE_SLOT","protocolVersion":1}`.
  The broker chooses `reserve(1)`; no caller-provided amount, day, path,
  retry flag, UID or provider endpoint is accepted.
- Return exactly `{"status":"RESERVED","protocolVersion":1}` after one
  successful trusted quota reservation. Failure uses fixed redacted statuses:
  `DENIED`, `INVALID_REQUEST`, or `BUDGET_UNAVAILABLE`.
- Validated `exp` must be in the future. The external verifier must also
  check the token signature and expiry; local claim checks are
  defense-in-depth only.
- Do not return or log raw Authorization data, token verifier errors,
  Firestore exceptions, quota document IDs or service secrets. No retries.
  An ambiguous commit must stop the upstream provider request; spending a
  slot without a provider call is the conservative outcome.
- The pure module has a 256-byte **serialized parsed-body** guard only.
  This does NOT replace the **raw HTTP request-byte limit before parsing**
  that a future HTTP adapter must implement, along with strict JSON
  content type, bounded responses, HTTP status mapping and timeouts.
- Future callers must use a pinned broker URL and
  `GoogleAuth().getIdTokenClient(targetAudience)` or an equivalent
  documented keyless mechanism, prevent redirects, disable transport retries
  and accept only exact, successful broker acknowledgements. **That
  authenticated caller adapter is not implemented in D15.5.**

## Security limitations and deferred tests

The new broker code is **not wired** to the deployed diagnostic; the diagnostic
still cannot reserve through the broker. No broker runtime has been created,
no account granted Invoker and no Firestore permissions granted.

The Firestore transaction remains the original
`_internal/oddsPapiDailyDiagnosticBudget` counter shared by all manually
triggered provider probes, max **six reservations per UTC day**. A future
broker runtime account with a minimal database-scoped role would still have
document-data access to other paths in the same database; the Admin SDK
bypasses browser Firestore Security Rules. Do not claim true one-document IAM.
Compromise of the diagnostic runtime's existing OddsPapi secret would also
bypass client-side quota workflow; application cap is not a paid-provider
enforced billing cap.

Before any actual integration, independently review:
- Real Google library token verification behavior, especially audience,
  expiration, email claims, credentials and Cloud Run header forwarding.
- Cloud Run broker private IAM and caller-only service-level Invoker
  (no broad project Invoker role), no public access.
- Streaming raw-body size/JSON validation, 4xx/5xx mappings, Google Auth
  client automatic retries/redirects, network timeouts, and negative tests.
- An isolated live IAM denial simulation with separate owner approval,
  no provider call, and a documented rollback path.
- A separate minimum-permissions review for the broker Firestore role and
  independent security evaluation of protected research documents.
- Future Cloud Build, Artifact Registry, Cloud Run and Firestore charges.
  Historical €0.00 net billing does **not** guarantee zero further costs.

All authorization scopes are independent: owner approval for any further
code implementation/merge, production IAM grant, new service creation,
individual targeted Firebase deployment, activation of backend and frontend
flags, and **every real metered OddsPapi request**. Never project-wide deploy
from `main`: the live `oddsPapiAccountPreflight` may not be represented
there. The old market-audit revision remains untouched.

## Offline checks

Node 22 backend lint and unit regression suite should pass with this
module added to `functions/package.json`. The D12
`npm run preflight:evidence` must still return
`{"status":"BLOCKED","releaseReady":false}` with exit 2.
Frontend is unchanged. Synthetic mocks are not Google-issued tokens;
there is **no live invocation**.

## Official references

- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- https://docs.cloud.google.com/run/docs/securing/managing-access
- https://docs.cloud.google.com/docs/authentication/token-types
- https://firebase.google.com/docs/firestore/security/iam
- https://googleapis.dev/nodejs/google-auth-library/latest/classes/GoogleAuth.html
