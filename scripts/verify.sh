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
# Does NOT compile anything native: no Gradle, no Xcode, no APK, no IPA.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILED=0
declare -a RESULTS=()

pass() { RESULTS+=("AC$1: PASS -- $2"); }
fail() { RESULTS+=("AC$1: FAIL -- $2"); FAILED=1; }
partial() { RESULTS+=("AC$1: PARTIAL -- $2"); }

note() { printf '    %s\n' "$*"; }
hdr()  { printf '\n=== %s ===\n' "$*"; }

TMP="$(mktemp -d)"
DB="$TMP/verify.db"
PORT=3517
BASE="http://127.0.0.1:$PORT"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

jsonfield() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);
      process.stdout.write(v===undefined||v===null?"":String(v));}catch(e){process.stdout.write("");}
  });' "$1"; }

# ---------------------------------------------------------------- AC1
hdr "AC1: server starts, /api/health -> 200"
( cd "$ROOT/server" && exec env DB_PATH="$DB" PORT="$PORT" NODE_ENV=development \
    JWT_SECRET="verify-run-only-secret-$$" \
    RATE_LIMIT_REGISTER_MAX=200 RATE_LIMIT_LOGIN_MAX=200 \
    node src/index.js ) >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

HEALTH=""
for _ in $(seq 1 60); do
  HEALTH="$(curl -s -o "$TMP/health.json" -w '%{http_code}' "$BASE/api/health" 2>/dev/null || true)"
  [ "$HEALTH" = "200" ] && break
  sleep 0.25
done
note "GET /api/health -> HTTP $HEALTH  body=$(cat "$TMP/health.json" 2>/dev/null)"
if [ "$HEALTH" = "200" ] && [ "$(jsonfield ok < "$TMP/health.json")" = "true" ]; then
  pass 1 "GET /api/health -> 200 {ok:true}"
else
  fail 1 "health check returned HTTP '$HEALTH'; see $TMP/server.log"
fi

# ---------------------------------------------------------------- AC2
hdr "AC2: bcrypt hash in DB, plaintext nowhere"
PW='corr3ct-horse-batt3ry'
REG_CODE="$(curl -s -o "$TMP/reg.json" -w '%{http_code}' -XPOST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' -d "{\"username\":\"verifyalice\",\"password\":\"$PW\"}")"
note "POST /api/auth/register -> HTTP $REG_CODE"
TOKEN="$(jsonfield token < "$TMP/reg.json")"

HASH="$(node scripts/sqlite-cli.js "$DB" \
  "SELECT password_hash FROM users WHERE username='verifyalice'" 2>/dev/null || true)"
note "sqlite: SELECT password_hash -> $HASH"
node scripts/sqlite-cli.js "$DB" --dump > "$TMP/dump.txt" 2>/dev/null || true
note "full DB dump: $(wc -l < "$TMP/dump.txt") value(s)"

if [ "$REG_CODE" = "201" ] \
   && [[ "$HASH" =~ ^\$2[aby]\$[0-9]{2}\$.{53}$ ]] \
   && ! grep -qF "$PW" "$TMP/dump.txt"; then
  pass 2 "hash '$(printf '%.29s' "$HASH")...' is bcrypt format; plaintext absent from full DB dump"
else
  fail 2 "register=$REG_CODE hash='$HASH' plaintext_found=$(grep -cF "$PW" "$TMP/dump.txt")"
fi

# ---------------------------------------------------------------- AC3
hdr "AC3: duplicate register 4xx; login right/wrong password"
DUP="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' -d "{\"username\":\"verifyalice\",\"password\":\"$PW\"}")"
GOOD="$(curl -s -o "$TMP/login.json" -w '%{http_code}' -XPOST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"username\":\"verifyalice\",\"password\":\"$PW\"}")"
BAD="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"verifyalice","password":"wrong-password"}')"
LOGIN_TOKEN="$(jsonfield token < "$TMP/login.json")"
note "duplicate register -> HTTP $DUP"
note "login correct password -> HTTP $GOOD (token length ${#LOGIN_TOKEN})"
note "login wrong password   -> HTTP $BAD"
if [ "$DUP" = "409" ] && [ "$GOOD" = "200" ] && [ -n "$LOGIN_TOKEN" ] && [ "$BAD" = "401" ]; then
  pass 3 "duplicate=409, good login=200 with token, bad login=401"
else
  fail 3 "duplicate=$DUP good=$GOOD token_len=${#LOGIN_TOKEN} bad=$BAD"
fi

# ---------------------------------------------------------------- AC4
hdr "AC4: POST /api/scores auth gate + row lands in DB"
NOAUTH="$(curl -s -o /dev/null -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H 'Content-Type: application/json' -d '{"score":1234,"wave":3}')"
WITH="$(curl -s -o "$TMP/score.json" -w '%{http_code}' -XPOST "$BASE/api/scores" \
  -H "Authorization: Bearer $LOGIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"score":1234,"wave":3}')"
ROW="$(node scripts/sqlite-cli.js "$DB" \
  "SELECT s.score, s.wave FROM scores s JOIN users u ON u.id=s.user_id WHERE u.username='verifyalice' AND s.score=1234" 2>/dev/null || true)"
note "POST /api/scores (no token)   -> HTTP $NOAUTH"
note "POST /api/scores (with token) -> HTTP $WITH  body=$(cat "$TMP/score.json")"
note "sqlite: matching row -> '$ROW'"
if [ "$NOAUTH" = "401" ] && [ "$WITH" = "201" ] && [ "$ROW" = "1234|3" ]; then
  pass 4 "no token=401, with token=201, DB row '1234|3' present"
else
  fail 4 "noauth=$NOAUTH with=$WITH row='$ROW'"
fi

# ---------------------------------------------------------------- AC5
hdr "AC5: leaderboard order/limit + personal best vs MAX(score)"
for i in 1 2 3; do
  T="$(curl -s -XPOST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
      -d "{\"username\":\"verifyp$i\",\"password\":\"password-$i-long\"}" | jsonfield token)"
  curl -s -o /dev/null -XPOST "$BASE/api/scores" -H "Authorization: Bearer $T" \
    -H 'Content-Type: application/json' -d "{\"score\":$((i * 1000)),\"wave\":$i}"
  curl -s -o /dev/null -XPOST "$BASE/api/scores" -H "Authorization: Bearer $T" \
    -H 'Content-Type: application/json' -d "{\"score\":$((i * 10)),\"wave\":1}"
done
curl -s -XPOST "$BASE/api/scores" -H "Authorization: Bearer $LOGIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"score":7777,"wave":9}' -o /dev/null

API_LB="$(curl -s "$BASE/api/leaderboard?limit=3" \
  | node -e 's="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const e=JSON.parse(s).entries;console.log(e.map(x=>x.username+"="+x.score).join(","));})')"
DB_LB="$(node scripts/sqlite-cli.js "$DB" \
  "SELECT u.username || '=' || MAX(s.score) FROM scores s JOIN users u ON u.id=s.user_id GROUP BY s.user_id ORDER BY MAX(s.score) DESC LIMIT 3" \
  | paste -sd, -)"
note "API  /api/leaderboard?limit=3 -> $API_LB"
note "sqlite equivalent            -> $DB_LB"

PB_API="$(curl -s "$BASE/api/scores/me" -H "Authorization: Bearer $LOGIN_TOKEN" | jsonfield score)"
PB_DB="$(node scripts/sqlite-cli.js "$DB" \
  "SELECT MAX(s.score) FROM scores s JOIN users u ON u.id=s.user_id WHERE u.username='verifyalice'")"
note "API  /api/scores/me -> $PB_API"
note "sqlite MAX(score)   -> $PB_DB"

SORTED="$(curl -s "$BASE/api/leaderboard?limit=100" | node -e 's="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const e=JSON.parse(s).entries;let ok=true;
  for(let i=1;i<e.length;i++) if(e[i-1].score<e[i].score) ok=false;
  const uniq=new Set(e.map(x=>x.username)).size===e.length;
  const ranks=e.every((x,i)=>x.rank===i+1);
  console.log(ok&&uniq&&ranks?"yes":"no");})')"
CAP="$(curl -s "$BASE/api/leaderboard?limit=3" | node -e 's="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).entries.length))')"
BADLIMIT="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/leaderboard?limit=abc")"
note "sorted desc + unique users + sequential ranks -> $SORTED ; limit=3 returned $CAP ; limit=abc -> HTTP $BADLIMIT"

if [ "$API_LB" = "$DB_LB" ] && [ "$PB_API" = "$PB_DB" ] && [ "$SORTED" = "yes" ] \
   && [ "$CAP" = "3" ] && [ "$BADLIMIT" = "400" ]; then
  pass 5 "leaderboard matches direct SQL ($API_LB); personal best $PB_API == MAX(score) $PB_DB"
else
  fail 5 "api='$API_LB' db='$DB_LB' pb_api=$PB_API pb_db=$PB_DB sorted=$SORTED cap=$CAP badlimit=$BADLIMIT"
fi

# ---------------------------------------------------------------- AC6
hdr "AC6: existing game files untouched; index.html +1 line only"
EXISTING="js/core.js js/fx.js js/audio.js js/input.js js/starfield.js js/particles.js js/entities.js js/props.js js/hud.js js/game.js js/main.js css/style.css"
DIRTY="$(git diff --name-only HEAD -- $EXISTING)"
note "git diff HEAD on the 11 js files + css/style.css -> '${DIRTY:-<empty>}'"

IDX_ADD="$(git diff -U0 HEAD -- index.html | grep -c '^+[^+]')"
IDX_DEL="$(git diff -U0 HEAD -- index.html | grep -c '^-[^-]')"
IDX_LINE="$(git diff -U0 HEAD -- index.html | grep '^+[^+]' || true)"
note "index.html: $IDX_ADD added line(s), $IDX_DEL removed line(s)"
note "added line: $IDX_LINE"

ORDER="$(grep -o 'js/[a-z]*\.js' index.html | paste -sd, -)"
EXPECTED="js/core.js,js/fx.js,js/audio.js,js/input.js,js/starfield.js,js/particles.js,js/entities.js,js/props.js,js/hud.js,js/game.js,js/main.js,js/net.js"
note "script order: $ORDER"

if [ -z "$DIRTY" ] && [ "$IDX_ADD" = "1" ] && [ "$IDX_DEL" = "0" ] \
   && [ "$IDX_LINE" = '+  <script src="js/net.js"></script>' ] && [ "$ORDER" = "$EXPECTED" ]; then
  pass 6 "12 existing files byte-identical; index.html = +1 line, original 11 tags in original order"
else
  fail 6 "dirty='$DIRTY' added=$IDX_ADD removed=$IDX_DEL order_ok=$([ "$ORDER" = "$EXPECTED" ] && echo yes || echo no)"
fi

# ---------------------------------------------------------------- AC7
hdr "AC7: node scripts/check-net.js"
if node scripts/check-net.js > "$TMP/checknet.log" 2>&1; then
  note "$(tail -3 "$TMP/checknet.log")"
  pass 7 "$(grep -o '[0-9]* checks run, [0-9]* problem(s).' "$TMP/checknet.log" | tail -1) exit=0"
else
  note "$(tail -20 "$TMP/checknet.log")"
  fail 7 "check-net.js exited non-zero"
fi

# ---------------------------------------------------------------- AC8
hdr "AC8: capacitor platform scaffolds exist"
AC8_MISSING=""
for f in android/app/build.gradle android/gradlew android/settings.gradle \
         android/app/src/main/AndroidManifest.xml \
         ios/App/Podfile ios/App/App/Info.plist \
         ios/App/App/AppDelegate.swift; do
  if [ -e "$f" ]; then note "present: $f"; else note "MISSING: $f"; AC8_MISSING="$AC8_MISSING $f"; fi
done
if [ -d ios/App/App.xcodeproj ]; then note "present: ios/App/App.xcodeproj/"; else AC8_MISSING="$AC8_MISSING ios/App/App.xcodeproj"; fi
if [ -z "$AC8_MISSING" ]; then
  pass 8 "cap add android & cap add ios both exited 0; all standard platform files present"
else
  fail 8 "missing:$AC8_MISSING"
fi

# ---------------------------------------------------------------- AC9
hdr "AC9: cap sync + web assets match www/"
node scripts/copy-web.js >/dev/null 2>&1
if npx cap sync > "$TMP/sync.log" 2>&1; then
  SYNC_EXIT=0
else
  SYNC_EXIT=$?
fi
note "npx cap sync -> exit $SYNC_EXIT"
grep -i 'warn' "$TMP/sync.log" | while read -r l; do note "sync warning: $l"; done

AC9_BAD=0
for P in android/app/src/main/assets/public ios/App/App/public; do
  while IFS= read -r f; do
    rel="${f#www/}"
    if ! cmp -s "$f" "$P/$rel"; then note "MISMATCH: $rel in $P"; AC9_BAD=1; fi
  done < <(find www -type f)
  note "$P: all $(find www -type f | wc -l) www files byte-identical"
done
if [ "$SYNC_EXIT" = "0" ] && [ "$AC9_BAD" = "0" ]; then
  pass 9 "cap sync exit 0; every www/ file byte-identical in both platform dirs (plus Capacitor's own cordova.js shims)"
else
  fail 9 "sync_exit=$SYNC_EXIT mismatches=$AC9_BAD"
fi

# ---------------------------------------------------------------- AC10
hdr "AC10: placeholder PNGs valid in both platforms' resource dirs"
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
const andr=fs.existsSync("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png");
const ios=fs.existsSync("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png");
console.log(JSON.stringify({count:n,bad,andr,ios}));')"
note "$PNG_CHECK"
if node -e "const r=JSON.parse(process.argv[1]);process.exit(r.bad.length===0&&r.count>0&&r.andr&&r.ios?0:1)" "$PNG_CHECK"; then
  pass 10 "$(node -e "console.log(JSON.parse(process.argv[1]).count)" "$PNG_CHECK") PNGs verified: signature + IHDR + IEND + non-zero dimensions, both platforms"
else
  fail 10 "invalid PNGs: $PNG_CHECK"
fi

# ---------------------------------------------------------------- AC11
hdr "AC11: nothing secret or generated is tracked"
BADTRACK="$(git ls-files | grep -E '(\.db$|\.db-|^\.env|/\.env$|(^|/)node_modules/|^www/|^server/data/)' || true)"
note "tracked offenders -> '${BADTRACK:-<none>}'"
UNTRACKED_BAD="$(git status --porcelain --untracked-files=all | awk '/^\?\?/{print $2}' \
  | grep -E '(\.db$|^\.env|/\.env$|(^|/)node_modules/|^www/|^server/data/)' || true)"
note "untracked-but-not-ignored offenders -> '${UNTRACKED_BAD:-<none>}'"
note "www/ ignored: $(git check-ignore -q www && echo yes || echo NO)"
note "server/data/x.db ignored: $(git check-ignore -q server/data/x.db && echo yes || echo NO)"
note "node_modules ignored: $(git check-ignore -q node_modules && echo yes || echo NO)"
LEAK="$(git ls-files -co --exclude-standard \
  | grep -vE '(^scripts/verify\.sh$|^server/README\.md$|^server/\.env\.example$)' \
  | xargs grep -lE 'JWT_SECRET\s*=\s*["'"'"']?[A-Za-z0-9+/]{24,}' 2>/dev/null || true)"
note "files with a literal long JWT_SECRET value -> '${LEAK:-<none>}'"
if [ -z "$BADTRACK" ] && [ -z "$UNTRACKED_BAD" ] && [ -z "$LEAK" ]; then
  pass 11 "no *.db/.env/www//node_modules tracked or unignored; no literal secret in committable files"
else
  fail 11 "tracked='$BADTRACK' untracked='$UNTRACKED_BAD' leak='$LEAK'"
fi

# ---------------------------------------------------------------- AC12
hdr "AC12: docs state what was NOT done"
AC12_BAD=""
for pat in "NOT" "No APK" "No IPA" "never" "signed"; do
  grep -qi -- "$pat" docs/MOBILE.md || AC12_BAD="$AC12_BAD MOBILE:$pat"
done
for pat in "What was NOT done" "anti-cheat" "HTTPS" "Remaining manual steps"; do
  grep -qi -- "$pat" server/README.md || AC12_BAD="$AC12_BAD SERVER:$pat"
done
grep -qi "Remaining manual steps" docs/MOBILE.md || AC12_BAD="$AC12_BAD MOBILE:manual-steps"
note "docs/MOBILE.md    -> $(wc -l < docs/MOBILE.md) lines"
note "server/README.md  -> $(wc -l < server/README.md) lines"
if [ -z "$AC12_BAD" ]; then
  pass 12 "both docs carry explicit 'NOT done' sections and remaining manual steps"
else
  fail 12 "missing statements:$AC12_BAD"
fi

# ------------------------------------------------------------ extra: unit tests
hdr "Extra: server unit tests"
if ( cd server && npm test ) > "$TMP/npmtest.log" 2>&1; then
  note "$(grep -E '^# (tests|pass|fail)' "$TMP/npmtest.log" | paste -sd' ' - || tail -3 "$TMP/npmtest.log")"
  note "server npm test: exit 0"
else
  note "server npm test FAILED"
  tail -20 "$TMP/npmtest.log"
  FAILED=1
fi

# ------------------------------------------------------------------- summary
hdr "SUMMARY"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo
if [ "$FAILED" = "0" ]; then
  echo "All acceptance checks reported PASS."
  echo "NOTE: this proves scaffolding + backend behaviour only. No APK/IPA was"
  echo "compiled, nothing was signed, and nothing ran on a device or simulator."
else
  echo "One or more acceptance checks FAILED."
fi
exit "$FAILED"
