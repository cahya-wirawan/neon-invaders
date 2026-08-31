#!/usr/bin/env node
/* check-net.js -- headless proof that js/net.js degrades safely.
 *
 * No dependencies, no browser, no jsdom. js/net.js is a plain IIFE whose only
 * free variables are window / document / localStorage / fetch /
 * AbortController / console, so it can be loaded through `new Function` with
 * those supplied as parameters. Running it in the host realm (rather than a
 * vm context) means the promises it creates are OUR promises, so Node's
 * process-level 'unhandledRejection' hook really does see them.
 *
 * Scenarios driven: no server configured, fetch missing, fetch throwing
 * synchronously, fetch rejecting (offline), fetch returning a non-promise,
 * HTTP 500 with a JSON body, HTTP 200 with a non-JSON body, a body whose
 * .text() rejects, a request that never settles (timeout), localStorage that
 * throws on every access, and the game-over setState hook.
 *
 *   node scripts/check-net.js      -> exit 0 on success, 1 on any failure
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NET_JS = path.resolve(__dirname, '..', 'js', 'net.js');
const SOURCE = fs.readFileSync(NET_JS, 'utf8');

let failures = 0;
let checks = 0;
const problems = [];

function record(kind, message) {
  problems.push(`${kind}: ${message}`);
  failures += 1;
}

process.on('unhandledRejection', (reason) => {
  record('UNHANDLED REJECTION', String((reason && reason.stack) || reason));
});
process.on('uncaughtException', (err) => {
  record('UNCAUGHT EXCEPTION', String((err && err.stack) || err));
});

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`);
    record('CHECK FAILED', name + (detail ? ' -- ' + detail : ''));
  }
}

/* ----------------------------- DOM stubs ------------------------------- */

function makeDocument() {
  const byId = new Map();
  /* Every <script> node that net.js appends anywhere in this document, in
   * order. The opt-in invariant (AC11) is asserted against this: at boot it
   * must stay EMPTY, and the Firebase CDN tags may appear only after an
   * explicit panel-open or sign-in. */
  const scripts = [];

  function indexTree(node) {
    if (!node || typeof node !== 'object') return;
    if (node.id) byId.set(node.id, node);
    if (node.tagName === 'SCRIPT') scripts.push(node);
    (node.childNodes || []).forEach(indexTree);
  }

  function makeElement(tagName) {
    const styleObj = {};
    const node = {
      tagName: String(tagName).toUpperCase(),
      nodeName: String(tagName).toUpperCase(),
      id: '',
      className: '',
      type: '',
      value: '',
      src: '',
      async: false,
      onload: null,
      onerror: null,
      disabled: false,
      textContent: '',
      childNodes: [],
      get style() { return styleObj; },
      set style(v) {
        throw new TypeError("Cannot assign to read only property 'style' of object");
      },
      parentNode: null,
      listeners: [],
      setAttribute(k, v) { node[k] = v; },
      getAttribute(k) { return node[k]; },
      get firstChild() {
        return this.childNodes.length ? this.childNodes[0] : null;
      },
      appendChild(child) {
        child.parentNode = node;
        node.childNodes.push(child);
        indexTree(child);
        return child;
      },
      removeChild(child) {
        const i = node.childNodes.indexOf(child);
        if (i >= 0) node.childNodes.splice(i, 1);
        if (child.id) byId.delete(child.id);
        return child;
      },
      contains(other) {
        if (other === node) return true;
        for (const c of node.childNodes) {
          if (c === other || (c.contains && c.contains(other))) return true;
        }
        return false;
      },
      addEventListener(type, fn, capture) {
        node.listeners.push({ type, fn, capture: !!capture });
      },
      removeEventListener() {},
      blurCount: 0,
      blur() { node.blurCount += 1; },
      focus() {}
    };
    return node;
  }

  const html = makeElement('html');
  const head = makeElement('head');
  const body = makeElement('body');
  html.appendChild(head);
  html.appendChild(body);

  return {
    head,
    body,
    documentElement: html,
    createElement: makeElement,
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text), childNodes: [] }),
    getElementById: (id) => byId.get(id) || null,
    getElementsByTagName: (tag) => (String(tag).toLowerCase() === 'head' ? [head] : []),
    addEventListener(type, fn, capture) {
      this._listeners.push({ type, fn, capture: !!capture });
    },
    removeEventListener() {},
    _listeners: [],
    _byId: byId,
    _scripts: scripts,
    _scriptSrcs: () => scripts.map((s) => String(s.src || ''))
  };
}

/* A stand-in for the firebase-*-compat globals, so the sign-in path can be
 * driven without loading anything from gstatic. Shaped exactly like the parts
 * of the compat API net.js touches. */
function makeFakeFirebase(options) {
  const opts = options || {};
  const calls = {
    initializeApp: 0,
    signIn: 0,
    signUp: 0,
    signInAnonymously: 0,
    signOut: 0,
    linkWithCredential: 0,
    linkWithPopup: 0,
    signInWithPopup: 0,
    signInWithCredential: 0,
    getIdToken: []
  };
  let currentUser = null;

  function makeUser(email, isAnonymous, uid) {
    return {
      uid: uid || (isAnonymous ? 'anon-uid-123' : 'user-uid-456'),
      email: email || (isAnonymous ? null : 'user@example.com'),
      displayName: opts.displayName === undefined ? (isAnonymous ? null : 'Pilot') : opts.displayName,
      isAnonymous: !!isAnonymous,
      getIdToken(force) {
        calls.getIdToken.push(!!force);
        // Only the FORCED refresh fails: the initial sign-in must still work,
        // otherwise there is no session to test the 401 path against.
        if (opts.getIdTokenFails && force) {
          return Promise.reject(new Error('token refresh failed'));
        }
        return Promise.resolve(force ? 'refreshed-id-token' : (opts.idToken || (isAnonymous ? 'fake-anon-token' : 'fake-id-token')));
      },
      linkWithCredential(cred) {
        calls.linkWithCredential += 1;
        if (opts.linkFailsConflict) {
          const e = new Error('The credential is already in use.');
          e.code = 'auth/credential-already-in-use';
          return Promise.reject(e);
        }
        if (opts.linkFails) {
          const e = new Error('Linking failed.');
          e.code = 'auth/invalid-credential';
          return Promise.reject(e);
        }
        this.isAnonymous = false;
        if (cred && cred.email) this.email = cred.email;
        if (cred && cred.providerId === 'apple.com') this.email = 'appleuser@example.com';
        return Promise.resolve({ user: this });
      },
      linkWithPopup(provider) {
        calls.linkWithPopup += 1;
        if (opts.linkFailsConflict) {
          const e = new Error('The credential is already in use.');
          e.code = 'auth/credential-already-in-use';
          return Promise.reject(e);
        }
        if (opts.linkFails) {
          const e = new Error('Popup linking failed.');
          e.code = 'auth/popup-closed-by-user';
          return Promise.reject(e);
        }
        this.isAnonymous = false;
        this.email = 'appleuser@example.com';
        return Promise.resolve({ user: this });
      }
    };
  }

  const auth = () => ({
    get currentUser() { return currentUser; },
    signInWithEmailAndPassword(email) {
      calls.signIn += 1;
      if (opts.signInFails) {
        const e = new Error('The password is invalid.');
        e.code = 'auth/wrong-password';
        return Promise.reject(e);
      }
      currentUser = makeUser(email, false);
      return Promise.resolve({ user: currentUser });
    },
    createUserWithEmailAndPassword(email) {
      calls.signUp += 1;
      if (opts.signUpFails) {
        const e = new Error('The email address is already in use.');
        e.code = 'auth/email-already-in-use';
        return Promise.reject(e);
      }
      currentUser = makeUser(email, false);
      return Promise.resolve({ user: currentUser });
    },
    signInAnonymously() {
      calls.signInAnonymously += 1;
      if (opts.signInAnonymouslyFails) {
        const e = new Error('Anonymous auth disabled.');
        e.code = 'auth/admin-restricted-operation';
        return Promise.reject(e);
      }
      currentUser = makeUser(null, true);
      return Promise.resolve({ user: currentUser });
    },
    signInWithCredential(cred) {
      calls.signInWithCredential += 1;
      if (opts.signInWithCredentialFails) {
        const e = new Error('Credential sign-in failed.');
        e.code = 'auth/invalid-credential';
        return Promise.reject(e);
      }
      currentUser = makeUser('appleuser@example.com', false);
      return Promise.resolve({ user: currentUser });
    },
    signInWithPopup(provider) {
      calls.signInWithPopup += 1;
      if (opts.signInWithPopupFails) {
        const e = new Error('Popup sign-in failed.');
        e.code = 'auth/popup-closed-by-user';
        return Promise.reject(e);
      }
      currentUser = makeUser('appleuser@example.com', false);
      return Promise.resolve({ user: currentUser });
    },
    signOut() {
      calls.signOut += 1;
      currentUser = null;
      return Promise.resolve();
    }
  });

  auth.EmailAuthProvider = {
    credential(email, password) {
      return { providerId: 'password', email, password };
    }
  };

  function OAuthProvider(providerId) {
    this.providerId = providerId;
    this.scopes = [];
    this.addScope = function (scope) { this.scopes.push(scope); return this; };
    this.credential = function (params) {
      return { providerId: this.providerId, idToken: params && params.idToken, rawNonce: params && params.rawNonce };
    };
  }
  auth.OAuthProvider = OAuthProvider;

  const fb = {
    apps: [],
    initializeApp(config) {
      calls.initializeApp += 1;
      fb.apps.push({ config });
      return { config };
    },
    app: () => fb.apps[0],
    auth,
    _calls: calls,
    _setUser: (u) => { currentUser = u; },
    _makeUser: makeUser
  };
  return fb;
}

/* Configures net.js and drives a full Firebase sign-in through the real
 * signIn() path (fake SDK pre-installed, so no script tag is needed). */
async function fakeSignIn(Net, opts) {
  Net.configure(Object.assign(
    { baseUrl: 'http://localhost:3000', projectId: 'demo-proj', apiKey: 'public-api-key' },
    (opts && opts.configure) || {}
  ));
  return Net.signIn((opts && opts.email) || 'pilot@example.com', 'hunter2hunter2');
}

function makeWindow() {
  const listeners = [];
  const win = {
    listeners,
    crypto: global.crypto || {
      getRandomValues(buf) {
        for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
        return buf;
      },
      subtle: {
        async digest(algo, data) {
          const cryptoModule = require('crypto');
          return cryptoModule.createHash('sha256').update(Buffer.from(data)).digest();
        }
      }
    },
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture: !!capture });
    },
    removeEventListener() {}
  };
  return win;
}

function makeStorage(mode) {
  if (mode === 'missing') return undefined;
  if (mode === 'throwing') {
    return {
      getItem() { throw new Error('SecurityError: storage disabled'); },
      setItem() { throw new Error('SecurityError: storage disabled'); },
      removeItem() { throw new Error('SecurityError: storage disabled'); }
    };
  }
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

const quietConsole = { log() {}, warn() {}, error() {} };

/* Loads a fresh copy of net.js against the supplied environment. Returns the
 * SI namespace, or throws (which is itself a failure of the file). */
function loadNet(env) {
  const e = env || {};
  const win = e.window === undefined ? makeWindow() : e.window;
  // Pre-installing window.firebase models "the compat SDK is already present",
  // which lets the sign-in path be driven without any CDN fetch. Scenarios
  // that test the LOADER itself deliberately leave this unset.
  if (e.firebase !== undefined && win) {
    win.firebase = e.firebase;
  }
  const factory = new Function(
    'window', 'document', 'localStorage', 'fetch', 'AbortController', 'console',
    SOURCE + '\n//# sourceURL=net.js'
  );
  factory(
    win,
    e.document === undefined ? makeDocument() : e.document,
    e.localStorage === undefined ? makeStorage('ok') : e.localStorage,
    e.fetch,
    e.AbortController === undefined ? global.AbortController : e.AbortController,
    e.console || quietConsole
  );
  return { SI: win.SI, Net: win.SI && win.SI.Net, window: win };
}

/* ------------------- DOM event propagation simulator -------------------
 *
 * The stub DOM above has no dispatchEvent, so the shield in net.js used to be
 * checked by calling the capture listener by hand -- which cannot distinguish
 * "the shield fired" from "the shield fired and killed the target-phase and
 * bubble-phase handlers too". That is exactly the NET-01/02/03 class of bug,
 * so this models the three DOM phases explicitly:
 *
 *   1. capture   -- window's capture listeners (net.js's shield lives here),
 *                   outermost first;
 *   2. target    -- the target element's own `on<type>` property handler
 *                   (net.js sets username.onkeydown / password.onkeydown);
 *   3. bubble    -- window's bubble listeners (js/input.js lives here).
 *
 * stopPropagation() ends the walk after the current phase's node;
 * stopImmediatePropagation() additionally stops the remaining listeners on the
 * current node. Only window carries addEventListener listeners in this build
 * and only panel elements carry property handlers, so those three steps are
 * the complete real path for the events under test.
 */
function dispatchKey(win, target, init) {
  const evt = Object.assign(
    { type: 'keydown', target, defaultPrevented: false },
    init || {}
  );
  let stopped = false;
  let stoppedImmediate = false;
  evt.stopPropagation = () => { stopped = true; };
  evt.stopImmediatePropagation = () => { stopped = true; stoppedImmediate = true; };
  evt.preventDefault = () => { evt.defaultPrevented = true; };

  const phase = (capture) => {
    for (const l of win.listeners.filter((x) => x.type === evt.type && x.capture === capture)) {
      l.fn(evt);
      if (stoppedImmediate) return;
    }
  };

  phase(true);                                   // 1. capture, on window
  if (stopped) return evt;
  const prop = target && target['on' + evt.type];  // 2. target phase
  if (typeof prop === 'function') { prop(evt); }
  if (stopped) return evt;
  phase(false);                                  // 3. bubble, on window
  return evt;
}

/* A stand-in for js/input.js: a window-level BUBBLE keydown/keyup pair that
 * preventDefault()s the game keys and tracks which are held down. Registered
 * before net.js loads, mirroring the script order in index.html. */
function installFakeInputJs(win) {
  const GAME_KEYS = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD',
    'KeyZ', 'KeyP', 'KeyM', 'Enter']);
  const down = Object.create(null);
  const seen = [];
  win.addEventListener('keydown', (e) => {
    seen.push(['keydown', e.code]);
    if (GAME_KEYS.has(e.code)) {
      down[e.code] = true;
      e.preventDefault();
    }
  }, false);
  win.addEventListener('keyup', (e) => {
    seen.push(['keyup', e.code]);
    down[e.code] = false;
  }, false);
  return { down, seen };
}

/* Fake Response with a configurable body. */
function fakeResponse(status, bodyText, textBehaviour) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text() {
      if (textBehaviour === 'reject') return Promise.reject(new Error('stream error'));
      if (textBehaviour === 'throw') throw new Error('text() exploded');
      if (textBehaviour === 'nonpromise') return 'not a promise';
      return Promise.resolve(bodyText);
    }
  };
}


/* A fake NEON INVADERS backend: issues run tokens and records score submits.
 * Mirrors the real contract closely enough that net.js's run-token plumbing is
 * genuinely exercised (a submit without a runToken is rejected, as the real
 * server would with run_required). */
function makeFakeServer(options) {
  const opts = options || {};
  const submitted = [];
  let issued = 0;
  const state = { scoresUp: opts.scoresUp !== false, scoreStatus: opts.scoreStatus || 201 };

  const fetchImpl = async (url, init) => {
    const u = String(url);
    const o = init || {};
    if (u.indexOf('/api/runs/start') !== -1) {
      if (opts.runStartFails) return fakeResponse(503, '{"error":"unavailable"}');
      issued += 1;
      return fakeResponse(201, JSON.stringify({
        runToken: 'run-token-' + issued, startedMs: Date.now(), expiresMs: Date.now() + 60000
      }));
    }
    if (u.indexOf('/api/scores') !== -1 && o.method === 'POST') {
      const body = JSON.parse(o.body);
      if (!state.scoresUp) return fakeResponse(503, '{"error":"unavailable"}');
      if (!body.runToken) return fakeResponse(400, '{"error":"run_required"}');
      if (state.scoreStatus !== 201) {
        return fakeResponse(state.scoreStatus, '{"error":"rejected"}');
      }
      submitted.push(body);
      return fakeResponse(201, '{"accepted":true,"personalBest":{"score":0}}');
    }
    return fakeResponse(200, '{"entries":[]}');
  };
  return { fetch: fetchImpl, submitted, state, issuedCount: () => issued };
}

/* --------------------------- the scenarios ----------------------------- */

async function scenario(name, fn) {
  console.log(`\n[${name}]`);
  try {
    await fn();
  } catch (err) {
    console.log(`  FAIL threw synchronously/asynchronously: ${err && err.stack}`);
    record('SCENARIO THREW', `${name}: ${err && err.message}`);
  }
}

async function main() {
  console.log('check-net.js -- js/net.js failure-mode harness');

  await scenario('loads with a normal environment', async () => {
    const { Net } = loadNet({ fetch: async () => fakeResponse(200, '{}') });
    check('SI.Net is exported', !!Net);
    const api = ['configure', 'status', 'register', 'login', 'signIn', 'signUp',
      'signInAnonymously', 'signInAsGuest', 'linkAccount', 'signInWithApple',
      'linkWithApple', 'getPlatform', 'logout', 'submitScore', 'leaderboard', 'personalBest'];
    for (const k of api) {
      check(`SI.Net.${k} is a function`, Net && typeof Net[k] === 'function');
    }
    check('no requests made before opt-in', Net.status().loggedIn === false);
  });

  await scenario('no document at all (headless / stripped WebView)', async () => {
    const { Net } = loadNet({ document: null, fetch: async () => fakeResponse(200, '{}') });
    check('module still exports SI.Net', !!Net && typeof Net.login === 'function');
    const res = await Net.login('a', 'b');
    check('login resolves rather than throwing', !!res && res.ok === false);
  });

  await scenario('no server configured -> no_server, zero fetch calls', async () => {
    let calls = 0;
    const { Net } = loadNet({
      firebase: makeFakeFirebase(),
      fetch: async () => { calls += 1; return fakeResponse(200, '{}'); }
    });
    const results = await Promise.all([
      Net.leaderboard(10),
      Net.startRun(),
      Net.submitScore(10, 1, 'some-run-token')
    ]);
    check('all resolve', results.every((r) => r && r.ok === false));
    check('leaderboard error is no_server', results[0].error === 'no_server', results[0].error);
    check('startRun without a session/server resolves not_logged_in',
      results[1].error === 'not_logged_in', results[1].error);
    check('submitScore without a session resolves not_logged_in',
      results[2].error === 'not_logged_in', results[2].error);
    check('fetch was never called', calls === 0, `calls=${calls}`);
  });

  await scenario('sign-in without a Firebase project/key never touches the network', async () => {
    let calls = 0;
    const { Net } = loadNet({
      firebase: makeFakeFirebase(),
      fetch: async () => { calls += 1; return fakeResponse(200, '{}'); }
    });
    Net.configure({ baseUrl: 'http://localhost:3000' });   // server set, firebase NOT
    const signIn = await Net.signIn('pilot@example.com', 'hunter2hunter2');
    const signUp = await Net.signUp('pilot@example.com', 'hunter2hunter2');
    check('signIn resolves ok:false', signIn && signIn.ok === false);
    check('error is no_firebase_config', signIn.error === 'no_firebase_config', signIn.error);
    check('signUp resolves ok:false too', signUp && signUp.ok === false);
    check('fetch was never called', calls === 0, `calls=${calls}`);
  });

  await scenario('fetch missing entirely -> no_fetch', async () => {
    const { Net } = loadNet({ fetch: undefined });
    Net.configure({ baseUrl: 'http://localhost:3000' });
    const res = await Net.leaderboard(5);
    check('resolves with ok:false', res && res.ok === false);
    check('error is no_fetch', res.error === 'no_fetch', res.error);
  });

  await scenario('fetch throws synchronously', async () => {
    const { Net } = loadNet({
      fetch: () => { throw new TypeError('Failed to fetch'); }
    });
    Net.configure({ baseUrl: 'http://localhost:3000' });
    const res = await Net.leaderboard(5);
    check('resolves with ok:false', res && res.ok === false);
    check('error is network', res.error === 'network', res.error);
  });

  await scenario('fetch rejects (device offline)', async () => {
    const { Net } = loadNet({
      fetch: () => Promise.reject(new TypeError('NetworkError when attempting to fetch resource.'))
    });
    Net.configure({ baseUrl: 'http://localhost:3000' });
    const res = await Net.leaderboard(10);
    check('resolves with ok:false', res && res.ok === false);
    check('error is network', res.error === 'network', res.error);
    check('status() reports the error', Net.status().lastError.length > 0);
    check('still not logged in', Net.status().loggedIn === false);
  });

  await scenario('fetch returns a non-promise', async () => {
    const { Net } = loadNet({ fetch: () => ({ status: 200 }) });
    Net.configure({ baseUrl: 'http://localhost:3000' });
    const res = await Net.leaderboard(5);
    check('resolves with ok:false', res && res.ok === false);
    check('error is network', res.error === 'network', res.error);
  });

  await scenario('HTTP 500 with a JSON error body', async () => {
    const { Net } = loadNet({
      fetch: async () => fakeResponse(500, '{"error":"internal_error"}')
    });
    Net.configure({ baseUrl: 'http://localhost:3000' });
    const res = await Net.leaderboard(10);
    check('resolves with ok:false', res && res.ok === false);
    check('status is 500', res.status === 500, String(res.status));
    check('error surfaces from the body', res.error === 'internal_error', res.error);
    check('no token adopted', Net.status().loggedIn === false);
  });

  await scenario('HTTP 200 with a non-JSON body (captive portal)', async () => {
    const { Net } = loadNet({
      fetch: async () => fakeResponse(200, '<html>Sign in to the WiFi</html>')
    });
    Net.configure({ baseUrl: 'http://localhost:3000' });
    const res = await Net.leaderboard(10);
    check('resolves ok:true with data:null (no JSON.parse throw)',
      res && res.ok === true && res.data === null);
    check('no token adopted from garbage', Net.status().loggedIn === false);
  });

  await scenario('HTTP 500 with a non-JSON body', async () => {
    const { Net } = loadNet({ fetch: async () => fakeResponse(502, 'Bad Gateway') });
    Net.configure({ baseUrl: 'http://localhost:3000' });
    const res = await Net.leaderboard(10);
    check('resolves with ok:false', res && res.ok === false);
    check('error falls back to http_502', res.error === 'http_502', res.error);
  });

  await scenario('response.text() rejects', async () => {
    const { Net } = loadNet({
      fetch: async () => fakeResponse(200, '', 'reject')
    });
    Net.configure({ baseUrl: 'http://localhost:3000' });
    const res = await Net.leaderboard(10);
    check('resolves with ok:false', res && res.ok === false);
    check('error is bad_response', res.error === 'bad_response', res.error);
  });

  await scenario('response.text() throws / returns a non-promise', async () => {
    for (const behaviour of ['throw', 'nonpromise']) {
      const { Net } = loadNet({ fetch: async () => fakeResponse(200, '', behaviour) });
      Net.configure({ baseUrl: 'http://localhost:3000' });
      const res = await Net.leaderboard(10);
      check(`text() ${behaviour} -> ok:false`, res && res.ok === false);
      check(`text() ${behaviour} -> bad_response`, res.error === 'bad_response', res.error);
    }
  });

  await scenario('request that never settles -> timeout', async () => {
    let aborted = false;
    const { Net } = loadNet({
      fetch: (url, opts) => new Promise((resolve, reject) => {
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => {
            aborted = true;
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }
      })
    });
    Net.configure({ baseUrl: 'http://localhost:3000', timeoutMs: 60 });
    const started = Date.now();
    const res = await Net.leaderboard(10);
    const elapsed = Date.now() - started;
    check('resolves with ok:false', res && res.ok === false);
    check('error is timeout', res.error === 'timeout', res.error);
    check('resolved promptly (< 3s)', elapsed < 3000, `${elapsed}ms`);
    check('AbortController.abort() was called', aborted === true);
    // Give the rejected fetch promise a tick to be (not) reported.
    await new Promise((r) => setTimeout(r, 50));
  });

  await scenario('localStorage throws on every access', async () => {
    const { Net } = loadNet({
      localStorage: makeStorage('throwing'),
      firebase: makeFakeFirebase(),
      fetch: async () => fakeResponse(200, '{}')
    });
    const res = await fakeSignIn(Net);
    check('sign-in still succeeds in memory', res && res.ok === true, JSON.stringify(res));
    check('session held in memory', Net.status().loggedIn === true);
    Net.logout();
    check('logout does not throw', Net.status().loggedIn === false);
  });

  await scenario('localStorage missing entirely', async () => {
    const { Net } = loadNet({
      localStorage: makeStorage('missing'),
      fetch: async () => fakeResponse(200, '{}')
    });
    check('module loaded', !!Net);
    const res = await Net.leaderboard(10);
    check('resolves', res && typeof res.ok === 'boolean');
  });

  await scenario('submitScore without a session never hits the network', async () => {
    let calls = 0;
    const { Net } = loadNet({ fetch: async () => { calls += 1; return fakeResponse(201, '{}'); } });
    Net.configure({ baseUrl: 'http://localhost:3000' });
    const res = await Net.submitScore(1234, 3);
    check('resolves with ok:false', res && res.ok === false);
    check('error is not_logged_in', res.error === 'not_logged_in', res.error);
    check('no fetch call', calls === 0, `calls=${calls}`);
  });

  await scenario('401 from OUR server triggers ONE silent ID-token refresh + retry', async () => {
    /* Firebase ID tokens expire after an hour, so a long session will get a
     * 401 from our server through no fault of the player. One silent
     * getIdToken(true) + retry must rescue it without signing them out. */
    const fakeFb = makeFakeFirebase();
    const seenAuth = [];
    let scoreCalls = 0;
    const { Net } = loadNet({
      firebase: fakeFb,
      fetch: async (url, opts) => {
        const auth = (opts && opts.headers && opts.headers.Authorization) || '';
        if (String(url).indexOf('/api/scores') !== -1 && opts.method === 'POST') {
          scoreCalls += 1;
          seenAuth.push(auth);
          // The stale token is refused; the refreshed one is accepted.
          return auth.indexOf('refreshed-id-token') !== -1
            ? fakeResponse(201, '{"accepted":true}')
            : fakeResponse(401, '{"error":"unauthorized"}');
        }
        return fakeResponse(200, '{"entries":[]}');
      }
    });
    await fakeSignIn(Net);
    check('signed in with the initial token', Net.status().loggedIn === true);

    const res = await Net.submitScore(500, 2, 'rt-refresh');
    check('the submit ultimately succeeded', res && res.ok === true, JSON.stringify(res));
    check('it took exactly two attempts', scoreCalls === 2, `scoreCalls=${scoreCalls}`);
    check('the first attempt used the stale token',
      seenAuth[0] === 'Bearer fake-id-token', seenAuth[0]);
    check('the retry used the refreshed token',
      seenAuth[1] === 'Bearer refreshed-id-token', seenAuth[1]);
    check('exactly one FORCED refresh was requested',
      fakeFb._calls.getIdToken.filter(Boolean).length === 1,
      JSON.stringify(fakeFb._calls.getIdToken));
    check('the player is still signed in', Net.status().loggedIn === true);
  });

  await scenario('401 with no refreshable session still drops the dead token', async () => {
    const { Net } = loadNet({
      firebase: makeFakeFirebase({ getIdTokenFails: true }),
      fetch: async () => fakeResponse(401, '{"error":"unauthorized"}')
    });
    await fakeSignIn(Net);
    check('logged in', Net.status().loggedIn === true);
    const res = await Net.submitScore(500, 2, 'rt-dead');
    check('submit resolves ok:false', res && res.ok === false);
    check('token discarded after an unrescuable 401', Net.status().loggedIn === false);
  });

  await scenario('game-over hook wraps setState without touching game.js', async () => {
    const win = makeWindow();
    // Stand in for js/game.js: the same STATE names and a setState of the
    // same shape, so the wrap under test is the real one.
    const STATE = { MENU: 'MENU', PLAYING: 'PLAYING', PAUSED: 'PAUSED', GAME_OVER: 'GAME_OVER' };
    const calls = [];
    function Game() { this.state = STATE.MENU; this.score = 0; this.wave = 1; }
    Game.prototype.setState = function (s) { calls.push(s); this.state = s; this.stateTimer = 0; };
    Game.STATE = STATE;
    win.SI = { Game, STATE };

    const server = makeFakeServer();
    const submitted = server.submitted;
    const { Net } = loadNet({ window: win, firebase: makeFakeFirebase(), fetch: server.fetch });

    check('original setState was wrapped', Game.prototype.setState.length >= 0
      && Game.prototype.setState.toString().indexOf('original.call') !== -1);

    Net.configure({ baseUrl: 'http://localhost:3000', projectId: 'p', apiKey: 'k' });
    const game = new Game();
    win.SI.game = game;

    // Not signed in yet: game over must NOT submit.
    game.setState(STATE.PLAYING);
    game.score = 111;
    game.setState(STATE.GAME_OVER);
    await new Promise((r) => setTimeout(r, 30));
    check('no submit while signed out', submitted.length === 0, JSON.stringify(submitted));
    check('underlying setState still ran', game.state === STATE.GAME_OVER);
    check('original setState side effects preserved', calls.includes('GAME_OVER'));

    await fakeSignIn(Net);

    // A fresh run: PLAYING resets the guard AND opens a server run;
    // GAME_OVER submits once, quoting that run token.
    game.setState(STATE.PLAYING);
    await new Promise((r) => setTimeout(r, 20));
    check('entering PLAYING asked the server to start a run',
      server.issuedCount() === 1, `issued=${server.issuedCount()}`);
    check('status() exposes the run token', Net.status().runToken === 'run-token-1',
      Net.status().runToken);
    game.score = 4200;
    game.wave = 5;
    game.setState(STATE.GAME_OVER);
    await new Promise((r) => setTimeout(r, 40));
    check('submitted exactly once', submitted.length === 1, JSON.stringify(submitted));
    check('submitted the final score', submitted[0] && submitted[0].score === 4200,
      JSON.stringify(submitted[0]));
    check('submitted the wave', submitted[0] && submitted[0].wave === 5);
    check('submitted the server-issued run token',
      submitted[0] && submitted[0].runToken === 'run-token-1', JSON.stringify(submitted[0]));

    // Re-entering GAME_OVER (e.g. lives<=0 re-check) must not double-submit.
    game.setState(STATE.GAME_OVER);
    await new Promise((r) => setTimeout(r, 30));
    check('no duplicate submit for the same run', submitted.length === 1,
      JSON.stringify(submitted));

    // Pause/resume must not clear the guard, nor open a second run.
    const issuedBefore = server.issuedCount();
    game.setState(STATE.PAUSED);
    game.setState(STATE.PLAYING);
    await new Promise((r) => setTimeout(r, 20));
    check('resuming from PAUSED does NOT start a new server run',
      server.issuedCount() === issuedBefore, `issued=${server.issuedCount()}`);
    game.setState(STATE.GAME_OVER);
    await new Promise((r) => setTimeout(r, 30));
    check('pause->resume->game over does not resubmit the same run',
      submitted.length === 1, JSON.stringify(submitted));
  });

  await scenario('score read is deferred so late points are included', async () => {
    const win = makeWindow();
    const STATE = { MENU: 'MENU', PLAYING: 'PLAYING', PAUSED: 'PAUSED', GAME_OVER: 'GAME_OVER' };
    function Game() { this.state = STATE.MENU; this.score = 0; this.wave = 1; }
    Game.prototype.setState = function (s) { this.state = s; };
    Game.STATE = STATE;
    win.SI = { Game, STATE };

    const server = makeFakeServer();
    const submitted = server.submitted;
    const { Net } = loadNet({ window: win, firebase: makeFakeFirebase(), fetch: server.fetch });
    await fakeSignIn(Net);

    const game = new Game();
    win.SI.game = game;
    game.setState(STATE.PLAYING);
    await new Promise((r) => setTimeout(r, 20));
    game.score = 1000;
    game.setState(STATE.GAME_OVER);
    // Same synchronous frame: game.js can still award points after
    // gameOver() inside the same collision pass.
    game.score = 1250;
    await new Promise((r) => setTimeout(r, 40));
    check('submitted the post-gameOver score', submitted[0] && submitted[0].score === 1250,
      JSON.stringify(submitted[0]));
  });

  await scenario('setState hook survives a throwing submit path', async () => {
    const win = makeWindow();
    const STATE = { MENU: 'MENU', PLAYING: 'PLAYING', PAUSED: 'PAUSED', GAME_OVER: 'GAME_OVER' };
    function Game() { this.state = STATE.MENU; this.score = 0; this.wave = 1; }
    Game.prototype.setState = function (s) { this.state = s; };
    Game.STATE = STATE;
    win.SI = { Game, STATE };
    const { Net } = loadNet({
      window: win,
      firebase: makeFakeFirebase(),
      fetch: (url, opts) => {
        if (opts && opts.method === 'POST' && String(url).indexOf('/api/scores') !== -1) {
          throw new Error('boom');
        }
        if (String(url).indexOf('/api/runs/start') !== -1) {
          return Promise.resolve(fakeResponse(201, '{"runToken":"rt-1","startedMs":1,"expiresMs":2}'));
        }
        return Promise.resolve(fakeResponse(200, '{"entries":[]}'));
      }
    });
    await fakeSignIn(Net);
    const game = new Game();
    win.SI.game = game;
    game.setState(STATE.PLAYING);
    await new Promise((r) => setTimeout(r, 20));
    game.setState(STATE.GAME_OVER);
    await new Promise((r) => setTimeout(r, 40));
    check('game reached GAME_OVER despite the failing submit', game.state === STATE.GAME_OVER);
  });

  await scenario('key shield: real capture/target/bubble propagation', async () => {
    const doc = makeDocument();
    const win = makeWindow();
    const inputJs = installFakeInputJs(win);   // registered first, as in index.html
    const fakeFb = makeFakeFirebase();
    const { Net: shieldNet } = loadNet({
      window: win,
      document: doc,
      firebase: fakeFb,
      fetch: async () => fakeResponse(200, '{"entries":[]}')
    });
    // Firebase config must be present or Enter-to-submit short-circuits before
    // ever reaching the SDK, which would make the NET-02 check vacuous.
    shieldNet.configure({ baseUrl: 'http://localhost:3000', projectId: 'p', apiKey: 'k' });

    const captureKeydown = win.listeners.filter((l) => l.type === 'keydown' && l.capture);
    check('a capture-phase keydown listener was installed', captureKeydown.length === 1,
      `found ${captureKeydown.length}`);
    // NET-03: keyup only CLEARS input.js's pressed-key map. Shielding it strands
    // a held key as permanently down.
    check('NO capture keyup listener is installed (NET-03)',
      !win.listeners.some((l) => l.type === 'keyup' && l.capture));

    const panel = doc.getElementById('ni-net');
    const toggle = doc.getElementById('ni-net-toggle');
    check('panel was mounted', !!panel && !!toggle);
    /* Panel field order is: Server, Firebase project ID, Firebase web API key,
     * Email, Password -- each preceded by its <label>, so the inputs sit at
     * odd indices. */
    const body = panel.childNodes[1];
    const serverField = body.childNodes[1];
    const projectField = body.childNodes[3];
    const apiKeyField = body.childNodes[5];
    const usernameField = body.childNodes[7];
    const passwordField = body.childNodes[9];
    check('located all five panel inputs',
      serverField.tagName === 'INPUT' && projectField.tagName === 'INPUT' &&
      apiKeyField.tagName === 'INPUT' && usernameField.tagName === 'INPUT' &&
      passwordField.type === 'password');
    check('the credential field is now an EMAIL input', usernameField.type === 'email',
      usernameField.type);

    // 1. Typing into a panel field: input.js must never see the key.
    dispatchKey(win, serverField, { code: 'Space', key: ' ' });
    check('Space typed in a panel field never reaches input.js',
      inputJs.down.Space !== true);

    // 2. NET-01: after clicking the toggle it stays the focused element in
    //    Chromium, so the NEXT keydown targets the BUTTON. Game keys must
    //    still get through.
    toggle.onclick();
    check('toggle.blur() is called after its click handler (NET-01)',
      toggle.blurCount === 1, `blurCount=${toggle.blurCount}`);
    dispatchKey(win, toggle, { code: 'Space', key: ' ' });
    check('Space with the toggle button as target still reaches input.js (NET-01)',
      inputJs.down.Space === true);
    dispatchKey(win, toggle, { code: 'ArrowLeft', key: 'ArrowLeft' });
    check('ArrowLeft with the toggle as target still reaches input.js (NET-01)',
      inputJs.down.ArrowLeft === true);

    // 3. NET-03: hold ArrowLeft, click into a field, release. The keyup's
    //    target is the input; it must still clear input.js's state.
    dispatchKey(win, doc.body, { type: 'keydown', code: 'ArrowLeft', key: 'ArrowLeft' });
    check('ArrowLeft is held', inputJs.down.ArrowLeft === true);
    dispatchKey(win, usernameField, { type: 'keyup', code: 'ArrowLeft', key: 'ArrowLeft' });
    check('keyup on a panel input still clears the held key (NET-03)',
      inputJs.down.ArrowLeft === false);

    // 4. A key pressed anywhere else reaches the game untouched.
    inputJs.down.KeyZ = false;
    dispatchKey(win, doc.body, { code: 'KeyZ', key: 'z' });
    check('game keys elsewhere are NOT stopped', inputJs.down.KeyZ === true);

    // 5. NET-02: Enter inside a credential field really does submit, even
    //    though the capture-phase stopImmediatePropagation() prevents the
    //    element's own target-phase onkeydown from running.
    usernameField.value = 'pilot@example.com';
    passwordField.value = 'hunter2hunter2';
    projectField.value = 'demo-proj';
    apiKeyField.value = 'public-api-key';
    const before = fakeFb._calls.signIn;
    dispatchKey(win, passwordField, { code: 'Enter', key: 'Enter' });
    await new Promise((r) => setTimeout(r, 30));
    check('Enter in the password field triggers a Firebase sign-in (NET-02)',
      fakeFb._calls.signIn === before + 1, `signIn calls=${fakeFb._calls.signIn}`);
    check('that Enter never reached input.js', inputJs.down.Enter !== true);
  });

  await scenario('failed submit is retained and retried, not lost (NET-05)', async () => {
    const win = makeWindow();
    const STATE = { MENU: 'MENU', PLAYING: 'PLAYING', PAUSED: 'PAUSED', GAME_OVER: 'GAME_OVER' };
    function Game() { this.state = STATE.MENU; this.score = 0; this.wave = 1; }
    Game.prototype.setState = function (s) { this.state = s; };
    Game.STATE = STATE;
    win.SI = { Game, STATE };

    const server = makeFakeServer({ scoresUp: false });
    const submitted = server.submitted;
    const { Net } = loadNet({ window: win, firebase: makeFakeFirebase(), fetch: server.fetch });
    await fakeSignIn(Net);

    const game = new Game();
    win.SI.game = game;
    game.setState(STATE.PLAYING);
    await new Promise((r) => setTimeout(r, 20));
    game.score = 7777;
    game.wave = 6;
    game.setState(STATE.GAME_OVER);
    await new Promise((r) => setTimeout(r, 40));

    check('nothing was accepted while the server was down', submitted.length === 0);
    const pending = Net.status().pendingSubmit;
    check('the run is held as pending', !!pending && pending.score === 7777, JSON.stringify(pending));
    check('pending kept the wave too', pending && pending.wave === 6);
    // The run token MUST travel with the pending record: a retry without it
    // would be rejected by the real server with run_required.
    check('pending kept the run token too', !!pending && pending.runToken === 'run-token-1',
      JSON.stringify(pending));

    // The server comes back; the retry flushes the run.
    server.state.scoresUp = true;
    await Net.flushPending();
    check('the pending run was submitted on retry', submitted.length === 1,
      JSON.stringify(submitted));
    check('retry sent the original score', submitted[0] && submitted[0].score === 7777);
    check('retry carried the ORIGINAL run token through',
      submitted[0] && submitted[0].runToken === 'run-token-1', JSON.stringify(submitted[0]));
    check('pending slot cleared after success', Net.status().pendingSubmit === null);

    // A rejected (non-retryable) submit must NOT be retained forever.
    const win2 = makeWindow();
    const server2 = makeFakeServer({ scoreStatus: 400 });
    const { Net: Net2 } = loadNet({
      window: win2, firebase: makeFakeFirebase(), fetch: server2.fetch
    });
    await fakeSignIn(Net2);
    const rejected = await Net2.submitScore(10, 1, 'rt-x');
    check('400 submit resolves ok:false', rejected && rejected.ok === false);
    check('a rejected submit is not queued for retry',
      Net2.status().pendingSubmit === null);

    // A 401 drops the session AND the pending run (no cross-account leak).
    const win3 = makeWindow();
    const { Net: Net3 } = loadNet({
      window: win3,
      // getIdToken(true) fails, so the one silent refresh cannot rescue the
      // 401 and the existing sign-out behaviour must still take over.
      firebase: makeFakeFirebase({ getIdTokenFails: true }),
      fetch: async (url, opts) => {
        if (String(url).indexOf('/api/scores') !== -1 && opts.method === 'POST') {
          return fakeResponse(401, '{"error":"unauthorized"}');
        }
        return fakeResponse(200, '{"entries":[]}');
      }
    });
    Net3.configure({ baseUrl: 'http://localhost:3000', projectId: 'p', apiKey: 'k' });
    // Sign in with a working token first, then make refreshes fail.
    const fb3 = win3.firebase;
    fb3._calls.getIdToken.length = 0;
    await Net3.signIn('pilot@example.com', 'hunter2hunter2').catch(() => null);
    await Net3.submitScore(10, 1, 'rt-y');
    check('401 still signs the player out', Net3.status().loggedIn === false);
    check('401 leaves nothing pending', Net3.status().pendingSubmit === null);
  });

  await scenario('panel markup is built without innerHTML', async () => {
    check('net.js contains no innerHTML assignment', !/\.innerHTML\s*=/.test(SOURCE));
    check('net.js contains no outerHTML assignment', !/\.outerHTML\s*=/.test(SOURCE));
    check('net.js does not use document.write', SOURCE.indexOf('document.write') === -1);
    check('net.js does not use eval', !/\beval\s*\(/.test(SOURCE));
  });

  await scenario('getPlatform detects ios, android, and web correctly', async () => {
    // 1. Capacitor getPlatform() method
    const winCapIos = makeWindow();
    winCapIos.Capacitor = { getPlatform: () => 'ios' };
    const { Net: NetCapIos } = loadNet({ window: winCapIos });
    check('Capacitor.getPlatform() === "ios" detected as ios', NetCapIos.getPlatform() === 'ios');
    check('status().platform reflects ios', NetCapIos.status().platform === 'ios');

    const winCapAndroid = makeWindow();
    winCapAndroid.Capacitor = { getPlatform: () => 'android' };
    const { Net: NetCapAndroid } = loadNet({ window: winCapAndroid });
    check('Capacitor.getPlatform() === "android" detected as android', NetCapAndroid.getPlatform() === 'android');
    check('status().platform reflects android', NetCapAndroid.status().platform === 'android');

    // 2. Capacitor.platform property
    const winCapProp = makeWindow();
    winCapProp.Capacitor = { platform: 'ios' };
    const { Net: NetCapProp } = loadNet({ window: winCapProp });
    check('Capacitor.platform property detected as ios', NetCapProp.getPlatform() === 'ios');

    // 3. UserAgent fallback: iPhone / Android / Desktop via win.navigator
    const winIphone = makeWindow();
    winIphone.navigator = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5 };
    const { Net: NetIphone } = loadNet({ window: winIphone });
    check('iPhone UA detected as ios', NetIphone.getPlatform() === 'ios');

    const winAndroid = makeWindow();
    winAndroid.navigator = { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', maxTouchPoints: 5 };
    const { Net: NetAndroid } = loadNet({ window: winAndroid });
    check('Android UA detected as android', NetAndroid.getPlatform() === 'android');

    const winMac = makeWindow();
    winMac.navigator = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 };
    const { Net: NetMac } = loadNet({ window: winMac });
    check('Desktop Mac UA detected as web', NetMac.getPlatform() === 'web');

    const winWin = makeWindow();
    winWin.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0 };
    const { Net: NetWin } = loadNet({ window: winWin });
    check('Desktop Windows UA detected as web', NetWin.getPlatform() === 'web');
  });

  await scenario('anonymous guest sign-in and score submission', async () => {
    const fakeFb = makeFakeFirebase();
    const server = makeFakeServer();
    const { Net } = loadNet({ firebase: fakeFb, fetch: server.fetch });
    Net.configure({ baseUrl: 'http://localhost:3000', projectId: 'demo-proj', apiKey: 'public-key' });

    check('initial isAnonymous is false', Net.status().isAnonymous === false);
    check('signInAsGuest is aliased to signInAnonymously', Net.signInAsGuest === Net.signInAnonymously);

    const res = await Net.signInAnonymously();
    check('signInAnonymously resolves ok', !!res && res.ok === true);
    check('status().loggedIn is true', Net.status().loggedIn === true);
    check('status().isAnonymous is true', Net.status().isAnonymous === true);
    check('status().username is Guest Pilot / anon name', /^Guest\s+/.test(Net.status().username));
    check('Firebase signInAnonymously was called', fakeFb._calls.signInAnonymously === 1);

    // Start a run and submit score as guest
    const runRes = await Net.startRun();
    check('startRun succeeds for anonymous user', !!runRes && runRes.ok === true);
    const scoreRes = await Net.submitScore(2500, 3);
    check('submitScore succeeds for anonymous user', !!scoreRes && scoreRes.ok === true);
    check('score recorded by server', server.submitted.length === 1 && server.submitted[0].score === 2500);
  });

  await scenario('account linking preserves session, run token, and flushes pending runs', async () => {
    const fakeFb = makeFakeFirebase();
    const server = makeFakeServer();
    const { Net } = loadNet({ firebase: fakeFb, fetch: server.fetch });
    Net.configure({ baseUrl: 'http://localhost:3000', projectId: 'demo-proj', apiKey: 'public-key' });

    await Net.signInAnonymously();
    check('signed in anonymously', Net.status().isAnonymous === true);

    // Start a run under anonymous user
    await Net.startRun();
    const currentRunToken = Net.status().runToken;
    check('active run token acquired', !!currentRunToken);

    // Link account with email + password
    const linkRes = await Net.linkAccount('upgraded@example.com', 'mypassword123');
    check('linkAccount resolves ok: true', !!linkRes && linkRes.ok === true);
    check('status().isAnonymous is now false', Net.status().isAnonymous === false);
    check('status().username updated to email username', Net.status().username === 'upgraded');
    check('active run token preserved across linking', Net.status().runToken === currentRunToken);
    check('user.linkWithCredential was called', fakeFb._calls.linkWithCredential === 1);

    // Submit score for the run started while anonymous
    const subRes = await Net.submitScore(5000, 5);
    check('submitScore succeeds using preserved run token', !!subRes && subRes.ok === true);
    check('server accepted the score', server.submitted.some((s) => s.score === 5000 && s.runToken === currentRunToken));
  });

  await scenario('linking conflict returns credential_already_in_use without destroying anonymous session', async () => {
    const fakeFb = makeFakeFirebase({ linkFailsConflict: true });
    const server = makeFakeServer();
    const { Net } = loadNet({ firebase: fakeFb, fetch: server.fetch });
    Net.configure({ baseUrl: 'http://localhost:3000', projectId: 'demo-proj', apiKey: 'public-key' });

    const anonRes = await Net.signInAnonymously();
    const tokenBefore = Net.status().token;
    check('anonymous user signed in', !!anonRes && anonRes.ok === true && Net.status().isAnonymous === true);

    const linkRes = await Net.linkAccount('conflict@example.com', 'hunter2hunter2');
    check('linkAccount returns ok: false on conflict', !!linkRes && linkRes.ok === false);
    check('error is credential_already_in_use', linkRes.error === 'credential_already_in_use', linkRes.error);
    check('status is 409', linkRes.status === 409, `status=${linkRes.status}`);

    // Anonymous session must NOT be destroyed
    check('player is still logged in', Net.status().loggedIn === true);
    check('player is still anonymous', Net.status().isAnonymous === true);
    check('token was preserved', Net.status().token === tokenBefore);
  });

  await scenario('sign in with Apple routes to native bridge when available or web popup', async () => {
    // 1. Native bridge via window.Capacitor.Plugins.SignInWithApple
    const winNative = makeWindow();
    let nativeAuthCalled = 0;
    winNative.Capacitor = {
      Plugins: {
        SignInWithApple: {
          authorize: async () => {
            nativeAuthCalled += 1;
            return {
              response: {
                identityToken: 'apple-jwt-token-native',
                nonce: 'raw-nonce-123'
              }
            };
          }
        }
      }
    };
    const fakeFbNative = makeFakeFirebase();
    const { Net: NetNative } = loadNet({ window: winNative, firebase: fakeFbNative });
    NetNative.configure({ baseUrl: 'http://localhost:3000', projectId: 'demo-proj', apiKey: 'public-key' });

    const nativeRes = await NetNative.signInWithApple();
    check('native signInWithApple resolves ok', !!nativeRes && nativeRes.ok === true);
    check('native plugin authorize was invoked', nativeAuthCalled === 1);
    check('Firebase signInWithCredential was called', fakeFbNative._calls.signInWithCredential === 1);

    // 2. Web fallback via OAuthProvider and signInWithPopup
    const winWeb = makeWindow();
    const fakeFbWeb = makeFakeFirebase();
    const { Net: NetWeb } = loadNet({ window: winWeb, firebase: fakeFbWeb });
    NetWeb.configure({ baseUrl: 'http://localhost:3000', projectId: 'demo-proj', apiKey: 'public-key' });

    const webRes = await NetWeb.signInWithApple();
    check('web signInWithApple resolves ok', !!webRes && webRes.ok === true);
    check('Firebase signInWithPopup was called', fakeFbWeb._calls.signInWithPopup === 1);

    // 3. linkWithApple on anonymous user (web popup)
    await NetWeb.signInAnonymously();
    check('anonymous user signed in', NetWeb.status().isAnonymous === true);
    const linkAppleRes = await NetWeb.linkWithApple();
    check('linkWithApple resolves ok', !!linkAppleRes && linkAppleRes.ok === true);
    check('status().isAnonymous is false after linking with Apple', NetWeb.status().isAnonymous === false);
    check('Firebase linkWithPopup was called', fakeFbWeb._calls.linkWithPopup === 1);
  });

  await scenario('lifecycle foreground triggers silent token refresh and flushes pending submissions', async () => {
    const doc = makeDocument();
    doc.visibilityState = 'hidden';
    const win = makeWindow();
    let appStateCallback = null;
    win.Capacitor = {
      Plugins: {
        App: {
          addListener: (event, cb) => {
            if (event === 'appStateChange') { appStateCallback = cb; }
          }
        }
      }
    };
    const fakeFb = makeFakeFirebase();
    const server = makeFakeServer({ scoresUp: false });
    const { Net } = loadNet({ document: doc, window: win, firebase: fakeFb, fetch: server.fetch });
    Net.configure({ baseUrl: 'http://localhost:3000', projectId: 'demo-proj', apiKey: 'public-key' });

    await Net.signIn('pilot@example.com', 'hunter2hunter2');

    // Create a pending submit while server is down
    await Net.startRun();
    await Net.submitScore(8888, 4);
    check('run held as pending', Net.status().pendingSubmit !== null);

    // Server comes back online
    server.state.scoresUp = true;
    fakeFb._calls.getIdToken.length = 0;

    // 1. Simulate visibilitychange (returning to foreground)
    doc.visibilityState = 'visible';
    Net._internal.onForeground();
    await new Promise((r) => setTimeout(r, 40));

    check('foreground refreshed ID token', fakeFb._calls.getIdToken.length >= 1);
    check('foreground flushed pending score', server.submitted.length === 1 && server.submitted[0].score === 8888);
    check('pending slot cleared', Net.status().pendingSubmit === null);

    // 2. Simulate Capacitor appStateChange after debounce interval
    await new Promise((r) => setTimeout(r, 1050));
    if (appStateCallback) {
      fakeFb._calls.getIdToken.length = 0;
      appStateCallback({ isActive: true });
      await new Promise((r) => setTimeout(r, 40));
      check('Capacitor appStateChange isActive refreshed token', fakeFb._calls.getIdToken.length >= 1);
    }
  });

  await scenario('net.js adheres strictly to ES5 syntax', async () => {
    const netSource = fs.readFileSync(NET_JS, 'utf8');
    const stripped = netSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    check('net.js contains no const keyword outside comments',
      !/^\s*(?:[^/]*[;{}]|[a-zA-Z0-9_$]*\s+)?const\s+[a-zA-Z0-9_$]+/m.test(stripped));
    check('net.js contains no let keyword outside comments',
      !/^\s*(?:[^/]*[;{}]|[a-zA-Z0-9_$]*\s+)?let\s+[a-zA-Z0-9_$]+/m.test(stripped));
    check('net.js contains no arrow functions outside comments',
      !/=>/.test(stripped));
    check('net.js contains no template literals outside comments',
      !/`/.test(stripped));
    check('net.js contains no class declarations outside comments',
      !/\bclass\s+[a-zA-Z0-9_$]+/.test(stripped));
  });

  // Let any straggling microtask/rejection land before we tally.
  await new Promise((r) => setTimeout(r, 120));

  console.log(`\n${checks} checks run, ${failures} problem(s).`);
  if (problems.length) {
    console.log('\nProblems:');
    problems.forEach((p) => console.log('  - ' + p));
  }
  console.log(failures === 0
    ? 'check-net: PASS (no throws, no unhandled rejections, all paths degrade)'
    : 'check-net: FAIL');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('check-net harness itself failed:', err && err.stack);
  process.exit(1);
});
