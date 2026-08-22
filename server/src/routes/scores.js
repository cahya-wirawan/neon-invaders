/* routes/scores.js -- score submission, personal best, public leaderboard.
 *
 * NOTE ON TRUST: the client is a browser game, so a submitted score is only
 * ever "what the client claimed". This endpoint authenticates *who* submitted
 * and bounds the value; it cannot prove the run happened. Anti-cheat would
 * need server-side replay validation, which is out of scope. See README.
 */
'use strict';

const express = require('express');
const { MAX_SCORE, MAX_WAVE } = require('../db');
const { shapeBest } = require('./auth');

const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 10;

function isSafeInteger(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function createScoreRoutes(store, auth) {
  const router = express.Router();
  const requireAuth = auth.requireAuth(store);

  // POST /api/scores  (auth required)
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

      store.addScore(req.user.id, b.score, wave);
      return res.status(201).json({
        accepted: true,
        score: b.score,
        wave: wave,
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
