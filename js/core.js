/* core.js -- namespace bootstrap, configuration and math helpers. */
(function (SI) {
  'use strict';

  var CONFIG = {
    // Shown on the title screen (js/hud.js drawTitle) and read by
    // scripts/verify.sh to cross-check package.json's version stays in
    // sync. Bump the MINOR number (1.3.0 -> 1.4.0) in both places together
    // for every new feature; patch/major are unused by this policy.
    VERSION: '1.8.0',

    WORLD_W: 960,
    WORLD_H: 720,
    MAX_DT: 1 / 30,
    MAX_DPR: 2,

    PLAYER: {
      W: 52,
      H: 26,
      SPEED: 420,
      Y: 648,
      FIRE_COOLDOWN: 0.28,
      RESPAWN_TIME: 1.6,
      INVULN_TIME: 2.2,
      START_LIVES: 3
    },

    BULLET: {
      PLAYER_SPEED: 720,
      PLAYER_W: 4,
      PLAYER_H: 16,
      ALIEN_SPEED: 300,
      ALIEN_W: 6,
      ALIEN_H: 16
    },

    SWARM: {
      COLS: 11,
      ROWS: 5,
      CELL_W: 62,
      CELL_H: 50,
      ALIEN_W: 40,
      ALIEN_H: 28,
      ORIGIN_X: 96,
      ORIGIN_Y: 130,
      MARGIN: 26,
      DESCEND: 26,
      FLOOR_Y: 610
    },

    UFO: {
      W: 62,
      H: 24,
      Y: 84,
      SPEED: 170,
      MIN_DELAY: 14,
      MAX_DELAY: 26,
      SCORES: [50, 100, 150, 200, 300]
    },

    BUNKER: {
      COUNT: 4,
      COLS: 12,
      ROWS: 8,
      CELL: 7,
      Y: 546
    },

    SCORE: {
      ROW: [30, 20, 20, 10, 10]
    },

    // Difficulty ramp per wave (index 0 == wave 1). Values are clamped
    // to the last entry so late waves stay hard but finite.
    WAVES: [
      { speed: 26, fire: 1.15, bulletSpeed: 300, startY: 130, maxAlienBullets: 3 },
      { speed: 32, fire: 0.95, bulletSpeed: 320, startY: 140, maxAlienBullets: 4 },
      { speed: 38, fire: 0.82, bulletSpeed: 335, startY: 150, maxAlienBullets: 4 },
      { speed: 45, fire: 0.72, bulletSpeed: 350, startY: 160, maxAlienBullets: 5 },
      { speed: 52, fire: 0.63, bulletSpeed: 365, startY: 170, maxAlienBullets: 5 },
      { speed: 60, fire: 0.55, bulletSpeed: 380, startY: 178, maxAlienBullets: 6 },
      { speed: 68, fire: 0.48, bulletSpeed: 395, startY: 186, maxAlienBullets: 6 },
      { speed: 76, fire: 0.43, bulletSpeed: 410, startY: 192, maxAlienBullets: 7 },
      { speed: 84, fire: 0.39, bulletSpeed: 420, startY: 196, maxAlienBullets: 7 },
      { speed: 92, fire: 0.36, bulletSpeed: 430, startY: 200, maxAlienBullets: 8 }
    ],

    // Evolving swarm choreography. A formation only ever writes the
    // per-alien OFFSET (fx/fy); the grid anchor (gx/gy) keeps marching
    // under the untouched classic rules, so a formation can neither
    // advance nor delay the invasion floor.
    FORMATION: {
      FROM_WAVE: 2,     // wave 1 stays the plain classic swarm
      FIRST_DELAY: 6,   // seconds before the first formation of a wave
      MIN_GAP: 7,
      MAX_GAP: 12,
      EASE_IN: 1.1,
      HOLD: 1.4,
      EASE_OUT: 1.1,
      MIN_ALIVE: 6,     // too few aliens left -> no formation, it looks silly
      WEDGE_DEPTH: 78,  // how far the centre column dips in a wedge
      WEDGE_PINCH: 9,   // horizontal squeeze per column away from centre
      DIVE_DEPTH: 150,
      PINCER_DEPTH: 70, // how far outer wings plunge forward in pincer
      PINCER_PINCH: 12, // horizontal squeeze inward for outer wings
      INVERTED_WEDGE_DEPTH: 75, // how far outer wings dip in inverted wedge
      SWEEP_DEPTH: 80,  // how far diagonal wave dips
      EDGE_PAD: 46      // effective x is clamped into [PAD, WORLD_W - PAD]
    },

    // One commander per wave from FROM_WAVE up. Killing it cancels the
    // formation in flight and grounds the swarm for the rest of the wave.
    //
    // Which PERSONALITY that commander has is WAVE-DERIVED --
    // PERSONALITIES[(wave - FROM_WAVE) % PERSONALITIES.length]. The PICK
    // itself is therefore not a Math.random() draw, and it is made after the
    // one existing randInt() that chooses WHICH row-0 alien is the commander,
    // so it cannot reorder that draw either.
    //
    // What that does and does NOT guarantee about the random stream:
    //   * Waves BELOW FROM_WAVE are completely unaffected -- personality
    //     stays null there. That is what keeps the wave-1 golden checksum in
    //     scripts/check-game.js exactly pinned.
    //   * From FROM_WAVE up the effects below DO intentionally change how
    //     many draws a wave consumes relative to an uncommanded wave. `kinds`
    //     is the clearest case: startFormation's 'dive' branch spends one
    //     SI.pick(cols) draw and its other branches spend none, so a
    //     dive-containing commander draws more per dive formation.
    //     `extraBullets` likewise un-short-circuits the
    //     `alienBulletCount() < cap && SI.chance(0.86)` test, letting
    //     SI.chance() run on ticks where it previously could not. That is
    //     expected, not a bug -- different behaviour is the whole point.
    //     Do not read any stream-invariance claim into these waves.
    //
    // Every field multiplies or selects on a hook that already existed:
    //   gapScale      scales the gap between formations (SI.rand(MIN_GAP,
    //                 MAX_GAP) is still ONE draw, just scaled afterwards).
    //                 It scales only the VARIABLE part of a wave's first
    //                 delay -- FORMATION.FIRST_DELAY is a documented grace
    //                 period and stays intact for every personality.
    //   kinds         replaces the default wave formation repertoire;
    //                 an explicitly-passed kind still wins outright
    //   fireScale     scales the already-computed alien fire delay, before
    //                 the existing Math.max(0.16, ...) clamp
    //   extraBullets  raises the simultaneous alien-bullet cap, but never
    //                 past MAX_ALIEN_BULLETS (the WAVES table's own ceiling)
    // All of them are read through Swarm.activePersonality(), which returns
    // null the moment the commander dies -- so the effects lapse instantly
    // with no death-path code of their own.
    COMMANDER: {
      FROM_WAVE: 3,
      SCORE_BONUS: 150,
      // Colours are the personality's visual tell (halo + crown crest), so
      // each has to read as clearly NOT the plain commander amber
      // (COLORS.commander) as well as clearly not each other: warm orange,
      // ice cyan, hot crimson. check-game.js scenario 18 enforces a minimum
      // channel distance against COLORS.commander and COLORS.warn.
      PERSONALITIES: [
        { id: 'aggressive', name: 'AGGRESSOR', color: '#ff7a5c',
          kinds: ['dive', 'pincer', 'dive'], gapScale: 0.75, fireScale: 0.92, extraBullets: 0 },
        { id: 'tactical', name: 'TACTICIAN', color: '#7ce8ff',
          kinds: ['wedge', 'pincer', 'inverted_wedge', 'sweep'], gapScale: 0.55, fireScale: 1, extraBullets: 0 },
        { id: 'barrage', name: 'BARRAGE', color: '#ff2d55',
          kinds: ['wedge', 'inverted_wedge'], gapScale: 1.35, fireScale: 0.7, extraBullets: 1 }
      ]
    },

    // Between-wave cannon upgrade. Exactly one is active at a time: a new
    // pick REPLACES the previous one, it never stacks.
    UPGRADE: {
      IDS: ['spread', 'pierce', 'bounce', 'shield'],
      // The shipped WEAPON COMBINATIONS. Deliberately NOT in IDS: IDS is
      // the unconditional 4-card pool, and combination options appear only when
      // the active cannon is one half of it. Game.upgradeChoices() swaps the
      // COMPLEMENTARY card for the combine id -- it never adds a 5th card, because
      // 5 * CARD.W + 4 * CARD.GAP = 5 * 196 + 4 * 18 = 1052 > WORLD_W (960).
      // See js/hud.js's CARD table and upgradeCardRect().
      COMBINED_ID: 'pierce_bounce',
      COMBINED_IDS: ['pierce_bounce', 'spread_bounce'],
      COMBINES: {
        pierce: { bounce: 'pierce_bounce' },
        spread: { bounce: 'spread_bounce' },
        bounce: { pierce: 'pierce_bounce', spread: 'spread_bounce' }
      },
      PICK_TIMEOUT: 12,   // auto-confirm so an idle session never hangs
      // Two independent gates guard the pick (see game.js): the confirm
      // binding must be RELEASED once after the screen opens, and this many
      // seconds must pass. The release gate alone loses to a player mashing
      // fire; the dwell alone loses to one who waits and then mashes. 1.0s is
      // long enough to read four cards, short enough not to feel like a stall.
      MIN_DWELL: 1,
      SPREAD_ANGLE: 0.2,  // radians, applied as -a / 0 / +a
      PIERCE_COUNT: 2,    // extra aliens a laser survives after the first
      // Bounce tuning. A shot spawns at y = PLAYER.Y - PLAYER.H/2 - 6 = 629
      // and dies at y < -40, so it lives 669 / BOUNCE_VY seconds; in that time
      // it covers 669 * BOUNCE_VX / BOUNCE_VY world units horizontally.
      BOUNCE_MAX: 2,      // wall reflections before the shot expires
      BOUNCE_VX: 560,
      BOUNCE_VY: 360,     // slower climb than BULLET.PLAYER_SPEED, on purpose
      SHIELD_TIME: 6
    },

    // Kill-streak score multiplier. Consecutive kills raise a multiplier that
    // scales what the NEXT kill pays; it lapses if you stop killing, and drops
    // outright if you are hit or the wave ends. Pure arithmetic on the existing
    // addScore() path: no new entity, no timer of its own beyond one float, and
    // not a single Math.random() draw.
    COMBO: {
      FROM_WAVE: 2,
      WINDOW: 2.6,   // seconds since the last kill before the streak lapses
      STEP: 4,       // kills per multiplier step
      MAX: 4         // ceiling: x4
    },

    // Distinct alien classes. Exactly one SHIELD, one KAMIKAZE, and one PHASE
    // per wave from their own FROM_WAVE gates up, and WHICH alien carries each
    // is WAVE-DERIVED arithmetic -- (wave - FROM_WAVE) % SWARM.COLS.
    ALIEN_CLASS: {
      SHIELD: {
        FROM_WAVE: 4,
        ROW: 2,       // middle row -- a full 3x3 cover block exists around it
        RADIUS: 1,    // Chebyshev distance in GRID cells (col/row), not pixels
        FLASH: 0.14   // seconds the covered alien flashes when a hit is eaten
      },
      KAMIKAZE: {
        FROM_WAVE: 5,
        FIRST_DELAY: 8,  // seconds of wave time before it commits
        SPEED_Y: 260,    // < BULLET.ALIEN_SPEED (300): the dive is dodgeable
        SPEED_X: 170     // steering cap, < PLAYER.SPEED (420): strafing out-runs it
      },
      PHASE: {
        FROM_WAVE: 6,
        ROW: 1,          // upper-middle row
        ACTIVE_TIME: 2.8,
        PHASE_TIME: 1.5,
        FLICKER_SPEED: 16
      }
    },

    // Intelligent Frenzy & Predatory Eagle Swoop Attacks.
    // When few aliens remain on Wave 2+, the survivors become highly
    // intelligent and aggressive: they undulate up and down dynamically,
    // fire with predictive aim, and launch predatory eagle swoop attacks.
    // The activation threshold starts at 5 surviving aliens on Wave 2 (after
    // 1 completed wave) and increases by +1 for every completed wave.
    FRENZY: {
      FROM_WAVE: 2,       // Wave 1 stays 100% classic Space Invaders
      BASE_THRESHOLD: 5,  // Base survival threshold on Wave 2 (1 completed wave)
      THRESHOLD: 5,       // Legacy alias for base threshold
      SCALE_PER_WAVE: 1,  // Threshold increases by +1 for every completed wave
      MAX_THRESHOLD: 18,  // Upper safety clamp
      WAVE_AMP: 18,       // Vertical sinusoidal up/down weave amplitude (pixels)
      WAVE_FREQ: 3.4,     // Vertical weave frequency
      SWOOP_SPEED: 280,   // Eagle swoop dive speed
      SWOOP_MIN_GAP: 3.5, // Seconds between eagle swoop attacks
      SWOOP_MAX_GAP: 6.0,
      SWOOP_DURATION: 2.2,// Duration of full eagle swoop loop
      AIM_BIAS: 0.70      // Probability shooter prioritizes column closest to playerX
    },

    COLORS: {
      player: '#5ffbf1',
      playerGlow: '#1ce8ff',
      bullet: '#e9fdff',
      alienBullet: '#ff5bb0',
      hud: '#9df3ff',
      accent: '#ff56d5',
      warn: '#ffd166',
      bunker: '#54ffa8',
      ufo: '#ffb0f7',
      commander: '#ffe066',
      // Class tells.
      shieldAlien: '#3d5bff',
      kamikaze: '#ff4d00',
      phaseAlien: '#d066ff',
      // Fused weapon tells.
      pierceBounce: '#b6ff4d',
      spreadBounce: '#ffaa40',
      spreadShield: '#38ef7d',
      alienRows: ['#ff6ad5', '#c774f7', '#8a7bff', '#5ad2ff', '#63ffc9']
    },

    // Milestone Boss Encounters. Replaces the 11x5 swarm on milestone waves
    // (waves 7, 14, 21...). Boss has multi-phase mechanics, animated twin/burst
    // cannons, hitFlash, and dedicated HUD boss health bar.
    BOSS: {
      WAVES: [7, 14, 21],
      W: 130,
      H: 52,
      Y: 155,
      MARGIN: 80,
      CONFIGS: {
        7: {
          name: 'VANGUARD MOTHERSHIP',
          hp: 35,
          score: 1000,
          speed: 105,
          fireRate: 0.95,
          bulletSpeed: 330,
          color: '#ff2d55',
          coreColor: '#ffd166'
        },
        14: {
          name: 'DREADNOUGHT SOVEREIGN',
          hp: 70,
          score: 2500,
          speed: 135,
          fireRate: 0.70,
          bulletSpeed: 380,
          color: '#ff007f',
          coreColor: '#5ffbf1'
        },
        21: {
          name: 'HIVE NEXUS',
          hp: 120,
          score: 5000,
          speed: 120,
          fireRate: 0.55,
          bulletSpeed: 420,
          color: '#00f5d4',
          coreColor: '#ff007f'
        }
      }
    },

    // Secondary EMP Super Bomb ability. Fills from 0 to 100% via kills,
    // combos, commanders, UFOs and boss combat. Unleashed via KeyX / Shift /
    // Gamepad LT/B/Y. Clears enemy bullets, damages enemies, triggers haptic
    // rumble and shockwave ring.
    EMP: {
      MAX: 100,
      INITIAL: 0,
      GAIN_KILL: 2.0,
      GAIN_COMMANDER: 15.0,
      GAIN_SHIELD: 8.0,
      GAIN_KAMIKAZE: 6.0,
      GAIN_UFO: 20.0,
      GAIN_BOSS_HIT: 1.5,
      GAIN_BOSS_KILL: 35.0,
      DAMAGE_BOSS: 12,
      COLOR: '#5ffbf1',
      COLOR_READY: '#ffd166'
    },

    // Persistent offline achievements (saved in localStorage).
    ACHIEVEMENTS: {
      FIRST_BLOOD: { id: 'first_blood', name: 'FIRST CONTACT', desc: 'Clear Wave 1', icon: '1', color: '#00f5d4' },
      COMBO_MASTER: { id: 'combo_master', name: 'COMBO KING', desc: 'Reach COMBO x4 multiplier', icon: 'x4', color: '#ff2a6d' },
      COMMANDER_SLAYER: { id: 'commander_slayer', name: 'DECAPITATION', desc: 'Defeat a Swarm Commander', icon: '★', color: '#ffd166' },
      MOTHERSHIP_DOWN: { id: 'mothership_down', name: 'TITAN SLAYER', desc: 'Defeat Vanguard Mothership', icon: 'M', color: '#ff2d55' },
      SOVEREIGN_FALL: { id: 'sovereign_fall', name: 'APEX PREDATOR', desc: 'Defeat Dreadnought Sovereign', icon: 'Ω', color: '#5ffbf1' },
      EMP_BLAST: { id: 'emp_blast', name: 'OVERCLOCKED', desc: 'Unleash full EMP Super Bomb', icon: '⚡', color: '#5ffbf1' },
      WEAPON_FUSED: { id: 'weapon_fused', name: 'FUSION MASTER', desc: 'Equip any fused Weapon Combo', icon: '⚛', color: '#a8ff78' },
      SHARPSHOOTER: { id: 'sharpshooter', name: 'DEADEYE', desc: 'Destroy an enemy projectile', icon: '⌖', color: '#38ef7d' },
      BUNKER_GUARDIAN: { id: 'bunker_guardian', name: 'IRON BASTION', desc: 'Clear wave with 4 bunkers intact', icon: '🛡', color: '#05d9e8' },
      HIGH_ROLLER: { id: 'high_roller', name: 'SCORE LEGEND', desc: 'Achieve 20,000+ points', icon: '👑', color: '#ffd166' }
    }
  };

  // Hard ceiling on a formation's effective y -- and y is an alien's CENTRE,
  // so the half-height has to be part of the derivation. collide() starts
  // grinding bunkers once an alien's BOTTOM edge (y + ALIEN_H / 2) reaches
  // BUNKER.Y - 4, i.e. once its centre reaches
  //   546 - 4 - 28/2 = 528.
  // The extra 12 is margin, giving 516: choreography can reach neither the
  // bunkers nor the invasion line at SWARM.FLOOR_Y (610).
  CONFIG.FORMATION.MAX_Y =
    CONFIG.BUNKER.Y - 4 - CONFIG.SWARM.ALIEN_H / 2 - 12;

  // How deep a diving kamikaze may go before it crashes. Deliberately NOT
  // derived the way FORMATION.MAX_Y is: that one comes from the BUNKERS
  // (choreography must never reach them), this one comes from the SHIP,
  // because reaching the ship is the whole point of a rammer.
  //
  // It must sit STRICTLY BELOW the ship's contact window, because the crash
  // test runs inside Swarm.update() -- BEFORE game.js's contact test in the
  // same tick. If the two overlapped, a diver whose final integration step
  // landed inside the overlap would self-destruct on the very tick it should
  // have registered a ram, silently voiding the hit.
  //   ship box (player.box) spans y 635 .. 661 = PLAYER.Y -+ PLAYER.H / 2
  //   an alien box spans y -+ ALIEN_H / 2 = 14, so the boxes overlap for an
  //   alien centre-y in the OPEN interval (621, 675)
  //   this floor = PLAYER.Y + PLAYER.H / 2 + ALIEN_H / 2 + 2 = 677
  // 677 >= 675, so reaching the floor means the contact window is already
  // behind the diver -- no tick can be both a crash and a missed ram. And
  // the window is 54 units deep while one step at MAX_DT is only
  // SPEED_Y / 30 = 8.67 units, so a diver always spends several whole ticks
  // inside it; it can never step over the window in one frame. (check-
  // game.js scenario 26 pins both halves, so retuning SPEED_Y or the ship
  // fails loudly.) Its bottom edge at crash, 677 + 14 = 691, is still inside
  // the 720-unit world -- the crash always happens on screen.
  CONFIG.ALIEN_CLASS.KAMIKAZE.FLOOR_Y =
    CONFIG.PLAYER.Y + CONFIG.PLAYER.H / 2 + CONFIG.SWARM.ALIEN_H / 2 + 2;

  // The WAVES table's own ceiling on simultaneous alien bullets. The table
  // stops ramping at wave 10 on purpose -- late waves stay hard without
  // becoming unfair -- so a commander personality's extraBullets may raise
  // the cap toward this number but must never push past it. On waves that are
  // already at the ceiling extraBullets is therefore a no-op, which is the
  // intent: the ceiling is absolute, not per-wave advice.
  CONFIG.COMMANDER.MAX_ALIEN_BULLETS = (function () {
    var m = 0;
    for (var i = 0; i < CONFIG.WAVES.length; i++) {
      m = Math.max(m, CONFIG.WAVES[i].maxAlienBullets);
    }
    return m;
  })();

  // Wave tuning lookup with a sane cap on difficulty.
  function waveConfig(wave) {
    var table = CONFIG.WAVES;
    var i = Math.min(Math.max(wave, 1), table.length) - 1;
    return table[i];
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Hermite ease, 0..1 -> 0..1 with zero slope at both ends.
  function smoothstep(t) {
    var x = t < 0 ? 0 : (t > 1 ? 1 : t);
    return x * x * (3 - 2 * x);
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function randInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function chance(p) {
    return Math.random() < p;
  }

  // Axis-aligned bounding-box overlap. Boxes are {x, y, w, h} with x/y
  // as the top-left corner in world units.
  function aabb(a, b) {
    return a.x < b.x + b.w &&
           a.x + a.w > b.x &&
           a.y < b.y + b.h &&
           a.y + a.h > b.y;
  }

  function boxFor(cx, cy, w, h) {
    return { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
  }

  // Removes array entries whose `dead` flag is set, in place.
  function compact(list) {
    var w = 0;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].dead) {
        list[w++] = list[i];
      }
    }
    list.length = w;
    return list;
  }

  function formatScore(n) {
    var s = String(Math.max(0, Math.floor(n)));
    while (s.length < 5) {
      s = '0' + s;
    }
    return s;
  }

  function isBossWave(wave) {
    return wave === 7 || wave === 14 || wave === 21 || (wave > 21 && wave % 7 === 0);
  }

  function getCombinedUpgrade(current, candidate) {
    if (!current || !candidate) { return null; }
    var key = current + '+' + candidate;
    return CONFIG.UPGRADE.COMBINED_MAP[key] || null;
  }

  var ACHIEVEMENTS_KEY = 'neon-invaders-achievements';
  var unlockedAchievements = null;

  function loadAchievements() {
    if (unlockedAchievements) { return unlockedAchievements; }
    unlockedAchievements = {};
    if (typeof localStorage !== 'undefined') {
      try {
        var raw = localStorage.getItem(ACHIEVEMENTS_KEY);
        if (raw) {
          unlockedAchievements = JSON.parse(raw) || {};
        }
      } catch (e) {
        unlockedAchievements = {};
      }
    }
    return unlockedAchievements;
  }

  function saveAchievements() {
    if (typeof localStorage !== 'undefined' && unlockedAchievements) {
      try {
        localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(unlockedAchievements));
      } catch (e) { /* ignore */ }
    }
  }

  function isAchievementUnlocked(id) {
    var map = loadAchievements();
    return !!map[id];
  }

  function unlockAchievement(id) {
    var map = loadAchievements();
    if (map[id]) { return false; }
    map[id] = { unlockedAt: new Date().toISOString() };
    saveAchievements();
    return true;
  }

  function getUnlockedCount() {
    var map = loadAchievements();
    return Object.keys(map).length;
  }

  function resetAchievements() {
    unlockedAchievements = {};
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(ACHIEVEMENTS_KEY);
      } catch (e) { /* ignore */ }
    }
  }

  SI.Achievements = {
    load: loadAchievements,
    save: saveAchievements,
    isUnlocked: isAchievementUnlocked,
    unlock: unlockAchievement,
    count: getUnlockedCount,
    reset: resetAchievements
  };

  SI.CONFIG = CONFIG;
  SI.waveConfig = waveConfig;
  SI.isBossWave = isBossWave;
  SI.getCombinedUpgrade = getCombinedUpgrade;
  SI.clamp = clamp;
  SI.lerp = lerp;
  SI.smoothstep = smoothstep;
  SI.rand = rand;
  SI.randInt = randInt;
  SI.pick = pick;
  SI.chance = chance;
  SI.aabb = aabb;
  SI.boxFor = boxFor;
  SI.compact = compact;
  SI.formatScore = formatScore;
})(window.SI = window.SI || {});
