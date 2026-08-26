#!/usr/bin/env node
/* check-game.js -- headless proof for the evolving formations and the
 * upgradeable cannon.
 *
 * Same trick as scripts/check-net.js: every js/*.js file is a plain IIFE
 * whose only free variables are `window` and `document`, so each one can be
 * loaded through `new Function` with hand-rolled stubs. No jsdom, no
 * dependencies. audio.js / input.js / starfield.js / main.js / net.js are
 * not loaded at all -- what they would have published on SI is stubbed
 * instead, which is also what lets the harness DRIVE input per tick.
 *
 * Math.random is replaced with a seeded mulberry32 for the duration of each
 * scenario and restored afterwards, so every run is reproducible.
 *
 * The headline scenario is the GOLDEN CHECKSUM: a seeded, scripted wave-1
 * simulation is digested tick by tick (score, alien positions, bullet
 * positions, lives, particle count) and compared against GOLDEN_DIGEST,
 * which was captured by running this very harness against the game as it
 * stood BEFORE formations and cannon upgrades existed. It is a pinned
 * constant on purpose: once the feature commit lands, `git show HEAD:js/*`
 * would return the NEW code and a HEAD-vs-worktree comparison would pass
 * trivially. The harness still runs the HEAD copy when it can, but only as
 * a secondary, informational cross-check.
 *
 *   node scripts/check-game.js     -> exit 0 on success, 1 on any failure
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');

/* Load order mirrors index.html, minus the files we stub out. */
const GAME_FILES = [
  'core.js', 'fx.js', 'particles.js', 'entities.js', 'props.js', 'hud.js', 'game.js'
];

const DT = 1 / 60;

/* Golden run parameters and the digest the PRE-FEATURE game produced for
 * them (measured against commit b316fc6, the last commit before evolving
 * formations and cannon upgrades were added). Changing SEED/TICKS/the input
 * script or snapshot() invalidates the constant -- if you must, re-measure
 * it by running this harness against that commit's js/, never by pasting in
 * whatever the current code happens to emit. */
const GOLDEN_SEED = 20260822;
const GOLDEN_TICKS = 1200;                     // 20 simulated seconds
const GOLDEN_DIGEST =
  '01cfdcd718d14da8fafb1a7df5fc6cc018476a2ef6932549ea813b3f45c1c04c';
const GOLDEN_SCORE = 420;
const GOLDEN_ALIVE = 29;

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`    ok   ${name}`);
  } else {
    failures += 1;
    console.log(`    FAIL ${name}${detail ? ' -- ' + detail : ''}`);
  }
  return !!condition;
}

const scenarioResults = [];

function scenario(name, fn) {
  console.log(`\n${name}`);
  const before = failures;
  try {
    fn();
  } catch (err) {
    failures += 1;
    checks += 1;
    console.log(`    FAIL threw -- ${(err && err.stack) || err}`);
  }
  const ok = failures === before;
  scenarioResults.push({ name, ok });
  return ok;
}

/* ------------------------------- RNG ---------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function withSeed(seed, fn) {
  const real = Math.random;
  Math.random = mulberry32(seed);
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

/* ------------------------------ stubs --------------------------------- */

const CTX_METHODS = [
  'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform',
  'resetTransform', 'transform', 'clearRect', 'fillRect', 'strokeRect',
  'drawImage', 'fillText', 'strokeText', 'beginPath', 'closePath', 'moveTo',
  'lineTo', 'arc', 'arcTo', 'ellipse', 'rect', 'quadraticCurveTo',
  'bezierCurveTo', 'fill', 'stroke', 'clip', 'setLineDash', 'putImageData'
];

function makeCtx() {
  const ctx = {
    canvas: null,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) })
  };
  for (const m of CTX_METHODS) ctx[m] = () => {};
  return ctx;
}

function makeDocument() {
  return {
    createElement(tag) {
      if (String(tag).toLowerCase() !== 'canvas') {
        return { tagName: String(tag).toUpperCase(), style: {} };
      }
      const canvas = { width: 0, height: 0, style: {} };
      const ctx = makeCtx();
      ctx.canvas = canvas;
      canvas.getContext = () => ctx;
      return canvas;
    },
    addEventListener() {},
    body: { appendChild() {}, style: {} },
    head: { appendChild() {} }
  };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map
  };
}

const AUDIO_METHODS = [
  'unlock', 'ready', 'setMuted', 'toggleMute', 'shoot', 'alienHit',
  'bunkerHit', 'playerHit', 'waveClear', 'gameOver', 'extraLife', 'ufoStart',
  'ufoStop', 'ufoKilled', 'startMusic', 'stopMusic', 'setMusicWave'
];

function makeAudio() {
  const audio = { calls: {}, isMuted: () => false };
  for (const m of AUDIO_METHODS) {
    audio[m] = function () { audio.calls[m] = (audio.calls[m] || 0) + 1; };
  }
  return audio;
}

/* Harness-controlled input: every field is set directly per tick. */
function makeInput(worldW, worldH) {
  const state = {
    axis: 0,
    fire: false,
    firePress: false,
    pause: false,
    mute: false,
    confirm: false,
    keys: Object.create(null),
    pointerState: { active: false, firing: false, x: worldW / 2, y: worldH / 2 }
  };
  const api = {
    _state: state,
    attach() {},
    setMapper() {},
    onFirstGesture() {},
    isDown: (code) => !!state.keys[code],
    justPressed: (code) => !!state.keys[code],
    endFrame() {
      state.keys = Object.create(null);
      state.firePress = false;
      state.pause = false;
      state.mute = false;
      state.confirm = false;
    },
    moveAxis: () => state.axis,
    firing: () => state.fire,
    firePressed: () => state.firePress,
    pausePressed: () => state.pause,
    mutePressed: () => state.mute,
    confirmPressed: () => state.confirm,
    pointer: () => state.pointerState,
    reset() {
      state.axis = 0;
      state.fire = false;
      state.keys = Object.create(null);
      state.pointerState.active = false;
      state.pointerState.firing = false;
    }
  };
  return api;
}

/* Loads one copy of the game into a fresh realm-ish object graph. */
function loadGame(jsDir) {
  const storage = makeStorage();
  const doc = makeDocument();
  const win = { localStorage: storage };
  win.window = win;
  win.SI = {};

  for (const file of GAME_FILES) {
    const src = fs.readFileSync(path.join(jsDir, file), 'utf8');
    const factory = new Function('window', 'document', 'localStorage', src);
    factory(win, doc, storage);
  }

  const SI = win.SI;
  SI.Audio = makeAudio();
  SI.Input = makeInput(SI.CONFIG.WORLD_W, SI.CONFIG.WORLD_H);
  return { SI, win, doc, storage, ctx: makeCtx(), input: SI.Input._state };
}

/* -------------------------- simulation driver -------------------------- */

function tick(env, game, dt) {
  game.update(dt == null ? DT : dt);
  game.draw(env.ctx);
  game.drawHud(env.ctx);
  env.SI.Input.endFrame();
}

function alivePlayerBullets(game) {
  return game.bullets.filter((b) => !b.dead && b.from === 'player');
}

/* ------------------------- 1. golden checksum -------------------------- */

/* Snapshot everything a formation or an upgrade could possibly perturb. */
function snapshot(game) {
  const parts = [
    game.state, game.score, game.hi, game.lives, game.wave,
    game.player.x, game.player.y, game.player.alive, game.player.invuln,
    game.particles.count
  ];
  const sw = game.swarm;
  if (sw) {
    parts.push(sw.dir, sw.descended, sw.aliveCount(), sw.fireTimer, sw.frame);
    for (const a of sw.aliens) {
      if (!a.alive) continue;
      parts.push(a.col, a.row, a.x, a.y);
    }
  }
  for (const b of game.bullets) {
    if (b.dead) continue;
    parts.push(b.from, b.x, b.y, b.vy);
  }
  if (game.ufo) parts.push('ufo', game.ufo.x, game.ufo.y, game.ufo.score);
  return parts.join('|');
}

/* A fixed, reproducible input script -- identical for both code copies. */
function scriptInput(input, t) {
  input.axis = (Math.floor(t / 37) % 3) - 1;
  input.fire = (t % 23) < 5;
  input.firePress = (t % 23) === 0;
}

function goldenDigest(jsDir, seed, ticks) {
  return withSeed(seed, () => {
    const env = loadGame(jsDir);
    const game = new env.SI.Game();
    const input = env.input;
    input.confirm = true;
    tick(env, game, DT);            // MENU -> startGame()
    const hash = crypto.createHash('sha256');
    for (let t = 0; t < ticks; t++) {
      scriptInput(input, t);
      tick(env, game, DT);
      hash.update(snapshot(game));
      hash.update('\n');
    }
    return {
      digest: hash.digest('hex'),
      wave: game.wave,
      score: game.score,
      state: game.state,
      alive: game.swarm ? game.swarm.aliveCount() : -1
    };
  });
}

/* Materialises js/ as it exists at git HEAD, so the golden baseline is the
 * committed game rather than something the harness author hand-copied. */
function baselineJsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-baseline-'));
  for (const file of GAME_FILES) {
    const src = execFileSync('git', ['show', `HEAD:js/${file}`], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024
    });
    fs.writeFileSync(path.join(dir, file), src);
  }
  return dir;
}

/* ------------------------------ helpers -------------------------------- */

function startedGame(env, wave) {
  const game = new env.SI.Game();
  game.startGame();
  if (wave && wave !== 1) {
    game.startWave(wave);
    game.setState(env.SI.STATE.PLAYING);
  }
  return game;
}

function quietSwarm(game) {
  if (game.swarm) game.swarm.fireTimer = Infinity;
  game.ufoTimer = Infinity;
}

function maxOffGrid(swarm) {
  let worst = 0;
  for (const a of swarm.aliens) {
    if (!a.alive) continue;
    worst = Math.max(worst, Math.abs(a.x - a.gx), Math.abs(a.y - a.gy));
  }
  return worst;
}

/* ================================ RUN ================================== */

console.log('check-game.js -- formations + cannon upgrades');

let baselineDir = null;
try {
  baselineDir = baselineJsDir();
} catch (e) {
  console.log(`\n(could not extract HEAD:js/* -- ${e.message})`);
}

/* --------------------------------------------------------------------- */
scenario('1. baseline/regression -- golden checksum vs the pre-feature game', () => {
  const now = goldenDigest(JS_DIR, GOLDEN_SEED, GOLDEN_TICKS);
  console.log(`    current : wave=${now.wave} score=${now.score} alive=${now.alive} state=${now.state}`);
  console.log(`    expected digest ${GOLDEN_DIGEST}   (pre-feature, commit b316fc6)`);
  console.log(`    current  digest ${now.digest}`);
  check('golden run stays inside wave 1 (formations arm from wave 2)', now.wave === 1,
    `wave=${now.wave}`);
  check('golden run actually did something (score > 0, aliens killed)',
    now.score > 0 && now.alive < 55, `score=${now.score} alive=${now.alive}`);
  check('score progression matches the pre-feature game',
    now.score === GOLDEN_SCORE, `${now.score} vs ${GOLDEN_SCORE}`);
  check('final alive count matches the pre-feature game',
    now.alive === GOLDEN_ALIVE, `${now.alive} vs ${GOLDEN_ALIVE}`);
  check('full per-tick digest matches (positions, bullets, score, lives, particles)',
    now.digest === GOLDEN_DIGEST, `${now.digest} vs ${GOLDEN_DIGEST}`);

  /* Secondary, informational: replay the same run against whatever js/ is
   * at git HEAD. Before the feature commit this is an independent second
   * opinion; after it, it is expected to agree trivially. */
  if (baselineDir) {
    const head = goldenDigest(baselineDir, GOLDEN_SEED, GOLDEN_TICKS);
    console.log(`    HEAD:js/ digest ${head.digest} (informational cross-check)`);
    check('working tree agrees with the HEAD copy of js/', head.digest === now.digest,
      `${head.digest} vs ${now.digest}`);
  } else {
    console.log('    (skipped HEAD cross-check -- git show unavailable)');
  }
});

/* --------------------------------------------------------------------- */
scenario('2. no-upgrade bullet is byte-for-byte the classic bullet', () => {
  withSeed(11, () => {
    const env = loadGame(JS_DIR);
    const game = startedGame(env);
    check("default upgrade is 'none'", game.upgrade === 'none', String(game.upgrade));
    env.input.fire = true;
    env.input.firePress = true;
    tick(env, game);
    const shots = alivePlayerBullets(game);
    check('exactly one player bullet', shots.length === 1, `got ${shots.length}`);
    const b = shots[0];
    check('vx === 0', b.vx === 0, String(b.vx));
    check('pierce === 0', b.pierce === 0, String(b.pierce));
    check('bounce === 0', b.bounce === 0, String(b.bounce));
    const top = Math.min(b.y, b.prevY) - b.h / 2;
    const bottom = Math.max(b.y, b.prevY) + b.h / 2;
    const expected = { x: b.x - b.w / 2, y: top, w: b.w, h: bottom - top };
    const got = b.box();
    check('box() matches the pre-existing y-only swept formula',
      got.x === expected.x && got.y === expected.y &&
      got.w === expected.w && got.h === expected.h,
      `${JSON.stringify(got)} vs ${JSON.stringify(expected)}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('3. WEDGE formation deviates then returns exactly to the grid', () => {
  withSeed(22, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const game = startedGame(env, 2);
    quietSwarm(game);
    const sw = game.swarm;
    sw.formationTimer = Infinity;           // only the forced one runs
    sw.startFormation('wedge', game.world);
    check('formation started', !!sw.formation && sw.formation.kind === 'wedge');

    let holdSeen = false;
    let centreDepth = 0;
    let edgeDepth = 0;
    let edgeShift = 0;
    let deepestCol = -1;
    const span = Math.ceil(
      (C.FORMATION.EASE_IN + C.FORMATION.HOLD + C.FORMATION.EASE_OUT) / DT) + 30;
    for (let t = 0; t < span && sw.formation; t++) {
      tick(env, game);
      if (sw.formation && sw.formation.phase === 1 && !holdSeen) {
        holdSeen = true;
        let best = -Infinity;
        for (const a of sw.aliens) {
          if (!a.alive) continue;
          const d = a.y - a.gy;
          if (d > best) { best = d; deepestCol = a.col; }
          if (a.col === 5) { centreDepth = d; }
          if (a.col === 0) { edgeDepth = d; edgeShift = a.x - a.gx; }
        }
      }
    }
    check('reached the HOLD phase', holdSeen);
    check('centre column dips ~WEDGE_DEPTH',
      Math.abs(centreDepth - C.FORMATION.WEDGE_DEPTH) < 0.5, `dip=${centreDepth}`);
    check('centre column is the deepest', deepestCol === 5, `deepest col=${deepestCol}`);
    check('outer column stays at grid depth', Math.abs(edgeDepth) < 0.5, `dip=${edgeDepth}`);
    check('outer column is pinched inward',
      Math.abs(edgeShift - 5 * C.FORMATION.WEDGE_PINCH) < 0.5, `shift=${edgeShift}`);
    check('formation completed', sw.formation === null);

    let clean = true;
    let bad = '';
    for (const a of sw.aliens) {
      if (!a.alive) continue;
      if (a.x !== a.gx || a.y !== a.gy || a.fx !== 0 || a.fy !== 0) {
        clean = false;
        bad = `col${a.col} row${a.row} x=${a.x} gx=${a.gx} y=${a.y} gy=${a.gy} fx=${a.fx} fy=${a.fy}`;
        break;
      }
    }
    check('every alien returned to x===gx, y===gy, fx===0, fy===0', clean, bad);
  });
});

/* --------------------------------------------------------------------- */
scenario('4. DIVE moves one column only; the rest of the swarm marches on', () => {
  withSeed(33, () => {
    const env = loadGame(JS_DIR);
    const game = startedGame(env, 2);
    quietSwarm(game);
    const sw = game.swarm;
    sw.formationTimer = Infinity;
    const before = new Map(sw.aliens.map((a) => [a, { gx: a.gx, gy: a.gy }]));
    sw.startFormation('dive', game.world);
    const col = sw.formation ? sw.formation.col : -1;
    check('dive started against one column', !!sw.formation && col >= 0, `col=${col}`);

    let offColOffset = 0;
    let diveDepth = 0;
    let checkedAtHold = false;
    for (let t = 0; t < 200 && sw.formation; t++) {
      tick(env, game);
      if (sw.formation && sw.formation.phase === 1 && !checkedAtHold) {
        checkedAtHold = true;
        for (const a of sw.aliens) {
          if (!a.alive) continue;
          if (a.col === col) {
            diveDepth = Math.max(diveDepth, a.y - a.gy);
          } else {
            offColOffset = Math.max(offColOffset, Math.abs(a.x - a.gx), Math.abs(a.y - a.gy));
            if (a.fx !== 0 || a.fy !== 0) { offColOffset = Infinity; }
          }
        }
      }
    }
    check('sampled the hold phase', checkedAtHold);
    check('diving column is well below its grid anchor', diveDepth > 60, `depth=${diveDepth}`);
    check('every other alien has zero offset (fx/fy === 0, x===gx, y===gy)',
      offColOffset === 0, `worst=${offColOffset}`);

    let marched = 0;
    for (const a of sw.aliens) {
      if (!a.alive || a.col === col) continue;
      const b0 = before.get(a);
      if (Math.abs(a.gx - b0.gx) > 1 || Math.abs(a.gy - b0.gy) > 0) marched++;
    }
    check('non-diving aliens kept advancing their grid anchors', marched > 0, `moved=${marched}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('5. formation bounds safety (never reaches bunkers or the floor)', () => {
  withSeed(44, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const game = startedGame(env, 5);
    quietSwarm(game);
    const sw = game.swarm;

    let worstY = -Infinity;
    let crushLine = 0;
    let invasions = 0;
    let gridMaxSeen = -Infinity;
    const realInvasion = game.world.onInvasion;
    game.world.onInvasion = function () { invasions++; realInvasion(); };

    for (let t = 0; t < 1200; t++) {
      quietSwarm(game);
      if (!sw.formation) {
        sw.formationTimer = 0;                 // force back-to-back formations
        sw.formationsEnabled = true;
      }
      tick(env, game);
      for (const a of sw.aliens) {
        /* A COMMITTED KAMIKAZE is the one documented, deliberate exemption
         * to this invariant: it leaves the grid entirely, owns its own
         * absolute x/y (a.dive) and is meant to reach the ship, which is
         * below both of these lines. Skipping it here narrows this scenario
         * to what it has always been about -- CHOREOGRAPHY (fx/fy offsets
         * applied on top of the grid anchor) never reaching the bunkers or
         * the floor -- and does not leave the dive unchecked: scenario 26
         * verifies the diver's own bounds, its crash floor, and that its
         * grid anchor stays untouched throughout. */
        if (!a.alive || a.dive) continue;
        worstY = Math.max(worstY, a.y);
        crushLine = Math.max(crushLine, a.y + a.h / 2);
      }
      gridMaxSeen = Math.max(gridMaxSeen, sw.gridBounds().maxY);
    }

    check('formations really did run repeatedly', sw.formationCount >= 4,
      `count=${sw.formationCount}`);
    check('no alien ever exceeded FORMATION.MAX_Y',
      worstY <= C.FORMATION.MAX_Y + 1e-9, `worst=${worstY} max=${C.FORMATION.MAX_Y}`);
    check('no alien ever crossed the bunker-crush line (BUNKER.Y - 4)',
      crushLine < C.BUNKER.Y - 4, `worst=${crushLine} line=${C.BUNKER.Y - 4}`);
    check('grid never reached FLOOR_Y in this run', gridMaxSeen < C.SWARM.FLOOR_Y,
      `gridMax=${gridMaxSeen}`);
    check('no invasion fired while the grid was above FLOOR_Y', invasions === 0,
      `fired=${invasions}`);
    let bunkersAlive = 0;
    for (const b of game.bunkers) if (b.alive()) bunkersAlive++;
    check('all four bunkers survived', bunkersAlive === 4, `alive=${bunkersAlive}`);

    /* Directional proof: the invasion decision reads the GRID, not the
     * effective (formation-displaced) position. */
    sw.startFormation('dive', game.world);
    for (let t = 0; t < 80 && sw.formation && sw.formation.phase === 0; t++) tick(env, game);
    check('a live formation genuinely displaces the effective bounds',
      sw.formation !== null && sw.bounds().maxY > sw.gridBounds().maxY,
      `eff=${sw.bounds().maxY} grid=${sw.gridBounds().maxY}`);
    const beforeCross = invasions;
    const lift = C.SWARM.FLOOR_Y - sw.gridBounds().maxY + 1;
    for (const a of sw.aliens) { if (a.alive) a.gy += lift; }
    tick(env, game);
    check('invasion fires the moment the GRID crosses FLOOR_Y (even mid-formation)',
      invasions > beforeCross, `before=${beforeCross} after=${invasions}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('6. exactly one commander per wave, from COMMANDER.FROM_WAVE up', () => {
  withSeed(55, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    let ok = true;
    let detail = '';
    for (let wave = 1; wave <= 10; wave++) {
      const sw = new env.SI.Swarm(wave);
      const n = sw.aliens.filter((a) => a.commander).length;
      const want = wave >= C.COMMANDER.FROM_WAVE ? 1 : 0;
      if (n !== want) { ok = false; detail += ` wave${wave}:${n}!=${want}`; }
      if (want === 1) {
        if (sw.commander !== sw.aliens.find((a) => a.commander)) {
          ok = false; detail += ` wave${wave}:cache-mismatch`;
        }
        if (sw.commander.score <= (C.SCORE.ROW[sw.commander.row] || 10)) {
          ok = false; detail += ` wave${wave}:no-bonus`;
        }
      }
    }
    check('waves 1..10 have the expected commander count', ok, detail.trim());
    const sw3 = new env.SI.Swarm(3);
    check('commander carries the score bonus through the existing addScore path',
      sw3.commander.score === (C.SCORE.ROW[sw3.commander.row] || 10) + C.COMMANDER.SCORE_BONUS,
      `score=${sw3.commander.score}`);
    check('commander is rendered distinctly (own colour)',
      sw3.commander.color === C.COLORS.commander, sw3.commander.color);
  });
});

/* --------------------------------------------------------------------- */
scenario('7. killing the commander cancels the formation and grounds the wave', () => {
  withSeed(66, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const game = startedGame(env, 3);
    quietSwarm(game);
    const sw = game.swarm;
    sw.formationTimer = Infinity;
    const cmd = sw.commander;
    check('wave 3 swarm has a commander', !!cmd);

    sw.startFormation('wedge', game.world);
    for (let t = 0; t < 90 && sw.formation && sw.formation.phase !== 1; t++) tick(env, game);
    check('formation is in flight before the kill', !!sw.formation && sw.formation.phase === 1);
    check('aliens are visibly off-grid before the kill', maxOffGrid(sw) > 5,
      `off=${maxOffGrid(sw)}`);

    const scoreBefore = game.score;
    const shot = new env.SI.Bullet(cmd.x, cmd.y, -C.BULLET.PLAYER_SPEED, 'player', '#fff');
    game.bullets.push(shot);
    let threw = null;
    try {
      tick(env, game);
    } catch (e) { threw = e; }
    check('no exception on the kill tick', threw === null, threw && String(threw));
    check('the commander actually died via collide()', cmd.alive === false);
    check('score included the commander bonus',
      game.score - scoreBefore === cmd.score, `delta=${game.score - scoreBefore} score=${cmd.score}`);
    check('formation cancelled', sw.formation === null);
    check('commander cache cleared', sw.commander === null);
    check('formations disabled for the wave', sw.formationsEnabled === false);
    check('every alien snapped back to the grid within one tick', maxOffGrid(sw) === 0,
      `off=${maxOffGrid(sw)}`);

    let restarted = false;
    let ticked = 0;
    for (let t = 0; t < 1500; t++) {
      quietSwarm(game);
      tick(env, game);
      ticked++;
      if (sw.formation !== null || sw.formationsEnabled) { restarted = true; break; }
    }
    check(`no new formation started for the rest of the wave (${ticked} further ticks)`,
      !restarted);
  });
});

/* --------------------------------------------------------------------- */
scenario('8. SPREAD SHOT fires three angled bullets per volley', () => {
  withSeed(77, () => {
    const env = loadGame(JS_DIR);
    const game = startedGame(env);
    game.upgrade = 'spread';
    env.input.fire = true;
    env.input.firePress = true;
    tick(env, game);
    const shots = alivePlayerBullets(game);
    check('exactly three player bullets', shots.length === 3, `got ${shots.length}`);
    const vxs = new Set(shots.map((b) => b.vx));
    check('at least two distinct vx values', vxs.size >= 2, `vx=${[...vxs].join(',')}`);
    check('one shot still travels dead ahead (vx === 0)', shots.some((b) => b.vx === 0));
    check('one muzzle shoot() per volley, not three',
      env.SI.Audio.calls.shoot === 1, `calls=${env.SI.Audio.calls.shoot}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('9. PIERCING LASER survives its first kill and takes a second alien', () => {
  withSeed(88, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const game = startedGame(env);
    quietSwarm(game);
    const sw = game.swarm;
    const column = sw.aliens.filter((a) => a.alive && a.col === 5).sort((a, b) => b.y - a.y);
    const target = column[0];
    const shot = new env.SI.Bullet(target.x, target.y, -C.BULLET.PLAYER_SPEED, 'player', '#fff');
    shot.pierce = C.UPGRADE.PIERCE_COUNT;
    game.bullets.push(shot);
    tick(env, game);
    check('first alien died', target.alive === false);
    check('bullet survived the first kill', shot.dead === false);
    check('pierce decremented', shot.pierce === C.UPGRADE.PIERCE_COUNT - 1,
      `pierce=${shot.pierce}`);

    let kills = 1;
    for (let t = 0; t < 120 && !shot.dead; t++) {
      quietSwarm(game);
      tick(env, game);
      kills = column.filter((a) => !a.alive).length;
    }
    check('killed a second aligned alien before dying', kills >= 2, `kills=${kills}`);
    check('the laser did eventually die', shot.dead === true);
    check('it never killed more than PIERCE_COUNT + 1 aliens in its column',
      kills <= C.UPGRADE.PIERCE_COUNT + 1, `kills=${kills}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('10. BOUNCING PROJECTILE reflects BOUNCE_MAX times, then expires', () => {
  withSeed(99, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const world = { particles: null };
    const b = new env.SI.Bullet(C.WORLD_W - 60, 400, 0, 'player', '#fff');
    b.vx = C.UPGRADE.BOUNCE_VX;
    b.bounce = C.UPGRADE.BOUNCE_MAX;

    let reflections = 0;
    let outOfBounds = 0;
    let prevSign = Math.sign(b.vx);
    let prevBounce = b.bounce;
    for (let t = 0; t < 4000 && !b.dead; t++) {
      b.update(DT, world);
      if (b.dead) break;
      if (b.x < b.w / 2 - 1e-9 || b.x > C.WORLD_W - b.w / 2 + 1e-9) outOfBounds++;
      const sign = Math.sign(b.vx);
      if (sign !== prevSign) {
        reflections++;
        if (b.bounce !== prevBounce - 1) outOfBounds += 1000;  // decrement check
        prevBounce = b.bounce;
        prevSign = sign;
      }
    }
    check(`reflected exactly BOUNCE_MAX (${C.UPGRADE.BOUNCE_MAX}) times`,
      reflections === C.UPGRADE.BOUNCE_MAX, `reflections=${reflections}`);
    check('bounce counter reached 0', b.bounce === 0, `bounce=${b.bounce}`);
    check('x stayed inside the world at all times', outOfBounds === 0,
      `violations=${outOfBounds}`);
    check('died on the (BOUNCE_MAX + 1)th edge contact', b.dead === true);

    const straight = new env.SI.Bullet(C.WORLD_W - 2, 400, -720, 'player', '#fff');
    for (let t = 0; t < 5; t++) straight.update(DT, world);
    check('a vx === 0 bullet is untouched by the edge logic', straight.dead === false);
  });
});

/* --------------------------------------------------------------------- */
function driveToUpgradeScreen(env, game) {
  game.clearWave();
  for (let t = 0; t < 400 && game.state !== env.SI.STATE.UPGRADE; t++) tick(env, game);
  return game.state === env.SI.STATE.UPGRADE;
}

function confirmUpgrade(env, game, id) {
  const ids = env.SI.CONFIG.UPGRADE.IDS;
  game.upgradeIndex = ids.indexOf(id);
  const dwell = Math.ceil(env.SI.CONFIG.UPGRADE.MIN_DWELL / DT) + 1;
  for (let t = 0; t < dwell; t++) tick(env, game);
  env.input.confirm = true;
  tick(env, game);
  return game.state === env.SI.STATE.PLAYING;
}

scenario('11. TEMPORARY SHIELD survives startWave()\'s player.reset(true)', () => {
  withSeed(101, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const game = startedGame(env);
    check('WAVE_CLEAR now leads to the UPGRADE screen', driveToUpgradeScreen(env, game),
      `state=${game.state}`);
    const waveBefore = game.wave;
    check('shield confirmed', confirmUpgrade(env, game, 'shield'), `state=${game.state}`);
    check('next wave started', game.wave === waveBefore + 1, `wave=${game.wave}`);
    check("upgrade recorded as 'shield'", game.upgrade === 'shield', game.upgrade);
    check('player.invuln >= UPGRADE.SHIELD_TIME (not clobbered by reset)',
      game.player.invuln >= C.UPGRADE.SHIELD_TIME,
      `invuln=${game.player.invuln} want>=${C.UPGRADE.SHIELD_TIME}`);
    check('the shield is strictly longer than the normal respawn invulnerability',
      game.player.invuln > C.PLAYER.INVULN_TIME,
      `invuln=${game.player.invuln} normal=${C.PLAYER.INVULN_TIME}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('12. a new upgrade REPLACES the previous one (never stacks)', () => {
  withSeed(202, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const game = startedGame(env);

    check('reached first upgrade screen', driveToUpgradeScreen(env, game), game.state);
    check('spread confirmed', confirmUpgrade(env, game, 'spread'));
    quietSwarm(game);
    env.input.fire = true;
    env.input.firePress = true;
    tick(env, game);
    const first = alivePlayerBullets(game);
    check('spread fires three bullets', first.length === 3, `got ${first.length}`);
    env.input.fire = false;

    check('reached second upgrade screen', driveToUpgradeScreen(env, game), game.state);
    check('bounce confirmed', confirmUpgrade(env, game, 'bounce'));
    check("upgrade replaced, not stacked ('bounce')", game.upgrade === 'bounce', game.upgrade);
    quietSwarm(game);
    env.input.fire = true;
    env.input.firePress = true;
    tick(env, game);
    const second = alivePlayerBullets(game);
    check('exactly one bullet now, not three', second.length === 1, `got ${second.length}`);
    if (second.length === 1) {
      check('it is a bouncing shot', second[0].bounce === C.UPGRADE.BOUNCE_MAX,
        `bounce=${second[0].bounce}`);
      check('it has horizontal velocity', second[0].vx !== 0, `vx=${second[0].vx}`);
      check('it is NOT a piercing shot', second[0].pierce === 0, `pierce=${second[0].pierce}`);
    }
  });
});

/* --------------------------------------------------------------------- */
scenario('13. multi-wave regression: no exceptions, pool capped, systems intact', () => {
  withSeed(303, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const game = startedGame(env);
    const errors = [];
    let poolOverflow = 0;
    let maxParticles = 0;
    let commanderWaves = 0;
    let formationsSeen = 0;
    let ufoSpawns = 0;
    const upgradeIds = C.UPGRADE.IDS;
    let pickTurn = 0;
    const seenWaves = new Set();

    for (let t = 0; t < 6000; t++) {
      scriptInput(env.input, t);
      if (game.state === env.SI.STATE.UPGRADE) {
        env.input.axis = 0;
        env.input.fire = false;
        env.input.firePress = false;
        if (game.stateTimer > C.UPGRADE.MIN_DWELL + 0.1) {
          game.upgradeIndex = pickTurn % upgradeIds.length;
          pickTurn++;
          env.input.confirm = true;
        }
      }
      try {
        tick(env, game);
      } catch (e) {
        errors.push(`tick ${t}: ${(e && e.stack) || e}`);
        break;
      }
      seenWaves.add(game.wave);
      if (game.swarm) {
        if (game.swarm.formation) formationsSeen++;
        if (game.swarm.commander) commanderWaves++;
        /* Thin the swarm so the run actually reaches later waves. Commanders
         * are deliberately EXEMPT: killing one grounds the swarm for the rest
         * of its wave by design (scenario 7 proves that), so letting this
         * random thinning snipe them would make the "formations actually ran"
         * assertion below a coin flip on the seed rather than a real check. */
        if (t % 12 === 0 && game.state === env.SI.STATE.PLAYING) {
          const live = game.swarm.aliens.filter((a) => a.alive && !a.commander);
          if (live.length > 0) {
            const victim = live[Math.floor(Math.random() * live.length)];
            game.swarm.killAlien(victim, game.world);
            game.addScore(victim.score);
          }
        }
      }
      if (game.ufo) ufoSpawns++;
      maxParticles = Math.max(maxParticles, game.particles.count);
      if (game.particles.count > game.particles.cap) poolOverflow++;
      if (game.state === env.SI.STATE.GAME_OVER && game.stateTimer > 0.5) {
        env.input.confirm = true;   // restart and keep going
      }
    }

    console.log(`    waves seen: ${[...seenWaves].join(',')} | score=${game.score} | maxParticles=${maxParticles}`);
    check('zero exceptions from update/draw/drawHud', errors.length === 0, errors[0]);
    check('run progressed through several waves', seenWaves.size >= 4,
      `waves=${[...seenWaves].join(',')}`);
    check('formations actually ran during the run', formationsSeen > 0, `ticks=${formationsSeen}`);
    check('a commander existed during the run', commanderWaves > 0, `ticks=${commanderWaves}`);
    check('particle pool never exceeded its cap', poolOverflow === 0,
      `overflows=${poolOverflow} max=${maxParticles} cap=${game.particles.cap}`);
    check('particle cap is still 1200', game.particles.cap === 1200, String(game.particles.cap));
    check('four bunkers rebuilt each wave', game.bunkers.length === 4,
      String(game.bunkers.length));

    /* UFO scoring still works. This sub-check is deliberately SELF-CONTAINED:
     * the 6000-tick run above is unscripted and thins the swarm every 12th
     * tick, so whatever it happens to leave behind may be a game-over screen
     * or a swarm down to its last couple of aliens -- and Game.update only
     * spawns a UFO while PLAYING with aliveCount() > 2. Depending on that tail
     * state made the check a coin flip on the seed rather than a test of what
     * it claims ("a UFO CAN spawn in a normal playing state"), so a fresh wave
     * is started here first. startWave() re-rolls ufoTimer, hence the zeroing
     * AFTER it, not before. */
    game.startWave(3);
    game.setState(env.SI.STATE.PLAYING);
    game.ufoTimer = 0;
    for (let t = 0; t < 60 && !game.ufo; t++) tick(env, game);
    check('a UFO can still spawn', !!game.ufo,
      `spawnTicks=${ufoSpawns} alive=${game.swarm ? game.swarm.aliveCount() : 'no-swarm'} ` +
      `state=${game.state} ufoTimer=${game.ufoTimer}`);
    if (game.ufo) {
      const before = game.score;
      const shot = new env.SI.Bullet(game.ufo.x, game.ufo.y, -C.BULLET.PLAYER_SPEED, 'player', '#fff');
      game.bullets.push(shot);
      tick(env, game);
      check('killing the UFO still scores', game.score > before,
        `${before} -> ${game.score}`);
    }

    /* Hi-score persistence still works. */
    game.gameOver();
    check('hi-score written to localStorage',
      env.storage.getItem('neon-invaders-hi') === String(game.hi),
      `stored=${env.storage.getItem('neon-invaders-hi')} hi=${game.hi}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('14. style guard -- the edited files stay ES5', () => {
  const files = ['js/core.js', 'js/entities.js', 'js/game.js', 'js/hud.js'];
  /* "const", "let" and "class" all have innocent English readings, and the
   * comments in these files are prose ("a class of bug", "let the grid own
   * descent"). Those three are therefore matched against CODE lines only,
   * using the same comment-line filter the backtick check below uses -- they
   * passed until now purely because no comment happened to use the words.
   * `=>` and `${` have no prose reading here, so they stay whole-file. */
  const patterns = [
    { name: 'arrow function (=>)', re: /=>/, codeOnly: false },
    { name: 'const', re: /\bconst\b/, codeOnly: true },
    { name: 'let', re: /\blet\b/, codeOnly: true },
    { name: 'class', re: /\bclass\b/, codeOnly: true },
    { name: 'template-literal interpolation (${)', re: /\$\{/, codeOnly: false }
  ];
  const isCommentLine = (line) => /^(\/\/|\/\*|\*)/.test(line.trim());
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const numbered = src.split('\n').map((line, i) => ({ line, n: i + 1 }));
    const codeLines = numbered.filter((e) => !isCommentLine(e.line));
    for (const p of patterns) {
      if (p.codeOnly) {
        const hit = codeLines.find((e) => p.re.test(e.line));
        check(`${rel}: no ${p.name}`, !hit,
          hit ? `line ${hit.n}: ${hit.line.trim()}` : '');
      } else {
        const m = src.match(p.re);
        check(`${rel}: no ${p.name}`, !m, m ? `found at index ${m.index}` : '');
      }
    }
    /* Backticks are used as prose quoting inside comments throughout this
     * codebase (`world`, `dead`, ...). Assert they never escape a comment,
     * which is what would make one an actual template literal. */
    const offenders = numbered
      .filter((e) => e.line.indexOf('`') >= 0)
      .filter((e) => !isCommentLine(e.line));
    check(`${rel}: every backtick is inside a comment`, offenders.length === 0,
      offenders.map((e) => 'line ' + e.n).join(', '));
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tags = (html.match(/<script src="js\/[a-z]+\.js"><\/script>/g) || [])
    .map((s) => s.replace(/.*js\/([a-z]+)\.js.*/, '$1'));
  check('index.html script list untouched',
    tags.join(',') === 'core,fx,audio,input,starfield,particles,entities,props,hud,game,main,net',
    tags.join(','));
});

/* --------------------------------------------------------------------- */
/* Scenario 10 proves the reflection MATHS with a hand-built vy === 0 bullet
 * -- a bullet Player.fire never produces. This one closes that gap: it fires
 * through the REAL Player.fire(world) path, from real firing positions, and
 * demands the shot actually reach a wall before it leaves the world. */
scenario('15. a REAL bounce volley reflects in flight from realistic positions', () => {
  withSeed(1515, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;

    /* Flies the currently-active upgrade's volley from player x = startX and
     * reports what the first player bullet did before it died. */
    function flight(startX, side) {
      const game = startedGame(env);
      game.upgrade = 'bounce';
      quietSwarm(game);
      game.swarm = null;          // isolate the flight from swarm collisions
      game.bunkers.length = 0;    // bunker chewing is scenario 13's business
      game.player.x = startX;
      game.player.bounceSide = side;
      game.player.cooldown = 0;
      env.input.fire = true;
      env.input.firePress = true;
      tick(env, game);            // Player.update -> Player.fire(world)
      env.input.fire = false;
      env.input.firePress = false;

      const shots = alivePlayerBullets(game);
      const b = shots[0];
      if (!b) return null;
      const spawn = { x: b.x, y: b.y, vx: b.vx, vy: b.vy };
      let reflections = 0;
      let prevSign = Math.sign(b.vx);
      let outOfBounds = 0;
      for (let t = 0; t < 600 && !b.dead; t++) {
        game.player.x = startX;   // hold station; only the bullet matters here
        tick(env, game);
        if (b.dead) break;
        if (b.x < b.w / 2 - 1e-9 || b.x > C.WORLD_W - b.w / 2 + 1e-9) outOfBounds++;
        if (Math.sign(b.vx) !== prevSign) {
          reflections += 1;
          prevSign = Math.sign(b.vx);
        }
      }
      return { spawn, reflections, outOfBounds, dead: b.dead, bounceLeft: b.bounce };
    }

    /* The arithmetic the tuning is derived from, restated as a check so a
     * future BOUNCE_* edit that makes the upgrade inert again fails here. */
    const spawnY = C.PLAYER.Y - C.PLAYER.H / 2 - 6;
    const life = (spawnY + 40) / C.UPGRADE.BOUNCE_VY;          // y < -40 kills it
    const reach = life * C.UPGRADE.BOUNCE_VX;
    const halfShip = C.PLAYER.W / 2;
    const xMin = halfShip + 12;                                 // Player.update clamp
    const wallGapWorst = (C.WORLD_W - C.BULLET.PLAYER_W / 2) - xMin;
    console.log(`    lifetime=${life.toFixed(3)}s reach=${reach.toFixed(1)}u ` +
      `worst wall gap=${wallGapWorst.toFixed(1)}u`);
    check('a bounce shot outlives its worst-case trip to a wall',
      reach > wallGapWorst, `reach=${reach} gap=${wallGapWorst}`);

    const mid = flight(C.WORLD_W / 2, 1);
    check('a volley was actually spawned by Player.fire', !!mid);
    check('the spawned shot really is the bounce shot',
      mid.spawn.vx === C.UPGRADE.BOUNCE_VX && mid.spawn.vy === -C.UPGRADE.BOUNCE_VY,
      JSON.stringify(mid.spawn));
    check('mid-screen: reflects at least once before dying',
      mid.reflections >= 1, `reflections=${mid.reflections}`);
    check('mid-screen: the shot did eventually die', mid.dead === true);
    check('mid-screen: never left the world horizontally', mid.outOfBounds === 0,
      `violations=${mid.outOfBounds}`);

    /* Worst case the game can produce: ship pinned at its left movement limit,
     * firing at the FAR wall. */
    const worst = flight(C.PLAYER.W / 2 + 12, 1);
    check('worst case (left limit, fired right): still reflects at least once',
      worst.reflections >= 1, `reflections=${worst.reflections}`);

    /* And BOUNCE_MAX has to be a number real play can reach, not decoration. */
    const nearWall = flight(C.PLAYER.W / 2 + 12, -1);
    check(`near-wall shot reaches BOUNCE_MAX (${C.UPGRADE.BOUNCE_MAX}) reflections`,
      nearWall.reflections === C.UPGRADE.BOUNCE_MAX,
      `reflections=${nearWall.reflections}`);
    check('and expires afterwards rather than living forever',
      nearWall.dead === true && nearWall.bounceLeft === 0,
      `dead=${nearWall.dead} left=${nearWall.bounceLeft}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('16. the upgrade pick cannot be won by a held, mashed or stray input', () => {
  withSeed(1616, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const S = env.SI.STATE;
    const U = C.UPGRADE;
    const ids = U.IDS;

    /* --- (a) the fire key HELD through WAVE_CLEAR must not lock card 0 in. */
    const held = startedGame(env);
    held.clearWave();
    // Just short of PICK_TIMEOUT, so that anything which dismisses the screen
    // in this window is the INPUT doing it, never the auto-select.
    const holdTicks = Math.floor((U.PICK_TIMEOUT - 1) / DT);
    let dismissedAt = -1;
    for (let t = 0; t < holdTicks; t++) {
      // A player leaning on fire: down every frame, and (unlike the real
      // input.js, which suppresses key auto-repeat) a confirm edge too.
      env.input.keys.Space = true;
      env.input.confirm = true;
      tick(env, held);
      if (held.state === S.PLAYING && dismissedAt < 0) { dismissedAt = t; break; }
    }
    check('a held fire key never confirms the pick', held.state === S.UPGRADE,
      `state=${held.state}, dismissed at tick ${dismissedAt}`);
    check('the held key did not even arm the screen', held.upgradeArmed === false);
    // MIN_DWELL was satisfied many times over during that hold, so the thing
    // still holding the screen open can only be the release gate.
    check('the dwell gate was long since satisfied -- the release gate is what held',
      held.state === S.UPGRADE && held.stateTimer > U.MIN_DWELL + 1,
      `t=${held.stateTimer} dwell=${U.MIN_DWELL}`);
    // Release: now the countdown may finish the job (that is PICK_TIMEOUT's
    // whole purpose -- an idle session must never hang).
    for (let t = 0; t < 300 && held.state === S.UPGRADE; t++) tick(env, held);
    check('releasing lets the PICK_TIMEOUT auto-select land', held.state === S.PLAYING,
      `state=${held.state}`);

    /* --- (b) mashing fire cannot beat MIN_DWELL (red-team measured 0.383s). */
    const mash = startedGame(env);
    check('reached the upgrade screen', driveToUpgradeScreen(env, mash), mash.state);
    let pickedAt = -1;
    let stillUpAtHalfSecond = false;
    for (let t = 0; t < 900; t++) {
      const clockBefore = mash.stateTimer;
      const downFrame = t % 4 < 2;       // press / press / release / release
      env.input.keys.Space = downFrame;
      env.input.confirm = downFrame && (t % 4 === 0);
      tick(env, mash);
      if (clockBefore >= 0.5 && mash.state === S.UPGRADE) stillUpAtHalfSecond = true;
      if (mash.state !== S.UPGRADE) { pickedAt = clockBefore; break; }
    }
    check('still on the screen after 0.5s of mashing (red-team dismissed at 0.383s)',
      stillUpAtHalfSecond, `picked at ${pickedAt}s`);
    check(`mashing could not confirm before MIN_DWELL (${U.MIN_DWELL}s)`,
      pickedAt >= U.MIN_DWELL, `picked at ${pickedAt}s`);
    check('a masher does eventually get a pick (it is not a soft lock)',
      mash.state === S.PLAYING, `state=${mash.state}`);

    /* --- (c) a tap that misses every card must not confirm; one that hits a
     *         card selects THAT card and confirms it. */
    const tap = startedGame(env);
    check('reached the upgrade screen', driveToUpgradeScreen(env, tap), tap.state);
    for (let t = 0; t < Math.ceil(U.MIN_DWELL / DT) + 2; t++) tick(env, tap);
    const p = env.SI.Input.pointer();
    // A pointerdown sets BOTH pressed.Pointer and confirmPressed() in the real
    // input.js, so drive both here.
    p.active = true;
    p.firing = true;
    p.x = C.WORLD_W / 2;
    p.y = C.WORLD_H - 30;                // below the cards: empty screen
    env.input.keys.Pointer = true;
    env.input.confirm = true;
    tick(env, tap);
    check('a tap on empty screen does NOT confirm', tap.state === S.UPGRADE,
      `state=${tap.state}`);

    const target = 2;                    // 'bounce'
    const rect = env.SI.HUD.upgradeCardRect(target, ids.length);
    p.x = rect.x + rect.w / 2;
    p.y = rect.y + rect.h / 2;
    env.input.keys.Pointer = true;
    env.input.confirm = true;
    tick(env, tap);
    check('a tap ON a card selects that card and confirms it',
      tap.state === S.PLAYING && tap.upgrade === ids[target],
      `state=${tap.state} upgrade=${tap.upgrade}`);
    p.active = false;
    p.firing = false;

    /* --- (d) a resting pointer must not overwrite the keyboard every frame. */
    const drift = startedGame(env);
    check('reached the upgrade screen', driveToUpgradeScreen(env, drift), drift.state);
    const card0 = env.SI.HUD.upgradeCardRect(0, ids.length);
    p.active = true;                     // finger resting on card 0, NOT tapping
    p.firing = true;
    p.x = card0.x + card0.w / 2;
    p.y = card0.y + card0.h / 2;
    env.input.keys.ArrowRight = true;
    tick(env, drift);
    check('arrow key moved the highlight off the card under the finger',
      drift.upgradeIndex === 1, `index=${drift.upgradeIndex}`);
    for (let t = 0; t < 30; t++) tick(env, drift);
    check('the resting finger never dragged the highlight back',
      drift.upgradeIndex === 1, `index=${drift.upgradeIndex}`);
    check('and the resting finger never confirmed on its own',
      drift.state === S.UPGRADE, `state=${drift.state}`);
    p.active = false;
    p.firing = false;
  });
});

/* --------------------------------------------------------------------- */
scenario('17. the upgrade pick window can be paused, and its clock freezes', () => {
  withSeed(1717, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const S = env.SI.STATE;
    const game = startedGame(env);
    check('reached the upgrade screen', driveToUpgradeScreen(env, game), game.state);

    for (let t = 0; t < 60; t++) tick(env, game);
    const clockAtPause = game.stateTimer;
    const waveAtPause = game.wave;
    env.input.pause = true;
    tick(env, game);
    check('P pauses the upgrade screen', game.state === S.PAUSED, `state=${game.state}`);

    // Hold the pause for longer than the whole auto-select budget.
    const long = Math.ceil((C.UPGRADE.PICK_TIMEOUT + 3) / DT);
    for (let t = 0; t < long; t++) tick(env, game);
    check('PICK_TIMEOUT does NOT fire while paused', game.state === S.PAUSED,
      `state=${game.state}`);
    check('no upgrade was force-applied while paused', game.upgrade === 'none',
      game.upgrade);
    check('and no wave was started while paused', game.wave === waveAtPause,
      `wave=${game.wave}`);

    env.input.pause = true;
    tick(env, game);
    check('P resumes back into the upgrade screen', game.state === S.UPGRADE,
      `state=${game.state}`);
    check('the pick clock resumed where it left off, not from 0 or from 15s',
      Math.abs(game.stateTimer - clockAtPause) < 0.05,
      `resumed=${game.stateTimer} paused-at=${clockAtPause}`);

    // Still fully usable afterwards.
    game.upgradeIndex = 1;
    for (let t = 0; t < Math.ceil(C.UPGRADE.MIN_DWELL / DT) + 2; t++) tick(env, game);
    env.input.confirm = true;
    tick(env, game);
    check('a normal confirm still works after the pause',
      game.state === S.PLAYING && game.upgrade === C.UPGRADE.IDS[1],
      `state=${game.state} upgrade=${game.upgrade}`);
  });
});

/* --------------------------------------------------------------------- */
/* Commander personalities. Everything below reseeds Math.random around the
 * single call it is measuring, so two swarms are always compared against the
 * SAME underlying draw -- the only difference left is the personality's
 * scaling, which is exactly what is under test. */

/* One fire tick with choreography pinned off, so the only Math.random draws
 * update() makes are the fire block's own. Returns the re-armed fireTimer,
 * i.e. the delay the personality produced. */
function fireDelayUnderSeed(env, game, sw, seed) {
  sw.formation = null;
  sw.formationTimer = Infinity;
  sw.fireTimer = 0;
  return withSeed(seed, () => {
    sw.update(DT, game.world);
    return sw.fireTimer;
  });
}

/* Does the swarm still shoot when the alien-bullet count is sitting exactly
 * on the CLASSIC cap? Only a personality with extraBullets > 0 may. */
function spawnsAtClassicCap(env, game, sw, seeds) {
  const realCount = game.world.alienBulletCount;
  const realSpawn = game.world.spawnBullet;
  let spawned = 0;
  game.world.alienBulletCount = () => sw.maxBullets;
  game.world.spawnBullet = () => { spawned += 1; };
  try {
    for (const s of seeds) fireDelayUnderSeed(env, game, sw, s);
  } finally {
    game.world.alienBulletCount = realCount;
    game.world.spawnBullet = realSpawn;
  }
  return spawned;
}

scenario('18. commander personalities are distinct and deterministic', () => {
  withSeed(1818, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const P = C.COMMANDER.PERSONALITIES;

    check('the personality table has at least 2 entries', P.length >= 2, `n=${P.length}`);

    /* (a) pairwise distinct, in identity AND in behaviour. */
    let idsOk = true;
    let behaviourOk = true;
    let detail = '';
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        const a = P[i];
        const b = P[j];
        if (a.id === b.id || a.name === b.name || a.color === b.color) {
          idsOk = false; detail += ` ${a.id}~${b.id}:identity`;
        }
        const differs = a.gapScale !== b.gapScale ||
          a.fireScale !== b.fireScale ||
          a.extraBullets !== b.extraBullets ||
          String(a.kinds) !== String(b.kinds);
        if (!differs) { behaviourOk = false; detail += ` ${a.id}~${b.id}:behaviour`; }
      }
    }
    check('every personality has a distinct id, name and colour', idsOk, detail.trim());
    check('every personality pair differs in at least one behavioural field',
      behaviourOk, detail.trim());

    /* (a2) the colour is the VISUAL tell, so !== is far too weak a test: a
     * personality one green step off C.COLORS.commander is, to a player,
     * simply "the commander". Every personality colour therefore has to clear
     * a minimum per-channel distance from the BASE commander colour (which
     * every commander's body wears regardless of personality) and from
     * C.COLORS.warn (used for the bounce upgrade in this same HUD), as well
     * as from each other. */
    const MIN_CHANNEL_GAP = 48;
    const rgb = (hex) => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    ];
    const chanGap = (x, y) => {
      const a = rgb(x);
      const b = rgb(y);
      return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
    };
    const REFS = [['commander', C.COLORS.commander], ['warn', C.COLORS.warn]];
    let tellOk = true;
    let tellDetail = '';
    for (let i = 0; i < P.length; i++) {
      REFS.forEach((ref) => {
        const d = chanGap(P[i].color, ref[1]);
        if (d < MIN_CHANNEL_GAP) {
          tellOk = false;
          tellDetail += ` ${P[i].id}(${P[i].color})~COLORS.${ref[0]}(${ref[1]}):${d}`;
        }
      });
      for (let j = i + 1; j < P.length; j++) {
        const d = chanGap(P[i].color, P[j].color);
        if (d < MIN_CHANNEL_GAP) {
          tellOk = false;
          tellDetail += ` ${P[i].id}~${P[j].id}:${d}`;
        }
      }
    }
    check(`every personality colour clears ${MIN_CHANNEL_GAP}/255 in some channel from ` +
      'COLORS.commander, COLORS.warn and each other', tellOk, tellDetail.trim());

    /* (b) below FROM_WAVE there is no commander and therefore no personality. */
    let earlyOk = true;
    for (let wave = 1; wave < C.COMMANDER.FROM_WAVE; wave++) {
      const sw = new env.SI.Swarm(wave);
      if (sw.personality !== null || sw.activePersonality() !== null) { earlyOk = false; }
    }
    check('waves below COMMANDER.FROM_WAVE have no personality at all', earlyOk);

    /* (c) the pick is wave-derived, so it is stable across seeds. */
    let mapOk = true;
    let mapDetail = '';
    for (let wave = C.COMMANDER.FROM_WAVE; wave <= C.COMMANDER.FROM_WAVE + 5; wave++) {
      const want = P[(wave - C.COMMANDER.FROM_WAVE) % P.length];
      const sw = new env.SI.Swarm(wave);
      const other = withSeed(999000 + wave, () => new env.SI.Swarm(wave));
      if (!sw.personality || sw.personality.id !== want.id) {
        mapOk = false; mapDetail += ` wave${wave}:${sw.personality && sw.personality.id}!=${want.id}`;
      }
      if (!other.personality || other.personality.id !== want.id) {
        mapOk = false; mapDetail += ` wave${wave}:seed-dependent`;
      }
      if (sw.commander && sw.commander.personality !== sw.personality) {
        mapOk = false; mapDetail += ` wave${wave}:alien-not-tagged`;
      }
    }
    check('waves 3..8 map onto (wave - FROM_WAVE) % n, identically under a fresh seed',
      mapOk, mapDetail.trim());

    /* (d) formation-KIND repertoire actually narrows per personality. The
     * default (null) path is the only one a personality touches.
     *
     * The ORDERED sequence is what is compared, not just the set of kinds
     * used: a personality whose `kinds` happens to reproduce the default
     * wedge/dive parity alternation (['wedge','dive'] does, exactly) is a
     * dead field that a set comparison cannot see. Wave 2 is the baseline --
     * formations are enabled from FORMATION.FROM_WAVE (2) but commanders only
     * from COMMANDER.FROM_WAVE (3), so wave 2 is choreography with no
     * personality at all. */
    const kindSeq = (wave, draws) => {
      const game = startedGame(env, wave);
      quietSwarm(game);
      const sw = game.swarm;
      const seq = [];
      for (let i = 0; i < draws; i++) {
        sw.snapToGrid();
        const f = sw.startFormation(null, game.world);
        if (f) seq.push(f.kind);
      }
      return seq;
    };
    const SEQ_N = 12;
    const baseSeq = kindSeq(2, SEQ_N);
    const aggSeq = kindSeq(3, SEQ_N);
    const tacSeq = kindSeq(4, SEQ_N);
    const barSeq = kindSeq(5, SEQ_N);
    const aggressive = new Set(aggSeq);
    const tactical = new Set(tacSeq);
    const barrage = new Set(barSeq);
    console.log(`    kind sequence over ${SEQ_N} default-path formations:` +
      `\n      no personality (wave 2) = ${baseSeq.join(',')}` +
      `\n      AGGRESSOR      (wave 3) = ${aggSeq.join(',')}` +
      `\n      TACTICIAN      (wave 4) = ${tacSeq.join(',')}` +
      `\n      BARRAGE        (wave 5) = ${barSeq.join(',')}`);
    check('the no-personality baseline still alternates wedge/dive on wave 2',
      baseSeq.slice(0, 6).join(',') === 'wedge,dive,wedge,dive,wedge,dive', baseSeq.join(','));
    check('the wave-3 (aggressive) commander uses dive and pincer, never a wedge',
      aggressive.has('dive') && aggressive.has('pincer') && !aggressive.has('wedge'), [...aggressive].join(','));
    check('the wave-5 (barrage) commander uses wedge and inverted_wedge, never a dive',
      barrage.has('wedge') && barrage.has('inverted_wedge') && !barrage.has('dive'), [...barrage].join(','));
    check('the wave-4 (tactician) commander uses all four tactical formation kinds',
      tactical.size === 4 && tactical.has('wedge') && tactical.has('pincer') &&
      tactical.has('inverted_wedge') && tactical.has('sweep'),
      [...tactical].join(','));
    /* The real anti-no-op gate: every personality's ORDERED sequence must
     * differ from the uncommanded one. TACTICIAN is the case this catches --
     * it is the only personality that keeps both kinds, so a set comparison
     * would pass it even when its `kinds` field does literally nothing. */
    let seqOk = true;
    let seqDetail = '';
    [['AGGRESSOR', aggSeq], ['TACTICIAN', tacSeq], ['BARRAGE', barSeq]].forEach((e) => {
      if (e[1].join(',') === baseSeq.join(',')) {
        seqOk = false;
        seqDetail += ` ${e[0]}:identical-to-default(${e[1].join(',')})`;
      }
    });
    check('every personality produces a DIFFERENT ordered kind sequence than no personality',
      seqOk, seqDetail.trim());

    /* An explicitly-passed kind must still win outright -- scenarios 3, 4
     * and 5 depend on that and must stay unaffected by any personality. */
    const forced = startedGame(env, 3);
    quietSwarm(forced);
    forced.swarm.snapToGrid();
    const wedge = forced.swarm.startFormation('wedge', forced.world);
    check('an explicit startFormation("wedge") still wins on a dive-only commander',
      !!wedge && wedge.kind === 'wedge', wedge && wedge.kind);
    forced.swarm.snapToGrid();
    const dive = forced.swarm.startFormation('dive', forced.world);
    check('an explicit startFormation("dive") is honoured verbatim too',
      !!dive && dive.kind === 'dive', dive && dive.kind);

    /* (e) formation CADENCE: same underlying draw, different gap. */
    const GAP_SEED = 4242;
    const gapOf = (wave) => {
      const sw = new env.SI.Swarm(wave);
      return withSeed(GAP_SEED, () => sw.nextFormationGap());
    };
    const base1 = gapOf(1);
    const base2 = gapOf(2);
    const gapTac = gapOf(4);
    const gapBar = gapOf(5);
    console.log(`    gap under seed ${GAP_SEED}: none=${base1.toFixed(3)}/${base2.toFixed(3)} ` +
      `tactical=${gapTac.toFixed(3)} barrage=${gapBar.toFixed(3)}`);
    check('the no-commander baseline gap is the same on waves 1 and 2',
      base1 === base2, `${base1} vs ${base2}`);
    check('the tactical commander re-arms formations STRICTLY sooner',
      gapTac < base1, `${gapTac} vs ${base1}`);
    check('the barrage commander re-arms formations STRICTLY later',
      gapBar > base1, `${gapBar} vs ${base1}`);

    /* (f) FIRE RATE: same underlying draw, different delay. Compared against
     * the very same swarm with its commander forced away, so wave tuning,
     * alive count and swarm size are all held constant. */
    const FIRE_SEED = 7373;
    const barGame = startedGame(env, 5);
    const barSw = barGame.swarm;
    const withCmd = fireDelayUnderSeed(env, barGame, barSw, FIRE_SEED);
    const keptCmd = barSw.commander;
    barSw.commander = null;
    const noCmd = fireDelayUnderSeed(env, barGame, barSw, FIRE_SEED);
    console.log(`    wave-5 fire delay under seed ${FIRE_SEED}: ` +
      `barrage=${withCmd.toFixed(4)} no-commander=${noCmd.toFixed(4)}`);
    check('a live barrage commander shortens the alien fire delay',
      withCmd < noCmd, `${withCmd} vs ${noCmd}`);
    check('the shortened delay is not just the 0.16 clamp',
      withCmd > 0.16, String(withCmd));

    /* (g) and it raises the simultaneous-bullet cap by extraBullets. */
    const CAP_SEEDS = [11, 22, 33, 44, 55, 66, 77, 88, 99, 111, 222, 333];
    barSw.commander = keptCmd;
    const capped = spawnsAtClassicCap(env, barGame, barSw, CAP_SEEDS);
    barSw.commander = null;
    const uncapped = spawnsAtClassicCap(env, barGame, barSw, CAP_SEEDS);
    barSw.commander = keptCmd;
    check('extraBullets is what is under test here',
      barSw.personality.extraBullets === 1, String(barSw.personality.extraBullets));
    check('at the CLASSIC cap the barrage swarm still gets shots away',
      capped > 0, `spawns=${capped}/${CAP_SEEDS.length}`);
    check('with no commander the classic cap is enforced exactly',
      uncapped === 0, `spawns=${uncapped}/${CAP_SEEDS.length}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('19. every personality still grounds the swarm when its commander dies', () => {
  withSeed(1919, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const P = C.COMMANDER.PERSONALITIES;
    const FIRE_SEED = 5150;
    const GAP_SEED = 4242;

    /* The unscaled formation gap, from a swarm that never had a commander.
     * Built outside the seeded region so the constructor's own draw cannot
     * shift which value nextFormationGap() consumes. */
    const plainSwarm = new env.SI.Swarm(1);
    const plainGap = withSeed(GAP_SEED, () => plainSwarm.nextFormationGap());

    for (let k = 0; k < P.length; k++) {
      const wave = C.COMMANDER.FROM_WAVE + k;
      const game = startedGame(env, wave);
      quietSwarm(game);
      const sw = game.swarm;
      const cmd = sw.commander;
      const want = P[k];
      check(`wave ${wave}: commander is the ${want.id} personality`,
        !!cmd && !!sw.personality && sw.personality.id === want.id,
        sw.personality && sw.personality.id);

      sw.formationTimer = Infinity;
      sw.startFormation('wedge', game.world);
      for (let t = 0; t < 90 && sw.formation && sw.formation.phase !== 1; t++) tick(env, game);
      check(`wave ${wave}: a formation is in flight, aliens off-grid`,
        !!sw.formation && maxOffGrid(sw) > 5, `off=${maxOffGrid(sw)}`);

      sw.killAlien(cmd, game.world);
      check(`wave ${wave}: formation cancelled instantly`, sw.formation === null);
      check(`wave ${wave}: formations disabled for the rest of the wave`,
        sw.formationsEnabled === false);
      check(`wave ${wave}: commander cache cleared`, sw.commander === null);
      check(`wave ${wave}: every alien is back on its grid anchor`,
        maxOffGrid(sw) === 0, `off=${maxOffGrid(sw)}`);
      check(`wave ${wave}: activePersonality() is null after the kill`,
        sw.activePersonality() === null, String(sw.activePersonality()));

      /* The personality effect must LAPSE, not linger. Both measurements
       * below are taken on the SAME post-death swarm -- alive count, wave
       * tuning and swarm size are therefore identical, and the ONLY thing
       * that can move the number is whether activePersonality() still
       * resolves. (Measuring the baseline before the kill would compare 55
       * live aliens against 54 and move the delay's alive/total term.) */
      const lapsed = fireDelayUnderSeed(env, game, sw, FIRE_SEED);
      sw.commander = cmd;          // force the DEAD commander back on
      const relit = fireDelayUnderSeed(env, game, sw, FIRE_SEED);
      sw.commander = null;         // and back to the real post-death state
      check(`wave ${wave}: the lapsed delay is exactly the unscaled one`,
        Math.abs(relit - lapsed * want.fireScale) < 1e-9,
        `${relit} vs ${lapsed} * ${want.fireScale}`);
      if (want.fireScale < 1) {
        check(`wave ${wave}: the dead commander no longer speeds up alien fire`,
          lapsed > relit, `${lapsed} vs ${relit}`);
      } else {
        check(`wave ${wave}: this personality never scaled fire in the first place`,
          lapsed === relit, `${lapsed} vs ${relit}`);
      }

      /* And so must the personality gap scale, dropping back to the wave's uncommanded gap. */
      const uncommandedSwarm = new env.SI.Swarm(wave);
      uncommandedSwarm.commander = null;
      const uncommandedGap = withSeed(GAP_SEED, () => uncommandedSwarm.nextFormationGap());
      const gapAfter = withSeed(GAP_SEED, () => sw.nextFormationGap());
      check(`wave ${wave}: the formation gap drops back to the unscaled personality value`,
        gapAfter === uncommandedGap, `${gapAfter} vs ${uncommandedGap}`);
    }
  });
});

/* --------------------------------------------------------------------- */
/* Kill-streak multiplier helpers. Every kill below is delivered the same
 * way scenarios 9/13 deliver theirs -- a real player Bullet pushed into
 * game.bullets and resolved by the game's own collide() during tick() --
 * so what is measured is the SHIPPING scoring path, not a direct call to
 * scoreKill(). */
function firstAlive(game) {
  if (!game.swarm) return null;
  for (const a of game.swarm.aliens) {
    if (a.alive) return a;
  }
  return null;
}

/* Freeze everything that could kill an alien (or the player) other than the
 * shot the scenario fires itself. */
function stillSwarm(game) {
  quietSwarm(game);
  if (game.swarm) game.swarm.formationTimer = Infinity;
}

/* Kills exactly one alien through collide() and reports the score delta.
 * Returns null if the tick did not resolve to exactly one death, so a
 * scenario can never mistake a miss for a x1 multiplier. */
function killOneByShot(env, game, target) {
  const C = env.SI.CONFIG;
  const before = game.score;
  const aliveBefore = game.swarm.aliveCount();
  game.bullets.push(
    new env.SI.Bullet(target.x, target.y, -C.BULLET.PLAYER_SPEED, 'player', '#fff'));
  tick(env, game);
  if (game.swarm.aliveCount() !== aliveBefore - 1) return null;
  return game.score - before;
}

scenario('20. kill-streak multiplier builds, applies, and draws zero RNG', () => {
  withSeed(2020, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const K = C.COMBO;

    /* --- wave 1 is inert: classic scoring, no streak state at all ------ */
    const w1 = startedGame(env);
    stillSwarm(w1);
    w1.player.invuln = 0;
    let rawSum = 0;
    let paidSum = 0;
    let w1Kills = 0;
    let w1Clean = true;
    for (let k = 0; k < 8; k++) {
      const target = firstAlive(w1);
      if (!target) break;
      const raw = target.score;
      const delta = killOneByShot(env, w1, target);
      if (delta === null) { w1Clean = false; break; }
      rawSum += raw;
      paidSum += delta;
      w1Kills++;
      if (w1.combo !== 0 || w1.comboMult() !== 1) { w1Clean = false; break; }
    }
    check('wave 1: eight aliens died through collide()', w1Kills === 8 && w1Clean,
      `kills=${w1Kills} clean=${w1Clean}`);
    check('wave 1: total paid equals the sum of the raw alien scores',
      paidSum === rawSum && rawSum > 0, `${paidSum} vs ${rawSum}`);
    check('wave 1: combo stays 0 and the multiplier stays x1',
      w1.combo === 0 && w1.comboMult() === 1, `combo=${w1.combo} mult=${w1.comboMult()}`);

    /* --- wave 2: the full multiplier table, kill by kill --------------- */
    const g = startedGame(env, 2);
    stillSwarm(g);
    g.player.invuln = 0;
    const total = K.STEP * K.MAX + 2;
    let tableOk = true;
    let tableDetail = '';
    let firstMulted = 0;
    let earlyOnes = 0;
    let maxSeen = 1;
    /* Observed pay-rate per kill (delta / raw), recorded for the literal
     * cross-check below -- deliberately measured from the SCORE, not read
     * back out of comboMult(). */
    const paidRates = [];
    for (let n = 1; n <= total; n++) {
      const target = firstAlive(g);
      if (!target) { tableOk = false; tableDetail = `ran out of aliens at n=${n}`; break; }
      const raw = target.score;
      const delta = killOneByShot(env, g, target);
      if (delta !== null && raw > 0) paidRates.push(delta / raw);
      /* n is the streak count AFTER this kill -- scoreKill() increments
       * first, so the kill that reaches STEP is already worth x2. */
      const wantMult = Math.min(K.MAX, 1 + Math.floor(n / K.STEP));
      if (delta === null) { tableOk = false; tableDetail = `kill ${n} did not resolve`; break; }
      if (delta !== raw * wantMult) {
        tableOk = false;
        tableDetail = `kill ${n}: paid ${delta}, wanted ${raw} * x${wantMult}`;
        break;
      }
      if (g.combo !== n) {
        tableOk = false;
        tableDetail = `kill ${n}: combo=${g.combo}`;
        break;
      }
      if (g.comboMult() !== wantMult) {
        tableOk = false;
        tableDetail = `kill ${n}: mult=${g.comboMult()} wanted ${wantMult}`;
        break;
      }
      if (wantMult === 1) earlyOnes++;
      if (wantMult > 1 && firstMulted === 0) firstMulted = n;
      maxSeen = Math.max(maxSeen, wantMult);
    }
    check(`wave 2: every one of ${total} kills paid raw * min(MAX, 1 + floor(n/STEP))`,
      tableOk, tableDetail);
    check('wave 2: the first STEP-1 kills are still worth exactly x1',
      earlyOnes === K.STEP - 1, `x1 kills=${earlyOnes} (STEP=${K.STEP})`);
    check('wave 2: the multiplier first rises on the STEP-th kill',
      firstMulted === K.STEP, `first multiplied kill=${firstMulted}`);
    check('wave 2: the multiplier saturates at MAX and never exceeds it',
      maxSeen === K.MAX && g.comboMult() === K.MAX,
      `maxSeen=${maxSeen} final=${g.comboMult()} MAX=${K.MAX}`);
    check('wave 2: the streak survived the whole back-to-back run',
      g.combo === total, `combo=${g.combo} vs ${total}`);

    /* --- the SAME table again, against a hand-written literal ----------
     * Everything above computes its expectation with the implementation's
     * own formula, so an off-by-one in scoreKill()/comboMult() would move
     * both sides together and still pass. This sequence was written out by
     * hand from the SHIPPED constants (STEP 4, MAX 4) -- kills 1-3 pay x1,
     * 4-7 x2, 8-11 x3, and 12 onward saturate at x4 -- so it can only agree
     * with a correct implementation. It is guarded on the constants rather
     * than derived from them: retune COMBO and this check fails loudly
     * saying so, instead of silently comparing against a stale literal. */
    if (K.STEP === 4 && K.MAX === 4) {
      const WANT = [1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4];
      check('wave 2: 18 kills were measured for the literal cross-check',
        paidRates.length === WANT.length, `measured ${paidRates.length} of ${WANT.length}`);
      check('wave 2: the paid rate matches a hand-written [1,1,1,2,2,2,2,3,3,3,3,4x7] literal',
        paidRates.length === WANT.length && WANT.every((w, i) => paidRates[i] === w),
        `paid=[${paidRates.join(',')}] want=[${WANT.join(',')}]`);
    } else {
      check('wave 2: COMBO retuned -- the hand-written literal must be rewritten',
        false, `STEP=${K.STEP} MAX=${K.MAX}; the literal below is written for STEP=4 MAX=4`);
    }

    /* --- the scoring path draws no randomness whatsoever ---------------- */
    const seeded = Math.random;
    let draws = 0;
    Math.random = function () { draws++; return seeded(); };
    try {
      const probe = startedGame(env, 2);
      draws = 0;                       // ignore the setup's own draws
      for (let i = 0; i < 50; i++) probe.scoreKill(10);
      probe.resetCombo();
      probe.comboMult();
      check('scoreKill/resetCombo/comboMult consume exactly zero Math.random draws',
        draws === 0, `draws=${draws}`);
    } finally {
      Math.random = seeded;
    }
  });
});

/* --------------------------------------------------------------------- */
scenario('21. reset rules are deterministic and complete', () => {
  const C0 = loadGame(JS_DIR).SI.CONFIG;
  const K0 = C0.COMBO;

  /* Builds a wave-2 game whose streak already stands at exactly x2. */
  function atX2(env) {
    const game = startedGame(env, 2);
    stillSwarm(game);
    game.player.invuln = 0;
    for (let n = 0; n < K0.STEP; n++) {
      const target = firstAlive(game);
      killOneByShot(env, game, target);
    }
    return game;
  }

  /* (a) taking a hit drops the streak outright. */
  withSeed(2101, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const game = atX2(env);
    check('(a) built up to x2 before the hit', game.comboMult() === 2,
      `mult=${game.comboMult()} combo=${game.combo}`);
    const lives = game.lives;
    game.player.invuln = 0;
    game.bullets.push(new env.SI.Bullet(game.player.x, game.player.y,
      C.BULLET.ALIEN_SPEED, 'alien', '#f0f'));
    tick(env, game);
    check('(a) the player actually took the hit', game.lives === lives - 1,
      `${lives} -> ${game.lives}`);
    check('(a) taking a hit resets the streak', game.combo === 0 && game.comboMult() === 1,
      `combo=${game.combo} mult=${game.comboMult()}`);
  });

  /* (b) the lapse window, tested from both sides of the boundary. */
  withSeed(2102, () => {
    const env = loadGame(JS_DIR);
    const game = atX2(env);
    check('(b) built up to x2 before the wait', game.comboMult() === 2,
      `mult=${game.comboMult()}`);
    /* The kill tick set comboTimer to exactly WINDOW, so WINDOW/DT - 2 more
     * ticks must leave it alive with ~2 frames to spare. */
    const shortOf = Math.floor(K0.WINDOW / DT) - 2;
    for (let t = 0; t < shortOf; t++) tick(env, game);
    check('(b) still x2 two frames short of WINDOW',
      game.comboMult() === 2 && game.combo === K0.STEP && game.comboTimer > 0,
      `mult=${game.comboMult()} timer=${game.comboTimer}`);
    for (let t = 0; t < 5; t++) tick(env, game);
    check('(b) lapsed to x1 once WINDOW elapsed with no kill',
      game.combo === 0 && game.comboMult() === 1 && game.comboTimer === 0,
      `combo=${game.combo} timer=${game.comboTimer}`);
  });

  /* (c) wave boundaries. */
  withSeed(2103, () => {
    const env = loadGame(JS_DIR);
    let game = atX2(env);
    check('(c) built up to x2 before clearWave()', game.comboMult() === 2);
    game.clearWave();
    check('(c) clearWave() resets the streak',
      game.combo === 0 && game.comboTimer === 0 && game.comboMult() === 1,
      `combo=${game.combo}`);
    game = atX2(env);
    check('(c) built up to x2 again before startWave()', game.comboMult() === 2);
    game.startWave(3);
    check('(c) startWave() resets the streak',
      game.combo === 0 && game.comboTimer === 0 && game.comboMult() === 1,
      `combo=${game.combo}`);
  });

  /* (d) the reflected-shot bonus is flat, unmultiplied, and streak-neutral. */
  withSeed(2104, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const game = atX2(env);
    check('(d) built up to x2 before the reflection', game.comboMult() === 2,
      `mult=${game.comboMult()}`);
    const comboBefore = game.combo;
    const timerBefore = game.comboTimer;
    const scoreBefore = game.score;
    /* Empty airspace: below the swarm, well above the bunkers. */
    const y = 450;
    const x = C.WORLD_W / 2;
    game.bullets.push(new env.SI.Bullet(x, y, -C.BULLET.PLAYER_SPEED, 'player', '#fff'));
    game.bullets.push(new env.SI.Bullet(x, y, C.BULLET.ALIEN_SPEED, 'alien', '#f0f'));
    const aliveBefore = game.swarm.aliveCount();
    tick(env, game);
    check('(d) no alien died in that tick', game.swarm.aliveCount() === aliveBefore,
      `${aliveBefore} -> ${game.swarm.aliveCount()}`);
    check('(d) the reflected shot paid exactly 5, unmultiplied',
      game.score - scoreBefore === 5, `delta=${game.score - scoreBefore}`);
    check('(d) the streak counter is untouched by the reflection',
      game.combo === comboBefore && game.comboMult() === 2,
      `combo=${game.combo} vs ${comboBefore}`);
    check('(d) the reflection did not re-arm the streak window either',
      game.comboTimer < timerBefore, `timer=${game.comboTimer} vs ${timerBefore}`);
  });

  /* (AC-2) the whole thing is deterministic: same seed, same log, same
   * number of RNG draws. */
  function runLog(seed) {
    return withSeed(seed, () => {
      const seeded = Math.random;
      let draws = 0;
      Math.random = function () { draws++; return seeded(); };
      try {
        const env = loadGame(JS_DIR);
        const C = env.SI.CONFIG;
        const game = startedGame(env, 2);
        const lines = [];
        for (let t = 0; t < 400; t++) {
          scriptInput(env.input, t);
          if (t % 15 === 0) {
            const target = firstAlive(game);
            if (target) {
              game.bullets.push(new env.SI.Bullet(target.x, target.y,
                -C.BULLET.PLAYER_SPEED, 'player', '#fff'));
            }
          }
          tick(env, game);
          lines.push(`${game.score}|${game.combo}|${game.comboMult()}`);
        }
        return { log: lines.join('\n'), draws };
      } finally {
        Math.random = seeded;
      }
    });
  }
  const runA = runLog(2105);
  const runB = runLog(2105);
  check('(AC-2) two identically seeded 400-tick runs log identical score|combo|mult',
    runA.log === runB.log, 'per-tick logs diverged');
  check('(AC-2) both runs consumed the same number of Math.random draws',
    runA.draws === runB.draws, `${runA.draws} vs ${runB.draws}`);
  check('(AC-2) the scripted run really did build a streak above x1',
    /\|[2-9]$/m.test(runA.log), 'no multiplied tick in the log');
});

/* --------------------------------------------------------------------- */
scenario('22. wave-1 inertness and HUD placement', () => {
  /* (a) The golden run, replayed tick by tick with the streak state read
   * directly -- a machine-check of "wave 1 is untouched" that does not go
   * through the digest at all. */
  withSeed(GOLDEN_SEED, () => {
    const env = loadGame(JS_DIR);
    const game = new env.SI.Game();
    const input = env.input;
    input.confirm = true;
    tick(env, game, DT);                 // MENU -> startGame()
    let badTick = -1;
    let leftWave1 = -1;
    for (let t = 0; t < GOLDEN_TICKS; t++) {
      scriptInput(input, t);
      tick(env, game, DT);
      if (game.wave !== 1 && leftWave1 < 0) leftWave1 = t;
      if (game.combo !== 0 || game.comboMult() !== 1) { badTick = t; break; }
    }
    check('(a) the golden run never leaves wave 1', leftWave1 === -1, `tick=${leftWave1}`);
    check(`(a) combo === 0 and comboMult() === 1 on all ${GOLDEN_TICKS} golden ticks`,
      badTick === -1, `first bad tick=${badTick}`);
    check('(a) the replay still scored what the golden run scores',
      game.score === GOLDEN_SCORE, `${game.score} vs ${GOLDEN_SCORE}`);
  });

  /* (b) HUD: nothing is drawn on wave 1, exactly one label on wave 2, and
   * it does not land on top of the SCORE or HI-SCORE blocks. */
  withSeed(2202, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const calls = [];
    env.SI.FX.glowText = function (ctx, text, x, y, opts) {
      calls.push({ text: String(text), x, y, opts: opts || {} });
    };
    const combos = () => calls.filter((c) => c.text.indexOf('COMBO') === 0);

    const w1 = startedGame(env);
    w1.combo = C.COMBO.STEP * 2;         // would be x3 IF the gate let it
    w1.comboTimer = C.COMBO.WINDOW;
    env.SI.HUD.draw(env.ctx, w1);
    check('(b) wave 1 draws no COMBO label at all', combos().length === 0,
      `drew ${combos().length}`);
    check('(b) the wave-1 HUD frame did draw (the stub is wired up)',
      calls.length > 0, `calls=${calls.length}`);

    calls.length = 0;
    const g = startedGame(env, 2);       // already on wave 2
    g.combo = C.COMBO.STEP * 2;          // x3
    g.comboTimer = C.COMBO.WINDOW;
    g.setState(env.SI.STATE.PLAYING);
    check('(b) the forced state really is x3', g.comboMult() === 3, `mult=${g.comboMult()}`);
    env.SI.HUD.draw(env.ctx, g);
    const drawn = combos();
    check('(b) wave 2 at x3 draws exactly one COMBO label', drawn.length === 1,
      `drew ${drawn.length}`);
    if (drawn.length === 1) {
      check('(b) it reads the live multiplier', drawn[0].text === 'COMBO  x3', drawn[0].text);
      check('(b) it sits at x 176 on the SCORE baseline y 66',
        drawn[0].x === 176 && drawn[0].y === 66, `x=${drawn[0].x} y=${drawn[0].y}`);

      /* Non-collision: rough width estimate (0.62em per glyph) is plenty to
       * show the label is not stacked on the score digits or the centred
       * hi-score block. */
      const sizeOf = (c) => {
        const m = /(\d+(?:\.\d+)?)px/.exec(c.opts.font || '');
        return m ? Number(m[1]) : 14;
      };
      const spanOf = (c) => {
        const w = c.text.length * sizeOf(c) * 0.62;
        if ((c.opts.align || 'left') === 'center') return [c.x - w / 2, c.x + w / 2];
        if (c.opts.align === 'right') return [c.x - w, c.x];
        return [c.x, c.x + w];
      };
      const mine = spanOf(drawn[0]);
      let clash = '';
      for (const c of calls) {
        if (c === drawn[0] || c.y !== 66) continue;
        const s = spanOf(c);
        if (mine[0] < s[1] && s[0] < mine[1]) {
          clash = `${c.text} [${s[0].toFixed(0)},${s[1].toFixed(0)}]`;
        }
      }
      check('(b) no other y=66 HUD text overlaps its x-range', clash === '',
        `overlaps ${clash} (COMBO span [${mine[0].toFixed(0)},${mine[1].toFixed(0)}])`);
      /* And the same claim against the WORST case rather than this frame's
       * digits: a 7-char score ends near x 156, the centred hi-score block
       * starts near x 415. */
      check('(b) it clears a maxed-out 7-digit score and the hi-score block',
        mine[0] >= 7 * 30 * 0.62 + 26 && mine[1] <= C.WORLD_W / 2 - 7 * 30 * 0.62 / 2,
        `span=[${mine[0].toFixed(0)},${mine[1].toFixed(0)}]`);
    }
  });
});

/* --------------------------------------------------------------------- */
scenario('23. the streak cannot survive into GAME_OVER, even mid-collision-pass', () => {
  /* THE REPRO, exactly as the red team framed it. collide() walks
   * game.bullets in index order. If the fatal ALIEN shot sits at a lower
   * index than player shots that are still in flight, then within one single
   * frame:
   *     bullets[0]  alien shot -> loseLife() -> lives 0 -> gameOver()
   *     bullets[1..] player shots -> still hit aliens -> still scoreKill()
   * Those later kills used to re-increment `combo` and re-arm `comboTimer`
   * AFTER the state had already left PLAYING. updatePlaying() is the only
   * place comboTimer ever decays, so the streak froze at a non-zero value for
   * good -- and HUD.draw() renders the score bar in every state except MENU,
   * so a stale "COMBO x2" was painted over the death screen permanently.
   *
   * The kills themselves must STILL score (flushHi() exists precisely because
   * points land after gameOver()), so this pins both halves: the points are
   * awarded, unmultiplied, and no streak is left standing. */
  withSeed(2300, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const STATE = env.SI.STATE;

    const game = startedGame(env, 2);
    stillSwarm(game);
    game.player.invuln = 0;

    /* Build a real x2 streak the shipping way, through collide(). */
    for (let n = 0; n < C.COMBO.STEP; n++) {
      const t = firstAlive(game);
      game.player.invuln = 0;
      killOneByShot(env, game, t);
    }
    check('(a) a genuine x2 streak stands before the fatal frame',
      game.combo === C.COMBO.STEP && game.comboMult() === 2,
      `combo=${game.combo} mult=${game.comboMult()}`);

    /* One life left, and the streak window freshly armed. */
    game.lives = 1;
    game.world.livesLeft = 1;
    game.player.invuln = 0;
    game.bullets.length = 0;

    /* Pick three distinct live aliens for the shots still in flight. */
    const targets = [];
    for (const a of game.swarm.aliens) {
      if (a.alive) targets.push(a);
      if (targets.length === 3) break;
    }
    const rawSum = targets.reduce((s, a) => s + a.score, 0);
    check('(a) three distinct live aliens were available to target',
      targets.length === 3 && rawSum > 0, `n=${targets.length} rawSum=${rawSum}`);

    /* ORDER IS THE WHOLE POINT: the fatal alien shot goes in FIRST, so
     * collide() resolves it -- and calls gameOver() -- before it ever reaches
     * the player shots behind it. */
    game.bullets.push(new env.SI.Bullet(game.player.x, game.player.y,
      C.BULLET.ALIEN_SPEED, 'alien', '#f0f'));
    for (const t of targets) {
      game.bullets.push(new env.SI.Bullet(t.x, t.y, -C.BULLET.PLAYER_SPEED, 'player', '#fff'));
    }
    check('(a) the fatal alien shot really is at a LOWER index than the player shots',
      game.bullets[0].from === 'alien' &&
      game.bullets.slice(1).every((b) => b.from === 'player'),
      game.bullets.map((b) => b.from).join(','));

    const scoreBefore = game.score;
    const aliveBefore = game.swarm.aliveCount();
    tick(env, game);                       // the one fatal frame

    /* The repro must actually have reproduced -- otherwise the assertions
     * below would pass vacuously against a frame where nothing happened. */
    check('(b) the run ended in that frame', game.state === STATE.GAME_OVER && game.lives === 0,
      `state=${game.state} lives=${game.lives}`);
    check('(b) and the in-flight player shots DID still kill aliens in that same pass',
      game.swarm.aliveCount() === aliveBefore - targets.length,
      `${aliveBefore} -> ${game.swarm.aliveCount()} (wanted -${targets.length})`);
    check('(b) those post-death kills still scored, at a flat x1',
      game.score - scoreBefore === rawSum,
      `delta=${game.score - scoreBefore} raw=${rawSum} (x2 would be ${rawSum * 2})`);

    /* THE FIX. */
    check('(c) combo is 0 and comboMult() is 1 once the state is GAME_OVER',
      game.combo === 0 && game.comboMult() === 1,
      `combo=${game.combo} mult=${game.comboMult()} timer=${game.comboTimer}`);
    check('(c) the streak window is not left armed either', game.comboTimer === 0,
      `timer=${game.comboTimer}`);

    /* And the user-visible half: no COMBO text on the death screen. */
    const calls = [];
    env.SI.FX.glowText = function (ctx, text) { calls.push(String(text)); };
    env.SI.HUD.draw(env.ctx, game);
    check('(d) the GAME_OVER HUD frame drew something (the stub is wired up)',
      calls.length > 0, `calls=${calls.length}`);
    check('(d) and NONE of it is a COMBO readout',
      calls.filter((t) => t.indexOf('COMBO') === 0).length === 0,
      calls.filter((t) => t.indexOf('COMBO') === 0).join(' | '));

    /* Idle frames on the death screen cannot resurrect it either: the
     * GAME_OVER branch of update() never touches comboTimer, so this is
     * checking that nothing else does. */
    let stayed = true;
    for (let t = 0; t < 30; t++) {
      tick(env, game);
      if (game.combo !== 0 || game.comboMult() !== 1) { stayed = false; break; }
    }
    check('(e) it stays cleared across 30 further GAME_OVER frames', stayed,
      `combo=${game.combo} mult=${game.comboMult()}`);
  });
});

/* --------------------------------------------------------------------- */
/* Distinct alien classes (SHIELD + KAMIKAZE) -- scenarios 24-27.
 *
 * Shared helpers. `countedRun` is the same save/restore discipline withSeed
 * uses, plus a draw counter: several checks below are ABOUT how many
 * Math.random() calls a piece of code spends, which withSeed alone cannot
 * answer. */
function countedRun(seed, fn) {
  const real = Math.random;
  const rng = mulberry32(seed);
  const counter = { draws: 0 };
  Math.random = function () { counter.draws += 1; return rng(); };
  try {
    return fn(counter);
  } finally {
    Math.random = real;
  }
}

/* Class-tagged aliens of a swarm, by role. */
function roleAliens(swarm) {
  return swarm.aliens.filter((a) => a.role);
}

/* A live alien inside SHIELD.RADIUS grid cells of the shield (but not the
 * shield itself), i.e. one the shield is actually covering. */
function coveredNeighbour(C, swarm) {
  const s = swarm.shield;
  if (!s) return null;
  const R = C.ALIEN_CLASS.SHIELD.RADIUS;
  for (const a of swarm.aliens) {
    if (!a.alive || a === s) continue;
    if (Math.abs(a.col - s.col) <= R && Math.abs(a.row - s.row) <= R) return a;
  }
  return null;
}

/* Fires one real player Bullet through the game's own collide(), exactly the
 * way scenarios 9/13/20 deliver a kill, and reports what the frame did. */
function shotAt(env, game, target, pierce) {
  const C = env.SI.CONFIG;
  const scoreBefore = game.score;
  const comboBefore = game.combo;
  const aliveBefore = game.swarm.aliveCount();
  const b = new env.SI.Bullet(
    target.x, target.y, -C.BULLET.PLAYER_SPEED, 'player', '#fff');
  if (pierce) b.pierce = pierce;
  game.bullets.push(b);
  tick(env, game);
  return {
    bullet: b,
    score: game.score - scoreBefore,
    combo: game.combo - comboBefore,
    killed: aliveBefore - game.swarm.aliveCount()
  };
}

/* --------------------------------------------------------------------- */
scenario('24. alien classes are wave-derived, mutually exclusive with the commander, ' +
         'and cost zero RNG', () => {
  withSeed(2401, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const K = C.ALIEN_CLASS;

    /* (a) the gates, and exactly one of each above them ------------------ */
    let gateOk = true;
    let gateDetail = '';
    let commanderWaves = 0;
    let exclusionOk = true;
    for (let w = 1; w <= 14; w++) {
      const sw = new env.SI.Swarm(w);
      const shields = sw.aliens.filter((a) => a.role === 'shield');
      const kams = sw.aliens.filter((a) => a.role === 'kamikaze');
      const wantShield = w >= K.SHIELD.FROM_WAVE ? 1 : 0;
      const wantKam = w >= K.KAMIKAZE.FROM_WAVE ? 1 : 0;
      if (shields.length !== wantShield || kams.length !== wantKam ||
          roleAliens(sw).length !== wantShield + wantKam ||
          (!!sw.shield) !== !!wantShield || (!!sw.kamikaze) !== !!wantKam) {
        gateOk = false;
        gateDetail += ` w${w}:shield=${shields.length}/${wantShield},kam=${kams.length}/${wantKam}`;
      }
      /* (b) AC-4: a commander NEVER also carries a class, and no class-tagged
       * alien is ever the commander. Checked on every wave that has one. */
      if (sw.commander) {
        commanderWaves++;
        if (sw.commander.role !== null) {
          exclusionOk = false;
          gateDetail += ` w${w}:commander.role=${sw.commander.role}`;
        }
        for (const a of roleAliens(sw)) {
          if (a.commander !== false) {
            exclusionOk = false;
            gateDetail += ` w${w}:${a.role} is also commander`;
          }
        }
      }
    }
    check('a shield exists iff wave >= SHIELD.FROM_WAVE and a kamikaze iff ' +
      'wave >= KAMIKAZE.FROM_WAVE, exactly one of each (waves 1-14)',
      gateOk, gateDetail.trim());
    check('every wave from COMMANDER.FROM_WAVE up actually had a commander to test',
      commanderWaves === 12, `waves=${commanderWaves}`);
    check('AC-4: the commander never carries a class, and no class alien is ever ' +
      'the commander (structural: assignRole refuses a commander cell)',
      exclusionOk, gateDetail.trim());

    /* (c) the pick is WAVE-DERIVED, so it is identical across seeds -------- */
    const SEEDS = [11, 222222, 987654321];
    let seedOk = true;
    let seedDetail = '';
    for (let w = K.KAMIKAZE.FROM_WAVE; w <= K.KAMIKAZE.FROM_WAVE + 5; w++) {
      const cells = SEEDS.map((s) => withSeed(s, () => {
        const sw = new env.SI.Swarm(w);
        return [
          sw.shield ? `${sw.shield.row},${sw.shield.col}` : 'none',
          sw.kamikaze ? `${sw.kamikaze.row},${sw.kamikaze.col}` : 'none'
        ].join('/');
      }));
      if (cells[0] !== cells[1] || cells[1] !== cells[2]) {
        seedOk = false;
        seedDetail += ` w${w}:${cells.join(' vs ')}`;
      }
    }
    check('the same wave tags the SAME (row, col) alien for each class under three ' +
      'different seeds (wave-derived, not drawn)', seedOk, seedDetail.trim());

    /* (d) the classes never touch the grid anchor layout ------------------ */
    const sw5 = new env.SI.Swarm(5);
    check('SHIELD sits on ALIEN_CLASS.SHIELD.ROW and KAMIKAZE on the bottom row',
      sw5.shield.row === K.SHIELD.ROW && sw5.kamikaze.row === C.SWARM.ROWS - 1,
      `shield.row=${sw5.shield.row} kamikaze.row=${sw5.kamikaze.row}`);
    check('SHIELD.ROW is deep enough that its RADIUS can never reach row 0, ' +
      'where every commander lives',
      K.SHIELD.ROW - K.SHIELD.RADIUS > 0, `row=${K.SHIELD.ROW} radius=${K.SHIELD.RADIUS}`);
    check('a fresh kamikaze is armed but not yet committed (dive === null)',
      sw5.kamikaze.dive === null && sw5.kamikaze.diveTimer === K.KAMIKAZE.FIRST_DELAY,
      `dive=${sw5.kamikaze.dive} timer=${sw5.kamikaze.diveTimer}`);
    check('neither class carries a score bonus (AC-7: server/ needs no re-derivation)',
      sw5.shield.score === C.SCORE.ROW[sw5.shield.row] &&
      sw5.kamikaze.score === C.SCORE.ROW[sw5.kamikaze.row],
      `shield=${sw5.shield.score} kamikaze=${sw5.kamikaze.score}`);
  });

  /* (e) AC-3: ZERO added Math.random() draws, at every wave --------------- */
  const drawsFor = (jsDir, wave) => countedRun(31337, (counter) => {
    const env = loadGame(jsDir);
    counter.draws = 0;                       // loadGame itself draws nothing, but be exact
    /* eslint-disable-next-line no-new */
    new env.SI.Swarm(wave);
    return counter.draws;
  });

  const WAVES = [1, 2, 3, 4, 5, 6, 10];
  const nowDraws = WAVES.map((w) => drawsFor(JS_DIR, w));
  console.log(`    Swarm() Math.random draws by wave: ` +
    WAVES.map((w, i) => `w${w}=${nowDraws[i]}`).join(' '));

  /* The plan's own formulation: from wave 3 up, a wave draws exactly what an
   * UNCLASSED commanded wave draws. Waves 4/5/6/10 all carry classes, wave 3
   * carries none, and the counts have to agree. */
  const w3 = nowDraws[WAVES.indexOf(3)];
  let sameAs3 = true;
  let sameDetail = '';
  for (const w of [4, 5, 6, 10]) {
    const d = nowDraws[WAVES.indexOf(w)];
    if (d !== w3) { sameAs3 = false; sameDetail += ` w${w}=${d} vs w3=${w3}`; }
  }
  check('AC-3: waves 4/5/6/10 (classed) spend exactly as many draws as wave 3 ' +
    '(commanded, unclassed) -- the classes add none', sameAs3, sameDetail.trim());

  /* Stronger still: compare EVERY wave against the pre-class game at git HEAD.
   * That pins the whole stream shape, not just a same-as-wave-3 relation.
   * (Skipped, with a visible note, if HEAD:js/ could not be extracted.) */
  if (baselineDir) {
    const headDraws = WAVES.map((w) => drawsFor(baselineDir, w));
    check('AC-3: the per-wave draw count is byte-identical to the pre-class game ' +
      'at git HEAD, for waves 1/2/3/4/5/6/10',
      headDraws.join(',') === nowDraws.join(','),
      `HEAD=${headDraws.join(',')} now=${nowDraws.join(',')}`);
  } else {
    console.log('    (HEAD:js/ unavailable -- skipping the HEAD draw-count cross-check)');
  }

  /* DURABLE PIN. The HEAD cross-check above is genuinely useful right now,
   * but it decays into a tautology the moment this round is committed: `git
   * show HEAD:js/*` will then BE the worktree and the comparison passes no
   * matter what. Scenario 1 solves exactly this problem with a literal
   * GOLDEN_DIGEST constant, and scenario 20 does it for the combo table with
   * a hand-written [1,1,1,2,2,2,2,3,3,3,3,4...] sequence. Same discipline
   * here, for the per-wave draw count.
   *
   * The numbers are NOT copied from the current output -- they are derived
   * by hand from the three draw sites in the Swarm constructor, in the order
   * they execute:
   *   1. `SI.rand(0.4, cfg.fire)` for fireTimer          -- EVERY wave
   *   2. `SI.rand(0, MAX_GAP - MIN_GAP)` first jitter    -- wave >= 2
   *   3. `SI.randInt(0, COLS - 1)` for the commander     -- wave >= 3
   * so wave 1 spends 1, wave 2 spends 2, and every wave from 3 up spends 3.
   * Neither ALIEN_CLASS gate adds a fourth: waves 4 and 5, where the shield
   * and the kamikaze switch on, must still read exactly 3.
   *
   * Guarded on the four gates the derivation depends on, the way scenario 20
   * guards its literal on COMBO.STEP/MAX: retune any of them and this fails
   * loudly saying the literal must be rewritten, instead of silently
   * comparing against a stale constant. */
  withSeed(2403, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const K = C.ALIEN_CLASS;
    if (C.FORMATION.FROM_WAVE === 2 && C.COMMANDER.FROM_WAVE === 3 &&
        K.SHIELD.FROM_WAVE === 4 && K.KAMIKAZE.FROM_WAVE === 5) {
      const PIN_WAVES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
      const WANT_DRAWS = [1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
      const got = PIN_WAVES.map((w) => drawsFor(JS_DIR, w));
      check('AC-3 (durable pin): `new SI.Swarm(wave)` spends a hand-derived ' +
        '[1,2,3,3x9] Math.random draws for waves 1-12 -- 1 for fireTimer, ' +
        '+1 from FORMATION.FROM_WAVE, +1 from COMMANDER.FROM_WAVE, and NOTHING ' +
        'from either class gate (survives this round being committed, unlike ' +
        'the HEAD comparison above)',
        got.join(',') === WANT_DRAWS.join(','),
        `got=[${got.join(',')}] want=[${WANT_DRAWS.join(',')}]`);
      check('AC-3 (durable pin): the class gates at waves 4 and 5 are inside the ' +
        'pinned range, so the pin actually covers them',
        PIN_WAVES.indexOf(K.SHIELD.FROM_WAVE) >= 0 &&
        PIN_WAVES.indexOf(K.KAMIKAZE.FROM_WAVE) >= 0,
        `shield=${K.SHIELD.FROM_WAVE} kamikaze=${K.KAMIKAZE.FROM_WAVE}`);
    } else {
      check('AC-3 (durable pin): a FROM_WAVE gate was retuned -- the hand-derived ' +
        'draw-count literal must be rewritten', false,
        `formation=${C.FORMATION.FROM_WAVE} commander=${C.COMMANDER.FROM_WAVE} ` +
        `shield=${K.SHIELD.FROM_WAVE} kamikaze=${K.KAMIKAZE.FROM_WAVE}; ` +
        `the literal is written for 2/3/4/5`);
    }
  });

  /* (f) the palette: each class tell must be unmistakable ----------------- */
  withSeed(2402, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const MIN_CHANNEL_GAP = 48;
    const rgb = (hex) => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16)
    ];
    const chanGap = (x, y) => {
      const a = rgb(x);
      const b = rgb(y);
      return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
    };
    const REFS = [
      ['commander', C.COLORS.commander],
      ['player', C.COLORS.player],
      ['playerGlow', C.COLORS.playerGlow]
    ];
    C.COLORS.alienRows.forEach((c, i) => REFS.push([`alienRows[${i}]`, c]));
    C.COMMANDER.PERSONALITIES.forEach((p) => REFS.push([`personality:${p.id}`, p.color]));
    const TELLS = [
      ['shieldAlien', C.COLORS.shieldAlien],
      ['kamikaze', C.COLORS.kamikaze]
    ];
    let paletteOk = true;
    let paletteDetail = '';
    for (const tell of TELLS) {
      for (const ref of REFS) {
        const d = chanGap(tell[1], ref[1]);
        if (d < MIN_CHANNEL_GAP) {
          paletteOk = false;
          paletteDetail += ` ${tell[0]}(${tell[1]})~${ref[0]}(${ref[1]}):${d}`;
        }
      }
    }
    const pairGap = chanGap(TELLS[0][1], TELLS[1][1]);
    if (pairGap < MIN_CHANNEL_GAP) {
      paletteOk = false;
      paletteDetail += ` shieldAlien~kamikaze:${pairGap}`;
    }
    check(`both class colours clear ${MIN_CHANNEL_GAP}/255 in some channel from ` +
      `COLORS.commander, every alienRows entry, every personality colour, the ship ` +
      `and each other (${REFS.length} references)`, paletteOk, paletteDetail.trim());

    /* (g) drawing smoke test: no class tell may throw ---------------------- */
    const game = startedGame(env, 5);
    stillSwarm(game);
    const sw = game.swarm;
    const drawErrors = [];
    const trydraw = (label, alien) => {
      try {
        alien.draw(env.ctx, 0, 0);
        alien.draw(env.ctx, 1, 1.2);
      } catch (e) { drawErrors.push(`${label}: ${(e && e.message) || e}`); }
    };
    trydraw('shield', sw.shield);
    sw.shield.hitFlash = C.ALIEN_CLASS.SHIELD.FLASH;
    trydraw('shield mid-flash', sw.shield);
    trydraw('kamikaze (armed)', sw.kamikaze);
    sw.kamikaze.dive = { x: sw.kamikaze.x, y: sw.kamikaze.y };
    trydraw('kamikaze (diving)', sw.kamikaze);
    if (sw.commander) trydraw('commander', sw.commander);
    trydraw('plain alien', sw.aliens[sw.aliens.length - 1]);
    check('drawing a shield, a flashing shield, an armed kamikaze, a DIVING ' +
      'kamikaze, a commander and a plain alien all throw nothing',
      drawErrors.length === 0, drawErrors.join(' | '));
  });
});

/* --------------------------------------------------------------------- */
scenario('25. SHIELD redirects a lethal hit to itself -- exactly once, credited ' +
         'to the shield', () => {
  withSeed(2501, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const SHIELD_WAVE = C.ALIEN_CLASS.SHIELD.FROM_WAVE;

    /* Wave 4 is deliberate: the shield's own gate, one wave BELOW the
     * kamikaze's, so nothing is diving while the redirect is measured. */
    const fresh = () => {
      const g = startedGame(env, SHIELD_WAVE);
      stillSwarm(g);
      g.player.invuln = 0;
      return g;
    };

    /* (a) a covered neighbour's lethal hit lands on the shield instead ---- */
    const g1 = fresh();
    const sw1 = g1.swarm;
    const shield = sw1.shield;
    const neighbour = coveredNeighbour(C, sw1);
    check('wave 4 really has a shield with a live covered neighbour',
      !!shield && !!neighbour, `shield=${!!shield} neighbour=${!!neighbour}`);

    const multBefore = g1.comboMult();
    const shieldScore = shield.score;
    const r1 = shotAt(env, g1, neighbour);
    check('(a) the covered neighbour SURVIVED the lethal hit', neighbour.alive === true);
    check('(a) the shield died in its place', shield.alive === false);
    check('(a) exactly one alien died -- one killAlien() per resolved shot',
      r1.killed === 1, `killed=${r1.killed}`);
    check('(a) the score credited is the SHIELD\'s, at the multiplier in force',
      r1.score === shieldScore * multBefore,
      `delta=${r1.score} expected=${shieldScore * multBefore}`);
    check('(a) combo advanced by exactly 1 -- one scoreKill(), not two',
      r1.combo === 1, `delta=${r1.combo}`);
    check('(a) the covered alien flashes so the player can see WHY it survived',
      neighbour.hitFlash > 0, `hitFlash=${neighbour.hitFlash}`);
    check('(a) the non-piercing shot is spent', r1.bullet.dead === true);

    /* (b) with the shield gone the same alien dies normally --------------- */
    const mult2 = g1.comboMult();
    const ownScore = neighbour.score;
    const r2 = shotAt(env, g1, neighbour);
    check('(b) the now-unprotected neighbour dies on the next shot',
      neighbour.alive === false && r2.killed === 1, `killed=${r2.killed}`);
    check('(b) and is credited its OWN score', r2.score === ownScore * mult2,
      `delta=${r2.score} expected=${ownScore * mult2}`);
    check('(b) shieldFor() returns null once the shield is dead',
      sw1.shieldFor(sw1.aliens[C.SWARM.COLS + 1]) === null);

    /* (c) an alien OUTSIDE the radius is not covered ---------------------- */
    const g2 = fresh();
    const sw2 = g2.swarm;
    const far = sw2.aliens.filter((a) =>
      a.alive && !a.commander && Math.abs(a.col - sw2.shield.col) > C.ALIEN_CLASS.SHIELD.RADIUS)[0];
    check('(c) an out-of-radius target exists to shoot', !!far,
      far ? `col=${far.col} shieldCol=${sw2.shield.col}` : 'none');
    const r3 = shotAt(env, g2, far);
    check('(c) an alien outside SHIELD.RADIUS dies normally',
      far.alive === false && r3.killed === 1, `killed=${r3.killed}`);
    check('(c) and the shield is untouched', sw2.shield.alive === true);

    /* (d) a shield does not protect ITSELF (no self-redirect loop) -------- */
    const g3 = fresh();
    const sw3 = g3.swarm;
    const s3 = sw3.shield;
    check('(d) shieldFor(shield) is null -- a shield never covers itself',
      sw3.shieldFor(s3) === null);
    const r4 = shotAt(env, g3, s3);
    check('(d) a direct hit kills the shield, and only it',
      s3.alive === false && r4.killed === 1, `killed=${r4.killed}`);
    check('(d) credited its own score', r4.score === s3.score * 1,
      `delta=${r4.score} score=${s3.score}`);

    /* (e) AC-4 at the collision level: a commander is never covered ------- */
    let cmdOk = true;
    let cmdDetail = '';
    let cmdWaves = 0;
    for (let w = SHIELD_WAVE; w <= SHIELD_WAVE + 8; w++) {
      const sw = new env.SI.Swarm(w);
      if (!sw.commander) continue;
      cmdWaves++;
      if (sw.shieldFor(sw.commander) !== null) {
        cmdOk = false;
        cmdDetail += ` w${w}`;
      }
    }
    check('(e) shieldFor(commander) is null on every wave >= SHIELD.FROM_WAVE ' +
      `that has one (${cmdWaves} waves)`, cmdOk && cmdWaves > 0, cmdDetail.trim());

    /* (f) the PIERCE upgrade still accounts correctly through a redirect --- */
    const g4 = fresh();
    const sw4 = g4.swarm;
    const s4 = sw4.shield;
    const n4 = coveredNeighbour(C, sw4);
    const r5 = shotAt(env, g4, n4, C.UPGRADE.PIERCE_COUNT);
    check('(f) a PIERCING shot into a covered alien kills the SHIELD',
      s4.alive === false && n4.alive === true,
      `shield=${s4.alive} neighbour=${n4.alive}`);
    check('(f) exactly one alien died -- it did NOT redirect twice in one pass',
      r5.killed === 1, `killed=${r5.killed}`);
    check('(f) pierce was decremented exactly once',
      r5.bullet.pierce === C.UPGRADE.PIERCE_COUNT - 1,
      `pierce=${r5.bullet.pierce} from=${C.UPGRADE.PIERCE_COUNT}`);
    check('(f) and the laser survived to fly on', r5.bullet.dead === false);
  });
});

/* --------------------------------------------------------------------- */
scenario('26. KAMIKAZE reaches the ship, costs a life, scores nothing, and never ' +
         'trips onInvasion()', () => {
  withSeed(2601, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const K = C.ALIEN_CLASS.KAMIKAZE;

    /* Formations are pinned OFF for isolation: this scenario is about the
     * dive, and scenarios 3-5 already own the choreography. */
    const armed = (parkX) => {
      const g = startedGame(env, K.FROM_WAVE);
      stillSwarm(g);
      g.swarm.formationsEnabled = false;
      g.swarm.formationTimer = Infinity;
      g.player.invuln = 0;
      if (parkX != null) g.player.x = parkX;
      g.swarm.kamikaze.diveTimer = 0;      // commit on the next tick
      const invasions = { n: 0 };
      const realInvasion = g.world.onInvasion;
      g.world.onInvasion = function () { invasions.n++; realInvasion(); };
      return { g, invasions };
    };

    /* ---- (a) ship contact: one life, no score, no invasion ------------- */
    const a = armed();
    const g1 = a.g;
    const sw1 = g1.swarm;
    const kz = sw1.kamikaze;
    /* A reference alien on the SAME grid row. If the dive ever wrote gx/gy,
     * the anchor relationship between these two would drift. */
    const ref = sw1.aliens.filter((x) => x.row === kz.row && x !== kz && x.alive)[0];
    const dgx = kz.gx - ref.gx;
    const dgy = kz.gy - ref.gy;

    const livesBefore = g1.lives;
    const scoreBefore = g1.score;
    let anchorOk = true;
    let anchorDetail = '';
    let deepestDiver = -Infinity;
    let deepestOther = -Infinity;
    let shooterHits = 0;
    let shooterSamples = 0;
    let diveTicks = 0;
    let contactTick = -1;

    for (let t = 0; t < 900 && contactTick < 0; t++) {
      /* Park the ship under the dive so contact is geometric, not luck. */
      if (kz.dive) g1.player.x = kz.dive.x;
      g1.player.invuln = 0;
      tick(env, g1);
      if (kz.alive) {
        if (Math.abs((kz.gx - ref.gx) - dgx) > 1e-9 ||
            Math.abs((kz.gy - ref.gy) - dgy) > 1e-9) {
          anchorOk = false;
          anchorDetail = `tick ${t}: dgx=${kz.gx - ref.gx} (want ${dgx}) ` +
            `dgy=${kz.gy - ref.gy} (want ${dgy})`;
        }
      }
      if (kz.dive) {
        diveTicks++;
        deepestDiver = Math.max(deepestDiver, kz.y);
        /* pickShooter() must never nominate a committed rammer. */
        for (let s = 0; s < 4; s++) {
          const pick = sw1.pickShooter();
          shooterSamples++;
          if (pick === kz) shooterHits++;
        }
      }
      for (const other of sw1.aliens) {
        if (!other.alive || other.dive) continue;
        deepestOther = Math.max(deepestOther, other.y);
      }
      if (g1.lives !== livesBefore) contactTick = t;
    }

    check('(a) the kamikaze committed to a dive', diveTicks > 0, `ticks=${diveTicks}`);
    check('(a) ANCHOR INVARIANT: gx/gy stayed exactly in lockstep with a same-row ' +
      'alien for the whole dive -- the dive never wrote the grid anchor',
      anchorOk, anchorDetail);
    check('(a) the diver really did pass FORMATION.MAX_Y (the exemption is real)',
      deepestDiver > C.FORMATION.MAX_Y, `deepest=${deepestDiver} max=${C.FORMATION.MAX_Y}`);
    check('(a) no NON-diving alien ever passed FORMATION.MAX_Y',
      deepestOther <= C.FORMATION.MAX_Y + 1e-9,
      `deepest=${deepestOther} max=${C.FORMATION.MAX_Y}`);
    check('(a) contact happened', contactTick >= 0, `tick=${contactTick}`);
    check('(a) it cost exactly one life', g1.lives === livesBefore - 1,
      `${livesBefore} -> ${g1.lives}`);
    check('(a) it awarded NO score', g1.score - scoreBefore === 0,
      `delta=${g1.score - scoreBefore}`);
    check('(a) the kamikaze died on contact', kz.alive === false);
    check('(a) the run continues (lives remained), state is still PLAYING',
      g1.lives > 0 && g1.state === env.SI.STATE.PLAYING,
      `lives=${g1.lives} state=${g1.state}`);
    check('(a) onInvasion() never fired during the whole dive', a.invasions.n === 0,
      `fired=${a.invasions.n}`);
    let bunkersAlive = 0;
    for (const b of g1.bunkers) if (b.alive()) bunkersAlive++;
    check('(a) all four bunkers survived -- a diver is exempt from the crush loop',
      bunkersAlive === 4, `alive=${bunkersAlive}`);
    check('(a) pickShooter() never nominated the committed rammer',
      shooterHits === 0 && shooterSamples >= 200,
      `hits=${shooterHits} samples=${shooterSamples}`);

    /* ---- (b) miss: the dive terminates at its own floor, on screen ------ */
    const bcase = armed(C.WORLD_W - 60);
    const g2 = bcase.g;
    const kz2 = g2.swarm.kamikaze;
    const lives2 = g2.lives;
    const score2 = g2.score;
    /* Captured UNCONDITIONALLY, so the tick that actually crashes the diver
     * (the one on which `alive` flips false) is the one measured. Guarding
     * this on `kz2.alive` would record the last PRE-crash position instead,
     * and the assertions below would then be checking a y the diver had
     * already left -- true by luck of the step size rather than by test. */
    let finalY = 0;
    for (let t = 0; t < 900 && kz2.alive; t++) {
      g2.player.x = C.WORLD_W - 60;         // parked far from the dive path
      g2.player.invuln = 0;                 // prove it is geometry, not invulnerability
      tick(env, g2);
      finalY = kz2.y;
    }
    /* Now that finalY IS the crash position, the bound can be exact: the
     * crash fires on `a.y >= FLOOR_Y`, so the terminal y must be at or past
     * the floor -- and no more than one integration step past it. */
    check('(b) a missed dive terminates AT its own floor (terminal y is at or ' +
      'past FLOOR_Y, and within one step of it)',
      kz2.alive === false && finalY >= K.FLOOR_Y - 1e-9 &&
      finalY <= K.FLOOR_Y + K.SPEED_Y * DT + 1e-9,
      `alive=${kz2.alive} finalY=${finalY} floor=${K.FLOOR_Y} step=${K.SPEED_Y * DT}`);
    check('(b) the crash happens INSIDE the visible world (y + h/2 < WORLD_H)',
      finalY + C.SWARM.ALIEN_H / 2 < C.WORLD_H,
      `bottom=${finalY + C.SWARM.ALIEN_H / 2} world=${C.WORLD_H}`);
    check('(b) a missed dive costs no life and awards no score',
      g2.lives === lives2 && g2.score === score2,
      `lives ${lives2}->${g2.lives} score ${score2}->${g2.score}`);
    check('(b) onInvasion() never fired', bcase.invasions.n === 0,
      `fired=${bcase.invasions.n}`);

    /* ---- (c) an invulnerable ship is not hurt by contact ---------------- */
    const ccase = armed();
    const g3 = ccase.g;
    const kz3 = g3.swarm.kamikaze;
    const lives3 = g3.lives;
    for (let t = 0; t < 900 && kz3.alive; t++) {
      if (kz3.dive) g3.player.x = kz3.dive.x;   // dead centre of the dive path
      g3.player.invuln = 99;                    // ... but shielded
      tick(env, g3);
    }
    check('(c) contact while player.invuln > 0 costs no life -- symmetric with the ' +
      'existing alien-bullet branch', g3.lives === lives3,
      `${lives3} -> ${g3.lives}`);
    check('(c) the diver still crashed out at its floor', kz3.alive === false);

    /* ---- (d) the floor may never steal the last contact frame ----------
     * ORDERING HAZARD, pinned. updateDive()'s FLOOR_Y crash test runs inside
     * Swarm.update(), which executes BEFORE collide()'s contact test in the
     * same tick. If FLOOR_Y sat INSIDE the ship's contact window, a diver
     * whose final integration step landed in the overlap would self-destruct
     * on the very tick it should have registered a ram -- the hit silently
     * voided. The geometry, from the two box() functions rather than from
     * hand-copied numbers:
     *   player.box() spans y  PLAYER.Y -+ PLAYER.H / 2
     *   alien.box()  spans y  centre   -+ ALIEN_H / 2
     * and SI.aabb overlaps on strict inequality, so the boxes touch for an
     * alien centre-y in the OPEN interval (contactTop, contactBottom). */
    const shipTop = C.PLAYER.Y - C.PLAYER.H / 2;
    const shipBottom = C.PLAYER.Y + C.PLAYER.H / 2;
    const halfAlien = C.SWARM.ALIEN_H / 2;
    const contactTop = shipTop - halfAlien;        // 621
    const contactBottom = shipBottom + halfAlien;  // 675
    const bandHeight = contactBottom - contactTop;
    const step = K.SPEED_Y * C.MAX_DT;
    check('(d) FLOOR_Y sits at or below the BOTTOM of the ship contact window, ' +
      'so no tick can be both a crash and a voided ram',
      K.FLOOR_Y >= contactBottom,
      `FLOOR_Y=${K.FLOOR_Y} contact window=(${contactTop}, ${contactBottom})`);
    check('(d) one dive step at the worst legal dt (SPEED_Y * MAX_DT) is ' +
      'comfortably under half the contact window, so a diver can never step ' +
      'over the window in a single frame',
      step > 0 && step < bandHeight / 2,
      `step=${step} window=${bandHeight} half=${bandHeight / 2}`);
    check('(d) the crash still happens on screen with the corrected floor ' +
      '(FLOOR_Y + ALIEN_H / 2 < WORLD_H)',
      K.FLOOR_Y + halfAlien < C.WORLD_H,
      `bottom=${K.FLOOR_Y + halfAlien} world=${C.WORLD_H}`);

    /* Empirical companion to (d): drive a diver straight down onto a parked
     * ship and confirm the contact -- not the floor -- is what resolved it,
     * from a start position deliberately close to the floor. */
    const dcase = armed();
    const g4 = dcase.g;
    const kz4 = g4.swarm.kamikaze;
    const lives4 = g4.lives;
    let resolvedByContact = false;
    for (let t = 0; t < 900 && kz4.alive; t++) {
      if (kz4.dive) g4.player.x = kz4.dive.x;
      g4.player.invuln = 0;
      /* Park the diver one step ABOVE the floor, inside the contact window,
       * which is the exact frame the old FLOOR_Y would have stolen. */
      if (kz4.dive && kz4.dive.y > contactBottom - step * 2) {
        kz4.dive.y = K.FLOOR_Y - step + 0.5;
        kz4.y = kz4.dive.y;
      }
      tick(env, g4);
      if (g4.lives !== lives4) { resolvedByContact = true; break; }
    }
    check('(d) a diver whose last step lands just short of FLOOR_Y and inside ' +
      'the contact window resolves as a RAM, not as a floor crash',
      resolvedByContact && kz4.alive === false,
      `lives ${lives4}->${g4.lives} alive=${kz4.alive}`);
  });
});

/* --------------------------------------------------------------------- */
/* Scenario 27's run, factored out so it can be executed twice under the
 * same seed and compared byte for byte (the determinism discipline
 * scenario 21 established). Returns both a per-tick log and the total
 * Math.random draw count. */
function classIntegrationRun(seed) {
  return countedRun(seed, (counter) => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const R = C.ALIEN_CLASS.SHIELD.RADIUS;

    /* Spy on the single redirect choke point: shieldFor() is called from
     * exactly one place (the player-shot branch of collide()), so a non-null
     * return IS a redirect. */
    const realShieldFor = env.SI.Swarm.prototype.shieldFor;
    let redirects = 0;
    env.SI.Swarm.prototype.shieldFor = function (al) {
      const r = realShieldFor.call(this, al);
      if (r) redirects += 1;
      return r;
    };

    const log = [];
    const errors = [];
    const seenWaves = [];
    let poolOverflow = 0;
    let maxParticles = 0;
    let dives = 0;
    let deepestNonDiver = -Infinity;
    let bunkersAtWaveStart = [];
    let pickTurn = 0;
    let lastWave = 0;

    try {
      const game = startedGame(env, C.ALIEN_CLASS.SHIELD.FROM_WAVE);

      for (let t = 0; t < 4200; t++) {
        scriptInput(env.input, t);
        /* Keep the run alive: this scenario is about invariants across
         * waves 4-6, not about surviving them. */
        if (game.lives < 5) game.lives = 5;
        /* Park the ship on the RIGHT flank and leave it there. A kamikaze is
         * always on the bottom row at column (wave - FROM_WAVE) % COLS, i.e.
         * the LEFT flank at these waves, and the scripted fire is a straight
         * shot from the ship's own x -- so a roaming ship simply shoots the
         * rammer off the board before its FIRST_DELAY elapses and the dive
         * assertion below becomes a coin flip on the seed. This is not the
         * dive being propped up: it is the scenario declining to shoot the
         * thing it is trying to observe. Scenario 26 drives the dive from a
         * pinned, isolated wave; this one only asserts that it HAPPENS
         * during ordinary multi-wave play. */
        if (game.state === env.SI.STATE.PLAYING) {
          env.input.axis = 0;
          game.player.x = C.WORLD_W - 80;
        }

        if (game.state === env.SI.STATE.UPGRADE) {
          env.input.axis = 0;
          env.input.fire = false;
          env.input.firePress = false;
          if (game.stateTimer > C.UPGRADE.MIN_DWELL + 0.1) {
            game.upgradeIndex = pickTurn % C.UPGRADE.IDS.length;
            pickTurn += 1;
            env.input.confirm = true;
          }
        }

        /* Deliberately provoke a redirect: without aiming at a COVERED alien
         * the "a redirect actually happened" assertion below would be a coin
         * flip on the seed rather than a check. */
        if (t % 29 === 0 && game.state === env.SI.STATE.PLAYING && game.swarm) {
          const sw = game.swarm;
          let target = null;
          if (sw.shield && sw.shield.alive) target = coveredNeighbour(C, sw);
          if (!target) {
            /* Mop up whatever the thinning below exempts, so a wave can
             * actually clear. The kamikaze is never a target here: it dies
             * by crashing or ramming, which is the behaviour under test. */
            target = sw.aliens.filter((al) => al.alive && al.role !== 'kamikaze')[0] || null;
          }
          if (target) {
            game.bullets.push(new env.SI.Bullet(
              target.x, target.y, -C.BULLET.PLAYER_SPEED, 'player', '#fff'));
          }
        }

        tick(env, game);

        if (game.wave !== lastWave) {
          lastWave = game.wave;
          seenWaves.push(game.wave);
          let alive = 0;
          for (const b of game.bunkers) if (b.alive()) alive += 1;
          bunkersAtWaveStart.push(`${game.wave}:${game.bunkers.length}/${alive}`);
        }

        if (game.swarm) {
          if (game.swarm.kamikaze && game.swarm.kamikaze.dive) dives += 1;
          for (const al of game.swarm.aliens) {
            if (!al.alive || al.dive) continue;
            /* The real invariant, and NOT "y <= FORMATION.MAX_Y": the GRID
             * ANCHOR is allowed past MAX_Y -- that is how the classic march
             * descends toward the invasion floor at SWARM.FLOOR_Y (610), and
             * a late wave routinely sits below 516. What MAX_Y bounds is the
             * FORMATION OFFSET: applyFormation() clamps a downward offset to
             * Math.max(gy, MAX_Y), so choreography may never push an alien
             * below MAX_Y, nor below its own anchor. Measure exactly that. */
            deepestNonDiver = Math.max(
              deepestNonDiver, al.y - Math.max(al.gy, C.FORMATION.MAX_Y));
          }
          /* Thin the swarm so the run reaches wave 6. Both class aliens and
           * the block the shield covers are EXEMPT -- sniping them would
           * make the "a redirect / a dive happened" assertions seed-
           * dependent. Commanders are NOT exempt here (unlike scenario 13,
           * which exempts them because it asserts formations ran): this
           * scenario asserts nothing about choreography. */
          if (t % 11 === 0 && game.state === env.SI.STATE.PLAYING) {
            const live = game.swarm.aliens.filter((al) =>
              al.alive && !al.role &&
              !(game.swarm.shield && game.swarm.shield.alive &&
                Math.abs(al.col - game.swarm.shield.col) <= R &&
                Math.abs(al.row - game.swarm.shield.row) <= R));
            if (live.length > 0) {
              const victim = live[Math.floor(Math.random() * live.length)];
              game.swarm.killAlien(victim, game.world);
              game.addScore(victim.score);
            }
          }
        }

        maxParticles = Math.max(maxParticles, game.particles.count);
        if (game.particles.count > game.particles.cap) poolOverflow += 1;
        if (game.state === env.SI.STATE.GAME_OVER && game.stateTimer > 0.5) {
          env.input.confirm = true;
        }
        log.push(`${t}|${game.wave}|${game.score}|${game.lives}|` +
          `${game.swarm ? game.swarm.aliveCount() : -1}`);
      }
    } catch (e) {
      errors.push((e && e.stack) || String(e));
    } finally {
      env.SI.Swarm.prototype.shieldFor = realShieldFor;
    }

    return {
      log: log.join('\n'),
      draws: counter.draws,
      errors,
      seenWaves,
      redirects,
      dives,
      poolOverflow,
      maxParticles,
      deepestNonDiver,
      bunkersAtWaveStart,
      maxY: C.FORMATION.MAX_Y
    };
  });
}

scenario('27. multi-wave integration across waves 4-6, invariants held every tick', () => {
  const a = classIntegrationRun(2701);
  console.log(`    waves seen: ${a.seenWaves.join(',')} | redirects=${a.redirects} | ` +
    `diveTicks=${a.dives} | maxParticles=${a.maxParticles}`);
  console.log(`    bunkers at each wave start (wave:count/alive): ` +
    `${a.bunkersAtWaveStart.join(' ')}`);

  check('zero exceptions from update/draw/drawHud across the whole run',
    a.errors.length === 0, a.errors[0]);
  check('the run really covered waves 4, 5 and 6',
    [4, 5, 6].every((w) => a.seenWaves.indexOf(w) >= 0), a.seenWaves.join(','));
  check('four bunkers rebuilt, undamaged, at the start of every wave',
    a.bunkersAtWaveStart.every((s) => s.split(':')[1] === '4/4'),
    a.bunkersAtWaveStart.join(' '));
  check('particle pool never exceeded its cap', a.poolOverflow === 0,
    `overflows=${a.poolOverflow} max=${a.maxParticles}`);
  check('EVERY tick: no non-diving alien was displaced past max(its own anchor, ' +
    'FORMATION.MAX_Y) -- choreography stays bounded, only the diver is exempt',
    a.deepestNonDiver <= 1e-9, `worst overshoot=${a.deepestNonDiver}`);
  /* Not vacuous: assert both mechanics genuinely fired during the run. */
  check('at least one SHIELD redirect actually happened (not a vacuous pass)',
    a.redirects > 0, `redirects=${a.redirects}`);
  check('at least one KAMIKAZE dive actually happened (not a vacuous pass)',
    a.dives > 0, `diveTicks=${a.dives}`);

  /* Determinism: the same scripted run under the same seed must reproduce
   * exactly, including how many Math.random draws it spent. */
  const b = classIntegrationRun(2701);
  check('the same seeded run reproduces an identical per-tick score/lives/alive log',
    a.log === b.log, a.log === b.log ? '' : 'per-tick logs diverged');
  check('and spends an identical number of Math.random draws',
    a.draws === b.draws, `${a.draws} vs ${b.draws}`);
  check('and reports identical redirect / dive counts',
    a.redirects === b.redirects && a.dives === b.dives,
    `${a.redirects}/${a.dives} vs ${b.redirects}/${b.dives}`);
});

/* --------------------------------------------------------------------- */
/* WEAPON COMBINATION SYSTEM (scenarios 28-30).
 *
 * A LIST-AWARE confirm helper. Deliberately NOT a change to confirmUpgrade()
 * above: that one resolves its index against CONFIG.UPGRADE.IDS and scenario
 * 12 depends on exactly that behaviour, so it stays byte-for-byte untouched.
 * This one resolves against the LIVE list the screen is actually offering. */
function confirmChoice(env, game, id) {
  const ids = game.upgradeChoices();
  const idx = ids.indexOf(id);
  if (idx < 0) return false;
  game.upgradeIndex = idx;
  const dwell = Math.ceil(env.SI.CONFIG.UPGRADE.MIN_DWELL / DT) + 1;
  for (let t = 0; t < dwell; t++) tick(env, game);
  env.input.confirm = true;
  tick(env, game);
  return game.state === env.SI.STATE.PLAYING;
}

const rgbOf = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
];
const chanGapOf = (x, y) => {
  const a = rgbOf(x);
  const b = rgbOf(y);
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
};

scenario('28. the PIERCE+BOUNCE combination is offered only from its two halves', () => {
  withSeed(2801, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const S = env.SI.STATE;
    const U = C.UPGRADE;
    const IDS = U.IDS;

    /* (a) the substitution is a pure function of game.upgrade ------------- */
    const probe = startedGame(env);
    const listFor = (up) => { probe.upgrade = up; return probe.upgradeChoices(); };

    let plainOk = true;
    let plainDetail = '';
    for (const up of ['none', 'spread', 'shield', U.COMBINED_ID]) {
      const got = listFor(up);
      if (got.length !== IDS.length || got.some((id, i) => id !== IDS[i])) {
        plainOk = false;
        plainDetail += ` ${up}->[${got.join(',')}]`;
      }
    }
    check('(a) upgrade none/spread/shield/pierce_bounce all offer the unchanged 4 IDS',
      plainOk, plainDetail.trim());
    check('(a) the combined upgrade itself cannot be combined again -- no third tier',
      listFor(U.COMBINED_ID).indexOf(U.COMBINED_ID) < 0);

    for (const half of ['pierce', 'bounce']) {
      const mate = U.COMBINES[half];
      const got = listFor(half);
      check(`(a) from '${half}' the list is still exactly ${IDS.length} cards`,
        got.length === IDS.length, `len=${got.length}`);
      check(`(a) from '${half}' the combine card sits in '${mate}'s slot ` +
        `(index ${IDS.indexOf(mate)})`,
        got[IDS.indexOf(mate)] === U.COMBINED_ID, `[${got.join(',')}]`);
      let othersOk = true;
      for (let i = 0; i < IDS.length; i++) {
        if (i === IDS.indexOf(mate)) continue;
        if (got[i] !== IDS[i]) othersOk = false;
      }
      check(`(a) from '${half}' every other card keeps its normal index`,
        othersOk, `[${got.join(',')}]`);
      check(`(a) from '${half}' the complement '${mate}' is no longer offered on its own`,
        got.indexOf(mate) < 0, `[${got.join(',')}]`);
    }

    /* (b) the LIVE path: pierce, then the combine card ---------------------- */
    const game = startedGame(env);
    check('(b) reached the first upgrade screen', driveToUpgradeScreen(env, game),
      game.state);
    check('(b) that first screen offers the plain four (upgrade is still none)',
      game.upgradeChoices().every((id, i) => id === IDS[i]),
      `[${game.upgradeChoices().join(',')}]`);
    check('(b) pierce confirmed', confirmChoice(env, game, 'pierce'), `state=${game.state}`);
    check("(b) upgrade is 'pierce'", game.upgrade === 'pierce', game.upgrade);

    const waveBefore = game.wave;
    check('(b) reached the second upgrade screen', driveToUpgradeScreen(env, game),
      game.state);
    const liveList = game.upgradeChoices();
    const combineIdx = liveList.indexOf(U.COMBINED_ID);
    check('(b) the second screen really offers the combine card',
      combineIdx >= 0, `[${liveList.join(',')}]`);
    check('(b) combine card confirmed', confirmChoice(env, game, U.COMBINED_ID),
      `state=${game.state}`);
    check(`(b) game.upgrade is exactly '${U.COMBINED_ID}' -- not silently ids[0]`,
      game.upgrade === U.COMBINED_ID, game.upgrade);
    check('(b) the wave advanced normally', game.wave === waveBefore + 1,
      `wave=${game.wave} was=${waveBefore}`);
    check('(b) and applyUpgrade did not fall back to a plain id',
      IDS.indexOf(game.upgrade) < 0, game.upgrade);

    /* (b2) from the combined cannon, the four plain cards come back --------- */
    check('(b2) reached a third upgrade screen', driveToUpgradeScreen(env, game),
      game.state);
    check('(b2) it offers the plain four again',
      game.upgradeChoices().every((id, i) => id === IDS[i]),
      `[${game.upgradeChoices().join(',')}]`);
    check("(b2) 'one only, replaces' still governs the combined cannon",
      confirmChoice(env, game, 'shield') && game.upgrade === 'shield', game.upgrade);

    /* (c) NEGATIVE: from 'spread', card 2 is still plain 'bounce' ----------- */
    const neg = startedGame(env);
    neg.upgrade = 'spread';
    check('(c) reached the upgrade screen', driveToUpgradeScreen(env, neg), neg.state);
    check('(c) no substitution applies from spread',
      neg.upgradeChoices()[2] === 'bounce', `[${neg.upgradeChoices().join(',')}]`);
    neg.upgradeIndex = 2;
    const dwell = Math.ceil(U.MIN_DWELL / DT) + 1;
    for (let t = 0; t < dwell; t++) tick(env, neg);
    env.input.confirm = true;
    tick(env, neg);
    check("(c) confirming card 2 from 'spread' yields plain 'bounce'",
      neg.upgrade === 'bounce', neg.upgrade);

    /* (d) mash protection applies identically to the combine card ----------- */
    /* (d1) a HELD fire key must not lock the combine card in. */
    const held = startedGame(env);
    held.upgrade = 'pierce';
    held.clearWave();
    const holdTicks = Math.floor((U.PICK_TIMEOUT - 1) / DT);
    for (let t = 0; t < holdTicks; t++) {
      if (held.state === S.UPGRADE) {
        held.upgradeIndex = held.upgradeChoices().indexOf(U.COMBINED_ID);
      }
      env.input.keys.Space = true;
      env.input.confirm = true;
      tick(env, held);
      if (held.state === S.PLAYING) break;
    }
    check('(d1) the combine card is the highlighted one',
      held.state === S.UPGRADE &&
      held.upgradeChoices()[held.upgradeIndex] === U.COMBINED_ID,
      `state=${held.state} index=${held.upgradeIndex}`);
    check('(d1) a held fire key never confirms the combine card',
      held.state === S.UPGRADE, `state=${held.state}`);
    check('(d1) the held key did not arm the screen', held.upgradeArmed === false);
    check('(d1) the dwell gate was long since satisfied -- the release gate held',
      held.stateTimer > U.MIN_DWELL + 1, `t=${held.stateTimer}`);

    /* (d2) mashing cannot beat MIN_DWELL on the combine card either. */
    const mash = startedGame(env);
    mash.upgrade = 'bounce';                 // the other half -- symmetric case
    check('(d2) reached the upgrade screen', driveToUpgradeScreen(env, mash), mash.state);
    let pickedAt = -1;
    for (let t = 0; t < 900; t++) {
      const clockBefore = mash.stateTimer;
      if (mash.state === S.UPGRADE) {
        mash.upgradeIndex = mash.upgradeChoices().indexOf(U.COMBINED_ID);
      }
      const downFrame = t % 4 < 2;
      env.input.keys.Space = downFrame;
      env.input.confirm = downFrame && (t % 4 === 0);
      tick(env, mash);
      if (mash.state !== S.UPGRADE) { pickedAt = clockBefore; break; }
    }
    check(`(d2) mashing could not confirm the combine card before MIN_DWELL ` +
      `(${U.MIN_DWELL}s)`, pickedAt >= U.MIN_DWELL, `picked at ${pickedAt}s`);
    check('(d2) a masher does eventually get the combined cannon (not a soft lock)',
      mash.state === S.PLAYING && mash.upgrade === U.COMBINED_ID,
      `state=${mash.state} upgrade=${mash.upgrade}`);

    /* (d3) tapping the combine card's rect selects and confirms THAT card,
     *      proving the hit-test reads the substituted list too. */
    const tap = startedGame(env);
    tap.upgrade = 'pierce';
    check('(d3) reached the upgrade screen', driveToUpgradeScreen(env, tap), tap.state);
    for (let t = 0; t < dwell; t++) tick(env, tap);
    const tapList = tap.upgradeChoices();
    const tapIdx = tapList.indexOf(U.COMBINED_ID);
    const rect = env.SI.HUD.upgradeCardRect(tapIdx, tapList.length);
    const p = env.SI.Input.pointer();
    p.active = true;
    p.firing = true;
    p.x = rect.x + rect.w / 2;
    p.y = rect.y + rect.h / 2;
    env.input.keys.Pointer = true;
    env.input.confirm = true;
    tick(env, tap);
    check('(d3) a tap on the combine card confirms exactly that card',
      tap.state === S.PLAYING && tap.upgrade === U.COMBINED_ID,
      `state=${tap.state} upgrade=${tap.upgrade}`);
    p.active = false;
    p.firing = false;
  });
});

/* --------------------------------------------------------------------- */
scenario('29. a combined shot pierces AND bounces, and still kills at most ' +
         'PIERCE_COUNT + 1', () => {
  withSeed(2901, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const U = C.UPGRADE;

    /* (a) the REAL fire path produces ONE bullet carrying BOTH fields ------ */
    const game = startedGame(env);
    quietSwarm(game);
    game.upgrade = U.COMBINED_ID;
    env.input.fire = true;
    env.input.firePress = true;
    tick(env, game);
    const shots = alivePlayerBullets(game);
    check('(a) exactly one player bullet (not three -- this is not spread)',
      shots.length === 1, `got ${shots.length}`);
    if (shots.length === 1) {
      const s = shots[0];
      check(`(a) pierce === PIERCE_COUNT (${U.PIERCE_COUNT})`,
        s.pierce === U.PIERCE_COUNT, `pierce=${s.pierce}`);
      check(`(a) bounce === BOUNCE_MAX (${U.BOUNCE_MAX})`,
        s.bounce === U.BOUNCE_MAX, `bounce=${s.bounce}`);
      check('(a) it has horizontal velocity, magnitude BOUNCE_VX',
        s.vx !== 0 && Math.abs(s.vx) === U.BOUNCE_VX, `vx=${s.vx}`);
      check('(a) it climbs at BOUNCE_VY, not PLAYER_SPEED',
        s.vy === -U.BOUNCE_VY, `vy=${s.vy}`);
      check('(a) it wears the combined colour, neither half\'s',
        s.color === C.COLORS.pierceBounce &&
        s.color !== C.COLORS.playerGlow && s.color !== C.COLORS.warn, s.color);
      check('(a) all three -- pierce, bounce and vx -- hold SIMULTANEOUSLY',
        s.pierce === U.PIERCE_COUNT && s.bounce === U.BOUNCE_MAX && s.vx !== 0);
    }
    /* And the other cannons are untouched by the restructured fire(). */
    const plain = (up) => {
      const g = startedGame(env);
      quietSwarm(g);
      g.upgrade = up;
      env.input.fire = true;
      env.input.firePress = true;
      tick(env, g);
      env.input.fire = false;
      return alivePlayerBullets(g);
    };
    const noneShots = plain('none');
    check('(a) a no-upgrade shot is still inert (pierce 0, bounce 0, vx 0)',
      noneShots.length === 1 && noneShots[0].pierce === 0 &&
      noneShots[0].bounce === 0 && noneShots[0].vx === 0);
    const pShots = plain('pierce');
    check('(a) a plain pierce shot still carries NO bounce and NO vx',
      pShots.length === 1 && pShots[0].pierce === U.PIERCE_COUNT &&
      pShots[0].bounce === 0 && pShots[0].vx === 0,
      pShots.length === 1 ? `p=${pShots[0].pierce} b=${pShots[0].bounce} vx=${pShots[0].vx}` : '');
    const bShots = plain('bounce');
    check('(a) a plain bounce shot still carries NO pierce',
      bShots.length === 1 && bShots[0].bounce === U.BOUNCE_MAX &&
      bShots[0].pierce === 0 && bShots[0].vx !== 0,
      bShots.length === 1 ? `p=${bShots[0].pierce} b=${bShots[0].bounce} vx=${bShots[0].vx}` : '');
    const sShots = plain('shield');
    check('(a) a shield-cannon shot is still the classic bullet',
      sShots.length === 1 && sShots[0].pierce === 0 &&
      sShots[0].bounce === 0 && sShots[0].vx === 0);
    /* COLOURS on the PLAIN cannons, not just the combined one. Player.fire()
     * now resolves the colour in a single expression covering four cases; a
     * typo in any one arm (matching 'pierce' where COMBINED_ID was meant, or
     * dropping the plain fall-through) would silently repaint a whole cannon
     * and nothing above would notice, because none of those checks reads
     * .color. */
    check(`(a) a plain pierce shot is still pierce-cyan (COLORS.playerGlow, ` +
      `${C.COLORS.playerGlow}) -- NOT the combined colour`,
      pShots.length === 1 && pShots[0].color === C.COLORS.playerGlow,
      pShots.length === 1 ? pShots[0].color : '');
    check(`(a) a plain bounce shot is still bounce-amber (COLORS.warn, ` +
      `${C.COLORS.warn}) -- NOT the combined colour`,
      bShots.length === 1 && bShots[0].color === C.COLORS.warn,
      bShots.length === 1 ? bShots[0].color : '');
    check(`(a) a no-upgrade and a shield-cannon shot are both still plain ` +
      `bullet white (COLORS.bullet, ${C.COLORS.bullet})`,
      noneShots.length === 1 && sShots.length === 1 &&
      noneShots[0].color === C.COLORS.bullet &&
      sShots[0].color === C.COLORS.bullet,
      `${noneShots.length === 1 ? noneShots[0].color : '?'} / ` +
      `${sShots.length === 1 ? sShots[0].color : '?'}`);
    check('(a) all four cannon colours are pairwise distinct',
      new Set([C.COLORS.bullet, C.COLORS.playerGlow, C.COLORS.warn,
        C.COLORS.pierceBounce]).size === 4);
    check('(a) one muzzle shoot() per volley, unchanged',
      env.SI.Audio.calls.shoot > 0);

    /* (b) accounting: one killAlien + one scoreKill per alien, and the two
     *     counters never interfere with one another ----------------------- */
    const g2 = startedGame(env);
    g2.player.invuln = 0;
    const sw = g2.swarm;
    const aliveAtStart = sw.aliveCount();

    /* Instrument the two choke points on the INSTANCES, so the real
     * prototypes (and every other scenario) are untouched. */
    const killCalls = [];
    const scoreCalls = [];
    const realKill = sw.killAlien;
    const realScore = g2.scoreKill;
    let bullet = null;
    sw.killAlien = function (a, world) {
      killCalls.push({ alien: a, bounceAtKill: bullet ? bullet.bounce : -1 });
      return realKill.call(this, a, world);
    };
    g2.scoreKill = function (points) {
      scoreCalls.push(points);
      return realScore.call(this, points);
    };

    /* Start low and hard against the RIGHT wall so the reflection happens
     * BEFORE the shot reaches the swarm -- that is what makes "it pierced
     * AND bounced in one flight" non-vacuous rather than lucky. y 500 is
     * below the swarm and above BUNKER.Y (546). */
    bullet = new env.SI.Bullet(900, 500, -U.BOUNCE_VY, 'player', C.COLORS.pierceBounce);
    bullet.vx = U.BOUNCE_VX;
    bullet.pierce = U.PIERCE_COUNT;
    bullet.bounce = U.BOUNCE_MAX;
    g2.bullets.push(bullet);

    let reflections = 0;
    let reflectedWhilePiercing = 0;
    let bounceChangedOnKillTick = 0;
    let pierceChangedOnPureReflectTick = 0;
    let pierceAccountingBad = 0;
    for (let t = 0; t < 600 && !bullet.dead; t++) {
      quietSwarm(g2);
      const before = { p: bullet.pierce, b: bullet.bounce, sx: Math.sign(bullet.vx) };
      const killsBefore = killCalls.length;
      tick(env, g2);
      const kills = killCalls.length - killsBefore;
      const reflected = Math.sign(bullet.vx) !== before.sx ? 1 : 0;
      if (reflected) {
        reflections += 1;
        if (before.p > 0) reflectedWhilePiercing += 1;
        if (kills === 0 && bullet.pierce !== before.p) pierceChangedOnPureReflectTick += 1;
      }
      if (kills > 0 && bullet.bounce !== before.b - reflected) bounceChangedOnKillTick += 1;
      /* pierce falls by exactly one per kill, until it runs out (then the
       * shot dies instead of decrementing below zero). */
      if (kills > 0 && !bullet.dead && bullet.pierce !== before.p - kills) {
        pierceAccountingBad += 1;
      }
      for (const k of killCalls.slice(killsBefore)) {
        if (k.bounceAtKill !== bullet.bounce) bounceChangedOnKillTick += 1;
      }
    }
    const died = aliveAtStart - sw.aliveCount();
    console.log(`    combined flight: kills=${killCalls.length} scoreKills=` +
      `${scoreCalls.length} aliensDead=${died} reflections=${reflections} ` +
      `pierceLeft=${bullet.pierce} bounceLeft=${bullet.bounce} dead=${bullet.dead}`);

    check('(b) it genuinely killed at least one alien (not a vacuous pass)',
      killCalls.length >= 1, `kills=${killCalls.length}`);
    check('(b) it genuinely reflected off a wall at least once',
      reflections >= 1, `reflections=${reflections}`);
    check('(b) at least one reflection happened while pierce was still > 0 -- ' +
      'it PIERCED AND BOUNCED in one flight', reflectedWhilePiercing >= 1,
      `reflectedWhilePiercing=${reflectedWhilePiercing}`);
    check('(b) exactly one killAlien() per alien that actually died',
      killCalls.length === died, `kills=${killCalls.length} died=${died}`);
    check('(b) exactly one scoreKill() per killAlien() -- no double, no missed scoring',
      scoreCalls.length === killCalls.length,
      `score=${scoreCalls.length} kill=${killCalls.length}`);
    check('(b) no kill event ever changed the bullet\'s bounce field',
      bounceChangedOnKillTick === 0, `violations=${bounceChangedOnKillTick}`);
    check('(b) no wall reflection ever changed the bullet\'s pierce field',
      pierceChangedOnPureReflectTick === 0,
      `violations=${pierceChangedOnPureReflectTick}`);
    check('(b) pierce decremented exactly once per kill',
      pierceAccountingBad === 0, `violations=${pierceAccountingBad}`);
    check('(b) the shot eventually died (pierce or bounce exhausted, or cover hit)',
      bullet.dead === true);
    check(`(b) it never killed more than PIERCE_COUNT + 1 (${U.PIERCE_COUNT + 1}) aliens`,
      killCalls.length <= U.PIERCE_COUNT + 1, `kills=${killCalls.length}`);

    /* (c) AC-6: the server's bound is still the right one ------------------ */
    const AC = require(path.join(ROOT, 'server', 'src', 'anticheat.js'));
    check('(c) server/src/anticheat.js exports BEST_ALIENS_PER_SHOT',
      typeof AC.BEST_ALIENS_PER_SHOT === 'number', String(AC.BEST_ALIENS_PER_SHOT));
    check(`(c) 1 + PIERCE_COUNT === BEST_ALIENS_PER_SHOT ` +
      `(${1 + U.PIERCE_COUNT} === ${AC.BEST_ALIENS_PER_SHOT}) -- no re-derivation needed`,
      1 + U.PIERCE_COUNT === AC.BEST_ALIENS_PER_SHOT);

    /* Brute force: sweep launch positions and both launch sides through a
     * FULL wave-1 swarm; no flight may exceed the server's bound. */
    let worst = 0;
    let worstAt = '';
    let trials = 0;
    for (let x = 60; x <= 900; x += 60) {
      for (const side of [1, -1]) {
        for (const y of [500, 380]) {
          const g = startedGame(env);
          g.player.invuln = 0;
          const before = g.swarm.aliveCount();
          const b = new env.SI.Bullet(
            x, y, -U.BOUNCE_VY, 'player', C.COLORS.pierceBounce);
          b.vx = U.BOUNCE_VX * side;
          b.pierce = U.PIERCE_COUNT;
          b.bounce = U.BOUNCE_MAX;
          g.bullets.push(b);
          for (let t = 0; t < 600 && !b.dead; t++) {
            quietSwarm(g);
            tick(env, g);
          }
          const n = before - g.swarm.aliveCount();
          trials += 1;
          if (n > worst) { worst = n; worstAt = `x=${x} y=${y} side=${side}`; }
        }
      }
    }
    console.log(`    brute force: ${trials} combined flights, worst kill count ${worst}` +
      `${worstAt ? ' at ' + worstAt : ''}`);
    check(`(c) across ${trials} simulated combined flights the worst kill count is ` +
      `${worst} <= BEST_ALIENS_PER_SHOT (${AC.BEST_ALIENS_PER_SHOT})`,
      worst <= AC.BEST_ALIENS_PER_SHOT, `worst=${worst} at ${worstAt}`);
    check('(c) the sweep was not vacuous -- some flight did kill aliens', worst > 0);
  });
});

/* --------------------------------------------------------------------- */
scenario('30. HUD presentation of the combined cannon', () => {
  withSeed(3001, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const S = env.SI.STATE;
    const U = C.UPGRADE;

    const calls = [];
    env.SI.FX.glowText = function (ctx, text, x, y, opts) {
      calls.push({ text: String(text), x, y, opts: opts || {} });
    };
    const NAMES = ['SPREAD SHOT', 'PIERCING LASER', 'BOUNCING SHOT', 'TEMP SHIELD',
                   'PIERCE + BOUNCE'];
    const cardNames = () => calls.filter((c) => NAMES.indexOf(c.text) >= 0);

    /* (a) the plain screen is exactly as it was ---------------------------- */
    const g0 = startedGame(env);
    g0.upgrade = 'none';
    g0.setState(S.UPGRADE);
    env.SI.HUD.draw(env.ctx, g0);
    check('(a) the HUD stub is wired up (something was drawn)', calls.length > 0,
      `calls=${calls.length}`);
    const plainCards = cardNames().map((c) => c.text);
    check('(a) with no upgrade the four original card names are drawn',
      plainCards.length === 4 &&
      ['SPREAD SHOT', 'PIERCING LASER', 'BOUNCING SHOT', 'TEMP SHIELD']
        .every((n) => plainCards.indexOf(n) >= 0), plainCards.join(','));
    check("(a) 'PIERCE + BOUNCE' is absent from that screen",
      plainCards.indexOf('PIERCE + BOUNCE') < 0, plainCards.join(','));
    /* Card colours, read back from what the HUD actually drew rather than
     * duplicated as literals here. */
    const colorOf = {};
    for (const c of cardNames()) colorOf[c.text] = c.opts.glow;

    /* (b) from 'pierce' the combine card SUBSTITUTES the bounce card ------- */
    calls.length = 0;
    const g1 = startedGame(env);
    g1.upgrade = 'pierce';
    g1.setState(S.UPGRADE);
    env.SI.HUD.draw(env.ctx, g1);
    const subCards = cardNames();
    check('(b) still exactly four card names are drawn -- no fifth card',
      subCards.length === 4, subCards.map((c) => c.text).join(','));
    const combine = subCards.filter((c) => c.text === 'PIERCE + BOUNCE');
    check("(b) 'PIERCE + BOUNCE' is drawn exactly once", combine.length === 1,
      `count=${combine.length}`);
    check("(b) 'BOUNCING SHOT' is no longer drawn -- it was substituted, not added",
      subCards.every((c) => c.text !== 'BOUNCING SHOT'),
      subCards.map((c) => c.text).join(','));
    if (combine.length === 1) {
      const list = g1.upgradeChoices();
      const idx = list.indexOf(U.COMBINED_ID);
      const r = env.SI.HUD.upgradeCardRect(idx, list.length);
      check(`(b) it is drawn at card ${idx}'s own rect (geometry unchanged, ` +
        'not hardcoded)',
        combine[0].x === r.x + r.w / 2 && combine[0].y === r.y + 126,
        `drawn at (${combine[0].x},${combine[0].y}) rect centre ` +
        `(${r.x + r.w / 2},${r.y + 126})`);
      const bounceRect = env.SI.HUD.upgradeCardRect(U.IDS.indexOf('bounce'),
        U.IDS.length);
      check("(b) that rect IS the slot 'bounce' would have occupied",
        r.x === bounceRect.x && r.y === bounceRect.y, `${r.x} vs ${bounceRect.x}`);
      colorOf['PIERCE + BOUNCE'] = combine[0].opts.glow;
    }
    /* The hint texts stay literally true and unchanged. */
    check('(b) the "ONE ONLY - IT REPLACES YOUR CURRENT CANNON" hint is unchanged',
      calls.some((c) => c.text === 'ONE  ONLY  -  IT  REPLACES  YOUR  CURRENT  CANNON'));
    check('(b) the "1-4 TO CHOOSE" hint is unchanged (still four cards)',
      calls.some((c) => c.text.indexOf('1-4  TO  CHOOSE') >= 0));

    /* (c) the bottom-right CANNON indicator ------------------------------- */
    calls.length = 0;
    const g2 = startedGame(env);
    g2.upgrade = U.COMBINED_ID;
    g2.setState(S.PLAYING);
    env.SI.HUD.draw(env.ctx, g2);
    const ind = calls.filter((c) => c.text === 'CANNON  PIERCE + BOUNCE');
    check('(c) the CANNON indicator reads "CANNON  PIERCE + BOUNCE", exactly once',
      ind.length === 1, `count=${ind.length}`);
    if (ind.length === 1) {
      check('(c) drawn bottom-right, right-aligned, at the established position',
        ind[0].x === C.WORLD_W - 26 && ind[0].y === C.WORLD_H - 20 &&
        ind[0].opts.align === 'right',
        `x=${ind[0].x} y=${ind[0].y} align=${ind[0].opts.align}`);
      check('(c) in COLORS.pierceBounce -- the HUD table and core.js agree',
        ind[0].opts.color === C.COLORS.pierceBounce,
        `${ind[0].opts.color} vs ${C.COLORS.pierceBounce}`);
    }

    /* (d) palette: the new colour reads as neither half -------------------- */
    const MIN_CHANNEL_GAP = 48;
    check('(d) all five card colours were captured from the real HUD draw',
      NAMES.every((n) => typeof colorOf[n] === 'string'),
      NAMES.map((n) => `${n}=${colorOf[n]}`).join(' '));
    const mine = colorOf['PIERCE + BOUNCE'];
    check('(d) the combine card is painted CONFIG.COLORS.pierceBounce',
      mine === C.COLORS.pierceBounce, `${mine} vs ${C.COLORS.pierceBounce}`);
    const REFS = [
      ['bullet', C.COLORS.bullet],
      ['playerGlow(pierce shot)', C.COLORS.playerGlow],
      ['warn(bounce shot)', C.COLORS.warn]
    ];
    for (const n of NAMES) {
      if (n !== 'PIERCE + BOUNCE') REFS.push([`card:${n}`, colorOf[n]]);
    }
    let paletteOk = true;
    let paletteDetail = '';
    for (const ref of REFS) {
      const d = chanGapOf(mine, ref[1]);
      if (d < MIN_CHANNEL_GAP) {
        paletteOk = false;
        paletteDetail += ` pierceBounce(${mine})~${ref[0]}(${ref[1]}):${d}`;
      }
    }
    check(`(d) it clears ${MIN_CHANNEL_GAP}/255 in some channel from the other four ` +
      `card colours, the plain bullet, pierce-cyan and bounce-amber ` +
      `(${REFS.length} references)`, paletteOk, paletteDetail.trim());

    /* (e) the new icon draws without throwing, at every card, in both lists. */
    const drawErrors = [];
    for (const up of ['none', 'pierce', 'bounce', U.COMBINED_ID]) {
      const g = startedGame(env);
      g.upgrade = up;
      g.setState(S.UPGRADE);
      for (let i = 0; i < U.IDS.length; i++) {
        g.upgradeIndex = i;
        try { env.SI.HUD.draw(env.ctx, g); } catch (e) {
          drawErrors.push(`${up}#${i}: ${(e && e.message) || e}`);
        }
      }
    }
    check('(e) every upgrade screen draws with no exception, selected card included',
      drawErrors.length === 0, drawErrors.join(' | '));
  });
});

/* --------------------------------------------------------------------- */
/* The CROSS-FEATURE case: this round's combined bullet meeting the SHIELD
 * alien class that shipped two rounds ago. Scenario 25 (f) already pins a
 * PLAIN piercing shot through a redirect; scenario 29 pins the combined
 * bullet against an ordinary swarm. Neither covers the two together, and
 * that intersection is precisely what this round's "server/ needs no
 * anti-cheat re-derivation" claim rests on -- a redirect must not be a way
 * to buy an extra kill out of the 1 + PIERCE_COUNT budget. */
scenario('31. a combined shot through a SHIELD redirect spends exactly one pierce, ' +
         'flies on, and still cannot beat the kill ceiling', () => {
  withSeed(3101, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const U = C.UPGRADE;
    const R = C.ALIEN_CLASS.SHIELD.RADIUS;
    const SHIELD_WAVE = C.ALIEN_CLASS.SHIELD.FROM_WAVE;

    /* Wave 4 exactly as scenario 25 sets it up: the shield's own gate, one
     * wave BELOW the kamikaze's, so nothing is diving while this is
     * measured, and nothing but the scenario's own shot can kill. */
    const fresh = () => {
      const g = startedGame(env, SHIELD_WAVE);
      stillSwarm(g);
      g.player.invuln = 0;
      return g;
    };

    /* A combined PIERCE+BOUNCE bullet with exactly the fields
     * Player.fire() gives one -- scenario 29 (a) is what proves those are
     * the right fields, so this does not restate them as a second source of
     * truth, it reuses the same constants. */
    const launchCombined = (game, x, y, side) => {
      const b = new env.SI.Bullet(x, y, -U.BOUNCE_VY, 'player', C.COLORS.pierceBounce);
      b.vx = U.BOUNCE_VX * side;
      b.pierce = U.PIERCE_COUNT;
      b.bounce = U.BOUNCE_MAX;
      game.bullets.push(b);
      return b;
    };

    /* Spy on the ONE kill choke point, on the instance, so the real
     * prototype (and every other scenario) is untouched -- same idiom as
     * scenario 29 (b). collide() calls killAlien() BEFORE it decrements
     * pierce, so `pierceBefore` is genuinely the pre-kill budget. */
    const spyKills = (game, getBullet) => {
      const sw = game.swarm;
      const log = [];
      const real = sw.killAlien;
      sw.killAlien = function (a, world) {
        const b = getBullet();
        log.push({
          alien: a,
          pierceBefore: b ? b.pierce : -1,
          bounceBefore: b ? b.bounce : -1
        });
        return real.call(this, a, world);
      };
      return log;
    };

    /* (a) the redirect itself, one tick, from a standstill ---------------- */
    const g1 = fresh();
    const sw1 = g1.swarm;
    const shield = sw1.shield;
    const ally = coveredNeighbour(C, sw1);
    check('(a) wave 4 really has a shield with a live covered ally',
      !!shield && !!ally, `shield=${!!shield} ally=${!!ally}`);
    let b1 = null;
    const kills1 = spyKills(g1, () => b1);
    const alive1 = sw1.aliveCount();
    b1 = launchCombined(g1, ally.x, ally.y, 1);
    tick(env, g1);

    check('(a) the covered ally SURVIVED the combined shot', ally.alive === true);
    check('(a) the SHIELD is the one that died, not the targeted ally',
      shield.alive === false && kills1.length === 1 && kills1[0].alien === shield,
      `kills=${kills1.length} shieldAlive=${shield.alive} allyAlive=${ally.alive}`);
    check('(a) exactly one alien died -- the redirect did not resolve twice',
      alive1 - sw1.aliveCount() === 1, `died=${alive1 - sw1.aliveCount()}`);
    check('(a) the covered ally flashes so the player can see WHY it survived',
      ally.hitFlash > 0, `hitFlash=${ally.hitFlash}`);
    check(`(a) pierce decremented by EXACTLY 1 -- not 0, not 2 ` +
      `(${U.PIERCE_COUNT} -> ${U.PIERCE_COUNT - 1})`,
      kills1.length === 1 && kills1[0].pierceBefore === U.PIERCE_COUNT &&
      b1.pierce === U.PIERCE_COUNT - 1,
      `before=${kills1.length ? kills1[0].pierceBefore : '?'} after=${b1.pierce}`);
    check('(a) the redirect left the BOUNCE budget completely intact',
      b1.bounce === U.BOUNCE_MAX, `bounce=${b1.bounce} want=${U.BOUNCE_MAX}`);
    check('(a) the shot survived the redirect and flew on',
      b1.dead === false, `dead=${b1.dead}`);
    check('(a) still carrying its full horizontal velocity',
      Math.abs(b1.vx) === U.BOUNCE_VX, `vx=${b1.vx}`);

    /* (a2) ... and that is IDENTICAL to an unshielded combined hit -------- */
    const g2 = fresh();
    const sw2 = g2.swarm;
    const far = sw2.aliens.filter((a) => a.alive && !a.commander &&
      Math.abs(a.col - sw2.shield.col) > R)[0];
    check('(a2) an out-of-radius target exists to compare against', !!far,
      far ? `col=${far.col} shieldCol=${sw2.shield.col}` : 'none');
    let b2 = null;
    const kills2 = spyKills(g2, () => b2);
    b2 = launchCombined(g2, far.x, far.y, 1);
    tick(env, g2);
    check('(a2) an UNSHIELDED combined hit kills its actual target',
      kills2.length === 1 && kills2[0].alien === far && far.alive === false,
      `kills=${kills2.length} alive=${far.alive}`);
    check('(a2) and leaves pierce/bounce/dead in exactly the same state as the ' +
      'redirect did -- a redirect costs the shot nothing extra and nothing less',
      b2.pierce === b1.pierce && b2.bounce === b1.bounce && b2.dead === b1.dead,
      `unshielded p=${b2.pierce} b=${b2.bounce} dead=${b2.dead} vs ` +
      `redirect p=${b1.pierce} b=${b1.bounce} dead=${b1.dead}`);

    /* (b) the WHOLE flight: redirect, then a wall reflection, then a
     *     further kill -- all on one bullet, and never past the ceiling.
     *     Swept rather than hand-placed, because which alien the shield
     *     covers is wave-derived arithmetic and the swarm is marching: a
     *     single hardcoded launch would be pinning today's geometry, not
     *     the invariant. Every cell the shield covers x both launch sides
     *     x three lead times (how far below the target the shot starts). */
    const probe = fresh();
    const ps = probe.swarm.shield;
    const coveredCells = probe.swarm.aliens
      .filter((a) => a.alive && a !== ps &&
        Math.abs(a.col - ps.col) <= R && Math.abs(a.row - ps.row) <= R)
      .map((a) => ({ row: a.row, col: a.col }));
    check('(b) the shield covers at least one live ally to sweep',
      coveredCells.length > 0, `cells=${coveredCells.length}`);

    const flights = [];
    for (const cell of coveredCells) {
      for (const side of [-1, 1]) {
        for (const lead of [0, 0.12, 0.24]) {
          const g = fresh();
          const sw = g.swarm;
          const s = sw.shield;
          const target = sw.aliens.filter((a) =>
            a.alive && a.row === cell.row && a.col === cell.col)[0];
          if (!target) continue;
          let b = null;
          const log = spyKills(g, () => b);
          const aliveBefore = sw.aliveCount();
          b = launchCombined(g,
            target.x - side * U.BOUNCE_VX * lead,
            target.y + U.BOUNCE_VY * lead, side);
          let reflected = false;
          let reflections = 0;
          let killsAfterReflect = 0;
          for (let t = 0; t < 600 && !b.dead; t++) {
            const wasReflected = reflected;
            const bounceBefore = b.bounce;
            const killsBefore = log.length;
            tick(env, g);
            if (b.bounce < bounceBefore) {
              reflected = true;
              reflections += 1;
            }
            /* Conservative: a kill landing in the SAME tick as the
             * reflection is not counted as "after" it. */
            if (wasReflected) killsAfterReflect += log.length - killsBefore;
          }
          flights.push({
            cell, side, lead, log, bullet: b, target,
            /* A REDIRECT is: the first thing this bullet killed was the
             * shield, and the shield is not what it was aimed at. */
            redirected: log.length > 0 && log[0].alien === s && s !== target,
            reflections,
            killsAfterReflect,
            died: aliveBefore - sw.aliveCount()
          });
        }
      }
    }

    const redirects = flights.filter((f) => f.redirected);
    const full = redirects.filter((f) => f.reflections > 0 && f.killsAfterReflect > 0);
    const worst = flights.reduce((m, f) => Math.max(m, f.log.length), 0);
    console.log(`    shield+combined sweep: ${flights.length} flights, ` +
      `${redirects.length} opened with a redirect, ${full.length} went ` +
      `redirect -> wall -> further kill, worst kill count ${worst}`);

    check(`(b) the sweep ran (${flights.length} flights over ` +
      `${coveredCells.length} covered cells)`, flights.length > 0);
    check('(b) some flight really did open with a shield redirect -- not vacuous',
      redirects.length > 0, `redirects=${redirects.length}`);

    const badPierce = redirects.filter((f) =>
      f.log[0].pierceBefore !== U.PIERCE_COUNT ||
      f.bullet.pierce > U.PIERCE_COUNT - 1);
    check('(b) every redirect in the sweep opened on a full pierce budget and ' +
      'spent at least that one pierce -- none was free',
      badPierce.length === 0,
      badPierce.map((f) => `r${f.cell.row}c${f.cell.col}/${f.side}/${f.lead}:` +
        `${f.log[0].pierceBefore}`).join(' '));

    check('(b) at least one flight did all three on ONE bullet: redirected kill, ' +
      'then a wall reflection, then a further kill',
      full.length > 0,
      `redirects=${redirects.length} withReflect=` +
      `${redirects.filter((f) => f.reflections > 0).length} full=${full.length}`);
    if (full.length > 0) {
      const f = full[0];
      check('(b) that flight\'s first kill was the shield, and its later kills ' +
        'came after the ricochet',
        f.log[0].alien.role === 'shield' && f.killsAfterReflect >= 1,
        `role=${f.log[0].alien.role} after=${f.killsAfterReflect}`);
      check(`(b) and it STILL killed at most PIERCE_COUNT + 1 ` +
        `(${U.PIERCE_COUNT + 1}) -- kills=${f.log.length}`,
        f.log.length <= U.PIERCE_COUNT + 1);
    }

    const over = flights.filter((f) => f.log.length > U.PIERCE_COUNT + 1);
    check(`(b) across all ${flights.length} shield-redirect flights the worst ` +
      `kill count is ${worst} <= PIERCE_COUNT + 1 (${U.PIERCE_COUNT + 1}) -- a ` +
      'redirect buys no extra kill, so BEST_ALIENS_PER_SHOT still holds',
      over.length === 0,
      over.map((f) => `r${f.cell.row}c${f.cell.col}/${f.side}/${f.lead}:` +
        `${f.log.length}`).join(' '));
    check('(b) killAlien() count and aliens actually removed agree on every flight',
      flights.every((f) => f.log.length === f.died),
      flights.filter((f) => f.log.length !== f.died)
        .map((f) => `${f.log.length}!=${f.died}`).join(' '));
  });
});

/* --------------------------------------------------------------------- */
scenario('32. PINCER, INVERTED WEDGE and SWEEP formations deviate, hold, and return cleanly to grid', () => {
  withSeed(3232, () => {
    const env = loadGame(JS_DIR);
    const C = env.SI.CONFIG;
    const F = C.FORMATION;
    const game = startedGame(env, 5);
    quietSwarm(game);
    const sw = game.swarm;
    if (sw.kamikaze) sw.kamikaze.diveTimer = Infinity;
    sw.formationTimer = Infinity;

    /* (a) PINCER: flanks plunge forward and squeeze inward toward center */
    sw.snapToGrid();
    sw.formationTimer = Infinity;
    const pincer = sw.startFormation('pincer', game.world);
    check('pincer formation started', !!pincer && pincer.kind === 'pincer');

    let pincerHold = false;
    let pincerLeftDip = 0, pincerRightDip = 0, pincerMidDip = 0;
    let pincerLeftPinch = 0, pincerRightPinch = 0;
    for (let t = 0; t < 300 && sw.formation; t++) {
      tick(env, game);
      if (sw.formation && sw.formation.phase === 1 && !pincerHold) {
        pincerHold = true;
        for (const a of sw.aliens) {
          if (!a.alive) continue;
          if (a.col === 0 && a.row === 0) { pincerLeftDip = a.y - a.gy; pincerLeftPinch = a.x - a.gx; }
          if (a.col === 10 && a.row === 0) { pincerRightDip = a.y - a.gy; pincerRightPinch = a.x - a.gx; }
          if (a.col === 5 && a.row === 0) { pincerMidDip = a.y - a.gy; }
        }
      }
    }
    check('pincer reached HOLD phase', pincerHold);
    check('pincer left and right flanks dip ~PINCER_DEPTH',
      Math.abs(pincerLeftDip - F.PINCER_DEPTH) < 0.5 && Math.abs(pincerRightDip - F.PINCER_DEPTH) < 0.5,
      `left=${pincerLeftDip} right=${pincerRightDip}`);
    check('pincer center stays at grid height', Math.abs(pincerMidDip) < 0.5, `mid=${pincerMidDip}`);
    check('pincer left flank pinches rightward (positive shift)', pincerLeftPinch > 0, `leftShift=${pincerLeftPinch}`);
    check('pincer right flank pinches leftward (negative shift)', pincerRightPinch < 0, `rightShift=${pincerRightPinch}`);
    check('pincer finished and all aliens returned cleanly to grid',
      sw.formation === null && maxOffGrid(sw) === 0, `off=${maxOffGrid(sw)}`);

    /* (b) INVERTED WEDGE: outer wings advance forward in chevron, center holds back */
    sw.snapToGrid();
    sw.formationTimer = Infinity;
    const invWedge = sw.startFormation('inverted_wedge', game.world);
    check('inverted_wedge formation started', !!invWedge && invWedge.kind === 'inverted_wedge');

    let invHold = false;
    let invLeftDip = 0, invRightDip = 0, invMidDip = 0;
    let invLeftSpread = 0, invRightSpread = 0;
    for (let t = 0; t < 300 && sw.formation; t++) {
      tick(env, game);
      if (sw.formation && sw.formation.phase === 1 && !invHold) {
        invHold = true;
        for (const a of sw.aliens) {
          if (!a.alive) continue;
          if (a.col === 0 && a.row === 0) { invLeftDip = a.y - a.gy; invLeftSpread = a.x - a.gx; }
          if (a.col === 10 && a.row === 0) { invRightDip = a.y - a.gy; invRightSpread = a.x - a.gx; }
          if (a.col === 5 && a.row === 0) { invMidDip = a.y - a.gy; }
        }
      }
    }
    check('inverted_wedge reached HOLD phase', invHold);
    check('inverted_wedge outer wings dip ~INVERTED_WEDGE_DEPTH',
      Math.abs(invLeftDip - F.INVERTED_WEDGE_DEPTH) < 0.5 && Math.abs(invRightDip - F.INVERTED_WEDGE_DEPTH) < 0.5,
      `left=${invLeftDip} right=${invRightDip}`);
    check('inverted_wedge center column stays at grid height', Math.abs(invMidDip) < 0.5, `mid=${invMidDip}`);
    check('inverted_wedge wings spread outward', invLeftSpread < 0 && invRightSpread > 0,
      `left=${invLeftSpread} right=${invRightSpread}`);
    check('inverted_wedge completed and all aliens returned cleanly to grid',
      sw.formation === null && maxOffGrid(sw) === 0, `off=${maxOffGrid(sw)}`);

    /* (c) SWEEP: staggered diagonal wave step across columns */
    sw.snapToGrid();
    sw.formationTimer = Infinity;
    sw.formationCount = 0; // even count -> left-to-right sweep
    const sweep = sw.startFormation('sweep', game.world);
    check('sweep formation started', !!sweep && sweep.kind === 'sweep');

    let sweepHold = false;
    let sweepCol0Dip = 0, sweepCol10Dip = 0, sweepCol5Dip = 0;
    for (let t = 0; t < 300 && sw.formation; t++) {
      tick(env, game);
      if (sw.formation && sw.formation.phase === 1 && !sweepHold) {
        sweepHold = true;
        for (const a of sw.aliens) {
          if (!a.alive) continue;
          if (a.col === 0 && a.row === 0) { sweepCol0Dip = a.y - a.gy; }
          if (a.col === 5 && a.row === 0) { sweepCol5Dip = a.y - a.gy; }
          if (a.col === 10 && a.row === 0) { sweepCol10Dip = a.y - a.gy; }
        }
      }
    }
    check('sweep reached HOLD phase', sweepHold);
    check('sweep col 0 stays at 0 offset', Math.abs(sweepCol0Dip) < 0.5, `col0=${sweepCol0Dip}`);
    check('sweep col 10 dips to ~SWEEP_DEPTH', Math.abs(sweepCol10Dip - F.SWEEP_DEPTH) < 0.5, `col10=${sweepCol10Dip}`);
    check('sweep col 5 dips to intermediate depth (~SWEEP_DEPTH * 0.5)',
      Math.abs(sweepCol5Dip - F.SWEEP_DEPTH * 0.5) < 0.5, `col5=${sweepCol5Dip}`);
    check('sweep completed and returned cleanly to grid',
      sw.formation === null && maxOffGrid(sw) === 0, `off=${maxOffGrid(sw)}`);
  });
});

/* --------------------------------------------------------------------- */
scenario('33. progressive wave formation unlocking and deterministic sequencing', () => {
  withSeed(3333, () => {
    const env = loadGame(JS_DIR);

    /* (a) Unlocked pool tiers per wave */
    const sw1 = new env.SI.Swarm(1);
    const sw2 = new env.SI.Swarm(2);
    const sw3 = new env.SI.Swarm(3);
    const sw4 = new env.SI.Swarm(4);
    const sw5 = new env.SI.Swarm(5);
    const sw10 = new env.SI.Swarm(10);

    check('wave 1 unlocked formations is empty', sw1.unlockedFormations().length === 0);
    check('wave 2 unlocks [wedge, dive]',
      sw2.unlockedFormations().join(',') === 'wedge,dive', sw2.unlockedFormations().join(','));
    check('wave 3 unlocks [wedge, dive, pincer]',
      sw3.unlockedFormations().join(',') === 'wedge,dive,pincer', sw3.unlockedFormations().join(','));
    check('wave 4 unlocks [wedge, dive, pincer, inverted_wedge]',
      sw4.unlockedFormations().join(',') === 'wedge,dive,pincer,inverted_wedge', sw4.unlockedFormations().join(','));
    check('wave 5+ unlocks full pool [wedge, dive, pincer, inverted_wedge, sweep]',
      sw5.unlockedFormations().join(',') === 'wedge,dive,pincer,inverted_wedge,sweep', sw5.unlockedFormations().join(','));
    check('wave 10 keeps full pool',
      sw10.unlockedFormations().join(',') === 'wedge,dive,pincer,inverted_wedge,sweep', sw10.unlockedFormations().join(','));

    /* (b) Deterministic uncommanded rotation on wave 3 */
    const game3 = startedGame(env, 3);
    quietSwarm(game3);
    const s3 = game3.swarm;
    s3.commander = null; // test pure uncommanded wave progression
    const seq3 = [];
    for (let i = 0; i < 6; i++) {
      s3.snapToGrid();
      const f = s3.startFormation(null, game3.world);
      if (f) seq3.push(f.kind);
    }
    check('uncommanded wave 3 rotates wedge -> dive -> pincer deterministically',
      seq3.join(',') === 'wedge,dive,pincer,wedge,dive,pincer', seq3.join(','));

    /* (c) Deterministic uncommanded rotation on wave 5 */
    const game5 = startedGame(env, 5);
    quietSwarm(game5);
    const s5 = game5.swarm;
    s5.commander = null;
    const seq5 = [];
    for (let i = 0; i < 10; i++) {
      s5.snapToGrid();
      const f = s5.startFormation(null, game5.world);
      if (f) seq5.push(f.kind);
    }
    check('uncommanded wave 5 rotates all 5 shapes across 10 formations',
      seq5.join(',') === 'wedge,dive,pincer,inverted_wedge,sweep,wedge,dive,pincer,inverted_wedge,sweep',
      seq5.join(','));
  });
});

/* --------------------------------------------------------------------- */
scenario('34. wave frequency and animation speed scale smoothly with higher waves', () => {
  withSeed(3434, () => {
    const env = loadGame(JS_DIR);

    /* (a) Gap scaling ramp */
    const gapScales = [];
    for (let w = 1; w <= 12; w++) {
      const sw = new env.SI.Swarm(w);
      gapScales.push({ wave: w, scale: sw.waveGapScale() });
    }
    check('wave 1 and 2 gap scale is 1.0 (unscaled baseline)',
      gapScales[0].scale === 1 && gapScales[1].scale === 1,
      `w1=${gapScales[0].scale} w2=${gapScales[1].scale}`);
    check('wave 3 gap scale is 0.9375',
      Math.abs(gapScales[2].scale - 0.9375) < 1e-6, `w3=${gapScales[2].scale}`);
    check('wave 10 gap scale clamps to 0.50 (50% interval)',
      Math.abs(gapScales[9].scale - 0.50) < 1e-6, `w10=${gapScales[9].scale}`);
    check('wave 12 stays clamped at 0.50',
      Math.abs(gapScales[11].scale - 0.50) < 1e-6, `w12=${gapScales[11].scale}`);

    /* (b) Animation speed scaling ramp */
    const speedScales = [];
    for (let w = 1; w <= 12; w++) {
      const sw = new env.SI.Swarm(w);
      speedScales.push({ wave: w, scale: sw.waveSpeedScale() });
    }
    check('wave 1 and 2 animation speed scale is 1.0',
      speedScales[0].scale === 1 && speedScales[1].scale === 1,
      `w1=${speedScales[0].scale} w2=${speedScales[1].scale}`);
    check('wave 10 animation speed scale clamps to 0.80 (20% faster transitions)',
      Math.abs(speedScales[9].scale - 0.80) < 1e-6, `w10=${speedScales[9].scale}`);

    /* (c) Measurable difference in formation gap under identical seed */
    const SEED = 8888;
    const sw2 = new env.SI.Swarm(2);
    const sw10 = new env.SI.Swarm(10);
    sw10.commander = null; // compare uncommanded wave scaling
    const gapW2 = withSeed(SEED, () => sw2.nextFormationGap());
    const gapW10 = withSeed(SEED, () => sw10.nextFormationGap());
    check('wave 10 formation gap is strictly half of wave 2 gap under identical seed',
      Math.abs(gapW10 - gapW2 * 0.5) < 1e-6, `w2=${gapW2} w10=${gapW10}`);
  });
});

/* ------------------------------ summary -------------------------------- */

if (baselineDir) {
  try { fs.rmSync(baselineDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log('\n---------------- scenario summary ----------------');
for (const r of scenarioResults) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
}
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILING`);
  process.exit(1);
}
console.log('check-game.js: all scenarios green');
