/* firebase.test.js -- token verification, mode selection, username derivation
 * and the legacy-database refusal.
 *
 * Everything here is offline and deterministic. `jwks` mode is driven with a
 * real locally-generated RSA keypair (real signatures, real crypto.verify);
 * `emulator` mode with the real unsigned-token shape; `admin` mode with a stub
 * loader, because a genuine Admin SDK path needs a Firebase project. The
 * opt-in test/emulator.test.js covers the real thing.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createVerifier, parseMaxAgeMs, decodeToken } = require('../src/firebase');
const { createAuth } = require('../src/auth');
const {
  createStore,
  deriveUsernameBase,
  suffixedUsername,
  IncompatibleDatabaseError
} = require('../src/db');
const { makeKeypair, claimsFor, signRs256, unsignedEmulatorToken } = require('./helpers/tokens');

const PROJECT = 'demo-neon-invaders';
const KEYS = makeKeypair();

function jwksVerifier(extra) {
  return createVerifier(
    Object.assign(
      {
        projectId: PROJECT,
        // Simulate firebase-admin being absent, which is what forces the
        // fallback modes to be reachable at all.
        adminLoader: () => null,
        staticKeys: KEYS.staticKeys,
        env: {}
      },
      extra || {}
    )
  );
}

/* --------------------------- mode selection ---------------------------- */

test('mode is "jwks" when firebase-admin is absent and no emulator is set', () => {
  assert.equal(jwksVerifier().mode, 'jwks');
});

test('mode is "emulator" when firebase-admin is absent but the emulator host is set', () => {
  const v = createVerifier({
    projectId: PROJECT,
    adminLoader: () => null,
    emulatorHost: '127.0.0.1:9099',
    env: {}
  });
  assert.equal(v.mode, 'emulator');
});

test('mode is "admin" when firebase-admin resolves and a project is configured', () => {
  const v = createVerifier({
    projectId: PROJECT,
    env: {},
    adminLoader: () => ({
      app: { initializeApp: () => ({}) },
      auth: { getAuth: () => ({ verifyIdToken: async () => claimsFor(PROJECT) }) }
    })
  });
  assert.equal(v.mode, 'admin');
});

test('admin mode takes precedence over the emulator host', () => {
  const v = createVerifier({
    projectId: PROJECT,
    emulatorHost: '127.0.0.1:9099',
    env: {},
    adminLoader: () => ({
      app: { initializeApp: () => ({}) },
      auth: { getAuth: () => ({ verifyIdToken: async () => claimsFor(PROJECT) }) }
    })
  });
  assert.equal(v.mode, 'admin');
});

test('mode is "jwks" when no project id is configured (admin cannot be used)', () => {
  const v = createVerifier({ projectId: '', env: {} });
  assert.equal(v.mode, 'jwks');
});

/* -------------------------- jwks verification --------------------------- */

test('jwks mode accepts a correctly signed token', async () => {
  const v = jwksVerifier();
  const claims = await v.verifyIdToken(signRs256(KEYS, claimsFor(PROJECT, { sub: 'uid-jwks' })));
  assert.equal(claims.uid, 'uid-jwks');
  assert.equal(claims.aud, PROJECT);
  assert.equal(claims.email, 'pilot@example.com');
});

test('jwks mode rejects a token signed by the wrong key', async () => {
  const other = makeKeypair();
  const forged = signRs256(
    { privateKey: other.privateKey, kid: KEYS.kid },
    claimsFor(PROJECT)
  );
  await assert.rejects(() => jwksVerifier().verifyIdToken(forged), /signature is invalid/);
});

test('jwks mode rejects an unknown key id', async () => {
  const other = makeKeypair();
  // A DIFFERENT kid, so the failure is "no such key" rather than "bad
  // signature" -- the two rejections are distinct code paths.
  const foreign = signRs256(
    { privateKey: other.privateKey, kid: 'some-other-kid' },
    claimsFor(PROJECT)
  );
  await assert.rejects(() => jwksVerifier().verifyIdToken(foreign), /unknown signing key id/);
});

test('jwks mode rejects "alg":"none" (algorithm confusion)', async () => {
  await assert.rejects(
    () => jwksVerifier().verifyIdToken(unsignedEmulatorToken(claimsFor(PROJECT))),
    /unsupported token algorithm/
  );
});

for (const [label, overrides, pattern] of [
  ['an expired token', { exp: Math.floor(Date.now() / 1000) - 10 }, /expired/],
  ['a wrong-audience token', { aud: 'some-other-project' }, /audience/],
  ['a wrong-issuer token', { iss: 'https://evil.example.com/x' }, /issuer/],
  ['a future-dated token', { iat: Math.floor(Date.now() / 1000) + 99999 }, /future/],
  ['a token with no subject', { sub: '' }, /subject/]
]) {
  test(`jwks mode rejects ${label}`, async () => {
    await assert.rejects(
      () => jwksVerifier().verifyIdToken(signRs256(KEYS, claimsFor(PROJECT, overrides))),
      pattern
    );
  });
}

for (const garbage of ['', 'garbage', 'a.b', 'a.b.c.d', '....', '!!!.???.###', 'null.null.null']) {
  test(`jwks mode rejects garbage token ${JSON.stringify(garbage)}`, async () => {
    await assert.rejects(() => jwksVerifier().verifyIdToken(garbage));
  });
}

test('a verifier with no project id rejects everything', async () => {
  const v = createVerifier({ projectId: '', env: {}, adminLoader: () => null });
  await assert.rejects(
    () => v.verifyIdToken(signRs256(KEYS, claimsFor(PROJECT))),
    /project id/
  );
});

/* ------------------------ emulator verification ------------------------- */

test('emulator mode accepts a real-shaped unsigned emulator token', async () => {
  const v = createVerifier({
    projectId: PROJECT,
    adminLoader: () => null,
    emulatorHost: '127.0.0.1:9099',
    env: {}
  });
  const claims = await v.verifyIdToken(unsignedEmulatorToken(claimsFor(PROJECT, { sub: 'uid-emu' })));
  assert.equal(claims.uid, 'uid-emu');
});

test('emulator mode still enforces audience and expiry', async () => {
  const v = createVerifier({
    projectId: PROJECT,
    adminLoader: () => null,
    emulatorHost: '127.0.0.1:9099',
    env: {}
  });
  await assert.rejects(
    () => v.verifyIdToken(unsignedEmulatorToken(claimsFor(PROJECT, { aud: 'other' }))),
    /audience/
  );
  await assert.rejects(
    () => v.verifyIdToken(unsignedEmulatorToken(claimsFor(PROJECT, { exp: 1 }))),
    /expired/
  );
});

test('emulator mode refuses a SIGNED token (never skips a real signature)', async () => {
  const v = createVerifier({
    projectId: PROJECT,
    adminLoader: () => null,
    emulatorHost: '127.0.0.1:9099',
    env: {}
  });
  await assert.rejects(
    () => v.verifyIdToken(signRs256(KEYS, claimsFor(PROJECT))),
    /only accepts unsigned emulator tokens/
  );
});

/* -------------------------- admin verification -------------------------- */

test('admin mode delegates to getAuth().verifyIdToken and re-checks claims', async () => {
  let seen = null;
  const v = createVerifier({
    projectId: PROJECT,
    env: {},
    adminLoader: () => ({
      app: { initializeApp: () => ({}) },
      auth: {
        getAuth: () => ({
          verifyIdToken: async (t) => {
            seen = t;
            return claimsFor(PROJECT, { sub: 'uid-admin' });
          }
        })
      }
    })
  });
  const claims = await v.verifyIdToken('opaque-token');
  assert.equal(seen, 'opaque-token');
  assert.equal(claims.uid, 'uid-admin');
});

test('admin mode re-rejects a wrong-audience token even if the SDK accepted it', async () => {
  const v = createVerifier({
    projectId: PROJECT,
    env: {},
    adminLoader: () => ({
      app: { initializeApp: () => ({}) },
      auth: {
        getAuth: () => ({ verifyIdToken: async () => claimsFor('a-different-project') })
      }
    })
  });
  await assert.rejects(() => v.verifyIdToken('x'), /audience/);
});

/* -------------------- requireAuth never becomes a 500 ------------------- */

test('requireAuth turns a THROWING verifier into 401, not 500', async () => {
  const auth = createAuth({
    projectId: PROJECT,
    verifier: {
      mode: 'jwks',
      projectId: PROJECT,
      verifyIdToken() {
        throw new Error('synchronous explosion');
      }
    }
  });
  const status = await runMiddleware(auth, { authorization: 'Bearer whatever' });
  assert.equal(status.code, 401);
  assert.equal(status.body.error, 'unauthorized');
});

test('requireAuth turns a REJECTING verifier (network down) into 401, not 500', async () => {
  const auth = createAuth({
    projectId: PROJECT,
    verifier: {
      mode: 'jwks',
      projectId: PROJECT,
      verifyIdToken: () => Promise.reject(new Error('getaddrinfo ENOTFOUND googleapis.com'))
    }
  });
  const status = await runMiddleware(auth, { authorization: 'Bearer whatever' });
  assert.equal(status.code, 401);
});

test('requireAuth rejects a missing/!bearer header with 401', async () => {
  const auth = createAuth({
    projectId: PROJECT,
    verifier: { mode: 'jwks', projectId: PROJECT, verifyIdToken: async () => claimsFor(PROJECT) }
  });
  assert.equal((await runMiddleware(auth, {})).code, 401);
  assert.equal((await runMiddleware(auth, { authorization: 'Basic abc' })).code, 401);
  assert.equal((await runMiddleware(auth, { authorization: 'Bearer' })).code, 401);
});

/* Minimal Express-shaped harness: enough req/res to drive the middleware
 * directly and observe whether it answered or called next(err). */
async function runMiddleware(auth, headers) {
  const store = {
    upsertUserByFirebaseUid: () => ({
      id: 1,
      firebase_uid: 'u',
      username: 'pilot',
      email: null
    })
  };
  const mw = auth.requireAuth(store);
  const out = { code: 0, body: null, nexted: false, nextErr: null };
  const res = {
    headersSent: false,
    status(c) {
      out.code = c;
      return this;
    },
    json(b) {
      out.body = b;
      return this;
    }
  };
  const req = { get: (k) => headers[k.toLowerCase()] };
  await mw(req, res, (err) => {
    out.nexted = true;
    out.nextErr = err || null;
  });
  return out;
}

/* ------------------------- username derivation -------------------------- */

test('username is derived from the display name, sanitised to the charset', () => {
  assert.equal(deriveUsernameBase('Ace Pilot', 'x@y.com', 'uid'), 'AcePilot');
  assert.equal(deriveUsernameBase('Zoë "Ace" Pilot!', null, 'uid'), 'ZoAcePilot');
});

test('username falls back to the email local-part', () => {
  assert.equal(deriveUsernameBase(null, 'commander@example.com', 'uid'), 'commander');
  assert.equal(deriveUsernameBase('   ', 'a.b_c@example.com', 'uid'), 'ab_c');
});

test('username falls back to a uid-stable name when nothing is usable', () => {
  const a = deriveUsernameBase(null, null, 'uid-xyz');
  const b = deriveUsernameBase('!!!', '@nolocalpart.com', 'uid-xyz');
  assert.match(a, /^pilot[0-9a-f]{8}$/);
  assert.equal(a, b, 'the same uid must always derive the same fallback name');
});

test('derived usernames always fit the 3-20 charset window', () => {
  for (const [name, email] of [
    ['A', null],
    ['ab', null],
    ['x'.repeat(200), null],
    [null, 'q@x.com'],
    [null, null]
  ]) {
    const u = deriveUsernameBase(name, email, 'uid-1');
    assert.ok(u.length >= 3 && u.length <= 20, `"${u}" is ${u.length} chars`);
    assert.match(u, /^[A-Za-z0-9_-]+$/);
  }
});

test('collision suffixes stay inside the 20-char budget', () => {
  assert.equal(suffixedUsername('pilot', 1), 'pilot');
  assert.equal(suffixedUsername('pilot', 2), 'pilot2');
  const long = 'x'.repeat(20);
  assert.equal(suffixedUsername(long, 12).length, 20);
});

test('two Firebase uids proposing the same username get distinct rows', () => {
  const store = createStore(':memory:');
  const a = store.upsertUserByFirebaseUid('uid-a', 'pilot@a.com', 'Pilot');
  const b = store.upsertUserByFirebaseUid('uid-b', 'pilot@b.com', 'Pilot');
  const c = store.upsertUserByFirebaseUid('uid-c', 'pilot@c.com', 'Pilot');
  assert.equal(a.username, 'Pilot');
  assert.equal(b.username, 'Pilot2');
  assert.equal(c.username, 'Pilot3');
  assert.notEqual(a.id, b.id);
  store.close();
});

test('upsert is idempotent and never renames an established account', () => {
  const store = createStore(':memory:');
  const first = store.upsertUserByFirebaseUid('uid-a', 'pilot@a.com', 'Pilot');
  const again = store.upsertUserByFirebaseUid('uid-a', 'newmail@a.com', 'Totally Different');
  assert.equal(again.id, first.id);
  assert.equal(again.username, 'Pilot');
  assert.equal(again.email, 'newmail@a.com', 'email is refreshed');
  store.close();
});

/* ----------------------- legacy-database refusal ------------------------ */

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-legacy-'));
  try {
    return fn(path.join(dir, 'legacy.db'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh database file opens cleanly and has the new schema', () => {
  withTempDb((file) => {
    const store = createStore(file);
    const cols = store.db
      .prepare('PRAGMA table_info(users)')
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes('firebase_uid'), 'firebase_uid present');
    assert.ok(!cols.includes('password_hash'), 'password_hash absent');
    const idx = store.db.prepare('PRAGMA index_list(users)').all();
    assert.ok(idx.length > 0);
    const runCols = store.db
      .prepare('PRAGMA table_info(runs)')
      .all()
      .map((c) => c.name);
    for (const c of ['run_token', 'user_id', 'started_ms', 'expires_ms', 'started_at', 'consumed_at']) {
      assert.ok(runCols.includes(c), `runs.${c} present`);
    }
    const scoreCols = store.db
      .prepare('PRAGMA table_info(scores)')
      .all()
      .map((c) => c.name);
    assert.ok(scoreCols.includes('run_id'), 'scores.run_id present');
    store.close();
  });
});

test('a legacy bcrypt-era database is REFUSED at startup, not migrated', () => {
  withTempDb((file) => {
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    legacy
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run('oldpilot', '$2b$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ');
    legacy.close();

    assert.throws(
      () => createStore(file),
      (err) => {
        assert.ok(err instanceof IncompatibleDatabaseError);
        assert.equal(err.code, 'INCOMPATIBLE_DATABASE');
        assert.match(err.message, /password_hash/);
        assert.match(err.message, /NO automatic migration/);
        assert.ok(err.message.includes(path.resolve(file)), 'names the db file');
        return true;
      }
    );

    // And it really did not touch the operator's data.
    const after = new Database(file, { readonly: true });
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    after.close();
  });
});

test('a non-empty users table with no firebase_uid is refused too', () => {
  withTempDb((file) => {
    const legacy = new Database(file);
    legacy.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);');
    legacy.prepare('INSERT INTO users (username) VALUES (?)').run('someone');
    legacy.close();
    assert.throws(() => createStore(file), /firebase_uid/);
  });
});

/* ------------------------------ cert cache ------------------------------ */

test('parseMaxAgeMs honours Cache-Control and clamps absurd values', () => {
  assert.equal(parseMaxAgeMs('public, max-age=3600'), 3600 * 1000);
  assert.equal(parseMaxAgeMs('max-age=1'), 60 * 1000, 'floored');
  assert.equal(parseMaxAgeMs('max-age=99999999'), 24 * 60 * 60 * 1000, 'ceilinged');
  assert.equal(parseMaxAgeMs(''), 60 * 60 * 1000, 'default');
  assert.equal(parseMaxAgeMs(null), 60 * 60 * 1000);
});

test('the cert store fetches once, caches, and refetches after max-age', async () => {
  let fetches = 0;
  // A REALISTIC clock: the claim gate compares exp/iat against it, so a fake
  // epoch would reject the token before the cache was ever exercised.
  let clock = Date.now();
  const other = makeKeypair();
  const v = createVerifier({
    projectId: PROJECT,
    adminLoader: () => null,
    env: {},
    now: () => clock,
    fetchImpl: async () => {
      fetches += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'public, max-age=120' },
        json: async () => other.staticKeys
      };
    }
  });
  const token = signRs256(other, claimsFor(PROJECT, { sub: 'uid-cached' }));
  assert.equal((await v.verifyIdToken(token)).uid, 'uid-cached');
  assert.equal(fetches, 1);
  await v.verifyIdToken(token);
  assert.equal(fetches, 1, 'second verify used the cache');
  clock += 121 * 1000;
  await v.verifyIdToken(token);
  assert.equal(fetches, 2, 'refetched once max-age elapsed');
});

test('a cert fetch failure rejects the token rather than accepting it', async () => {
  const v = createVerifier({
    projectId: PROJECT,
    adminLoader: () => null,
    env: {},
    fetchImpl: async () => {
      throw new Error('ENOTFOUND');
    }
  });
  await assert.rejects(() => v.verifyIdToken(signRs256(KEYS, claimsFor(PROJECT))), /ENOTFOUND/);
});

test('decodeToken refuses non-base64url segments', () => {
  assert.throws(() => decodeToken('aaa.bbb.ccc'));
  assert.throws(() => decodeToken('a b.c d.e f'));
});
