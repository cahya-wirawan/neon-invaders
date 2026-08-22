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

  let auth;
  try {
    // Throws when NODE_ENV=production and JWT_SECRET is unset.
    auth = createAuth();
  } catch (err) {
    console.error('[neon-invaders] startup refused:', err.message);
    process.exit(1);
    return;
  }

  const store = createStore(dbPath);
  const app = createApp({ store, auth });

  const server = app.listen(port, () => {
    console.log(`[neon-invaders] listening on http://localhost:${port}`);
    console.log(`[neon-invaders] database: ${dbPath}`);
    if (auth.usesInsecureFallbackSecret) {
      console.log('[neon-invaders] JWT secret: INSECURE DEV FALLBACK (set JWT_SECRET)');
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
