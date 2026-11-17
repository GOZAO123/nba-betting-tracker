# Update 35.1D8 — Offline binding of manual OddsPapi fetch to one-use source receipt

**Scope:** One new offline Node.js 22 factory and synthetic tests. No production deployment, real provider/ESPN request, production Firestore read/write, new callable, frontend change, polling, model promotion or betting capture. The owner previously verified their Firebase billing dashboard showed **€0**; this PR adds no incremental provider requests or operational Firebase usage.

## Starting state

`main` at `c2944470ceda6f645ce1bdb8213cfd2d71c845b5` includes the D5 sanitized optional `onProviderEvidence` hook (disabled in production), D6 immutable source storage contract and D7 strict Firestore Admin-style transaction adapter. Production `functions/index.js` is unchanged; real OddsPapi source observations, independently corroborated ESPN identities and D3 approved crosswalks remain **unavailable**.

D7's open security dependency was a trusted receipt binding between **the authorized manual provider fetch** and the exact sanitized evidence batch presented for storage. A client-provided reference or hash is not adequate authentication.

## D8 offline orchestration

`functions/manual-evidence-receipt.js` exports `makeOfflineManualEvidenceAudit({ownerUid,reserve,fetchCatalogue,fetchOdds,db,waitBetweenRequests,onFailure,now})`. All network, quota, database and clock effects are **injected**. Its only public output is the existing owner-only `run(request)` function; it does **not expose** a standalone paid-fetch method, evidence callback, receipt token, internal snapshot or storage object.

It composes three already-tested components:

- Existing `makeLeagueMarketAuditRunner`, which enforces verified Firebase owner identity, rejects manual request parameters, reserves one or two upstream quota slots through the injected existing transactional guard, honors cooldown, validates catalogue/odds, caches the aggregate for 15 minutes and deduplicates concurrent clicks. **It is still explicitly manual; no polling.**
- D5 provider identity extractor, called on the response returned by the **same** injected `fetchOdds` operation. It retains only bounded fixture/participant IDs and other allowlisted evidence; no raw odds, market offers, keys or player names are stored in the receipt. The runner later extracts the batch for an optional backend sink, and D8 compares exact fixture identity tuples/counts with the source it observed from the fetch. Missing IDs or near-boundary changes fail closed.
- D6+D7 immutable store and strict Firestore transaction facade. D8 creates an **unforgeable, in-memory, single-use object-identity token** only after a genuine backend-controlled delegated fetch. The D6 `isTrustedManualReceipt` callback recognizes this token only while storing that exact fixture batch, with matching capturedAt/source reference and a two-minute freshness window; it cannot be supplied in caller request parameters. A failure consumes the token and cannot cause an automatic provider retry.

After a backend-approved request and a successful validated audit, no *additional* odds fetch is performed to save identity evidence. The existing manual catalogue and league fetches are still **metered** if a future deployment enables this workflow, and must remain subject to owner approval and the server's six-reservation-requests-per-UTC-day limit. Unused authorizations from failed catalogue audits are invalidated before a new reservation; a paid-stage failure does not trigger retries.

The backend receipt is a capability generated from execution of the trusted fetch wrapper. It **does not cryptographically prove an external provider's response independently** and does not validate Betano offers, decide home/away team mappings or guarantee that injected backend dependencies are genuine. Production integration must pass only the fixed-origin authenticated OddsPapi transport, existing protected owner UID and quota guard, with clear evidence storage failure monitoring and separate deployment approval.

The module returns the **same aggregate-only audit report**; no raw bookmaker records, fixture IDs, receipt tokens or new fields are returned to clients. Firestore browser rules remain default-deny for internal evidence, and no Google sign-in, current app visuals, settlement, models or line selection changes.

## Required verification and next approval

- Node 22 syntax/lint, 238 existing tests plus 21 D8 synthetic tests on a repository CI runner. Test confirmed one manual fetch, cache/click deduplication, sequential reservations, owner denial before upstream work, no automatic retry on failed catalogue, odds or Firestore stages, no guessed participant IDs, no unreviewed-to-approved promotion and quota exhaustion.
- Only four changes: `functions/manual-evidence-receipt.js`, its tests, `functions/package.json`, and this document. No `functions/index.js`, Firestore rules, quota, frontend, credentials or dependency changes.
- Keep PR **OPEN/DRAFT/UNMERGED** until owner approves *that specific PR*. **Merging does not deploy.** Future targeted Firebase deployment, production Firestore write or actual metered OddsPapi request requires separate explicit owner consent.
- **Future phases:** production adapter to bind the fixed-host manual source and authenticated receipt with real Firebase IAM, minimal monitored snapshot retention, independent bounded ESPN evidence and explicit human approval/revocation of 2×2 team mappings. No genuine reviewed mapping, independent Betano price verification, main-line selection, EV or ROI claim is created by D8.

**Limitation:** This offline composite has not been tested against a real Firebase project or authentic OddsPapi league response. Actual provider fields may be absent; records must fail closed rather than inferring IDs. The trusted function dependency is an architectural assumption until separately reviewed and enabled.
