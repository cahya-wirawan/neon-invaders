# Features

Status markers below record what actually shipped in the formations +
cannon-upgrade round, and what was deliberately left out of it. "Deferred"
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
