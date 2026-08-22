/* test/helpers/tokens.js -- mints Firebase-shaped ID tokens locally.
 *
 * NETWORK-FREE BY CONSTRUCTION. The RSA keypair is generated in-process and
 * fed to createVerifier via its `staticKeys` seam, so the `jwks` mode is
 * exercised for real (real RS256 signatures, real crypto.verify) without ever
 * contacting Google. Tokens minted here are NOT real Firebase tokens; the
 * opt-in test/emulator.test.js is the one that uses genuine emulator tokens.
 */
'use strict';

const crypto = require('node:crypto');

const TEST_KID = 'test-signing-key-1';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function makeKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  return {
    privateKey,
    publicKey,
    kid: TEST_KID,
    // createVerifier({ staticKeys }) accepts an SPKI public-key PEM exactly as
    // it accepts the X.509 cert PEMs Google publishes.
    staticKeys: { [TEST_KID]: publicKey.export({ type: 'spki', format: 'pem' }) }
  };
}

function claimsFor(projectId, overrides) {
  const now = Math.floor(Date.now() / 1000);
  return Object.assign(
    {
      aud: projectId,
      iss: 'https://securetoken.google.com/' + projectId,
      sub: 'firebase-uid-default',
      email: 'pilot@example.com',
      name: 'Ace Pilot',
      auth_time: now,
      iat: now,
      exp: now + 3600
    },
    overrides || {}
  );
}

/* A properly RS256-signed token for the `jwks` mode. */
function signRs256(keypair, claims) {
  const header = b64url({ alg: 'RS256', typ: 'JWT', kid: keypair.kid });
  const payload = b64url(claims);
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(header + '.' + payload, 'utf8'), keypair.privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

/* The shape a real Firebase Auth emulator actually emits: alg "none" and an
 * EMPTY signature segment. Confirmed against a live emulator -- see the
 * Phase 0 transcript in server/README.md. */
function unsignedEmulatorToken(claims) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`;
}

module.exports = { makeKeypair, claimsFor, signRs256, unsignedEmulatorToken, TEST_KID };
