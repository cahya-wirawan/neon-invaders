/* entities.js -- Player, Bullet, Alien, Swarm.
 *
 * Entities never reach into game.js. Every update() receives a `world`
 * context ({dt, particles, audio, spawnBullet, shake, ...}) supplied by
 * game.js, which keeps the dependency graph acyclic.
 */
(function (SI) {
  'use strict';

  var C = SI.CONFIG;

  /* ------------------------------ Bullet ---------------------------- */

  function Bullet(x, y, vy, from, color) {
    this.x = x;
    this.y = y;
    this.vy = vy;
    this.from = from;
    this.color = color;
    this.w = from === 'player' ? C.BULLET.PLAYER_W : C.BULLET.ALIEN_W;
    this.h = from === 'player' ? C.BULLET.PLAYER_H : C.BULLET.ALIEN_H;
    this.dead = false;
    this.age = 0;
    this.prevY = y;
    // Cannon-upgrade fields. All three are inert at their defaults, and a
    // default bullet must stay byte-for-byte the bullet this game always
    // had: vx === 0 means no horizontal integration and the original
    // y-only swept box.
    this.vx = 0;
    this.prevX = x;
    this.pierce = 0;
    this.bounce = 0;
    this.antiBullet = false;
  }

  Bullet.prototype.update = function (dt, world) {
    this.prevY = this.y;
    this.prevX = this.x;
    this.y += this.vy * dt;
    this.x += this.vx * dt;
    this.age += dt;
    if (this.y < -40 || this.y > C.WORLD_H + 40) {
      this.dead = true;
      return;
    }
    if (this.vx !== 0) {
      var lo = this.w / 2;
      var hi = C.WORLD_W - this.w / 2;
      if (this.x < lo || this.x > hi) {
        if (this.bounce > 0) {
          this.bounce--;
          // Reflect within the same step so the shot never renders or
          // collides from outside the world.
          this.x = this.x < lo ? (lo + (lo - this.x)) : (hi - (this.x - hi));
          this.x = SI.clamp(this.x, lo, hi);
          this.vx = -this.vx;
          if (world.particles) {
            world.particles.emitSparks(this.x, this.y, this.color, 5, this.vx > 0 ? 1 : -1, 0, 0.9);
          }
        } else {
          // Same semantics as leaving the world vertically.
          this.dead = true;
          return;
        }
      }
    }
    if (world.particles && Math.random() < 0.6) {
      world.particles.emitTrail(this.x, this.y + (this.vy > 0 ? -6 : 6), this.color, 9, 0.2);
    }
  };

  // Swept box: covers the travel since the previous frame so fast
  // bullets cannot tunnel through thin targets. Angled shots (vx !== 0)
  // sweep horizontally too; straight shots keep the original expression.
  Bullet.prototype.box = function () {
    var top = Math.min(this.y, this.prevY) - this.h / 2;
    var bottom = Math.max(this.y, this.prevY) + this.h / 2;
    if (this.vx === 0) {
      return { x: this.x - this.w / 2, y: top, w: this.w, h: bottom - top };
    }
    var left = Math.min(this.x, this.prevX) - this.w / 2;
    var right = Math.max(this.x, this.prevX) + this.w / 2;
    return { x: left, y: top, w: right - left, h: bottom - top };
  };

  Bullet.prototype.draw = function (ctx) {
    var sprite = SI.FX.glow(this.color);
    SI.FX.drawGlow(ctx, sprite, this.x, this.y, this.h * 2.4, 0.85);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(this.x - this.w / 2, this.y - this.h / 2, this.w, this.h);
  };

  /* ------------------------------ Player ---------------------------- */

  function Player() {
    this.w = C.PLAYER.W;
    this.h = C.PLAYER.H;
    this.x = C.WORLD_W / 2;
    this.y = C.PLAYER.Y;
    this.cooldown = 0;
    this.invuln = C.PLAYER.INVULN_TIME;
    this.respawn = 0;
    this.alive = true;
    this.tilt = 0;
    this.thrust = 0;
    this.pulse = 0;
    // Alternates the launch side of a bouncing shot -- deterministic, so
    // the upgrade adds no entropy to the RNG stream.
    this.bounceSide = 1;
  }

  Player.prototype.reset = function (full) {
    this.x = C.WORLD_W / 2;
    this.cooldown = 0;
    this.alive = true;
    this.respawn = 0;
    this.invuln = C.PLAYER.INVULN_TIME;
    this.tilt = 0;
    if (full) {
      this.thrust = 0;
    }
  };

  Player.prototype.box = function () {
    return { x: this.x - this.w / 2 + 4, y: this.y - this.h / 2, w: this.w - 8, h: this.h };
  };

  // Spawns the volley for the currently active cannon upgrade. With no
  // upgrade this is exactly the single straight shot the game always
  // fired. One muzzle spark + one shoot() per volley stays the caller's
  // job, so SPREAD is not three times as loud.
  Player.prototype.fire = function (world) {
    var U = C.UPGRADE;
    var bx = this.x;
    var by = this.y - this.h / 2 - 6;
    var speed = C.BULLET.PLAYER_SPEED;
    var up = world.upgrade || 'none';
    var b, i, ang;

    if (up === 'spread') {
      var angles = [-U.SPREAD_ANGLE, 0, U.SPREAD_ANGLE];
      for (i = 0; i < angles.length; i++) {
        ang = angles[i];
        b = new Bullet(bx, by, -speed * Math.cos(ang), 'player', C.COLORS.bullet);
        b.vx = speed * Math.sin(ang);
        world.spawnBullet(b);
      }
      return;
    }

    if (up === 'spread_bounce') {
      var sbAngles = [-U.SPREAD_ANGLE, 0, U.SPREAD_ANGLE];
      for (i = 0; i < sbAngles.length; i++) {
        b = new Bullet(bx, by, -U.BOUNCE_VY, 'player', C.COLORS.spreadBounce);
        b.bounce = U.BOUNCE_MAX;
        b.vx = i === 0 ? -U.BOUNCE_VX * 0.85 : (i === 2 ? U.BOUNCE_VX * 0.85 : U.BOUNCE_VX * 0.45 * this.bounceSide);
        world.spawnBullet(b);
      }
      this.bounceSide = -this.bounceSide;
      return;
    }

    b = new Bullet(bx, by, -speed, 'player', C.COLORS.bullet);
    // TWO INDEPENDENT `if`s, not an if/else chain: the WEAPON COMBINATION
    // (U.COMBINED_ID) is exactly the union of both blocks, and pierce/bounce
    // are already independent Bullet fields, so it needs no third code path
    // and no new field. For 'none' / 'spread' / 'shield' neither block runs;
    // for plain 'pierce' or plain 'bounce' exactly the one block runs, with
    // the same side effects (bounceSide flip included) it always had.
    if (up === 'pierce' || up === U.COMBINED_ID) {
      b.pierce = U.PIERCE_COUNT;
    }
    if (up === 'bounce' || up === U.COMBINED_ID) {
      b.bounce = U.BOUNCE_MAX;
      b.vx = U.BOUNCE_VX * this.bounceSide;
      // A bouncing shot climbs SLOWER than a normal one (BOUNCE_VY, not
      // PLAYER_SPEED). At the standard 720 it leaves the top of the world in
      // 0.93s and covers only ~520 units sideways, which is not enough to
      // reach a wall from mid-screen -- the upgrade would be inert. See the
      // arithmetic in CONFIG.UPGRADE.
      b.vy = -U.BOUNCE_VY;
      this.bounceSide = -this.bounceSide;
    }
    // ONE colour decision, evaluated once, AFTER the field blocks -- the two
    // `if`s above set fields only. Writing the colour inside them would have
    // the combined shot repainted three times over with only the last write
    // surviving, which is correct by ordering rather than by construction and
    // breaks the moment the blocks are reordered. The combined shot must not
    // masquerade as either half, so it wins outright; otherwise each half
    // keeps the colour it always had, and everything else keeps the plain
    // bullet white the Bullet was constructed with.
    b.color = up === U.COMBINED_ID ? C.COLORS.pierceBounce
      : up === 'pierce' ? C.COLORS.playerGlow
      : up === 'bounce' ? C.COLORS.warn
      : C.COLORS.bullet;
    world.spawnBullet(b);
  };

  Player.prototype.update = function (dt, world) {
    this.pulse += dt;
    if (!this.alive) {
      this.respawn -= dt;
      if (this.respawn <= 0 && world.livesLeft > 0) {
        this.reset(false);
      }
      return;
    }
    if (this.invuln > 0) {
      this.invuln -= dt;
    }

    var axis = world.moveAxis || 0;
    var pointer = world.pointer;
    if (pointer && pointer.active) {
      var dx = pointer.x - this.x;
      if (Math.abs(dx) > 6) {
        axis = SI.clamp(dx / 90, -1, 1);
      } else {
        axis = 0;
      }
    }
    this.x += axis * C.PLAYER.SPEED * dt;
    var half = this.w / 2;
    this.x = SI.clamp(this.x, half + 12, C.WORLD_W - half - 12);
    this.tilt = SI.lerp(this.tilt, axis * 0.22, Math.min(1, dt * 10));
    this.thrust = SI.lerp(this.thrust, Math.abs(axis), Math.min(1, dt * 8));

    if (world.particles && Math.random() < 0.7) {
      world.particles.emitTrail(
        this.x + SI.rand(-8, 8),
        this.y + this.h / 2 + 2,
        this.thrust > 0.4 ? '#ffd166' : C.COLORS.playerGlow,
        6 + this.thrust * 8,
        0.22
      );
    }

    this.cooldown -= dt;
    if (world.wantFire && this.cooldown <= 0) {
      this.cooldown = C.PLAYER.FIRE_COOLDOWN;
      this.fire(world);
      if (world.particles) {
        world.particles.emitSparks(this.x, this.y - this.h / 2 - 6, C.COLORS.player, 6, 0, -1, 0.5);
      }
      if (world.audio) {
        world.audio.shoot();
      }
    }
  };

  Player.prototype.kill = function (world) {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    this.respawn = C.PLAYER.RESPAWN_TIME;
    if (world.particles) {
      world.particles.emitExplosion(this.x, this.y, C.COLORS.player, 46, 1.5);
      world.particles.emitDebris(this.x, this.y, C.COLORS.playerGlow, 16, 1.3);
      world.particles.emitSparks(this.x, this.y, '#ffffff', 22, 0, -1, Math.PI);
    }
    if (world.shake) {
      world.shake(22, 0.5);
    }
    if (world.audio) {
      world.audio.playerHit();
    }
  };

  // The ship is one of only two places allowed to use shadowBlur.
  Player.prototype.draw = function (ctx) {
    if (!this.alive) {
      return;
    }
    var blink = this.invuln > 0 && Math.floor(this.invuln * 12) % 2 === 0;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.tilt);
    ctx.globalAlpha = blink ? 0.35 : 1;

    var w = this.w;
    var h = this.h;
    var glowSprite = SI.FX.glow(C.COLORS.playerGlow);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    SI.FX.drawGlow(ctx, glowSprite, 0, 0, w * 2.1, 0.5 + 0.12 * Math.sin(this.pulse * 6));
    var flame = 10 + this.thrust * 22 + Math.sin(this.pulse * 40) * 3;
    SI.FX.drawGlow(ctx, SI.FX.glow('#ffd166'), 0, h / 2 + flame * 0.35, flame * 1.7, 0.75);
    ctx.restore();

    ctx.shadowColor = C.COLORS.playerGlow;
    ctx.shadowBlur = 18;
    ctx.fillStyle = C.COLORS.player;
    ctx.beginPath();
    ctx.moveTo(0, -h / 2 - 4);
    ctx.lineTo(w * 0.18, -h * 0.05);
    ctx.lineTo(w * 0.5, h * 0.3);
    ctx.lineTo(w * 0.28, h / 2);
    ctx.lineTo(-w * 0.28, h / 2);
    ctx.lineTo(-w * 0.5, h * 0.3);
    ctx.lineTo(-w * 0.18, -h * 0.05);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 10;
    ctx.fillStyle = '#eafcff';
    ctx.fillRect(-2.5, -h / 2 - 2, 5, h * 0.55);
    ctx.fillStyle = C.COLORS.accent;
    ctx.fillRect(-w * 0.44, h * 0.16, w * 0.16, 5);
    ctx.fillRect(w * 0.28, h * 0.16, w * 0.16, 5);
    ctx.restore();
  };

  /* ------------------------------ Alien ----------------------------- */

  // 11x8 bitmaps, three species; rows of the formation pick a species.
  var SHAPES = [
    [
      '00100000100',
      '00010001000',
      '00111111100',
      '01101110110',
      '11111111111',
      '10111111101',
      '10100000101',
      '00011011000'
    ],
    [
      '00011111000',
      '01111111110',
      '11100100111',
      '11111111111',
      '00111011100',
      '01100100110',
      '11000000011',
      '00110001100'
    ],
    [
      '00001110000',
      '00111111100',
      '01110101110',
      '11111111111',
      '10011111001',
      '10100000101',
      '00011011000',
      '00110001100'
    ]
  ];

  // Eye-highlight cells per species, as [row, colA, colB]. These MUST land
  // on cells that are solid in that species' bitmap, otherwise the
  // highlight floats detached from the body (shape 1 has no ink at
  // columns 3/7 of row 2, so its eyes sit at columns 1/9).
  var EYES = [
    [2, 3, 7],
    [2, 1, 9],
    [2, 3, 7]
  ];

  function Alien(col, row, type, color, score) {
    this.col = col;
    this.row = row;
    this.type = type;
    this.color = color;
    this.score = score;
    this.alive = true;
    // x/y are the EFFECTIVE position: everything that collides, draws or
    // shoots reads these. gx/gy are the grid anchor moved by the classic
    // march logic; fx/fy are the formation offset. Effective = anchor +
    // offset * k, so with no formation running (k === 0) x === gx and
    // y === gy exactly -- the classic game, bit for bit.
    this.x = 0;
    this.y = 0;
    this.gx = 0;
    this.gy = 0;
    this.fx = 0;
    this.fy = 0;
    this.commander = false;
    this.personality = null;
    // Distinct alien class, or null for a plain alien. Named `role`, not
    // `class`: the latter is a reserved word and check-game.js's ES5 style
    // guard rejects it outright. All three fields are inert at these
    // defaults, and Swarm only ever sets them from FROM_WAVE up.
    //
    // `dive` is the kamikaze's OWN absolute position ({x, y}) once it has
    // committed. It is deliberately not an fx/fy formation offset: a diver
    // owns its effective x/y outright and its grid anchor (gx/gy) keeps
    // marching untouched underneath. The scope of that guarantee is exactly
    // the dive's MOTION: no amount of diving can displace the grid or move
    // the invasion floor, because nothing in the dive path ever writes
    // gx/gy. It is NOT a claim about invasion TIMING -- the kamikaze's
    // eventual death (ram, crash or shot) removes an alien, and every alien
    // death already shifts currentSpeed()'s `gone` ramp and gridBounds()'s
    // extent. That is the ordinary difficulty curve, identical in kind to
    // any other kill, not an invariant this class breaks.
    this.role = null;
    this.dive = null;
    this.diveTimer = 0;
    this.swoop = null;
    this.phaseTimer = 0;
    this.phased = false;
    this.w = C.SWARM.ALIEN_W;
    this.h = C.SWARM.ALIEN_H;
    this.hitFlash = 0;
  }

  Alien.prototype.box = function () {
    return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h };
  };

  Alien.prototype.draw = function (ctx, frame, bob) {
    var si = this.type % SHAPES.length;
    var shape = SHAPES[si];
    var cols = shape[0].length;
    var rows = shape.length;
    var cw = this.w / cols;
    var ch = this.h / rows;
    var ox = this.x - this.w / 2;
    var oy = this.y - this.h / 2 + bob;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    SI.FX.drawGlow(ctx, SI.FX.glow(this.color), this.x, this.y + bob, this.w * 1.8, 0.4);
    // The commander reads as a distinct unit through a wider second halo
    // -- still an additive sprite blit, never per-alien shadowBlur. Its
    // crest colour is the personality's tell; the BODY keeps the shared
    // commander colour so the unit still reads as "the commander" first.
    if (this.commander) {
      var haloCrest = (this.personality && this.personality.color) ?
        this.personality.color : C.COLORS.commander;
      SI.FX.drawGlow(ctx, SI.FX.glow(haloCrest), this.x, this.y + bob, this.w * 3.1, 0.5);
    }
    // Class tells, same technique: a second additive halo in the class
    // colour, never a per-alien shadow blur. A COMMITTED kamikaze burns wider
    // and brighter, so a dive reads as a threat before it is on top of you.
    if (this.role === 'shield') {
      SI.FX.drawGlow(ctx, SI.FX.glow(C.COLORS.shieldAlien), this.x, this.y + bob, this.w * 2.6, 0.5);
    } else if (this.role === 'kamikaze') {
      SI.FX.drawGlow(ctx, SI.FX.glow(C.COLORS.kamikaze), this.x, this.y + bob,
        this.dive ? this.w * 3.2 : this.w * 2.4, this.dive ? 0.7 : 0.45);
    } else if (this.role === 'phase') {
      var flicker = Math.sin(this.phaseTimer * (C.ALIEN_CLASS.PHASE.FLICKER_SPEED || 16));
      SI.FX.drawGlow(ctx, SI.FX.glow(C.COLORS.phaseAlien), this.x, this.y + bob,
        this.phased ? this.w * 2.0 : this.w * 2.6, this.phased ? 0.35 + 0.15 * flicker : 0.5);
    }
    if (this.swoop) {
      SI.FX.drawGlow(ctx, SI.FX.glow('#ff3366'), this.x, this.y + bob, this.w * 3.2, 0.75);
    }
    // A shield that just ATE a hit flares for SHIELD.FLASH seconds. hitFlash
    // is an existing per-alien timer already ticked down in Swarm.update.
    if (this.hitFlash > 0) {
      SI.FX.drawGlow(ctx, SI.FX.glow(C.COLORS.shieldAlien), this.x, this.y + bob, this.w * 3.6, 0.8);
    }
    ctx.restore();

    var alpha = 1;
    if (this.role === 'phase' && this.phased) {
      alpha = 0.28 + 0.18 * Math.sin(this.phaseTimer * (C.ALIEN_CLASS.PHASE.FLICKER_SPEED || 16));
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = this.color;
    for (var r = 0; r < rows; r++) {
      var line = shape[r];
      // Animation: alternate frames mirror the outer columns slightly.
      var shift = (frame === 1 && (r === 3 || r === 4)) ? cw * 0.5 : 0;
      for (var c = 0; c < cols; c++) {
        if (line.charCodeAt(c) === 49) {
          ctx.fillRect(ox + c * cw + shift, oy + r * ch, cw + 0.6, ch + 0.6);
        }
      }
    }
    // Eye highlight, on cells this species actually has ink in.
    var eye = EYES[si];
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(ox + cw * eye[1], oy + ch * eye[0], cw, ch);
    ctx.fillRect(ox + cw * eye[2], oy + ch * eye[0], cw, ch);

    // Commander crown: three chevron pips above the body.
    if (this.commander) {
      ctx.fillStyle = '#fffbe0';
      ctx.fillRect(ox + cw * 2, oy - ch * 1.4, cw * 1.2, ch * 1.1);
      ctx.fillRect(ox + cw * 4.9, oy - ch * 2.1, cw * 1.2, ch * 1.8);
      ctx.fillRect(ox + cw * 7.8, oy - ch * 1.4, cw * 1.2, ch * 1.1);
      var crest = (this.personality && this.personality.color) || C.COLORS.commander;
      ctx.fillStyle = crest;
      ctx.fillRect(ox + cw * 1.6, oy - ch * 0.5, this.w * 0.72, ch * 0.6);
    }

    // Class shape-marks, drawn the same way the crown is: flat fillRects, no
    // a shadow blur. Colour alone is not a good enough tell (the swarm is
    // already five colours deep), so each class also changes silhouette.
    if (this.role === 'shield') {
      // A brace across the top of the body plus two short side posts.
      ctx.fillStyle = '#dfe6ff';
      ctx.fillRect(ox + cw * 1.4, oy - ch * 1.1, this.w * 0.74, ch * 0.7);
      ctx.fillRect(ox + cw * 0.7, oy - ch * 0.6, cw * 0.9, ch * 1.9);
      ctx.fillRect(ox + cw * 9.4, oy - ch * 0.6, cw * 0.9, ch * 1.9);
    } else if (this.role === 'kamikaze') {
      // Two swept chevrons under the body -- a ram prow, pointing down.
      ctx.fillStyle = '#ffd0b0';
      ctx.fillRect(ox + cw * 2.6, oy + this.h + ch * 0.1, cw * 2.4, ch * 0.7);
      ctx.fillRect(ox + cw * 4.4, oy + this.h + ch * 0.8, cw * 2.4, ch * 0.7);
    } else if (this.role === 'phase') {
      // Flank antennae / quantum prongs
      ctx.fillStyle = '#eeddff';
      ctx.fillRect(ox - cw * 0.7, oy + ch * 0.6, cw * 0.7, ch * 2.2);
      ctx.fillRect(ox + this.w, oy + ch * 0.6, cw * 0.7, ch * 2.2);
    }
  };

  /* ------------------------------ Swarm ----------------------------- */

  function Swarm(wave) {
    var cfg = SI.waveConfig(wave);
    this.wave = wave;
    this.dir = 1;
    this.baseSpeed = cfg.speed;
    this.fireDelay = cfg.fire;
    this.bulletSpeed = cfg.bulletSpeed;
    this.maxBullets = cfg.maxAlienBullets;
    this.fireTimer = SI.rand(0.4, cfg.fire);
    this.frame = 0;
    this.frameTimer = 0;
    this.bob = 0;
    this.aliens = [];
    this.total = 0;
    this.descended = 0;

    var S = C.SWARM;
    for (var r = 0; r < S.ROWS; r++) {
      var type = r === 0 ? 0 : (r < 3 ? 1 : 2);
      var color = C.COLORS.alienRows[r % C.COLORS.alienRows.length];
      for (var c = 0; c < S.COLS; c++) {
        var a = new Alien(c, r, type, color, C.SCORE.ROW[r] || 10);
        a.gx = S.ORIGIN_X + c * S.CELL_W;
        a.gy = cfg.startY + r * S.CELL_H;
        a.x = a.gx;
        a.y = a.gy;
        this.aliens.push(a);
        this.total++;
      }
    }

    /* -------------------------- choreography ------------------------ */
    // Below FORMATION.FROM_WAVE nothing here touches Math.random(), so an
    // early wave draws exactly the same random stream as it always did.
    var F = C.FORMATION;
    this.formation = null;
    this.formationsEnabled = wave >= F.FROM_WAVE;
    this.formationTimer = Infinity;
    this.formationCount = 0;
    var firstJitter = 0;
    if (this.formationsEnabled) {
      firstJitter = SI.rand(0, F.MAX_GAP - F.MIN_GAP);
      this.formationTimer = F.FIRST_DELAY + firstJitter;
    }

    this.commander = null;
    this.personality = null;
    if (wave >= C.COMMANDER.FROM_WAVE) {
      // Row 0 occupies indices 0 .. COLS-1 of `aliens`.
      var cmd = this.aliens[SI.randInt(0, S.COLS - 1)];
      cmd.commander = true;
      cmd.score += C.COMMANDER.SCORE_BONUS;
      cmd.color = C.COLORS.commander;
      this.commander = cmd;
      // Personality is derived from the wave number, NOT drawn -- see the
      // COMMANDER comment in core.js. It is picked AFTER the alien pick
      // above so it cannot reorder that one existing draw.
      var P = C.COMMANDER.PERSONALITIES;
      this.personality = P[(wave - C.COMMANDER.FROM_WAVE) % P.length];
      cmd.personality = this.personality;
    }

    /* --------------------------- alien classes ---------------------- */
    // Both picks are WAVE-DERIVED arithmetic, made AFTER the commander block
    // so they cannot reorder its one existing randInt() draw, and they spend
    // no draw of their own at any wave. Below a class's FROM_WAVE the branch
    // is not entered at all -- which also keeps the modulo away from a
    // negative operand, where JS's % would hand back a negative index.
    //
    // NOTE: exactly ONE shield and ONE kamikaze per wave is an assumption
    // baked into these two fields -- shieldFor() and updateDive() both read
    // the singleton, not a list. A future round that wants several of either
    // would start by turning these into arrays; assignRole() is the only
    // place a class is ever attached, so it is the single extension point.
    this.shield = null;
    this.kamikaze = null;
    this.phaseAlien = null;
    var K = C.ALIEN_CLASS;
    if (wave >= K.SHIELD.FROM_WAVE) {
      this.shield = this.assignRole(
        'shield', K.SHIELD.ROW, (wave - K.SHIELD.FROM_WAVE) % S.COLS);
    }
    if (wave >= K.KAMIKAZE.FROM_WAVE) {
      // Bottom row: a rammer starts from the front of the swarm.
      this.kamikaze = this.assignRole(
        'kamikaze', S.ROWS - 1, (wave - K.KAMIKAZE.FROM_WAVE) % S.COLS);
      if (this.kamikaze) {
        this.kamikaze.diveTimer = K.KAMIKAZE.FIRST_DELAY;
      }
    }
    if (wave >= K.PHASE.FROM_WAVE) {
      this.phaseAlien = this.assignRole(
        'phase', K.PHASE.ROW, (wave - K.PHASE.FROM_WAVE) % S.COLS);
      if (this.phaseAlien) {
        this.phaseAlien.phaseTimer = K.PHASE.ACTIVE_TIME;
        this.phaseAlien.phased = false;
      }
    }
    // PRE-WARM the class glow sprites, and only on the waves that will
    // actually draw them.
    if (SI.FX && SI.FX.glow) {
      if (this.shield) { SI.FX.glow(C.COLORS.shieldAlien); }
      if (this.kamikaze) { SI.FX.glow(C.COLORS.kamikaze); }
      if (this.phaseAlien) { SI.FX.glow(C.COLORS.phaseAlien); }
      if (wave >= (C.FRENZY ? C.FRENZY.FROM_WAVE : 2)) { SI.FX.glow('#ff3366'); }
    }

    this.frenzyTimer = 0;
    this.eagleSwoopTimer = (C.FRENZY ? C.FRENZY.SWOOP_MIN_GAP : 3.5);

    // Applied after the commander block so the timer's own draw (above)
    // keeps its original position in the random stream; this only rescales
    // the value that draw already produced.
    if (this.personality && this.formationsEnabled) {
      this.formationTimer = F.FIRST_DELAY + firstJitter * this.personality.gapScale;
    }
  }

  /* --------------------------- alien classes ------------------------ */

  Swarm.prototype.assignRole = function (role, row, col) {
    var a = this.aliens[row * C.SWARM.COLS + col];
    if (!a || a.commander || a.role) { return null; }
    a.role = role;
    a.color = role === 'shield' ? C.COLORS.shieldAlien : (role === 'kamikaze' ? C.COLORS.kamikaze : C.COLORS.phaseAlien);
    return a;
  };

  // SHIELD ALIEN. Cover is decided in GRID space (col/row), never in pixels:
  // col/row are set once in the Alien constructor and nothing ever moves
  // them, so cover cannot drift with the march, with a formation offset or
  // with a thinning swarm. A shield never covers ITSELF (a direct hit kills
  // it normally), and never covers an alien that has left the grid to dive.
  Swarm.prototype.shieldFor = function (alien) {
    var s = this.shield;
    var R = C.ALIEN_CLASS.SHIELD.RADIUS;
    if (!s || !s.alive || s === alien || alien.dive) { return null; }
    if (Math.abs(s.col - alien.col) > R || Math.abs(s.row - alien.row) > R) { return null; }
    return s;
  };

  // KAMIKAZE. The dive is NOT a formation: `a.dive` holds the alien's own
  // ABSOLUTE position, applyFormation()/snapToGrid() deliberately leave a
  // diver alone, and it is the one thing in the game that may go past
  // FORMATION.MAX_Y -- it earns that by never touching gx/gy. The anchor
  // keeps marching under the untouched classic rules, so gridBounds()
  // (edge bounce, descent, the invasion floor) cannot see the dive at all.
  //
  // Precisely: no dive MOTION can displace the grid or move the invasion
  // floor. It is NOT a claim that the kamikaze cannot affect invasion
  // TIMING -- the killAlien() below removes an alien, and one fewer alien
  // both speeds up the survivors (currentSpeed()'s `gone` ramp) and can
  // shrink gridBounds()'s extent, exactly as EVERY other alien death
  // already does. That is the intended difficulty curve, not an exemption
  // this class was granted.
  Swarm.prototype.updateDive = function (dt, world) {
    var K = C.ALIEN_CLASS.KAMIKAZE;
    var a = this.kamikaze;
    if (!a || !a.alive) { return; }
    if (!a.dive) {
      a.diveTimer -= dt;
      // Never commit mid-choreography: the swarm may only be displaced by
      // one system at a time, and applyFormation() skips divers outright.
      if (a.diveTimer > 0 || this.formation) { return; }
      a.dive = { x: a.x, y: a.y };
      if (world.particles) {
        world.particles.emitSparks(a.x, a.y, a.color, 10, 0, 1, 0.9);
      }
    }
    var target = (world && typeof world.playerX === 'number') ? world.playerX : C.WORLD_W / 2;
    a.dive.y += K.SPEED_Y * dt;
    // Steering is CAPPED per tick and well under PLAYER.SPEED, so strafing
    // out of the way always beats it -- the dive is dodgeable, not homing.
    a.dive.x += SI.clamp(target - a.dive.x, -K.SPEED_X * dt, K.SPEED_X * dt);
    a.dive.x = SI.clamp(a.dive.x, C.FORMATION.EDGE_PAD, C.WORLD_W - C.FORMATION.EDGE_PAD);
    a.x = a.dive.x;
    a.y = a.dive.y;
    if (world.particles) {
      world.particles.emitTrail(a.x, a.y - a.h / 2, a.color, 10, 0.2);
    }
    if (a.y >= K.FLOOR_Y) {
      this.killAlien(a, world);   // crashed short of the ship: no score, no life
    }
  };

  // In Frenzy mode (Wave 2+, survival threshold scaling by +1 per completed wave),
  // the surviving aliens become intelligent predators: they weave vertically and
  // periodically launch a swooping dive attack toward the player's position, firing
  // an aimed shot at the apex before banking upward in a loop back to the swarm.
  // Like kamikaze dives, swoops do not displace grid anchors (gx/gy).
  Swarm.prototype.frenzyThreshold = function () {
    var Fz = C.FRENZY;
    if (!Fz || this.wave < Fz.FROM_WAVE) { return 0; }
    var base = Fz.BASE_THRESHOLD || Fz.THRESHOLD || 5;
    var scale = Fz.SCALE_PER_WAVE !== undefined ? Fz.SCALE_PER_WAVE : 1;
    return base + (this.wave - Fz.FROM_WAVE) * scale;
  };

  Swarm.prototype.isFrenzy = function () {
    var Fz = C.FRENZY;
    if (!Fz || this.wave < Fz.FROM_WAVE) { return false; }
    return this.aliveCount() <= this.frenzyThreshold();
  };

  Swarm.prototype.updateEagleSwoop = function (dt, world) {
    var Fz = C.FRENZY;
    if (!this.isFrenzy()) {
      return;
    }

    var i, a;
    var activeSwooper = false;
    for (i = 0; i < this.aliens.length; i++) {
      a = this.aliens[i];
      if (a.alive && a.swoop) {
        activeSwooper = true;
        var sw = a.swoop;
        sw.t += dt;
        var p = sw.t / sw.duration;
        if (p < 0.55) {
          // Phase 1: Predatory eagle swoop toward player target
          var u = p / 0.55;
          a.y = sw.startY + (sw.targetY - sw.startY) * Math.sin(u * Math.PI / 2);
          a.x = sw.startX + (sw.targetX - sw.startX) * u + sw.bankX * Math.sin(u * Math.PI);
          // Fire aimed pulse bolt near apex of dive
          if (u >= 0.70 && !sw.fired) {
            sw.fired = true;
            if (world && world.spawnBullet) {
              world.spawnBullet(new Bullet(
                a.x,
                a.y + a.h / 2 + 4,
                this.bulletSpeed * 1.15,
                'alien',
                '#ff3366'
              ));
              if (world.particles) {
                world.particles.emitSparks(a.x, a.y + a.h / 2, '#ff3366', 8, 0, 1, 0.8);
              }
            }
          }
        } else if (p < 1.0) {
          // Phase 2: Banking upward loop / climb back to formation slot
          var v = (p - 0.55) / 0.45;
          a.y = sw.targetY + (a.gy - sw.targetY) * Math.sin(v * Math.PI / 2);
          a.x = sw.targetX + (a.gx - sw.targetX) * v - sw.bankX * 0.45 * Math.sin(v * Math.PI);
        } else {
          // Swoop complete: safely dock back onto grid anchor
          a.swoop = null;
          a.x = a.gx;
          a.y = a.gy;
        }

        if (a.swoop) {
          a.x = SI.clamp(a.x, C.FORMATION.EDGE_PAD, C.WORLD_W - C.FORMATION.EDGE_PAD);
          if (world && world.particles) {
            world.particles.emitTrail(a.x, a.y - a.h / 2, '#ff3366', 8, 0.15);
          }
        }
      }
    }

    // Launch a new eagle swoop periodically if none is active
    if (!activeSwooper) {
      this.eagleSwoopTimer -= dt;
      if (this.eagleSwoopTimer <= 0) {
        this.eagleSwoopTimer = SI.rand(Fz.SWOOP_MIN_GAP, Fz.SWOOP_MAX_GAP);
        var candidates = [];
        for (i = 0; i < this.aliens.length; i++) {
          a = this.aliens[i];
          if (a.alive && !a.dive && !a.swoop) {
            candidates.push(a);
          }
        }
        if (candidates.length > 0) {
          var eagle = SI.pick(candidates);
          var playerX = (world && typeof world.playerX === 'number') ? world.playerX : C.WORLD_W / 2;
          var bankDir = (eagle.col % 2 === 0 ? 1 : -1);
          var bankOffset = bankDir * SI.rand(60, 110);
          eagle.swoop = {
            t: 0,
            duration: Fz.SWOOP_DURATION || 2.2,
            startX: eagle.x,
            startY: eagle.y,
            targetX: playerX,
            targetY: 570,
            bankX: bankOffset,
            fired: false
          };
          if (world && world.particles) {
            world.particles.emitSparks(eagle.x, eagle.y, '#ff3366', 14, 0, 1, Math.PI);
          }
        }
      }
    }
  };

  Swarm.prototype.aliveCount = function () {
    var n = 0;
    for (var i = 0; i < this.aliens.length; i++) {
      if (this.aliens[i].alive) { n++; }
    }
    return n;
  };

  // Bounds of the EFFECTIVE positions, i.e. the grid anchors plus whatever
  // formation offset is currently applied. A committed kamikaze is skipped
  // for the same reason applyFormation(), snapToGrid() and pickShooter()
  // skip it: a diver has left the grid and owns absolute coordinates that
  // are not an offset of anything, so including it would report a "swarm
  // extent" that no part of the swarm actually occupies.
  Swarm.prototype.bounds = function () {
    var minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < this.aliens.length; i++) {
      var a = this.aliens[i];
      if (!a.alive || a.dive || a.swoop) { continue; }
      if (a.x - a.w / 2 < minX) { minX = a.x - a.w / 2; }
      if (a.x + a.w / 2 > maxX) { maxX = a.x + a.w / 2; }
      if (a.y + a.h / 2 > maxY) { maxY = a.y + a.h / 2; }
    }
    return { minX: minX, maxX: maxX, maxY: maxY };
  };

  // Bounds of the GRID ANCHORS, ignoring any formation offset. Edge
  // bounce, descent and the invasion floor are all decided from these,
  // which is what makes it impossible for choreography to advance or
  // delay an invasion.
  Swarm.prototype.gridBounds = function () {
    var minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < this.aliens.length; i++) {
      var a = this.aliens[i];
      if (!a.alive) { continue; }
      if (a.gx - a.w / 2 < minX) { minX = a.gx - a.w / 2; }
      if (a.gx + a.w / 2 > maxX) { maxX = a.gx + a.w / 2; }
      if (a.gy + a.h / 2 > maxY) { maxY = a.gy + a.h / 2; }
    }
    return { minX: minX, maxX: maxX, maxY: maxY };
  };

  // Speed ramps as the formation thins out -- classic Invaders panic.
  Swarm.prototype.currentSpeed = function () {
    var alive = this.aliveCount();
    var gone = (this.total - alive) / Math.max(1, this.total);
    return this.baseSpeed * (1 + gone * 3.4) + this.descended * 1.2;
  };

  Swarm.prototype.update = function (dt, world) {
    var alive = this.aliveCount();
    if (alive === 0) {
      return;
    }
    var speed = this.currentSpeed();

    this.frameTimer += dt * (0.9 + speed / 90);
    if (this.frameTimer >= 0.5) {
      this.frameTimer = 0;
      this.frame ^= 1;
    }
    this.bob = Math.sin(this.frameTimer * 6) * 1.2;

    var dx = this.dir * speed * dt;
    var b = this.gridBounds();
    var margin = C.SWARM.MARGIN;
    var hitEdge = (this.dir > 0 && b.maxX + dx > C.WORLD_W - margin) ||
                  (this.dir < 0 && b.minX + dx < margin);

    var i, a;
    if (hitEdge) {
      this.dir *= -1;
      this.descended += 1;
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (a.alive) {
          a.gy += C.SWARM.DESCEND;
        }
      }
      if (world.onDescend) {
        world.onDescend();
      }
    } else {
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (a.alive) {
          a.gx += dx;
        }
      }
    }

    for (i = 0; i < this.aliens.length; i++) {
      a = this.aliens[i];
      if (a.hitFlash > 0) { a.hitFlash -= dt; }
    }

    if (this.phaseAlien && this.phaseAlien.alive) {
      var ph = this.phaseAlien;
      var Pk = C.ALIEN_CLASS.PHASE;
      ph.phaseTimer -= dt;
      if (ph.phaseTimer <= 0) {
        ph.phased = !ph.phased;
        ph.phaseTimer = ph.phased ? Pk.PHASE_TIME : Pk.ACTIVE_TIME;
      }
    }

    var Fz = C.FRENZY;
    var isFrenzy = this.isFrenzy();
    if (isFrenzy) {
      this.frenzyTimer += dt;
    }

    // Writes the effective x/y for this tick. With no formation running
    // it is a plain `x = gx; y = gy`.
    this.updateFormation(dt, world);

    // If frenzy is active, survivors dynamically weave up and down
    if (isFrenzy) {
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.dive || a.swoop) { continue; }
        var waveOffset = Math.sin(this.frenzyTimer * Fz.WAVE_FREQ + a.col * 0.9) * Fz.WAVE_AMP;
        a.y = Math.min(a.gy + waveOffset, (C.FORMATION && C.FORMATION.MAX_Y) || 560);
      }
    }

    // Runs AFTER applyFormation() has written everyone else's effective
    // position, because a committed diver or swooper owns its x/y outright and must
    // have the last word on them.
    this.updateDive(dt, world);
    this.updateEagleSwoop(dt, world);

    // Aliens shoot: timer + probability, from the lowest alien in a
    // random occupied column so nobody shoots through a friend.
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      // A live commander's personality scales the delay and can widen the
      // simultaneous-bullet cap; neither touches the draws below.
      var p = this.activePersonality();
      var delay = this.fireDelay * SI.rand(0.55, 1.35) * (0.55 + alive / Math.max(1, this.total) * 0.9);
      if (p) { delay *= p.fireScale; }
      this.fireTimer = Math.max(0.16, delay);
      // extraBullets widens the cap, but never past the WAVES table's own
      // ceiling: the table stops ramping at wave 10 by design, and a
      // personality is not allowed to raise late-wave difficulty above the
      // number that design settled on. On a wave already at the ceiling this
      // makes extraBullets a deliberate no-op.
      var cap = this.maxBullets;
      if (p && p.extraBullets) {
        cap = Math.min(cap + p.extraBullets, C.COMMANDER.MAX_ALIEN_BULLETS);
      }
      if (world.alienBulletCount() < cap && SI.chance(0.86)) {
        var shooter = this.pickShooter(world);
        if (shooter) {
          world.spawnBullet(new Bullet(
            shooter.x,
            shooter.y + shooter.h / 2 + 4,
            this.bulletSpeed,
            'alien',
            C.COLORS.alienBullet
          ));
          if (world.particles) {
            world.particles.emitSparks(shooter.x, shooter.y + shooter.h / 2, C.COLORS.alienBullet, 5, 0, 1, 0.6);
          }
        }
      }
    }

    if (this.gridBounds().maxY >= C.SWARM.FLOOR_Y && world.onInvasion) {
      world.onInvasion();
    }
  };

  /* --------------------------- formations --------------------------- */

  // Drops every alien back onto its grid anchor immediately, with no
  // easing, and forgets the formation in flight.
  Swarm.prototype.snapToGrid = function () {
    for (var i = 0; i < this.aliens.length; i++) {
      var a = this.aliens[i];
      // A committed kamikaze or swooper is not part of the grid any more:
      // it owns its own absolute x/y and must not be yanked back onto its anchor.
      if (a.dive || a.swoop) { continue; }
      a.fx = 0;
      a.fy = 0;
      a.x = a.gx;
      a.y = a.gy;
    }
    this.formation = null;
  };

  Swarm.prototype.endFormation = function () {
    this.snapToGrid();
    this.formationTimer = this.nextFormationGap();
  };

  // The personality only counts while its commander is ALIVE. killAlien
  // nulls this.commander, so every personality effect lapses through this
  // one accessor without any death-path code of its own.
  Swarm.prototype.activePersonality = function () {
    return this.commander ? this.personality : null;
  };

  Swarm.prototype.waveGapScale = function () {
    if (this.wave < C.FORMATION.FROM_WAVE) { return 1; }
    return Math.max(0.5, 1 - (this.wave - C.FORMATION.FROM_WAVE) * 0.0625);
  };

  Swarm.prototype.waveSpeedScale = function () {
    if (this.wave < C.FORMATION.FROM_WAVE) { return 1; }
    return Math.max(0.8, 1 - (this.wave - C.FORMATION.FROM_WAVE) * 0.025);
  };

  Swarm.prototype.unlockedFormations = function () {
    var w = this.wave;
    if (w < 2) { return []; }
    if (w === 2) { return ['wedge', 'dive']; }
    if (w === 3) { return ['wedge', 'dive', 'pincer']; }
    if (w === 4) { return ['wedge', 'dive', 'pincer', 'inverted_wedge']; }
    return ['wedge', 'dive', 'pincer', 'inverted_wedge', 'sweep'];
  };

  // Drop-in for the inline SI.rand(MIN_GAP, MAX_GAP) re-arms: still exactly
  // ONE draw, so the random stream keeps its shape whether or not a
  // personality is in play.
  Swarm.prototype.nextFormationGap = function () {
    var g = SI.rand(C.FORMATION.MIN_GAP, C.FORMATION.MAX_GAP);
    g *= this.waveGapScale();
    var p = this.activePersonality();
    if (p) { g *= p.gapScale; }
    return g;
  };

  // `kind` may be 'wedge', 'dive', 'pincer', 'inverted_wedge', 'sweep', or null to rotate.
  Swarm.prototype.startFormation = function (kind, world) {
    var F = C.FORMATION;
    var S = C.SWARM;
    var i, a;

    // An explicitly-passed `kind` always wins outright. Only the default
    // (null) path consults the commander's personality, which narrows or
    // reorders the repertoire it cycles through.
    var p = this.activePersonality();
    if (!kind) {
      if (p && p.kinds && p.kinds.length) {
        kind = p.kinds[this.formationCount % p.kinds.length];
      } else {
        var pool = this.unlockedFormations();
        kind = pool.length ? pool[this.formationCount % pool.length] : 'wedge';
      }
    }
    // A committed diver or swooper is never a formation participant: applyFormation()
    // and snapToGrid() both skip it, so writing fx/fy on it would only leave
    // stale offsets on an object nothing reads -- a landmine for any future
    // "abort the dive and rejoin the formation" path.
    for (i = 0; i < this.aliens.length; i++) {
      if (this.aliens[i].dive || this.aliens[i].swoop) { continue; }
      this.aliens[i].fx = 0;
      this.aliens[i].fy = 0;
    }

    var col = -1;
    var m = (S.COLS - 1) / 2;
    if (kind === 'dive') {
      var cols = [];
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        // Same guard on the candidate columns: a diver/swooper is not eligible, and
        // counting it could hand the whole formation a column whose only
        // "member" has left the grid -- a full ease-in/hold/ease-out cycle
        // spent displacing nothing.
        if (a.alive && !a.dive && !a.swoop && cols.indexOf(a.col) < 0) { cols.push(a.col); }
      }
      if (!cols.length) { return null; }
      col = SI.pick(cols);
      // Sampled ONCE, at dive start: the column commits to where the ship
      // was, it does not track it.
      var targetX = (world && typeof world.playerX === 'number') ?
        world.playerX : C.WORLD_W / 2;
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.dive || a.swoop || a.col !== col) { continue; }
        a.fy = F.DIVE_DEPTH;
        a.fx = targetX - a.gx;
      }
    } else if (kind === 'pincer') {
      // Outer wings plunge forward and pinch inward toward center
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.dive || a.swoop) { continue; }
        var dp = Math.abs(a.col - m);
        a.fy = m > 0 ? F.PINCER_DEPTH * (dp / m) : 0;
        a.fx = -(a.col - m) * F.PINCER_PINCH;
      }
    } else if (kind === 'inverted_wedge') {
      // Inverted Chevron: outer wings advance forward, center stays back
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.dive || a.swoop) { continue; }
        var di = Math.abs(a.col - m);
        a.fy = m > 0 ? F.INVERTED_WEDGE_DEPTH * (di / m) : 0;
        a.fx = (a.col - m) * F.WEDGE_PINCH;
      }
    } else if (kind === 'sweep') {
      // Staggered diagonal step rolling across columns
      var maxCol = S.COLS - 1;
      var reverse = (this.formationCount % 2 !== 0);
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.dive || a.swoop) { continue; }
        var frac = maxCol > 0 ? (reverse ? (maxCol - a.col) / maxCol : a.col / maxCol) : 0;
        a.fy = F.SWEEP_DEPTH * frac;
        a.fx = 0;
      }
    } else {
      // V-shape: apex at the centre column, pinched inwards.
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.dive || a.swoop) { continue; }
        var d = Math.abs(a.col - m);
        a.fy = m > 0 ? F.WEDGE_DEPTH * (1 - d / m) : F.WEDGE_DEPTH;
        a.fx = -(a.col - m) * F.WEDGE_PINCH;
      }
    }

    this.formation = { kind: kind, phase: 0, t: 0, k: 0, col: col };
    this.formationCount++;
    return this.formation;
  };

  // Advances the ease-in -> hold -> ease-out phase clock, then writes the
  // effective positions for this tick.
  Swarm.prototype.updateFormation = function (dt, world) {
    var F = C.FORMATION;
    var f = this.formation;
    var speedScale = this.waveSpeedScale();
    var easeIn = F.EASE_IN * speedScale;
    var hold = F.HOLD * speedScale;
    var easeOut = F.EASE_OUT * speedScale;

    if (f) {
      f.t += dt;
      if (f.phase === 0) {
        if (f.t >= easeIn) {
          f.phase = 1;
          f.t = 0;
          f.k = 1;
        } else {
          f.k = SI.smoothstep(f.t / easeIn);
        }
      } else if (f.phase === 1) {
        f.k = 1;
        if (f.t >= hold) {
          f.phase = 2;
          f.t = 0;
        }
      } else if (f.t >= easeOut) {
        this.endFormation();
      } else {
        f.k = 1 - SI.smoothstep(f.t / easeOut);
      }
    } else if (this.formationsEnabled) {
      this.formationTimer -= dt;
      if (this.formationTimer <= 0) {
        if (this.aliveCount() >= F.MIN_ALIVE) {
          this.startFormation(null, world);
        } else {
          this.formationTimer = this.nextFormationGap();
        }
      }
    }

    this.applyFormation();
  };

  Swarm.prototype.applyFormation = function () {
    var F = C.FORMATION;
    var f = this.formation;
    var i, a, ox, oy, ex, ey;

    if (!f) {
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.dive || a.swoop) { continue; }
        a.x = a.gx;
        a.y = a.gy;
      }
      return;
    }

    for (i = 0; i < this.aliens.length; i++) {
      a = this.aliens[i];
      if (!a.alive || a.dive || a.swoop) { continue; }
      ox = a.fx * f.k;
      oy = a.fy * f.k;
      ex = a.gx + ox;
      ey = a.gy + oy;
      if (ox !== 0) {
        ex = SI.clamp(ex, F.EDGE_PAD, C.WORLD_W - F.EDGE_PAD);
      }
      if (oy > 0) {
        // Never push an alien deeper than MAX_Y, and never pull one that
        // is already deeper than that back UP (the grid owns descent).
        ey = Math.max(a.gy, Math.min(ey, F.MAX_Y));
      }
      a.x = ex;
      a.y = ey;
    }
  };

  Swarm.prototype.pickShooter = function (world) {
    var byCol = {};
    for (var i = 0; i < this.aliens.length; i++) {
      var a = this.aliens[i];
      // A committed rammer or swooper is out of the firing line:
      if (!a.alive || a.dive || a.swoop) { continue; }
      var cur = byCol[a.col];
      if (!cur || a.y > cur.y) {
        byCol[a.col] = a;
      }
    }
    var list = [];
    for (var k in byCol) {
      if (Object.prototype.hasOwnProperty.call(byCol, k)) {
        list.push(byCol[k]);
      }
    }
    if (!list.length) { return null; }

    var Fz = C.FRENZY;
    if (this.isFrenzy() &&
        world && typeof world.playerX === 'number' && SI.chance(Fz.AIM_BIAS || 0.7)) {
      list.sort(function (a, b) {
        return Math.abs(a.x - world.playerX) - Math.abs(b.x - world.playerX);
      });
      return list[0];
    }
    return SI.pick(list);
  };

  Swarm.prototype.killAlien = function (alien, world) {
    alien.alive = false;
    if (world.particles) {
      world.particles.emitExplosion(alien.x, alien.y, alien.color, 24, 1);
      world.particles.emitDebris(alien.x, alien.y, alien.color, 8, 0.9);
    }
    if (world.audio) {
      world.audio.alienHit();
    }
    if (world.shake) {
      world.shake(5, 0.16);
    }

    // Commander down: the swarm loses its choreographer. Any formation in
    // flight is cancelled INSTANTLY (not eased out) -- the snap is hidden
    // behind the commander's own explosion -- and no further formation
    // can start for the rest of this wave.
    if (alien.commander) {
      if (world && world.particles) {
        world.particles.emitExplosion(alien.x, alien.y, C.COLORS.commander, 34, 1.4);
        world.particles.emitSparks(alien.x, alien.y, '#fffbe0', 16, 0, 0, Math.PI);
      }
      if (world && world.shake) {
        world.shake(14, 0.32);
      }
      this.commander = null;
      this.formationsEnabled = false;
      this.formationTimer = Infinity;
      this.snapToGrid();
    }
  };

  Swarm.prototype.draw = function (ctx) {
    for (var i = 0; i < this.aliens.length; i++) {
      var a = this.aliens[i];
      if (a.alive) {
        a.draw(ctx, this.frame, this.bob);
      }
    }
  };

  /* ------------------------------- Boss ----------------------------- */

  function Boss(wave) {
    var bcfg = C.BOSS;
    var wcfg = bcfg.CONFIGS[wave] || (wave >= 21 ? bcfg.CONFIGS[21] : (wave >= 14 ? bcfg.CONFIGS[14] : bcfg.CONFIGS[7]));
    this.wave = wave;
    this.name = wcfg.name;
    this.score = wcfg.score;
    this.maxHp = wcfg.hp;
    this.hp = this.maxHp;
    this.w = bcfg.W;
    this.h = bcfg.H;
    this.x = C.WORLD_W / 2;
    this.y = bcfg.Y;
    this.baseSpeed = wcfg.speed;
    this.vx = this.baseSpeed;
    this.color = wcfg.color;
    this.coreColor = wcfg.coreColor;
    this.bulletSpeed = wcfg.bulletSpeed;
    this.baseFireRate = wcfg.fireRate;
    this.fireTimer = 1.0;
    this.phase = 1;
    this.hitFlash = 0;
    this.alive = true;
    this.pulse = 0;
  }

  Boss.prototype.box = function () {
    return {
      x: this.x - this.w / 2,
      y: this.y - this.h / 2,
      w: this.w,
      h: this.h
    };
  };

  Boss.prototype.update = function (dt, world) {
    if (!this.alive) { return; }

    this.pulse += dt * 4;
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt);
    }

    var hpRatio = this.hp / this.maxHp;
    var isHive = this.wave === 21 || this.maxHp >= 100;
    if (isHive) {
      if (hpRatio <= 0.30 && this.phase < 3) {
        this.phase = 3;
        this.vx = (this.vx > 0 ? 1 : -1) * this.baseSpeed * 1.45;
        if (world && world.shake) { world.shake(12, 0.35); }
      } else if (hpRatio <= 0.65 && this.phase < 2) {
        this.phase = 2;
        this.vx = (this.vx > 0 ? 1 : -1) * this.baseSpeed * 1.25;
        if (world && world.shake) { world.shake(8, 0.25); }
      }
    } else {
      if (hpRatio <= 0.5 && this.phase === 1) {
        this.phase = 2;
        this.vx = (this.vx > 0 ? 1 : -1) * this.baseSpeed * 1.35;
        if (world && world.shake) {
          world.shake(8, 0.25);
        }
      }
    }

    var speedMult = this.phase === 3 ? 1.45 : (this.phase === 2 ? 1.35 : 1.0);
    var speed = this.baseSpeed * speedMult;
    this.x += (this.vx > 0 ? 1 : -1) * speed * dt;

    var minX = C.BOSS.MARGIN + this.w / 2;
    var maxX = C.WORLD_W - C.BOSS.MARGIN - this.w / 2;
    if (this.x < minX) {
      this.x = minX;
      this.vx = Math.abs(this.vx);
    } else if (this.x > maxX) {
      this.x = maxX;
      this.vx = -Math.abs(this.vx);
    }

    // Fire logic
    var rateMult = this.phase === 3 ? 0.55 : (this.phase === 2 ? 0.65 : 1.0);
    var rate = this.baseFireRate * rateMult;
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      this.fireTimer = rate;
      this.fire(world);
    }
  };

  Boss.prototype.fire = function (world) {
    if (!world || !world.spawnBullet) { return; }

    var vy = this.bulletSpeed;
    var color = C.COLORS.alienBullet;
    var isHive = this.wave === 21 || this.maxHp >= 100;

    if (isHive) {
      if (this.phase === 1) {
        var leftX = this.x - this.w * 0.35;
        var rightX = this.x + this.w * 0.35;
        var gunY = this.y + this.h / 2 + 2;
        world.spawnBullet(new Bullet(leftX, gunY, vy, 'alien', color));
        world.spawnBullet(new Bullet(rightX, gunY, vy, 'alien', color));
      } else if (this.phase === 2) {
        var offsets = [-36, -12, 12, 36];
        var vxs = [-50, -15, 15, 50];
        for (var k = 0; k < 4; k++) {
          var bP2 = new Bullet(this.x + offsets[k], this.y + this.h / 2 + 2, vy, 'alien', k === 1 || k === 2 ? '#00f5d4' : color);
          bP2.vx = vxs[k];
          world.spawnBullet(bP2);
        }
      } else {
        var radOffsets = [-48, -24, 0, 24, 48];
        var radVxs = [-90, -45, 0, 45, 90];
        for (var m = 0; m < 5; m++) {
          var bP3 = new Bullet(this.x + radOffsets[m], this.y + this.h / 2 + 2, vy * 1.1, 'alien', m === 2 ? '#ff007f' : color);
          bP3.vx = radVxs[m];
          world.spawnBullet(bP3);
        }
      }
    } else if (this.phase === 1) {
      // Twin cannons
      var leftX1 = this.x - this.w * 0.32;
      var rightX1 = this.x + this.w * 0.32;
      var gunY1 = this.y + this.h / 2 + 2;
      world.spawnBullet(new Bullet(leftX1, gunY1, vy, 'alien', color));
      world.spawnBullet(new Bullet(rightX1, gunY1, vy, 'alien', color));
    } else {
      // Phase 2: Enraged 3-way burst
      var cX = this.x;
      var gY = this.y + this.h / 2 + 2;
      var bLeft = new Bullet(cX - 24, gY, vy, 'alien', color);
      var bCenter = new Bullet(cX, gY, vy * 1.1, 'alien', '#ff2d55');
      var bRight = new Bullet(cX + 24, gY, vy, 'alien', color);
      bLeft.vx = -60;
      bRight.vx = 60;
      world.spawnBullet(bLeft);
      world.spawnBullet(bCenter);
      world.spawnBullet(bRight);
    }

    if (world && world.particles) {
      world.particles.emitSparks(this.x, this.y + this.h / 2, C.COLORS.alienBullet, 6, 0, 1, 0.8);
    }
  };

  Boss.prototype.takeDamage = function (amount, world) {
    if (!this.alive) { return; }
    this.hp = Math.max(0, this.hp - (amount || 1));
    this.hitFlash = 0.08;

    if (world && world.particles) {
      var sparkColor = this.phase >= 2 ? '#ff2d55' : this.coreColor;
      world.particles.emitSparks(this.x + SI.rand(-30, 30), this.y + SI.rand(-10, 10), sparkColor, 6, 0, 1, Math.PI);
    }
    if (world && world.audio && world.audio.alienHit) {
      world.audio.alienHit();
    }

    if (this.hp <= 0) {
      this.die(world);
    }
  };

  Boss.prototype.die = function (world) {
    this.alive = false;
    this.hp = 0;
    if (world && world.particles) {
      world.particles.emitExplosion(this.x, this.y, this.color, 48, 2.0);
      world.particles.emitDebris(this.x, this.y, this.coreColor, 20, 1.6);
      world.particles.emitSparks(this.x, this.y, '#ffffff', 24, 0, 0, Math.PI * 2);
    }
    if (world && world.shake) {
      world.shake(20, 0.5);
    }
    if (world && world.audio && world.audio.ufoKilled) {
      world.audio.ufoKilled();
    }
  };

  Boss.prototype.draw = function (ctx) {
    if (!this.alive) { return; }

    var x = this.x;
    var y = this.y;
    var w = this.w;
    var h = this.h;
    var halfW = w / 2;
    var halfH = h / 2;

    ctx.save();

    // Halo glow using pre-rendered cached glow sprite
    var glowColor = this.phase === 3 ? '#ff007f' : (this.phase === 2 ? '#ff2d55' : this.color);
    var glowSprite = SI.FX.glow(glowColor);
    if (glowSprite) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 + Math.sin(this.pulse) * 0.15;
      ctx.drawImage(glowSprite, x - 84, y - 56, 168, 112);
      ctx.restore();
    }

    // Hull polygon
    var hullColor = this.hitFlash > 0 ? '#ffffff' : (this.phase === 3 ? '#ff007f' : (this.phase === 2 ? '#ff4d79' : this.color));
    ctx.strokeStyle = hullColor;
    ctx.lineWidth = 3;
    ctx.fillStyle = '#0a0818';

    ctx.beginPath();
    ctx.moveTo(x, y - halfH);
    ctx.lineTo(x + halfW * 0.6, y - halfH * 0.7);
    ctx.lineTo(x + halfW, y - halfH * 0.2);
    ctx.lineTo(x + halfW * 0.85, y + halfH * 0.5);
    ctx.lineTo(x + halfW * 0.4, y + halfH * 0.4);
    ctx.lineTo(x + halfW * 0.35, y + halfH);
    ctx.lineTo(x + halfW * 0.25, y + halfH);
    ctx.lineTo(x + halfW * 0.2, y + halfH * 0.3);
    ctx.lineTo(x, y + halfH * 0.6);
    ctx.lineTo(x - halfW * 0.2, y + halfH * 0.3);
    ctx.lineTo(x - halfW * 0.25, y + halfH);
    ctx.lineTo(x - halfW * 0.35, y + halfH);
    ctx.lineTo(x - halfW * 0.4, y + halfH * 0.4);
    ctx.lineTo(x - halfW * 0.85, y + halfH * 0.5);
    ctx.lineTo(x - halfW, y - halfH * 0.2);
    ctx.lineTo(x - halfW * 0.6, y - halfH * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Inner wing accents
    ctx.strokeStyle = this.hitFlash > 0 ? '#ffffff' : (this.phase >= 2 ? '#ffd166' : '#5ffbf1');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - halfW * 0.6, y);
    ctx.lineTo(x - halfW * 0.15, y);
    ctx.moveTo(x + halfW * 0.15, y);
    ctx.lineTo(x + halfW * 0.6, y);
    ctx.stroke();

    // Glowing power core
    var corePulse = 8 + Math.sin(this.pulse * 1.5) * 3;
    var coreColor = this.hitFlash > 0 ? '#ffffff' : (this.phase === 3 ? '#ff007f' : (this.phase === 2 ? '#ff2d55' : this.coreColor));
    ctx.fillStyle = coreColor;
    ctx.beginPath();
    ctx.arc(x, y - 2, corePulse, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  };

  SI.Bullet = Bullet;
  SI.Player = Player;
  SI.Alien = Alien;
  SI.Swarm = Swarm;
  SI.Boss = Boss;
})(window.SI = window.SI || {});
