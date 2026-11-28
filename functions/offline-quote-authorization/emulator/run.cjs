'use strict';

const {spawnSync} = require('node:child_process');
const {join} = require('node:path');
const {assertDemoEnvironment} = require('./environment.cjs');

assertDemoEnvironment();

const rehearsals = [
  'firestore-transaction-rehearsal.cjs',
  'advanced-transaction-rehearsal.cjs',
  'end-to-end-emulator-rehearsal-v2.cjs',
  'collector-failure-matrix.cjs',
  'firestore-rules-rehearsal.cjs'
];

for (const rehearsal of rehearsals) {
  console.log('\nRunning ' + rehearsal);
  const result = spawnSync(process.execPath, [join(__dirname, rehearsal)], {
    stdio: 'inherit',
    timeout: 180000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
