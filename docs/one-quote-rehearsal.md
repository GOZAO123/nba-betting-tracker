# Local one-quote Firestore rehearsal

Use Node.js 22, Java 21, and Firebase CLI 15.35.0 from the repository root. Install the Functions dependencies with `npm install --prefix functions --no-audit --no-fund`. The CLI may need to download the Firestore emulator on first use. No Firebase login, provider key, cloud project, or deployment is needed.

```powershell
firebase.cmd emulators:exec --config firebase.quote-rehearsal.json --project demo-nba-quote-rehearsal --only firestore,auth "node --test functions/one-quote-rehearsal.js"
```

The runner requires the exact demo project and both configured loopback hosts before loading the Admin SDK. It uses the repository Firestore rules, emulator-issued synthetic authentication for client rule checks, and an in-process mock for both OddsPapi endpoints. The test requires a fresh emulator and starts no Functions emulator. Run it without import or export options.

A pass shows that an authorized synthetic run commits a two-slot Firestore quota reservation before transport, writes one private fixture and quote, and supports review-only linkage by a separate Admin client. Concurrent and warm cached runs create one pair in total. Disabled and unauthorized runs have no quota, transport or custody activity. An exhausted run checks quota before returning and leaves both receipt collections unchanged. The test uses a local adapter that mirrors the current production quota transaction. It does not invoke the deployed quota entry point.

The same run checks a new cold composition and a simulated quote write failure. A cold composition can collect a later pair using another reservation. A quote failure can leave the fixture without a matching quote because the writes are separate. These observations do not authorize repeat production collection or ledger capture.

`emulators:exec` stops the Firestore and Auth emulator processes after the test. Check for their shutdown messages and that loopback ports 8187 and 9197 are no longer listening. Without an export there is no datastore to restore. Any local Firebase debug logs are diagnostic output. There are no cloud resources to clean up. The rehearsal supplies no evidence for restoring the legacy `oddsBackendStatus` deployment.
