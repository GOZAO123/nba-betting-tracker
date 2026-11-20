# Update 35.1D15.35 — Persistent local OddsPapi diagnostic summaries

**Status: Draft / GitHub-only. No Firebase deployment, paid provider calls, new research captures or automatic polling.**

## Purpose

The owner’s first approved live OddsPapi preview returned 158 active selections across all eight supported markets for Atlanta Hawks vs Charlotte Hornets, using two diagnostic reservations. After a Windows restart, the app’s original preview DOM and ESPN player selection were lost, while Firestore confirmed the two daily reservations were still recorded. This change preserves a small, historical **summary of future successful manual previews** without replaying OddsPapi, storing unverified player prices or treating a screen snapshot as research evidence.

## User experience

A new **Saved diagnostic summaries (this browser only)** area appears below the existing manual player-props preview. It shows up to ten historical entries, most recent first, for up to 30 days. Each entry contains the **local time the browser viewed** the manual response (Europe/Lisbon, HH:mm), NBA fixture, number of matching market IDs, active selections, eight market-family counts where returned, and app-reported requests used/cached indication. It includes a prominent `HISTORICAL ODDS PAPI SUMMARY ONLY` disclaimer.

The history is **not** a replay of the live preview: it has no player rows, names, prices, lines, OddsPapi player IDs, bookmaker account data, credentials, API key, independent Betano confirmation, ESPN roster match, model score or betting recommendation. It cannot be sent to Props Analyzer or used to capture a research record. The existing short-lived research `sessionStorage` preview and its stale-offer safeguards are unchanged.

History is held in the browser’s `localStorage`, **not** Firestore. The storage key includes SHA-256 of the currently signed-in Firebase UID (not the raw UID) so different signed-in accounts on the same browser do not share summaries. Hashing a UID only scopes local content; it does not authenticate a provider response or encrypt the local metadata. It remains readable to anyone with access to that browser profile. The UI hides history on sign-out. Storage is best effort; browsers can deny it or users can clear it.

At sign-in, the app derives the local per-account key, validates stored records and renders the history **without any provider/ESPN/Firebase request**. A new history entry can be saved **only after** the existing authenticated manual `oddsPapiVerifiedPropsProbe` callable returns an eligible fixture and sanitized aggregate counts; it does not trigger a callable on its own. The 6/UTC-day backend reservation limit and owner confirmation remain untouched. Invalid/corrupted/oversized/expired records fail closed, market families are restricted to the eight supported markets, and the fixture must comprise two distinct names from the existing NBA team-ID map. All UI rendering uses `textContent` rather than inserting unchecked HTML.

A **Clear local history** button deletes only these stored summaries after confirmation. It does not reset Firebase diagnostic reservations, provider monthly usage, research ledger or prior paid requests.

## Scope and limitations

- Exactly one existing UI file (`index.html`) is modified: a separate local history area, pure summary validation/storage helpers, a sign-in restoration hook and one conditional save after a successful manual preview. No other existing app code, Firebase Functions, Firestore rules, project configuration, scheduling, Android zoom or checklist reset is changed.
- A new offline Node 22 test file exercises retention, simulated restart, account separation, validation of known teams and market families, sanitization, inaccessible local storage, tampering and confirmation of the unchanged manual-only request boundary. A dedicated CI job runs these tests; existing frontend/backend CI must remain green.
- **Historical note:** The **20 November 2026** first live preview is documented in GitHub issue #1 and screenshots, but cannot be backfilled into new `localStorage` automatically from the already lost DOM without inventing source provenance. Only subsequent successful manual previews produce entries.
- Browser time is explicitly a **local observation timestamp**, not the original bookmaker quote/capture time. The app currently does not independently verify exact Betano offers or the provider’s primary line. An entry’s status is always `PROVIDER_PREVIEW_UNVERIFIED`.
- `localStorage` survives ordinary same-browser PC restarts but is **not a cloud backup** and is not shared across Android, other browsers or private modes. Browser-site-data clearing removes it.

## Acceptance tests

```sh
node --check tests/odds-diagnostic-history.test.cjs
node --test tests/odds-diagnostic-history.test.cjs
node --test tests/research-dashboard.test.cjs
npm run lint --prefix functions
npm test --prefix functions
```

**Owner review before merge and visible site changes.** After any future separately approved merge and GitHub Pages rollout, check desktop and Android that the local summary does not change table widths or zoom and stays labeled historical, log out/log back in, restart and confirm the summary persists, and ensure no automatic OddsPapi requests. Do not spend any requests merely to test history without separate explicit approval; until the next separately authorized manual provider call, the empty-state message is the expected result.

`releaseReady:false` · `paidProviderAllowed:false` · `cloudChangesAuthorized:false`
