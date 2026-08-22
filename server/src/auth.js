/* auth.js -- password hashing, JWT issue/verify, bearer middleware,
 * input validation and the in-memory rate limiter.
 *
 * Passwords: bcryptjs (pure JS -- no node-gyp / native bcrypt install risk).
 * Sessions: stateless JWT bearer tokens, NOT cookies. The mobile builds load
 * from capacitor://localhost, https://localhost and null (file://) origins,
 * where SameSite cookie semantics are unusable.
 */
'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

/* Dev-only fallback so `npm start` works with zero setup. It is deliberately
 * named to be obvious in a stack trace, log line or grep. It is NOT a secret
 * and must never be used off a developer laptop -- production startup is
 * refused when JWT_SECRET is unset (see resolveJwtSecret). */
const INSECURE_DEV_ONLY_JWT_SECRET =
  'neon-invaders-INSECURE-DEV-ONLY-FALLBACK-do-not-use-in-production';

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const PASSWORD_MIN = 8;
// bcrypt only reads the first 72 bytes; refuse longer rather than silently
// truncating (bcryptjs 3.x throws on >72 bytes anyway).
const PASSWORD_MAX = 72;

function resolveJwtSecret(env) {
  const e = env || process.env;
  const secret = (e.JWT_SECRET || '').trim();
  if (secret) {
    return secret;
  }
  if (e.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET is not set and NODE_ENV=production. Refusing to start with ' +
        'the insecure dev fallback. See server/.env.example.'
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[neon-invaders] WARNING: JWT_SECRET is not set. Falling back to ' +
      'INSECURE_DEV_ONLY_JWT_SECRET. Tokens are forgeable by anyone who has ' +
      'read this source file. Set JWT_SECRET before exposing this server.'
  );
  return INSECURE_DEV_ONLY_JWT_SECRET;
}

function createAuth(options) {
  const opts = options || {};
  const secret = opts.jwtSecret || resolveJwtSecret(opts.env);
  const expiresIn = opts.expiresIn || process.env.JWT_EXPIRES_IN || '30d';
  const rounds = Number(opts.rounds || process.env.BCRYPT_ROUNDS || 10);

  const effectiveRounds = Number.isFinite(rounds) ? rounds : 10;

  /* A real bcrypt hash of a value nobody can log in with, computed once per
   * auth instance at the SAME work factor as real passwords. /login compares
   * against it when the username does not exist, so "no such user" costs the
   * same wall-clock time as "wrong password" and the endpoint is genuinely not
   * a username oracle (SRV-05). */
  const dummyPasswordHash = bcrypt.hashSync(
    'dummy-password-for-timing',
    effectiveRounds
  );

  function hashPassword(plain) {
    return bcrypt.hash(plain, effectiveRounds);
  }

  function verifyPassword(plain, hash) {
    // A malformed/empty stored hash must resolve false, never throw.
    return bcrypt.compare(plain, hash).catch(() => false);
  }

  function issueToken(user) {
    return jwt.sign({ username: user.username }, secret, {
      subject: String(user.id),
      expiresIn,
      algorithm: 'HS256'
    });
  }

  function verifyToken(token) {
    try {
      return jwt.verify(token, secret, { algorithms: ['HS256'] });
    } catch (err) {
      return null;
    }
  }

  /* Express middleware. Requires `Authorization: Bearer <jwt>` and a user row
   * that still exists; sets req.user = { id, username }. */
  function requireAuth(store) {
    return function (req, res, next) {
      const header = req.get('authorization') || '';
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (!match) {
        return res
          .status(401)
          .json({ error: 'unauthorized', message: 'Missing bearer token.' });
      }
      const payload = verifyToken(match[1].trim());
      if (!payload || !payload.sub) {
        return res
          .status(401)
          .json({ error: 'unauthorized', message: 'Invalid or expired token.' });
      }
      const user = store.findUserById(Number(payload.sub));
      if (!user) {
        return res
          .status(401)
          .json({ error: 'unauthorized', message: 'Account no longer exists.' });
      }
      req.user = { id: user.id, username: user.username };
      return next();
    };
  }

  return {
    dummyPasswordHash,
    hashPassword,
    verifyPassword,
    issueToken,
    verifyToken,
    requireAuth,
    usesInsecureFallbackSecret: secret === INSECURE_DEV_ONLY_JWT_SECRET
  };
}

/* ------------------------------ validation ------------------------------ */

function validateCredentials(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];

  const username = typeof b.username === 'string' ? b.username.trim() : null;
  if (username === null || !USERNAME_RE.test(username)) {
    errors.push(
      'username must be 3-20 characters of A-Z, a-z, 0-9, underscore or hyphen'
    );
  }

  const password = typeof b.password === 'string' ? b.password : null;
  if (password === null) {
    errors.push('password must be a string');
  } else if (
    password.length < PASSWORD_MIN ||
    password.length > PASSWORD_MAX ||
    Buffer.byteLength(password, 'utf8') > PASSWORD_MAX
  ) {
    errors.push(
      `password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters (and at ` +
        `most ${PASSWORD_MAX} bytes)`
    );
  }

  return { ok: errors.length === 0, errors, username, password };
}

/* --------------------------- rate limiting ------------------------------ */

/* Deliberately in-memory: single-process, resets on restart, not a defence
 * against a distributed attacker. It exists to blunt trivial credential
 * stuffing / signup floods. A real deployment should put a proper limiter
 * (nginx, Cloudflare, redis-backed) in front. */
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
  validateCredentials,
  resolveJwtSecret,
  INSECURE_DEV_ONLY_JWT_SECRET,
  USERNAME_RE,
  PASSWORD_MIN,
  PASSWORD_MAX
};
