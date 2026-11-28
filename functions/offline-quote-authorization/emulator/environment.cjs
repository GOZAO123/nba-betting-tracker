'use strict';

const assert = require('node:assert/strict');

const PROJECT = 'demo-nba-quote-rehearsal';
const HOST = '127.0.0.1';
const PORTS = Object.freeze({auth: 9197, firestore: 8087, hub: 4400, logging: 4500});
const AUTH = HOST + ':' + PORTS.auth;
const FIRESTORE = HOST + ':' + PORTS.firestore;

function assertDemoEnvironment() {
  const required = {
    GCLOUD_PROJECT: PROJECT,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    FIREBASE_AUTH_EMULATOR_HOST: AUTH,
    FIRESTORE_EMULATOR_HOST: FIRESTORE,
    FIREBASE_EMULATOR_HUB: HOST + ':' + PORTS.hub,
    ODDSPAPI_ONE_QUOTE_ENABLED: 'false'
  };
  for (const [name, value] of Object.entries(required)) {
    assert.ok(process.env[name] === value, 'Unsafe emulator environment: ' + name);
  }
  assert.ok(JSON.parse(process.env.FIREBASE_CONFIG ?? '{}').projectId === PROJECT,
    'Unsafe Firebase project configuration');
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']) {
    assert.ok(!process.env[name], 'Credential environment is forbidden: ' + name);
  }
  process.env.GCE_METADATA_HOST = HOST + ':1';
  process.env.GCE_METADATA_IP = HOST + ':1';
}

async function assertEmulatorsRunning() {
  const response = await fetch('http://' + HOST + ':' + PORTS.hub + '/emulators', {
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  });
  assert.ok(response.ok, 'Emulator hub did not respond');
  const services = await response.json();
  for (const service of ['auth', 'firestore']) {
    assert.equal(services[service]?.host, HOST);
    assert.equal(services[service]?.port, PORTS[service]);
  }
  assert.ok(!services.functions, 'Functions emulator is outside this rehearsal');
}

module.exports = {PROJECT, HOST, PORTS, AUTH, FIRESTORE, assertDemoEnvironment, assertEmulatorsRunning};
