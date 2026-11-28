'use strict';

const {spawnSync} = require('node:child_process');
const {accessSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync} = require('node:fs');
const {createServer} = require('node:net');
const {homedir, tmpdir} = require('node:os');
const {dirname, join, resolve} = require('node:path');
const {PROJECT, HOST, PORTS} = require('./environment.cjs');

function assertFreePort(port) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', () => reject(Error('Required loopback port unavailable: ' + port)));
    server.listen({host: HOST, port, exclusive: true}, () => server.close(resolvePort));
  });
}

async function main() {
  const legacy = process.argv[3] === '--legacy';
  if (process.argv.length !== (legacy ? 4 : 3)) {
    throw Error('Provide the installed Firebase CLI firebase.js path and optional --legacy');
  }
  const cli = resolve(process.argv[2]);
  const cliPackage = JSON.parse(readFileSync(resolve(dirname(cli), '../../package.json'), 'utf8'));
  if (cliPackage.name !== 'firebase-tools' || cliPackage.version !== '15.35.0' ||
      cli !== resolve(dirname(cli), '../../', cliPackage.bin.firebase)) {
    throw Error('An existing Firebase CLI 15.35.0 installation is required');
  }
  const cache = resolve(process.env.FIREBASE_EMULATORS_PATH ??
    join(homedir(), '.cache', 'firebase', 'emulators'));
  accessSync(join(cache, 'cloud-firestore-emulator-v1.22.0.jar'));
  const ports = {...PORTS, firestore: legacy ? 8187 : PORTS.firestore, websocket: 9150};
  await Promise.all(Object.values(ports).map(assertFreePort));

  // Start with an empty project directory and home. The CLI inherits neither
  // production selectors nor authentication settings from the parent process.
  const sandbox = mkdtempSync(join(tmpdir(), 'nba-authorization-emulators-'));
  const config = {
    firestore: {rules: 'firestore.rules'},
    emulators: {
      ...Object.fromEntries(Object.entries(PORTS).map(([name, port]) => [name, {host: HOST, port}])),
      firestore: {host: HOST, port: ports.firestore, websocketPort: ports.websocket},
      ui: {enabled: false},
      singleProjectMode: true
    }
  };
  copyFileSync(resolve(__dirname, '../../../firestore.rules'), join(sandbox, 'firestore.rules'));
  writeFileSync(join(sandbox, 'firebase.json'), JSON.stringify(config));

  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'JAVA_HOME', 'NODE_PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: sandbox,
    USERPROFILE: sandbox,
    APPDATA: sandbox,
    LOCALAPPDATA: sandbox,
    XDG_CONFIG_HOME: sandbox,
    CLOUDSDK_CONFIG: sandbox,
    TEMP: sandbox,
    TMP: sandbox,
    TMPDIR: sandbox,
    CI: 'true',
    NO_UPDATE_NOTIFIER: '1',
    FIREBASE_CLI_DISABLE_TELEMETRY: '1',
    FIREBASE_EMULATORS_PATH: cache,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    ODDSPAPI_ONE_QUOTE_ENABLED: 'false',
    NBA_AUTHORIZATION_REHEARSAL_RUNNER: join(__dirname, 'run.cjs'),
    NBA_LEGACY_REHEARSAL: resolve(__dirname, '../../one-quote-rehearsal.js'),
    HTTP_PROXY: 'http://' + HOST + ':1',
    HTTPS_PROXY: 'http://' + HOST + ':1',
    NO_PROXY: HOST + ',localhost'
  });

  console.log('Isolated emulator directory: ' + sandbox);
  const command = legacy
    ? 'node --test --test-timeout=180000 "%NBA_LEGACY_REHEARSAL%"'
    : 'node -e "require(process.env.NBA_AUTHORIZATION_REHEARSAL_RUNNER)"';
  const legacyCommand = process.platform === 'win32' ? command : command.replace('%NBA_LEGACY_REHEARSAL%', '$NBA_LEGACY_REHEARSAL');
  const result = spawnSync(process.execPath, [
    cli, 'emulators:exec', '--project', PROJECT, '--only', 'auth,firestore', legacyCommand
  ], {cwd: sandbox, env, stdio: 'inherit'});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
