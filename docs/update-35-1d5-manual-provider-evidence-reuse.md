# Update 35.1D5 — Reuse a manual OddsPapi response for minimal team-identity evidence (offline)

**Status:** Draft-only implementation; no production deployment, paid provider call, Firestore write, live ESPN read, browser UI, automatic polling, odds capture or new callable.

## Starting point

Update 35.1D4 established an offline strict provider/ESPN evidence and reviewed-team mapping gate, merged at main commit \`f6c6963bc71c3008b99f304c91e0b066f2e15ae6\`. The D3 reviewed manifest remains empty. The earlier 35.1C15 live audit retained aggregate counts, **not** raw provider fixture IDs; these cannot be reconstructed from old logs, caches or screenshots.

The existing manual owner-only \`oddsPapiNbaMarketAudit\` runner already fetches the NBA tournament 132 league response from OddsPapi. D5 adds an **optional injection point** that can reuse that same response **when** an authorized manual fetch is independently approved in a future production integration. It cannot run on its own.

## Exact implementation

- \`functions/provider-evidence-acquisition.js\`: pure \`extractManualProviderIdentityBatch(payload,capturedAt)\` consumes an already-fetched provider response. It accepts bounded array/\`data\`/\`fixtures\` envelopes of up to 250 fixtures, rejects malformed timestamps, quarantines all duplicate fixture IDs and refuses first-N truncation when more than 64 identity records would be retained.
- Only exact NBA sport 11 / tournament 132, scheduled status ID 0, two distinct numeric provider participant IDs, explicit fixture ID, future kickoff (>5min, ≤72h), and active unsuspended \`betano.pt\` bookmaker market containers qualify. Missing source fields **fail closed**; team or player names are not used as substitutes.
- Reuses D4 \`captureProviderFixture\` to retain only fixture ID, kickoff, provider participant IDs, a unique opaque source receipt reference and server-derived capturedAt, plus SHA-256 record fingerprint. The batch's status is **UNREVIEWED_PROVIDER_EVIDENCE**; no ESPN event/team identity, reviewer approval or bookmaker confirmation is asserted. The helper cannot prove real provider origin independently; only a backend-supplied actual fetch and an authenticated write can do so in a later approved stage.
- \`functions/league-market-audit-runner.js\`: adds optional \`onProviderEvidence\` injection, **default null**. Only after a successfully validated already-paid-stage manual league response does it pass the sanitized evidence batch to that callback. The callback **never** receives raw provider odds/players/market lines, and no record is returned to the callable's client. Cached repeats do not rerun extraction or the callback, and concurrent invocations share one fetch and one callback. Optional callback failure does not invalidate the established aggregate audit, emit sensitive errors, or trigger an additional request. The runner does not claim evidence was stored from success alone.
- \`functions/index.js\` is **unchanged**, and does not supply the optional callback. Therefore current production has **zero evidence collection or storage side effects**. No additional network path, new scheduled task, browser input parameter, Firestore rule, diagnostic quota or separate OddsPapi reservation is introduced.
- No ESPN lookup or guessing by team name. No main-line selection: zero explicit main-line flags in the previous live audit remains unresolved; \`autoLineSelected:false\`, \`captureAllowed:false\`, and \`bookmakerVerified:false\` in downstream D1–D4 logic.

## Security and practical limits

The optional callback is a server-trust boundary, **not** authorization in itself. A future separately approved production adapter must authenticate the Firebase owner, prove the response was fetched by the fixed-host/backend-controlled OddsPapi transport after a reserved user-approved manual request, create immutable source receipts, and persist only normalized evidence via least-privilege server operations. Review candidates still require genuine independent ESPN event/team observations and human validation of the exact 2×2 participant↔team pairing. Timestamp coincidence does not prove the pairing.

In the future approved rollout, an evidence sink must provide transactional persistence, appropriate retention, deduplication, revocation-safe retrieval and explicit success/failure monitoring, without revealing raw provider IDs, player names, prices or secrets in logs/frontend. Production data schema and functionality must be reviewed separately.

Provider response schema caveat: D4 requires explicit \`sportId\`, \`tournamentId\` and \`statusId\` as well as both numeric participant IDs. If an actual OddsPapi league response omits any of them, the new extractor will return **zero matching records**. Do not fill in missing fields from the requested URL or infer IDs from names. Verify actual schema with a separately approved live manual request, not an unapproved probe. Absence of captured evidence must not prompt automatic retries.

## Validation / approval gates

- Node.js 22 \`npm run lint --prefix functions\` and \`npm test --prefix functions\`: all previous 179 tests + 18 D5 synthetic tests should pass.
- Validate malformed/missing IDs, exact book, duplicate IDs, near tipoff, 72-hour bounds, overlarge arrays and selection caps, no raw odds/secret leakage, no unauthorized side effects, no added paid calls, cache/concurrency reuse, sink failures and disabled production wiring.
- Review exact 5-file diff: new extractor, new tests, existing runner, \`functions/package.json\` and this document. No \`functions/index.js\`, frontend, Firestore or dependency changes.
- Keep PR draft and unmerged until separate owner approval. Require distinct user approval for any future Firebase deployment, live ESPN/OddsPapi request or Firestore write. Maintain six-reserved-requests-per-UTC-day guard and never deploy all functions while preflight is held in PR #17.

**Separate research item:** ESPN-only broader player/team cohort testing to evaluate whether the experimental AST signal generalizes; D5 does not affect models, captures or outcomes.
