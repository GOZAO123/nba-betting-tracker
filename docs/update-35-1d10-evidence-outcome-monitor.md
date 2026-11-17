# Update 35.1D10 — Safe manual evidence outcome / readiness signals (offline)

**Status: draft-only; no production activation, paid requests, Firebase deployment, live Firestore operations or new client UI.**

## Problem / rationale

Merged main `01b9d77851ade27ca2c85dd9422f04aafc9b98b7` contains the fixed-origin offline D9 OddsPapi transport, D8 trusted in-memory receipt composition, D7 Admin-style storage adapter, D6 immutable evidence store and D5 opt-in provider identity extraction. **Production `functions/index.js` still does not supply a provider evidence sink.**

Before any separately approved live fetch, we must be able to establish whether the provider response actually contained the explicit fixture/participant identity fields required by D4/D5. Today the manual aggregate-only audit can report success even when optional evidence extraction yields zero records or a secure storage sink fails. Making more provider requests blindly would risk the six-upstream-reservations-per-UTC-day budget without supplying useful identity evidence.

## Narrow D10 change

`functions/league-market-audit-runner.js` now accepts a **disabled-by-default** backend callback `onEvidenceOutcome`. It can only be injected if `onProviderEvidence` also exists. It runs **once** after the same authorized manual league fetch, once the existing audit has produced a valid aggregate report, and never on unauthorized requests, failed catalogue/league calls, cached clicks or concurrent in-flight duplicates.

The callback receives exactly one frozen, allowlisted `{status}` value:

| Status | Meaning |
|---|---|
| `STORED` | Trusted storage adapter reported a new immutable write |
| `ALREADY_STORED` | Exact same immutable snapshot already present |
| `CONFLICT` | Same source reference has conflicting stored content |
| `DENIED` | Trusted source receipt was denied |
| `INVALID_BATCH` | Storage validation rejected the batch |
| `UNAVAILABLE` | Secure backend storage was unavailable |
| `NO_STORABLE_EVIDENCE` | Provider batch had no validated identity records or violated a bound; not a verified provider schema diagnosis |
| `EXTRACTION_FAILED` | Extractor raised an exception |
| `SINK_EXCEPTION` | Sink raised an exception |
| `SINK_RESULT_INVALID` | Sink supplied an unexpected or extra-field result |

No IDs, names, bookmaker odds, private credential, URLs, source timestamps, UID, provider errors or raw response are sent to the outcome callback. Unrecognized storage outcomes and extra fields are collapsed to `SINK_RESULT_INVALID`. Callback failure is silently isolated from the existing manual audit and never initiates retries.

`functions/manual-evidence-receipt.js` forwards an optional trusted `onEvidenceOutcome` injection to the existing owner-authenticated, quota-gated D8 runner. This allows a **future independently reviewed backend adapter** to count statuses or emit constrained diagnostics after genuine manual fetches. It does not add a server logger, Firestore write, cloud function, response property or browser access. Default production wiring remains off.

## Constraints and next steps

- The outcome is *an offline trusted adapter's report*, **not** cryptographic proof of provider authenticity or successful settlement, and not proof that the original bookmaker odds are correct. A `STORED` status cannot authorize D3 team mappings or selection of betting lines. Independent ESPN evidence and explicit 2×2 team-ID review are still mandatory.
- No automatic polling, extra OddsPapi call, retry, separate account check, new reservation, deployment or Firestore schema modification. User previously verified billing €0; this GitHub-only update incurs **zero incremental live metered API and Firebase operations**, but does not independently audit future account charges.
- Exact intended five-file diff: `functions/league-market-audit-runner.js`, `functions/manual-evidence-receipt.js`, new `functions/manual-evidence-outcome.test.js`, `functions/package.json`, this document. `functions/index.js`, `firestore.rules`, UI, and held draft PRs #16/#17 must remain untouched.
- Node 22 syntax/lint and all **284 existing +23 D10 synthetic** tests: storage status allowlist, no leakage, malformed statuses, exception isolation, cache/concurrency, blocked budget, missing IDs and D8 composition.
- **Separate owner approval** required to merge the D10 draft PR. Production wiring, monitoring/logging, actual Firestore writes and manually triggered OddsPapi requests will each require later scoped approval. Never deploy all Firebase functions while the preflight source in held PR #17 is absent from main.

The future live-rollout prerequisite remains: independently verify actual provider response fields through a separately approved, budget-reserved manual observation; do not infer missing sport, status, participant IDs or verified bookmaker offers from names or kickoff times.
