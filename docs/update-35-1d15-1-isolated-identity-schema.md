# Update 35.1D15.1 — isolated manual identity-schema diagnostic

## Purpose and compatibility decision

D15's one-request \`PROVIDER_IDENTITY_SHAPE_ONLY\` payload cannot be returned
from the existing \`oddsPapiNbaMarketAudit\` callable: the installed frontend
requires \`diagnosticVersion: "35.1C-MANUAL"\` and eight ordered family rows.
The legacy market audit and the D14/D15 literal-false evidence flag stay
unchanged. **Do not activate D15 inside the legacy callable.**

D15.1 instead adds **a distinct callable** named
\`oddsPapiNbaIdentitySchemaDiagnostic\` and **a distinct developer-tool control**
named “Inspect NBA identity schema (disabled)”. This is a schema-only
observation, not bookmaker price verification, approved crosswalk, ESPN match,
research entry, betting signal or production evidence release.

## Two independent compile-time guards

- Backend: \`const NBA_IDENTITY_SCHEMA_DIAGNOSTIC_ENABLED = false;\` in
  \`functions/index.js\`. The new callable is registered but, when called,
  rejects before reading credentials, reserving quota, fetching OddsPapi or
  opening Firestore.
- Frontend: \`const NBA_IDENTITY_SCHEMA_UI_ENABLED = false;\` in \`index.html\`.
  The button carries the HTML \`disabled\` attribute and the JavaScript
  repeats that disabled state. It cannot call the new endpoint as shipped.

Neither switch reads browser input, configuration, environment variables or
remote flags. **Enabling one does not enable the other.** Enabling either
requires a separately reviewed code change and an explicit approval; even a
deployed enabled version may only be invoked with specific permission to spend
one provider request.

## Path when separately reviewed and enabled in the future

1. The named Cloud Function accepts a verified Firebase-authenticated owner
   with an empty callable data payload only. It rejects client-supplied fixture,
   participant, bookmaker, endpoint, ID and override parameters.
2. A credential availability precheck happens before spending quota.
3. The existing D15 runner transactionally reserves **one of the globally
   shared six upstream diagnostic requests per UTC day**, *before* the single
   fixed-origin \`GET /v4/odds-by-tournaments\` call. The provider host,
   tournament 132, exact \`betano.pt\`, verbosity, timeout, redirect policy and
   byte limit are fixed in backend code. No global market-catalogue fetch occurs.
4. The strict D13/D5 validator returns only bounded enum-coded counts and
   schema-compatibility flags. No fixture IDs, participant/player names,
   source URLs, raw prices, provider response or credentials are returned.
5. A successful report is cached for 15 minutes per process; concurrent owner
   invocations of the same runner deduplicate. Cache is **not a billing
   guarantee** across restarts or deployments. A failed provider call is
   never retried or refunded; a quota slot may have been consumed.
6. No OddsPapi polling, scheduler, Firestore research writes, team mapping
   approval or settlement action exists in this path.

The existing \`oddsPapiNbaMarketAudit\` callable continues to return the
original eight-family schema. The new UI accepts only
\`PROVIDER_IDENTITY_SHAPE_ONLY\`, the known status codes, strictly enumerated
reason counters, and explicit \`false\` release/mapping/research flags. Its
manual confirmation warns about the **possible metered request** and UTC cap.

## Offline validation and production release gates

Use Node.js 22. Run \`npm run lint --prefix functions\`,
\`npm test --prefix functions\`, and
\`node --test tests/research-dashboard.test.cjs\`.
All test data and HTTP responses are synthetic; these commands never call
OddsPapi. The release preflight command
\`npm run preflight:evidence --prefix functions\` is **expected to exit 2 with
\`BLOCKED\` and \`releaseReady:false\`**. Do not work around that gate.

Prior to a later separately authorized production trial:

1. Inspect the **current** main commit, draft PR and CI, present live Firebase
   inventory, the server UTC-day budget and actual OddsPapi plan/billing status.
2. Review the independently deployed \`oddsPapiAccountPreflight\` Function,
   which is **absent from main**. Never run a broad
   \`firebase deploy --only functions\` command or use \`--force\`.
3. Obtain explicit owner approval to deploy **only the new named callable**;
   do not redeploy the existing audit or research functions as a side effect.
   Confirm its region, secret binding and runtime service permissions first.
4. Separately obtain permission before enabling the diagnostic with a new
   reviewed code change; when explicitly approved, deploy *only* that named
   callable. The UI must remain disabled until a separate frontend approval.
5. Obtain a fresh and **distinct** approval before the owner manually clicks
   through the one-request cost warning. Do not fire it during deployment,
   unit tests or preflight. After a real response, capture **only** aggregate
   reason codes and do not assume identity mapping is verified.
6. If the backend reports an error, treat the provider reservation as possibly
   spent; inspect the evidence and budget before any authorized retry.
   Preserve the known-good live audit revision and backup; restoration has
   not been exercised in production.

No merge, deployment, production Firestore write, OddsPapi request, approval
or provider identity verification is authorized by this implementation.
