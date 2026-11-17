# Update 35.1D2 — Server-sourced ESPN evidence adapter (offline, review only)

**Status:** Draft only. No Firebase deployment, external API calls, Firestore writes, browser change or capture path is authorized.

## Scope and trust boundary
The previously merged 35.1D1 helper consumes injected ESPN event/roster *assertions*. Update 35.1D2 adds a separate asynchronous `inspectWithServerEspnEvidence` helper whose **only request data** are separately obtained provider catalogue, one provider fixture and provider player ID. It rejects any input that tries to supply an ESPN event ID, roster/team mapping, reviewed athlete bridge or extra proof fields.

A **future trusted server-only caller** must supply:
- `fetchEspn(path)`, implemented using the existing fixed-origin backend ESPN transport, **not** caller-controlled URLs, with timeout/byte limits.
- `getReviewedTeamBridge({fixtureId,participant1Id,participant2Id})`, backed by owner-reviewed, authenticated **server-side** mapping of the two OddsPapi participant IDs to two ESPN NBA team IDs. The helper does not create that mapping and **must not** infer it from player names, team names, timestamps alone or a client-supplied assertion.
- A trusted server-clock `now` in milliseconds.

Before any ESPN read, reject malformed/oversized provider catalogue and market lists, then verify NBA sport 11 / tournament 132, scheduled fixture status, active exact `betano.pt`, two distinct participants and a start 5 minutes to 72 hours in the future. Reject incomplete/duplicated/incorrect reviewed team mappings without network requests. Derive the ESPN scoreboard date from provider tipoff using **America/New_York** NBA calendar days, like the existing trusted research capture route. Fetch **at most one scoreboard and two unique team rosters** (3 ESPN requests maximum) *only if a future owner-authorized caller explicitly invokes the function*. Never query ESPN by browser-supplied event ID or fetch player game logs.

Select **exactly one** upcoming ESPN regular-season event with status `pre`, matching both explicitly mapped ESPN team IDs and tipoff within five minutes. Reject missing, duplicate, in-progress, postseason or contradictory evidence. Verify roster team IDs and team display names against that ESPN scoreboard; flatten ESPN's grouped athlete items, cap and deduplicate athlete IDs and refuse incomplete or crossed rosters. Only then feed normalized evidence into the existing 35.1D1 offer matcher. Names are still *candidate only*, never an automatic provider-player/ESPN-athlete identity promotion.

## Always prohibited
No Firebase callable or browser import is added. No OddsPapi request, polling, model update, bookmaker quote validation, automatic main-line selection, confidence claim, research capture or Firestore write is introduced. Preserve `captureAllowed:false`, `autoLineSelected:false`, `bookmakerVerified:false` in every output. All error codes are fixed and do not reveal ESPN or provider payloads, player IDs, names or decimal prices.

**Security boundary:** injected `fetchEspn` and `getReviewedTeamBridge` are **synthetic test doubles in this PR**. An insecure future caller could fake them; this library does not independently attest to the origin of injected functions. The next milestone must establish a server-controlled crosswalk with provenance and integrate the fixed-host ESPN transport under explicit authorization, then validate schema against live fixtures without paid OddsPapi requests unless separately approved.

## Acceptance and tests
- 19 synthetic Node.js tests: valid three-read evidence flow; browser proof injection refusal; malformed inputs and ESPN sources; bridge failure and conflicts; wrong provider book/league/timing; missing/duplicate/unexpected ESPN events; scoreboard outages; roster fetch failures and early exit; wrong team names; ESPN roster grouping, duplicate player IDs and ambiguous cross-team names; unflagged lines remain unselected; New York calendar-day roll-over; no live callable or network code.
- Run full Node 22 backend syntax and regression tests in CI; verify that `functions/index.js`, auth, Firestore rules, odds reservations, all deployed functions and frontend remain untouched.
- Owner must explicitly approve **only** this draft PR for merge. Any future Firebase release or paid upstream odds call requires a separate, explicit approval.
