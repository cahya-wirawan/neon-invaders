#!/usr/bin/env bash
# verify.sh -- runs every acceptance check and prints "AC<n>: PASS|FAIL".
# Exits non-zero if any check fails.
#
#   bash scripts/verify.sh
#
# Requires: node, npm, curl. Does NOT require the sqlite3 CLI (absent here) --
# scripts/sqlite-cli.js reads the DB through Node's built-in node:sqlite, a
# different driver from the better-sqlite3 the server writes with.
#
# Starts a REAL `firebase-tools` Auth emulator for AC9 (see
# server/README.md's "Phase 0 transcript" for why that's safe to automate in
# this environment -- no Java needed for the Auth emulator, and firebase-tools
# is cached locally so `npx --no-install` needs no network). Falls back
# honestly (PARTIAL, not a silent fake) if the emulator cannot be started here.
#
# Does NOT compile anything native: no Gradle, no Xcode, no APK, no IPA.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=0
declare -a RESULTS=()

pass() { RESULTS+=("AC$1: PASS -- $2"); }
fail() { RESULTS+=("AC$1: FAIL -- $2"); FAILED=1; }
partial() { RESULTS+=("AC$1: PARTIAL -- $2"); }
rpass() { RESULTS+=("REGRESSION $1: PASS -- $2"); }
rfail() { RESULTS+=("REGRESSION $1: FAIL -- $2"); FAILED=1; }

note() { printf '    %s\n' "$*"; }
hdr()  { printf '\n=== %s ===\n' "$*"; }

TMP="$(mktemp -d)"
DB="$TMP/verify.db"
PORT=3517
BASE="http://127.0.0.1:$PORT"
SERVER_PID=""
EMULATOR_PID=""
EMULATOR_HOST="127.0.0.1:9099"
PROJECT="demo-neon-invaders"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$EMULATOR_PID" ] && kill -0 "$EMULATOR_PID" 2>/dev/null; then
    kill "$EMULATOR_PID" 2>/dev/null || true
    wait "$EMULATOR_PID" 2>/dev/null || true
  fi
  # Belt-and-suspenders: npx forks a child for the actual firebase-tools CLI,
  # which does not always inherit a clean SIGTERM path through npx's own PID.
  # Scoped tightly to THIS run's project id so it cannot touch anything else.
  pkill -f "emulators:start.*$PROJECT" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

jsonfield() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);
      process.stdout.write(v===undefined||v===null?"":String(v));}catch(e){process.stdout.write("");}
  });' "$1"; }

# A hand-crafted, deliberately UNSIGNED token in the exact shape a real
# Firebase Auth emulator issues ({"alg":"none"}, empty signature segment --
# confirmed against a live emulator, see server/README.md). Used only for the
# NEGATIVE cases (expired / wrong audience) where we need to control specific
# claim values; the POSITIVE case below uses a token the emulator itself
# minted, not one of these.
craft_unsigned_token() {
  node -e '
    function b64url(o){return Buffer.from(JSON.stringify(o)).toString("base64url");}
    const [aud, iss, exp, sub] = process.argv.slice(1);
    const header = { alg: "none", typ: "JWT" };
    const payload = { aud, iss, sub, iat: Math.floor(Date.now()/1000) - 5, exp: Number(exp) };
    process.stdout.write(b64url(header) + "." + b64url(payload) + ".");
  ' "$1" "$2" "$3" "$4"
}

# Mints a REAL token from the running emulator via the same Identity Toolkit
# REST endpoint the browser SDK itself talks to.
mint_emulator_token() {
  local email="$1"
  curl -s -XPOST "http://$EMULATOR_HOST/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"hunter2hunter2\",\"returnSecureToken\":true}" \
    | jsonfield idToken
}

# ---------------------------------------------------------- start emulator
hdr "Starting a real Firebase Auth emulator for AC9"
EMULATOR_UP=0
( cd "$ROOT" && exec npx --no-install firebase-tools emulators:start --only auth \
    --project "$PROJECT" ) >"$TMP/emulator.log" 2>&1 &
EMULATOR_PID=$!

for _ in $(seq 1 60); do
  if curl -s -o /dev/null -w '%{http_code}' "http://$EMULATOR_HOST/" 2>/dev/null | grep -q 200; then
    EMULATOR_UP=1
    break
  fi
  sleep 0.5
done
if [ "$EMULATOR_UP" = "1" ]; then
  note "emulator ready at http://$EMULATOR_HOST"
else
  note "emulator did NOT become ready -- AC9 will fall back to a locally-signed token"
  note "$(tail -20 "$TMP/emulator.log")"
fi

# ---------------------------------------------------------------- AC1
hdr "AC1: POST /api/runs/start issues a server-timestamped token"
( cd "$ROOT/server" && exec env DB_PATH="$DB" PORT="$PORT" NODE_ENV=development \
    FIREBASE_PROJECT_ID="$PROJECT" FIREBASE_AUTH_EMULATOR_HOST="$EMULATOR_HOST" \
    RUN_MIN_SECONDS_PER_WAVE_SCALE=0.05 RUN_MAX_SCORE_PER_SECOND=200 RUN_SCORE_GRACE_SECONDS=5 \
    RATE_LIMIT_RUNSTART_MAX=200 RATE_LIMIT_WINDOW_MS=900000 \
    node src/index.js ) >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

HEALTH=""
for _ in $(seq 1 60); do
  HEALTH="$(curl -s -o "$TMP/health.json" -w '%{http_code}' "$BASE/api/health" 2>/dev/null || true)"
  [ "$HEALTH" = "200" ] && break
  sleep 0.25
done
note "GET /api/health -> HTTP $HEALTH  body=$(cat "$TMP/health.json" 2>/dev/null)"
if [ "$HEALTH" != "200" ]; then
  fail 1 "server never came up; see $TMP/server.log"
  echo "Cannot continue without a running server."
  for r in "${RESULTS[@]}"; do echo "$r"; done
  exit 1
fi

if [ "$EMULATOR_UP" = "1" ]; then
  ALICE_TOKEN="$(mint_emulator_token "verifyalice@example.com")"
else
  ALICE_TOKEN="$(craft_unsigned_token "$PROJECT" "https://securetoken.google.com/$PROJECT" \
    "$(($(date +%s) + 3600))" "verifyalice-uid")"
fi
note "alice ID token acquired (${#ALICE_TOKEN} chars, source: $([ "$EMULATOR_UP" = "1" ] && echo real-emulator || echo hand-crafted-fallback))"

RS_NOAUTH="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/api/runs/start")"
RS1="$(curl -s -o "$TMP/run1.json" -w '%{http_code}' -XPOST "$BASE/api/runs/start" \
  -H "Authorization: Bearer $ALICE_TOKEN")"
RUN1_TOKEN="$(jsonfield runToken < "$TMP/run1.json")"
RUN1_STARTED="$(jsonfield startedMs < "$TMP/run1.json")"
note "POST /api/runs/start (no auth) -> HTTP $RS_NOAUTH"
note "POST /api/runs/start (alice)   -> HTTP $RS1  body=$(cat "$TMP/run1.json")"

DB_RUN_ROW="$(node scripts/sqlite-cli.js "$DB" \
  "SELECT run_token, consumed_at FROM runs WHERE run_token='$RUN1_TOKEN'" 2>/dev/null || true)"
note "sqlite: runs row -> '$DB_RUN_ROW'"

if [ "$RS_NOAUTH" = "401" ] && [ "$RS1" = "201" ] && [ -n "$RUN1_TOKEN" ] \
   && [ -n "$RUN1_STARTED" ] && [ "$DB_RUN_ROW" = "$RUN1_TOKEN|" ]; then
  pass 1 "no auth=401; with auth=201 token+startedMs; row confirmed in runs table, unconsumed"
else
  fail 1 "noauth=$RS_NOAUTH withauth=$RS1 token='$RUN1_TOKEN' started='$RUN1_STARTED' row='$DB_RUN_ROW'"
fi

# ---------------------------------------------------------------- AC2
hdr "AC2: a run token can be submitted at most once"
SUB1="$(curl -s -o "$TMP/sub1.json" -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $ALICE_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"score\":500,\"wave\":1,\"runToken\":\"$RUN1_TOKEN\"}")"
SUB2="$(curl -s -o "$TMP/sub2.json" -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $ALICE_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"score\":500,\"wave\":1,\"runToken\":\"$RUN1_TOKEN\"}")"
SUB2_ERR="$(jsonfield error < "$TMP/sub2.json")"
ROWCOUNT="$(node scripts/sqlite-cli.js "$DB" \
  "SELECT COUNT(*) FROM scores WHERE run_id=(SELECT id FROM runs WHERE run_token='$RUN1_TOKEN')" 2>/dev/null || true)"
note "1st submit -> HTTP $SUB1  body=$(cat "$TMP/sub1.json")"
note "2nd submit (same token) -> HTTP $SUB2  error=$SUB2_ERR"
note "sqlite: scores rows for that run -> $ROWCOUNT"
if [ "$SUB1" = "201" ] && [ "$SUB2" -ge "400" ] && [ "$SUB2" -lt "500" ] \
   && [ "$SUB2_ERR" = "run_already_used" ] && [ "$ROWCOUNT" = "1" ]; then
  pass 2 "1st submit=201, 2nd (same token)=$SUB2 run_already_used, exactly one scores row"
else
  fail 2 "sub1=$SUB1 sub2=$SUB2 err=$SUB2_ERR rows=$ROWCOUNT"
fi

# ---------------------------------------------------------------- AC3
hdr "AC3: score submission without a valid run token is rejected"
COUNT_BEFORE="$(node scripts/sqlite-cli.js "$DB" "SELECT COUNT(*) FROM scores" 2>/dev/null || true)"
NORUNT="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $ALICE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"score":999,"wave":1}')"
BOGUS="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $ALICE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"score":999,"wave":1,"runToken":"totally-made-up-token"}')"
COUNT_AFTER="$(node scripts/sqlite-cli.js "$DB" "SELECT COUNT(*) FROM scores" 2>/dev/null || true)"
note "no runToken -> HTTP $NORUNT ; bogus runToken -> HTTP $BOGUS"
note "scores row count: before=$COUNT_BEFORE after=$COUNT_AFTER"
if [ "$NORUNT" -ge "400" ] && [ "$NORUNT" -lt "500" ] \
   && [ "$BOGUS" -ge "400" ] && [ "$BOGUS" -lt "500" ] \
   && [ "$COUNT_BEFORE" = "$COUNT_AFTER" ]; then
  pass 3 "no token=$NORUNT, bogus token=$BOGUS, no new scores row written"
else
  fail 3 "norunt=$NORUNT bogus=$BOGUS before=$COUNT_BEFORE after=$COUNT_AFTER"
fi

# ---------------------------------------------------------------- AC4
hdr "AC4: implausibly-fast wave claim is rejected until enough time passes"
( cd "$ROOT/server" && node -e '
  const { createStore } = require("./src/db");
  const s = createStore(process.argv[1]);
  s.upsertUserByFirebaseUid("waveuser-uid", "waveuser@example.com", "Wave User");
  s.close();
' "$DB" )
WAVE_TOKEN="$([ "$EMULATOR_UP" = "1" ] && mint_emulator_token "waveuser@example.com" \
  || craft_unsigned_token "$PROJECT" "https://securetoken.google.com/$PROJECT" "$(($(date +%s)+3600))" "waveuser-uid")"

RS_WAVE="$(curl -s -o "$TMP/runwave.json" -w '%{http_code}' -XPOST "$BASE/api/runs/start" \
  -H "Authorization: Bearer $WAVE_TOKEN")"
WAVE_RUN="$(jsonfield runToken < "$TMP/runwave.json")"
note "run-start for wave test -> HTTP $RS_WAVE token=$WAVE_RUN"

TOO_SOON="$(curl -s -o "$TMP/toosoon.json" -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $WAVE_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"score\":500,\"wave\":10,\"runToken\":\"$WAVE_RUN\"}")"
TOO_SOON_ERR="$(jsonfield error < "$TMP/toosoon.json")"
note "wave=10 claimed immediately -> HTTP $TOO_SOON error=$TOO_SOON_ERR (bound ~3.5s at this scale)"

note "sleeping 9s past the (10-1)*7.72*0.05 = 3.47s minimum..."
sleep 9
AFTER_WAIT="$(curl -s -o "$TMP/afterwait.json" -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $WAVE_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"score\":500,\"wave\":10,\"runToken\":\"$WAVE_RUN\"}")"
note "same claim after waiting -> HTTP $AFTER_WAIT body=$(cat "$TMP/afterwait.json")"

if [ "$TOO_SOON" = "400" ] && [ "$TOO_SOON_ERR" = "implausible_run" ] && [ "$AFTER_WAIT" = "201" ]; then
  pass 4 "immediate claim rejected (implausible_run); same token accepted after waiting past the time bound"
else
  fail 4 "too_soon=$TOO_SOON err=$TOO_SOON_ERR after_wait=$AFTER_WAIT"
fi

# ---------------------------------------------------------------- AC5
hdr "AC5: score-per-second ceiling enforced independent of the time bound"
RS_RATE="$(curl -s -o "$TMP/runrate.json" -w '%{http_code}' -XPOST "$BASE/api/runs/start" \
  -H "Authorization: Bearer $WAVE_TOKEN")"
RATE_RUN="$(jsonfield runToken < "$TMP/runrate.json")"
note "run-start for rate test -> HTTP $RS_RATE token=$RATE_RUN"
sleep 1
TOO_FAST="$(curl -s -o "$TMP/toofast.json" -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $WAVE_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"score\":50000,\"wave\":1,\"runToken\":\"$RATE_RUN\"}")"
TOO_FAST_ERR="$(jsonfield error < "$TMP/toofast.json")"
note "wave=1 (zero time bound), score=50000 after ~1s -> HTTP $TOO_FAST error=$TOO_FAST_ERR (ceiling ~200*(1+5)=1200)"

UNDER_CEIL="$(curl -s -o "$TMP/underceil.json" -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $WAVE_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"score\":1000,\"wave\":1,\"runToken\":\"$RATE_RUN\"}")"
note "same token, score=1000 (under ceiling) -> HTTP $UNDER_CEIL body=$(cat "$TMP/underceil.json")"

if [ "$TOO_FAST" = "400" ] && [ "$TOO_FAST_ERR" = "implausible_score" ] && [ "$UNDER_CEIL" = "201" ]; then
  pass 5 "over-ceiling score rejected (implausible_score, distinct from AC4's implausible_run); under-ceiling accepted on the same token"
else
  fail 5 "too_fast=$TOO_FAST err=$TOO_FAST_ERR under_ceil=$UNDER_CEIL"
fi

# ---------------------------------------------------------------- AC6
hdr "AC6: run-start issuance is separately rate-limited from score submission"
( cd "$ROOT/server" && node -e '
  const { createStore } = require("./src/db");
  const s = createStore(process.argv[1]);
  s.upsertUserByFirebaseUid("rluser-uid", "rluser@example.com", "RL User");
  s.close();
' "$DB" )
RL_TOKEN="$([ "$EMULATOR_UP" = "1" ] && mint_emulator_token "rluser@example.com" \
  || craft_unsigned_token "$PROJECT" "https://securetoken.google.com/$PROJECT" "$(($(date +%s)+3600))" "rluser-uid")"

# The server for THIS check needs a tiny RATE_LIMIT_RUNSTART_MAX, so run it as
# a second, throwaway instance sharing the same DB rather than restarting the
# main one (which the remaining ACs below still need at its current settings).
RL_PORT=3518
RL_BASE="http://127.0.0.1:$RL_PORT"
( cd "$ROOT/server" && exec env DB_PATH="$DB" PORT="$RL_PORT" NODE_ENV=development \
    FIREBASE_PROJECT_ID="$PROJECT" FIREBASE_AUTH_EMULATOR_HOST="$EMULATOR_HOST" \
    RUN_MIN_SECONDS_PER_WAVE_SCALE=0 RUN_MAX_SCORE_PER_SECOND=999999 \
    RATE_LIMIT_RUNSTART_MAX=3 RATE_LIMIT_WINDOW_MS=900000 \
    node src/index.js ) >"$TMP/rl-server.log" 2>&1 &
RL_SERVER_PID=$!
for _ in $(seq 1 60); do
  curl -s -o /dev/null "$RL_BASE/api/health" 2>/dev/null && break
  sleep 0.25
done

RL_CODES=""
LAST_TOKEN=""
for i in 1 2 3 4; do
  CODE="$(curl -s -o "$TMP/rl$i.json" -w '%{http_code}' -XPOST "$RL_BASE/api/runs/start" \
    -H "Authorization: Bearer $RL_TOKEN")"
  RL_CODES="$RL_CODES $CODE"
  [ "$CODE" = "201" ] && LAST_TOKEN="$(jsonfield runToken < "$TMP/rl$i.json")"
done
note "4 rapid run-start calls -> HTTP codes:$RL_CODES (max is 3/window)"

STILL_SUBMITS="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$RL_BASE/api/scores" \
  -H "Authorization: Bearer $RL_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"score\":10,\"wave\":1,\"runToken\":\"$LAST_TOKEN\"}")"
note "the previously-issued token can still be submitted -> HTTP $STILL_SUBMITS (proves score submission has its own, separate limiter)"

kill "$RL_SERVER_PID" 2>/dev/null || true
wait "$RL_SERVER_PID" 2>/dev/null || true

FOURTH="$(echo "$RL_CODES" | awk '{print $4}')"
if [ "$FOURTH" = "429" ] && [ "$STILL_SUBMITS" = "201" ]; then
  pass 6 "4th run-start -> 429 (limit=3); an already-issued token still submits successfully in the same window"
else
  fail 6 "codes=$RL_CODES still_submits=$STILL_SUBMITS"
fi

# ---------------------------------------------------------------- AC7
hdr "AC7: unsubmitted run tokens expire and are purged, not accumulated"
ALICE_ID="$(node scripts/sqlite-cli.js "$DB" "SELECT id FROM users WHERE username LIKE 'verifyalice%' OR firebase_uid='verifyalice-uid' LIMIT 1" 2>/dev/null || true)"
if [ -z "$ALICE_ID" ]; then
  ALICE_ID="$(node scripts/sqlite-cli.js "$DB" "SELECT id FROM users LIMIT 1" 2>/dev/null || true)"
fi
EXPIRED_TOKEN="$( ( cd "$ROOT/server" && node -e '
  const { createStore } = require("./src/db");
  const s = createStore(process.argv[1]);
  const userId = Number(process.argv[2]);
  const past = Date.now() - 60000;
  const run = s.createRun(userId, past - 10000, past); // expires_ms already in the past
  process.stdout.write(run.run_token);
  s.close();
' "$DB" "$ALICE_ID" ) )"
note "directly inserted an already-expired run row for user $ALICE_ID -> token=$EXPIRED_TOKEN"

BEFORE_ROW="$(node scripts/sqlite-cli.js "$DB" "SELECT COUNT(*) FROM runs WHERE run_token='$EXPIRED_TOKEN'" 2>/dev/null || true)"
EXPIRED_SUBMIT="$(curl -s -o "$TMP/expired.json" -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $ALICE_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"score\":1,\"wave\":1,\"runToken\":\"$EXPIRED_TOKEN\"}")"
EXPIRED_ERR="$(jsonfield error < "$TMP/expired.json")"
AFTER_ROW="$(node scripts/sqlite-cli.js "$DB" "SELECT COUNT(*) FROM runs WHERE run_token='$EXPIRED_TOKEN'" 2>/dev/null || true)"
note "before submit attempt: row present=$BEFORE_ROW"
note "submit against expired token -> HTTP $EXPIRED_SUBMIT error=$EXPIRED_ERR"
note "after submit attempt (which purges expired rows as a side effect): row present=$AFTER_ROW"

if [ "$BEFORE_ROW" = "1" ] && [ "$EXPIRED_SUBMIT" = "400" ] && [ "$EXPIRED_ERR" = "invalid_run" ] && [ "$AFTER_ROW" = "0" ]; then
  pass 7 "expired token rejected as invalid_run (not a distinct 'expired' code -- no existence oracle); purged from the runs table by the same request"
else
  fail 7 "before=$BEFORE_ROW submit=$EXPIRED_SUBMIT err=$EXPIRED_ERR after=$AFTER_ROW"
fi

# ---------------------------------------------------------------- AC8
hdr "AC8: old bcrypt/JWT auth is fully removed, not left dormant"
AC8_BAD=""
if node -e "require.resolve('bcryptjs')" 2>/dev/null; then AC8_BAD="$AC8_BAD bcryptjs-resolves"; fi
if node -e "require.resolve('jsonwebtoken')" 2>/dev/null; then AC8_BAD="$AC8_BAD jsonwebtoken-resolves"; fi
if grep -q '"bcryptjs"\|"jsonwebtoken"' server/package.json; then AC8_BAD="$AC8_BAD in-package-json"; fi
REG404="$(curl -s -o "$TMP/reg404.json" -w '%{http_code}' -XPOST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' -d '{"username":"x","password":"x"}')"
LOGIN404="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"x","password":"x"}')"
note "require.resolve bcryptjs/jsonwebtoken from repo root -> ${AC8_BAD:-<neither resolves>}"
note "POST /api/auth/register -> HTTP $REG404 ; POST /api/auth/login -> HTTP $LOGIN404"
# Strip block-comment continuation lines ("^\s*\*") first -- auth.js's header
# comment legitimately DISCUSSES bcrypt/JWT in prose to document the removal
# (exactly what AC14 wants), which would otherwise false-positive here.
CODE_LEFTOVERS="$(grep -v '^[[:space:]]*\*' server/src/auth.js server/src/routes/*.js 2>/dev/null \
  | grep -iE 'bcrypt|jsonwebtoken|password_hash|jwt\.sign|jwt\.verify' | head -5)"
note "grep for actual password/JWT CODE (comment lines excluded) -> '${CODE_LEFTOVERS:-<none>}'"
if [ -z "$AC8_BAD" ] && [ "$REG404" = "404" ] && [ "$LOGIN404" = "404" ] && [ -z "$CODE_LEFTOVERS" ]; then
  pass 8 "bcryptjs/jsonwebtoken absent as deps and unresolvable; /api/auth/register and /api/auth/login both 404; no password/JWT code left in server/src"
else
  fail 8 "deps='$AC8_BAD' register=$REG404 login=$LOGIN404 leftovers='$CODE_LEFTOVERS'"
fi

# ---------------------------------------------------------------- AC9
hdr "AC9: Firebase ID token verification"
GARBAGE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/me" -H 'Authorization: Bearer garbage')"
EXPIRED_TOK="$(craft_unsigned_token "$PROJECT" "https://securetoken.google.com/$PROJECT" \
  "$(($(date +%s) - 100))" "someone")"
EXPIRED_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/me" -H "Authorization: Bearer $EXPIRED_TOK")"
WRONG_AUD_TOK="$(craft_unsigned_token "wrong-project" "https://securetoken.google.com/wrong-project" \
  "$(($(date +%s) + 3600))" "someone")"
WRONG_AUD_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/me" -H "Authorization: Bearer $WRONG_AUD_TOK")"

if [ "$EMULATOR_UP" = "1" ]; then
  AC9_TOKEN="$(mint_emulator_token "ac9pilot@example.com")"
  AC9_SOURCE="real firebase-tools Auth emulator (identitytoolkit accounts:signUp)"
else
  AC9_TOKEN="$(craft_unsigned_token "$PROJECT" "https://securetoken.google.com/$PROJECT" \
    "$(($(date +%s)+3600))" "ac9pilot-uid")"
  AC9_SOURCE="hand-crafted fallback -- emulator did not start in this run"
fi
ME_CODE="$(curl -s -o "$TMP/me.json" -w '%{http_code}' "$BASE/api/me" -H "Authorization: Bearer $AC9_TOKEN")"
ME_UID="$(jsonfield user.firebase_uid < "$TMP/me.json")"
DB_USER_ROW="$(node scripts/sqlite-cli.js "$DB" "SELECT firebase_uid FROM users WHERE firebase_uid='$ME_UID'" 2>/dev/null || true)"

note "garbage token -> HTTP $GARBAGE"
note "expired token -> HTTP $EXPIRED_CODE"
note "wrong-audience token -> HTTP $WRONG_AUD_CODE"
note "valid token (source: $AC9_SOURCE) -> HTTP $ME_CODE  uid=$ME_UID"
note "sqlite: matching users row -> '$DB_USER_ROW'"

if [ "$GARBAGE" = "401" ] && [ "$EXPIRED_CODE" = "401" ] && [ "$WRONG_AUD_CODE" = "401" ] \
   && [ "$ME_CODE" = "200" ] && [ -n "$ME_UID" ] && [ "$DB_USER_ROW" = "$ME_UID" ]; then
  if [ "$EMULATOR_UP" = "1" ]; then
    pass 9 "garbage/expired/wrong-audience all 401; a REAL emulator-issued token accepted with req.user populated and matching users row"
  else
    partial 9 "garbage/expired/wrong-audience all 401; POSITIVE case used a hand-crafted fallback token, NOT a live emulator (emulator failed to start this run -- see log above)"
  fi
else
  fail 9 "garbage=$GARBAGE expired=$EXPIRED_CODE wrong_aud=$WRONG_AUD_CODE valid=$ME_CODE uid=$ME_UID dbrow='$DB_USER_ROW'"
fi

# ---------------------------------------------------------------- AC10
hdr "AC10: firebase-tools/firebase-admin availability matches documented Phase 0 outcome"
if node scripts/check-firebase-availability.js > "$TMP/fbcheck.log" 2>&1; then
  note "$(tail -5 "$TMP/fbcheck.log")"
  pass 10 "runtime matches server/README.md's PHASE0_* markers (exit 0)"
else
  note "$(cat "$TMP/fbcheck.log")"
  fail 10 "check-firebase-availability.js exited non-zero -- see output above"
fi

# ---------------------------------------------------------------- AC11
hdr "AC11: js/net.js stays strictly opt-in (zero requests, zero SDK injection until interaction)"
if node scripts/check-net.js > "$TMP/checknet.log" 2>&1; then
  note "$(tail -5 "$TMP/checknet.log")"
  pass 11 "$(grep -o '[0-9]* checks run, [0-9]* problem(s).' "$TMP/checknet.log" | tail -1) exit=0"
else
  note "$(tail -30 "$TMP/checknet.log")"
  fail 11 "check-net.js exited non-zero"
fi

# ---------------------------------------------------------------- AC12
hdr "AC12: schema migration is explicit; fresh DB boots; legacy DB is refused"
FRESH_DB="$TMP/fresh.db"
FRESH_OK="$( ( cd "$ROOT/server" && node -e '
  const { createStore } = require("./src/db");
  const s = createStore(process.argv[1]);
  s.close();
  console.log("ok");
' "$FRESH_DB" 2>&1 ) )"
note "fresh DB boots cleanly -> $FRESH_OK"

SCHEMA_COLS="$(node scripts/sqlite-cli.js "$FRESH_DB" "PRAGMA table_info(users)" 2>/dev/null | tr '\n' ';' || true)"
HAS_FBUID="$(echo "$SCHEMA_COLS" | grep -c 'firebase_uid' || true)"
HAS_PWHASH="$(echo "$SCHEMA_COLS" | grep -c 'password_hash' || true)"
note "users table columns -> $SCHEMA_COLS"
note "has firebase_uid: $HAS_FBUID ; has password_hash (should be 0): $HAS_PWHASH"

LEGACY_DB="$TMP/legacy.db"
# Prepared statement + placeholders, deliberately: raw SQL string literals
# would need one more layer of quote-escaping (bash single-quotes wrapping a
# JS string wrapping a SQL string) than is worth fighting for two values.
( cd "$ROOT/server" && node -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1]);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT NOT NULL)");
  db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
    .run("legacyuser", "$2b$10$fakefakefakefakefakefakefake");
  db.close();
' "$LEGACY_DB" )
LEGACY_REFUSAL="$( ( cd "$ROOT/server" && node -e '
  const { createStore } = require("./src/db");
  try { createStore(process.argv[1]); console.log("DID NOT REFUSE"); }
  catch (err) { console.log("REFUSED: " + err.name + ": " + err.message.slice(0,60)); }
' "$LEGACY_DB" ) )"
note "legacy password_hash DB -> $LEGACY_REFUSAL"
LEGACY_DATA_INTACT="$(node scripts/sqlite-cli.js "$LEGACY_DB" "SELECT username FROM users" 2>/dev/null || true)"
note "legacy DB's data still intact after the refused open -> $LEGACY_DATA_INTACT"

if [ "$FRESH_OK" = "ok" ] && [ "$HAS_FBUID" -ge "1" ] && [ "$HAS_PWHASH" = "0" ] \
   && [[ "$LEGACY_REFUSAL" == REFUSED:* ]] && [ "$LEGACY_DATA_INTACT" = "legacyuser" ]; then
  pass 12 "fresh DB has firebase_uid/no password_hash; a legacy password_hash DB is refused at startup with data left untouched"
else
  fail 12 "fresh=$FRESH_OK fbuid=$HAS_FBUID pwhash=$HAS_PWHASH legacy='$LEGACY_REFUSAL' data='$LEGACY_DATA_INTACT'"
fi

# ---------------------------------------------------------------- AC13
hdr "AC13: nothing outside this round's authorized scope (WEAPON COMBINATION SYSTEM) changed; the engine regression suite passes"
# THIS ROUND'S SCOPE IS DIFFERENT FROM THE LAST ONE. The previous round --
# DISTINCT ALIEN CLASSES -- authorized js/core.js, js/entities.js and
# js/game.js and froze js/hud.js. This round is the WEAPON COMBINATION SYSTEM
# (exactly ONE combination: PIERCING LASER + BOUNCING SHOT fused onto a single
# bullet), so js/hud.js comes BACK OUT of the frozen list and IS AUTHORIZED
# this round: the combination is a real pick-screen card, so it needs its own
# UPGRADES table entry (name/blurb/colour) and its own icon glyph, and the
# card list has to be read from game.upgradeChoices() instead of
# CONFIG.UPGRADE.IDS. js/entities.js stays authorized too -- Player.fire() is
# where the two field sets are unioned.
#
# server/ is FULLY FROZEN this round, with NO carve-out at all. The reason it
# needs none is arithmetic, and it is MACHINE-CHECKED in (e) below rather than
# merely asserted here: a bouncing bullet survives WALLS, it does not kill more
# aliens, so the combined shot's kill ceiling is still exactly
# 1 + UPGRADE.PIERCE_COUNT = 3 aliens per trigger pull -- precisely the
# BEST_ALIENS_PER_SHOT that server/src/anticheat.js already assumes for bound 1.
# (scripts/check-game.js scenario 29 brute-forces 60 combined flights -- 15
# launch x positions x both launch sides x 2 heights -- through a full swarm and
# confirms no flight ever EXCEEDS that ceiling; what it asserts is the upper
# bound plus non-vacuity, not an exact worst-case number. Scenario 31 runs the
# same ceiling check with the SHIELD alien's redirect in the mix, which is the
# one cross-feature path that could have leaked an extra kill into a trigger
# pull.) The combination also carries
# NO score bonus of its own -- each kill pays its own SCORE.ROW value at the
# multiplier already in force -- so BEST_ALIEN_SCORE and COMBO_MAX are
# unchanged, PEAK_SCORE_PER_SECOND stays ~522/s and bound 2's 800/s ceiling
# needs no re-derivation either. Nothing under server/ may change, and the whole
# tree is checked below with no exclusions.
#
# The check is still the same two halves:
#   (a) everything the round was NOT authorized to touch is still untouched,
#       and
#   (b) the authorized engine files pass scripts/check-game.js, which is the
#       real regression gate for them (its scenario 1 is a golden per-tick
#       checksum against the PRE-feature game, so classic play being
#       bit-identical is still proven -- just by behaviour, not by bytes).
#
# Authorized to change this round, hence excluded from (a):
#   js/core.js                            (UPGRADE.COMBINED_ID + UPGRADE
#                                          .COMBINES, COLORS.pierceBounce,
#                                          VERSION)
#   js/entities.js                        (Player.fire()'s pierce/bounce
#                                          if/else-if split into two
#                                          INDEPENDENT ifs, plus the combined
#                                          colour override -- no new Bullet
#                                          field, collide() untouched)
#   js/game.js                            (Game.upgradeChoices(), and the pick
#                                          screen's hit-test / tick / apply
#                                          reading it instead of UPGRADE.IDS)
#   js/hud.js                             (the pierce_bounce UPGRADES entry,
#                                          its icon, the card list read from
#                                          game.upgradeChoices(), and the card
#                                          count passed to drawUpgradeCard)
#   scripts/check-game.js                 (scenarios 28-31 appended -- 31 is
#                                          the combined bullet vs the SHIELD
#                                          alien's redirect; NO pre-existing
#                                          scenario (1-27) or shared helper
#                                          was modified this round)
#   scripts/verify.sh                     (this retarget)
#   README.md FEATURES.md                 (the docs for the above)
#   package.json                          (the "version" field ONLY, bumped to
#                                          1.3.0 with CONFIG.VERSION -- AC15
#                                          below is what checks they agree)
# NOT authorized: js/net.js (frozen -- the combination is engine-only and the
# opt-in leaderboard bridge has nothing to say about it) and every path under
# server/ (frozen -- no new kill ceiling, no score bonus, nothing to
# re-derive; see (e)).

# --- (a) untouched-outside-scope, tracked AND untracked -----------------
FROZEN_ENGINE="js/audio.js js/starfield.js js/particles.js js/props.js js/main.js css/style.css index.html js/net.js"
FROZEN_MOBILE="android ios capacitor.config.json package-lock.json"
DIRTY_ENGINE="$(git status --porcelain --untracked-files=all -- $FROZEN_ENGINE)"
DIRTY_MOBILE="$(git status --porcelain --untracked-files=all -- $FROZEN_MOBILE)"
DIRTY_SERVER="$(git status --porcelain --untracked-files=all -- server)"
DIRTY_SCRIPTS="$(git status --porcelain --untracked-files=all -- scripts \
  ':(exclude)scripts/check-game.js' ':(exclude)scripts/verify.sh')"
# package.json is authorized for its "version" field ONLY, so do not simply
# exclude it -- pin the claim instead: every added/removed line in its diff
# must BE a "version" line. Anything else (a new dependency, a changed script,
# a stray edit) still trips AC13.
DIRTY_PKGJSON="$(git diff HEAD -- package.json | grep -E '^[+-]' \
  | grep -vE '^(\+\+\+|---)' | grep -vE '^[+-][[:space:]]*"version":' || true)"
DIRTY="$DIRTY_ENGINE$DIRTY_MOBILE$DIRTY_SERVER$DIRTY_SCRIPTS$DIRTY_PKGJSON"
note "8 frozen engine files + css + index.html + net.js -> '${DIRTY_ENGINE:-<clean>}'"
note "android/ ios/ capacitor.config.json package-lock.json      -> '${DIRTY_MOBILE:-<clean>}'"
note "ALL of server/ (no carve-out at all this round)            -> '${DIRTY_SERVER:-<clean>}'"
note "pre-existing scripts/* (minus check-game.js + verify.sh)    -> '${DIRTY_SCRIPTS:-<clean>}'"
note "package.json lines changed that are NOT the version field  -> '${DIRTY_PKGJSON:-<clean>}'"

GSTATIC_IN_HTML="$(grep -c 'gstatic\|firebase' index.html || true)"
ORDER="$(grep -o 'js/[a-z]*\.js' index.html | paste -sd, -)"
EXPECTED="js/core.js,js/fx.js,js/audio.js,js/input.js,js/starfield.js,js/particles.js,js/entities.js,js/props.js,js/hud.js,js/game.js,js/main.js,js/net.js"
note "script order: $ORDER"
note "gstatic/firebase references directly in index.html: $GSTATIC_IN_HTML (must be 0 -- the SDK is injected by net.js at runtime, never present in the HTML source)"

# --- (b) the engine regression gate -------------------------------------
CHECKGAME_OK=1
if node scripts/check-game.js > "$TMP/checkgame.log" 2>&1; then
  note "node scripts/check-game.js -> exit 0"
  note "$(grep -E '^[0-9]+/[0-9]+ checks passed' "$TMP/checkgame.log" | tail -1)"
  note "$(grep -c '^  PASS' "$TMP/checkgame.log") scenarios PASS, $(grep -c '^  FAIL' "$TMP/checkgame.log") FAIL"
else
  CHECKGAME_OK=0
  note "node scripts/check-game.js FAILED:"
  note "$(grep -E '^\s+FAIL|^  FAIL' "$TMP/checkgame.log" | head -10)"
fi

# --- (c) the anti-cheat mirror actually mirrors --------------------------
# STANDING REGRESSION CHECK, not specific to any one round. COMBO_MAX in
# server/src/anticheat.js is a hand-copied mirror of js/core.js's
# CONFIG.COMBO.MAX, and bound 2's ceiling is derived from it, so drift between
# the two is a stale-bound bug that would falsely reject a legitimate run.
# This round changes neither side (server/ is frozen and COMBO.MAX is
# untouched), so it is expected to pass unchanged -- which is the point of
# keeping it: it is what would catch a future round quietly breaking the
# mirror. Checked by value rather than by trusting the comment.
# Anchored at line start so BOUNCE_MAX and friends cannot match instead.
CORE_COMBO_MAX="$(grep -oE '^[[:space:]]+MAX: [0-9]+' js/core.js | head -1 | grep -oE '[0-9]+')"
AC_COMBO_MAX="$(node -e "process.stdout.write(String(require('./server/src/anticheat.js').COMBO_MAX))" 2>/dev/null || true)"
AC_CEILING="$(node -e "process.stdout.write(String(require('./server/src/anticheat.js').DEFAULTS.maxScorePerSecond))" 2>/dev/null || true)"
AC_PEAK="$(node -e "process.stdout.write(String(Math.round(require('./server/src/anticheat.js').PEAK_SCORE_PER_SECOND)))" 2>/dev/null || true)"
COMBO_SYNC=0
[ -n "$CORE_COMBO_MAX" ] && [ "$CORE_COMBO_MAX" = "$AC_COMBO_MAX" ] && COMBO_SYNC=1
note "COMBO.MAX: js/core.js=$CORE_COMBO_MAX  server/src/anticheat.js COMBO_MAX=$AC_COMBO_MAX (must match)"
note "bound 2: derived peak ~$AC_PEAK/s -> enforced default ceiling $AC_CEILING/s (must be >= the peak)"
CEILING_OK=0
if [ -n "$AC_CEILING" ] && [ -n "$AC_PEAK" ] && [ "$AC_CEILING" -ge "$AC_PEAK" ]; then
  CEILING_OK=1
fi

# --- (d) no NEW shadowBlur call site --------------------------------------
# Glow is faked with prerendered additive sprite blits on purpose; the
# expensive shadowBlur is reserved for exactly two existing places -- the
# player ship's own draw (js/entities.js) and HUD text (js/hud.js).
SHADOW_ADDED="$(git diff HEAD -- js/core.js js/entities.js js/game.js js/hud.js js/input.js js/fx.js \
  | grep '^+' | grep -v '^+++' | grep -c 'shadowBlur' || true)"
note "shadowBlur occurrences on ADDED lines in js/core.js+js/entities.js+js/game.js+js/hud.js+js/input.js+js/fx.js: $SHADOW_ADDED (must be 0 -- the ship's draw and the HUD text stay the only two call sites)"
SHADOW_OK=0
[ "$SHADOW_ADDED" = "0" ] && SHADOW_OK=1

# --- (e) the combined shot's kill ceiling is the server's bound ------------
# THIS ROUND'S machine check for "server/ needed no carve-out", mirroring the
# COMBO_MAX cross-check in (c) above. The WEAPON COMBINATION fuses PIERCING
# LASER onto BOUNCING SHOT; bouncing lets a bullet survive a WALL, which is
# not a kill, so the combined shot still removes at most
#   1 (the hit that spends the shot) + UPGRADE.PIERCE_COUNT (the hits it
#   survives) = 3
# aliens per trigger pull. server/src/anticheat.js derives bound 1's
# shots-per-wave floor from BEST_ALIENS_PER_SHOT, so as long as those two
# numbers satisfy 1 + PIERCE_COUNT == BEST_ALIENS_PER_SHOT the server bound is
# still exactly right and nothing under server/ has to change. Both values are
# read from their REAL source files -- PIERCE_COUNT grepped out of js/core.js,
# BEST_ALIENS_PER_SHOT required out of the (dependency-free) anticheat module
# -- rather than restated here, so a future retune of either side fails loudly.
# scripts/check-game.js scenarios 29 and 31 make the same claim behaviourally:
# 29 brute-forces 60 combined flights through a full swarm and 31 re-runs the
# ceiling with a SHIELD alien redirecting one of the kills. Both assert that no
# flight EXCEEDS the ceiling (plus non-vacuity), not an exact worst case.
CORE_PIERCE_COUNT="$(grep -oE '^[[:space:]]+PIERCE_COUNT: [0-9]+' js/core.js \
  | head -1 | grep -oE '[0-9]+')"
AC_BEST_PER_SHOT="$(node -e "process.stdout.write(String(require('./server/src/anticheat.js').BEST_ALIENS_PER_SHOT))" 2>/dev/null || true)"
PIERCE_SYNC=0
if [ -n "$CORE_PIERCE_COUNT" ] && [ -n "$AC_BEST_PER_SHOT" ] \
   && [ "$((1 + CORE_PIERCE_COUNT))" = "$AC_BEST_PER_SHOT" ]; then
  PIERCE_SYNC=1
fi
note "kill ceiling: 1 + js/core.js UPGRADE.PIERCE_COUNT ($CORE_PIERCE_COUNT) = $((1 + ${CORE_PIERCE_COUNT:-0})) vs server/src/anticheat.js BEST_ALIENS_PER_SHOT=$AC_BEST_PER_SHOT (must be equal -- this is why server/ stayed frozen)"

if [ -z "$DIRTY" ] && [ "$ORDER" = "$EXPECTED" ] && [ "$GSTATIC_IN_HTML" = "0" ] \
   && [ "$CHECKGAME_OK" = "1" ] && [ "$COMBO_SYNC" = "1" ] && [ "$CEILING_OK" = "1" ] \
   && [ "$SHADOW_OK" = "1" ] && [ "$PIERCE_SYNC" = "1" ]; then
  pass 13 "every path in this round's frozen-file list is byte-identical to HEAD -- 7 engine files (js/hud.js is AUTHORIZED this round: the combination is a real pick-screen card and needs its own UPGRADES entry and icon), css, index.html, net.js, android/ios/capacitor, package-lock.json, pre-existing scripts/*, and ALL of server/ with no carve-out at all -- and package.json's only changed line is its version field (note: this is an allowlist of enumerated paths, not a whole-tree scan, so paths in neither the frozen nor the authorized list are outside what AC13 inspects); script order is the original 11 tags + net.js; no gstatic/firebase in index.html; server/src/anticheat.js's COMBO_MAX still mirrors js/core.js and its ceiling still clears the derived peak; 1 + UPGRADE.PIERCE_COUNT still equals BEST_ALIENS_PER_SHOT, which is the machine proof that the combined bullet needs no anti-cheat re-derivation; this round introduced no new shadowBlur call site in any of the four authorized engine files; and scripts/check-game.js passes every scenario, which is what gates js/core.js, js/entities.js, js/game.js and js/hud.js"
else
  fail 13 "dirty='$DIRTY' order_ok=$([ "$ORDER" = "$EXPECTED" ] && echo yes || echo no) gstatic=$GSTATIC_IN_HTML check_game_ok=$CHECKGAME_OK combo_mirror_ok=$COMBO_SYNC ceiling_ok=$CEILING_OK shadowblur_ok=$SHADOW_OK (added=$SHADOW_ADDED) pierce_ceiling_ok=$PIERCE_SYNC (1+$CORE_PIERCE_COUNT vs $AC_BEST_PER_SHOT)"
fi

# ---------------------------------------------------------------- AC14
hdr "AC14: docs state the anti-cheat's real limits and the Firebase migration decision"
AC14_BAD=""
for pat in "not a replay engine" "plausibility" "patient" "breaking" "no migration\|no data to migrate\|nothing to migrate" "PHASE0_"; do
  grep -qi -- "$pat" server/README.md || AC14_BAD="$AC14_BAD README:$pat"
done
note "server/README.md -> $(wc -l < server/README.md) lines"
if [ -z "$AC14_BAD" ]; then
  pass 14 "server/README.md states the anti-cheat's honest limits, the breaking migration decision, and the Phase 0 outcome"
else
  fail 14 "missing statements:$AC14_BAD"
fi

# ---------------------------------------------------------------- AC15
hdr "AC15: the version shown on the title screen matches package.json, and is genuinely rendered"
CORE_VERSION="$(grep -oE "VERSION: '[^']+'" js/core.js | head -1 | sed -E "s/VERSION: '([^']+)'/\1/")"
PKG_VERSION="$(node -e "console.log(require('./package.json').version)" 2>/dev/null)"
if [ -n "$CORE_VERSION" ] && [ "$CORE_VERSION" = "$PKG_VERSION" ] \
   && grep -q 'CONFIG.VERSION\|C\.VERSION' js/hud.js; then
  pass 15 "js/core.js CONFIG.VERSION ($CORE_VERSION) matches package.json ($PKG_VERSION), and js/hud.js draws it"
else
  fail 15 "core=$CORE_VERSION pkg=$PKG_VERSION hud_draws=$(grep -q 'CONFIG.VERSION\|C\.VERSION' js/hud.js && echo yes || echo no)"
fi

# ---------------------------------------------------------------- AC16
hdr "AC16: full automated suite passes end to end"
if ( cd server && FIREBASE_AUTH_EMULATOR_HOST="$EMULATOR_HOST" FIREBASE_PROJECT_ID="$PROJECT" npm test ) \
    > "$TMP/npmtest.log" 2>&1; then
  note "$(grep -E '^# (tests|pass|fail|skipped)' "$TMP/npmtest.log" | paste -sd' ' - || tail -5 "$TMP/npmtest.log")"
  NPM_TEST_OK=1
else
  note "server npm test FAILED"
  tail -30 "$TMP/npmtest.log"
  NPM_TEST_OK=0
fi

CHECKNET_OK=1
node scripts/check-net.js >/dev/null 2>&1 || CHECKNET_OK=0

VERIFY_AC_FAILED=0
for r in "${RESULTS[@]}"; do
  case "$r" in AC*': FAIL'*) VERIFY_AC_FAILED=1 ;; esac
done

# CHECKGAME_OK was set by AC13 above; named here too so the engine suite is
# explicitly part of the "full suite" claim, not only of AC13's.
if [ "$NPM_TEST_OK" = "1" ] && [ "$CHECKNET_OK" = "1" ] \
   && [ "${CHECKGAME_OK:-0}" = "1" ] && [ "$VERIFY_AC_FAILED" = "0" ]; then
  pass 16 "npm test exit 0, check-net.js exit 0, check-game.js exit 0, and every AC1-AC15 above is PASS or the documented emulator-fallback PARTIAL"
else
  fail 16 "npm_test_ok=$NPM_TEST_OK checknet_ok=$CHECKNET_OK checkgame_ok=${CHECKGAME_OK:-0} any_ac_failed=$VERIFY_AC_FAILED"
fi

# ============================================================ REGRESSION
# Checks from the prior round that this round's AC1-15 don't restate, kept so
# they still gate overall pass/fail.

hdr "REGRESSION: Capacitor platform scaffolds still exist"
REG_MISSING=""
for f in android/app/build.gradle android/gradlew android/settings.gradle \
         android/app/src/main/AndroidManifest.xml \
         ios/App/Podfile ios/App/App/Info.plist \
         ios/App/App/AppDelegate.swift; do
  if [ -e "$f" ]; then note "present: $f"; else note "MISSING: $f"; REG_MISSING="$REG_MISSING $f"; fi
done
if [ -d ios/App/App.xcodeproj ]; then note "present: ios/App/App.xcodeproj/"; else REG_MISSING="$REG_MISSING ios/App/App.xcodeproj"; fi
if [ -z "$REG_MISSING" ]; then
  rpass CAPACITOR-SCAFFOLD "all standard platform files present"
else
  rfail CAPACITOR-SCAFFOLD "missing:$REG_MISSING"
fi

hdr "REGRESSION: cap sync + web assets match www/"
node scripts/copy-web.js >/dev/null 2>&1
if npx cap sync > "$TMP/sync.log" 2>&1; then SYNC_EXIT=0; else SYNC_EXIT=$?; fi
note "npx cap sync -> exit $SYNC_EXIT"
REG_AC9_BAD=0
for P in android/app/src/main/assets/public ios/App/App/public; do
  while IFS= read -r f; do
    rel="${f#www/}"
    if ! cmp -s "$f" "$P/$rel"; then note "MISMATCH: $rel in $P"; REG_AC9_BAD=1; fi
  done < <(find www -type f)
  note "$P: all $(find www -type f | wc -l) www files byte-identical"
done
if [ "$SYNC_EXIT" = "0" ] && [ "$REG_AC9_BAD" = "0" ]; then
  rpass CAP-SYNC "cap sync exit 0; every www/ file byte-identical in both platform dirs"
else
  rfail CAP-SYNC "sync_exit=$SYNC_EXIT mismatches=$REG_AC9_BAD"
fi

hdr "REGRESSION: placeholder PNGs still valid in both platforms"
PNG_CHECK="$(node -e '
const fs=require("fs");const path=require("path");
const roots=["android/app/src/main/res","ios/App/App/Assets.xcassets"];
const SIG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
let n=0,bad=[];
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const p=path.join(d,e.name);
  if(e.isDirectory())walk(p);
  else if(p.endsWith(".png")){
    const b=fs.readFileSync(p);n++;
    if(!b.subarray(0,8).equals(SIG))bad.push(p+" bad signature");
    else if(b.subarray(12,16).toString("ascii")!=="IHDR")bad.push(p+" no IHDR");
    else if(b.subarray(b.length-8,b.length-4).toString("ascii")!=="IEND")bad.push(p+" no IEND");
    else if(b.readUInt32BE(16)<1||b.readUInt32BE(20)<1)bad.push(p+" zero dimension");
  }}}
for(const r of roots){if(fs.existsSync(r))walk(r);else bad.push(r+" missing");}
console.log(JSON.stringify({count:n,bad}));')"
note "$PNG_CHECK"
if node -e "const r=JSON.parse(process.argv[1]);process.exit(r.bad.length===0&&r.count>0?0:1)" "$PNG_CHECK"; then
  rpass PNG-VALIDITY "$(node -e "console.log(JSON.parse(process.argv[1]).count)" "$PNG_CHECK") PNGs verified valid"
else
  rfail PNG-VALIDITY "invalid PNGs: $PNG_CHECK"
fi

hdr "REGRESSION: nothing secret or generated is tracked"
BADTRACK="$(git ls-files | grep -E '(\.db$|\.db-|^\.env|/\.env$|(^|/)node_modules/|^www/|^server/data/)' || true)"
UNTRACKED_BAD="$(git status --porcelain --untracked-files=all | awk '/^\?\?/{print $2}' \
  | grep -E '(\.db$|^\.env|/\.env$|(^|/)node_modules/|^www/|^server/data/)' || true)"
note "tracked offenders -> '${BADTRACK:-<none>}' ; untracked-but-not-ignored -> '${UNTRACKED_BAD:-<none>}'"
LEAK="$(git ls-files -co --exclude-standard \
  | grep -vE '(^scripts/verify\.sh$|^server/README\.md$|^server/\.env\.example$)' \
  | xargs grep -lE '(JWT_SECRET|GOOGLE_APPLICATION_CREDENTIALS)\s*=\s*["'"'"']?[A-Za-z0-9+/._-]{16,}' 2>/dev/null || true)"
note "files with a literal long secret-shaped value -> '${LEAK:-<none>}'"
if [ -z "$BADTRACK" ] && [ -z "$UNTRACKED_BAD" ] && [ -z "$LEAK" ]; then
  rpass SECRET-HYGIENE "no *.db/.env/www//node_modules tracked or unignored; no literal secret in committable files"
else
  rfail SECRET-HYGIENE "tracked='$BADTRACK' untracked='$UNTRACKED_BAD' leak='$LEAK'"
fi

hdr "REGRESSION: docs/MOBILE.md still states what was NOT done"
REG_MOBILE_BAD=""
for pat in "NOT" "No APK" "No IPA" "never" "signed"; do
  grep -qi -- "$pat" docs/MOBILE.md || REG_MOBILE_BAD="$REG_MOBILE_BAD MOBILE:$pat"
done
if [ -z "$REG_MOBILE_BAD" ]; then
  rpass MOBILE-DOCS "docs/MOBILE.md carries its 'NOT done' section"
else
  rfail MOBILE-DOCS "missing:$REG_MOBILE_BAD"
fi

# ------------------------------------------------------------------- summary
hdr "SUMMARY"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo
if [ "$FAILED" = "0" ]; then
  echo "All acceptance checks reported PASS (or a clearly-labeled PARTIAL)."
  echo "NOTE: this proves scaffolding + backend + anti-cheat + Firebase-verification"
  echo "behaviour only. No APK/IPA was compiled, nothing was signed, and nothing ran"
  echo "on a device or simulator. The client sign-in path was proven against a real"
  echo "emulator/server round trip but never against a real browser executing the"
  echo "actual Firebase JS SDK -- see server/README.md."
else
  echo "One or more acceptance checks FAILED."
fi
exit "$FAILED"
