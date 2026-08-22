#!/usr/bin/env node
/* index.js -- process entry point. Reads env, refuses to start insecurely,
 * opens the on-disk DB and listens. */
'use strict';

const path = require('node:path');
const { createApp } = require('./app');
const { createStore } = require('./db');
const { createAuth } = require('./auth');

function loadDotEnv() {
  // Node >= 20.6 can load a .env without any dependency. Optional: absence of
  // the file (or of the API) is not an error.
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
    }
  } catch (err) {
    /* no .env -- env vars / defaults are used instead */
  }
}

function main() {
  loadDotEnv();

  const port = Number(process.env.PORT) || 3000;
  const dbPath = process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'neon-invaders.db');

  /* Replaces the old "refuse to start in production without JWT_SECRET"
   * check. This server no longer issues tokens, so there is no secret to
   * protect -- but without a project id it cannot check a token's audience,
   * and a verifier that accepts any audience accepts tokens minted by ANY
   * Firebase project. That is the production-fatal misconfiguration now. */
  const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
  if (!projectId && process.env.NODE_ENV === 'production') {
    console.error(
      '[neon-invaders] startup refused: FIREBASE_PROJECT_ID is not set and ' +
        'NODE_ENV=production. Without it no ID token can be checked against an ' +
        'audience, so tokens from any Firebase project would be accepted. ' +
        'See server/.env.example.'
    );
    process.exit(1);
    return;
  }
  if (!projectId) {
    console.warn(
      '[neon-invaders] WARNING: FIREBASE_PROJECT_ID is not set. Every ' +
        'authenticated request will be rejected with 401 until it is.'
    );
  }

  let auth;
  let store;
  try {
    auth = createAuth();
    // Throws IncompatibleDatabaseError on a legacy bcrypt-era database file.
    store = createStore(dbPath);
  } catch (err) {
    console.error('[neon-invaders] startup refused:', err.message);
    process.exit(1);
    return;
  }

  const app = createApp({ store, auth });

  const server = app.listen(port, () => {
    console.log(`[neon-invaders] listening on http://localhost:${port}`);
    console.log(`[neon-invaders] database: ${dbPath}`);
    console.log(`[neon-invaders] firebase project: ${projectId || '(unset)'}`);
    console.log(`[neon-invaders] token verification mode: ${auth.mode}`);
    if (auth.mode === 'emulator' || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
      console.log(
        `[neon-invaders] FIREBASE_AUTH_EMULATOR_HOST=${process.env.FIREBASE_AUTH_EMULATOR_HOST} ` +
          '-- emulator ID tokens are UNSIGNED. Never set this in production.'
      );
    }
  });

  function shutdown(signal) {
    console.log(`[neon-invaders] ${signal} -- shutting down`);
    server.close(() => {
      try {
        store.close();
      } catch (err) {
        /* already closed */
      }
      process.exit(0);
    });
    // Don't hang forever on a wedged keep-alive connection.
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main();
}

module.exports = { main };
