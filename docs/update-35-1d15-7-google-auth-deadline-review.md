# Update 35.1D15.7 — GoogleAuth adapter and operation-wide deadline (offline)

> **NOT DEPLOYED OR ENABLED.** This review does not authorize OAuth/metadata
> requests, Cloud Run creation, Firestore IAM changes, secret access, paid
> OddsPapi calls, diagnostic activation, or merging without owner approval.

## Verified baseline

GitHub `main` at `f142a6e43f7d0ae1c70304d3f28b2a612a2c3d2a`,
with no later commits at branch creation. D15.6's outbound broker client
was already merged as an **inert, offline** module. The production
`oddsPapiNbaIdentitySchemaDiagnostic` callable is still hard-disabled at
the backend and UI. The original market audit and 15 deployed functions
were owner-verified previously; none is changed by this branch. The D12
general evidence release preflight remains intentionally **BLOCKED**.

## D15.7 changes, exactly five files

1. New `functions/offline-identity-quota-google-auth.js`:
   `makeOfflineGoogleIdTokenClientFactory({loadGoogleAuth})`.
   Lazily loads the official `google-auth-library` GoogleAuth constructor
   **only when the disconnected factory is actually invoked**; uses
   `new GoogleAuth()` with no JSON key, explicit credentials or scopes.
   Calls `getIdTokenClient(trustedAudience)`, checks its
   `getRequestHeaders()` API and redacts acquisition errors.
2. Existing, previously offline `functions/offline-identity-quota-caller.js`:
   start **one six-second AbortSignal before** token-client creation.
   The same deadline covers the token-client promise, header refresh,
   HTTPS fetch and streamed acknowledgement. When the deadline fires,
   return a fixed failure immediately, even if a non-abort-aware
   GoogleAuth promise settles later. The code checks deadline state
   before beginning a subsequent stage; a late token cannot start HTTP.
   The shared AbortSignal is also given to the single-shot fetch.
   A stalled response reader is cancelled when the signal aborts.
3. Existing `functions/offline-identity-quota-caller.test.js`: adjust
   its pre-aborted-signal case to require **zero** token acquisition and
   **zero** HTTP calls, a stronger security invariant.
4. New `functions/offline-identity-quota-google-auth.test.js`: 11
   synthetic tests for deferred load, real GoogleAuth API shape,
   redacted loader errors, abort during client discovery or header
   refresh, late results, pending fetch, pending body, invalid
   signals, single-signal success and production isolation.
5. `functions/package.json`: add only the new files to syntax lint
   and test scripts; no dependency, runtime entrypoint or lockfile change.

## Real Google Cloud requirements and limitations

Google Cloud's documented Node pattern is:

```js
const {GoogleAuth} = require("google-auth-library");
const auth = new GoogleAuth();
const client = await auth.getIdTokenClient(targetAudience);
const headers = await client.getRequestHeaders(targetAudience);
```

The future service must run under the previously verified
`nba-identity-schema` **keyless runtime service account**, and use
the *broker's* exact canonical `https://*.run.app` service URL
as the audience. The future broker must require Cloud Run authenticated
invocation, allow only that service account at the **service** level
(`roles/run.invoker`), and verify the token's signature, issuer,
audience, expiry and expected principal inside its handler.

**No Google library is installed or imported at application startup**.
The future production integration must add an explicit, reviewed
`google-auth-library` dependency and lockfile, verify ADC resolves to
the correct metadata-backed identity, and test live signed ID token
handling in an owner-approved, provider-free rehearsal. The offline CI
loads *synthetic* GoogleAuth substitutes: it does not exercise Google
metadata, validate signatures, prove IAM, or authorize a real call.
No service-account key file must be created or downloaded.

The whole-operation deadline gives an **application-visible six-second
upper bound for these awaited stages**. GoogleAuth credential/token
acquisition itself has no injected AbortSignal through this API:
the underlying library operation may continue after our caller returns,
but the caller will not send broker HTTP when that late stage finishes.
The HTTP call receives the AbortSignal and is single-shot; HTTP 401/403/429,
redirects and ambiguous acknowledgements do not trigger retry. Do not
use an authenticated library `request()` helper that can transparently
retry. Timeout after broker commit can waste one reserved slot; it
must never authorize an unpaid/unreserved provider request.

**Residual risk:** a compromised diagnostic runtime still has access to
the existing OddsPapi secret and can bypass application-level checks.
A future broker's database-scoped Firestore permissions would permit
data operations on more than the single budget document. Neither client
nor broker constitutes a provider-enforced spend cap.

## Future release gates (not included in this PR)

- Independent review of a real broker Cloud Run handler: raw request size
  limits **before JSON parsing**, signature verification library, safe
  HTTP status mapping, no public ingress, Cloud Run IAM policy and
  minimum database-scoped Firestore permissions.
- Independent review of authentic GoogleAuth class behavior (including
  credential discovery and metadata flow) and the dependency version.
- Check original 15 Functions, original audit revision, billing and
  the dedicated identity before authorizing **any** targeted deployment;
  do not deploy all functions because production includes
  `oddsPapiAccountPreflight`, whose source may not be in `main`.
- Separate owner approvals for merges, production IAM changes, Cloud Run
  creation, targeted Firebase deployment, diagnostic backend/UI
  activation, and **each** metered OddsPapi request.
- Preserve the existing shared six-upstream-requests-per-UTC-day Firestore
  transaction and fail closed on missing permissions. No polling.
- Test D12 release preflight remains `BLOCKED` with exit 2.

## Validation expectations

- Node 22 syntax tests and backend suite: expected **479/479**
  (468 existing + 11 new); no paid API calls or credentials.
- Frontend code is unchanged (last independently verified 106/106).
- Tests prove offline control-flow and failure invariants, **not**
  real Google Cloud auth or production safety.

## References

- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- https://docs.cloud.google.com/run/docs/securing/service-identity
- https://googleapis.dev/nodejs/google-auth-library/latest/classes/GoogleAuth.html
- https://googleapis.dev/nodejs/google-auth-library/latest/classes/IdTokenClient.html
- https://firebase.google.com/docs/firestore/security/iam
