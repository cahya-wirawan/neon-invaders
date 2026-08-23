# NEON INVADERS

A modern, neon-drenched take on Space Invaders that runs entirely in the browser.
No build step, no bundler, no asset files — every pixel is drawn with Canvas 2D
and every sound is synthesized live with the Web Audio API. The game itself
still makes **zero network requests**; an optional, opt-in online leaderboard
lives in `js/net.js` and stays completely dormant until you sign in.

**Play it now: https://cahya-wirawan.github.io/neon-invaders/**

## Run it

Just open `index.html`:

```
double-click index.html
```

It works straight from `file://` — the scripts are plain `<script>` tags (not ES
modules), so there is no CORS problem and nothing to install.

> The root `package.json` exists only for the Capacitor CLI used by the mobile
> shells. The game never needs it: `index.html` still runs with nothing
> installed.

## Optional extras

- **Online accounts + leaderboard** — `server/` is a Node + Express + SQLite
  backend that verifies Firebase Authentication ID tokens (no passwords stored
  locally) and checks submitted scores against server-tracked plausibility
  bounds before accepting them. `js/net.js` adds a small opt-in panel in the
  corner of the page, loading the Firebase SDK from CDN only once you open it;
  until then, it makes no requests at all. See [`server/README.md`](server/README.md).
- **Android / iOS** — Capacitor shells wrapping this exact web build, no engine
  rewrite. See [`docs/MOBILE.md`](docs/MOBILE.md). A real debug/release APK
  has been compiled for Android; iOS is still scaffolding only (Xcode is
  macOS-only). Neither has been installed or run on a device yet.

Optionally, serve it over HTTP instead:

```
python3 -m http.server 8000
# then visit http://localhost:8000/
```

## Controls

| Action  | Keys                                    |
| ------- | --------------------------------------- |
| Move    | `←` `→` or `A` `D`                      |
| Fire    | `Space` or `Z`                          |
| Pause   | `P`                                     |
| Mute    | `M`                                     |
| Start / Restart | `Enter`, `Space`, or tap/click  |

Touch and mouse: press and hold — the ship steers toward your finger/cursor and
fires continuously.

Between waves you're offered a cannon upgrade (see "Gameplay" below): move the
highlight with `←`/`→`/`A`/`D` or jump straight to a card with `1`–`4`, and
confirm with `Space`/`Z`/`Enter` or a tap on the card. A pick made in the very
first instant the screen appears is ignored — release the key first — so
mashing fire through the wave-clear screen can't blow past the choice
unread; left alone for 12 seconds it picks the highlighted card for you.

Sound only starts after your first key press or tap: browsers require a user
gesture before an `AudioContext` may run, so the context is created inside that
first input handler.

## Scoring

- Front-row aliens are worth more (30 / 20 / 20 / 10 / 10 by row).
- The bonus saucer is worth 50–300 points.
- Shooting down an incoming alien shot scores 5 points.
- An extra life every 5,000 points.
- The hi-score is kept in `localStorage` (silently skipped if storage is blocked).
- The title screen shows a small `v1.0.0` tag in the bottom-right corner
  (`SI.CONFIG.VERSION` in `js/core.js`), kept in sync with the root
  `package.json`'s `version` field — `scripts/verify.sh` checks the two never
  drift apart. Bump both together on any user-visible change.

## Difficulty

Each wave pulls from a tuning table (`SI.CONFIG.WAVES` in `js/core.js`): the
formation moves faster, fires more often, fires faster bullets, allows more
simultaneous shots, and starts lower on the screen. The table caps at wave 10, so
later waves stay hard but never become impossible. Within a wave the formation
also accelerates as its numbers thin out, and the music tempo rises with the wave.

## Gameplay: evolving formations and cannon upgrades

From wave 2 the swarm periodically breaks formation: a **wedge** (a V-shape,
apex pointed at you) or a **dive**, where one column peels off and sweeps
toward your position before rejoining the grid. From wave 3, one alien per
wave is a visually distinct **commander** — kill it and any choreography in
progress is cancelled instantly, grounding the swarm back to plain marching
for the rest of that wave.

That commander is one of three named personalities, cycling by wave number
(wave 3, 6, 9… get the first, wave 4, 7, 10… the second, and so on). You can
tell them apart two ways: the commander's halo and crown bar are tinted in
its own colour, and the HUD shows `COMMANDER <name>` along the bottom edge
while it is alive.

| Commander | Tell | While it is alive |
| --- | --- | --- |
| **AGGRESSOR** | warm orange halo/crown | choreographs **dives only** — a column peeling at you, never a wedge — and shortens the gap between formations by a quarter, so it re-arms roughly **a third sooner** than an uncommanded swarm; aliens shoot slightly faster |
| **TACTICIAN** | ice cyan halo/crown | keeps **both** wedges and dives but on its own `wedge → dive → dive` cycle rather than the plain alternation, and nearly **halves** the gap between them (about 1.8× as many formations); leaves the fire rate alone |
| **BARRAGE** | hot crimson halo/crown | choreographs **wedges only** and calls them a fifth less often, trading choreography for firepower: aliens shoot noticeably faster and one extra alien bullet may be in the air at a time |

The formation gap is the only thing a commander speeds up — the grace period
at the start of every wave (`FORMATION.FIRST_DELAY`) is never shortened, and
BARRAGE's extra bullet can never push the swarm above the wave-10 ceiling the
difficulty table already sets, so late waves stay exactly as hard as they were
designed to be.

Every one of those effects is tied to the commander being alive. Killing it
cancels the formation in flight and, as before, stops formations **entirely**
for the rest of that wave — the cadence does not fall back to the uncommanded
rhythm, there simply is no further choreography. Alien fire returns to normal
from the next delay onward: the shot timer that was already armed when the
commander died runs out at its scaled value first (under a second), and every
delay computed after that is unscaled.

Clearing a wave offers a choice of cannon upgrade (pick one — it replaces
whatever you had, it doesn't stack): **spread shot** (three angled bullets
per volley), **piercing laser** (survives multiple alien hits instead of
dying on the first), **bouncing projectile** (ricochets off the side walls),
or **temporary shield** (start the next wave invulnerable). See
[`FEATURES.md`](FEATURES.md) for exactly what shipped versus what was
deliberately left out of this round.

## Project layout

```
index.html        canvas element + script tags (dependency order)
css/style.css     full-bleed dark stage, letterboxed canvas
js/core.js        SI namespace, CONFIG, math/RNG/AABB helpers
js/fx.js          prerendered glow sprites, screen shake, CRT overlay, nebula
js/audio.js       synthesized SFX + lookahead-scheduled music (Web Audio)
js/input.js       keyboard/pointer state, first-gesture hook
js/starfield.js   3-layer parallax starfield + shooting stars
js/particles.js   pooled particle system (1200 cap), additive rendering
js/entities.js    Player, Bullet, Alien, Swarm
js/props.js       destructible bunkers, bonus UFO
js/hud.js         on-canvas HUD and state overlays
js/game.js        state machine, collisions, scoring, wave progression
js/main.js        canvas/resize/letterbox setup and the rAF delta-time loop
```

## How it is put together

- **Namespace, not modules.** Every file is an IIFE that attaches to the shared
  `window.SI` object, so the game runs from `file://` where ES modules would be
  blocked by CORS.
- **Fixed virtual resolution.** All gameplay math is in 960×720 world units. The
  frame applies one `setTransform` (scale × devicePixelRatio, capped at 2) to
  letterbox the world into any window size.
- **Delta time.** `dt` is clamped to 1/30 s so a background tab or a GC pause can
  never teleport a bullet through an alien; bullets additionally use a swept
  hitbox covering their travel since the previous frame.
- **Bloom without the cost.** Glow comes from radial-gradient sprites rendered
  once into offscreen canvases and blitted with
  `globalCompositeOperation = 'lighter'`. `shadowBlur` is used only for HUD text
  and the player ship — never per particle.
- **Audio.** One `AudioContext`, created inside the first user gesture. SFX are
  oscillator/noise voices with gain envelopes; the music is a bass + arpeggio +
  drum loop scheduled by a 25 ms lookahead timer against `ctx.currentTime`.
