/* routes/scores.js -- score submission, personal best, public leaderboard.
 *
 * NOTE ON TRUST: the client is a browser game, so a submitted score is still
 * only "what the client claimed". What changed is that the claim must now
 * reference a run token this server issued and timestamped, and must survive
 * two PLAUSIBILITY BOUNDS measured against server wall-clock time (see
 * ../anticheat.js for the derivations and the honest list of what they do and
 * do not catch). This is NOT server-side replay validation and it cannot prove
 * a run happened -- it only rejects claims that are physically impossible.
 *
 * Error taxonomy, all HTTP 400 (401 is auth's alone):
 *   run_required      no runToken in the body
 *   invalid_run       unknown OR expired OR belongs to a different user --
 *                     deliberately ONE code, so the endpoint is not an oracle
 *                     for whether a given token exists
 *   run_already_used  the token was already spent
 *   implausible_run   bound 1: not enough elapsed time for the claimed wave
 *   implausible_score bound 2: more points than the rate ceiling allows
 */
'use strict';

const express = require('express');
const { MAX_SCORE, MAX_WAVE } = require('../db');
const { shapeBest } = require('./me');

const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 10;

function isSafeInteger(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function createScoreRoutes(store, auth, antiCheat) {
  const router = express.Router();
  const requireAuth = auth.requireAuth(store);

  // POST /api/scores  (auth required, run token required)
  router.post('/scores', requireAuth, (req, res, next) => {
    try {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const errors = [];

      if (!isSafeInteger(b.score)) {
        errors.push('score must be an integer');
      } else if (b.score < 0 || b.score > MAX_SCORE) {
        errors.push(`score must be between 0 and ${MAX_SCORE}`);
      }

      // wave is optional metadata; default to 1 when absent.
      let wave = b.wave === undefined || b.wave === null ? 1 : b.wave;
      if (!isSafeInteger(wave)) {
        errors.push('wave must be an integer');
      } else if (wave < 1 || wave > MAX_WAVE) {
        errors.push(`wave must be between 1 and ${MAX_WAVE}`);
      }

      if (errors.length) {
        return res
          .status(400)
          .json({ error: 'validation_error', details: errors });
      }

      const runToken = typeof b.runToken === 'string' ? b.runToken.trim() : '';
      if (!runToken) {
        return res.status(400).json({
          error: 'run_required',
          message:
            'A score must reference a run token from POST /api/runs/start.'
        });
      }

      const now = Date.now();
      // Opportunistic cleanup, on the same call that needs the table small.
      store.purgeExpiredRuns(now);

      const run = store.findRunByToken(runToken);
      /* One error for "no such token", "expired" and "not yours". Splitting
       * them would let an attacker probe which tokens exist. */
      if (!run || run.user_id !== req.user.id || Number(run.expires_ms) <= now) {
        return res.status(400).json({
          error: 'invalid_run',
          message: 'That run token is not valid for this account, or has expired.'
        });
      }
      if (run.consumed_at) {
        return res.status(400).json({
          error: 'run_already_used',
          message: 'That run token has already been used.'
        });
      }

      /* Elapsed time is ALWAYS derived from the started_ms this server wrote.
       * Nothing the client sends can influence it. */
      const elapsedSeconds = antiCheat.elapsedSeconds(run.started_ms, now);

      // Bound 1 -- time. Independent of the score value entirely.
      const minElapsed = antiCheat.minElapsedSecondsForWave(wave);
      if (elapsedSeconds < minElapsed) {
        return res.status(400).json({
          error: 'implausible_run',
          message:
            `Reaching wave ${wave} takes at least ${minElapsed.toFixed(1)}s of play; ` +
            `this run is ${elapsedSeconds.toFixed(1)}s old.`
        });
      }

      // Bound 2 -- rate. Independent of the wave value entirely.
      const maxScore = antiCheat.maxScoreFor(elapsedSeconds);
      if (b.score > maxScore) {
        return res.status(400).json({
          error: 'implausible_score',
          message:
            `${b.score} points in ${elapsedSeconds.toFixed(1)}s exceeds the maximum ` +
            `scoring rate (ceiling ${Math.floor(maxScore)} for this run).`
        });
      }

      /* Consume-and-insert atomically. A second request racing this one loses
       * the guarded UPDATE and writes no score at all. */
      const result = store.consumeRunAndAddScore(
        run.id,
        req.user.id,
        b.score,
        wave,
        new Date(now).toISOString()
      );
      if (!result.ok) {
        return res.status(400).json({
          error: 'run_already_used',
          message: 'That run token has already been used.'
        });
      }

      return res.status(201).json({
        accepted: true,
        score: b.score,
        wave: wave,
        elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
        personalBest: shapeBest(store.personalBest(req.user.id))
      });
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/scores/me  (auth required)
  router.get('/scores/me', requireAuth, (req, res, next) => {
    try {
      const best = store.personalBest(req.user.id);
      return res.status(200).json(
        best
          ? {
              score: best.score,
              wave: best.wave,
              achieved_at: best.achieved_at,
              username: req.user.username
            }
          : { score: null, wave: null, achieved_at: null, username: req.user.username }
      );
    } catch (err) {
      return next(err);
    }
  });

  // GET /api/leaderboard?limit=N  (public)
  router.get('/leaderboard', (req, res, next) => {
    try {
      const raw = req.query.limit;
      let limit = LIMIT_DEFAULT;
      if (raw !== undefined) {
        // Reject "12abc", "", arrays, NaN -- do not silently coerce.
        if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) {
          return res.status(400).json({
            error: 'validation_error',
            details: ['limit must be an integer']
          });
        }
        limit = parseInt(raw, 10);
        // Out-of-range values clamp rather than 400 (documented behaviour).
        limit = Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, limit));
      }
      return res.status(200).json({ limit, entries: store.leaderboard(limit) });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createScoreRoutes, LIMIT_MIN, LIMIT_MAX, LIMIT_DEFAULT };
