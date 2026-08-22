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
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const MAX_SCORE = 9999999;
const MAX_WAVE = 9999;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL CHECK (score >= 0 AND score <= ${MAX_SCORE}),
  wave        INTEGER NOT NULL CHECK (wave >= 1 AND wave <= ${MAX_WAVE}),
  achieved_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores (score DESC, achieved_at ASC);
CREATE INDEX IF NOT EXISTS idx_scores_user ON scores (user_id, score DESC);
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

function openDatabase(dbPath) {
  let db;
  if (dbPath === ':memory:') {
    db = new Database(':memory:');
  } else {
    const abs = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    db = new Database(abs);
  }
  db.exec(SCHEMA);
  return db;
}

/* Wraps a raw better-sqlite3 handle in the only operations the routes need,
 * so no route ever writes SQL of its own. */
function createStore(dbPath) {
  const db = openDatabase(dbPath);

  const stmt = {
    insertUser: db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ),
    userByName: db.prepare(
      'SELECT id, username, password_hash, created_at FROM users WHERE username = ? COLLATE NOCASE'
    ),
    userById: db.prepare(
      'SELECT id, username, created_at FROM users WHERE id = ?'
    ),
    insertScore: db.prepare(
      'INSERT INTO scores (user_id, score, wave) VALUES (?, ?, ?)'
    ),
    personalBest: db.prepare(PERSONAL_BEST_SQL),
    leaderboard: db.prepare(LEADERBOARD_SQL)
  };

  return {
    db,

    close() {
      db.close();
    },

    createUser(username, passwordHash) {
      const info = stmt.insertUser.run(username, passwordHash);
      return { id: Number(info.lastInsertRowid), username };
    },

    findUserByUsername(username) {
      return stmt.userByName.get(username) || null;
    },

    findUserById(id) {
      return stmt.userById.get(id) || null;
    },

    addScore(userId, score, wave) {
      const info = stmt.insertScore.run(userId, score, wave);
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

module.exports = { createStore, MAX_SCORE, MAX_WAVE, LEADERBOARD_SQL };
