# Update 35.1D15.8 — Private quota broker HTTP boundary (staged, not deployed)

> **OFFLINE / DRAFT / UNWIRED.** No Firebase deployment, Cloud Run service,
> IAM role binding, Firestore mutation, signed Google token acquisition,
> OddsPapi request, secret access, or automatic polling is authorized.
> Do not merge this PR or deploy anything without separate owner approval.

## Verified starting point and objective

- GitHub main was `2effa9b12c03e3ab551da2e1d62d74243a7ed08d`
  after owner-approved D15.7. The original **15 deployed Functions** were
  owner-verified after D15.2; this branch does not read or alter production.
- The deployed identity-schema diagnostic remains **disabled** in
  `functions/index.js`, behind literal
  `NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false`. The backend evidence
  integration gate is also literal false, and the frontend UI stays off.
- The existing `oddsPapiNbaMarketAudit` callable and its known-good Cloud
  Run revision must be preserved. The production `oddsPapiAccountPreflight`
  callable is deployed but its source may be absent from GitHub main;
  **never deploy all functions from this checkout**.
- We already observed eight supported player-prop families in the
  owner-approved 16 November 2026 live market audit. The next **paid**
  diagnostic should identify real provider fixture/player schema, not
  redundantly refresh aggregate catalogue counts.
- The provider budget is the **existing shared Firestore document**
  `_internal/oddsPapiDailyDiagnosticBudget` in the default database,
  max **6 upstream requests per UTC day**; it is not an OddsPapi-enforced
  spending cap and may consume slots without upstream calls.

## D15.8 scope: three backend modules, one regression module, this runbook, CI wiring

1. `functions/offline-identity-quota-google-verify.js`:
   real **Google OAuth2Client.verifyIdToken({idToken,audience}) API path**,
   lazily invoked. The method verifies signing certificates, token issuer,
   expiration and exact audience; it returns the verified ticket payload.
   Our D15.5 ingress independently demands the exact permitted **service
   account email**, `email_verified === true`, `aud`, `iss`,
   `sub` and `exp`. Do **not** merely decode JWT text.
2. `functions/offline-identity-quota-firestore-reserve.js`:
   a transaction on the **same budget doc and same UTC-day ceiling**
   as the production legacy audit. Exact one-slot-only reservation;
   uses `db.runTransaction`, `tx.get`, `tx.set`, and
   `{maxAttempts:5}`. Rejects corrupt same-day counters, exhausted
   budget, clock/data/permission errors and ambiguous commits.
   No research ledger paths, provider secrets or client-selectable
   document IDs. A future runtime must have an explicitly reviewed,
   least-privileged Firestore IAM role and project permissions.
3. `functions/offline-identity-quota-http-handler.js`:
   unregistered **native Node HTTP request handler**, intended for a
   private Cloud Run service—not a Firebase `onRequest` route. It
   receives an unparsed `IncomingMessage` stream and limits **raw
   incoming bytes to 256 before parsing**. Accepts exactly POST
   `/`, the canonical one-slot JSON body, a single regular
   `Authorization: Bearer ID_TOKEN` and exact
   `Content-Type: application/json`. Rejects query strings,
   alternate `X-Serverless-Authorization`, duplicate relevant headers,
   mismatched Content-Length, content-length/transfer-encoding
   ambiguity, oversized/malformed bodies and user-selected amounts.
   The handler delegates to the previously tested D15.5 ingress and
   returns fixed JSON statuses: `200 RESERVED`, `403 DENIED`,
   `400 INVALID_REQUEST`, or `503 BUDGET_UNAVAILABLE`, with
   `Cache-Control: no-store`. A single six-second deadline covers
   request streaming, token validation and Firestore transaction;
   an ambiguous post-commit timeout fails closed. The underlying
   Firestore transaction might finish after response timeout; never
   automatically retry it.
4. `functions/offline-identity-quota-http-handler.test.js`:
   synthetic no-network tests of verifier API wiring, bad tokens,
   raw streaming and byte cap, malformed requests/duplicate headers,
   ID spoofing, good reservation, six-slot exhaustion across concurrent
   simulated requests, corrupt counters, UTC-day reset, and deadlines.
5. This document sets the IAM/cost/security boundaries.
6. `functions/package.json` adds only the offline test and syntax
   lint commands. No dependency changes and no production imports.

## Actual Google authentication requirements

The future Cloud Run service must require **authentication** and grant
`roles/run.invoker` at the broker **service** scope to **only** the
existing dedicated `nba-identity-schema` runtime identity, not
`allUsers`, `allAuthenticatedUsers` or other project principals.
The diagnostic obtains a keyless Google-signed ID token with the broker's
**exact** `https://*.run.app` URL as audience, using its dedicated
runtime service account. Do not use service-account JSON key files.
The broker-side verifier must use the official Google authentication
library and independently verify the same signed JWT. Cloud Run strips
the signature from `X-Serverless-Authorization` before forwarding to
the container, so D15.8 requires standard `Authorization` only.

**Dependency gate:** this PR does not install `google-auth-library` or
add a lockfile. The future deployment must review its Node22-compatible,
pinned direct version, transitive security advisories, deterministic
dependency lockfile and network/certificate retrieval behavior, then
test real signed tokens through IAM. Synthetic test tickets are **not**
live cryptographic proof; offline CI has no Google credentials or network.

## Privacy / IAM and cost blockers (not approved)

- Even an IAM custom role restricted to Firestore
  `datastore.databases.get`, `datastore.entities.get`,
  `datastore.entities.create`, and
  `datastore.entities.update` is **database-scoped, not single-document
  scoped**. A compromised broker could access other permitted documents
  in default Firestore. Firebase browser Security Rules do not apply to
  the Admin SDK. Do not grant this role until the owner approves a
  residual-risk assessment or a safer isolation design.
- The broker runtime must have **no OddsPapi secret access**, no
  blanket project-level `Editor` and no browser invocation.
  The diagnostic runtime already has secret-specific OddsPapi access;
  a compromised diagnostic can bypass application quota controls.
- New Cloud Run services, Artifact Registry artifacts, Cloud Build,
  authentication verification and Firestore transactions can incur
  charges. Historical €0 net billing does not guarantee future €0.
- The pure handler is **not a runnable HTTP service**: it must be
  hosted only by a separately reviewed native streaming Node server,
  not behind Express/Firebase middleware that pre-buffers unbounded
  bodies. Check Cloud Run request buffering behavior and ingress
  admission controls before production deployment. The handler's
  timeout does not forcibly interrupt an underlying Google certificate
  request or Firestore transaction; it prevents issuing a success ACK.
- The current handler has a strict fixed-body protocol only, not a
  general HTTP API. No health/probe route, shared secret, user UID or
  implicit retry should be added without separate security review.

## Proposed provider-free validation gates, requiring new owner approvals

1. Review D15.8 GitHub draft diff, Node22 syntax and all backend tests;
   preserve original ledger and D12 `preflight:evidence` **BLOCKED**.
2. Pin and security-audit the real Google auth library and backend
   dependency lockfile, review native HTTP server entrypoint, and
   verify service authentication/configuration against actual Google
   Cloud documentation—still offline and without IAM changes.
3. Review minimum Firestore permissions and the privacy impact of
   database-wide IAM; compare safer alternatives if unacceptable.
4. **Only after explicit owner approval**, create a keyless dedicated
   broker runtime identity, private Cloud Run service and scoped
   service-only Invoker binding. Require a separate, approved broker
   IAM grant, targeted deploy, rollback plan and billing inspection.
5. Perform a strictly **provider-free** live rehearsal using the exact
   principal, wrong audience, denied browser, denied other service
   accounts, one-slot reservation and no seventh-slot behaviour.
   Any successful real reservation changes the internal daily counter,
   so its test must also receive separate explicit approval.
6. Separately approve enabling the diagnostic and **one** manually
   triggered one-upstream-request identity-schema observation. Never
   run it automatically or assume verified bookmaker odds/ESPN matches.
7. Only after identity evidence warrants it, consider a new paid,
   two-upstream-request market audit of eight prop families.

## Official references

- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- https://docs.cloud.google.com/run/docs/securing/managing-access
- https://googleapis.dev/nodejs/google-auth-library/latest/classes/OAuth2Client.html
- https://firebase.google.com/docs/firestore/security/iam
