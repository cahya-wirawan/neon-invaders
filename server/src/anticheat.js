/* anticheat.js -- server-side PLAUSIBILITY BOUNDS on a submitted score.
 *
 * THIS IS NOT A REPLAY ENGINE and it cannot prove a run happened. It answers
 * exactly one question: "could a human physically have produced this claim in
 * the wall-clock time this server measured?" Everything it can catch is a
 * claim that is impossible; everything merely improbable gets through.
 *
 * The two bounds are deliberately independent, so a rejection names which
 * physical limit was broken:
 *
 * BOUND 1 -- minimum elapsed time for the claimed wave.
 *   Constants are the real ones from js/core.js / js/game.js:
 *     SWARM.COLS 11 x SWARM.ROWS 5      = 55 aliens that must each be shot
 *     PLAYER.FIRE_COOLDOWN              = 0.28 s between shots
 *     WAVE_CLEAR intermission (game.js) = 2.4 s
 *   so one wave cannot take less than 55 * 0.28 + 2.4 = 17.8 s even for a
 *   player who never misses and whose bullets travel instantly. Reaching wave
 *   W means clearing W-1 waves, hence:
 *
 *     minElapsedSecondsForWave(W) = (W - 1) * 17.8 * SCALE
 *
 *   SCALE (default 0.5) is pure safety margin against everything the model
 *   ignores -- a slower machine's clock, a paused tab, a player who reached
 *   wave W by dying on it rather than clearing it. At the default that is
 *   8.9 s per wave, about half of what the game can actually do. Wave 1 has a
 *   bound of ZERO by construction: nothing has to be cleared to be on wave 1,
 *   so the rate ceiling below is the only guard there.
 *
 * BOUND 2 -- maximum score per second of play.
 *   Best sustainable alien rate: SCORE.ROW max 30 points / 0.28 s = ~107/s.
 *   Best UFO rate: UFO.SCORES max 300 / UFO.MIN_DELAY 14 s = ~21/s.
 *   Together ~128/s, ~136/s once the +5 bullet-shootdown bonus is allowed for.
 *   The default ceiling is 200/s -- deliberate headroom, because being wrong
 *   here rejects a legitimate player's best-ever run.
 *
 *     maxScoreFor(elapsed) = CEILING * (elapsed + GRACE)
 *
 *   GRACE (default 5 s) keeps a very short run from having an absurdly tight
 *   ceiling: without it a 0.4 s run would be capped at 80 points.
 *
 * KNOWN LIMITS (also in server/README.md, in more detail):
 *   - FALSE NEGATIVE: a patient cheater who calls /api/runs/start, waits, and
 *     then submits a fabricated score satisfies both bounds trivially. This
 *     raises the cost of cheating from "one curl" to "one curl and a timer".
 *     That is the honest ceiling of a non-replay design.
 *   - FALSE POSITIVE: a genuinely exceptional player is only rejected if they
 *     beat the physical limits above, which the SCALE and headroom make very
 *     unlikely -- but the tradeoff is real and the bounds are env-tunable for
 *     exactly that reason.
 */
'use strict';

/* --- constants mirrored from the game, with their source noted --------- */
const ALIENS_PER_WAVE = 55;          // js/core.js SWARM.COLS(11) * SWARM.ROWS(5)
const FIRE_COOLDOWN_SECONDS = 0.28;  // js/core.js PLAYER.FIRE_COOLDOWN
const WAVE_CLEAR_SECONDS = 2.4;      // js/game.js STATE.WAVE_CLEAR intermission

/* 55 * 0.28 + 2.4 = 17.8 */
const SECONDS_PER_WAVE_FLOOR =
  ALIENS_PER_WAVE * FIRE_COOLDOWN_SECONDS + WAVE_CLEAR_SECONDS;

const DEFAULTS = {
  ttlMs: 6 * 60 * 60 * 1000,     // 6 hours
  minSecondsPerWaveScale: 0.5,
  maxScorePerSecond: 200,
  scoreGraceSeconds: 5,
  runStartMax: 60,
  runStartWindowMs: 15 * 60 * 1000
};

function pickNumber(optionValue, envValue, fallback, allowZero) {
  const candidates = [optionValue, envValue];
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === '') {
      continue;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && (n > 0 || (allowZero && n >= 0))) {
      return n;
    }
  }
  return fallback;
}

/* (W - 1) * 17.8 * scale, floored at 0. */
function minElapsedSecondsForWave(wave, scale) {
  const w = Number(wave);
  const s = Number.isFinite(Number(scale)) ? Number(scale) : DEFAULTS.minSecondsPerWaveScale;
  if (!Number.isFinite(w) || w <= 1) {
    return 0;
  }
  return (w - 1) * SECONDS_PER_WAVE_FLOOR * s;
}

function maxScoreForElapsed(elapsedSeconds, ceiling, graceSeconds) {
  const e = Number.isFinite(Number(elapsedSeconds)) ? Math.max(0, Number(elapsedSeconds)) : 0;
  return ceiling * (e + graceSeconds);
}

function createAntiCheat(options, env) {
  const opts = options || {};
  const e = env || process.env;

  const ttlMs = pickNumber(opts.ttlMs, e.RUN_TTL_MS, DEFAULTS.ttlMs);
  const minSecondsPerWaveScale = pickNumber(
    opts.minSecondsPerWaveScale,
    e.RUN_MIN_SECONDS_PER_WAVE_SCALE,
    DEFAULTS.minSecondsPerWaveScale,
    true
  );
  const maxScorePerSecond = pickNumber(
    opts.maxScorePerSecond,
    e.RUN_MAX_SCORE_PER_SECOND,
    DEFAULTS.maxScorePerSecond
  );
  const scoreGraceSeconds = pickNumber(
    opts.scoreGraceSeconds,
    e.RUN_SCORE_GRACE_SECONDS,
    DEFAULTS.scoreGraceSeconds,
    true
  );
  const runStartMax = pickNumber(
    opts.runStartMax,
    e.RATE_LIMIT_RUNSTART_MAX,
    DEFAULTS.runStartMax
  );
  const runStartWindowMs = pickNumber(
    opts.runStartWindowMs,
    e.RATE_LIMIT_WINDOW_MS,
    DEFAULTS.runStartWindowMs
  );

  return {
    ttlMs,
    minSecondsPerWaveScale,
    maxScorePerSecond,
    scoreGraceSeconds,
    runStartMax,
    runStartWindowMs,
    secondsPerWaveFloor: SECONDS_PER_WAVE_FLOOR,

    minElapsedSecondsForWave(wave) {
      return minElapsedSecondsForWave(wave, minSecondsPerWaveScale);
    },

    maxScoreFor(elapsedSeconds) {
      return maxScoreForElapsed(elapsedSeconds, maxScorePerSecond, scoreGraceSeconds);
    },

    /* Never trusts a client clock: `startedMs` came from the runs row this
     * server wrote. A negative delta (operator moved the clock back) clamps to
     * 0 rather than granting free elapsed time. */
    elapsedSeconds(startedMs, nowMs) {
      return Math.max(0, (Number(nowMs) - Number(startedMs)) / 1000);
    }
  };
}

module.exports = {
  createAntiCheat,
  minElapsedSecondsForWave,
  maxScoreForElapsed,
  ALIENS_PER_WAVE,
  FIRE_COOLDOWN_SECONDS,
  WAVE_CLEAR_SECONDS,
  SECONDS_PER_WAVE_FLOOR,
  DEFAULTS
};
