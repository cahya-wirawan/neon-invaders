# Features

Status markers below record what actually shipped in the formations +
cannon-upgrade rounds and in the kill-streak multiplier round, and what was
deliberately left out of each of them. "Deferred"
means considered and descoped, not forgotten — nothing in this file is a
promise about a future round.

## Alien formations that evolve

- **[shipped]** Enemies dynamically rearrange into multiple tactical formations
  (`CONFIG.FORMATION`, `Swarm.startFormation` in `js/entities.js`). Each
  formation eases in, holds, then eases back out onto the marching grid.
- **[shipped]** Progressive formation unlock tiers by wave:
  - Wave 1: Classic marching grid.
  - Wave 2: **Wedge** (center apex dips forward) and **Dive** (single column commits toward ship $X$).
  - Wave 3: **Pincer** (flanks plunge forward and pinch inward toward center).
  - Wave 4: **Inverted Wedge / Chevron** (outer wings advance forward in chevron, center holds back).
  - Wave 5+: **Sweep** (staggered diagonal wave step across columns).
- **[shipped]** Dual wave-based difficulty scaling:
  - Formation interval gaps compress smoothly by ~6.25% per wave, shrinking from 7–12s (wave 2) down to 3.5–6s (wave 10+).
  - Animation transition times (`EASE_IN`, `HOLD`, `EASE_OUT`) scale up to 20% faster on higher waves.
- **[shipped]** Certain aliens act as commanders; killing one cancels the
  formation in flight and grounds the swarm for the rest of the wave
  (`CONFIG.COMMANDER`, `Swarm.killAlien`).
- **[shipped]** Three distinct commander personalities
  (`CONFIG.COMMANDER.PERSONALITIES`), selected by wave number rather than by
  a random draw, each with its own halo/crown tint and a `COMMANDER <name>`
  HUD label:
  - **AGGRESSOR**: uses aggressive flanking routines (`dive → pincer → dive`), re-arms formations ~33% sooner (0.75 gap scale), with slightly faster alien fire.
  - **TACTICIAN**: orchestrates the full tactical repertoire (`wedge → pincer → inverted_wedge → sweep`), re-arming ~80% faster (0.55 gap scale).
  - **BARRAGE**: deploys wide wall formations (`wedge → inverted_wedge`) with dense firepower (1.35 gap scale, 0.70 fire scale, +1 simultaneous bullet cap).
- **[deferred]** Shield and spiral formations — the wedge, dive, pincer, chevron, and sweep set already
  covers readable silhouettes without visual clutter.
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

## Weapon combination system

Exactly **one** shipped weapon combination: the **piercing laser** and the
**bouncing shot** fused onto a single bullet (`UPGRADE.COMBINED_ID` /
`UPGRADE.COMBINES` and `COLORS.pierceBounce` in `js/core.js`,
`Game.prototype.upgradeChoices` in `js/game.js`, the two-independent-`if`
restructure of `Player.prototype.fire` in `js/entities.js`, and the
`pierce_bounce` card entry plus its icon in `js/hud.js`).

- **[shipped]** **PIERCE + BOUNCE** (`'pierce_bounce'`). One shot that carries
  *both* field sets at once: `pierce = UPGRADE.PIERCE_COUNT` (2),
  `bounce = UPGRADE.BOUNCE_MAX` (2), and the bouncing shot's launch velocity
  (`vx = ±BOUNCE_VX`, `vy = -BOUNCE_VY`, with the same deterministic
  `bounceSide` alternation). It cuts through aliens *and* ricochets off the
  side walls in the same flight, and it is painted `COLORS.pierceBounce`
  (`#b6ff4d`) rather than either half's colour, so it never masquerades as a
  plain pierce or a plain bounce shot. It has **no tuning constants of its
  own** — it is precisely the union of the two upgrades already shipped.
- **[shipped]** It is offered by **substitution, never as a fifth card**, and
  that is a hard layout constraint rather than a preference. `js/hud.js`'s
  `CARD` table is `W: 196, GAP: 18`, and `upgradeCardRect()` centres the row
  in the 960-unit world:

  | cards | total width | fits `WORLD_W` (960)? |
  | --- | --- | --- |
  | 4 | `4 * 196 + 3 * 18` = **838** | yes, 61 units of margin each side |
  | 5 | `5 * 196 + 4 * 18` = **1052** | no — it would start at x −46 and end 46 units past the right wall |

  So `upgradeChoices()` returns `UPGRADE.IDS` verbatim unless the active
  cannon is one half of the combination, in which case the **complementary**
  card is swapped for the combine card *in that card's own slot*. The list
  length is therefore always 4: every card rect, the `1`–`4` digit bindings,
  the arrow-key wrap and the tap hit-test are byte-for-byte the code they were,
  and `game.upgradeCardAt()` and `js/hud.js`'s draw loop read the **same**
  list, so the card you tap is always the card you can see. On `'pierce'` the
  combine card takes index 2 (`'bounce'`'s slot); on `'bounce'` it takes index
  1 (`'pierce'`'s slot). From `'none'`, `'spread'` or `'shield'` no
  substitution applies at all and the screen is exactly the one that shipped
  before.
- **[shipped]** **The kill ceiling is unchanged, so `server/` stayed
  completely frozen — no anti-cheat carve-out, and none needed.** The trace:
  `collide()` resolves one alien per bullet per frame and either decrements
  `pierce` or kills the bullet, so a shot removes `1 + PIERCE_COUNT` = **3**
  aliens per trigger pull. `bounce` is decremented in `Bullet.update()` on
  *wall* contact only — a bounce buys the shot more **travel**, not more
  **kills** — and the two counters are separate fields that never read or
  write each other. 3 is exactly the `BEST_ALIENS_PER_SHOT` that
  `server/src/anticheat.js` already assumes for bound 1, so no bound moves.
  The combination also carries **no score bonus**: each kill pays its own
  `SCORE.ROW` value at whatever multiplier is already in force, so
  `BEST_ALIEN_SCORE` (30) and `COMBO_MAX` (4) are untouched,
  `PEAK_SCORE_PER_SECOND` stays ~522/s and bound 2's 800/s ceiling is
  unchanged. This is **machine-checked, not asserted**: `scripts/verify.sh`'s
  AC13 (e) greps `PIERCE_COUNT` out of `js/core.js`, requires
  `BEST_ALIENS_PER_SHOT` out of `anticheat.js` and fails unless
  `1 + PIERCE_COUNT === BEST_ALIENS_PER_SHOT`, and scenario 29 in
  `scripts/check-game.js` brute-forces 60 combined flights (15 launch x
  positions, `x = 60…900` step 60, × both launch sides × 2 heights) through a
  full 55-alien swarm and confirms no flight ever exceeds that ceiling. What
  the sweep asserts is the **upper bound** (`worst <= BEST_ALIENS_PER_SHOT`)
  plus non-vacuity (`worst > 0`) — it is not pinned to an exact number, so a
  future retune that made the worst flight *weaker* would not fail it. (Today
  the worst flight does reach the ceiling: it removes 3.)
- **[shipped]** **No new state and no new `Bullet` field.** `game.upgrade`
  stays a plain string — it just has one more legal value. `Bullet.pierce` and
  `Bullet.bounce` were already independent fields with independent owners
  (`collide()` and `Bullet.update()` respectively), which is the entire reason
  this combination needed **zero** new collision-handling code: `collide()`,
  `killAlien()` and `scoreKill()` are untouched this round. Scenario 29 pins
  the accounting behaviourally — one `killAlien()` and one `scoreKill()` per
  alien that actually died, no kill event ever changing `bounce`, no wall
  reflection ever changing `pierce`, and at least one reflection happening
  while `pierce` was still above zero, so "it pierced *and* bounced in one
  flight" is proven rather than assumed.
- **[shipped]** `UPGRADE.COMBINED_ID` is deliberately **not** in
  `UPGRADE.IDS`. `IDS` is the unconditional four-card pool; the combine card is
  conditional, so putting it in `IDS` would offer it from every cannon,
  including `'none'`. `applyUpgrade()`'s defence-in-depth check therefore
  validates the picked id against **`this.upgradeChoices()`** — the list this
  particular pick screen actually offered — rather than against the static
  `IDS` pool. That is both narrower (an id that exists but was never on screen
  is rejected too) and simpler (`COMBINED_ID` needs no special-case clause,
  because on a screen that offers it, it is *in* the list). The "unknown id
  falls back to `IDS[0]`" behaviour is unchanged. (The note in *Upgradeable
  cannon* above still holds for adding a fifth **unconditional** upgrade: that
  one really does want an `IDS` entry.)
- **[shipped]** `upgradeChoices()` always returns a **fresh array**, on the
  substitution path and the plain path alike, and it looks `COMBINES` up with
  an explicit `Object.prototype.hasOwnProperty.call()` — the same idiom
  `js/entities.js` already uses for its `byCol` walk, and now also used for
  `js/hud.js`'s two `UPGRADES[...]` lookups. Neither is reachable as a bug
  today (nothing writes `game.upgrade` from untrusted input, and every caller
  only *reads* the list it gets back), but a bare bracket lookup on an object
  literal answers for inherited `Object.prototype` keys with a truthy
  non-entry, and handing out `CONFIG.UPGRADE.IDS` itself would let one future
  caller's `sort`/`splice` corrupt the global config for the rest of the
  session — and only on the common no-substitution path, which is the worst
  kind of intermittent. Both are cheap enough that being safe by construction
  beats being safe by a downstream guard.
- **[shipped, documented asymmetry]** **From `'bounce'`, the plain BOUNCING
  SHOT card that stays on screen is strictly dominated by the combine.** This
  is an accepted consequence of the substitution design, not a defect. The
  combined shot is the pierce field set *plus* the entire unmodified bounce
  field set — same `vx`/`vy`, same `bounceSide` alternation, same trajectory —
  with nothing subtracted, so the two directions are not symmetric:

  | active cannon | cards offered | the choice |
  | --- | --- | --- |
  | `'pierce'` | `[spread, pierce, **pierce_bounce**, shield]` | a **real tradeoff** — plain PIERCING LASER is a straight, fast shot (`vy = -BULLET.PLAYER_SPEED`, `vx = 0`); the combine is angled and slower (`vy = -BOUNCE_VY`, `vx = ±BOUNCE_VX`). Neither dominates: the straight laser is the better answer to a column directly overhead. |
  | `'bounce'` | `[spread, **pierce_bounce**, bounce, shield]` | **not a tradeoff** — plain BOUNCING SHOT has the combine's exact trajectory and none of its piercing, so there is no board state in which re-picking it beats picking the combine. |

  Fixing it would mean substituting the *active* card rather than the
  complementary one, which changes what the screen offers from `'pierce'` too
  and is a design change, not a polish item. The current substitution is what
  keeps the card count at four and the kill ceiling at 3, which is what keeps
  `server/` frozen — so the asymmetry is documented and kept.
- **[shipped]** The combined cannon obeys the **same "one only, it replaces"
  rule** as every other upgrade. It cannot itself be combined further —
  `COMBINES` has no entry for `'pierce_bounce'`, so from the combined cannon
  the plain four cards come back and picking any of them replaces it outright.
  There is no third tier. The pick-screen hint text
  (*ONE ONLY — IT REPLACES YOUR CURRENT CANNON*) and the *1-4 TO CHOOSE*
  digit hint are unchanged because both are still literally true.
- **[shipped]** The two **mash-protection gates** apply to the combine card
  identically, because they were never per-card: `upgradeArmed` (the confirm
  binding must be seen released once after the screen opens) and
  `UPGRADE.MIN_DWELL` (1 s) are checked in `updateUpgradePick()` before the
  index is resolved against the list at all. Scenario 28 re-runs the held-key,
  mashing and tap-a-card probes from scenario 16 with the combine card
  highlighted and gets the same answers.
- **[shipped]** Presentation: a new `UPGRADES` entry in `js/hud.js`
  (**PIERCE + BOUNCE**, *"Pierces aliens AND ricochets off walls."*) and an
  icon built only from primitives the two source icons already use — the
  bounce icon's pair of wall posts around the pierce icon's shaft and
  cross-bars, with the shaft tilted so it reads as a ricochet rather than a
  straight lance. Flat `fillRect`/`rotate` only: **no new `shadowBlur` call
  site** (`verify.sh` machine-checks that across all four authorized engine
  files this round, `js/hud.js` included — it was frozen for the alien-classes
  round and is open for this one). The bottom-right `CANNON  PIERCE + BOUNCE`
  readout needed no new code at all: it already reads the `UPGRADES` table by
  `game.upgrade`. Scenario 30 pins the colour at a 48/255 minimum channel gap
  from the other four card colours, the plain bullet white, pierce-cyan and
  bounce-amber, and reads those colours back out of the real HUD draw rather
  than restating them as literals.
- **[shipped]** **The combined bullet meeting a SHIELD alien is covered, not
  assumed.** The shield class (`ALIEN_CLASS.SHIELD`, wave 4 up) redirects a
  lethal hit aimed at a covered ally onto itself, which is the one place a
  cross-feature interaction could have leaked an extra kill into a trigger
  pull. Scenario 31 pins it: on a redirected kill the combined shot's `pierce`
  falls by **exactly one** (not zero, not two), the **shield** dies and the
  targeted ally survives and flashes, `bounce` is left completely untouched,
  and the shot flies on — behaviourally *identical* to the same combined shot
  killing an unshielded alien, which the scenario asserts by comparing the two
  bullets field for field. It then sweeps every cell the shield covers ×
  both launch sides × three launch lead times and confirms that a flight which
  opens with a redirect can still ricochet off a wall and kill again, and that
  no flight anywhere in the sweep exceeds `1 + PIERCE_COUNT` = 3 kills. A
  redirect therefore buys no extra kill, which is why `BEST_ALIENS_PER_SHOT`
  needs no re-derivation even with both features live at once.
- **[shipped]** The wave-1 golden checksum is **unchanged**
  (`01cfdcd7…c1c04c`, score 420, alive 29). Nothing in this round changes a
  no-upgrade bullet: `Player.fire()`'s two field-setting `if`s are both false
  for `'none'`, `'spread'` and `'shield'`, its single colour expression falls
  through to `COLORS.bullet` (which is what the `Bullet` constructor was
  already given), and wave 1 has no upgrade at all. That colour expression is
  evaluated **once, after** the field blocks, rather than being written from
  inside each of them: the combined shot would otherwise be repainted three
  times with only the last write surviving — correct by ordering rather than
  by construction. Scenario 29 (a) pins all four resulting colours, the two
  plain cannons included.
- **[deferred]** **Spread + Pierce.** Three piercing bullets per trigger pull
  raises the best-case kills per trigger pull from 3 to `3 * (1 +
  PIERCE_COUNT)` = **9**, which invalidates `BEST_ALIENS_PER_SHOT` and forces
  a re-derivation of bound 1's shots-per-wave floor in
  `server/src/anticheat.js` — the one thing this round was specifically built
  to avoid. Shipping it means opening `server/` and re-deriving the bound
  properly, not widening a constant.
- **[deferred]** **Spread + Bounce.** There is no defined per-bullet-angle
  semantics for three simultaneously-bouncing shots. Spread's three bullets
  are distinguished by `±SPREAD_ANGLE` around vertical; bounce's single bullet
  is distinguished by `bounceSide`, which *alternates between trigger pulls*.
  Combining them means deciding what side each of the three takes, whether
  they alternate as a group or individually, and what happens when two of them
  reflect off opposite walls into each other's lanes — a real design problem,
  not a plumbing one.
- **[deferred]** **Pierce + Shield**, **Bounce + Shield** and **Spread +
  Shield.** All three for the same structural reason: `'shield'` never touches
  a `Bullet` at all. Its entire implementation is one line in `applyUpgrade()`
  setting `player.invuln = UPGRADE.SHIELD_TIME` after `startWave()`. There is
  no bullet-level interaction to combine — a "shield + X" is just X with a
  head start, which is a different feature (a modifier that stacks on top of a
  cannon) and would need the "exactly one upgrade, it replaces" rule that
  `game.upgrade` being a single string encodes to be rethought first.

## Boss Encounters

Milestone multi-phase boss encounters (`CONFIG.BOSS`, `SI.Boss` in `js/entities.js`,
`isBossWave` in `js/core.js`, HUD health bar in `js/hud.js`, collision and state
flow in `js/game.js`).

- **[shipped]** **Milestone Boss Waves (Wave 7 & 14)**:
  - Replaces the 11×5 grid swarm on milestone waves with a single massive
    alien capital ship.
  - **Wave 7**: **VANGUARD MOTHERSHIP** (35 HP, 1000 pts score award, 95 u/s speed,
    twin plasma cannons).
  - **Wave 14**: **DREADNOUGHT SOVEREIGN** (70 HP, 2500 pts score award, 135 u/s speed,
    dense 3-way burst barrage).
- **[shipped]** **Multi-Phase Combat**:
  - **Phase 1 (HP > 50%)**: Steady lateral sweep, twin wing cannons firing synchronized
    plasma bolts down the lanes.
  - **Phase 2 (HP <= 50% / ENRAGED)**: Red hull glow, +35% movement velocity, 3-way
    fanned plasma burst volleys, and 35% faster firing cadence.
- **[shipped]** **HUD Boss Health Bar**:
  - Dedicated retro health bar positioned cleanly below the separator bar (`drawBossBar`
    in `js/hud.js`).
  - Real-time HP ratio fill (green -> amber -> red) with live `[PHASE 1]` / `[ENRAGED]`
    status indicator.
- **[shipped]** **Zero-Regression Invariants**:
  - Waves 1–6 (and all standard swarm waves) remain completely bit-identical.
  - Wave 1 golden checksum digest is 100% unchanged.
  - Zero new `shadowBlur` call sites (draws use pre-warmed cached gradient glow sprites).
  - Anti-cheat compliance: boss kill score divided by the multi-second time to defeat
    stays far below the server's 800 pts/s ceiling.

## Native Gamepad & Haptic Rumble (v1.6.0)

- **[shipped]** **Standard Gamepad API Polling**:
  - `SI.Input` reads `navigator.getGamepads()` every frame in `update()`.
  - Analog left stick with standard deadzone ($0.15$), D-pad directional buttons ($12$ & $13$).
  - Full button mappings: Face buttons (A/Cross for Fire/Confirm, B/Circle/LT for EMP), Shoulder buttons (LB/RB for upgrade card selection), and Menu (Start/Options for Pause).
- **[shipped]** **Dual-Motor Haptic Vibration Feedback**:
  - `SI.Input.vibrate(durationMs, weakMagnitude, strongMagnitude)` triggers gamepad `vibrationActuator` (`dual-rumble`) with fallback to mobile `navigator.vibrate`.
  - Seamless rumble triggers on EMP Super Bomb detonation, boss phase transitions, player destruction, and achievement unlocks.

## Secondary EMP Super Bomb Ability (v1.6.0)

- **[shipped]** **Secondary EMP Charge Gauge (0–100%)**:
  - Charges incrementally through active gameplay: standard alien kills ($+2\%$), commander kills ($+15\%$), shield redirects ($+8\%$), kamikaze kills ($+6\%$), flying saucers ($+20\%$), boss hits ($+1.5\%$), and boss defeats ($+35\%$).
  - Meter rendered on bottom-left HUD overlay with ready state animation and prompt (`EMP READY [X / LT]`).
- **[shipped]** **Shockwave Screen Clearance & Enemy Damage**:
  - Triggered via `KeyX`, `Shift`, or Gamepad `LT`/`B`/`Y`.
  - Instantly destroys all incoming alien projectiles on screen.
  - Deals $12$ direct damage to milestone Boss flagships and eliminates the vanguard rank of the alien swarm.
  - Triggers camera screen-shake and dual-motor haptic rumble.

## Retro Achievements System (v1.6.0)

- **[shipped]** **10 Offline Persistent Achievements** (`CONFIG.ACHIEVEMENTS`, `SI.Achievements`):
  - 1. **FIRST CONTACT** (`first_blood`): Clear Wave 1.
  - 2. **COMBO KING** (`combo_master`): Reach COMBO x4 multiplier.
  - 3. **DECAPITATION** (`commander_slayer`): Defeat a Swarm Commander.
  - 4. **TITAN SLAYER** (`mothership_down`): Defeat Vanguard Mothership (Wave 7).
  - 5. **APEX PREDATOR** (`sovereign_fall`): Defeat Dreadnought Sovereign (Wave 14).
  - 6. **OVERCLOCKED** (`emp_blast`): Unleash full EMP Super Bomb.
  - 7. **FUSION MASTER** (`weapon_fused`): Equip any fused Weapon Combo.
  - 8. **DEADEYE** (`sharpshooter`): Intercept and shoot down an enemy projectile.
  - 9. **IRON BASTION** (`bunker_guardian`): Clear a wave with all 4 bunkers intact.
  - 10. **SCORE LEGEND** (`high_roller`): Achieve 20,000+ points in a single run.
- **[shipped]** **In-Game Toast Notifications & Showcase**:
  - Smooth animated banner notification slides into view upon unlocking an achievement.
  - Title Screen displays total unlocked achievements count badge strip.
  - Offline-first persistence via `localStorage` (degrades gracefully if storage is disabled).

## Prism Scatter Fused Weapon (v1.7.0)

- **[shipped]** **Prism Scatter (`spread_bounce`) Combination**:
  - Fused upgrade combining `spread` and `bounce` cannon upgrades (`CONFIG.UPGRADE.COMBINES`).
  - Fires a 3-way spread volley where all three projectiles ricochet off boundary walls up to `UPGRADE.BOUNCE_MAX` times.
  - Center projectile alternates initial bounce deflection direction.
  - Anti-cheat ceiling invariant preserved: max 3 kills per trigger pull (`BEST_ALIENS_PER_SHOT = 3`).

## Phase / Cloaking Alien Class (v1.7.0)

- **[shipped]** **Phase Specialist Alien (`ALIEN_CLASS.PHASE`)**:
  - Unlocked deterministically from Wave 6+ on row 1 at `(wave - 6) % COLS`.
  - Cycles between solid active state (2.8s) and intangible phased state (1.5s).
  - Phased state renders translucent with high-frequency sine flicker tell and quantum flank prongs.
  - Completely intangible to player bullets while phased (bullets pass through without colliding).

## CRT Scanline & Phosphor Bloom Visual Modes (v1.7.0)

- **[shipped]** **3-Stage Toggleable Visual Filter**:
  - `OFF`: Ultra-crisp high-framerate modern digital display.
  - `SCANLINES`: Standard 3px spaced scanlines with smooth radial vignette.
  - `PHOSPHOR`: Dense 2px phosphor scanline mesh with green/cyan curvature glow.
  - Switchable in real time via `KeyC` / Pause Menu / Gamepad, persisted to `localStorage['neon_invaders_crt_mode']`.
  - Zero-cost prerendered offscreen canvas blits with 0 new `shadowBlur` calls.

## Wave 21 "Hive Nexus" Boss Encounter (v1.7.0)

- **[shipped]** **Ultimate Milestone Boss Flagship**:
  - Spawns at milestone Wave 21 with 120 HP, 5,000 pts score award, and custom crystalline hive architecture.
  - **Phase 1 (100% - 65% HP)**: Twin heavy forward plasma cannons.
  - **Phase 2 (65% - 30% HP / CHARGED)**: +25% speed with 4-way concentrated pulse barrages.
  - **Phase 3 (< 30% HP / OVERLOAD CRISIS)**: +45% speed, crimson hull glow, and 5-way desperate radial spreads.
  - Dedicated HUD health bar supporting `[PHASE 1]`, `[ENRAGED]`, and `[OVERLOAD]` status banners.

## Intelligent Frenzy & Predatory Eagle Swoops (v1.9.1)

- **[shipped]** **Late-Wave Swarm Intelligence & Progressive Scaling (`CONFIG.FRENZY`)**:
  - Activates on Wave 2+ whenever the swarm thins down to the survival threshold (`frenzyThreshold()`).
  - **Progressive Wave Scaling**: The survival alien activation gate begins at 5 aliens on Wave 2 (after 1 completed wave) and increases by **+1 surviving alien for every completed wave** (Wave 2: 5, Wave 3: 6, Wave 4: 7, Wave 5: 8, Wave 6: 9, etc., capped at 18).
  - Wave 1 remains 100% classic Space Invaders behavior and retains its bit-identical golden checksum.
- **[shipped]** **Decoupled Independent 2D Soaring Flight**:
  - Remaining survivors break completely out of rigid grid lockstep into independent, fluid, random-directional soaring flight like eagles (`SOAR_SPEED: 140 px/s`, bounded in $X \in [40, 920]$ and altitude $Y \in [100, 450]$).
  - Continuous angular heading adjustments and predictive edge deflection/reflection prevent wall sticking while maintaining separate trajectories.
- **[shipped]** **Predatory Eagle Swoop Attacks**:
  - Periodically, an individual surviving alien breaks into an aggressive hunting swoop dive aimed at the player ship (`targetY: 648`).
  - **Phase 1 (Hunting Dive)**: Curving lateral arc toward `playerX` with scarlet engine thruster flare, firing a high-speed aimed pulse bolt at dive apex.
  - **Phase 2 (Banking Loop & Recovery)**: Smooth climbing recovery arc that brings the predator back into independent soaring flight.
  - Direct player collision destroys the diver and costs the player a life if not invulnerable.
- **[shipped]** **Aimed Leading Fire**:
  - In frenzy mode, shooter selection intelligently targets the occupied column closest to the player ($70\%$ aim bias).

