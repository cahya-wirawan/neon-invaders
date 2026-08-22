/* api.test.js -- end-to-end HTTP tests over the real Express app and a real
 * (temp-file) SQLite database. Node's built-in test runner only; no jest,
 * no vitest, no supertest.
 *
 *   node --test test/
 *
 * Identity comes from locally-minted RS256 tokens verified through the real
 * `jwks` code path (see test/helpers/tokens.js) -- no network, no Firebase
 * project, no credentials. There is no register/login to test any more:
 * those endpoints were deleted and must 404.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, coerceTrustProxy } = require('../src/app');
const { createStore } = require('../src/db');
const { createAuth } = require('../src/auth');
const { createVerifier } = require('../src/firebase');
const { createAntiCheat, SECONDS_PER_WAVE_FLOOR } = require('../src/anticheat');
const { makeKeypair, claimsFor, signRs256 } = require('./helpers/tokens');

const PROJECT = 'demo-neon-invaders';
const KEYS = makeKeypair();

let tmpDir;
let store;
let server;
let base;

function tokenFor(uid, overrides) {
  return signRs256(KEYS, claimsFor(PROJECT, Object.assign({ sub: uid }, overrides || {})));
}

function buildAuth() {
  return createAuth({
    projectId: PROJECT,
    verifier: createVerifier({
      projectId: PROJECT,
      adminLoader: () => null, // force the offline fallback path
      staticKeys: KEYS.staticKeys,
      env: {}
    })
  });
}

/* Spins up an isolated app (own DB, own limiters, own bounds) for tests that
 * need non-default anti-cheat settings. */
async function isolatedApp(antiCheatOptions, rateLimit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-iso-'));
  const isoStore = createStore(path.join(dir, 'iso.db'));
  const app = createApp({
    store: isoStore,
    auth: buildAuth(),
    antiCheat: Object.assign({ ttlMs: 60000 }, antiCheatOptions || {}),
    rateLimit: rateLimit || {}
  });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return {
    url,
    store: isoStore,
    async close() {
      await new Promise((r) => srv.close(r));
      try {
        isoStore.close();
      } catch (err) {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-invaders-test-'));
  store = createStore(path.join(tmpDir, 'test.db'));
  const app = createApp({
    store,
    auth: buildAuth(),
    /* No bounds in the shared app: its tests submit within milliseconds of
     * run-start, which the DEFAULT rate ceiling correctly rejects (200/s x a
     * 5s grace = 1000 points max at elapsed 0). That is the bound working, not
     * a bug -- a real run is minutes old by the time it is submitted. The two
     * bounds get their own dedicated apps, with their own settings, below. */
    antiCheat: { ttlMs: 60000, minSecondsPerWaveScale: 0, maxScorePerSecond: 1000000 },
    rateLimit: { runStartMax: 5000 }
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    store.close();
  } catch (err) {
    /* ignore */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function callAt(root, method, url, body, token) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(root + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try {
    json = await res.json();
  } catch (err) {
    json = null;
  }
  return { status: res.status, body: json, headers: res.headers };
}

function call(method, url, body, token) {
  return callAt(base, method, url, body, token);
}

async function startRun(root, token) {
  const res = await callAt(root, 'POST', '/api/runs/start', undefined, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- health -------------------------------- */

test('GET /api/health returns 200 {ok:true}', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

/* ----------------------- old auth is really gone ------------------------ */

test('POST /api/auth/register is a plain 404 (endpoint deleted)', async () => {
  const res = await call('POST', '/api/auth/register', { username: 'x', password: 'yyyyyyyy' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('POST /api/auth/login is a plain 404 (endpoint deleted)', async () => {
  const res = await call('POST', '/api/auth/login', { username: 'x', password: 'yyyyyyyy' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('GET /api/auth/anything is a plain 404', async () => {
  const res = await call('GET', '/api/auth/whatever');
  assert.equal(res.status, 404);
});

/* --------------------------- firebase identity -------------------------- */

test('a valid Firebase ID token populates req.user and creates a users row', async () => {
  const res = await call('GET', '/api/me', undefined, tokenFor('uid-alice', {
    email: 'alice@example.com',
    name: 'Alice'
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, 'Alice');
  assert.equal(res.body.user.firebase_uid, 'uid-alice');
  assert.equal(res.body.user.email, 'alice@example.com');
  assert.ok(Number.isInteger(res.body.user.id));

  const row = store.db
    .prepare('SELECT id, firebase_uid, username, email FROM users WHERE firebase_uid = ?')
    .get('uid-alice');
  assert.ok(row, 'users row exists keyed on firebase_uid');
  assert.equal(row.username, 'Alice');
  assert.equal(row.id, res.body.user.id);
});

test('the same uid maps to the same row on a second request', async () => {
  const a = await call('GET', '/api/me', undefined, tokenFor('uid-stable', { name: 'Stable' }));
  const b = await call('GET', '/api/me', undefined, tokenFor('uid-stable', { name: 'Stable' }));
  assert.equal(a.body.user.id, b.body.user.id);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM users WHERE firebase_uid = ?').get('uid-stable').n,
    1
  );
});

for (const [label, token] of [
  ['no header', undefined],
  ['garbage', 'not-a-token'],
  ['empty-ish', '..'],
  ['three empty segments', 'e30.e30.e30']
]) {
  test(`GET /api/me with ${label} -> 401`, async () => {
    const res = await call('GET', '/api/me', undefined, token);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'unauthorized');
  });
}

test('an expired token -> 401', async () => {
  const res = await call('GET', '/api/me', undefined,
    tokenFor('uid-exp', { exp: Math.floor(Date.now() / 1000) - 60 }));
  assert.equal(res.status, 401);
});

test('a wrong-audience token -> 401', async () => {
  const res = await call('GET', '/api/me', undefined,
    tokenFor('uid-aud', { aud: 'someone-elses-project' }));
  assert.equal(res.status, 401);
});

test('a token signed by a different key -> 401', async () => {
  const other = makeKeypair();
  const forged = signRs256(
    { privateKey: other.privateKey, kid: KEYS.kid },
    claimsFor(PROJECT, { sub: 'uid-forged' })
  );
  const res = await call('GET', '/api/me', undefined, forged);
  assert.equal(res.status, 401);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM users WHERE firebase_uid = ?').get('uid-forged').n,
    0,
    'a rejected token must not create a user'
  );
});

/* ------------------------- POST /api/runs/start ------------------------- */

test('POST /api/runs/start without auth -> 401', async () => {
  const res = await call('POST', '/api/runs/start');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'unauthorized');
});

test('POST /api/runs/start with auth -> 201 with a token and server timestamps', async () => {
  const before = Date.now();
  const res = await call('POST', '/api/runs/start', undefined, tokenFor('uid-runner', { name: 'Runner' }));
  const after = Date.now();
  assert.equal(res.status, 201);
  assert.equal(typeof res.body.runToken, 'string');
  assert.ok(res.body.runToken.length >= 32, `token is ${res.body.runToken.length} chars`);
  assert.match(res.body.runToken, /^[A-Za-z0-9_-]+$/, 'base64url');
  assert.ok(res.body.startedMs >= before && res.body.startedMs <= after, 'server-timestamped');
  assert.ok(res.body.expiresMs > res.body.startedMs);
  assert.equal(typeof res.body.startedAt, 'string');

  const row = store.db.prepare('SELECT * FROM runs WHERE run_token = ?').get(res.body.runToken);
  assert.ok(row, 'runs row was written');
  assert.equal(row.consumed_at, null);
  assert.equal(row.started_ms, res.body.startedMs);
});

test('run-start is deduped: an open run is returned again, not reminted', async () => {
  const token = tokenFor('uid-dedupe', { name: 'Dedupe' });
  const first = await startRun(base, token);
  const second = await startRun(base, token);
  assert.equal(second.runToken, first.runToken);
  assert.equal(second.reused, true);
  assert.equal(second.startedMs, first.startedMs, 'the clock is NOT restarted');
  const n = store.db
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE run_token = ?")
    .get(first.runToken).n;
  assert.equal(n, 1);
});

test('after consuming a run, run-start mints a fresh one', async () => {
  const token = tokenFor('uid-fresh', { name: 'Fresh' });
  const first = await startRun(base, token);
  await call('POST', '/api/scores', { score: 10, wave: 1, runToken: first.runToken }, token);
  const second = await startRun(base, token);
  assert.notEqual(second.runToken, first.runToken);
  assert.equal(second.reused, false);
});

/* --------------------------- score submission --------------------------- */

test('a score referencing a valid run is accepted and stored with its run_id', async () => {
  const token = tokenFor('uid-scorer', { name: 'Scorer' });
  const run = await startRun(base, token);
  const res = await call('POST', '/api/scores', { score: 1234, wave: 3, runToken: run.runToken }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.personalBest.score, 1234);

  const row = store.db
    .prepare(
      'SELECT s.score, s.wave, s.run_id, r.run_token FROM scores s ' +
        'JOIN runs r ON r.id = s.run_id WHERE r.run_token = ?'
    )
    .get(run.runToken);
  assert.ok(row, 'the score row links back to the run row');
  assert.equal(row.score, 1234);
  assert.equal(row.wave, 3);
});

test('submitting without auth -> 401 and no row', async () => {
  const res = await call('POST', '/api/scores', { score: 1, wave: 1, runToken: 'whatever' });
  assert.equal(res.status, 401);
});

test('submitting with NO runToken -> 400 run_required, no row written', async () => {
  const token = tokenFor('uid-noRun', { name: 'NoRun' });
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n;
  const res = await call('POST', '/api/scores', { score: 9999, wave: 2 }, token);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'run_required');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, before);
});

test('submitting with a BOGUS runToken -> 400 invalid_run, no row written', async () => {
  const token = tokenFor('uid-bogus', { name: 'Bogus' });
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n;
  const res = await call('POST', '/api/scores',
    { score: 9999, wave: 2, runToken: 'ZmFrZS10b2tlbi1ub3QtcmVhbA' }, token);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_run');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, before);
});

test("another user's run token -> 400 invalid_run (same code, no existence oracle)", async () => {
  const owner = tokenFor('uid-owner', { name: 'Owner' });
  const thief = tokenFor('uid-thief', { name: 'Thief' });
  const run = await startRun(base, owner);
  const res = await call('POST', '/api/scores', { score: 50, wave: 1, runToken: run.runToken }, thief);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_run', 'must NOT reveal that the token exists');
  assert.equal(
    store.db.prepare('SELECT consumed_at FROM runs WHERE run_token = ?').get(run.runToken).consumed_at,
    null,
    "the owner's run is untouched"
  );
});

test('the SAME run token submitted twice -> 2nd is 400 run_already_used, exactly one row', async () => {
  const token = tokenFor('uid-replay', { name: 'Replay' });
  const run = await startRun(base, token);
  const first = await call('POST', '/api/scores', { score: 777, wave: 2, runToken: run.runToken }, token);
  const second = await call('POST', '/api/scores', { score: 777, wave: 2, runToken: run.runToken }, token);
  assert.equal(first.status, 201);
  assert.equal(second.status, 400);
  assert.equal(second.body.error, 'run_already_used');

  const n = store.db
    .prepare('SELECT COUNT(*) AS n FROM scores WHERE run_id = (SELECT id FROM runs WHERE run_token = ?)')
    .get(run.runToken).n;
  assert.equal(n, 1, 'exactly one score row for that run');
});

test('CONCURRENT submits of one token: exactly one wins, one row written', async () => {
  const token = tokenFor('uid-race', { name: 'Racer' });
  const run = await startRun(base, token);
  const body = { score: 321, wave: 2, runToken: run.runToken };
  const results = await Promise.all([
    call('POST', '/api/scores', body, token),
    call('POST', '/api/scores', body, token),
    call('POST', '/api/scores', body, token),
    call('POST', '/api/scores', body, token)
  ]);
  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 400);
  assert.equal(created.length, 1, `expected 1 x 201, got ${results.map((r) => r.status).join(',')}`);
  assert.equal(rejected.length, 3);
  for (const r of rejected) {
    assert.equal(r.body.error, 'run_already_used');
  }
  const n = store.db
    .prepare('SELECT COUNT(*) AS n FROM scores WHERE run_id = (SELECT id FROM runs WHERE run_token = ?)')
    .get(run.runToken).n;
  assert.equal(n, 1);
});

test('score/wave validation still applies before any run lookup', async () => {
  const token = tokenFor('uid-validate', { name: 'Validate' });
  const run = await startRun(base, token);
  for (const body of [
    { score: 'lots', wave: 1, runToken: run.runToken },
    { score: -1, wave: 1, runToken: run.runToken },
    { score: 1.5, wave: 1, runToken: run.runToken },
    { score: 10, wave: 0, runToken: run.runToken },
    { score: 10, wave: 100000, runToken: run.runToken }
  ]) {
    const res = await call('POST', '/api/scores', body, token);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, 'validation_error', JSON.stringify(res.body));
  }
  // ...and none of that consumed the run.
  const ok = await call('POST', '/api/scores', { score: 10, wave: 1, runToken: run.runToken }, token);
  assert.equal(ok.status, 201);
});

/* --------------- BOUND 1: minimum elapsed time for the wave ------------- */

test('BOUND 1: an impossibly fast wave claim -> 400 implausible_run, then 201 after waiting', async () => {
  // scale 0.02 => 17.8 * 0.02 = 0.356s per wave. Wave 4 => ~1.07s required.
  const iso = await isolatedApp({ minSecondsPerWaveScale: 0.02, maxScorePerSecond: 100000 });
  try {
    const token = tokenFor('uid-b1', { name: 'BoundOne' });
    const run = await startRun(iso.url, token);
    const claim = { score: 300, wave: 4, runToken: run.runToken };

    const tooSoon = await callAt(iso.url, 'POST', '/api/scores', claim, token);
    assert.equal(tooSoon.status, 400, JSON.stringify(tooSoon.body));
    assert.equal(tooSoon.body.error, 'implausible_run');
    assert.equal(
      iso.store.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 0,
      'a rejected claim writes no score'
    );
    assert.equal(
      iso.store.db.prepare('SELECT consumed_at FROM runs WHERE run_token = ?').get(run.runToken)
        .consumed_at,
      null,
      'a rejected claim does NOT burn the run token'
    );

    // Same claim, same token, after enough wall-clock time has passed.
    await sleep(1300);
    const later = await callAt(iso.url, 'POST', '/api/scores', claim, token);
    assert.equal(later.status, 201, JSON.stringify(later.body));
    assert.equal(later.body.wave, 4);
  } finally {
    await iso.close();
  }
});

test('BOUND 1: wave 1 has no time bound at all', async () => {
  const iso = await isolatedApp({ minSecondsPerWaveScale: 5 }); // absurdly strict
  try {
    const token = tokenFor('uid-b1w1', { name: 'WaveOne' });
    const run = await startRun(iso.url, token);
    const res = await callAt(iso.url, 'POST', '/api/scores',
      { score: 100, wave: 1, runToken: run.runToken }, token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  } finally {
    await iso.close();
  }
});

test('the time bound is the documented (wave-1) * 17.8 * scale formula', () => {
  const ac = createAntiCheat({ minSecondsPerWaveScale: 0.5 }, {});
  assert.equal(Math.round(SECONDS_PER_WAVE_FLOOR * 10) / 10, 17.8);
  assert.equal(ac.minElapsedSecondsForWave(1), 0);
  assert.ok(Math.abs(ac.minElapsedSecondsForWave(2) - 8.9) < 1e-9);
  assert.ok(Math.abs(ac.minElapsedSecondsForWave(11) - 89) < 1e-9);
});

/* -------------------- BOUND 2: maximum score per second ----------------- */

test('BOUND 2: exceeding the rate ceiling -> 400 implausible_score, at/under -> 201', async () => {
  /* Deliberately arranged so this trips ONLY bound 2: the time bound is off
   * (scale 0) and the claimed wave is 1, so nothing about elapsed-time-for-
   * wave is in play. Ceiling 100/s with a 5s grace and a ~0s-old run means
   * anything over ~500 points is impossible. */
  const iso = await isolatedApp({
    minSecondsPerWaveScale: 0,
    maxScorePerSecond: 100,
    scoreGraceSeconds: 5
  });
  try {
    const token = tokenFor('uid-b2', { name: 'BoundTwo' });

    const run1 = await startRun(iso.url, token);
    const tooFast = await callAt(iso.url, 'POST', '/api/scores',
      { score: 50000, wave: 1, runToken: run1.runToken }, token);
    assert.equal(tooFast.status, 400, JSON.stringify(tooFast.body));
    assert.equal(tooFast.body.error, 'implausible_score');
    assert.equal(iso.store.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 0);

    // Same run token, a claim inside the ceiling: accepted.
    const ok = await callAt(iso.url, 'POST', '/api/scores',
      { score: 400, wave: 1, runToken: run1.runToken }, token);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  } finally {
    await iso.close();
  }
});

test('the two bounds are INDEPENDENT: each can fail while the other passes', async () => {
  /* One app, one settings set, two claims:
   *   - claim A: high wave, low score   -> only the TIME bound can trip
   *   - claim B: wave 1, huge score     -> only the RATE bound can trip
   * Different error codes prove they are separate gates. */
  const iso = await isolatedApp({
    minSecondsPerWaveScale: 1,      // 17.8s per wave -- wave 9 needs ~142s
    maxScorePerSecond: 1000,
    scoreGraceSeconds: 5
  });
  try {
    const token = tokenFor('uid-indep', { name: 'Independent' });

    const runA = await startRun(iso.url, token);
    // 500 points is far under the ceiling (1000 * (0 + 5) = 5000), so only
    // the time bound can reject this.
    const a = await callAt(iso.url, 'POST', '/api/scores',
      { score: 500, wave: 9, runToken: runA.runToken }, token);
    assert.equal(a.status, 400);
    assert.equal(a.body.error, 'implausible_run', JSON.stringify(a.body));

    // Wave 1 has a zero time bound, so only the rate ceiling can reject this.
    const b = await callAt(iso.url, 'POST', '/api/scores',
      { score: 900000, wave: 1, runToken: runA.runToken }, token);
    assert.equal(b.status, 400);
    assert.equal(b.body.error, 'implausible_score', JSON.stringify(b.body));

    // And a claim that satisfies both is accepted on the very same token.
    const c = await callAt(iso.url, 'POST', '/api/scores',
      { score: 500, wave: 1, runToken: runA.runToken }, token);
    assert.equal(c.status, 201, JSON.stringify(c.body));
  } finally {
    await iso.close();
  }
});

test('the rate ceiling grows with measured elapsed time', () => {
  const ac = createAntiCheat({ maxScorePerSecond: 200, scoreGraceSeconds: 5 }, {});
  assert.equal(ac.maxScoreFor(0), 1000);
  assert.equal(ac.maxScoreFor(10), 3000);
  assert.equal(ac.maxScoreFor(60), 13000);
});

test('elapsed time clamps at 0 if the clock moves backwards', () => {
  const ac = createAntiCheat({}, {});
  assert.equal(ac.elapsedSeconds(2000, 1000), 0);
  assert.equal(ac.elapsedSeconds(1000, 3500), 2.5);
});

test('anti-cheat settings come from env vars when no option is given', () => {
  const ac = createAntiCheat(undefined, {
    RUN_TTL_MS: '1234',
    RUN_MIN_SECONDS_PER_WAVE_SCALE: '0.25',
    RUN_MAX_SCORE_PER_SECOND: '77',
    RUN_SCORE_GRACE_SECONDS: '2',
    RATE_LIMIT_RUNSTART_MAX: '9'
  });
  assert.equal(ac.ttlMs, 1234);
  assert.equal(ac.minSecondsPerWaveScale, 0.25);
  assert.equal(ac.maxScorePerSecond, 77);
  assert.equal(ac.scoreGraceSeconds, 2);
  assert.equal(ac.runStartMax, 9);
});

/* ---------------------------- TTL and purging --------------------------- */

test('an unsubmitted run expires (400 invalid_run) and is PURGED, not accumulated', async () => {
  const iso = await isolatedApp({ ttlMs: 1200, minSecondsPerWaveScale: 0 });
  try {
    const token = tokenFor('uid-ttl', { name: 'Ttl' });
    const run = await startRun(iso.url, token);
    assert.equal(iso.store.countRuns(), 1, 'one run row before expiry');

    await sleep(1500);

    const res = await callAt(iso.url, 'POST', '/api/scores',
      { score: 100, wave: 1, runToken: run.runToken }, token);
    assert.equal(res.status, 400);
    assert.equal(
      res.body.error, 'invalid_run',
      'expired reads the SAME as unknown -- no oracle for which it was'
    );
    assert.equal(iso.store.countRuns(), 0, 'the expired row was purged, not left to accumulate');
    assert.equal(iso.store.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 0);
  } finally {
    await iso.close();
  }
});

test('run-start also purges expired rows rather than growing the table', async () => {
  const iso = await isolatedApp({ ttlMs: 900 });
  try {
    const a = tokenFor('uid-purgeA', { name: 'PurgeA' });
    const b = tokenFor('uid-purgeB', { name: 'PurgeB' });
    await startRun(iso.url, a);
    await startRun(iso.url, b);
    assert.equal(iso.store.countRuns(), 2);

    await sleep(1200);
    await startRun(iso.url, tokenFor('uid-purgeC', { name: 'PurgeC' }));
    assert.equal(iso.store.countRuns(), 1, 'both stale rows purged, only the new one remains');
  } finally {
    await iso.close();
  }
});

test('a CONSUMED run is never purged (it is the audit trail for a score)', async () => {
  const iso = await isolatedApp({ ttlMs: 800, minSecondsPerWaveScale: 0 });
  try {
    const token = tokenFor('uid-keep', { name: 'Keep' });
    const run = await startRun(iso.url, token);
    const ok = await callAt(iso.url, 'POST', '/api/scores',
      { score: 42, wave: 1, runToken: run.runToken }, token);
    assert.equal(ok.status, 201);
    await sleep(1000);
    await startRun(iso.url, token); // triggers a purge
    assert.equal(iso.store.countRuns(), 2, 'the consumed run survived the purge');
    assert.equal(iso.store.db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 1);
  } finally {
    await iso.close();
  }
});

/* ------------------------- rate limiting (runs) ------------------------- */

test('run-start has its OWN limiter: Nth+1 -> 429 while an issued token still works', async () => {
  const iso = await isolatedApp({ minSecondsPerWaveScale: 0 }, { runStartMax: 3 });
  try {
    // Distinct users so this is about the per-IP bucket, not per-account state.
    const first = await callAt(iso.url, 'POST', '/api/runs/start', undefined,
      tokenFor('uid-rl1', { name: 'Rl1' }));
    assert.equal(first.status, 201);
    const issued = first.body.runToken;

    const second = await callAt(iso.url, 'POST', '/api/runs/start', undefined,
      tokenFor('uid-rl2', { name: 'Rl2' }));
    const third = await callAt(iso.url, 'POST', '/api/runs/start', undefined,
      tokenFor('uid-rl3', { name: 'Rl3' }));
    assert.equal(second.status, 201);
    assert.equal(third.status, 201);

    const fourth = await callAt(iso.url, 'POST', '/api/runs/start', undefined,
      tokenFor('uid-rl4', { name: 'Rl4' }));
    assert.equal(fourth.status, 429, JSON.stringify(fourth.body));
    assert.equal(fourth.body.error, 'rate_limited');
    assert.ok(fourth.headers.get('retry-after'));

    // The token issued BEFORE the limit was hit is still perfectly submittable.
    const submit = await callAt(iso.url, 'POST', '/api/scores',
      { score: 120, wave: 1, runToken: issued }, tokenFor('uid-rl1', { name: 'Rl1' }));
    assert.equal(submit.status, 201, JSON.stringify(submit.body));
  } finally {
    await iso.close();
  }
});

test('a deduped run-start still COUNTS against the limiter', async () => {
  const iso = await isolatedApp({}, { runStartMax: 2 });
  try {
    const token = tokenFor('uid-rldedupe', { name: 'RlDedupe' });
    const a = await callAt(iso.url, 'POST', '/api/runs/start', undefined, token);
    const b = await callAt(iso.url, 'POST', '/api/runs/start', undefined, token);
    const c = await callAt(iso.url, 'POST', '/api/runs/start', undefined, token);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.body.reused, true, 'same token returned');
    assert.equal(c.status, 429, 'repeated calls past the limit still 429');
  } finally {
    await iso.close();
  }
});

test('run-start limiting does not limit score submission', async () => {
  const iso = await isolatedApp({ minSecondsPerWaveScale: 0 }, { runStartMax: 1 });
  try {
    const token = tokenFor('uid-sep', { name: 'Separate' });
    const run = await startRun(iso.url, token);
    const blocked = await callAt(iso.url, 'POST', '/api/runs/start', undefined,
      tokenFor('uid-sep2', { name: 'Separate2' }));
    assert.equal(blocked.status, 429);
    // The score endpoint is on a different (unshared) path entirely.
    const submit = await callAt(iso.url, 'POST', '/api/scores',
      { score: 100, wave: 1, runToken: run.runToken }, token);
    assert.equal(submit.status, 201, JSON.stringify(submit.body));
  } finally {
    await iso.close();
  }
});

/* ---------------------------- scores/me + board ------------------------- */

test('GET /api/scores/me needs auth and reports the personal best', async () => {
  const anon = await call('GET', '/api/scores/me');
  assert.equal(anon.status, 401);

  const token = tokenFor('uid-best', { name: 'Bester' });
  const empty = await call('GET', '/api/scores/me', undefined, token);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.score, null);

  for (const score of [100, 900, 400]) {
    const run = await startRun(base, token);
    const r = await call('POST', '/api/scores', { score, wave: 1, runToken: run.runToken }, token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const best = await call('GET', '/api/scores/me', undefined, token);
  assert.equal(best.body.score, 900);
  assert.equal(best.body.username, 'Bester');
});

test('GET /api/leaderboard is public, ordered, one row per player', async () => {
  for (const [uid, score] of [['uid-lb1', 5000], ['uid-lb2', 8000], ['uid-lb3', 6000]]) {
    const token = tokenFor(uid, { name: uid.replace(/-/g, '') });
    for (const s of [score, Math.floor(score / 2)]) {
      const run = await startRun(base, token);
      await call('POST', '/api/scores', { score: s, wave: 1, runToken: run.runToken }, token);
    }
  }
  const res = await call('GET', '/api/leaderboard?limit=100');
  assert.equal(res.status, 200);
  const entries = res.body.entries;
  assert.ok(entries.length >= 3);
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok(entries[i - 1].score >= entries[i].score, 'descending');
  }
  assert.equal(new Set(entries.map((e) => e.username)).size, entries.length, 'unique players');
  entries.forEach((e, i) => assert.equal(e.rank, i + 1));
});

test('GET /api/leaderboard rejects a non-integer limit and clamps range', async () => {
  assert.equal((await call('GET', '/api/leaderboard?limit=abc')).status, 400);
  assert.equal((await call('GET', '/api/leaderboard?limit=12abc')).status, 400);
  assert.equal((await call('GET', '/api/leaderboard?limit=99999')).body.limit, 100);
  assert.equal((await call('GET', '/api/leaderboard?limit=-4')).body.limit, 1);
});

/* ------------------------- transport-level behaviour -------------------- */

test('malformed JSON gets a 400 bad_json, not a 500', async () => {
  const res = await fetch(base + '/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor('uid-json')}` },
    body: '{ not json'
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_json');
});

test('an oversized body gets 413, not a 500', async () => {
  const res = await fetch(base + '/api/scores', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor('uid-big')}` },
    body: JSON.stringify({ score: 1, wave: 1, runToken: 'x'.repeat(40000) })
  });
  assert.equal(res.status, 413);
});

test('an unknown path returns the JSON 404 shape', async () => {
  const res = await call('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('CORS: an allowed origin is echoed, an unknown one is not', async () => {
  const good = await fetch(base + '/api/health', { headers: { Origin: 'capacitor://localhost' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  const bad = await fetch(base + '/api/health', { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('coerceTrustProxy turns env strings into what Express wants', () => {
  assert.equal(coerceTrustProxy('1'), 1);
  assert.equal(coerceTrustProxy('true'), true);
  assert.equal(coerceTrustProxy('false'), false);
  assert.equal(coerceTrustProxy('loopback'), 'loopback');
});

/* ------------------------ no password/JWT residue ----------------------- */

test('the users table has no password_hash column at runtime', () => {
  const cols = store.db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(!cols.includes('password_hash'));
  assert.ok(cols.includes('firebase_uid'));
});

test('bcryptjs and jsonwebtoken are not declared dependencies', () => {
  const pkg = require('../package.json');
  const all = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies);
  assert.ok(!('bcryptjs' in all), 'bcryptjs still declared');
  assert.ok(!('jsonwebtoken' in all), 'jsonwebtoken still declared');
});

/* Strips comments so the check is about CODE, not about the header comment
 * that explains these things were removed. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('src/auth.js contains no password or JWT-issuing code', () => {
  const src = stripComments(
    fs.readFileSync(path.resolve(__dirname, '..', 'src', 'auth.js'), 'utf8')
  );
  for (const banned of [
    'bcrypt', 'jsonwebtoken', 'hashPassword', 'verifyPassword',
    'issueToken', 'verifyToken(', 'dummyPasswordHash', 'JWT_SECRET',
    'password_hash', 'validateCredentials', 'resolveJwtSecret',
    'INSECURE_DEV_ONLY_JWT_SECRET', 'PASSWORD_MIN', 'PASSWORD_MAX'
  ]) {
    assert.ok(src.indexOf(banned) === -1, `auth.js code still contains ${banned}`);
  }
});

test('the deleted routes/auth.js is really gone from disk', () => {
  assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'src', 'routes', 'auth.js')), false);
});

test('no source file under src/ requires bcryptjs or jsonwebtoken', () => {
  const dir = path.resolve(__dirname, '..', 'src');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  })(dir);
  assert.ok(files.length >= 6, `expected several src files, found ${files.length}`);
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    assert.ok(!/require\(['"]bcryptjs['"]\)/.test(src), `${f} requires bcryptjs`);
    assert.ok(!/require\(['"]jsonwebtoken['"]\)/.test(src), `${f} requires jsonwebtoken`);
  }
});
