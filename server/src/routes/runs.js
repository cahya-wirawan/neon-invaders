/* routes/runs.js -- POST /api/runs/start.
 *
 * Issues the single-use, server-timestamped run record that POST /api/scores
 * must later reference. The point is that the SERVER decides when a run began,
 * so "how long did this run take" is a fact rather than a client claim.
 *
 * Three things worth knowing:
 *
 *  - SEPARATE RATE LIMITER. This gets its own createRateLimiter instance and
 *    its own env var (RATE_LIMIT_RUNSTART_MAX). It must not share a bucket
 *    with score submission: a player legitimately submits one score per run,
 *    but a run-start flood is the cheap way to farm a pile of tokens and let
 *    them age past the time bound.
 *
 *  - DEDUP. A player who already holds an unconsumed, unexpired run gets that
 *    SAME token back instead of a fresh one. Minting a new token per call
 *    would let a client restart the clock at will, and would also let a
 *    tab-refresher accumulate tokens. The rate limiter still COUNTS the
 *    request, so hammering this endpoint still ends in 429.
 *
 *  - PURGE. Expired unconsumed runs are deleted opportunistically here (and on
 *    score submit). No setInterval, no background job -- nothing to leak in a
 *    test process or to keep a container awake.
 */
'use strict';

const express = require('express');
const { createRateLimiter } = require('../auth');

function shapeRun(run) {
  return {
    runToken: run.run_token,
    startedMs: Number(run.started_ms),
    expiresMs: Number(run.expires_ms),
    startedAt: run.started_at
  };
}

function createRunRoutes(store, auth, antiCheat, options) {
  const opts = options || {};
  const router = express.Router();
  const requireAuth = auth.requireAuth(store);

  const runStartLimiter = createRateLimiter({
    windowMs: opts.runStartWindowMs || antiCheat.runStartWindowMs,
    max: opts.runStartMax || antiCheat.runStartMax
  });

  // requireAuth runs FIRST so an unauthenticated caller gets 401 rather than
  // burning a signed-in player's bucket entry from the same NAT address.
  router.post('/runs/start', requireAuth, runStartLimiter, (req, res, next) => {
    try {
      const now = Date.now();
      store.purgeExpiredRuns(now);

      const existing = store.findActiveRunForUser(req.user.id, now);
      if (existing) {
        return res.status(201).json(Object.assign(shapeRun(existing), { reused: true }));
      }

      const run = store.createRun(req.user.id, now, now + antiCheat.ttlMs);
      return res.status(201).json(Object.assign(shapeRun(run), { reused: false }));
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createRunRoutes, shapeRun };
