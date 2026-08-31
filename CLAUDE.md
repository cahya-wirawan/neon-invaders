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

Run these after touching `js/net.js`, `server/`, or the Capacitor scaffold:

```
bash scripts/verify.sh        # every acceptance check, prints AC1..AC16
node scripts/check-net.js     # js/net.js offline/error-path harness
cd server && npm test         # backend API tests (node:test)
```

and this one after touching the swarm formations, the cannon upgrades (weapon
combinations included), the commander personalities, the kill-streak
multiplier, the alien classes, or anything they reach — `js/core.js`,
`js/entities.js`, `js/game.js`, `js/hud.js`:

```
node scripts/check-game.js    # formations (Starling Murmuration) + upgrades + commander
                              # personalities + kill-streak multiplier +
                              # alien classes + weapon combinations +
                              # boss encounters + gamepad/EMP/achievements +
                              # phase aliens + CRT visual modes + Wave 21 Hive Nexus +
                              # Intelligent Frenzy & Eagle Swoops + Hyper-Graze/Phase Dash +
                              # Cosmic Asteroid Fields + Fleet Hangar + Glitch Incursion +
                              # Drone Wingmen & Tesla Arcs + Mystery Saucer Alien Deployment,
                              # headless, 58 scenarios (640 checks)
```

or just open `index.html` directly (`file://` works too, since scripts are
classic `<script>` tags, not ES modules, so there's no CORS issue).

`scripts/check-game.js` loads the real game files through `new Function` with
stubbed canvas/audio/input (same trick as `check-net.js` — no jsdom, no
dependencies) and drives `SI.Game` tick by tick under a seeded PRNG. Its first
scenario is a **golden checksum**: a scripted wave-1 run must digest to exactly
the value the game produced *before* formations and upgrades existed, which is
what proves the grid-anchor/offset split left classic play bit-identical. That
digest is a pinned constant in the file — re-measure it against the pre-feature
commit if you ever have to change it, never paste in whatever the current code
emits.

Beyond that the **game itself** still has no automated coverage — verify
changes to `js/fx.js`, `js/audio.js`, `js/input.js`, `js/starfield.js`,
`js/particles.js`, `js/props.js`, `js/main.js` and `css/style.css` by playing
it: start a wave, fire, take damage, clear a wave (and pick an upgrade),
trigger the UFO, pause/resume, and resize the window, checking the browser
console for errors.

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
PAUSED, WAVE_CLEAR, UPGRADE, GAME_OVER}` via `setState`/`update`, and owns
collision resolution, scoring, and wave progression. Difficulty is
table-driven — `SI.CONFIG.WAVES` (in `core.js`) controls formation speed, fire
rate, bullet speed, and max simultaneous shots per wave, capped at wave 10 so
late waves stay hard without becoming unfair.

`STATE.UPGRADE` sits between `WAVE_CLEAR` and the next `PLAYING`: it is the
cannon-refit screen, and `applyUpgrade()` — not `WAVE_CLEAR` — is what calls
`startWave()`. Exactly one upgrade is active at a time and a new pick replaces
the old one. The card list comes from `Game.upgradeChoices()`, not from
`CONFIG.UPGRADE.IDS` directly: when the active cannon is one half of an active
**weapon combination** (`UPGRADE.COMBINED_IDS`: `pierce_bounce` and `spread_bounce` "Prism Scatter"),
the *complementary* card is substituted for the combine card in that card's own slot.
It is a substitution, never a fifth card — five cards do not fit `WORLD_W` — so the list is always four long and every
card rect, digit binding and arrow wrap is unchanged. Because fire and confirm
share Space/Z/tap, the pick needs *two*
gates before it will accept a confirm: the binding must be seen released after
the screen opens (`upgradeArmed`), and `UPGRADE.MIN_DWELL` must have elapsed —
without both, the key still held down from dismissing `WAVE_CLEAR` instantly
locks in card 0. `PAUSED` remembers where it came from (`pausedFrom`) and
restores the frozen `stateTimer`, because on the upgrade screen that timer *is*
the `PICK_TIMEOUT` auto-select countdown.

**Formations & Alien Classes (`entities.js`).** From `FORMATION.FROM_WAVE` up,
the swarm periodically choreographs tactical formations (Wedge, Dive, Pincer, Inverted Wedge, Sweep).
Every alien carries a grid anchor (`gx`/`gy`), a formation offset (`fx`/`fy`) and the effective position (`x`/`y`).
Alien classes (`shield` on row 2, `kamikaze` on row 4, `phase` on row 1) are deterministically
assigned from their wave gates (`CONFIG.ALIEN_CLASS`) without drawing extra RNG.
Phase aliens cycle between solid active and intangible cloaked states with a high-frequency flicker tell.
One commander per wave from `COMMANDER.FROM_WAVE` up choreographs the swarm:
kill it and formations are cancelled and disabled for the rest of the wave.
That commander wears one of `COMMANDER.PERSONALITIES` (AGGRESSOR, TACTICIAN, BARRAGE).

**Intelligent Frenzy & Eagle Swoops (`CONFIG.FRENZY`, `entities.js`).** On Wave 2+,
when the swarm drops to the survival threshold (scaling by +1 surviving alien per completed wave:
5 on Wave 2, 6 on Wave 3, 7 on Wave 4, etc.), Frenzy mode activates. The survivors
break out of rigid 1D marching into fluid 2D sinusoidal vertical wave weaving, periodically
launch predatory curved eagle swoop dives toward the player with aimed apex bolts, and
target the player's column with leading fire. Grid anchors remain untouched, keeping invasion
floors and edge bounds mathematically honest.

**Milestone Boss Encounters (`entities.js`, `game.js`, `hud.js`).** On milestone
waves (`isBossWave`: 7, 14, 21), the grid swarm is replaced by a massive capital ship
(Wave 7 Vanguard Mothership, Wave 14 Dreadnought Sovereign, Wave 21 Hive Nexus).
Bosses feature multi-phase combat escalations, distinct barrage patterns, and a dedicated HUD health bar.

**Rendering tricks & CRT Modes (`fx.js`, `particles.js`).** Glow/bloom is faked cheaply:
gradient sprites are rendered once into offscreen canvases at startup and
blitted with `globalCompositeOperation = 'lighter'`; the expensive
`shadowBlur` is reserved for HUD text and the player ship only, never used
per-particle. `fx.js` provides a 3-stage CRT visual filter (`OFF`, `SCANLINES`, `PHOSPHOR`)
toggled via `KeyC` and persisted to `localStorage`. The particle system is a fixed-size pool (cap 1200) — don't
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
