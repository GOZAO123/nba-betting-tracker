# Update 35.1D15.34 — Trust-accurate provider/ESPN preview wording

**Draft / GitHub-only UI-copy correction. No Firebase deployment, OddsPapi request, new research capture, UI behavior change, or consent to merge.**

## Why this matters

On 20 November 2026, the owner ran one explicitly authorized manual `oddsPapiVerifiedPropsProbe` request. The app reported two upstream requests, 158 active provider-reported selections for Atlanta Hawks vs Charlotte Hornets, all eight markets represented, and **no visible sample flagged as a provider main line**. The owner then selected Dyson Daniels (provider name `Daniels, Dyson`) and Atlanta Hawks. The existing ESPN roster-name lookup reported **Dyson Daniels**, ESPN athlete ID `4869342`, and a unique name match after formatting normalization. It explicitly reported that availability was not confirmed.

Despite these limitations, the UI displayed `Verified Betano offer ready for manual transfer` and a green `Use this verified Betano offer in Props Analyzer` control. Those statements incorrectly imply that OddsPapi's bookmaker-attributed price, provider-player ID bridge and primary market line have been independently verified against Betano or ESPN.

## Smallest safe change

Change **only the user-facing text** in `index.html` connected to the existing OddsPapi market preview, the name-only ESPN roster match, the manual Analyzer transfer, and related historical research-preview notices. The new copy identifies provider-reported Betano-market prices as **unverified against the bookmaker** and roster checks as **ESPN roster-name matches**, not authenticated player-ID bridges. The existing button IDs, DOM events, callable name, request quota confirmation, selection binding, event payload, market data, layout and Google sign-in are retained unchanged.

Examples:

- `Preview verified Betano props` → `Preview OddsPapi Betano-market props`.
- `Betano odds` table header → `OddsPapi price (Betano PT)`.
- Green transfer button: `Use this verified Betano offer` → `Use provider quote preview`.
- Transfer status explicitly states that an ESPN roster name matched, but the OddsPapi-reported price **has not** been independently bookmaker-verified and the Analyzer transfer is for historical research only.
- The downstream Analyzer banner no longer claims a verified Betano line.

## Validation

`functions/odds-preview-verification-copy.test.js` adds **nine** read-only Node.js 22 source regression assertions for provider-vs-bookmaker claims, the exact manual two-slot confirmation, Google sign-in, ESPN roster-name lookup, protected preview-offer binding, the existing manual Analyzer event, Lisbon date formatting and absence of external calls in the test. An isolated GitHub workflow runs syntax + those assertions. Existing backend CI must still pass. These source tests cannot prove that a deployed UI is updated; live GitHub Pages deployment is separate and requires owner approval.

## Still blocked

Direct Betano quote authenticity, precise provider-to-ESPN player ID mapping, independent fixture linkage, player availability, unambiguous primary line, trusted prospective quote capture and model calibration remain unresolved. The one approved manual OddsPapi test is complete; do not click it again without renewed consent. No Firestore writes, paid calls, production functions changes, broad deployments, automatic polling, or UI launch are authorized by this draft.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`