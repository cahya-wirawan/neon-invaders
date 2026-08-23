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
