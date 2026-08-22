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
  backend (bcrypt-hashed passwords, JWT bearer auth). `js/net.js` adds a small
  opt-in panel in the corner of the page; until you sign in, it makes no
  requests at all. See [`server/README.md`](server/README.md).
- **Android / iOS** — Capacitor shells wrapping this exact web build, no engine
  rewrite. See [`docs/MOBILE.md`](docs/MOBILE.md). Note: no APK/IPA has been
  compiled and nothing has been run on a device; the platform projects are
  scaffolding only.

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

Sound only starts after your first key press or tap: browsers require a user
gesture before an `AudioContext` may run, so the context is created inside that
first input handler.

## Scoring

- Front-row aliens are worth more (30 / 20 / 20 / 10 / 10 by row).
- The bonus saucer is worth 50–300 points.
- Shooting down an incoming alien shot scores 5 points.
- An extra life every 5,000 points.
- The hi-score is kept in `localStorage` (silently skipped if storage is blocked).

## Difficulty

Each wave pulls from a tuning table (`SI.CONFIG.WAVES` in `js/core.js`): the
formation moves faster, fires more often, fires faster bullets, allows more
simultaneous shots, and starts lower on the screen. The table caps at wave 10, so
later waves stay hard but never become impossible. Within a wave the formation
also accelerates as its numbers thin out, and the music tempo rises with the wave.

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
