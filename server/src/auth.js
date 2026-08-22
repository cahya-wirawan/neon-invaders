/* auth.js -- bearer middleware over Firebase ID tokens, plus the in-memory
 * rate limiter.
 *
 * BREAKING CHANGE. This file used to hash passwords with bcryptjs and issue
 * its own HS256 JWTs. All of that is GONE -- there is no password, no
 * password_hash column, no JWT_SECRET, no /api/auth/register and no
 * /api/auth/login. Identity now comes from Firebase Auth: the browser signs
 * in against Google, and this server only ever VERIFIES the resulting ID
 * token. See server/README.md for the migration decision and its cost.
 *
 * Sessions are still stateless bearer tokens, NOT cookies, for the same
 * reason as before: the mobile builds load from capacitor://localhost,
 * https://localhost and null (file://) origins, where SameSite cookie
 * semantics are unusable.
 */
'use strict';

const { createVerifier } = require('./firebase');

/* Kept from the old file, repurposed: this is no longer a validator for a
 * user-supplied username (there is no signup form any more) but the charset
 * a username DERIVED from a Firebase profile is sanitised down to. */
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

function createAuth(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const projectId = String(
    opts.projectId === undefined ? env.FIREBASE_PROJECT_ID || '' : opts.projectId || ''
  ).trim();

  const verifier =
    opts.verifier ||
    createVerifier({
      projectId,
      emulatorHost: env.FIREBASE_AUTH_EMULATOR_HOST,
      env
    });

  function verifyIdToken(token) {
    // Always a rejected promise on failure, never a throw, so callers can use
    // one code path.
    try {
      return Promise.resolve(verifier.verifyIdToken(token));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function unauthorized(res, message) {
    if (res.headersSent) {
      return undefined;
    }
    return res.status(401).json({ error: 'unauthorized', message });
  }

  /* Express middleware. Requires `Authorization: Bearer <firebase id token>`.
   *
   * ASYNC, unlike the JWT version it replaces -- Firebase verification does
   * I/O (admin/jwks modes). Express 4 does NOT await a promise returned from
   * middleware, so an unhandled rejection here would hang the request and
   * crash the process on Node's default unhandledRejection behaviour. The
   * whole body is therefore inside one try/catch and this function can never
   * reject. Every failure -- malformed header, bad token, verifier throwing,
   * DNS failure while fetching Google's certs -- becomes 401, never 500. That
   * does mean an outage at Google is reported to the player as "signed out"
   * rather than "server problem"; see README.
   */
  function requireAuth(store) {
    return async function requireFirebaseAuth(req, res, next) {
      try {
        const header = req.get('authorization') || '';
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        if (!match) {
          return unauthorized(res, 'Missing bearer token.');
        }

        let claims;
        try {
          claims = await verifyIdToken(match[1].trim());
        } catch (err) {
          return unauthorized(res, 'Invalid or expired token.');
        }
        if (!claims || typeof claims.uid !== 'string' || !claims.uid) {
          return unauthorized(res, 'Invalid or expired token.');
        }

        // First sight of a Firebase uid creates the local row; later sights
        // reuse it. This is the only way a users row is ever created.
        const user = store.upsertUserByFirebaseUid(claims.uid, claims.email, claims.name);
        if (!user) {
          return unauthorized(res, 'Account could not be resolved.');
        }

        req.user = {
          id: user.id,
          firebase_uid: user.firebase_uid,
          username: user.username,
          email: user.email === undefined ? null : user.email
        };
        return next();
      } catch (err) {
        // A store failure is genuinely ours, so let the 500 handler see it --
        // but only for errors raised OUTSIDE token verification, which is
        // already fully handled above.
        return next(err);
      }
    };
  }

  return {
    verifyIdToken,
    requireAuth,
    mode: verifier.mode,
    projectId: verifier.projectId,
    emulatorHost: verifier.emulatorHost
  };
}

/* --------------------------- rate limiting ------------------------------ */

/* Deliberately in-memory: single-process, resets on restart, not a defence
 * against a distributed attacker. It exists to blunt trivial floods. A real
 * deployment should put a proper limiter (nginx, Cloudflare, redis-backed) in
 * front. Each call site builds its OWN instance, so buckets never share
 * counters -- run-start issuance and score submission are limited separately. */
function createRateLimiter(options) {
  const opts = options || {};
  const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : 900000;
  const max = Number(opts.max) > 0 ? Number(opts.max) : 10;
  const hits = new Map();

  function prune(now) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) {
        hits.delete(key);
      }
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    // Cheap unbounded-growth guard for a long-lived process.
    if (hits.size > 5000) {
      prune(now);
    }
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests. Try again later.',
        retryAfter
      });
    }
    return next();
  };
}

module.exports = {
  createAuth,
  createRateLimiter,
  USERNAME_RE
};
