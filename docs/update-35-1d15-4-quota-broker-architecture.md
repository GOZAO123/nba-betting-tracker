# Update 35.1D15.4 — private quota broker, offline architecture only

> **DESIGN ONLY: NOT DEPLOYABLE.** No Cloud Run service, Firebase Function,
> IAM binding, Firestore database, schedule, secret, paid API request or production
> behavior change is authorized by this document or its pure test module.

## Verified baseline

- Main before this design: `ccc8cac4a1333dab73f28eb2877a4bb6d85eab72`.
- D15.2 deployed one new identity diagnostic with a dedicated runtime service
  account; production still has **15** Functions. Its backend flag
  `NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false` and frontend flag
  `NBA_IDENTITY_SCHEMA_UI_ENABLED = false` remain OFF.
- Original market audit revision `oddspapinbamarketaudit-00010-tof` was
  separately owner-verified at 100% traffic after the disabled deploy.
- The existing shared, transactional six-requests-per-UTC-day counter is
  `_internal/oddsPapiDailyDiagnosticBudget` in the `(default)` Firestore database.
- D12 production evidence release preflight remains intentionally `BLOCKED`.

## Architecture and trust boundary

1. Browser signs into the existing Firebase-authenticated, owner-only
   identity-schema callable. Browser cannot access the broker directly.
2. The diagnostic runtime (`nba-identity-schema`) has the already-approved
   secret-level OddsPapi accessor, **no direct Firestore IAM role**, and no
   automatic polling. On future explicit enablement it would request ONE
   quota slot through authenticated service-to-service HTTPS.
3. A NEW private reservation-only broker (not created) would accept only
   Google-signed service identity from the diagnostic account, with the
   correct ID-token audience and a service-specific `roles/run.invoker`
   binding. No `allUsers` or `allAuthenticatedUsers`. A body-supplied UID,
   service account email, claim, or header is NEVER authentication.
4. The broker has its OWN keyless runtime identity, no access to the OddsPapi
   secret, and candidate minimum Firestore transaction privileges. Its
   **only** data operation is one existing shared budget-record transaction.
5. On a verified commit the broker returns a strict one-slot acknowledgement.
   Only then may the diagnostic issue its already bounded, fixed-host,
   single manual provider call. Failed, ambiguous or timed-out reservations
   fail closed: no paid call and NO automatic retry.

      Browser (verified owner)
         -> existing disabled identity-schema callable [NO Firestore grant]
         -> future IAM-private quota broker [NO OddsPapi secret]
         -> existing shared Firestore budget document
         <- exact `RESERVED` acknowledgement
         -> optional fixed OddsPapi request, only with separate approval

Important: original 14 Functions keep their current quota code. Do NOT
introduce a new independent counter or change the historical daily ceiling.
Do not import `functions/index.js` into the broker: doing so registers and
initializes unrelated Firebase Functions. A future implementation may
extract and regression-test the shared quota transaction under a separate
review, while retaining the same Firestore document and six-slot ceiling.

## Protocol v1 — pure synthetic module, NOT an HTTP adapter

Future request: `POST`, empty query, exact JSON object:

```json
{"operation":"RESERVE_IDENTITY_SCHEMA_ONE_SLOT","protocolVersion":1}
```

Future success body after one verified reservation:

```json
{"status":"RESERVED","protocolVersion":1}
```

- No client-supplied amount, provider endpoint, bookmaker, UTC date, retry,
  UID, request ID, Firestore path or credentials. Broker fixes amount to 1.
- Fixed failure states: `DENIED`, `INVALID_REQUEST`, `BUDGET_UNAVAILABLE`.
  A production HTTP adapter will need explicit status-code mapping,
  request-byte limits, timeouts, content-type checks, trusted token
  verification and safe logging; none is implemented here.
- The caller must validate the WHOLE success body, not merely HTTP 200.
- The pure `functions/offline-identity-quota-broker.js` takes injected
  `verifyCaller` and `reserve` adapters. In production those MUST receive
  a cryptographically verified caller identity from a trusted transport
  context, never copy assertions from the request object or arbitrary
  HTTP headers. Offline synthetic verification does not prove Cloud IAM.
- A timeout *after* a successful commit may consume one slot without
  permitting a provider request. Conservatively losing a slot is safer
  than issuing an extra paid request. No broker HTTP retries.

## IAM, residual exposure and cost (NOT approved)

| Actor | Candidate access | Forbidden / concern |
|---|---|---|
| Identity-schema runtime | Keep secret-specific accessor; future `roles/run.invoker` on broker only | No new Firestore IAM, no project Editor/Owner |
| Future broker runtime | After separate approval: candidate database-scoped `datastore.databases.get`, `datastore.entities.get`, `datastore.entities.create`, `datastore.entities.update` | No provider secret or broad datastore.user; permissions still cover other documents in default database |
| Browser | Existing Firebase auth for diagnostic UI only | No broker invocation, no identity override |

**Residual limitation:** even the candidate four-permission broker role is
NOT one-document IAM isolation. Firestore Admin SDK bypasses browser Security
Rules. A compromised broker could read or create/update other data allowed
by those IAM permissions. A broker can reduce direct privilege exposure
from the externally reachable diagnostic, but cannot eliminate this risk.
Actual IAM policy, verified-token extraction, Firestore SDK requirements,
broker threat model and production denial testing require another review.

The existing diagnostic runtime has access to the OddsPapi secret. A
runtime compromise could bypass application-level quota logic entirely;
the six-request limit is **not** a provider-enforced spending cap.

A new service would add Cloud Build, Artifact Registry, Cloud Run and
Firestore activity with possible fees. Historical €0.00 net billing does
not guarantee a free implementation. A separate Firestore database would
also complicate the **shared** quota and may have separate billing.

## Test and release gates

- Offline tests cover wrong caller, verifier failure, spoofed identity,
  unexpected methods/data, strict one-slot reservation, missing dependency,
  Firestore denial, malformed receipt, strict acknowledgement, six-slot
  ceiling, and proof that the module is not imported by deployed Functions.
- CI must run syntax and all backend regressions; frontend remains
  unchanged. D12 `preflight:evidence` must remain `BLOCKED`.
- Tests do NOT test real Google-issued ID tokens, actual IAM, HTTP routing,
  Firestore permissions, payment limits, or cloud operation. Later work
  must test token audience, browser denial, cloud principal verification,
  concurrency and ambiguous commits before any real integration.
- Approval is **separate** for actual broker implementation, a new runtime
  service account/role grants, narrowly scoped production deployment,
  enabling either diagnostic flag, and EACH real paid OddsPapi request.
- Do not merge this draft PR without owner authorization. Do not change
  existing audits, ledger, Firebase rules, Cloud Run traffic or older PRs.

## Official design references (checked 18 November 2026)

- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- https://docs.cloud.google.com/functions/docs/securing/authenticating
- https://docs.cloud.google.com/run/docs/securing/managing-access
- https://firebase.google.com/docs/firestore/security/iam
- https://firebase.google.com/docs/functions/faq-and-troubleshooting
