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

| Action          | Keyboard / Mouse               | Gamepad (Direct / Xbox / DualShock) |
| --------------- | ------------------------------ | ----------------------------------- |
| Move            | `←` `→` or `A` `D` / Mouse Drag| Left Stick / D-Pad                  |
| Fire            | `Space` or `Z` / Hold Click    | Button A / Button X / Right Trigger |
| EMP Super Bomb  | `X` or `Shift`                 | Button B / Left Trigger / Button Y  |
| Pause           | `P`                            | Start / Options Button              |
| Mute            | `M`                            | -                                   |
| Start / Restart | `Enter`, `Space`, or tap/click | Button A / Start Button             |

Touch and mouse: press and hold — the ship steers toward your finger/cursor and
fires continuously.

Between waves you're offered a cannon upgrade (see "Gameplay" below): move the
highlight with `←`/`→`/`A`/`D`, Gamepad D-pad or jump straight to a card with `1`–`4`
(or Gamepad bumpers), and confirm with `Space`/`Z`/`Enter` / Gamepad `A` or a tap on the card.
A pick made in the very first instant the screen appears is ignored — release the key first — so
mashing fire through the wave-clear screen can't blow past the choice
unread; left alone for 12 seconds it picks the highlighted card for you.

## Special Abilities & Features (v1.6.0)

- **Secondary EMP Super Bomb**: Combat kills, kill-streaks, commanders, UFOs, and boss combat charge the secondary EMP meter (0–100%). When ready, activate `X` / `Shift` / Gamepad `LT`/`B` to vaporize all incoming enemy projectiles, damage the alien swarm / boss, and trigger haptic rumble feedback.
- **Native Gamepad + Haptics**: Full plug-and-play support for standard gamepads with analog stick deadzones, D-pad navigation, and dual-motor haptic vibration feedback.
- **Retro Achievements System**: 10 offline persistent achievements tracked in `localStorage` with in-game animated toast notifications and Title Screen progress display.
- **Milestone Boss Encounters**: Milestone encounters at Wave 7 (Vanguard Mothership) and Wave 14 (Dreadnought Sovereign) with multi-phase rage modes, burst barrages, and dynamic HUD boss health bars.

Sound only starts after your first key press or tap: browsers require a user
gesture before an `AudioContext` may run, so the context is created inside that
first input handler.

## Scoring

- Front-row aliens are worth more (30 / 20 / 20 / 10 / 10 by row).
- The bonus saucer is worth 50–300 points.
- Shooting down an incoming alien shot scores 5 points.
- **Kill-streak multiplier** (`SI.CONFIG.COMBO`), active from wave 2 — wave 1
  stays classic. Every 4 consecutive kills raises the multiplier one step, up
  to x4, and it scales what each alien or bonus saucer kill pays (the saucer
  banner shows the multiplied amount actually awarded). That includes a
  commander's `+150` bonus, which is already baked into its score before the
  multiplier is applied — so a commander killed at x4 pays `(30 + 150) * 4 =
  720`, the largest single award in the game. The streak drops back to x1 if
  you are hit, when the wave ends, when the run ends, or after 2.6 seconds
  with no kill; a `COMBO  x4` readout (that spelling, ASCII `x`, is literally
  what `js/hud.js` draws) appears next to the score whenever the multiplier is
  above x1 and fades as its window runs out. The flat 5-point reflected-shot
  bonus is deliberately **not** multiplied and neither builds nor breaks the
  streak.
- An extra life every 5,000 points. The multiplier feeds the same `addScore()`
  path, so during a sustained streak extra lives arrive proportionally sooner
  — up to ~4x sooner at x4. That knock-on is intended, not a separate
  mechanic.
- The hi-score is kept in `localStorage` (silently skipped if storage is blocked).
- The title screen shows a small `v1.2.0` tag in the bottom-**left** corner —
  bottom-right is where `js/net.js`'s opt-in online panel is pinned —
  (`SI.CONFIG.VERSION` in `js/core.js`), kept in sync with the root
  `package.json`'s `version` field — `scripts/verify.sh` checks the two never
  drift apart. Policy: bump the **minor** number together in both places for
  every new feature (patch/major are unused).

## Difficulty

Each wave pulls from a tuning table (`SI.CONFIG.WAVES` in `js/core.js`): the
formation moves faster, fires more often, fires faster bullets, allows more
simultaneous shots, and starts lower on the screen. The table caps at wave 10, so
later waves stay hard but never become impossible. Within a wave the formation
also accelerates as its numbers thin out, and the music tempo rises with the wave.

## Gameplay: evolving formations and cannon upgrades

From wave 2 the swarm periodically breaks into dynamic formations, unlocking richer shapes as waves advance:
- **Wave 2**: **Wedge** (V-shape with center apex dipping forward) and **Dive** (single column commits toward ship $X$).
- **Wave 3**: **Pincer** (left and right wings plunge forward and pinch inward toward center).
- **Wave 4**: **Inverted Chevron / Funnel** (outer wings advance forward in chevron, center holds back).
- **Wave 5+**: **Sweeping Wave** (staggered diagonal wave rolling across the columns).

Formations scale in frequency and speed as you climb: formation cooldown intervals decrease from 7–12s (wave 2) down to 3.5–6s (wave 10+), while transition animations become up to 20% faster.

From wave 3, one alien per wave is a visually distinct **commander** — kill it and any choreography in progress is cancelled instantly, grounding the swarm back to plain marching for the rest of that wave.

That commander is one of three named personalities, cycling by wave number
(wave 3, 6, 9… get the first, wave 4, 7, 10… the second, and so on). You can
tell them apart two ways: the commander's halo and crown bar are tinted in
its own colour, and the HUD shows `COMMANDER <name>` along the bottom edge
while it is alive.

| Commander | Tell | While it is alive |
| --- | --- | --- |
| **AGGRESSOR** | warm orange halo/crown | choreographs **dives and pincers** (`dive → pincer → dive`) and shortens the gap between formations by a quarter (0.75 scale), re-arming roughly **a third sooner**; aliens shoot slightly faster |
| **TACTICIAN** | ice cyan halo/crown | orchestrates **the full tactical rotation** (`wedge → pincer → inverted_wedge → sweep`) and nearly **halves** the gap between them (0.55 scale, about 1.8× as many formations); leaves the fire rate alone |
| **BARRAGE** | hot crimson halo/crown | deploys **wide wall formations** (`wedge → inverted_wedge`) with heavy firepower: aliens shoot noticeably faster and one extra alien bullet may be in the air at a time |

The formation gap is scaled further by wave difficulty — the grace period
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

From wave 4 the swarm also fields **distinct alien classes** — one of each per
wave, always the same grid cell for a given wave number, so they are something
you learn rather than something you roll.

| Class | Tell | What it does |
| --- | --- | --- |
| **Shield Alien** (wave 4+) | deep-blue body and halo, a bright brace across its head with two side posts | Any alien within one grid cell of it — the 3×3 block around it, rows 1–3 — is covered: a shot that would kill one of them kills the **shield** instead, and the alien that was saved flashes blue. A redirected kill always pays the **shield's own** row value (20), never the value of whichever alien you were aiming at — you killed the shield, so you are paid for killing the shield, and it can be worth more than the shot you meant to take. It never covers itself, so a direct hit kills it normally, and it can never cover the commander (which is always on the top row). Kill it first and the block it was protecting opens up. |
| **Kamikaze Unit** (wave 5+) | burnt-orange body and halo, two swept chevrons under it; the halo flares wider and brighter the moment it commits | Sits on the bottom row for the first eight seconds of the wave, then leaves the swarm entirely and dives at your ship, steering toward you as it falls. Contact costs a life. It is the only alien that reaches your ship's own row — and unlike the rest of the swarm, which grinds down through your bunkers as it marches, a committed diver ignores them on the way past. It is **dodgeable by design**: it falls slower than an alien bullet and steers far slower than your ship moves, so strafing out of the lane beats it. Shoot it (before or during its dive) and it pays its row's points like any other alien, multiplied by any active streak; let it ram you or crash into the floor and it pays nothing. |

Neither class carries a score *bonus* — no extra points for being special.
A shield shot pays the shield's own row value, and a kamikaze pays its row
value when you shoot it and nothing when it removes itself. What they cost you
is position — the shield decides which shots are wasted, and the kamikaze
decides where you are standing.

Clearing a wave offers a choice of cannon upgrade (pick one — it replaces
whatever you had, it doesn't stack): **spread shot** (three angled bullets
per volley), **piercing laser** (survives multiple alien hits instead of
dying on the first), **bouncing projectile** (ricochets off the side walls),
or **temporary shield** (start the next wave invulnerable). If you're already
carrying the piercing laser or the bouncing shot, one of the four cards
changes: the *other* half of that pair is replaced by **PIERCE + BOUNCE**, a
single acid-green shot that cuts through aliens and ricochets off the walls at
the same time. It's a substitution, not a fifth card — you still choose one of
four, and it still replaces whatever you had, so the combined cannon can be
traded away again on the next screen and can't be combined any further.

At milestone waves (**Wave 7** and **Wave 14**), the standard swarm is replaced by
a multi-phase **Alien Boss Encounter**: the **Vanguard Mothership** (Wave 7) and
the **Dreadnought Sovereign** (Wave 14). Bosses field dual synchronized wing cannons,
enter an enraged high-speed 3-way burst barrage below 50% HP, and display a dedicated
live HUD health bar. See [`FEATURES.md`](FEATURES.md) for full details.

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
