/* emulator.test.js -- OPT-IN integration test against a REAL Firebase Auth
 * emulator, using ID tokens the emulator actually minted.
 *
 * Every other test in this directory is offline and mints its own tokens. This
 * one is the counterweight: it proves the verifier accepts a token this code
 * did not create.
 *
 * It runs only when FIREBASE_AUTH_EMULATOR_HOST points at a reachable
 * emulator, and SKIPS (never fails) otherwise, so `npm test` stays green and
 * network-free by default. To run it:
 *
 *   npx firebase-tools emulators:start --only auth --project demo-neon-invaders
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npm test
 *
 * scripts/verify.sh starts the emulator itself and sets that variable, which
 * is how AC9 gets its real-emulator evidence.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createVerifier } = require('../src/firebase');
const { createAuth } = require('../src/auth');
const { createApp } = require('../src/app');
const { createStore } = require('../src/db');

const PROJECT = process.env.FIREBASE_PROJECT_ID || 'demo-neon-invaders';
const HOST = String(process.env.FIREBASE_AUTH_EMULATOR_HOST || '').trim();

async function emulatorReachable() {
  if (!HOST) {
    return false;
  }
  try {
    const res = await fetch(`http://${HOST}/`, {
      signal: AbortSignal.timeout(2500)
    });
    const body = await res.json();
    return !!(body && body.authEmulator && body.authEmulator.ready);
  } catch (err) {
    return false;
  }
}

/* The emulator implements the real Identity Toolkit REST API and accepts any
 * api key, which is how the browser SDK talks to it too. */
async function mintRealToken(email) {
  const res = await fetch(
    `http://${HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'hunter2hunter2', returnSecureToken: true })
    }
  );
  const body = await res.json();
  if (!body.idToken) {
    throw new Error('emulator did not return an idToken: ' + JSON.stringify(body));
  }
  return body.idToken;
}

/* This file is CommonJS, so there is no top-level await to resolve
 * reachability once up front -- memoise the probe instead and let each test
 * skip itself. A skip is a visible "ℹ skipped" line in the runner output, not
 * a silent pass. */
let availabilityPromise = null;
function available() {
  if (!availabilityPromise) {
    availabilityPromise = emulatorReachable();
  }
  return availabilityPromise;
}

async function skipUnlessEmulator(t) {
  if (await available()) {
    return false;
  }
  t.skip(
    HOST
      ? `FIREBASE_AUTH_EMULATOR_HOST=${HOST} is not reachable`
      : 'FIREBASE_AUTH_EMULATOR_HOST is not set'
  );
  return true;
}

test('REAL emulator: ID tokens are unsigned (alg none, empty signature)', async (t) => {
  if (await skipUnlessEmulator(t)) return;
  const token = await mintRealToken(`shape-${Date.now()}@example.com`);
  const [rawHeader, , signature] = token.split('.');
  const header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
  assert.equal(header.alg, 'none', 'documents WHY emulator mode skips signature checks');
  assert.equal(signature, '', 'the signature segment really is empty');
});

test('REAL emulator: emulator-mode verifier accepts a genuine emulator token', async (t) => {
  if (await skipUnlessEmulator(t)) return;
  const verifier = createVerifier({
    projectId: PROJECT,
    adminLoader: () => null, // exercise the no-firebase-admin fallback
    emulatorHost: HOST,
    env: {}
  });
  assert.equal(verifier.mode, 'emulator');
  const claims = await verifier.verifyIdToken(await mintRealToken(`emu-${Date.now()}@example.com`));
  assert.equal(claims.aud, PROJECT);
  assert.equal(claims.iss, `https://securetoken.google.com/${PROJECT}`);
  assert.ok(claims.uid && claims.uid.length > 0);
});

test('REAL emulator: firebase-admin (admin mode) accepts a genuine emulator token', async (t) => {
  if (await skipUnlessEmulator(t)) return;
  let verifier;
  try {
    verifier = createVerifier({ projectId: PROJECT, emulatorHost: HOST, env: {} });
  } catch (err) {
    assert.fail('createVerifier threw: ' + err.message);
  }
  if (verifier.mode !== 'admin') {
    // firebase-admin is an optionalDependency: absent is a legitimate state.
    return;
  }
  const claims = await verifier.verifyIdToken(await mintRealToken(`adm-${Date.now()}@example.com`));
  assert.ok(claims.uid);
  assert.equal(claims.aud, PROJECT);
  await assert.rejects(() => verifier.verifyIdToken('garbage'));
});

test('REAL emulator: end-to-end run-start + score submit with a genuine token', async (t) => {
  if (await skipUnlessEmulator(t)) return;
  const store = createStore(':memory:');
  const auth = createAuth({
    projectId: PROJECT,
    verifier: createVerifier({ projectId: PROJECT, emulatorHost: HOST, env: {} })
  });
  const app = createApp({
    store,
    auth,
    antiCheat: { ttlMs: 60000, minSecondsPerWaveScale: 0, maxScorePerSecond: 100000 }
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const email = `e2e-${Date.now()}@example.com`;
    const idToken = await mintRealToken(email);
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` };

    const me = await (await fetch(`${base}/api/me`, { headers: H })).json();
    assert.equal(me.user.email, email, 'req.user was populated from a real token');

    const uidRow = store.db
      .prepare('SELECT firebase_uid, username FROM users WHERE firebase_uid = ?')
      .get(me.user.firebase_uid);
    assert.ok(uidRow, 'a users row keyed on the real firebase_uid exists');

    const runRes = await fetch(`${base}/api/runs/start`, { method: 'POST', headers: H });
    assert.equal(runRes.status, 201);
    const run = await runRes.json();

    const scoreRes = await fetch(`${base}/api/scores`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ score: 4242, wave: 1, runToken: run.runToken })
    });
    assert.equal(scoreRes.status, 201, JSON.stringify(await scoreRes.json()));

    const unauth = await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer garbage' } });
    assert.equal(unauth.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});
