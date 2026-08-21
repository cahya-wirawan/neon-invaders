/* core.js -- namespace bootstrap, configuration and math helpers. */
(function (SI) {
  'use strict';

  var CONFIG = {
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
      alienRows: ['#ff6ad5', '#c774f7', '#8a7bff', '#5ad2ff', '#63ffc9']
    }
  };

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

  SI.CONFIG = CONFIG;
  SI.waveConfig = waveConfig;
  SI.clamp = clamp;
  SI.lerp = lerp;
  SI.rand = rand;
  SI.randInt = randInt;
  SI.pick = pick;
  SI.chance = chance;
  SI.aabb = aabb;
  SI.boxFor = boxFor;
  SI.compact = compact;
  SI.formatScore = formatScore;
})(window.SI = window.SI || {});
