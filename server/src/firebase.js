/* firebase.js -- Firebase ID token verification, with three resolution modes.
 *
 * This replaces the old hand-rolled HS256 JWT system entirely. The server no
 * longer issues tokens at all; it only VERIFIES tokens that Firebase Auth
 * issued to the browser.
 *
 * WHY THREE MODES. `firebase-admin` is a 200-package dependency that needs
 * ambient Google credentials to do anything useful. A server that hard-required
 * it could not run in CI, in a container with no service account, or against
 * the local emulator. So the verifier picks, ONCE at construction, from:
 *
 *   "admin"     firebase-admin resolved AND a project id is configured ->
 *               getAuth(app).verifyIdToken(). This is the production path and
 *               it also handles the emulator (the SDK reads
 *               FIREBASE_AUTH_EMULATOR_HOST itself and skips the signature).
 *   "emulator"  firebase-admin is absent but FIREBASE_AUTH_EMULATOR_HOST is
 *               set. Emulator ID tokens are genuinely UNSIGNED -- the emulator
 *               mints `{"alg":"none","typ":"JWT"}` with an EMPTY signature
 *               segment, by design (verified empirically; see server/README.md
 *               "Phase 0 transcript"). So there is nothing to verify
 *               cryptographically and claim validation is the whole job --
 *               exactly what the Admin SDK does in this situation.
 *   "jwks"      neither of the above: verify RS256 by hand against Google's
 *               public `securetoken@system` X.509 certs, fetched and cached
 *               per Cache-Control: max-age.
 *
 * The precedence is admin > emulator > jwks, matching the numbering above.
 *
 * EVERY mode validates the same claim set:
 *   aud === projectId
 *   iss === https://securetoken.google.com/<projectId>
 *   exp >  now
 *   iat <= now + clockSkewSeconds
 *   sub is a non-empty string
 *
 * Nothing here ever throws out of `verifyIdToken` for an untrusted token --
 * it rejects with an Error, and auth.js turns every rejection into a 401.
 * `require('firebase-admin')` is LAZY and wrapped in try/catch so the module
 * loads fine when the optional dependency is not installed.
 */
'use strict';

const crypto = require('node:crypto');

const GOOGLE_CERT_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const DEFAULT_CLOCK_SKEW_SECONDS = 60;
// Floor/ceiling for however long we honour a Cache-Control: max-age.
const MIN_CERT_TTL_MS = 60 * 1000;
const MAX_CERT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CERT_TTL_MS = 60 * 60 * 1000;

function issuerFor(projectId) {
  return 'https://securetoken.google.com/' + projectId;
}

/* ------------------------------- JWT bits ------------------------------- */

function b64urlToBuffer(segment) {
  if (typeof segment !== 'string') {
    throw new Error('malformed token segment');
  }
  // Buffer's base64url decoder is lenient; reject anything outside the
  // alphabet explicitly so garbage cannot decode to "valid-looking" bytes.
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new Error('malformed token segment');
  }
  return Buffer.from(segment, 'base64url');
}

function decodeJson(segment) {
  const parsed = JSON.parse(b64urlToBuffer(segment).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('malformed token segment');
  }
  return parsed;
}

/* Splits and JSON-decodes without verifying anything. */
function decodeToken(token) {
  if (typeof token !== 'string' || !token) {
    throw new Error('token is not a string');
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('token does not have three segments');
  }
  return {
    header: decodeJson(parts[0]),
    payload: decodeJson(parts[1]),
    signature: parts[2],
    signingInput: parts[0] + '.' + parts[1]
  };
}

/* The shared claim gate. Every mode runs this, including "admin" (belt and
 * braces: the SDK checks the same things, but the audience check in
 * particular is the one that stops a token minted for a DIFFERENT Firebase
 * project from being accepted here). */
function assertClaims(payload, projectId, nowSeconds, skewSeconds) {
  if (!projectId) {
    throw new Error('no Firebase project id is configured');
  }
  if (payload.aud !== projectId) {
    throw new Error('token audience is not this project');
  }
  if (payload.iss !== issuerFor(projectId)) {
    throw new Error('token issuer is not this project');
  }
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= nowSeconds) {
    throw new Error('token has expired');
  }
  const iat = Number(payload.iat);
  if (!Number.isFinite(iat) || iat > nowSeconds + skewSeconds) {
    throw new Error('token was issued in the future');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('token has no subject');
  }
  return payload;
}

/* Normalises whatever a mode produced into the one shape auth.js consumes. */
function shapeClaims(payload) {
  return {
    uid: payload.sub,
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    name: typeof payload.name === 'string' ? payload.name : null,
    aud: payload.aud,
    iss: payload.iss,
    exp: Number(payload.exp),
    iat: Number(payload.iat)
  };
}

/* ------------------------------ cert cache ------------------------------ */

function parseMaxAgeMs(cacheControl) {
  const m = /max-age\s*=\s*(\d+)/i.exec(String(cacheControl || ''));
  if (!m) {
    return DEFAULT_CERT_TTL_MS;
  }
  const ms = Number(m[1]) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) {
    return DEFAULT_CERT_TTL_MS;
  }
  return Math.min(MAX_CERT_TTL_MS, Math.max(MIN_CERT_TTL_MS, ms));
}

/* Google publishes a flat {kid: <X.509 PEM>} object. Tests inject the same
 * shape with an SPKI public-key PEM instead -- crypto.createPublicKey accepts
 * both, so no test needs the network. */
function createCertStore(options) {
  const opts = options || {};
  const staticKeys = opts.staticKeys || null;
  const url = opts.url || GOOGLE_CERT_URL;
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const now = opts.now || Date.now;

  let cache = null;      // { keys: Map<kid, KeyObject>, expiresMs }
  let inFlight = null;   // de-duplicates concurrent refreshes

  function toKeyMap(raw) {
    const keys = new Map();
    for (const kid of Object.keys(raw || {})) {
      try {
        keys.set(kid, crypto.createPublicKey(raw[kid]));
      } catch (err) {
        /* one unusable cert must not poison the whole set */
      }
    }
    if (keys.size === 0) {
      throw new Error('no usable signing certificates');
    }
    return keys;
  }

  if (staticKeys) {
    const keys = toKeyMap(staticKeys);
    return {
      async get(kid) {
        const key = keys.get(kid);
        if (!key) {
          throw new Error('unknown signing key id');
        }
        return key;
      }
    };
  }

  async function refresh() {
    if (!fetchImpl) {
      throw new Error('no fetch() available to load signing certificates');
    }
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res || !res.ok) {
      throw new Error(
        'could not load signing certificates (HTTP ' + ((res && res.status) || 0) + ')'
      );
    }
    const body = await res.json();
    const keys = toKeyMap(body);
    const ttl = parseMaxAgeMs(res.headers && res.headers.get && res.headers.get('cache-control'));
    cache = { keys, expiresMs: now() + ttl };
    return keys;
  }

  return {
    async get(kid) {
      if (cache && cache.expiresMs > now() && cache.keys.has(kid)) {
        return cache.keys.get(kid);
      }
      if (!inFlight) {
        inFlight = refresh().finally(() => {
          inFlight = null;
        });
      }
      const keys = await inFlight;
      const key = keys.get(kid);
      if (!key) {
        throw new Error('unknown signing key id');
      }
      return key;
    }
  };
}

/* --------------------------- firebase-admin ----------------------------- */

/* Lazy, guarded, and never at module top level: the whole point of the
 * optionalDependency is that the server still boots when it is absent. */
function defaultAdminLoader() {
  try {
    // eslint-disable-next-line global-require
    const app = require('firebase-admin/app');
    // eslint-disable-next-line global-require
    const auth = require('firebase-admin/auth');
    if (!app || typeof app.initializeApp !== 'function') {
      return null;
    }
    if (!auth || typeof auth.getAuth !== 'function') {
      return null;
    }
    return { app, auth };
  } catch (err) {
    return null;
  }
}

let adminAppSeq = 0;

/* --------------------------- the verifier ------------------------------- */

function createVerifier(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const projectId = String(
    opts.projectId === undefined ? env.FIREBASE_PROJECT_ID || '' : opts.projectId || ''
  ).trim();
  const emulatorHost = String(
    opts.emulatorHost === undefined
      ? env.FIREBASE_AUTH_EMULATOR_HOST || ''
      : opts.emulatorHost || ''
  ).trim();
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const skewSeconds = Number.isFinite(opts.clockSkewSeconds)
    ? Number(opts.clockSkewSeconds)
    : DEFAULT_CLOCK_SKEW_SECONDS;

  const loadAdmin = typeof opts.adminLoader === 'function' ? opts.adminLoader : defaultAdminLoader;

  let mode;
  let adminAuth = null;
  let certStore = null;

  const admin = projectId ? loadAdmin() : null;
  if (admin && projectId) {
    mode = 'admin';
  } else if (emulatorHost) {
    mode = 'emulator';
  } else {
    mode = 'jwks';
  }

  if (mode === 'admin') {
    // A named app keeps this from colliding with any default app the host
    // process may already have initialised.
    adminAppSeq += 1;
    const app = admin.app.initializeApp({ projectId }, 'neon-invaders-' + adminAppSeq);
    adminAuth = admin.auth.getAuth(app);
  }

  if (mode === 'jwks') {
    certStore = createCertStore({
      staticKeys: opts.staticKeys || null,
      url: opts.certUrl,
      fetchImpl: opts.fetchImpl,
      now
    });
  }

  async function verifyViaAdmin(token) {
    // The SDK rejects on anything wrong (bad signature, expired, wrong
    // audience). We re-assert the claims anyway so all three modes are
    // provably identical from the caller's point of view.
    const decoded = await adminAuth.verifyIdToken(token);
    return assertClaims(decoded, projectId, Math.floor(now() / 1000), skewSeconds);
  }

  function verifyViaEmulator(token) {
    const { header, payload, signature } = decodeToken(token);
    // Refuse to treat a SIGNED token as an emulator token: if someone points a
    // production token at an emulator-mode server we must not skip the
    // signature check silently.
    if (header.alg !== 'none' || signature !== '') {
      throw new Error('emulator mode only accepts unsigned emulator tokens');
    }
    return assertClaims(payload, projectId, Math.floor(now() / 1000), skewSeconds);
  }

  async function verifyViaJwks(token) {
    const { header, payload, signature, signingInput } = decodeToken(token);
    if (header.alg !== 'RS256') {
      throw new Error('unsupported token algorithm');
    }
    if (typeof header.kid !== 'string' || !header.kid) {
      throw new Error('token has no key id');
    }
    if (!signature) {
      throw new Error('token is not signed');
    }
    const key = await certStore.get(header.kid);
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(signingInput, 'utf8'),
      key,
      b64urlToBuffer(signature)
    );
    if (!ok) {
      throw new Error('token signature is invalid');
    }
    return assertClaims(payload, projectId, Math.floor(now() / 1000), skewSeconds);
  }

  /* Rejects (never returns a falsy "failure value") so a caller cannot forget
   * to check. auth.js turns every rejection into a 401. */
  async function verifyIdToken(token) {
    if (!projectId) {
      throw new Error('no Firebase project id is configured');
    }
    let claims;
    if (mode === 'admin') {
      claims = await verifyViaAdmin(token);
    } else if (mode === 'emulator') {
      claims = verifyViaEmulator(token);
    } else {
      claims = await verifyViaJwks(token);
    }
    return shapeClaims(claims);
  }

  return {
    mode,
    projectId,
    emulatorHost,
    verifyIdToken
  };
}

module.exports = {
  createVerifier,
  createCertStore,
  decodeToken,
  assertClaims,
  parseMaxAgeMs,
  issuerFor,
  GOOGLE_CERT_URL,
  DEFAULT_CLOCK_SKEW_SECONDS
};
