# NBA Betting Tracker — Firebase Functions

Firebase project: `nba-betting-tracker-3979d`, Functions region `europe-west1`, Node.js 22.

## Offline development validation on Windows

From the repository root (no network or cloud actions beyond installing project dependencies if necessary):

```powershell
cd functions
npm.cmd run lint
npm.cmd test
npm.cmd run preflight:evidence
```

The last command is a **read-only local release preflight**. It deliberately exits with code **2 (BLOCKED)** while independent provider field checks, ESPN mapping review, production IAM/billing verification, and separate deployment/API permissions remain outstanding. A passing unit test suite or a successful GitHub merge does **not** mean the Firebase deployment is authorized.

If dependencies are missing, `npm.cmd install` installs the pinned project dependencies and may contact the package registry; it does not contact OddsPapi or deploy Firebase. The syntax/test commands use built-in Node.js functionality.

## Production deployment safety — STOP by default

**Never run a project-wide Firebase Functions deployment.** Production includes individually deployed functions that may not match the current `main` checkout (notably held draft PR #17). A broad deployment could update or remove working functions. Do not deploy Firebase, run live Firestore writes or make metered OddsPapi requests without a fresh, specific owner approval.

Only **after explicit owner approval for one named function** and verification of both its exact reviewed code and the live deployed function inventory should an engineer consider a targeted command such as:

```powershell
firebase.cmd deploy --only functions:EXACT_APPROVED_FUNCTION_NAME --project nba-betting-tracker-3979d
```

The above is an illustrative command, **not approval or an instruction to execute it now**. Confirm source/secret compatibility, build inputs, quota reservations and rollback safety first; never infer production state from a GitHub merge.

Research evidence from D5–D11 remains **offline and disabled in production**. Provider fixture fields, independent ESPN team identities, owner-reviewed two-way crosswalks and safe source receipts still need real verification and separate authorization before enablement.

Do not commit API keys, service account JSON, `.env` files or tokens. Provider credentials belong in Firebase Secret Manager; do not paste them into GitHub, ChatGPT or screenshots.

The Firebase Blaze plan may incur charges even when usage is low. Billing alerts are not spending caps. Keep the six upstream diagnostic reservations per UTC day and never introduce automatic OddsPapi polling.
