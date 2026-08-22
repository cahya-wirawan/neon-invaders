#!/usr/bin/env node
/* sqlite-cli.js -- stand-in for the `sqlite3` command-line tool.
 *
 * WHY THIS EXISTS: the `sqlite3` CLI is NOT installed in this environment
 * (`command -v sqlite3` -> not found) and there is no package manager access
 * to add it. The acceptance criteria call for reading the database *directly*,
 * bypassing the API, to prove what is really stored.
 *
 * This deliberately uses Node's built-in `node:sqlite`, which is a DIFFERENT
 * driver from the better-sqlite3 the server writes with. So a read here is a
 * genuinely independent check of the file on disk, not the server's own code
 * marking its own homework.
 *
 *   node scripts/sqlite-cli.js <db-path> "<sql>"        # rows, pipe-separated
 *   node scripts/sqlite-cli.js <db-path> --dump         # every value in the DB
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');

function main() {
  const [dbPath, arg] = process.argv.slice(2);
  if (!dbPath || !arg) {
    console.error('usage: sqlite-cli.js <db-path> "<sql>" | --dump');
    process.exit(2);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (arg === '--dump') {
      // Every value of every column of every row, one per line. Used to prove
      // a plaintext password appears nowhere in the database.
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all();
      for (const { name } of tables) {
        for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
          for (const [col, value] of Object.entries(row)) {
            console.log(`${name}.${col}=${value === null ? '' : String(value)}`);
          }
        }
      }
    } else {
      for (const row of db.prepare(arg).all()) {
        console.log(Object.values(row).map((v) => (v === null ? '' : String(v))).join('|'));
      }
    }
  } finally {
    db.close();
  }
}

main();
