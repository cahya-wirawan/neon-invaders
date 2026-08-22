/* app.js -- wires the store, auth helpers, CORS and routes into an Express
 * app. Exported as a factory so tests can build one over a throwaway DB. */
'use strict';

const express = require('express');
const { createStore } = require('./db');
const { createAuth } = require('./auth');
const { createAuthRoutes, createMeRoute } = require('./routes/auth');
const { createScoreRoutes } = require('./routes/scores');

/* Origins the mobile + web builds actually load from:
 *   capacitor://localhost  -> iOS WKWebView default
 *   http://localhost       -> Android WebView default (and any dev server)
 *   https://localhost      -> Android with androidScheme https (our config)
 * A file:// page sends `Origin: null`, and curl/native clients send no Origin
 * at all -- both are allowed because CORS is not a server-side authorisation
 * mechanism here; the bearer token is. */
const DEFAULT_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
  'http://localhost',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
  'null'
];

function buildAllowedOrigins(extra) {
  const list = DEFAULT_ORIGINS.slice();
  const raw = extra === undefined ? process.env.CORS_EXTRA_ORIGINS : extra;
  if (raw) {
    for (const o of String(raw).split(',')) {
      const trimmed = o.trim();
      if (trimmed && list.indexOf(trimmed) === -1) {
        list.push(trimmed);
      }
    }
  }
  return list;
}

function corsMiddleware(allowed) {
  const set = new Set(allowed);
  return function cors(req, res, next) {
    const origin = req.headers.origin;
    // No Origin header (curl, native HTTP client, same-origin) -- nothing to
    // negotiate, let it through untouched.
    if (origin && set.has(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    return next();
  };
}

/* Express compiles `trust proxy` eagerly and treats a STRING as a list of
 * trusted IPs/CIDRs -- so the two most natural operator inputs, TRUST_PROXY=1
 * and TRUST_PROXY=true, both throw ("invalid IP address"), because env vars are
 * always strings. Coerce them to the number/boolean Express actually wants and
 * pass anything else through as the IP/CIDR list it looks like. */
function coerceTrustProxy(value) {
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }
  const lower = raw.toLowerCase();
  if (lower === 'true') {
    return true;
  }
  if (lower === 'false') {
    return false;
  }
  return raw;
}

/* Body-parser (and any middleware that follows its convention) reports client
 * mistakes with a 4xx `status` and a machine-readable `type`. Those are routine
 * -- an oversized paste, a truncated upload -- and must answer with that status
 * and a warn-level one-liner, not a 500 with a stack trace. */
const CLIENT_ERROR_TYPES = {
  'entity.parse.failed': [400, 'bad_json', 'Request body is not valid JSON.'],
  'entity.too.large': [413, 'payload_too_large', 'Request body is too large.'],
  'entity.verify.failed': [403, 'bad_request', 'Request body failed verification.'],
  'request.aborted': [400, 'request_aborted', 'Request aborted before the body was received.'],
  'request.size.invalid': [400, 'bad_request', 'Request body size did not match Content-Length.'],
  'charset.unsupported': [415, 'unsupported_charset', 'Request body charset is not supported.'],
  'encoding.unsupported': [415, 'unsupported_encoding', 'Request body encoding is not supported.'],
  'parameters.too.many': [413, 'bad_request', 'Too many parameters in the request body.']
};

function clientErrorFor(err) {
  if (!err) {
    return null;
  }
  const raw = Number(err.status || err.statusCode);
  const status = Number.isInteger(raw) && raw >= 400 && raw < 500 ? raw : null;

  const known = CLIENT_ERROR_TYPES[err.type];
  if (known) {
    return { status: status || known[0], error: known[1], message: known[2] };
  }
  // A body-parser SyntaxError predates the `type` convention in some versions.
  if (err instanceof SyntaxError && (status === null || status === 400)) {
    return { status: 400, error: 'bad_json', message: 'Request body is not valid JSON.' };
  }
  if (status !== null) {
    // Never echo err.message: it is not ours and may quote request content.
    return { status, error: 'bad_request', message: 'Request could not be processed.' };
  }
  return null;
}

/* Shared by both error middlewares below. Returns true if it answered. */
function sendClientError(err, req, res) {
  const client = clientErrorFor(err);
  if (!client) {
    return false;
  }
  if (!res.headersSent) {
    res.status(client.status).json({ error: client.error, message: client.message });
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[neon-invaders] client error ${client.status} ${client.error} on ` +
      `${req.method} ${req.path}${err.type ? ` (${err.type})` : ''}`
  );
  return true;
}

function createApp(options) {
  const opts = options || {};
  const store = opts.store || createStore(opts.dbPath || ':memory:');
  const auth = opts.auth || createAuth(opts.authOptions);

  const app = express();
  app.disable('x-powered-by');
  // req.ip honours the proxy chain only when explicitly told to; otherwise a
  // spoofed X-Forwarded-For could be used to dodge the rate limiter.
  const rawTrustProxy =
    opts.trustProxy === undefined ? process.env.TRUST_PROXY : opts.trustProxy;
  if (rawTrustProxy !== undefined && String(rawTrustProxy).trim() !== '') {
    const trustProxy = coerceTrustProxy(rawTrustProxy);
    try {
      app.set('trust proxy', trustProxy);
    } catch (err) {
      throw new Error(
        `TRUST_PROXY="${String(rawTrustProxy)}" is not a valid Express ` +
          'trust-proxy setting. Use a hop count (e.g. 1), true/false, or a ' +
          'comma-separated list of trusted IPs/CIDRs/subnet names (e.g. ' +
          `"loopback, 10.0.0.0/8"). Express said: ${err && err.message}`
      );
    }
  }

  app.use(corsMiddleware(buildAllowedOrigins(opts.corsExtraOrigins)));
  app.use(express.json({ limit: '16kb' }));

  // Body-parser client errors (malformed JSON, oversized body, unsupported
  // charset/encoding) answer with their own 4xx instead of falling through to
  // the generic 500 handler.
  app.use((err, req, res, next) => {
    if (sendClientError(err, req, res)) {
      return undefined;
    }
    return next(err);
  });

  app.get('/api/health', (req, res) => {
    res.status(200).json({ ok: true, service: 'neon-invaders-server' });
  });

  app.use('/api/auth', createAuthRoutes(store, auth, opts.rateLimit));
  app.use('/api', createMeRoute(store, auth));
  app.use('/api', createScoreRoutes(store, auth));

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // A 4xx raised anywhere downstream is the client's mistake, not a fault:
    // answer with that status and a one-line warning, no stack trace.
    if (sendClientError(err, req, res)) {
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[neon-invaders] unhandled error:', err && err.stack ? err.stack : err);
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ error: 'internal_error' });
  });

  app.locals.store = store;
  app.locals.auth = auth;
  return app;
}

module.exports = {
  createApp,
  buildAllowedOrigins,
  coerceTrustProxy,
  clientErrorFor,
  DEFAULT_ORIGINS
};
