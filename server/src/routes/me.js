/* routes/me.js -- the authenticated /api/me probe.
 *
 * This file exists because routes/auth.js was DELETED: there is no register
 * and no login any more (Firebase Auth does that in the browser). /api/me and
 * the shapeBest helper it shared with routes/scores.js moved here rather than
 * being deleted with it.
 */
'use strict';

const express = require('express');

function shapeBest(best) {
  if (!best) {
    return { score: null, wave: null, achieved_at: null };
  }
  return { score: best.score, wave: best.wave, achieved_at: best.achieved_at };
}

function createMeRoute(store, auth) {
  const router = express.Router();
  router.get('/me', auth.requireAuth(store), (req, res, next) => {
    try {
      return res.status(200).json({
        user: req.user,
        personalBest: shapeBest(store.personalBest(req.user.id))
      });
    } catch (err) {
      return next(err);
    }
  });
  return router;
}

module.exports = { createMeRoute, shapeBest };
