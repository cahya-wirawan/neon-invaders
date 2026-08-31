/* net.js -- OPTIONAL online accounts + leaderboard bridge.
 *
 * This file is purely additive. Nothing else in js/ knows it exists and
 * nothing in js/ was changed for it:
 *   - the game-over hook is installed by wrapping SI.Game.prototype.setState
 *     from out here, not by editing game.js;
 *   - the UI is built with document.createElement and its CSS is injected
 *     from a <style> element, so css/style.css is untouched.
 *
 * It is OPT-IN. With no stored token and no configured server the file
 * performs ZERO network requests AND injects ZERO <script> tags -- it only
 * draws a small collapsed toggle in the corner. The Firebase Auth SDK is
 * fetched from the CDN lazily, no earlier than the player opening the panel
 * or clicking sign-in. The game keeps running offline, from file://, with the
 * backend down, with the CDN blocked, or with fetch missing entirely.
 *
 * Identity is Firebase Auth (compat build, loaded lazily from gstatic), NOT
 * this server: there is no register/login endpoint any more. The server only
 * verifies the Firebase ID token this file sends as a bearer credential.
 *
 * Scores are bound to a server-issued RUN TOKEN: entering PLAYING calls
 * POST /api/runs/start, and the game-over submit quotes that token so the
 * server can measure how long the run really took.
 *
 * Every request is wrapped in try/catch AND .catch(), is bounded by a
 * timeout, and resolves (never rejects) with a plain result object. See
 * scripts/check-net.js, which drives all of those failure modes headlessly.
 */
(function (SI) {
  'use strict';

  var HAS_PROMISE = typeof Promise === 'function';
  var DOC = typeof document !== 'undefined' ? document : null;

  var STORAGE_PREFIX = 'neon-invaders.net.';
  var KEY_BASE = STORAGE_PREFIX + 'baseUrl';
  var KEY_TOKEN = STORAGE_PREFIX + 'token';
  var KEY_USER = STORAGE_PREFIX + 'username';
  var KEY_EMAIL = STORAGE_PREFIX + 'email';
  var KEY_IS_ANONYMOUS = STORAGE_PREFIX + 'isAnonymous';
  var KEY_PENDING = STORAGE_PREFIX + 'pendingSubmit';
  /* Firebase web config. A Firebase "apiKey" is a PUBLIC identifier, not a
   * secret -- it identifies the project to Google's endpoints and every
   * Firebase web app ships it in plain client JavaScript. What actually
   * protects data is Firebase Auth + security rules, not this string. Storing
   * it in localStorage is therefore fine. */
  var KEY_PROJECT = STORAGE_PREFIX + 'firebaseProjectId';
  var KEY_APIKEY = STORAGE_PREFIX + 'firebaseApiKey';

  var DEFAULT_BASE = 'http://localhost:3000';
  var DEFAULT_TIMEOUT_MS = 8000;

  /* Pinned deliberately: an unpinned "latest" URL would let a CDN change alter
   * what runs in the player's browser. COMPAT builds, not the modular/ESM
   * ones, because compat ships classic <script> globals -- so this works from
   * file:// with no bundler and no CORS-blocked `import`, exactly like the
   * rest of js/. */
  var FIREBASE_VERSION = '11.10.0';
  var FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/';
  var FIREBASE_SCRIPTS = ['firebase-app-compat.js', 'firebase-auth-compat.js'];

  var state = {
    baseUrl: '',
    token: '',
    username: '',
    email: '',
    isAnonymous: false,
    projectId: '',
    apiKey: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    lastError: '',
    lastSubmit: null,
    personalBest: null,
    // A single run whose submit failed retryably, kept so the next successful
    // connection can send it. One slot, not a queue -- see NET-05.
    pending: null
  };

  /* The server-issued run token for the run currently being played. `failed`
   * latches when /api/runs/start did not give us one, so submitScore can fail
   * loudly instead of queueing something the server will always reject. */
  var runState = { token: '', startedMs: 0, failed: false };

  /* --------------------------- tiny helpers --------------------------- */

  function fail(error, message) {
    return { ok: false, status: 0, error: error, message: message || error };
  }

  // Always-resolving promise factory that degrades gracefully if the engine
  // has no Promise at all (very old WebView).
  function resolved(value) {
    if (HAS_PROMISE) {
      return Promise.resolve(value);
    }
    return {
      then: function (fn) {
        try {
          if (typeof fn === 'function') { fn(value); }
        } catch (e) { /* a broken caller must not break the game */ }
        return this;
      },
      'catch': function () { return this; }
    };
  }

  // Detect platform: 'ios', 'android', or 'web' via Capacitor and userAgent.
  function getPlatform() {
    try {
      if (typeof window !== 'undefined' && window.Capacitor) {
        if (typeof window.Capacitor.getPlatform === 'function') {
          var cp = window.Capacitor.getPlatform();
          if (cp === 'ios' || cp === 'android') { return cp; }
        } else if (window.Capacitor.platform === 'ios' || window.Capacitor.platform === 'android') {
          return window.Capacitor.platform;
        }
      }
      var nav = (typeof window !== 'undefined' && window.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
      if (nav) {
        var ua = (nav.userAgent || '').toLowerCase();
        if (/iphone|ipad|ipod/.test(ua)) { return 'ios'; }
        if (/macintosh/.test(ua) && nav.maxTouchPoints > 1) { return 'ios'; }
        if (/android/.test(ua)) { return 'android'; }
      }
    } catch (e) { /* ignore */ }
    return 'web';
  }

  // localStorage throws in Safari private mode and in some WebView configs.
  function storeGet(key) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) { return ''; }
      var v = localStorage.getItem(key);
      return typeof v === 'string' ? v : '';
    } catch (e) {
      return '';
    }
  }

  function storeSet(key, value) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) { return; }
      if (value) {
        localStorage.setItem(key, value);
      } else {
        localStorage.removeItem(key);
      }
    } catch (e) {
      /* storage unavailable -- session-only credentials are fine */
    }
  }

  function normaliseBase(url) {
    var s = typeof url === 'string' ? url.trim() : '';
    if (!s) { return ''; }
    return s.replace(/\/+$/, '');
  }

  function clampScore(score) {
    return Math.max(0, Math.min(9999999, Math.floor(Number(score) || 0)));
  }

  function clampWave(wave) {
    return Math.max(1, Math.min(9999, Math.floor(Number(wave) || 1)));
  }

  /* ------------------------- pending submit slot ---------------------- */

  /* The runToken is part of the pending record, not just the score: a retry
   * without it would be rejected by the server with run_required, so the held
   * run would be lost anyway. */
  function setPending(score, wave, runToken) {
    state.pending = {
      score: clampScore(score),
      wave: clampWave(wave),
      runToken: typeof runToken === 'string' ? runToken : ''
    };
    try {
      storeSet(KEY_PENDING, JSON.stringify(state.pending));
    } catch (e) {
      /* memory-only pending is still better than losing the run */
    }
  }

  function clearPending() {
    state.pending = null;
    storeSet(KEY_PENDING, '');
  }

  function loadPending() {
    var raw = storeGet(KEY_PENDING);
    if (!raw) { return null; }
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      storeSet(KEY_PENDING, '');
      return null;
    }
    return {
      score: clampScore(parsed.score),
      wave: clampWave(parsed.wave),
      runToken: typeof parsed.runToken === 'string' ? parsed.runToken : ''
    };
  }

  /* ------------------------------ transport --------------------------- */

  function request(method, path, body, token) {
    if (!HAS_PROMISE) {
      return resolved(fail('no_promise', 'This browser has no Promise support.'));
    }

    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      var ctrl = null;

      function done(result) {
        if (settled) { return; }
        settled = true;
        if (timer !== null) {
          try { clearTimeout(timer); } catch (e) { /* ignore */ }
        }
        if (result && result.ok === false) {
          state.lastError = result.message || result.error || '';
        }
        resolve(result);
      }

      try {
        if (!state.baseUrl) {
          done(fail('no_server', 'No server configured.'));
          return;
        }
        if (typeof fetch !== 'function') {
          done(fail('no_fetch', 'This browser has no fetch().'));
          return;
        }

        var opts = { method: method, headers: {}, mode: 'cors', cache: 'no-store' };
        if (body !== undefined && body !== null) {
          opts.headers['Content-Type'] = 'application/json';
          try {
            opts.body = JSON.stringify(body);
          } catch (e) {
            done(fail('bad_request', 'Could not serialise the request body.'));
            return;
          }
        }
        if (token) {
          opts.headers.Authorization = 'Bearer ' + token;
        }

        try {
          if (typeof AbortController === 'function') {
            ctrl = new AbortController();
            opts.signal = ctrl.signal;
          }
        } catch (e) {
          ctrl = null;
        }

        timer = setTimeout(function () {
          if (ctrl) {
            try { ctrl.abort(); } catch (e) { /* ignore */ }
          }
          done(fail('timeout', 'The server did not answer in time.'));
        }, state.timeoutMs);

        var p;
        try {
          p = fetch(state.baseUrl + path, opts);
        } catch (e) {
          // A fetch() that throws synchronously (some polyfills, some WebViews).
          done(fail('network', (e && e.message) || 'Network request failed.'));
          return;
        }
        if (!p || typeof p.then !== 'function') {
          done(fail('network', 'fetch() did not return a promise.'));
          return;
        }

        p.then(function (res) {
          var textPromise;
          try {
            textPromise = res && typeof res.text === 'function' ? res.text() : null;
          } catch (e) {
            textPromise = null;
          }
          if (!textPromise || typeof textPromise.then !== 'function') {
            done(fail('bad_response', 'Could not read the server response.'));
            return null;
          }
          return textPromise.then(function (text) {
            var data = null;
            if (text) {
              // A proxy/captive portal may answer HTML with a 200. Never let
              // JSON.parse throw out of here.
              try { data = JSON.parse(text); } catch (e) { data = null; }
            }
            var status = (res && res.status) || 0;
            if (status >= 200 && status < 300) {
              done({ ok: true, status: status, data: data });
            } else {
              var msg = (data && data.message) ||
                (data && data.details && data.details.join && data.details.join('; ')) ||
                ('HTTP ' + status);
              done({
                ok: false,
                status: status,
                error: (data && data.error) || ('http_' + status),
                message: msg,
                data: data
              });
            }
            return null;
          }, function () {
            done(fail('bad_response', 'Could not read the server response.'));
            return null;
          });
        }, function (e) {
          var name = e && e.name;
          if (name === 'AbortError') {
            done(fail('timeout', 'The server did not answer in time.'));
          } else {
            done(fail('network', (e && e.message) || 'Network request failed.'));
          }
          return null;
        })['catch'](function (e) {
          // Belt and braces: nothing above may ever surface as an unhandled
          // rejection, whatever a stubbed/broken fetch does.
          done(fail('network', (e && e.message) || 'Network request failed.'));
          return null;
        });
      } catch (e) {
        done(fail('network', (e && e.message) || 'Network request failed.'));
      }
    });
  }

  /* ------------------------------ public API -------------------------- */

  function configure(options) {
    var o = options || {};
    if (typeof o.baseUrl === 'string') {
      state.baseUrl = normaliseBase(o.baseUrl);
      storeSet(KEY_BASE, state.baseUrl);
    }
    if (typeof o.timeoutMs === 'number' && o.timeoutMs > 0) {
      state.timeoutMs = o.timeoutMs;
    }
    /* Firebase web config may also be supplied by an embedding page instead of
     * being typed into the panel. Neither value is a secret (see KEY_APIKEY)
     * and setting them does NOT load the SDK or touch the network. */
    if (typeof o.projectId === 'string') {
      state.projectId = o.projectId.trim();
      storeSet(KEY_PROJECT, state.projectId);
    }
    if (typeof o.apiKey === 'string') {
      state.apiKey = o.apiKey.trim();
      storeSet(KEY_APIKEY, state.apiKey);
    }
    return status();
  }

  function status() {
    return {
      baseUrl: state.baseUrl,
      username: state.username,
      email: state.email,
      loggedIn: !!state.token,
      isAnonymous: state.isAnonymous,
      platform: getPlatform(),
      timeoutMs: state.timeoutMs,
      lastError: state.lastError,
      lastSubmit: state.lastSubmit,
      personalBest: state.personalBest,
      pendingSubmit: state.pending
        ? {
          score: state.pending.score,
          wave: state.pending.wave,
          runToken: state.pending.runToken || ''
        }
        : null,
      projectId: state.projectId,
      hasApiKey: !!state.apiKey,
      // Exposed so scripts/check-net.js can assert the opt-in invariant.
      sdkLoaded: !!fb(),
      runToken: runState.token,
      runFailed: runState.failed
    };
  }

  /* ------------------------- Firebase Auth SDK ------------------------ *
   *
   * STRICTLY LAZY. Nothing here runs at boot. The two <script> tags are
   * injected on the FIRST call to ensureSdk(), which happens only when the
   * player opens the panel or clicks a sign-in button. A first-time visitor
   * who never touches the panel causes zero network requests and zero script
   * tags -- scripts/check-net.js asserts exactly that.
   */

  var sdkPromise = null;   // set on first ensureSdk() -- the double-load guard
  var firebaseApp = null;

  function fb() {
    return typeof window !== 'undefined' ? window.firebase : undefined;
  }

  function loadScript(url) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(ok, message) {
        if (settled) { return; }
        settled = true;
        resolve({ ok: ok, message: message || '' });
      }
      try {
        var head = DOC.head || DOC.getElementsByTagName('head')[0] || DOC.body;
        if (!head) {
          finish(false, 'No document head to load the Firebase SDK into.');
          return;
        }
        var node = DOC.createElement('script');
        node.src = url;
        node.async = true;
        // A blocked CDN, an offline device or a CSP refusal must resolve a
        // failure state -- never throw, never reject, never hang forever.
        node.onload = function () { finish(true); };
        node.onerror = function () {
          finish(false, 'Could not load the Firebase SDK (offline or blocked).');
        };
        head.appendChild(node);
      } catch (e) {
        finish(false, (e && e.message) || 'Could not inject the Firebase SDK.');
      }
    });
  }

  /* Injects both compat scripts exactly once. Repeat calls reuse the same
   * promise, so a second sign-in click adds no further tags. */
  function ensureSdk() {
    if (sdkPromise) { return sdkPromise; }
    if (!HAS_PROMISE) {
      return resolved(fail('no_promise', 'This browser has no Promise support.'));
    }
    if (!DOC) {
      return resolved(fail('no_document', 'No document to load the Firebase SDK into.'));
    }
    if (fb()) {
      // Already present (host page loaded it, or a test injected one).
      sdkPromise = resolved({ ok: true });
      return sdkPromise;
    }

    var chain = resolved({ ok: true });
    for (var i = 0; i < FIREBASE_SCRIPTS.length; i++) {
      chain = chain.then((function (src) {
        return function (prev) {
          if (!prev || prev.ok === false) { return prev; }
          return loadScript(FIREBASE_CDN + src);
        };
      })(FIREBASE_SCRIPTS[i]));
    }

    sdkPromise = chain.then(function (res) {
      if (!res || res.ok === false) {
        // Allow a later retry after a transient failure, but the tags already
        // in the document are never duplicated by loadScript itself.
        sdkPromise = null;
        return fail('sdk_unavailable', (res && res.message) || 'Firebase SDK did not load.');
      }
      if (!fb()) {
        sdkPromise = null;
        return fail('sdk_unavailable', 'Firebase SDK loaded but did not register itself.');
      }
      return { ok: true };
    })['catch'](function (e) {
      sdkPromise = null;
      return fail('sdk_unavailable', (e && e.message) || 'Firebase SDK did not load.');
    });
    return sdkPromise;
  }

  /* ensureSdk() + initializeApp(). Separate because opening the panel should
   * warm the SDK without needing a project id yet. */
  function ensureAuth() {
    if (!state.projectId || !state.apiKey) {
      return resolved(fail('no_firebase_config',
        'Set a Firebase project ID and web API key in the panel first.'));
    }
    return ensureSdk().then(function (res) {
      if (!res || res.ok === false) { return res; }
      try {
        var F = fb();
        if (!firebaseApp) {
          firebaseApp = (F.apps && F.apps.length)
            ? F.app()
            : F.initializeApp({
              apiKey: state.apiKey,
              authDomain: state.projectId + '.firebaseapp.com',
              projectId: state.projectId
            });
        }
        if (typeof F.auth !== 'function') {
          return fail('sdk_unavailable', 'Firebase Auth is not available.');
        }
        return { ok: true };
      } catch (e) {
        return fail('firebase_init_failed', (e && e.message) || 'Firebase init failed.');
      }
    });
  }

  function currentFirebaseUser() {
    try {
      var F = fb();
      if (!F || typeof F.auth !== 'function') { return null; }
      return F.auth().currentUser || null;
    } catch (e) {
      return null;
    }
  }

  function adoptFirebaseSession(idToken, username, email, isAnonymous) {
    state.token = String(idToken || '');
    state.username = String(username || '');
    state.email = String(email || '');
    state.isAnonymous = !!isAnonymous;
    storeSet(KEY_TOKEN, state.token);
    storeSet(KEY_USER, state.username);
    storeSet(KEY_EMAIL, state.email);
    storeSet(KEY_IS_ANONYMOUS, state.isAnonymous ? 'true' : '');
    state.lastError = '';
    return {
      ok: true,
      status: 200,
      data: {
        username: state.username,
        email: state.email,
        isAnonymous: state.isAnonymous
      }
    };
  }

  /* Maps a Firebase error object onto this file's flat result shape. */
  function firebaseFailure(e) {
    var code = (e && e.code) || 'firebase_error';
    var message = (e && e.message) || 'Sign-in failed.';
    return { ok: false, status: 0, error: String(code), message: String(message) };
  }

  function finishSignIn(cred) {
    var user = (cred && cred.user) || currentFirebaseUser();
    if (!user || typeof user.getIdToken !== 'function') {
      return resolved(fail('no_user', 'Firebase returned no user.'));
    }
    return Promise.resolve(user.getIdToken()).then(function (idToken) {
      var isAnon = !!user.isAnonymous;
      var name = user.displayName || '';
      var mail = user.email || '';
      if (!name && mail) { name = mail.split('@')[0]; }
      if (!name && isAnon) {
        name = 'Guest ' + (user.uid ? user.uid.substring(0, 6) : 'Pilot');
      }
      return adoptFirebaseSession(idToken, name, mail, isAnon);
    }, function (e) {
      return firebaseFailure(e);
    });
  }

  function withEmailPassword(method, email, password) {
    return ensureAuth().then(function (res) {
      if (!res || res.ok === false) { return res; }
      try {
        var p = fb().auth()[method](
          String(email == null ? '' : email),
          String(password == null ? '' : password)
        );
        if (!p || typeof p.then !== 'function') {
          return fail('firebase_error', 'Firebase did not return a promise.');
        }
        return p.then(finishSignIn, function (e) { return firebaseFailure(e); });
      } catch (e) {
        return firebaseFailure(e);
      }
    });
  }

  function signIn(email, password) {
    return withEmailPassword('signInWithEmailAndPassword', email, password);
  }

  function signUp(email, password) {
    return withEmailPassword('createUserWithEmailAndPassword', email, password);
  }

  /* Anonymous sign-in ("Play as Guest"). */
  function signInAnonymously() {
    return ensureAuth().then(function (res) {
      if (!res || res.ok === false) { return res; }
      try {
        var auth = fb().auth();
        if (typeof auth.signInAnonymously !== 'function') {
          return fail('not_supported', 'signInAnonymously is not supported by this SDK.');
        }
        var p = auth.signInAnonymously();
        if (!p || typeof p.then !== 'function') {
          return fail('firebase_error', 'Firebase did not return a promise.');
        }
        return p.then(finishSignIn, function (e) { return firebaseFailure(e); });
      } catch (e) {
        return firebaseFailure(e);
      }
    });
  }

  function handleLinkError(e) {
    var code = (e && e.code) || '';
    if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use' ||
        code === 'credential-already-in-use' || code === 'email-already-in-use') {
      return {
        ok: false,
        status: 409,
        error: 'credential_already_in_use',
        message: (e && e.message) || 'This credential is already linked to another account.'
      };
    }
    return firebaseFailure(e);
  }

  /* Account linking for anonymous accounts. Preserves UID, active run token and personal best. */
  function linkAccount(credentialOrEmail, password) {
    return ensureAuth().then(function (res) {
      if (!res || res.ok === false) { return res; }
      var user = currentFirebaseUser();
      if (!user) {
        return fail('no_user', 'No active user session to link.');
      }
      if (typeof user.linkWithCredential !== 'function') {
        return fail('not_supported', 'linkWithCredential is not supported by this SDK.');
      }
      var cred = null;
      var F = fb();
      try {
        if (credentialOrEmail && typeof credentialOrEmail === 'object') {
          cred = credentialOrEmail;
        } else if (typeof credentialOrEmail === 'string' && password !== undefined) {
          if (F && F.auth && F.auth.EmailAuthProvider && typeof F.auth.EmailAuthProvider.credential === 'function') {
            cred = F.auth.EmailAuthProvider.credential(String(credentialOrEmail), String(password));
          } else {
            cred = { providerId: 'password', email: String(credentialOrEmail), password: String(password) };
          }
        } else {
          return fail('invalid_argument', 'Provide a credential or email and password.');
        }
      } catch (e) {
        return firebaseFailure(e);
      }

      var p;
      try {
        p = user.linkWithCredential(cred);
      } catch (e) {
        return handleLinkError(e);
      }

      if (!p || typeof p.then !== 'function') {
        return fail('firebase_error', 'Firebase did not return a promise.');
      }

      return p.then(function (userCred) {
        var u = (userCred && userCred.user) || currentFirebaseUser() || user;
        return Promise.resolve(u.getIdToken ? u.getIdToken(true) : null).then(function (idToken) {
          state.isAnonymous = false;
          storeSet(KEY_IS_ANONYMOUS, '');
          if (idToken) {
            state.token = String(idToken);
            storeSet(KEY_TOKEN, state.token);
          }
          var mail = u.email || (typeof credentialOrEmail === 'string' ? credentialOrEmail : '');
          var name = u.displayName || '';
          if (!name && mail) { name = mail.split('@')[0]; }
          if (!name) { name = state.username; }
          state.username = name;
          state.email = mail;
          storeSet(KEY_USER, state.username);
          storeSet(KEY_EMAIL, state.email);
          renderSession();
          flushPending()['catch'](function () { /* ignore */ });
          return {
            ok: true,
            status: 200,
            data: {
              username: state.username,
              email: state.email,
              isAnonymous: false
            }
          };
        }, function (e) {
          return firebaseFailure(e);
        });
      }, function (e) {
        return handleLinkError(e);
      });
    });
  }

  function generateSecureNonce(len) {
    var length = len || 32;
    var chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    try {
      var crypt = (typeof window !== 'undefined' && (window.crypto || window.msCrypto)) || (typeof crypto !== 'undefined' ? crypto : null);
      if (!crypt || typeof crypt.getRandomValues !== 'function') {
        return null;
      }
      var buf = new Uint8Array(length);
      crypt.getRandomValues(buf);
      var res = '';
      for (var i = 0; i < length; i++) {
        res += chars.charAt(buf[i] % chars.length);
      }
      return res;
    } catch (e) {
      return null;
    }
  }

  function sha256Hex(str) {
    try {
      var crypt = (typeof window !== 'undefined' && (window.crypto || window.msCrypto)) || (typeof crypto !== 'undefined' ? crypto : null);
      if (!crypt || !crypt.subtle || typeof crypt.subtle.digest !== 'function') {
        return resolved(fail('crypto_unavailable', 'Web Crypto SHA-256 is unavailable on this device.'));
      }
      var enc = typeof TextEncoder === 'function' ? new TextEncoder() : null;
      var data = enc ? enc.encode(str) : null;
      if (!data) {
        data = new Uint8Array(str.length);
        for (var i = 0; i < str.length; i++) {
          data[i] = str.charCodeAt(i) & 0xff;
        }
      }
      return Promise.resolve(crypt.subtle.digest('SHA-256', data)).then(function (buf) {
        var arr = new Uint8Array(buf);
        var hex = '';
        for (var j = 0; j < arr.length; j++) {
          var h = arr[j].toString(16);
          hex += (h.length === 1 ? '0' + h : h);
        }
        return { ok: true, hash: hex };
      }, function (e) {
        return fail('crypto_unavailable', (e && e.message) || 'SHA-256 digest computation failed.');
      });
    } catch (e) {
      return resolved(fail('crypto_unavailable', (e && e.message) || 'SHA-256 digest computation failed.'));
    }
  }

  function getAppleCredential() {
    var capPlugin = null;
    try {
      if (typeof window !== 'undefined') {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SignInWithApple) {
          capPlugin = window.Capacitor.Plugins.SignInWithApple;
        } else if (window.SignInWithApple) {
          capPlugin = window.SignInWithApple;
        }
      }
    } catch (e) {}

    if (capPlugin && typeof capPlugin.authorize === 'function') {
      try {
        var rawNonce = generateSecureNonce(32);
        if (!rawNonce) {
          return resolved(fail('crypto_unavailable', 'Secure nonce generation is unavailable on this device.'));
        }
        return sha256Hex(rawNonce).then(function (hashRes) {
          if (!hashRes || hashRes.ok === false) { return hashRes; }
          var hashedNonce = hashRes.hash;
          var authPromise = capPlugin.authorize({
            clientId: 'com.neoninvaders.app',
            redirectURI: 'https://' + (state.projectId || 'demo-proj') + '.firebaseapp.com/__/auth/handler',
            scopes: 'email name',
            nonce: hashedNonce
          });
          return Promise.resolve(authPromise).then(function (res) {
            var idToken = (res && res.response && res.response.identityToken) ||
                          (res && res.identityToken) || (res && res.idToken) || '';
            if (!idToken) {
              return fail('no_identity_token', 'No identity token received from Apple native sign in.');
            }
            var F = fb();
            if (F && F.auth && F.auth.OAuthProvider) {
              var provider = new F.auth.OAuthProvider('apple.com');
              var cred = null;
              if (typeof provider.credential === 'function') {
                cred = provider.credential({
                  idToken: idToken,
                  rawNonce: rawNonce
                });
              } else if (typeof F.auth.OAuthProvider.credential === 'function') {
                try {
                  cred = F.auth.OAuthProvider.credential('apple.com', {
                    idToken: idToken,
                    rawNonce: rawNonce
                  });
                } catch (e1) {
                  cred = F.auth.OAuthProvider.credential({
                    idToken: idToken,
                    rawNonce: rawNonce
                  });
                }
              }
              if (cred) {
                return { ok: true, credential: cred, isNative: true };
              }
            }
            return { ok: true, credential: { providerId: 'apple.com', idToken: idToken, rawNonce: rawNonce }, isNative: true };
          }, function (e) {
            return firebaseFailure(e);
          });
        }, function (e) {
          return firebaseFailure(e);
        });
      } catch (e) {
        return resolved(firebaseFailure(e));
      }
    }

    var plat = getPlatform();
    if (plat === 'ios' || plat === 'android') {
      return resolved(fail('disallowed_useragent',
        'Native auth bridge required on mobile platforms to prevent disallowed_useragent OAuth blocking.'));
    }

    var F = fb();
    if (!F || !F.auth || !F.auth.OAuthProvider) {
      return resolved(fail('not_supported', 'OAuthProvider is not available in this SDK.'));
    }
    var webProvider = new F.auth.OAuthProvider('apple.com');
    if (typeof webProvider.addScope === 'function') {
      webProvider.addScope('email');
      webProvider.addScope('name');
    }
    return resolved({ ok: true, provider: webProvider, isNative: false });
  }

  function signInWithApple() {
    return ensureAuth().then(function (res) {
      if (!res || res.ok === false) { return res; }
      return getAppleCredential().then(function (credRes) {
        if (!credRes || credRes.ok === false) { return credRes; }
        var auth = fb().auth();
        var p;
        try {
          if (credRes.credential) {
            if (typeof auth.signInWithCredential === 'function') {
              p = auth.signInWithCredential(credRes.credential);
            } else {
              return fail('not_supported', 'signInWithCredential is not supported.');
            }
          } else if (credRes.provider) {
            if (typeof auth.signInWithPopup === 'function') {
              p = auth.signInWithPopup(credRes.provider);
            } else {
              return fail('not_supported', 'signInWithPopup is not supported.');
            }
          } else {
            return fail('no_credential', 'Could not obtain Apple credential.');
          }
        } catch (e) {
          return firebaseFailure(e);
        }
        return Promise.resolve(p).then(finishSignIn, function (e) { return firebaseFailure(e); });
      });
    });
  }

  function linkWithApple() {
    return ensureAuth().then(function (res) {
      if (!res || res.ok === false) { return res; }
      var user = currentFirebaseUser();
      if (!user) {
        return fail('no_user', 'No active user session to link.');
      }
      return getAppleCredential().then(function (credRes) {
        if (!credRes || credRes.ok === false) { return credRes; }
        if (credRes.credential) {
          return linkAccount(credRes.credential);
        } else if (credRes.provider) {
          if (typeof user.linkWithPopup === 'function') {
            var p;
            try {
              p = user.linkWithPopup(credRes.provider);
            } catch (e) {
              return handleLinkError(e);
            }
            return Promise.resolve(p).then(function (userCred) {
              var u = (userCred && userCred.user) || currentFirebaseUser() || user;
              return Promise.resolve(u.getIdToken ? u.getIdToken(true) : null).then(function (idToken) {
                state.isAnonymous = false;
                storeSet(KEY_IS_ANONYMOUS, '');
                if (idToken) {
                  state.token = String(idToken);
                  storeSet(KEY_TOKEN, state.token);
                }
                var mail = u.email || '';
                var name = u.displayName || '';
                if (!name && mail) { name = mail.split('@')[0]; }
                if (!name) { name = state.username; }
                state.username = name;
                state.email = mail;
                storeSet(KEY_USER, state.username);
                storeSet(KEY_EMAIL, state.email);
                renderSession();
                flushPending()['catch'](function () { /* ignore */ });
                return {
                  ok: true,
                  status: 200,
                  data: {
                    username: state.username,
                    email: state.email,
                    isAnonymous: false
                  }
                };
              }, function (e) {
                return firebaseFailure(e);
              });
            }, function (e) {
              return handleLinkError(e);
            });
          } else {
            return fail('not_supported', 'linkWithPopup is not supported.');
          }
        } else {
          return fail('no_credential', 'Could not obtain Apple credential.');
        }
      });
    });
  }

  /* One silent ID-token refresh. Firebase ID tokens expire after an hour, so a
   * long session (or a token restored from localStorage) will eventually get a
   * 401 from OUR server; this swaps in a fresh one and the caller retries
   * once. Resolves true only if the token actually changed hands. */
  function refreshIdToken() {
    var user = currentFirebaseUser();
    if (!user || typeof user.getIdToken !== 'function') {
      return resolved(false);
    }
    try {
      return Promise.resolve(user.getIdToken(true)).then(function (idToken) {
        if (!idToken) { return false; }
        state.token = String(idToken);
        storeSet(KEY_TOKEN, state.token);
        return true;
      }, function () { return false; });
    } catch (e) {
      return resolved(false);
    }
  }

  var lastForegroundAt = 0;
  var foregroundInFlight = false;
  var lifecycleHooked = false;

  /* Mobile lifecycle hook: on returning to foreground, refresh token and flush pending runs. */
  function onForeground() {
    var now = Date.now ? Date.now() : (+new Date());
    if (now - lastForegroundAt < 1000 || foregroundInFlight) {
      return;
    }
    lastForegroundAt = now;
    if (state.token) {
      foregroundInFlight = true;
      refreshIdToken().then(function () {
        return flushPending();
      })['catch'](function () {})
        .then(function () {
          foregroundInFlight = false;
        });
    }
  }

  function setupLifecycleHooks() {
    if (lifecycleHooked) { return; }
    lifecycleHooked = true;
    if (DOC && typeof DOC.addEventListener === 'function') {
      DOC.addEventListener('visibilitychange', function () {
        if (DOC.visibilityState === 'visible') {
          onForeground();
        }
      });
    }
    try {
      var capApp = null;
      if (typeof window !== 'undefined') {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
          capApp = window.Capacitor.Plugins.App;
        } else if (window.App) {
          capApp = window.App;
        }
      }
      if (capApp && typeof capApp.addListener === 'function') {
        capApp.addListener('appStateChange', function (appState) {
          if (appState && appState.isActive) {
            onForeground();
          }
        });
      }
    } catch (e) { /* ignore */ }
  }

  /* An authenticated request that survives one expired ID token. A 401 from
   * OUR server (not from Firebase) triggers a single silent refresh + retry;
   * if there is no SDK or no signed-in user, the caller's existing 401
   * handling (logout) takes over unchanged. */
  function authedRequest(method, path, body) {
    return request(method, path, body, state.token).then(function (res) {
      if (!res || res.status !== 401) { return res; }
      return refreshIdToken().then(function (refreshed) {
        if (!refreshed) { return res; }
        return request(method, path, body, state.token);
      });
    });
  }

  function logout() {
    try {
      var F = fb();
      if (F && typeof F.auth === 'function' && firebaseApp) {
        var p = F.auth().signOut();
        if (p && typeof p['catch'] === 'function') {
          p['catch'](function () { /* signing out locally is enough */ });
        }
      }
    } catch (e) {
      /* the local session is cleared regardless */
    }
    state.token = '';
    state.username = '';
    state.email = '';
    state.isAnonymous = false;
    state.personalBest = null;
    state.lastSubmit = null;
    runState = { token: '', startedMs: 0, failed: false };
    storeSet(KEY_TOKEN, '');
    storeSet(KEY_USER, '');
    storeSet(KEY_EMAIL, '');
    storeSet(KEY_IS_ANONYMOUS, '');
    // A pending run belongs to the account that played it. Dropping it here
    // stops it from being re-attributed to whoever signs in next.
    clearPending();
    return status();
  }

  /* Kept under the historical names so the exported API is unchanged for
   * callers (and for scripts/check-net.js); the mechanism behind them is now
   * Firebase rather than /api/auth/*. */
  function login(email, password) { return signIn(email, password); }
  function register(email, password) { return signUp(email, password); }

  /* ---------------------------- run tokens ---------------------------- */

  /* Asks the server to open a run. Called when the game enters PLAYING, so the
   * server's clock starts at the same moment the player's does. */
  function startRun() {
    runState = { token: '', startedMs: 0, failed: false };
    if (!state.token || !state.baseUrl) {
      runState.failed = true;
      return resolved(fail('not_logged_in', 'Not signed in.'));
    }
    return authedRequest('POST', '/api/runs/start', null).then(function (res) {
      if (res && res.ok && res.data && res.data.runToken) {
        runState.token = String(res.data.runToken);
        runState.startedMs = Number(res.data.startedMs) || 0;
        runState.failed = false;
      } else {
        runState.failed = true;
        if (res && res.status === 401) { logout(); }
      }
      return res;
    });
  }

  /* A failure worth retrying later: no answer at all (offline / timeout /
   * broken fetch), a server-side fault, or a rate limit. A 4xx other than 429
   * means the request itself was unacceptable and will never succeed. */
  function isRetryable(res) {
    if (!res || res.ok) { return false; }
    var s = Number(res.status) || 0;
    return s === 0 || s === 429 || s >= 500;
  }

  function submitScore(score, wave, runToken) {
    if (!state.token) {
      return resolved(fail('not_logged_in', 'Not signed in.'));
    }
    var s = clampScore(score);
    var w = clampWave(wave);
    var rt = typeof runToken === 'string' && runToken ? runToken : runState.token;
    /* No run token means the server never opened a run for this play-through,
     * so /api/scores would answer run_required forever. Fail TERMINALLY here
     * rather than queueing something that can never succeed (which would also
     * block the pending slot against the next, submittable run). */
    if (!rt) {
      clearPending();
      return resolved(fail('no_run',
        'This run was not registered with the server, so it cannot be submitted.'));
    }
    return authedRequest('POST', '/api/scores', { score: s, wave: w, runToken: rt })
      .then(function (res) {
        if (res && res.ok) {
          state.lastSubmit = { score: s, wave: w, at: Date.now() };
          if (res.data && res.data.personalBest) {
            state.personalBest = res.data.personalBest;
          }
          clearPending();
        } else if (res && res.status === 401) {
          // The token expired or the account is gone -- drop it rather than
          // retrying with a dead credential every run. logout() also clears
          // the pending slot.
          logout();
        } else if (isRetryable(res)) {
          // Flaky wifi / backend down must not silently eat the run. The run
          // token travels with it so the retry is still a valid submission.
          setPending(s, w, rt);
        } else {
          clearPending();
        }
        return res;
      });
  }

  /* Retries the one stored run, if any. Called after a successful sign-in and
   * at boot for an already-signed-in device. Resolves either way. */
  function flushPending() {
    var p = state.pending;
    if (!p || !state.token || !state.baseUrl) {
      return resolved(null);
    }
    return submitScore(p.score, p.wave, p.runToken);
  }

  function personalBest() {
    if (!state.token) {
      return resolved(fail('not_logged_in', 'Not signed in.'));
    }
    return authedRequest('GET', '/api/scores/me', null)
      .then(function (res) {
        if (res && res.ok && res.data) {
          state.personalBest = res.data;
        } else if (res && res.status === 401) {
          logout();
        }
        return res;
      });
  }

  function leaderboard(limit) {
    var n = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
    return request('GET', '/api/leaderboard?limit=' + n, null, null);
  }

  /* --------------------- game-over hook (no game.js edit) ------------- */

  var hooked = false;
  // Latched only once the server has CONFIRMED the run (NET-05). A separate
  // in-flight flag stops a re-entered GAME_OVER from firing a second request
  // while the first is still outstanding.
  var submittedThisRun = false;
  var submitInFlight = false;

  function currentGame(fallback) {
    return SI.game || fallback || null;
  }

  function maybeSubmit(gameRef) {
    if (!state.token || submittedThisRun || submitInFlight) { return; }
    var g = currentGame(gameRef);
    if (!g) { return; }
    var score = Number(g.score);
    var wave = Number(g.wave);
    if (!isFinite(score)) { score = 0; }
    if (!isFinite(wave)) { wave = 1; }
    submitInFlight = true;
    try {
      submitScore(score, wave).then(function (res) {
        submitInFlight = false;
        if (res && res.ok) {
          submittedThisRun = true;
          renderStatus('Submitted ' + score + ' (wave ' + wave + ').');
        } else if (state.pending) {
          renderStatus('Submit failed, will retry: ' +
            ((res && res.message) || 'unknown error'));
        } else {
          // Not retryable (rejected, or the session was dropped) -- allow a
          // later GAME_OVER in this run to try again rather than latching.
          renderStatus('Submit failed: ' + ((res && res.message) || 'unknown error'));
        }
        refreshBoard();
      })['catch'](function () { submitInFlight = false; });
    } catch (e) {
      submitInFlight = false;
      /* submission must never break the game-over screen */
    }
  }

  function hookGame() {
    if (hooked) { return true; }
    var G = SI.Game;
    if (!G || !G.prototype || typeof G.prototype.setState !== 'function') {
      return false;
    }
    var STATE = SI.STATE || G.STATE || { PLAYING: 'PLAYING', GAME_OVER: 'GAME_OVER', PAUSED: 'PAUSED' };
    var original = G.prototype.setState;

    G.prototype.setState = function (s) {
      var previous = this.state;
      original.call(this, s);
      var self = this;
      try {
        if (s === STATE.PLAYING && previous !== STATE.PAUSED) {
          submittedThisRun = false;
          /* A NEW run begins (resuming from PAUSED is the same run, so it is
           * excluded). Ask the server to start its clock now, so the elapsed
           * time it later measures covers the whole play-through. */
          startRun()['catch'](function () { /* never surfaces */ });
        } else if (s === STATE.GAME_OVER && previous !== STATE.GAME_OVER) {
          // Deferred by one macrotask: game.js can still award points after
          // gameOver() inside the same collision pass (see flushHi), so the
          // final score is only settled once this frame is done.
          setTimeout(function () { maybeSubmit(self); }, 0);
        }
      } catch (e) {
        /* the hook must never break the state machine */
      }
    };

    hooked = true;
    return true;
  }

  /* ------------------------------- panel UI --------------------------- */

  var els = null;

  var PANEL_CSS = [
    '#ni-net{position:fixed;right:10px;bottom:10px;z-index:50;',
    'font:12px/1.45 "Segoe UI","Helvetica Neue",Arial,sans-serif;',
    'color:#9df3ff;touch-action:auto;-webkit-user-select:text;user-select:text;}',
    '#ni-net *{box-sizing:border-box;touch-action:auto;-webkit-user-select:text;user-select:text;}',
    '#ni-net-toggle{display:block;margin-left:auto;cursor:pointer;',
    'background:rgba(8,7,26,.82);color:#9df3ff;border:1px solid #2b3d6b;',
    'border-radius:6px;padding:5px 10px;font:inherit;letter-spacing:.08em;}',
    '#ni-net-toggle:hover{border-color:#5ffbf1;color:#5ffbf1;}',
    '#ni-net-body{display:none;width:246px;margin-top:6px;padding:10px;',
    'background:rgba(6,5,20,.94);border:1px solid #2b3d6b;border-radius:8px;',
    'box-shadow:0 6px 26px rgba(0,0,0,.55);}',
    '#ni-net.ni-open #ni-net-body{display:block;}',
    '#ni-net label{display:block;margin:6px 0 2px;font-size:10px;',
    'letter-spacing:.1em;text-transform:uppercase;color:#6f8fbd;}',
    '#ni-net input{width:100%;padding:5px 7px;background:#0b0a20;color:#cfe9ff;',
    'border:1px solid #2b3d6b;border-radius:4px;font:inherit;}',
    '#ni-net input:focus{outline:none;border-color:#5ffbf1;}',
    '#ni-net .ni-row{display:flex;gap:6px;margin-top:9px;}',
    '#ni-net button.ni-act{flex:1;cursor:pointer;padding:5px 6px;font:inherit;',
    'background:#141a3c;color:#9df3ff;border:1px solid #2b3d6b;border-radius:4px;}',
    '#ni-net button.ni-act:hover{border-color:#ff56d5;color:#ff56d5;}',
    '#ni-net button.ni-apple{background:#000;color:#fff;border:1px solid #444;}',
    '#ni-net button.ni-apple:hover{border-color:#fff;color:#fff;}',
    '#ni-net .ni-badge{display:inline-block;padding:2px 5px;font-size:9px;font-weight:bold;',
    'letter-spacing:.08em;text-transform:uppercase;border-radius:3px;background:#ffd166;',
    'color:#060514;margin:6px 0 2px;}',
    '#ni-net .ni-status{margin-top:8px;min-height:15px;font-size:11px;color:#ffd166;',
    'word-break:break-word;}',
    '#ni-net .ni-board{margin-top:8px;max-height:132px;overflow:auto;font-size:11px;}',
    '#ni-net .ni-board div{display:flex;justify-content:space-between;gap:8px;',
    'padding:1px 0;color:#cfe9ff;}',
    '#ni-net .ni-board span:first-child{overflow:hidden;text-overflow:ellipsis;',
    'white-space:nowrap;}'
  ].join('');

  function injectStyle() {
    if (!DOC || DOC.getElementById('ni-net-style')) { return; }
    var head = DOC.head || DOC.getElementsByTagName('head')[0] || DOC.body;
    if (!head) { return; }
    var style = DOC.createElement('style');
    style.id = 'ni-net-style';
    style.type = 'text/css';
    if (style.styleSheet) {
      style.styleSheet.cssText = PANEL_CSS;   // old IE/WebView
    } else {
      style.appendChild(DOC.createTextNode(PANEL_CSS));
    }
    head.appendChild(style);
  }

  function el(tag, props) {
    var node = DOC.createElement(tag);
    for (var k in props) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        if (k === 'style' && typeof props[k] === 'object' && props[k] !== null) {
          for (var s in props[k]) {
            if (Object.prototype.hasOwnProperty.call(props[k], s)) {
              node.style[s] = props[k][s];
            }
          }
        } else {
          node[k] = props[k];
        }
      }
    }
    return node;
  }

  function renderStatus(text) {
    if (els && els.status) {
      els.status.textContent = String(text == null ? '' : text);
    }
  }

  function renderSession() {
    if (!els) { return; }
    var inSession = !!state.token;
    var isAnon = !!state.isAnonymous;
    var plat = getPlatform();
    var showApple = (plat === 'ios' || plat === 'web');

    if (inSession) {
      els.toggle.textContent = isAnon ? ('◈ [GUEST] ' + state.username) : ('◈ ' + state.username);
    } else {
      els.toggle.textContent = '◈ ONLINE';
    }

    if (els.guestBadge) {
      els.guestBadge.style.display = (inSession && isAnon) ? '' : 'none';
    }

    els.login.style.display = inSession ? 'none' : '';
    els.register.style.display = inSession ? 'none' : '';
    els.guest.style.display = inSession ? 'none' : '';
    els.apple.style.display = (!inSession && showApple) ? '' : 'none';

    if (els.linkSection) {
      els.linkSection.style.display = (inSession && isAnon) ? '' : 'none';
    }
    if (els.linkApple) {
      els.linkApple.style.display = (inSession && isAnon && showApple) ? '' : 'none';
    }

    els.logout.style.display = inSession ? '' : 'none';

    if (inSession && !isAnon) {
      els.username.disabled = true;
      els.password.disabled = true;
      els.username.value = state.username;
      els.password.value = '';
    } else if (inSession && isAnon) {
      els.username.disabled = false;
      els.password.disabled = false;
      els.username.value = '';
      els.password.value = '';
    } else {
      els.username.disabled = false;
      els.password.disabled = false;
    }
  }

  function renderBoard(entries) {
    if (!els || !els.board) { return; }
    while (els.board.firstChild) {
      els.board.removeChild(els.board.firstChild);
    }
    if (!entries || !entries.length) { return; }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var row = DOC.createElement('div');
      var left = DOC.createElement('span');
      var right = DOC.createElement('span');
      // textContent only -- a username from the server is never HTML.
      left.textContent = e.rank + '. ' + e.username;
      right.textContent = String(e.score);
      row.appendChild(left);
      row.appendChild(right);
      els.board.appendChild(row);
    }
  }

  function refreshBoard() {
    if (!state.baseUrl) { return; }
    leaderboard(10).then(function (res) {
      if (res && res.ok && res.data) {
        renderBoard(res.data.entries);
      }
    })['catch'](function () { /* never surfaces */ });
  }

  function readBase() {
    var v = normaliseBase(els && els.server ? els.server.value : '');
    state.baseUrl = v || normaliseBase(DEFAULT_BASE);
    storeSet(KEY_BASE, state.baseUrl);
    if (els && els.server) { els.server.value = state.baseUrl; }
    return state.baseUrl;
  }

  function readFirebaseConfig() {
    if (els && els.project) {
      state.projectId = String(els.project.value || '').trim();
      storeSet(KEY_PROJECT, state.projectId);
    }
    if (els && els.apiKey) {
      state.apiKey = String(els.apiKey.value || '').trim();
      storeSet(KEY_APIKEY, state.apiKey);
    }
  }

  function afterAuth(res) {
    if (res && res.ok) {
      renderStatus('Signed in as ' + state.username + '.');
      renderSession();
      refreshBoard();
      personalBest()['catch'](function () { /* never surfaces */ });
      flushPending()['catch'](function () { /* never surfaces */ });
    } else {
      renderStatus((res && res.message) || 'Request failed.');
    }
  }

  function doLogin() {
    readBase();
    readFirebaseConfig();
    renderStatus('Signing in...');
    signIn(els.username.value, els.password.value).then(afterAuth)
      ['catch'](function () { renderStatus('Request failed.'); });
  }

  function doRegister() {
    readBase();
    readFirebaseConfig();
    renderStatus('Creating account...');
    signUp(els.username.value, els.password.value).then(afterAuth)
      ['catch'](function () { renderStatus('Request failed.'); });
  }

  function doGuestSignIn() {
    readBase();
    readFirebaseConfig();
    renderStatus('Signing in as guest...');
    signInAnonymously().then(afterAuth)
      ['catch'](function () { renderStatus('Guest sign-in failed.'); });
  }

  function doAppleSignIn() {
    readBase();
    readFirebaseConfig();
    renderStatus('Connecting to Apple...');
    signInWithApple().then(afterAuth)
      ['catch'](function () { renderStatus('Apple sign-in failed.'); });
  }

  function doLinkAccount() {
    readBase();
    readFirebaseConfig();
    renderStatus('Linking account...');
    linkAccount(els.username.value, els.password.value).then(function (res) {
      if (res && res.ok) {
        renderStatus('Account linked! Signed in as ' + state.username + '.');
        renderSession();
        refreshBoard();
      } else {
        renderStatus((res && res.message) || 'Account linking failed.');
      }
    })['catch'](function () {
      renderStatus('Account linking failed.');
    });
  }

  function doLinkApple() {
    readBase();
    readFirebaseConfig();
    renderStatus('Linking with Apple...');
    linkWithApple().then(function (res) {
      if (res && res.ok) {
        renderStatus('Account linked with Apple! Signed in as ' + state.username + '.');
        renderSession();
        refreshBoard();
      } else {
        renderStatus((res && res.message) || 'Apple linking failed.');
      }
    })['catch'](function () {
      renderStatus('Apple linking failed.');
    });
  }

  function doLogout() {
    logout();
    renderSession();
    renderBoard([]);
    renderStatus('Signed out.');
  }

  /* js/input.js installs a window-level bubble-phase keydown listener that
   * preventDefault()s Space/Enter/A/D/Z/P/M. That would eat those characters
   * while the player types into the fields below. A CAPTURE listener on
   * window runs before any bubble listener anywhere, so stopping propagation
   * here keeps input.js from ever seeing the event.
   *
   * Scope, deliberately narrow (NET-01):
   *   - only for a real <input> INSIDE this panel. Shielding the whole panel
   *     subtree meant that clicking the toggle button (which stays focused in
   *     Chromium) made every later keydown target that button, blanket-
   *     blocking Space/arrows/A/D/Z/P/M until the canvas was re-clicked;
   *   - keydown/keypress only, never keyup (NET-03). input.js uses keyup only
   *     to CLEAR its pressed-key map; swallowing it strands a held arrow key
   *     as permanently down when the player clicks into a field mid-press.
   *
   * Because stopImmediatePropagation() during the capture phase also prevents
   * the TARGET-phase listeners from running, Enter-to-submit cannot be left to
   * the element's own onkeydown -- the shield invokes it directly instead
   * (NET-02), marking the event so the element handler cannot run it twice. */
  function isPanelInput(root, target) {
    return !!(target && root && target.tagName === 'INPUT' &&
      (root === target || (root.contains && root.contains(target))));
  }

  function shieldKeys(root, onKeydown) {
    if (typeof window === 'undefined' || !window.addEventListener) { return; }
    var shield = function (e) {
      if (!isPanelInput(root, e && e.target)) { return; }
      if (e.type === 'keydown' && typeof onKeydown === 'function') {
        try { onKeydown(e); } catch (err) { /* never break typing */ }
      }
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', shield, true);
    window.addEventListener('keypress', shield, true);
  }

  function buildPanel() {
    if (!DOC || !DOC.body || DOC.getElementById('ni-net')) { return; }
    injectStyle();

    var root = el('div', { id: 'ni-net' });
    var toggle = el('button', { id: 'ni-net-toggle', type: 'button', textContent: '◈ ONLINE' });
    var body = el('div', { id: 'ni-net-body' });

    var server = el('input', { type: 'text', value: state.baseUrl || DEFAULT_BASE, autocomplete: 'off', spellcheck: false });
    /* Firebase project id + web API key. The API key is a PUBLIC project
     * identifier, not a credential -- every Firebase web app ships it in
     * plain client JavaScript -- so keeping it in a visible field and in
     * localStorage leaks nothing. */
    var project = el('input', { type: 'text', value: state.projectId, autocomplete: 'off', spellcheck: false });
    var apiKey = el('input', { type: 'text', value: state.apiKey, autocomplete: 'off', spellcheck: false });
    // Firebase signs in with an email, not the old free-form username.
    var username = el('input', { type: 'email', autocomplete: 'username', spellcheck: false, maxLength: 254 });
    var password = el('input', { type: 'password', autocomplete: 'current-password', maxLength: 128 });

    body.appendChild(el('label', { textContent: 'Server' }));
    body.appendChild(server);
    body.appendChild(el('label', { textContent: 'Firebase project ID' }));
    body.appendChild(project);
    body.appendChild(el('label', { textContent: 'Firebase web API key' }));
    body.appendChild(apiKey);
    body.appendChild(el('label', { textContent: 'Email' }));
    body.appendChild(username);
    body.appendChild(el('label', { textContent: 'Password' }));
    body.appendChild(password);

    var guestBadge = el('div', { className: 'ni-badge', textContent: 'Guest Account' });
    body.appendChild(guestBadge);

    var row1 = el('div', { className: 'ni-row' });
    var loginBtn = el('button', { className: 'ni-act', type: 'button', textContent: 'Sign in' });
    var registerBtn = el('button', { className: 'ni-act', type: 'button', textContent: 'Register' });
    var logoutBtn = el('button', { className: 'ni-act', type: 'button', textContent: 'Sign out' });
    row1.appendChild(loginBtn);
    row1.appendChild(registerBtn);
    row1.appendChild(logoutBtn);
    body.appendChild(row1);

    var rowGuest = el('div', { className: 'ni-row' });
    var guestBtn = el('button', { className: 'ni-act', type: 'button', textContent: 'Play as Guest' });
    var appleBtn = el('button', { className: 'ni-act ni-apple', type: 'button', textContent: ' Sign in with Apple' });
    rowGuest.appendChild(guestBtn);
    rowGuest.appendChild(appleBtn);
    body.appendChild(rowGuest);

    var linkSection = el('div', { style: { display: 'none' } });
    linkSection.appendChild(el('label', { textContent: 'Link Account' }));
    var rowLink = el('div', { className: 'ni-row' });
    var linkBtn = el('button', { className: 'ni-act', type: 'button', textContent: 'Link Account' });
    var linkAppleBtn = el('button', { className: 'ni-act ni-apple', type: 'button', textContent: 'Link  Apple' });
    rowLink.appendChild(linkBtn);
    rowLink.appendChild(linkAppleBtn);
    linkSection.appendChild(rowLink);
    body.appendChild(linkSection);

    var statusEl = el('div', { className: 'ni-status' });
    var board = el('div', { className: 'ni-board' });
    body.appendChild(statusEl);
    body.appendChild(board);

    root.appendChild(toggle);
    root.appendChild(body);
    DOC.body.appendChild(root);

    els = {
      root: root, toggle: toggle, body: body, server: server,
      project: project, apiKey: apiKey,
      username: username, password: password,
      guestBadge: guestBadge,
      login: loginBtn, register: registerBtn, logout: logoutBtn,
      guest: guestBtn, apple: appleBtn,
      linkSection: linkSection, linkBtn: linkBtn, linkApple: linkAppleBtn,
      status: statusEl, board: board
    };

    // Every panel button drops focus once it has done its job. A button that
    // keeps focus turns the next Space/Enter -- the game's fire and start
    // keys -- into another click on that button (NET-01).
    function releaseFocus(node) {
      try {
        if (node && typeof node.blur === 'function') { node.blur(); }
      } catch (e) { /* not focusable in this engine */ }
    }

    toggle.onclick = function () {
      var open = root.className.indexOf('ni-open') !== -1;
      root.className = open ? '' : 'ni-open';
      if (!open) {
        /* OPENING the panel is the player's first explicit opt-in gesture, so
         * this is the earliest point the Firebase SDK may be fetched. It is
         * warmed here (rather than on the sign-in click) purely so the button
         * feels instant; a visitor who never opens the panel loads nothing. */
        ensureSdk()['catch'](function () { /* never surfaces */ });
        refreshBoard();
      }
      releaseFocus(toggle);
    };
    loginBtn.onclick = function () { doLogin(); releaseFocus(loginBtn); };
    registerBtn.onclick = function () { doRegister(); releaseFocus(registerBtn); };
    logoutBtn.onclick = function () { doLogout(); releaseFocus(logoutBtn); };
    guestBtn.onclick = function () { doGuestSignIn(); releaseFocus(guestBtn); };
    appleBtn.onclick = function () { doAppleSignIn(); releaseFocus(appleBtn); };
    linkBtn.onclick = function () { doLinkAccount(); releaseFocus(linkBtn); };
    linkAppleBtn.onclick = function () { doLinkApple(); releaseFocus(linkAppleBtn); };

    /* Enter inside a field submits. The capture-phase shield below calls this
     * directly (a capture-phase stopImmediatePropagation() would otherwise
     * prevent the target-phase handler from ever running); the property
     * handlers are the fallback for an engine with no window.addEventListener,
     * where no shield is installed. The marker makes the two paths exclusive. */
    var onEnter = function (e) {
      if (!e || e.niEnterHandled) { return; }
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.niEnterHandled = true;
        if (!state.token) {
          doLogin();
        } else if (state.isAnonymous) {
          doLinkAccount();
        }
      }
    };
    username.onkeydown = onEnter;
    password.onkeydown = onEnter;

    // Pointer events inside the panel must not reach the canvas underneath.
    root.onpointerdown = function (e) { e.stopPropagation(); };
    root.onmousedown = function (e) { e.stopPropagation(); };
    root.ontouchstart = function (e) { e.stopPropagation(); };

    shieldKeys(root, function (e) {
      // Only the credential fields submit on Enter, exactly as the property
      // handlers above would have.
      if (e && (e.target === username || e.target === password)) { onEnter(e); }
    });
    renderSession();
  }

  /* -------------------------------- boot ------------------------------ */

  function boot() {
    state.baseUrl = normaliseBase(storeGet(KEY_BASE));
    state.token = storeGet(KEY_TOKEN);
    state.username = storeGet(KEY_USER);
    state.email = storeGet(KEY_EMAIL) || '';
    state.isAnonymous = state.token ? (storeGet(KEY_IS_ANONYMOUS) === 'true') : false;
    // Config only -- reading these does NOT load the SDK or touch the network.
    state.projectId = storeGet(KEY_PROJECT);
    state.apiKey = storeGet(KEY_APIKEY);
    state.pending = state.token ? loadPending() : null;
    if (!state.token) {
      storeSet(KEY_PENDING, '');
      storeSet(KEY_EMAIL, '');
      storeSet(KEY_IS_ANONYMOUS, '');
    }

    hookGame();
    setupLifecycleHooks();
    buildPanel();

    // The only automatic traffic: a player who already signed in on this
    // device gets their board refreshed, and a run that failed to upload last
    // time is retried. A first-time visitor causes none.
    if (state.token && state.baseUrl) {
      refreshBoard();
      personalBest()['catch'](function () { /* never surfaces */ });
      flushPending()['catch'](function () { /* never surfaces */ });
    }
  }

  function safeBoot() {
    try {
      boot();
    } catch (e) {
      // The bridge is a luxury; the game is not. Swallow anything.
      if (typeof console !== 'undefined' && console && console.warn) {
        console.warn('[neon-invaders] net.js disabled:', e && e.message);
      }
    }
  }

  if (DOC && DOC.body) {
    safeBoot();
  } else if (DOC && DOC.addEventListener) {
    DOC.addEventListener('DOMContentLoaded', safeBoot);
  } else {
    safeBoot();
  }

  SI.Net = {
    configure: configure,
    status: status,
    // Historical names, now backed by Firebase Auth.
    register: register,
    login: login,
    // Preferred names.
    signIn: signIn,
    signUp: signUp,
    signInAnonymously: signInAnonymously,
    signInAsGuest: signInAnonymously,
    linkAccount: linkAccount,
    signInWithApple: signInWithApple,
    linkWithApple: linkWithApple,
    getPlatform: getPlatform,
    logout: logout,
    startRun: startRun,
    submitScore: submitScore,
    flushPending: flushPending,
    leaderboard: leaderboard,
    personalBest: personalBest,
    // Exposed for scripts/check-net.js.
    _internal: {
      request: request,
      hookGame: hookGame,
      boot: safeBoot,
      ensureSdk: ensureSdk,
      refreshIdToken: refreshIdToken,
      FIREBASE_CDN: FIREBASE_CDN,
      onForeground: onForeground,
      getPlatform: getPlatform
    }
  };
})(window.SI = window.SI || {});
