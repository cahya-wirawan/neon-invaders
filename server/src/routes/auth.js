/* routes/auth.js -- register, login, and the authenticated /api/me probe. */
'use strict';

const express = require('express');
const {
  createRateLimiter,
  validateCredentials
} = require('../auth');

function shapeBest(best) {
  if (!best) {
    return { score: null, wave: null, achieved_at: null };
  }
  return { score: best.score, wave: best.wave, achieved_at: best.achieved_at };
}

function createAuthRoutes(store, auth, options) {
  const opts = options || {};
  const router = express.Router();

  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 900000;
  const registerLimiter = createRateLimiter({
    windowMs: opts.registerWindowMs || windowMs,
    max: opts.registerMax || Number(process.env.RATE_LIMIT_REGISTER_MAX) || 10
  });
  const loginLimiter = createRateLimiter({
    windowMs: opts.loginWindowMs || windowMs,
    max: opts.loginMax || Number(process.env.RATE_LIMIT_LOGIN_MAX) || 30
  });

  router.post('/register', registerLimiter, async (req, res, next) => {
    try {
      const v = validateCredentials(req.body);
      if (!v.ok) {
        return res
          .status(400)
          .json({ error: 'validation_error', details: v.errors });
      }
      if (store.findUserByUsername(v.username)) {
        return res.status(409).json({
          error: 'username_taken',
          message: 'That username is already registered.'
        });
      }

      const hash = await auth.hashPassword(v.password);
      let user;
      try {
        user = store.createUser(v.username, hash);
      } catch (err) {
        // Lost the race against a concurrent identical signup.
        if (String(err && err.code).startsWith('SQLITE_CONSTRAINT')) {
          return res.status(409).json({
            error: 'username_taken',
            message: 'That username is already registered.'
          });
        }
        throw err;
      }

      return res.status(201).json({
        token: auth.issueToken(user),
        user: { id: user.id, username: user.username }
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const username = typeof b.username === 'string' ? b.username.trim() : '';
      const password = typeof b.password === 'string' ? b.password : '';

      const user = username ? store.findUserByUsername(username) : null;
      /* Same generic 401 for "no such user" and "wrong password", and the same
       * COST: skipping the bcrypt compare when the user is missing returned in
       * ~0ms against ~60-100ms for a real account, which enumerated usernames
       * regardless of the identical body (SRV-05). An unknown username is
       * compared against a precomputed dummy hash of the same work factor
       * instead, so both paths do exactly one bcrypt compare. */
      const ok = await auth.verifyPassword(
        password,
        user ? user.password_hash : auth.dummyPasswordHash
      );
      if (!user || !ok) {
        return res.status(401).json({
          error: 'invalid_credentials',
          message: 'Username or password is incorrect.'
        });
      }

      return res.status(200).json({
        token: auth.issueToken(user),
        user: { id: user.id, username: user.username }
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
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

module.exports = { createAuthRoutes, createMeRoute, shapeBest };
