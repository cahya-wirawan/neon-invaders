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
 * performs ZERO network requests -- it only draws a small collapsed toggle
 * in the corner. The game keeps running offline, from file://, with the
 * backend down, or with fetch missing entirely.
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
  var KEY_PENDING = STORAGE_PREFIX + 'pendingSubmit';

  var DEFAULT_BASE = 'http://localhost:3000';
  var DEFAULT_TIMEOUT_MS = 8000;

  var state = {
    baseUrl: '',
    token: '',
    username: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    lastError: '',
    lastSubmit: null,
    personalBest: null,
    // A single run whose submit failed retryably, kept so the next successful
    // connection can send it. One slot, not a queue -- see NET-05.
    pending: null
  };

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

  function setPending(score, wave) {
    state.pending = { score: clampScore(score), wave: clampWave(wave) };
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
    return { score: clampScore(parsed.score), wave: clampWave(parsed.wave) };
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
    return status();
  }

  function status() {
    return {
      baseUrl: state.baseUrl,
      username: state.username,
      loggedIn: !!state.token,
      timeoutMs: state.timeoutMs,
      lastError: state.lastError,
      lastSubmit: state.lastSubmit,
      personalBest: state.personalBest,
      pendingSubmit: state.pending
        ? { score: state.pending.score, wave: state.pending.wave }
        : null
    };
  }

  function adoptSession(result) {
    if (result && result.ok && result.data && result.data.token) {
      state.token = String(result.data.token);
      state.username = (result.data.user && result.data.user.username) || '';
      storeSet(KEY_TOKEN, state.token);
      storeSet(KEY_USER, state.username);
      state.lastError = '';
    }
    return result;
  }

  function register(username, password) {
    return request('POST', '/api/auth/register', {
      username: String(username == null ? '' : username),
      password: String(password == null ? '' : password)
    }).then(adoptSession);
  }

  function login(username, password) {
    return request('POST', '/api/auth/login', {
      username: String(username == null ? '' : username),
      password: String(password == null ? '' : password)
    }).then(adoptSession);
  }

  function logout() {
    state.token = '';
    state.username = '';
    state.personalBest = null;
    state.lastSubmit = null;
    storeSet(KEY_TOKEN, '');
    storeSet(KEY_USER, '');
    // A pending run belongs to the account that played it. Dropping it here
    // stops it from being re-attributed to whoever signs in next.
    clearPending();
    return status();
  }

  /* A failure worth retrying later: no answer at all (offline / timeout /
   * broken fetch), a server-side fault, or a rate limit. A 4xx other than 429
   * means the request itself was unacceptable and will never succeed. */
  function isRetryable(res) {
    if (!res || res.ok) { return false; }
    var s = Number(res.status) || 0;
    return s === 0 || s === 429 || s >= 500;
  }

  function submitScore(score, wave) {
    if (!state.token) {
      return resolved(fail('not_logged_in', 'Not signed in.'));
    }
    var s = clampScore(score);
    var w = clampWave(wave);
    return request('POST', '/api/scores', { score: s, wave: w }, state.token)
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
          // Flaky wifi / backend down must not silently eat the run.
          setPending(s, w);
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
    return submitScore(p.score, p.wave);
  }

  function personalBest() {
    if (!state.token) {
      return resolved(fail('not_logged_in', 'Not signed in.'));
    }
    return request('GET', '/api/scores/me', null, state.token)
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
        node[k] = props[k];
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
    els.toggle.textContent = inSession ? ('◈ ' + state.username) : '◈ ONLINE';
    els.login.style.display = inSession ? 'none' : '';
    els.register.style.display = inSession ? 'none' : '';
    els.logout.style.display = inSession ? '' : 'none';
    els.username.disabled = inSession;
    els.password.disabled = inSession;
    if (inSession) {
      els.username.value = state.username;
      els.password.value = '';
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
    renderStatus('Signing in...');
    login(els.username.value, els.password.value).then(afterAuth)
      ['catch'](function () { renderStatus('Request failed.'); });
  }

  function doRegister() {
    readBase();
    renderStatus('Creating account...');
    register(els.username.value, els.password.value).then(afterAuth)
      ['catch'](function () { renderStatus('Request failed.'); });
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
    var username = el('input', { type: 'text', autocomplete: 'username', spellcheck: false, maxLength: 20 });
    var password = el('input', { type: 'password', autocomplete: 'current-password', maxLength: 72 });

    body.appendChild(el('label', { textContent: 'Server' }));
    body.appendChild(server);
    body.appendChild(el('label', { textContent: 'Username' }));
    body.appendChild(username);
    body.appendChild(el('label', { textContent: 'Password' }));
    body.appendChild(password);

    var row = el('div', { className: 'ni-row' });
    var loginBtn = el('button', { className: 'ni-act', type: 'button', textContent: 'Sign in' });
    var registerBtn = el('button', { className: 'ni-act', type: 'button', textContent: 'Register' });
    var logoutBtn = el('button', { className: 'ni-act', type: 'button', textContent: 'Sign out' });
    row.appendChild(loginBtn);
    row.appendChild(registerBtn);
    row.appendChild(logoutBtn);
    body.appendChild(row);

    var statusEl = el('div', { className: 'ni-status' });
    var board = el('div', { className: 'ni-board' });
    body.appendChild(statusEl);
    body.appendChild(board);

    root.appendChild(toggle);
    root.appendChild(body);
    DOC.body.appendChild(root);

    els = {
      root: root, toggle: toggle, body: body, server: server,
      username: username, password: password, login: loginBtn,
      register: registerBtn, logout: logoutBtn, status: statusEl, board: board
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
      if (!open) { refreshBoard(); }
      releaseFocus(toggle);
    };
    loginBtn.onclick = function () { doLogin(); releaseFocus(loginBtn); };
    registerBtn.onclick = function () { doRegister(); releaseFocus(registerBtn); };
    logoutBtn.onclick = function () { doLogout(); releaseFocus(logoutBtn); };

    /* Enter inside a field submits. The capture-phase shield below calls this
     * directly (a capture-phase stopImmediatePropagation() would otherwise
     * prevent the target-phase handler from ever running); the property
     * handlers are the fallback for an engine with no window.addEventListener,
     * where no shield is installed. The marker makes the two paths exclusive. */
    var onEnter = function (e) {
      if (!e || e.niEnterHandled) { return; }
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.niEnterHandled = true;
        if (!state.token) { doLogin(); }
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
    state.pending = state.token ? loadPending() : null;
    if (!state.token) { storeSet(KEY_PENDING, ''); }

    hookGame();
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
    register: register,
    login: login,
    logout: logout,
    submitScore: submitScore,
    flushPending: flushPending,
    leaderboard: leaderboard,
    personalBest: personalBest,
    // Exposed for scripts/check-net.js.
    _internal: { request: request, hookGame: hookGame, boot: safeBoot }
  };
})(window.SI = window.SI || {});
