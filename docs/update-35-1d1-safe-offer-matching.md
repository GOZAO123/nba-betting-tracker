# Update 35.1D1 — Offline safe offer matching and line-review gate

**Status:** Draft / offline only. Owner approval required to merge. No Firebase deployment, live API request, user-facing change or capture is part of this update.

## Verified starting point
On 16 November 2026 at 23:31 Lisbon the owner-authorized manual audit successfully joined the official global OddsPapi catalogue with NBA tournament 132, exact `betano.pt`: 248 eligible full-game/OT catalogue IDs; 831 matched active market objects and 1,512 active named provider price entries across all eight prop families. **Zero** entries were explicitly `mainLine: true`. Those are provider observations, not ESPN-verified athletes or independently verified Betano Portugal offers. The existing audit deliberately returns aggregate counts and does not preserve original payloads, so no real player/line can be reconstructed from its screenshot.

## Narrow implementation
The pure function `inspectOfflineNbaOffers` in `functions/offer-matching.js` consumes *injected*, synthetic or separately obtained, validated **one-provider-fixture** data: official catalogue, OddsPapi fixture, an ESPN event assertion, an explicit reviewed provider-participant → ESPN-team bridge, both ESPN team-roster assertions, a selected provider player ID and (optionally) an independently reviewed player-ID bridge. It never performs HTTP, Firebase calls, state changes or logging of raw user/provider data.

1. Require exact OddsPapi sport **11**, NBA tournament **132**, scheduled status **0**, two different provider participants, an upcoming fixture (>5min, ≤72h), exact `betano.pt` bookmaker with active, non-suspended markets, and an ESPN event assertion with numeric ID, `STATUS_SCHEDULED`, two distinct ESPN team IDs and start difference no greater than five minutes.
2. Fail closed unless the reviewed team-ID bridge maps **both** provider participants to **both** ESPN event teams, and both official ESPN roster assertions are present with nonduplicate numeric athlete IDs. Roster displays are compared using strict Unicode NFC and collapsed whitespace, **without fuzzy matching, diacritic deletion or name-only identity promotion**. One exact uniquely matching name is a candidate for *manual identity review* only. An optional player-ID bridge is cross-checked against that roster athlete but never treated as authenticated merely because a caller supplied it.
3. Reuse the existing catalogue matcher (`officialCatalogueMap`), its global duplicate market-ID quarantine, eight fixed full-game market names, exact `period === 'result'`, numeric half-point lines and exact canonical Over/Under outcome IDs. Keep the selected handicap in the **internal** map only; the live aggregate audit response stays unchanged.
4. For one provider player ID, require both active canonical Over/Under entries to agree on exact player display name, have finite decimal prices and plausible ISO-with-timezone change timestamps. Classify pairs older than 15 min separately; invalidate future timestamps. Detect duplicate family/line mapping rather than assuming it is unique. `mainLine` is explicit only when **both** sides say `true`; zero flags require line review and multiple flagged lines are ambiguous. A single explicitly flagged line is still **review required**, not captured or sportsbook-confirmed.
5. Return only fixed-vocabulary dispositions and aggregate family counts, **never** player names, provider or ESPN IDs, handicaps, prices, bookmaker URLs, secrets or purported verified bookmaker offers. `autoLineSelected`, `captureAllowed`, `bookmakerVerified` are **always false**. The new helper is not imported by any live Cloud Function or browser code.

## Limits and future trust boundary
All ESPN event and roster inputs and review bridges are **untrusted assertions** in this offline component. In a later, separately reviewed milestone, a trusted server-owned adapter must obtain ESPN event/roster evidence, establish non-spoofable participant/team crosswalk provenance, and require an independently verified bookmaker selection before proposing any trusted pre-tip-off capture. Never expose this function as a callable that accepts browser-supplied identity proof.

The provider's documented `GET /v4/markets` and `GET /v4/odds-by-tournaments` schemas define separate fixture participants, canonical market/outcome IDs, per-player odds and `mainLine` flags:
- https://oddspapi.io/us/docs/get-markets
- https://oddspapi.io/en/docs/get-odds-by-tournaments

## Review and validation
- 15 deterministic synthetic offline tests covering event/team/roster mismatches, ambiguous names, optional reviewed bridge mismatches, duplicate catalogue IDs and line definitions, stale/future quotes, zero/partial/one/multiple main flags, wrong bookmaker and privacy/no-network wiring.
- Existing backend CI syntax, settlement, ESPN identity, diagnostic quota and catalogue tests must remain green.
- Zero new billable calls, no change to six-per-UTC-day guard, no schema/capture/Firestore writes, no automatic OddsPapi polling or model adjustment.
- Owner must explicitly approve PR merge; production deployment, future ESPN adapters and manually requested OddsPapi data collection require *separate* approval and live verification.