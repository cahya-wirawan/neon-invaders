#!/usr/bin/env node
/* check-firebase-availability.js -- AC10: prove the runtime reality of this
 * environment (does firebase-admin resolve? is firebase-tools available
 * offline?) agrees with what server/README.md documents from the one-time
 * Phase 0 install/emulator probe, instead of letting stale prose drift away
 * from what actually works here.
 *
 * This is deliberately network-free: firebase-admin resolution is a plain
 * `require.resolve` against server/node_modules, and firebase-tools is probed
 * with `npx --no-install`, which only ever consults npm's local package
 * cache and fails fast (no download attempt) if nothing is cached.
 *
 *   node scripts/check-firebase-availability.js
 *
 * Exits 0 when the documented PHASE0_* markers in server/README.md match
 * what this run can independently observe; exits 1 and explains the mismatch
 * otherwise. Also prints which AC9 evidence path scripts/verify.sh is about
 * to use, so that claim is grounded in a check, not asserted in prose alone.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'server', 'README.md');

function fail(msg) {
  console.error('check-firebase-availability: FAIL -- ' + msg);
  process.exit(1);
}

function parseMarkers(text) {
  const markers = {};
  const re = /^PHASE0_([A-Z_]+)=(\S+)/gm;
  let m;
  while ((m = re.exec(text))) {
    markers[m[1]] = m[2];
  }
  return markers;
}

function probeFirebaseAdmin() {
  try {
    const p = require.resolve('firebase-admin', { paths: [path.join(ROOT, 'server')] });
    return { present: true, detail: p };
  } catch (err) {
    return { present: false, detail: err.message };
  }
}

function probeFirebaseTools() {
  // --no-install: consult npm's local cache only, never attempt a download.
  // A missing/uncached package fails this immediately instead of hanging on
  // a network fetch, which is exactly the offline-safe behaviour this check
  // needs.
  const res = spawnSync('npx', ['--no-install', 'firebase-tools', '--version'], {
    cwd: ROOT,
    timeout: 15000,
    encoding: 'utf8'
  });
  const version = res.status === 0 ? String(res.stdout || '').trim() : null;
  return { present: res.status === 0, version, detail: version || (res.stderr || res.error || '').toString().trim() };
}

function main() {
  if (!fs.existsSync(README)) {
    fail(`server/README.md not found at ${README} -- nothing to compare against.`);
  }
  const readmeText = fs.readFileSync(README, 'utf8');
  const documented = parseMarkers(readmeText);

  const requiredMarkers = ['FIREBASE_ADMIN', 'FIREBASE_TOOLS', 'EMULATOR_LIVE_RUN', 'JAVA'];
  const missing = requiredMarkers.filter((k) => !(k in documented));
  if (missing.length) {
    fail(
      `server/README.md is missing PHASE0_${missing.join('/PHASE0_')} marker line(s). ` +
        'Run the Phase 0 probe and record its result there (see "Phase 0 transcript").'
    );
  }

  const admin = probeFirebaseAdmin();
  const tools = probeFirebaseTools();

  console.log('Documented (server/README.md):');
  for (const k of requiredMarkers) {
    console.log(`  PHASE0_${k}=${documented[k]}`);
  }
  console.log('Observed (this run, right now):');
  console.log(`  firebase-admin resolvable: ${admin.present} (${admin.detail})`);
  console.log(`  firebase-tools available offline (npx --no-install): ${tools.present} (${tools.detail || 'n/a'})`);

  const problems = [];

  const adminClaim = documented.FIREBASE_ADMIN === 'installed';
  if (adminClaim !== admin.present) {
    problems.push(
      `README claims PHASE0_FIREBASE_ADMIN=${documented.FIREBASE_ADMIN} but firebase-admin ` +
        `resolvability is actually ${admin.present}.`
    );
  }

  const toolsClaim = documented.FIREBASE_TOOLS === 'installed';
  if (toolsClaim !== tools.present) {
    problems.push(
      `README claims PHASE0_FIREBASE_TOOLS=${documented.FIREBASE_TOOLS} but firebase-tools ` +
        `availability is actually ${tools.present}.`
    );
  }

  // Which AC9 evidence path is scripts/verify.sh entitled to claim, given what
  // is ACTUALLY available right now (not what README once recorded).
  let ac9Path;
  if (tools.present) {
    ac9Path = 'emulator (live firebase-tools Auth emulator, real minted tokens)';
  } else if (admin.present) {
    ac9Path =
      'admin-mode code path exercisable, but without a live emulator the only token ' +
      'source is a locally-signed test token (jwks-equivalent) -- not genuine Firebase ' +
      'issuance';
  } else {
    ac9Path = 'jwks (locally-generated RSA keypair; no real Firebase involvement at all)';
  }
  console.log(`\nAC9 evidence path available to scripts/verify.sh right now: ${ac9Path}`);

  if (problems.length) {
    console.error('\nMismatch between documented Phase 0 outcome and observed reality:');
    for (const p of problems) {
      console.error('  - ' + p);
    }
    console.error(
      '\nEither the environment changed since Phase 0 (a package was removed, the npx ' +
        'cache was cleared, ...) or server/README.md needs updating. Do not let ' +
        'verify.sh or any AC9 claim rest on stale prose.'
    );
    process.exit(1);
  }

  console.log('\ncheck-firebase-availability: PASS -- documented Phase 0 outcome matches this runtime.');
  process.exit(0);
}

main();
