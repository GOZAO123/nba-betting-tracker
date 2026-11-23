# Issue #97 / D20 — Offline fixed-origin ESPN acquisition to private source custody

**Stage:** offline-only, disabled/unwired. No live ESPN or OddsPapi HTTP
call was made in this milestone. No production Firebase deployment,
production Firestore write, IAM change, permit, paid OddsPapi request,
frontend change, caller-visible identity or automatic polling.

## Verified baseline

The owner fast-forwarded their Windows checkout to GitHub
`main` `a09f5f827ddf846b75a0af4537be36e6ec603bb5`, then
independently ran the complete Node.js 22 backend suite:
**686 tests / 686 passed / zero failed / zero skipped**.
This resolved the Windows LF/CRLF-only test assumptions from PR #114.

Existing `functions/index.js` has a working, authenticated
`ledgerGetEspn(path)` transport using
`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/`
with a 12-second timer. Its other ledger logic must stay untouched.
D19 introduced a private create-only storage primitive for allowlisted
ESPN scoreboard observations, but it had no source-specific fixed-host
acquisition and trusted attestation.

## D20 feature and trust boundaries

`functions/offline-fixed-espn-scoreboard-acquisition.js` provides
`makeOfflineFixedEspnScoreboardAcquisition({db,fetchImpl,now,makeSignal})`
with a single explicitly invoked
`captureForFixtureStart(startMs)` operation.

The factory is inert. The caller **must** inject a trusted backend HTTP
implementation, Admin Firestore handle and server clock. There is no
default global fetch, Firebase import, public callable, browser input,
automatic timer/schedule, API secret or external OddsPapi access.

The operation:

1. Accepts a **server-verified fixture start timestamp**, never a
   browser-selected host, URL, ESPN event, player or source ID. It
   rejects an invalid start, less than five minutes before tipoff
   or more than 72 hours in the future **before HTTP or Firestore**.
2. Derives the NBA day from `America/New_York`, exactly as the
   existing ledger scoreboard fetch does, and pins one endpoint:
   `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD`.
3. Makes at most **one explicit GET** with `Accept: application/json`,
   `redirect: error`, `cache: no-store`, an injected abort signal
   defaulting to 12 seconds. Never retries automatically.
4. Rejects failed HTTP, redirected or cross-origin response URLs,
   wrong JSON MIME type, malformed/missing byte stream,
   oversized Content-Length or more than 4 MiB streamed JSON
   (max 8,192 stream chunks). Parser failures return a fixed status.
5. Canonicalizes ESPN's UTC or offset-bearing event-date strings to
   `toISOString()` for the strict D19 custody format; this is an
   **explicit derived representation**, not a verbatim HTTP archive.
   Runs D19's strict all-or-nothing event/team sanitizer, never
   silently dropping same-time unrelated games, raw metadata,
   headers, stats, odds, or secret-like fields.
6. Requires **exactly one scheduled regular-season ESPN event**
   within five minutes of the trusted fixture start, without
   automatically matching provider team IDs to ESPN IDs.
7. Mints a server-private, fresh random 128-bit source reference
   and an opaque one-use in-memory attestation token, pinned to the
   allowlisted scoreboard's source, reference, server capture time
   and SHA-256 digest. Calls the unchanged D19 create-only custody
   adapter with this **backend-only capability**. No token, ID,
   digest, URLs or event data are returned to a browser; only
   `STORED`, a sanitized storage failure status or a fixed
   unavailable/invalid-start code.

**Source authenticity limitation:** this adapter only strengthens
source *custody and transport invariants* when its `fetchImpl` and
server clock are injected from a genuinely trusted fixed-origin
backend. A synthetic fetch function can still lie; merely hashing a
payload is not proof the genuine ESPN server supplied it. Tests
do not call the internet or validate an actual current ESPN response.
A separately approved backend integration and live ESPN-only schema
verification must precede treating this as independently sourced
evidence. It does not attest the origin of the separate OddsPapi
fixture receipt.

## Testing

Offline unit tests use a synthetic `fetchImpl` and in-memory
Admin-transaction stand-in, never global `fetch` or a paid API.
They exercise:

- Inert factory; exact host/path/GET options and New York
  calendar-day derivation near Lisbon midnight
- Strict fixture time window and no effect on invalid input
- Content-Type and streamed-byte limits, HTTP errors,
  cross-origin response URLs, redirects and malformed JSON
- ESPN date canonicalization, strict sanitation and no leaked
  raw response fields/secrets
- Exactly one nearby pregame regular-season event; duplicate
  or ambiguous event ID, multiple kickoff matches and wrong
  season/status cannot create custody records
- One-use internal attestation tied to the normalized snapshot,
  create-only private storage, status-only outputs, no retries
- No `functions/index.js` import or production Firebase changes

The existing D19 Firestore/Auth emulator cases continue to validate
actual browser GET/PATCH denial and backend create-only persistence.
All three GitHub workflows must remain green.

## Remaining release gates

These improvements do **not** create a trusted, deployed ESPN
callable or a real-game approval. Still required: authenticated
backend caller binding the independently obtained D17 OddsPapi
fixture receipt to this verified ESPN snapshot; protected
create-only source-binding provisioner; explicit manual 2×2
provider↔ESPN review; global journal/registry reconciliation and
safe emergency revocation; effective database-scoped runtime IAM;
provider subscription and costs, real provider fixture/team identity
shape, and targeted rollback.

**Each draft merge, live ESPN capture, Firebase deployment, IAM
change, provider permit or paid OddsPapi request requires separate
owner approval.** Keep the provider collector disabled.
