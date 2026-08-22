/* db.js -- SQLite schema + every query the API needs.
 *
 * Driver: better-sqlite3. It was chosen over `sqlite3` (callback based) and
 * over the built-in `node:sqlite` because:
 *   - it installed cleanly here from a prebuilt binary (no node-gyp toolchain
 *     compile was required), and
 *   - `node:sqlite` still prints an ExperimentalWarning on Node 24 and its API
 *     is not frozen, which is a poor foundation for a server.
 * If a future environment cannot build better-sqlite3, `node:sqlite` is a
 * near drop-in (DatabaseSync has the same exec/prepare/run/get/all shape).
 *
 * BREAKING SCHEMA CHANGE. `users.password_hash` is gone and
 * `users.firebase_uid` replaces it as the identity column. There is NO
 * migration: an existing database written by the bcrypt/JWT version of this
 * server is REFUSED at startup with an explicit message rather than silently
 * migrated or dropped (see assertCompatibleSchema).
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const MAX_SCORE = 9999999;
const MAX_WAVE = 9999;

const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
// Bounded, so a pathological set of collisions cannot spin forever.
const USERNAME_COLLISION_TRIES = 50;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  firebase_uid TEXT    NOT NULL UNIQUE,
  username     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

/* One row per issued run token. started_ms/expires_ms are epoch milliseconds
 * recorded BY THE SERVER; no client timestamp is ever stored or trusted.
 * consumed_at NULL means "still submittable". */
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_token   TEXT    NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_ms  INTEGER NOT NULL,
  expires_ms  INTEGER NOT NULL,
  started_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id      INTEGER REFERENCES runs(id),
  score       INTEGER NOT NULL CHECK (score >= 0 AND score <= ${MAX_SCORE}),
  wave        INTEGER NOT NULL CHECK (wave >= 1 AND wave <= ${MAX_WAVE}),
  achieved_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores (score DESC, achieved_at ASC);
CREATE INDEX IF NOT EXISTS idx_scores_user ON scores (user_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_runs_user_open ON runs (user_id, consumed_at, expires_ms);
CREATE INDEX IF NOT EXISTS idx_runs_expiry ON runs (consumed_at, expires_ms);
`;

/* One row per user (their single best run), globally ranked.
 * ROW_NUMBER keeps the tie-break deterministic instead of relying on
 * SQLite's bare-column-with-MAX() behaviour. */
const LEADERBOARD_SQL = `
SELECT username, score, achieved_at FROM (
  SELECT u.username      AS username,
         s.score         AS score,
         s.achieved_at   AS achieved_at,
         ROW_NUMBER() OVER (
           PARTITION BY s.user_id
           ORDER BY s.score DESC, s.achieved_at ASC, s.id ASC
         ) AS rn
  FROM scores s
  JOIN users u ON u.id = s.user_id
)
WHERE rn = 1
ORDER BY score DESC, achieved_at ASC, username ASC
LIMIT ?
`;

const PERSONAL_BEST_SQL = `
SELECT score, wave, achieved_at
FROM scores
WHERE user_id = ?
ORDER BY score DESC, achieved_at ASC, id ASC
LIMIT 1
`;

/* ------------------------- legacy-schema refusal ------------------------ */

class IncompatibleDatabaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompatibleDatabaseError';
    this.code = 'INCOMPATIBLE_DATABASE';
  }
}

/* Runs BEFORE any DDL. `CREATE TABLE IF NOT EXISTS` would happily no-op over a
 * legacy `users` table and leave the server inserting into a schema with a
 * NOT NULL password_hash it can no longer fill -- failing later, at runtime,
 * per request. Fail here instead, loudly, and never touch the operator's data. */
function assertCompatibleSchema(db, label) {
  const hasUsers = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='users'")
    .get();
  if (!hasUsers) {
    return; // fresh database
  }

  const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const hasPasswordHash = columns.indexOf('password_hash') !== -1;
  const hasFirebaseUid = columns.indexOf('firebase_uid') !== -1;

  if (hasPasswordHash) {
    throw new IncompatibleDatabaseError(
      `The database at ${label} still has the legacy users.password_hash column. ` +
        'This server no longer uses passwords -- identity comes from Firebase Auth ' +
        '(users.firebase_uid). There is NO automatic migration and nothing here will ' +
        'delete your data. Delete or rename that file (and its -wal/-shm siblings) to ' +
        'start a fresh database, or point DB_PATH somewhere else. See server/README.md ' +
        '("Breaking migration").'
    );
  }

  if (!hasFirebaseUid) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    if (count && Number(count.n) > 0) {
      throw new IncompatibleDatabaseError(
        `The database at ${label} has a users table with ${count.n} row(s) but no ` +
          'firebase_uid column, so those accounts cannot be mapped onto Firebase ' +
          'identities. There is NO automatic migration and nothing here will delete ' +
          'your data. Delete or rename that file (and its -wal/-shm siblings), or point ' +
          'DB_PATH somewhere else. See server/README.md ("Breaking migration").'
      );
    }
  }
}

function openDatabase(dbPath) {
  let db;
  let label;
  if (dbPath === ':memory:') {
    db = new Database(':memory:');
    label = ':memory:';
  } else {
    const abs = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    db = new Database(abs);
    label = abs;
  }
  try {
    assertCompatibleSchema(db, label);
  } catch (err) {
    try {
      db.close();
    } catch (closeErr) {
      /* already closing */
    }
    throw err;
  }
  db.exec(SCHEMA);
  return db;
}

/* ---------------------------- username derivation ----------------------- */

/* Firebase gives us a display name and/or an email, neither guaranteed. Boil
 * whichever exists down to this project's historical username charset
 * (USERNAME_RE in auth.js: 3-20 of [A-Za-z0-9_-]). Deterministic, so the same
 * profile always proposes the same base name. */
function deriveUsernameBase(name, email, uid) {
  const candidates = [];
  if (typeof name === 'string' && name.trim()) {
    candidates.push(name.trim());
  }
  if (typeof email === 'string' && email.indexOf('@') > 0) {
    candidates.push(email.slice(0, email.indexOf('@')));
  }
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[^A-Za-z0-9_-]/g, '').slice(0, USERNAME_MAX);
    if (cleaned.length >= USERNAME_MIN) {
      return cleaned;
    }
    if (cleaned.length > 0) {
      // Too short after sanitising ("A.", CJK-only display names): keep the
      // usable part and pad rather than discarding the player's identity.
      return (cleaned + 'pilot').slice(0, USERNAME_MAX);
    }
  }
  // Nothing usable at all -- fall back to something stable per uid.
  const digest = crypto
    .createHash('sha256')
    .update(String(uid || ''))
    .digest('hex')
    .slice(0, 8);
  return ('pilot' + digest).slice(0, USERNAME_MAX);
}

/* base, base2, base3, ... The suffix is appended inside the 20-char budget by
 * trimming the base, so a 20-char name still collides gracefully. */
function suffixedUsername(base, n) {
  if (n <= 1) {
    return base;
  }
  const suffix = String(n);
  return base.slice(0, Math.max(1, USERNAME_MAX - suffix.length)) + suffix;
}

/* Wraps a raw better-sqlite3 handle in the only operations the routes need,
 * so no route ever writes SQL of its own. */
function createStore(dbPath) {
  const db = openDatabase(dbPath);

  const stmt = {
    insertUser: db.prepare(
      'INSERT INTO users (firebase_uid, username, email) VALUES (?, ?, ?)'
    ),
    userByFirebaseUid: db.prepare(
      'SELECT id, firebase_uid, username, email, created_at FROM users WHERE firebase_uid = ?'
    ),
    userByName: db.prepare(
      'SELECT id, firebase_uid, username, email, created_at FROM users WHERE username = ? COLLATE NOCASE'
    ),
    userById: db.prepare(
      'SELECT id, firebase_uid, username, email, created_at FROM users WHERE id = ?'
    ),
    updateEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),

    insertScore: db.prepare(
      'INSERT INTO scores (user_id, run_id, score, wave) VALUES (?, ?, ?, ?)'
    ),
    personalBest: db.prepare(PERSONAL_BEST_SQL),
    leaderboard: db.prepare(LEADERBOARD_SQL),

    insertRun: db.prepare(
      'INSERT INTO runs (run_token, user_id, started_ms, expires_ms) VALUES (?, ?, ?, ?)'
    ),
    runByToken: db.prepare(
      'SELECT id, run_token, user_id, started_ms, expires_ms, started_at, consumed_at ' +
        'FROM runs WHERE run_token = ?'
    ),
    runById: db.prepare(
      'SELECT id, run_token, user_id, started_ms, expires_ms, started_at, consumed_at ' +
        'FROM runs WHERE id = ?'
    ),
    activeRunForUser: db.prepare(
      'SELECT id, run_token, user_id, started_ms, expires_ms, started_at, consumed_at ' +
        'FROM runs WHERE user_id = ? AND consumed_at IS NULL AND expires_ms > ? ' +
        'ORDER BY id DESC LIMIT 1'
    ),
    consumeRun: db.prepare('UPDATE runs SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL'),
    purgeRuns: db.prepare('DELETE FROM runs WHERE consumed_at IS NULL AND expires_ms <= ?'),
    countRuns: db.prepare('SELECT COUNT(*) AS n FROM runs')
  };

  /* Single-use consumption and the score insert are ONE transaction, and the
   * UPDATE is guarded by `consumed_at IS NULL`. Two concurrent submits of the
   * same token therefore cannot both write a score: the loser's UPDATE reports
   * changes === 0 and the whole transaction is abandoned. */
  const consumeAndScore = db.transaction((runId, userId, score, wave, nowIso) => {
    const info = stmt.consumeRun.run(nowIso, runId);
    if (info.changes !== 1) {
      return { ok: false, reason: 'run_already_used' };
    }
    const scoreInfo = stmt.insertScore.run(userId, runId, score, wave);
    return { ok: true, scoreId: Number(scoreInfo.lastInsertRowid) };
  });

  return {
    db,

    close() {
      db.close();
    },

    /* ------------------------------ users ------------------------------ */

    /* The ONLY way a user row is created. Called on every authenticated
     * request from auth.js, so it must be cheap and idempotent. */
    upsertUserByFirebaseUid(uid, email, name) {
      const firebaseUid = String(uid || '');
      if (!firebaseUid) {
        return null;
      }
      const normalisedEmail =
        typeof email === 'string' && email.trim() ? email.trim() : null;

      const existing = stmt.userByFirebaseUid.get(firebaseUid);
      if (existing) {
        // Keep the email fresh (the player may have changed it in Firebase)
        // but NEVER rename an established account behind the player's back.
        if (normalisedEmail && existing.email !== normalisedEmail) {
          stmt.updateEmail.run(normalisedEmail, existing.id);
          existing.email = normalisedEmail;
        }
        return existing;
      }

      const base = deriveUsernameBase(name, normalisedEmail, firebaseUid);
      for (let n = 1; n <= USERNAME_COLLISION_TRIES; n += 1) {
        const candidate = suffixedUsername(base, n);
        try {
          const info = stmt.insertUser.run(firebaseUid, candidate, normalisedEmail);
          return {
            id: Number(info.lastInsertRowid),
            firebase_uid: firebaseUid,
            username: candidate,
            email: normalisedEmail,
            created_at: null
          };
        } catch (err) {
          if (!String(err && err.code).startsWith('SQLITE_CONSTRAINT')) {
            throw err;
          }
          // Lost a race on firebase_uid -- another request just created the
          // same account. Use theirs.
          const raced = stmt.userByFirebaseUid.get(firebaseUid);
          if (raced) {
            return raced;
          }
          // Otherwise it was the username that collided: try the next suffix.
        }
      }
      // Exhausted the polite names; fall back to something unique by
      // construction rather than failing the player's request.
      const fallback = ('u' + crypto.randomBytes(9).toString('base64url')).slice(0, USERNAME_MAX);
      const info = stmt.insertUser.run(firebaseUid, fallback, normalisedEmail);
      return {
        id: Number(info.lastInsertRowid),
        firebase_uid: firebaseUid,
        username: fallback,
        email: normalisedEmail,
        created_at: null
      };
    },

    findUserByFirebaseUid(uid) {
      return stmt.userByFirebaseUid.get(String(uid || '')) || null;
    },

    findUserByUsername(username) {
      return stmt.userByName.get(username) || null;
    },

    findUserById(id) {
      return stmt.userById.get(id) || null;
    },

    /* ------------------------------- runs ------------------------------ */

    createRun(userId, startedMs, expiresMs) {
      const token = crypto.randomBytes(24).toString('base64url');
      const info = stmt.insertRun.run(token, userId, startedMs, expiresMs);
      return stmt.runById.get(Number(info.lastInsertRowid));
    },

    findRunByToken(token) {
      if (typeof token !== 'string' || !token) {
        return null;
      }
      return stmt.runByToken.get(token) || null;
    },

    /* The dedup source for POST /api/runs/start: an unconsumed, unexpired run
     * this user already holds. */
    findActiveRunForUser(userId, nowMs) {
      return stmt.activeRunForUser.get(userId, nowMs) || null;
    },

    consumeRunAndAddScore(runId, userId, score, wave, nowIso) {
      return consumeAndScore(runId, userId, score, wave, nowIso || new Date().toISOString());
    },

    /* Opportunistic cleanup. Called on run-start and score-submit -- no timer,
     * no background job, nothing to leak in a test process. */
    purgeExpiredRuns(nowMs) {
      return Number(stmt.purgeRuns.run(nowMs).changes) || 0;
    },

    countRuns() {
      const row = stmt.countRuns.get();
      return row ? Number(row.n) : 0;
    },

    /* ------------------------------ scores ----------------------------- */

    addScore(userId, score, wave, runId) {
      const info = stmt.insertScore.run(
        userId,
        runId === undefined ? null : runId,
        score,
        wave
      );
      return Number(info.lastInsertRowid);
    },

    personalBest(userId) {
      return stmt.personalBest.get(userId) || null;
    },

    leaderboard(limit) {
      const rows = stmt.leaderboard.all(limit);
      return rows.map((row, i) => ({
        rank: i + 1,
        username: row.username,
        score: row.score,
        achieved_at: row.achieved_at
      }));
    }
  };
}

module.exports = {
  createStore,
  openDatabase,
  assertCompatibleSchema,
  IncompatibleDatabaseError,
  deriveUsernameBase,
  suffixedUsername,
  MAX_SCORE,
  MAX_WAVE,
  USERNAME_MIN,
  USERNAME_MAX,
  LEADERBOARD_SQL
};
