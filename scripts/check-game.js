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
        if (!a.alive) continue;
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
    const SEQ_N = 6;
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
    check('the no-personality baseline still alternates wedge/dive by parity',
      baseSeq.join(',') === 'wedge,dive,wedge,dive,wedge,dive', baseSeq.join(','));
    check('the wave-3 (dive-only) commander never choreographs a wedge',
      aggressive.size === 1 && aggressive.has('dive'), [...aggressive].join(','));
    check('the wave-5 (wedge-only) commander never choreographs a dive',
      barrage.size === 1 && barrage.has('wedge'), [...barrage].join(','));
    check('the wave-4 commander still uses BOTH kinds across enough draws',
      tactical.size === 2 && tactical.has('wedge') && tactical.has('dive'),
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

      /* And so must the formation gap, even though nothing can use it now.
       * plainGap is built OUTSIDE its seeded region on purpose: a Swarm
       * constructor draws for fireTimer, which would otherwise shift which
       * value nextFormationGap() lands on. */
      const gapAfter = withSeed(GAP_SEED, () => sw.nextFormationGap());
      check(`wave ${wave}: the formation gap drops back to the unscaled value`,
        gapAfter === plainGap, `${gapAfter} vs ${plainGap}`);
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
