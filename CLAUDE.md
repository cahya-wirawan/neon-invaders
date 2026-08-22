# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NEON INVADERS: a zero-dependency, browser-only Space Invaders clone. No build
step, no bundler, no asset files — every pixel is drawn with Canvas 2D and every
sound is synthesized live with the Web Audio API. Live demo:
https://cahya-wirawan.github.io/neon-invaders/

**The game engine (`js/core.js` … `js/main.js`, `css/style.css`) is still
exactly that: zero dependencies, zero network requests.** Three additive things
now sit alongside it and must not leak into it:

- `js/net.js` — an **opt-in** online accounts/leaderboard bridge. It performs no
  network request until the player signs in through the panel it injects (the
  Firebase Auth SDK itself is injected from CDN lazily, same trigger), and it
  hooks game over by wrapping `SI.Game.prototype.setState` from the outside
  rather than editing `game.js`.
- `server/` — Node + Express + SQLite backend (its own `package.json`). Verifies
  Firebase Authentication ID tokens (no local password storage) and checks
  submitted scores against server-tracked plausibility bounds (not a replay
  engine) via a server-issued run token — see `server/README.md`.
- Root `package.json` + `capacitor.config.json` + `android/` + `ios/` — the
  Capacitor mobile shells. The root `package.json` holds the Capacitor CLI
  **only**; the game never requires an `npm install` to run.

## Running / testing changes

The game itself has no build, lint, or test tooling — it's plain HTML/CSS/JS.
To check a change, run it in a browser:

```
python3 -m http.server 8000   # then visit http://localhost:8000/
```

The additive parts do have checks. Run them after touching `js/net.js`,
`server/`, or the Capacitor scaffold:

```
bash scripts/verify.sh        # every acceptance check, prints AC1..AC12
node scripts/check-net.js     # js/net.js offline/error-path harness
cd server && npm test         # backend API tests (node:test)
```

or just open `index.html` directly (`file://` works too, since scripts are
classic `<script>` tags, not ES modules, so there's no CORS issue).

The **game itself** has no automated tests — verify changes to `js/core.js` …
`js/main.js` and `css/style.css` by playing it: start a wave, fire, take
damage, clear a wave, trigger the UFO, pause/resume, and resize the window,
checking the browser console for errors. The **additive parts** (`js/net.js`,
`server/`, the Capacitor scaffold) *do* have automated tests — the three
commands listed just above — and all three must pass before you commit a change
to those areas.

## Architecture

**Namespace, not modules.** Every file in `js/` is an IIFE of the form
`(function (SI) { ... })(window.SI = window.SI || {})` that attaches its
exports onto the shared global `SI` object. This is deliberate, not legacy
style — it's what lets the game run from `file://` without a CORS-blocked
`import`. When adding a new file, follow the same pattern and add its
`<script>` tag to `index.html` in the right dependency position (see load
order below) — order matters because later files reference earlier ones via
`SI.*` at execution time, not through explicit imports.

**Load order (`index.html`), and why it's this order:**
```
core.js       SI namespace bootstrap, CONFIG, math/RNG/AABB helpers — depended on by everything
fx.js         prerendered glow sprites, screen shake, CRT overlay, nebula
audio.js      synthesized SFX + lookahead-scheduled music (Web Audio)
input.js      keyboard/pointer state, first-gesture hook
starfield.js  3-layer parallax starfield + shooting stars
particles.js  pooled particle system (1200 cap), additive rendering
entities.js   Player, Bullet, Alien, Swarm
props.js      destructible bunkers, bonus UFO
hud.js        on-canvas HUD and state overlays
game.js       SI.Game: state machine, collisions, scoring, wave progression
main.js       canvas/resize/letterbox setup + the rAF delta-time loop; boots everything
net.js        OPTIONAL opt-in online accounts/leaderboard; must stay last — it wraps
              SI.Game.prototype.setState and reads SI.game, both of which main.js creates
```

`net.js` is the only script that may be added here, and only at the end. It is
strictly additive: if you delete it, everything above still works unchanged.

**Fixed virtual resolution.** All gameplay math happens in 960×720 world
units (`SI.CONFIG.WORLD_W/H`). `main.js` computes one `setTransform` per
frame (scale × devicePixelRatio, dpr capped at `CONFIG.MAX_DPR`, and the
backing store further capped at ~16M pixels) to letterbox that world into
whatever the actual window size is. If you add drawing code, draw in world
units — don't hand-convert to screen pixels.

**Game loop (`main.js`).** A single `requestAnimationFrame` loop: clamp
`dt` to `CONFIG.MAX_DT` (1/30s) so a backgrounded tab or GC pause can't
teleport entities through collision checks, then `game.update(dt)` →
`starfield.update` → draw (starfield → game → particles → HUD → FX overlay).
Bullets additionally use a swept hitbox covering travel since the previous
frame, since a single point-in-time check isn't enough at these speeds. The
loop has a circuit breaker: repeated per-frame exceptions (5 in a row) halt
the loop and show a static "SIGNAL LOST" screen rather than spinning forever
in a broken state.

**State machine (`game.js`).** `SI.Game` drives `STATE.{MENU, PLAYING,
PAUSED, WAVE_CLEAR, GAME_OVER}` via `setState`/`update`, and owns collision
resolution, scoring, and wave progression. Difficulty is table-driven —
`SI.CONFIG.WAVES` (in `core.js`) controls formation speed, fire rate, bullet
speed, and max simultaneous shots per wave, capped at wave 10 so late waves
stay hard without becoming unfair.

**Audio (`audio.js`).** One `AudioContext`, created lazily inside the first
user-gesture handler (`SI.Input.onFirstGesture`, wired up in `main.js`) —
browsers block autoplay without a gesture. SFX are oscillator/noise voices
with gain envelopes; music is a bass + arpeggio + drum loop scheduled with a
25ms lookahead timer against `ctx.currentTime`, not driven directly off the
rAF loop. On tab visibility change, `main.js` calls `SI.Audio.unlock()` to
recover a possibly-suspended context — it never creates a new one outside a
gesture.

**Rendering tricks (`fx.js`, `particles.js`).** Glow/bloom is faked cheaply:
gradient sprites are rendered once into offscreen canvases at startup and
blitted with `globalCompositeOperation = 'lighter'`; the expensive
`shadowBlur` is reserved for HUD text and the player ship only, never used
per-particle. The particle system is a fixed-size pool (cap 1200) — don't
replace it with unbounded array growth.

## Gauntlet Loop (multi-agent review)

This repo has the `gauntlet-loop` plugin available (`/gauntlet <task>`), which
runs analyst → planner → builder → independent critic/red-team/verifier →
reviser → judge, optionally fanning review/judge roles out to external model
providers (OpenAI, Gemini, Anthropic API, Ollama) via the bundled
`gauntlet-router` MCP server for genuine cross-vendor independence. Provider
credentials are configured per-machine in `gauntlet-env.sh` (gitignored, not
committed) — see `.claude/plugins/local/gauntlet-loop/skills/gauntlet` for
the full protocol.
