# NBA Betting Tracker — Firebase Functions

Firebase project: `nba-betting-tracker-3979d`

## Local setup

From the repository root:

```powershell
cd functions
npm.cmd install
npm.cmd run lint
cd ..
firebase.cmd use nba-betting-tracker-3979d
firebase.cmd deploy --only functions
```

Initial deployment exports `oddsBackendStatus`, a Firebase callable function in `europe-west1` that requires a signed-in Firebase user. It makes **no OddsPapi API requests**.

Do not commit API keys, service account JSON, `.env` files, or tokens. Later, set the OddsPapi key through Firebase Secret Manager with `firebase.cmd functions:secrets:set ODDSPAPI_API_KEY`; never paste the key into GitHub.

Blaze billing can incur charges even when usage is low. Budget alerts are not spending caps.
