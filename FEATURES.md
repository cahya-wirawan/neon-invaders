# Features

Status markers below record what actually shipped in the formations +
cannon-upgrade rounds and in the kill-streak multiplier round, and what was
deliberately left out of each of them. "Deferred"
means considered and descoped, not forgotten — nothing in this file is a
promise about a future round.

## Alien formations that evolve

- **[shipped]** Enemies dynamically rearrange into wedges and attack columns
  (`CONFIG.FORMATION`, `Swarm.startFormation` in `js/entities.js`). Each
  formation eases in, holds, then eases back out onto the marching grid.
- **[deferred]** Shield and spiral formations — the wedge/dive pair already
  covers the readable silhouettes at this alien count; more shapes read as
  noise rather than choreography.
- **[shipped]** Certain aliens act as commanders; killing one cancels the
  formation in flight and grounds the swarm for the rest of the wave
  (`CONFIG.COMMANDER`, `Swarm.killAlien`).
- **[shipped]** Three distinct commander personalities
  (`CONFIG.COMMANDER.PERSONALITIES`), selected by wave number rather than by
  a random draw, each with its own halo/crown tint and a `COMMANDER <name>`
  HUD label: **AGGRESSOR** choreographs dives only and re-arms them roughly a
  third sooner (a 0.75 gap scale), with slightly faster alien fire;
  **TACTICIAN** keeps both shapes but runs its own `wedge → dive → dive`
  cycle instead of the default alternation, at ~1.8× the cadence;
  **BARRAGE** choreographs wedges only, a fifth less often, and instead fires
  markedly faster with one extra alien bullet allowed in the air — clamped so
  it can never exceed the difficulty table's own wave-10 bullet ceiling. The
  per-wave grace period (`FORMATION.FIRST_DELAY`) is outside the gap scaling,
  so no personality shortens it. All of it is read through
  `Swarm.activePersonality()`, which returns null the moment the commander
  dies, so every effect lapses with the existing death path and needs no code
  of its own.
- **[deferred]** A *defensive* commander that pulls the swarm into a
  protective screen — that needs a new formation SHAPE, and shape variety
  was explicitly settled and descoped in the previous round (see the
  shield/spiral entry above). Adding one here would reopen that decision.
- **[deferred]** A *siege* commander that aims the swarm's fire at the
  bunkers — that needs bunker-aware alien-shot targeting.
  `Swarm.pickShooter` stays uniform-random over the occupied columns by
  design and is unchanged this round; making it target-aware is a
  gameplay-balance change of its own, not a personality field.
- **[deferred]** A *swarm* commander that calls in numeric reinforcements —
  the grid is a fixed 11×5 built once in the `Swarm` constructor, and adding
  aliens mid-wave would break the `total`-relative difficulty ramp and the
  grid-anchor invariants that keep the invasion floor honest. The
  "overwhelm you" idea ships as denser FIRE in the BARRAGE personality
  instead of as more aliens.
- **[deferred]** Formations combining into a giant temporary enemy — a new
  entity type with its own hitbox, health and death choreography, which is a
  round of its own rather than a bullet point in this one.

## Upgradeable cannon

Between waves (`STATE.UPGRADE`) the player picks exactly one upgrade; it
REPLACES the previous one and never stacks.

- **[shipped]** spread shot — three angled bullets per volley.
- **[shipped]** piercing laser — survives `UPGRADE.PIERCE_COUNT` extra kills.
- **[shipped]** bouncing projectile — angled, slower-climbing shot that
  reflects off the side walls up to `UPGRADE.BOUNCE_MAX` times.
- **[shipped]** temporary shield — starts the wave invulnerable for
  `UPGRADE.SHIELD_TIME` seconds.
- **[deferred]** homing missiles — needs per-bullet target acquisition and
  steering, which the current straight-line swept-hitbox collision model has
  no place for.
- **[deferred]** charge beam — needs a hold-to-charge input mode that would
  change how firing works for every other upgrade too.
- **[deferred]** drone companion — a second friendly entity with its own
  update/draw/collision path; out of scope for a between-waves pick.

The four shipped upgrades give each playthrough a small roguelite flavour.
Adding a fifth means an entry in `CONFIG.UPGRADE.IDS`, a branch in
`Player.prototype.fire`, and a matching entry in `js/hud.js`'s `UPGRADES`
table — the HUD skips any id it has no metadata for rather than throwing.

## Kill-streak multiplier

A deterministic score multiplier that rewards sustained accuracy
(`CONFIG.COMBO` in `js/core.js`, `Game.prototype.scoreKill` in `js/game.js`).

- **[shipped]** The multiplier itself. It is arithmetic on the existing
  `addScore()` path — one integer and one float of state, no new entity, no
  timer of its own, and not a single `Math.random()` draw (scenario 20 in
  `scripts/check-game.js` counts the draws to prove that).

| Rule | Behaviour |
| --- | --- |
| Increment | Every kill routed through `scoreKill()` — an alien or the bonus saucer — raises the streak by 1 and re-arms the window. |
| Apply | The kill pays `raw * min(MAX, 1 + floor(streak / STEP))`: x1 for the first three kills, x2 on the 4th, x3 on the 8th, saturating at x4 on the 12th. The multiplier is computed *after* the increment, so the kill that reaches a step already pays the new rate. The saucer banner prints what was actually awarded, so it can never disagree with the score. |
| Apply — commander | A commander alien's `+150` bonus is already baked into its `.score` before `scoreKill()` sees it, so the bonus is multiplied along with the rest: a commander killed at x4 pays `(30 + 150) * 4 = 720`, by far the largest single award in the game. That is deliberate — the commander is the wave's hardest target and the streak is what makes taking it down at the right moment worth setting up. |
| Reset — hit | `loseLife()` clears the streak as its first statement, so it drops even on the hit that ends the run. |
| Reset — run over | `gameOver()` clears it again *after* `setState(GAME_OVER)`, and `scoreKill()` refuses to build a streak once the state is `GAME_OVER`. Both are needed: `collide()` keeps walking the same `bullets` array after the fatal alien shot resolves, so player shots at a higher index still land — and still score — inside the very frame that ended the run. Those points stand (`flushHi()` exists for exactly that reason) but they pay a flat x1 and rebuild nothing, so no stale readout can be stranded on the death screen by a state that no longer ticks `comboTimer`. Scenario 23 reproduces that frame directly. |
| Reset — wave | `startWave()` and `clearWave()` both clear it, so nothing lingers into `WAVE_CLEAR`, the upgrade screen, or the next wave. |
| Reset — lapse | `updatePlaying()` decays `comboTimer` by `dt` and clears the streak at 0 (`WINDOW`, 2.6s). The decay runs *before* `collide()`, so a kill later in the same frame re-arms the window rather than being expired by that frame's own decay. |
| Readout | `js/hud.js` draws `COMBO  x4` — that spelling, ASCII `x` and two spaces, is the literal string in the code and what scenario 22 pins — on the score baseline, only while the multiplier exceeds x1, its alpha fading with the remaining window, which is the tell that the streak is about to lapse. |
| Knock-on — extra lives | The multiplier feeds the existing `addScore()`, and `addScore()` is what grants an extra life every 5,000 points. So a sustained streak brings extra lives proportionally sooner — up to ~4x sooner while x4 holds. This is an intended, expected consequence of putting the multiplier on the one scoring path, not a separate mechanic and not a bug. |

- **[shipped]** Gated from wave 2 (`COMBO.FROM_WAVE`), the same precedent as
  `FORMATION.FROM_WAVE = 2` and `COMMANDER.FROM_WAVE = 3`. The design reason
  is that wave 1 is the classic wave — plain swarm, no commander, and now
  classic scoring too, so the opening minute is still the game everyone
  already knows, and the multiplier arrives as something the player earns
  their way into. The honest secondary reason is regression safety:
  `scripts/check-game.js`'s golden checksum is a per-tick digest of a scripted
  wave-1 run pinned to the pre-feature commit (b316fc6), and that run's kills
  would have scored differently under a wave-1 multiplier. That constant may
  only ever be re-measured against that commit, never re-pasted from current
  output, so the wave-1 gate is what keeps the one bit-identity proof this
  codebase has intact. Scenario 22 asserts `combo === 0 && comboMult() === 1`
  on all 1200 golden ticks directly, so the claim does not rest on the digest
  alone.
- **[shipped]** The flat 5-point reflected-shot bonus (shooting down an
  incoming alien shot) is deliberately excluded: it stays on plain
  `addScore(5)`, unmultiplied, and neither builds nor breaks the streak.
  Multiplying it would make "farm the bullet stream" outscore "keep killing
  aliens", and letting it count as a streak kill would let a player hold x4
  indefinitely without touching the swarm — while making it *reset* the streak
  would punish a defensive shot the game otherwise rewards. Scenario 21(d)
  pins all three halves of that: exactly 5 points, streak counter unchanged,
  window not re-armed.
- **[deferred]** A dedicated streak meter or countdown bar — the fading
  `COMBO  x4` label already carries both facts (current rate, time left), and
  the HUD bar has no room at that baseline for a gauge that does not collide
  with the score or hi-score blocks.
- **[deferred]** Streak carry-over between waves, and a per-run "best streak"
  statistic — both change what a submitted *score* means to the online
  leaderboard beyond what this round already had to account for.
- **[shipped]** The server-side plausibility ceiling was re-derived for the
  multiplier. `server/src/anticheat.js`'s bound 2 assumed no score multiplier
  (peak ~136/s, ceiling 200/s); with `COMBO.MAX` scaling every alien and
  saucer kill the real peak is ~522/s, so a legitimate high-streak run would
  have been rejected as `implausible_score` by `POST /api/scores`. The file
  now mirrors `COMBO.MAX` as `COMBO_MAX` — with the same keep-in-sync warning
  `BEST_ALIENS_PER_SHOT` carries, and for the same reason it was added
  (commit `a1d8682`, the pierce upgrade's floor) — and derives both the peak
  and the 800/s default ceiling from it in code rather than hard-coding them.
  `scripts/verify.sh` AC13 checks the mirror by value.
- **[deferred]** Multiplier-aware upgrades (e.g. a cannon that slows the
  lapse) — that couples two independent systems whose interaction has no test
  coverage yet; the multiplier ships orthogonal to the upgrade pick.

## Distinct alien classes

Two named alien classes that change what a single unit in the swarm *does*,
rather than how the swarm as a whole moves (`CONFIG.ALIEN_CLASS` in
`js/core.js`, `Swarm.prototype.assignRole` / `shieldFor` / `updateDive` in
`js/entities.js`, the redirect and contact branches in `js/game.js`).

- **[shipped]** **Shield Aliens** (`ALIEN_CLASS.SHIELD`, from wave 4). One
  alien per wave protects its neighbours: a shot that would kill any alien
  within `RADIUS` (1) grid cell of it kills the *shield* instead, and the
  alien that was saved flashes (`hitFlash`) so the player can see why. Cover
  is decided in **grid space** — `Math.abs(shield.col - a.col)` and
  `.row`, never pixels — and `col`/`row` are written once in the `Alien`
  constructor and never moved, so cover cannot drift with the march, with a
  formation offset, or as the swarm thins. The whole mechanic is *one
  reassignment* placed on the near side of the existing `killAlien()` /
  `scoreKill()` pair in `collide()`, so there is still exactly **one**
  `killAlien()` and **one** `scoreKill()` per resolved hit — the shield is
  simply who they are about. No new scoring logic exists at all. A direct
  consequence of placing the reassignment *before* the pair rather than
  after it: a redirected kill always pays the **shield's own** row score
  (`SHIELD.ROW` is 2, so `SCORE.ROW[2]` = 20 points, times any active combo)
  — never the score of the alien that was originally hit, which may be a
  10-point row-3/4 alien. That is intended, not an accounting slip: the
  alien that died is the shield, so the shield is what the player is paid
  for. A shield
  never covers itself (a direct hit kills it normally), never covers a
  diving alien, and — because `SHIELD.ROW` is 2 and `RADIUS` is 1, i.e.
  cover spans rows 1–3 — it can never cover the commander, which is always
  on row 0. Scenario 25 in `scripts/check-game.js` pins all of that,
  including that a piercing shot through a covered alien kills the shield,
  decrements `pierce` exactly once, and does not redirect twice in one pass.
- **[shipped]** **Kamikaze Units** (`ALIEN_CLASS.KAMIKAZE`, from wave 5).
  One alien per wave, on the bottom row, commits to a ramming dive after
  `FIRST_DELAY` (8s) of wave time and is **the one alien in the game exempt
  from `FORMATION.MAX_Y`**. It earns that exemption structurally rather than
  by permission: a committed diver owns its own absolute coordinates
  (`a.dive = {x, y}`) instead of participating in the grid-anchor/offset
  system, and `applyFormation()`, `snapToGrid()` and `pickShooter()` all skip
  it. Its **grid anchor (`gx`/`gy`) is never written by the dive** and keeps
  marching under the untouched classic rules, so `gridBounds()` — which
  decides edge bounce, descent and the invasion floor — cannot see the dive
  at all. The precise scope of that guarantee: no dive **motion** can
  displace the grid or move the invasion floor, because nothing on the dive
  path ever writes `gx`/`gy`. It is *not* a claim that the kamikaze cannot
  affect invasion **timing** — its eventual death removes an alien, and one
  fewer alien both speeds up the survivors (`currentSpeed()`'s `gone` ramp)
  and can shrink `gridBounds()`'s extent, which measurably moves when an
  invasion lands. That is true of *every* alien death in the game, has been
  since long before this round, and is the intended difficulty curve; the
  kamikaze is not exempt from it and was never claimed to be. Scenario 26
  asserts the anchor stays in exact lockstep with a same-row alien for the
  whole dive, and that `onInvasion()` never
  fires. Contact costs a life through the **one** new alien-vs-player
  collision branch in the game, derived from the same three tests the
  existing alien-bullet branch uses (player alive, `invuln <= 0`, boxes
  overlap). Its two *self-removing* deaths — ramming the ship and crashing
  at `FLOOR_Y` — bypass `scoreKill()` and award **no score**; being **shot**
  is not one of them, and never was: a player bullet resolves a kamikaze
  through the ordinary `killAlien()`/`scoreKill()` path in `collide()`,
  which never inspects `role`, so shooting it (armed or mid-dive) pays its
  row's 10 points times the active combo like any other alien. It is
  excluded
  from the bunker-crush loop (a rammer aimed at the ship does not also strip
  your cover on the way past — unlike the marching swarm, which grinds
  through the bunkers on its way to the invasion floor), and its dive is
  dodgeable by construction:
  `SPEED_Y` 260 is below `BULLET.ALIEN_SPEED` (300) and its steering cap
  `SPEED_X` 170 is well below `PLAYER.SPEED` (420), so strafing out-runs it.
  `KAMIKAZE.FLOOR_Y` (677) is derived from the **ship** (`PLAYER.Y +
  PLAYER.H / 2 + SWARM.ALIEN_H / 2 + 2`), deliberately unlike
  `FORMATION.MAX_Y`, which is derived from the bunkers. The `+ ALIEN_H / 2
  + 2` matters for ordering, not aesthetics: the crash test runs inside
  `Swarm.update()`, *before* `collide()`'s contact test in the same tick, so
  the floor has to sit strictly below the ship's contact window (alien
  centre-y in the open interval 621–675) or a diver whose last step landed
  in the overlap would self-destruct on the very tick it should have
  registered a ram. At 677 it does, and one step at `MAX_DT` is only 8.67
  units against a 54-unit window, so a diver always spends several whole
  ticks inside it. Scenario 26 pins both halves. The diver's bottom edge at
  crash is 691, still inside the 720-unit world, so the crash always happens
  on screen.
- **[shipped]** One of each per wave, and **wave-derived, not RNG-drawn**:
  the carrier is `aliens[row * COLS + (wave - FROM_WAVE) % COLS]`, the same
  discipline the commander's personality uses. The class **assignment**
  itself spends **zero** `Math.random()` draws at any wave — scenario 24
  measures the draws consumed inside `new SI.Swarm(wave)` for waves
  1/2/3/4/5/6/10, compares them against the pre-class game at `git HEAD`,
  *and* pins them against a hand-written literal `[1, 2, 3, 3, 3, 3, 3]`
  that survives this round being committed (the `HEAD` half decays into a
  tautology the moment it is, exactly as scenario 1's `GOLDEN_DIGEST`
  constant exists to avoid). Below a class's `FROM_WAVE` the branch is not
  entered at all and neither class has any runtime behaviour, so those
  waves are completely unaffected and the wave-1
  golden checksum in scenario 1 is unchanged
  (`01cfdcd7…c1c04c`, score 420, alive 29). That is the whole claim: it is
  **not** a "zero draws at runtime" claim. From `FROM_WAVE` up the dive
  emits cosmetic particles every tick and a spark burst on commit, and
  `SI.Particles`' emitters consume draws when a pool slot is free — the same
  cosmetics-on-the-RNG-stream coupling `Bullet.update` and the UFO already
  have, and the same disclaimer the commander personalities already carry
  for their own effects. Expected, not a defect. Commander and class are
  **mutually exclusive by construction**: `assignRole()` refuses a cell that
  is already the commander or already classed, so the guarantee survives a
  future round moving `SHIELD.ROW` rather than resting on today's row
  numbers.
- **[shipped]** Neither class carries a **score bonus** (unlike
  `COMMANDER.SCORE_BONUS`), and that is a design decision, not an oversight:
  it is what lets `server/` stay completely frozen this round. Bound 2 of
  `server/src/anticheat.js` derives its ceiling from the highest points per
  second a client can legitimately produce; with no bonus,
  `BEST_ALIEN_SCORE` is still `SCORE.ROW`'s 30, `COMBO_MAX` is still 4, so
  `PEAK_SCORE_PER_SECOND` stays ~522/s and the enforced ceiling stays 800/s.
  Bound 1 is the one the kamikaze touches, because it removes an alien
  *without* a trigger pull, so a wave can be cleared with one shot fewer.
  The real arithmetic, from the actual constants in `anticheat.js`:

  | | shots needed | true floor for one wave |
  | --- | --- | --- |
  | as modelled (55 aliens) | `ceil(55 / 3)` = 19 | `19 * 0.28 + 2.4` = **7.72 s** |
  | with a kamikaze self-removing (54 aliens) | `ceil(54 / 3)` = 18 | `18 * 0.28 + 2.4` = **7.44 s** |

  The *enforced* floor is `7.72 * minSecondsPerWaveScale (0.5)` = **3.86 s**
  per wave. The true achievable floor drops from 7.72 s to 7.44 s — still
  **1.93×** above what the server actually enforces (it was 2.00× before), so
  the bound remains comfortably conservative and needs no re-derivation.
  `BEST_ALIENS_PER_SHOT` is likewise untouched: a shield redirect still
  removes exactly one alien per bullet, and a pierce shot through a shield
  still removes at most 3 per trigger pull. Contrast the kill-streak round,
  which *did* need a carve-out because `COMBO.MAX` invalidated bound 2
  outright.
- **[shipped]** In-world visual tells only — no new persistent HUD text, and
  `js/hud.js` is untouched this round. Each class gets a second additive glow
  halo in its own colour (a committed kamikaze burns wider and brighter) plus
  a flat-`fillRect` shape mark: a brace and side posts for the shield, two
  swept chevrons for the kamikaze. Both follow the existing commander
  halo/crown pattern exactly, and **no new `shadowBlur` call site** is
  introduced — the ship's own draw and the HUD text remain the only two in
  the codebase. Scenario 24 enforces a 48/255 minimum channel gap between
  each class colour and the commander amber, every `alienRows` entry, every
  personality crest, the ship, and each other. Both class sprites are
  **pre-warmed** from the `Swarm` constructor (one throwaway `SI.FX.glow()`
  per class, only on the waves that will actually draw them): `js/fx.js`'s
  own `init()` warm-list is frozen this round, but `glow()` builds-and-caches
  lazily, so warming from `js/entities.js` has exactly the same effect —
  the radial-gradient offscreen canvas is built at wave start instead of
  mid-frame the first time a tell is blitted. `glow()` consumes no
  `Math.random`, which scenario 24's draw counts pin.
- **[deferred]** **Snipers** (an alien that aims at the player's current
  position). Needs `Swarm.prototype.pickShooter` to become
  player-position-aware; it is uniform-random over occupied grid columns *by
  design*, and it was already held frozen for this exact reason by the siege-
  commander deferral in the commander-personality round.
- **[deferred]** **Bombers** (an alien whose shots target bunkers). Same
  `pickShooter` dependency, plus bunker-aware aiming — and alien shots have
  no steering or targeting model at all today: `Bullet` is spawned with a
  fixed `vy` and `vx === 0`.
- **[deferred]** **Teleporters**. A teleport would have to move the **grid
  anchor** (`gx`/`gy`), the one thing only the classic march may write.
  `gridBounds()` derives edge bounce, descent and the invasion floor from it,
  so a teleport could advance or delay an invasion — which is precisely the
  invariant this round's own scenario 26 exists to protect for the kamikaze.
  Shipping one means first deciding what an invasion *means* when position is
  discontinuous.
- **[deferred]** **Engineers** (an alien that repairs damaged allies).
  `Alien.alive` is a boolean; there is no HP model, so "damaged" has no
  representation. Adding one would touch every kill path at once —
  `collide()`, `killAlien()`, `scoreKill()`, pierce accounting — and would
  also change the anti-cheat's aliens-per-shot floor, since a repaired alien
  costs more than one trigger pull.
- **[deferred]** More than one shield or kamikaze per wave, and stacking a
  class onto a commander. There is no precedent for two visual tells on one
  sprite, and `assignRole()` deliberately refuses both cases today.
  `assignRole()` is the natural extension point for a future round: it takes
  a role, a row and a column and is the only place a class is ever attached.
