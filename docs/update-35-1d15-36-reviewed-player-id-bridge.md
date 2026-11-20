# Update 35.1D15.36 — Offline reviewed OddsPapi ↔ ESPN player-ID bridge

**Status: DRAFT / OFFLINE ONLY. No player mappings activated, no new OddsPapi request, no Firebase deployment, no research capture.**

## Why this milestone is necessary

On 20 November 2026 the owner made **one specifically approved** manual OddsPapi player-props preview and received 158 active, provider-attributed selections for Atlanta Hawks vs Charlotte Hornets. The UI then matched the formatted name `Daniels, Dyson` to ESPN's `Dyson Daniels` on Atlanta Hawks, displaying an ESPN athlete ID. However, that **name-only roster match did not preserve or independently review the actual OddsPapi player ID**, event ID or team participant IDs. The primary-market flags in the visible sample were all `Not flagged`. These screenshots do not establish a real source-to-ESPN player-ID link or primary line. **Do not manufacture a Dyson Daniels mapping from them.**

Existing backend components already distinguish provider candidate names from true identifiers (`functions/offer-matching.js`) and require a manual, two-source, full fixture/participant crosswalk (`functions/offer-team-crosswalk.js`). Its server-owned real-data manifest is empty. This update adds a matching **player-level approval gate** so that future independent evidence can be reviewed and introduced only through trusted backend sources, without silently accepting a browser's name comparison.

## What the new module does

`functions/offer-player-crosswalk.js` exports `makeReviewedPlayerBridgeResolver(records, clock)` and a default-denying `getReviewedPlayerBridge` constructed from an **empty server manifest**. The module has no provider calls, ESPN fetches, secret access, Firestore, timer, production callable, browser interface, logging or data writes.

Each backend-owned manually reviewed record requires exactly:

- `schemaVersion:1`, `reviewMethod:MANUAL_TWO_SOURCE_PLAYER_ID_REVIEW`, `reviewStatus:APPROVED` or `REVOKED`, review and expiry timestamps;
- A **provider side** consisting of the exact NBA fixture ID and start, provider participant ID, provider player ID, original provider player name, original OddsPapi manual source reference, and SHA-256 quote digest;
- An **ESPN side** consisting of the independently reviewed ESPN event ID, team ID, athlete ID, ESPN athlete name and source evidence reference.

The resolver only accepts an **already supplied backend-frozen** unreviewed quote, the **existing approved** fixture/team/event bridge and a **backend-obtained** ESPN roster. It requires exact fixture/source/player/digest/timestamp matches, two distinct matched team/participant IDs, matching event/team/athlete IDs, matching original provider and ESPN names **within their respective sources**, and a valid fresh review well before tipoff. It rejects duplicates, ambiguous rosters, conflicting provider↔ESPN mapping anywhere in the manifest, mixed approval/revocation across separate source references, malformed metadata, stale/future decisions and browser-like extra fields.

A successful synthetic review returns only the provider player ID, ESPN athlete/team IDs, the explicit status `REVIEW_ASSERTION_ONLY` and false bookmaker-verification/auto-line-selection/capture permissions. It **does not** turn the asserted pair into a verified bookmaker offer, automatically select a market line, authorize a protected research record, or claim independently authenticated ESPN/player-source provenance. Existing `offer-matching.js` can consume the three ID fields under its current *candidate-only* semantics, with no production wiring changed.

## Important trust limitations

Both input source references and the quote digest are **consistency checks, not cryptographic authenticity signatures**. The resolver cannot verify that future source rows truly originated from OddsPapi, the independent ESPN API, or a genuine manual reviewer. The provider snapshot and ESPN roster must be acquired by separately approved **trusted** backend methods; never pass client-authored or arbitrary quote/roster data through a public endpoint and call it verified. An approved row is merely an offline review assertion. The current production manifest must remain empty until genuine, independently recorded cross-source identifiers are available.

The existing `functions/offer-espn-evidence.js` performs bounded ESPN scoreboard/roster verification when its upstream trusted fixture/team bridge is available; this PR does **not** enable those calls, alter the frontend, or integrate the new resolver. The test suite uses only synthetic provider and ESPN IDs. It does not use the real player name or athlete ID from a screenshot as a source record.

## Tests and next real-world evidence gate

Node 22 focused tests cover empty manifest, exact ID approval, compatibility with existing candidate-only matcher, wrong provider and ESPN IDs, mismatched team/event and fixture/source digest, spoofing/overrides, duplicate/expired/revoked/mixed-status rows, quote permission escalation and no production linkage. Run:

```sh
node --check functions/offer-player-crosswalk.js
node --check functions/offer-player-crosswalk.test.js
node --test functions/offer-player-crosswalk.test.js functions/offer-team-crosswalk.test.js functions/offer-matching.test.js
npm run lint --prefix functions
npm test --prefix functions
```

Only after a future **separately authorized** manual provider observation, secure backend custody of the original provider player ID + quote/receipt (not just a player name), and independently verified ESPN event/team/athlete IDs could a reviewer consider approving one real mapping. No extra OddsPapi call is authorized by this PR. Actual backend production capability, audited IAM/costs, target-only rollback, protected create-only quote storage and safe primary-line handling remain independently blocked.

**No new Firebase production changes, automatic polling, betting recommendations, paid API calls or ledger observations.** Preserve all 15 live Functions, especially the separately deployed preflight absent from source exports; never blanket-deploy.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
