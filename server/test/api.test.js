/* api.test.js -- end-to-end HTTP tests over the real Express app and a real
 * (temp-file) SQLite database. Node's built-in test runner only; no jest,
 * no vitest, no supertest.
 *
 *   node --test test/
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

const TEST_SECRET = 'test-only-secret-not-used-anywhere-else';

let tmpDir;
let store;
let server;
let base;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-invaders-test-'));
  store = createStore(path.join(tmpDir, 'test.db'));
  const auth = createAuth({ jwtSecret: TEST_SECRET, rounds: 4 });
  const app = createApp({
    store,
    auth,
    // Generous enough that the happy-path tests never trip it; the 429 test
    // uses its own app with max:2.
    rateLimit: { registerMax: 500, loginMax: 500 }
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

async function call(method, url, body, token) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(base + url, {
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

/* ------------------------------- health -------------------------------- */

test('GET /api/health returns 200 {ok:true}', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

/* ------------------------------ register ------------------------------- */

test('register creates a user and returns a token', async () => {
  const res = await call('POST', '/api/auth/register', {
    username: 'alice',
    password: 'correct-horse-1'
  });
  assert.equal(res.status, 201);
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.user.username, 'alice');
  assert.equal(typeof res.body.user.id, 'number');
});

test('register stores a bcrypt hash, never the plaintext', () => {
  const row = store.findUserByUsername('alice');
  assert.ok(row, 'user row exists');
  assert.match(row.password_hash, /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
  assert.notEqual(row.password_hash, 'correct-horse-1');
  assert.ok(!row.password_hash.includes('correct-horse-1'));
});

test('duplicate register is 409, case-insensitively', async () => {
  const same = await call('POST', '/api/auth/register', {
    username: 'alice',
    password: 'another-password'
  });
  assert.equal(same.status, 409);

  const cased = await call('POST', '/api/auth/register', {
    username: 'ALICE',
    password: 'another-password'
  });
  assert.equal(cased.status, 409);
});

test('register rejects bad usernames and short passwords with 400', async () => {
  const cases = [
    { username: 'ab', password: 'longenough1' },
    { username: 'has space', password: 'longenough1' },
    { username: 'a'.repeat(21), password: 'longenough1' },
    { username: 'bad!chars', password: 'longenough1' },
    { username: 'validname', password: 'short' },
    { username: 'validname', password: 'x'.repeat(73) },
    { username: 'validname' },
    {}
  ];
  for (const body of cases) {
    const res = await call('POST', '/api/auth/register', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(res.body.error, 'validation_error');
  }
});

/* -------------------------------- login -------------------------------- */

test('login with the right password returns 200 + token', async () => {
  const res = await call('POST', '/api/auth/login', {
    username: 'alice',
    password: 'correct-horse-1'
  });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.user.username, 'alice');
});

test('login with the wrong password is 401', async () => {
  const res = await call('POST', '/api/auth/login', {
    username: 'alice',
    password: 'wrong-password-x'
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'invalid_credentials');
});

test('login for an unknown user is 401 with the same body (no oracle)', async () => {
  const unknown = await call('POST', '/api/auth/login', {
    username: 'nobody-here',
    password: 'wrong-password-x'
  });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, 'invalid_credentials');
});

test('login runs a bcrypt compare even for an unknown user (SRV-05)', async () => {
  /* Deterministic rather than a wall-clock measurement: the timing oracle
   * existed because the "no such user" branch skipped verifyPassword entirely,
   * so counting the compares proves the fix without a flaky timer. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-invaders-timing-'));
  const timingStore = createStore(path.join(dir, 'timing.db'));
  const realAuth = createAuth({ jwtSecret: TEST_SECRET, rounds: 4 });
  const compares = [];
  const spyAuth = Object.assign({}, realAuth, {
    verifyPassword(plain, hash) {
      compares.push(hash);
      return realAuth.verifyPassword(plain, hash);
    }
  });
  const app = createApp({ store: timingStore, auth: spyAuth });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/auth`;

  const post = (path_, body) =>
    fetch(url + path_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  await post('/register', { username: 'realuser', password: 'realpassword1' });
  compares.length = 0;

  const known = await post('/login', { username: 'realuser', password: 'wrongpassword1' });
  const unknown = await post('/login', { username: 'nosuchuser', password: 'wrongpassword1' });

  await new Promise((r) => srv.close(r));
  timingStore.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(known.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(compares.length, 2, 'both logins must run exactly one compare');
  // The unknown-user compare uses a real bcrypt hash at the same work factor.
  assert.match(compares[1], /^\$2[aby]\$04\$[./A-Za-z0-9]{53}$/);
  assert.equal(compares[1], realAuth.dummyPasswordHash);
  assert.notEqual(compares[0], compares[1]);
});

/* --------------------------------- me ---------------------------------- */

test('GET /api/me without a token is 401', async () => {
  const res = await call('GET', '/api/me');
  assert.equal(res.status, 401);
});

test('GET /api/me with a garbage token is 401', async () => {
  const res = await call('GET', '/api/me', undefined, 'not.a.jwt');
  assert.equal(res.status, 401);
});

test('a token signed with a different secret is rejected', async () => {
  const otherAuth = createAuth({ jwtSecret: 'a-completely-different-secret' });
  const forged = otherAuth.issueToken({ id: 1, username: 'alice' });
  const res = await call('GET', '/api/me', undefined, forged);
  assert.equal(res.status, 401);
});

/* -------------------------------- scores ------------------------------- */

test('POST /api/scores without a token is 401', async () => {
  const res = await call('POST', '/api/scores', { score: 100, wave: 1 });
  assert.equal(res.status, 401);
});

test('POST /api/scores with a token is 201 and updates personal best', async () => {
  const login = await call('POST', '/api/auth/login', {
    username: 'alice',
    password: 'correct-horse-1'
  });
  const token = login.body.token;

  const first = await call('POST', '/api/scores', { score: 1200, wave: 3 }, token);
  assert.equal(first.status, 201);
  assert.equal(first.body.accepted, true);
  assert.equal(first.body.score, 1200);
  assert.equal(first.body.personalBest.score, 1200);

  // A lower later score must not lower the personal best.
  const second = await call('POST', '/api/scores', { score: 300, wave: 1 }, token);
  assert.equal(second.status, 201);
  assert.equal(second.body.personalBest.score, 1200);

  const me = await call('GET', '/api/scores/me', undefined, token);
  assert.equal(me.status, 200);
  assert.equal(me.body.score, 1200);

  // Direct DB read agrees with the API.
  const dbBest = store.db
    .prepare('SELECT MAX(score) AS m FROM scores WHERE user_id = ?')
    .get(login.body.user.id);
  assert.equal(dbBest.m, 1200);
});

test('POST /api/scores rejects non-integer / out-of-range scores', async () => {
  const login = await call('POST', '/api/auth/login', {
    username: 'alice',
    password: 'correct-horse-1'
  });
  const token = login.body.token;

  const bad = [
    { score: 'abc', wave: 1 },
    { score: 12.5, wave: 1 },
    { score: -1, wave: 1 },
    { score: 10000000, wave: 1 },
    { score: null, wave: 1 },
    { score: 100, wave: 0 },
    { score: 100, wave: 1.5 },
    { score: 100, wave: 100000 },
    {}
  ];
  for (const body of bad) {
    const res = await call('POST', '/api/scores', body, token);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('GET /api/scores/me is {score:null} for a user with no runs', async () => {
  const reg = await call('POST', '/api/auth/register', {
    username: 'freshuser',
    password: 'freshpassword1'
  });
  const res = await call('GET', '/api/scores/me', undefined, reg.body.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.score, null);
});

/* ----------------------------- leaderboard ----------------------------- */

test('leaderboard is one row per user, sorted score DESC, limit-clamped', async () => {
  const players = [
    ['bravo', 5000],
    ['charlie', 9000],
    ['delta', 2000]
  ];
  for (const [name, score] of players) {
    const reg = await call('POST', '/api/auth/register', {
      username: name,
      password: `${name}-password-1`
    });
    assert.equal(reg.status, 201);
    // Two runs each -- only the best may appear.
    await call('POST', '/api/scores', { score: 10, wave: 1 }, reg.body.token);
    await call('POST', '/api/scores', { score, wave: 2 }, reg.body.token);
  }

  const lb = await call('GET', '/api/leaderboard?limit=100');
  assert.equal(lb.status, 200);
  const entries = lb.body.entries;

  // Sorted descending.
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i - 1].score >= entries[i].score, 'sorted desc');
  }
  // Ranks are 1..n.
  entries.forEach((e, i) => assert.equal(e.rank, i + 1));
  // One row per user.
  const names = entries.map((e) => e.username);
  assert.equal(new Set(names).size, names.length, 'no duplicate usernames');
  // Top entry is charlie/9000.
  assert.equal(entries[0].username, 'charlie');
  assert.equal(entries[0].score, 9000);

  // Matches a direct DB aggregate.
  const dbTop = store.db
    .prepare(
      'SELECT u.username AS username, MAX(s.score) AS score FROM scores s ' +
        'JOIN users u ON u.id = s.user_id GROUP BY s.user_id ' +
        'ORDER BY score DESC LIMIT 1'
    )
    .get();
  assert.equal(dbTop.username, entries[0].username);
  assert.equal(dbTop.score, entries[0].score);

  const capped = await call('GET', '/api/leaderboard?limit=2');
  assert.equal(capped.body.entries.length, 2);
  assert.equal(capped.body.entries[0].username, 'charlie');
});

test('leaderboard limit clamps to 1..100 and defaults to 10', async () => {
  assert.equal((await call('GET', '/api/leaderboard')).body.limit, 10);
  assert.equal((await call('GET', '/api/leaderboard?limit=0')).body.limit, 1);
  assert.equal((await call('GET', '/api/leaderboard?limit=-5')).body.limit, 1);
  assert.equal((await call('GET', '/api/leaderboard?limit=9999')).body.limit, 100);
});

test('leaderboard rejects a non-numeric limit with 400', async () => {
  const res = await call('GET', '/api/leaderboard?limit=abc');
  assert.equal(res.status, 400);
  const partial = await call('GET', '/api/leaderboard?limit=12abc');
  assert.equal(partial.status, 400);
});

test('leaderboard is public (no token needed)', async () => {
  const res = await fetch(`${base}/api/leaderboard`);
  assert.equal(res.status, 200);
});

/* --------------------------------- CORS -------------------------------- */

test('CORS allows the capacitor / localhost / null origins', async () => {
  for (const origin of ['capacitor://localhost', 'https://localhost', 'null']) {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: origin } });
    assert.equal(res.headers.get('access-control-allow-origin'), origin, origin);
  }
});

test('CORS does not echo an unlisted origin', async () => {
  const res = await fetch(`${base}/api/health`, {
    headers: { Origin: 'https://evil.example.com' }
  });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('OPTIONS preflight returns 204', async () => {
  const res = await fetch(`${base}/api/scores`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'capacitor://localhost',
      'Access-Control-Request-Method': 'POST'
    }
  });
  assert.equal(res.status, 204);
});

/* ------------------------------ robustness ----------------------------- */

test('malformed JSON body is 400, not 500', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json'
  });
  assert.equal(res.status, 400);
});

test('an oversized body is 413, not 500 (SRV-01)', async () => {
  // express.json({ limit: '16kb' }) -- 32KB of padding is comfortably over.
  const body = JSON.stringify({
    username: 'alice',
    password: 'correct-horse-1',
    padding: 'x'.repeat(32 * 1024)
  });
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
  assert.equal(res.status, 413);
  const json = await res.json();
  assert.equal(json.error, 'payload_too_large');
});

test('an unsupported charset is 415, not 500 (SRV-01)', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-32' },
    body: '{"username":"alice","password":"correct-horse-1"}'
  });
  assert.equal(res.status, 415);
  const json = await res.json();
  assert.equal(json.error, 'unsupported_charset');
});

test('unknown route is 404 JSON', async () => {
  const res = await call('GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

/* ----------------------------- rate limiting --------------------------- */

test('register rate limit returns 429 past the cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-invaders-rl-'));
  const rlStore = createStore(path.join(dir, 'rl.db'));
  const app = createApp({
    store: rlStore,
    auth: createAuth({ jwtSecret: TEST_SECRET, rounds: 4 }),
    rateLimit: { registerMax: 2, registerWindowMs: 60000 }
  });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/api/auth/register`;

  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `rl${i}`, password: 'password-123' })
    });
    statuses.push(res.status);
  }

  await new Promise((r) => srv.close(r));
  rlStore.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.deepEqual(statuses.slice(0, 2), [201, 201]);
  assert.equal(statuses[2], 429);
  assert.equal(statuses[3], 429);
});

/* ------------------------------ trust proxy ---------------------------- */

test('coerceTrustProxy turns env strings into what Express expects (SRV-02)', () => {
  assert.equal(coerceTrustProxy('1'), 1);
  assert.equal(coerceTrustProxy(' 2 '), 2);
  assert.equal(coerceTrustProxy('0'), 0);
  assert.equal(coerceTrustProxy('true'), true);
  assert.equal(coerceTrustProxy('TRUE'), true);
  assert.equal(coerceTrustProxy('false'), false);
  assert.equal(coerceTrustProxy('loopback'), 'loopback');
  assert.equal(coerceTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
});

test('createApp accepts TRUST_PROXY=1 / true / an IP list (SRV-02)', () => {
  for (const value of ['1', 'true', 'false', 'loopback', '10.0.0.0/8, loopback']) {
    const app = createApp({
      store,
      auth: createAuth({ jwtSecret: TEST_SECRET, rounds: 4 }),
      trustProxy: value
    });
    assert.ok(app, `TRUST_PROXY=${value} must not throw`);
  }
  // A hop count really is applied as a number, not as an IP list.
  const numeric = createApp({
    store,
    auth: createAuth({ jwtSecret: TEST_SECRET, rounds: 4 }),
    trustProxy: '2'
  });
  assert.equal(numeric.get('trust proxy'), 2);
});

test('an invalid TRUST_PROXY fails with a clear message (SRV-02)', () => {
  assert.throws(
    () =>
      createApp({
        store,
        auth: createAuth({ jwtSecret: TEST_SECRET, rounds: 4 }),
        trustProxy: 'not-an-ip-at-all'
      }),
    /TRUST_PROXY="not-an-ip-at-all" is not a valid Express trust-proxy setting/
  );
});

/* --------------------------- secret handling --------------------------- */

test('createAuth throws when NODE_ENV=production and JWT_SECRET is unset', () => {
  assert.throws(
    () => createAuth({ env: { NODE_ENV: 'production' } }),
    /JWT_SECRET/
  );
});

test('createAuth warns and falls back outside production', () => {
  const original = console.warn;
  let warned = '';
  console.warn = (msg) => {
    warned += String(msg);
  };
  try {
    const a = createAuth({ env: { NODE_ENV: 'development' } });
    assert.equal(a.usesInsecureFallbackSecret, true);
  } finally {
    console.warn = original;
  }
  assert.match(warned, /JWT_SECRET is not set/);
});
