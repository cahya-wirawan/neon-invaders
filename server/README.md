# NEON INVADERS -- game server

Node.js + Express + SQLite. Stores user accounts (bcrypt-hashed passwords) and
high scores, and serves a public leaderboard. Score submission requires a
bearer token.

```bash
cd server
npm install
cp .env.example .env      # then edit JWT_SECRET
npm start                 # http://localhost:3000
npm test                  # 33 tests, node:test only
```

## Stack choices

| Choice | Why |
| --- | --- |
| **bcryptjs** (not `bcrypt`) | Pure JS. No node-gyp, no native toolchain, installs anywhere. Slower, which is why `BCRYPT_ROUNDS` is tunable. |
| **JWT bearer** (not cookies) | The mobile builds load from `capacitor://localhost`, `https://localhost` and `null` (`file://`). Cookie `SameSite`/domain semantics do not work across those origins. |
| **better-sqlite3** | Installed cleanly here from a **prebuilt binary** (no compile). Synchronous API suits a single-process game backend. `node:sqlite` (Node >=22.5) is a near drop-in if a future environment cannot install it, but it still emits an `ExperimentalWarning`. |
| **`node:test`** | No jest/vitest. Zero test dependencies. |

## API

Base URL `http://localhost:3000`. All bodies are JSON.

| Method | Path | Auth | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | – | 200 `{ok:true}` | |
| POST | `/api/auth/register` | – | 201 `{token,user}` | 400 validation, 409 duplicate, 429 rate limit |
| POST | `/api/auth/login` | – | 200 `{token,user}` | 401 invalid credentials |
| GET | `/api/me` | Bearer | 200 `{user,personalBest}` | 401 |
| POST | `/api/scores` | Bearer | 201 `{accepted,score,wave,personalBest}` | 400 bad score, 401 |
| GET | `/api/scores/me` | Bearer | 200 best, or `{score:null}` | 401 |
| GET | `/api/leaderboard?limit=N` | – | 200 `{limit,entries:[{rank,username,score,achieved_at}]}` | 400 non-integer limit |

- Username: 3–20 chars of `[A-Za-z0-9_-]`, unique case-insensitively.
- Password: 8–72 characters (bcrypt reads at most 72 bytes; longer is rejected
  rather than silently truncated).
- Score: integer 0–9,999,999. Wave: integer 1–9,999.
- `limit` clamps to 1–100, defaults to 10. One row per user (their best run),
  sorted `score DESC, achieved_at ASC`.

```bash
TOKEN=$(curl -s -XPOST localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"pilot","password":"hunter2hunter2"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -s -XPOST localhost:3000/api/scores -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"score":4200,"wave":5}'

curl -s 'localhost:3000/api/leaderboard?limit=10'
```

## Schema

```sql
users  (id, username UNIQUE COLLATE NOCASE, password_hash, created_at)
scores (id, user_id -> users.id, score CHECK 0..9999999, wave, achieved_at)
INDEX idx_scores_rank ON scores (score DESC, achieved_at ASC)
```

## Secrets

`JWT_SECRET` comes from the environment. If it is unset:

- outside production: the server logs a loud `console.warn` and falls back to
  the constant `INSECURE_DEV_ONLY_JWT_SECRET` in `src/auth.js` — a value that
  is public in this source tree and therefore forgeable by anyone;
- with `NODE_ENV=production`: **startup is refused.**

`.env`, `data/` and `*.db` are gitignored. No real secret and no database file
is committed.

---

## What was NOT done

Be clear-eyed about the gaps before deploying this:

- **No HTTPS/TLS.** The server speaks plain HTTP. Put it behind a TLS
  terminator (nginx, Caddy, a PaaS). Bearer tokens over cleartext are
  interceptable.
- **No anti-cheat whatsoever.** `POST /api/scores` authenticates *who* is
  submitting and bounds the number, but cannot prove the run happened. Anyone
  with a token can `curl` a 9,999,999. Real defence needs server-side replay
  validation or a signed input trace, which is out of scope.
- **No load testing, no benchmarks, no profiling.** Performance is unmeasured.
- **No deployment.** Never run anywhere but localhost. No Dockerfile, no
  systemd unit, no CI, no process manager, no healthcheck wiring, no backups
  of the SQLite file, no migration tooling (the schema is `CREATE TABLE IF NOT
  EXISTS` only — there is no path to *change* it).
- **No password reset, email verification, account deletion, or logout
  server-side.** Tokens are stateless and valid until expiry: there is no
  revocation list, so a leaked token works for its full 30-day life.
- **The rate limiter is in-memory and per-process.** It resets on restart and
  is useless behind more than one instance or against a distributed attacker.
  It keys on `req.ip`, which is only trustworthy if you set `TRUST_PROXY`
  correctly for your actual proxy chain.
- **No structured logging, metrics, or alerting.**
- **Tests are functional only** (33 of them, all passing). No security audit,
  no fuzzing, no concurrency/race testing beyond the duplicate-signup path.

## Known limitations (Gauntlet review, not fixed this round)

Reviewed, reproduced where applicable, and consciously left alone. Each is
recorded so it is deferred rather than forgotten.

| ID | Limitation | Why it is deferred |
| --- | --- | --- |
| SRV-03 | No rate limit and no best-only dedupe on `POST /api/scores`, so rows grow without bound | Low real-world risk at hobby-project scale (one authenticated player per run). |
| SRV-04 | The leaderboard query full-scans `scores` instead of using `idx_scores_rank` (the window function prevents index use) | Fine at current and expected data volumes. |
| SRV-06 | `BCRYPT_ROUNDS` and `JWT_EXPIRES_IN` are read from the environment without validation or clamping at startup | Operator error, not attacker-controlled. |
| SRV-07 | The rate limiter is per-process/in-memory (useless across instances) and shares one bucket per NAT egress IP | Matches the single-instance deployment this was built for. |
| SRV-08 | `isSafeInteger()` in `src/db.js` is misnamed — it calls `Number.isInteger`, and a separate range check is what actually bounds the value | Cosmetic; rename in a future pass. |
| SRV-09 | `Vary: Origin` is set only on the allowed-origin branch, and by overwrite rather than append | No cache currently sits in front of this server. |
| NET-04 | `js/net.js` does not rebind the stored auth token when the panel's server-URL field changes, so a token could be sent to a newly typed host | Requires the player to manually retype the server field; low-likelihood, self-inflicted. |
| NET-06 | Three defensive pointer-event handlers on the panel are unreachable (`js/input.js` binds pointer events to the canvas element only) | Dead-code cleanup for later; harmless. |
| NET-07 | Score/wave/limit bounds are clamped rather than rejected client-side, and duplicated as literals between `js/net.js` and `src/db.js` instead of shared constants | Server-side validation is the real enforcement point regardless. |
| NET-08 | Two narrow state-leak edges in the game-over hook: signing in exactly on the game-over screen misses that run's submit, and a late-resolving submit can refresh the board mid-next-run | Narrow timing windows, no data corruption. |
| NET-09 | Once a server URL is set, clearing the field re-persists the default instead of fully disabling the bridge | Clearing `localStorage` remains the escape hatch. |
| MOB-01 | The bridge's default server URL (`http://localhost:3000`) cannot work out of the box inside the Capacitor shells because of mixed-content blocking | Already documented in [`docs/MOBILE.md`](../docs/MOBILE.md#the-cleartext-gotcha) — no additional fix here. |
| F2 | `Origin: null` (a `file://` page) is on the CORS allowlist | Accepted tradeoff, already commented in `src/app.js`: auth is a bearer token, not a cookie, so a null-origin page cannot act on another origin's session. |

## Remaining manual steps

1. Set a real `JWT_SECRET` (`node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`).
2. Terminate TLS in front of the process.
3. Set `TRUST_PROXY` to match your proxy, or the rate limiter is trivially bypassed.
4. Decide on a backup strategy for the SQLite file (or move to Postgres).
5. Add token revocation if 30-day stateless tokens are unacceptable.
