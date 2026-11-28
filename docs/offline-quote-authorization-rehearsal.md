# Offline quote authorization and shared quota rehearsal

The factories in `functions/offline-quote-authorization` are disconnected from
the Firebase entry point. The tests reuse the repository's quote normalizer,
Firestore review journal, evidence readers and linked quote collector. The
rehearsal supplies synthetic approvals, source records, catalogue and odds.
The one-slot broker and two-slot collector share the repository Firestore
adapter and its six-slot UTC-day counter in the demo project. The production
one-quote flag stays false.

## Run locally

From the repository root, run the ordinary syntax and unit checks:

```powershell
npm run lint --prefix functions
npm test --prefix functions
```

Run `npm run test:offline:all --prefix functions` to repeat the registered
suite and the 14 additional offline suites. This command uses an explicit file
list and leaves the existing CI commands intact.

The emulator suites run separately. The launcher requires Node.js 22, Java 21,
an existing local Firebase CLI 15.35.0 installation, the already-cached
Firestore emulator v1.22.0 JAR and the repository's existing Functions
dependencies. If using a sibling checkout with compatible installed
dependencies, set `NODE_PATH` to its `functions/node_modules` directory for
this shell. Supply the existing CLI entry file to the launcher:

```powershell
$cli = Join-Path (Split-Path (Get-Command firebase.cmd).Source) 'node_modules/firebase-tools/lib/bin/firebase.js'
node functions/offline-quote-authorization/emulator/start.cjs $cli
```

If the CLI uses a different installation layout, supply its
`firebase-tools/lib/bin/firebase.js` path directly. The launcher checks the
CLI version and checks for the JAR in `FIREBASE_EMULATORS_PATH` or the normal
Firebase emulator cache before starting. Use an unused set of loopback ports
8087, 9197, 4400, 4500 and 9150.

The launcher copies the repository rules to a fresh temporary directory and runs
`emulators:exec` for Auth and Firestore with the fixed project
`demo-nba-quote-rehearsal`. It uses an isolated CLI home and keeps diagnostic
logs in that directory. The runner checks the project, exact loopback
addresses, disabled flag and service inventory before loading the SDK. The
six suites run sequentially with synthetic accounts, create-only seeds and
targeted cleanup. Check each suite's cleanup line and the emulator shutdown
messages. The runner does not import or export emulator data.

To run the separate legacy one-quote suite in a second fresh emulator, add
`--legacy` to the launcher command. The legacy suite uses Firestore port 8187
and the same Auth port 9197. It creates a transient synthetic datastore and
relies on emulator shutdown without export to discard its contents.

The transaction suites use actual Auth emulator ID tokens and verify the
decoded project, UID and email verification claim. The Firestore rules
rehearsal uses client REST requests for the permissions assertions. The
corrected v2 end-to-end rehearsal verifies private receipt creation,
fixture matching, and status-only linkage with the existing collector. It
also checks same-permit and distinct-permit concurrency and verifies the stored
counter across a pre-commit abort and synthetic lost acknowledgements.
The dedicated shared-budget suite covers the six-slot limit, mixed callers,
counter validation, UTC rollover, and transaction retries.

Release requires review of any production shared quota integration, genuine
provider evidence, independent ESPN evidence, global mapping completeness,
production IAM and recovery, and explicit owner authorization.
