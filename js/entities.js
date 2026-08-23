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
      var haloCrest = (this.personality && this.personality.color) || C.COLORS.commander;
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
    }
    // A shield that just ATE a hit flares for SHIELD.FLASH seconds. hitFlash
    // is an existing per-alien timer already ticked down in Swarm.update.
    if (this.hitFlash > 0) {
      SI.FX.drawGlow(ctx, SI.FX.glow(C.COLORS.shieldAlien), this.x, this.y + bob, this.w * 3.6, 0.8);
    }
    ctx.restore();

    ctx.globalAlpha = 1;
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
    // PRE-WARM the class glow sprites, and only on the waves that will
    // actually draw them. js/fx.js's own init() warm-list is frozen this
    // round, but SI.FX.glow() builds-and-CACHES lazily, so one throwaway
    // call here has exactly the same effect as being in that list: the
    // radial-gradient offscreen canvas is built at wave start rather than
    // mid-frame the first time a class tell is blitted. glow() draws a
    // gradient into a canvas and consumes no Math.random, so the RNG stream
    // is untouched (scenario 24 counts the draws and pins that).
    if (SI.FX && SI.FX.glow) {
      if (this.shield) { SI.FX.glow(C.COLORS.shieldAlien); }
      if (this.kamikaze) { SI.FX.glow(C.COLORS.kamikaze); }
    }

    // Applied after the commander block so the timer's own draw (above)
    // keeps its original position in the random stream; this only rescales
    // the value that draw already produced.
    //
    // Only the JITTER is scaled. FORMATION.FIRST_DELAY is the documented
    // grace period before the first formation of a wave, and no personality
    // is allowed to quietly shorten (or stretch) it -- a TACTICIAN wave
    // re-arms sooner AFTER that grace period, not during it.
    if (this.personality && this.formationsEnabled) {
      this.formationTimer = F.FIRST_DELAY + firstJitter * this.personality.gapScale;
    }
  }

  /* --------------------------- alien classes ------------------------ */

  // Tags one grid cell with a class. `aliens` is row-major -- the
  // constructor fills row 0 first, COLS entries per row -- so the cell is
  // at row * COLS + col, the same convention the commander pick uses when
  // it treats indices 0..COLS-1 as row 0.
  //
  // The commander guard is what makes "a commander never also carries a
  // class" STRUCTURAL rather than a coincidence of the row numbers: even if
  // a future round moved SHIELD.ROW to 0, the class would simply not be
  // assigned rather than stacking two tells on one sprite. One unit, one
  // tell -- the second guard (`a.role`) keeps two classes off one alien too.
  Swarm.prototype.assignRole = function (role, row, col) {
    var a = this.aliens[row * C.SWARM.COLS + col];
    if (!a || a.commander || a.role) { return null; }
    a.role = role;
    a.color = role === 'shield' ? C.COLORS.shieldAlien : C.COLORS.kamikaze;
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
      if (!a.alive || a.dive) { continue; }
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

    // Writes the effective x/y for this tick. With no formation running
    // it is a plain `x = gx; y = gy`.
    this.updateFormation(dt, world);
    // Runs AFTER applyFormation() has written everyone else's effective
    // position, because a committed diver owns its x/y outright and must
    // have the last word on them.
    this.updateDive(dt, world);

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
        var shooter = this.pickShooter();
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
      // A committed kamikaze is not part of the grid any more: it owns its
      // own absolute x/y and must not be yanked back onto its anchor.
      if (a.dive) { continue; }
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

  // Drop-in for the inline SI.rand(MIN_GAP, MAX_GAP) re-arms: still exactly
  // ONE draw, so the random stream keeps its shape whether or not a
  // personality is in play.
  Swarm.prototype.nextFormationGap = function () {
    var g = SI.rand(C.FORMATION.MIN_GAP, C.FORMATION.MAX_GAP);
    var p = this.activePersonality();
    if (p) { g *= p.gapScale; }
    return g;
  };

  // `kind` may be 'wedge', 'dive', or null to alternate.
  Swarm.prototype.startFormation = function (kind, world) {
    var F = C.FORMATION;
    var S = C.SWARM;
    var i, a;

    // An explicitly-passed `kind` always wins outright. Only the default
    // (null) path consults the commander's personality, which narrows or
    // reorders the repertoire it cycles through.
    var p = this.activePersonality();
    if (!kind) {
      kind = (p && p.kinds) ?
        p.kinds[this.formationCount % p.kinds.length] :
        ((this.formationCount % 2 === 0) ? 'wedge' : 'dive');
    }
    // A committed diver is never a formation participant: applyFormation()
    // and snapToGrid() both skip it, so writing fx/fy on it would only leave
    // stale offsets on an object nothing reads -- a landmine for any future
    // "abort the dive and rejoin the formation" path.
    for (i = 0; i < this.aliens.length; i++) {
      if (this.aliens[i].dive) { continue; }
      this.aliens[i].fx = 0;
      this.aliens[i].fy = 0;
    }

    var col = -1;
    if (kind === 'dive') {
      var cols = [];
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        // Same guard on the candidate columns: a diver is not eligible, and
        // counting it could hand the whole formation a column whose only
        // "member" has left the grid -- a full ease-in/hold/ease-out cycle
        // spent displacing nothing.
        if (a.alive && !a.dive && cols.indexOf(a.col) < 0) { cols.push(a.col); }
      }
      if (!cols.length) { return null; }
      col = SI.pick(cols);
      // Sampled ONCE, at dive start: the column commits to where the ship
      // was, it does not track it.
      var targetX = (world && typeof world.playerX === 'number') ?
        world.playerX : C.WORLD_W / 2;
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.dive || a.col !== col) { continue; }
        a.fy = F.DIVE_DEPTH;
        a.fx = targetX - a.gx;
      }
    } else {
      // V-shape: apex at the centre column, pinched inwards.
      var m = (S.COLS - 1) / 2;
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.dive) { continue; }
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

    if (f) {
      f.t += dt;
      if (f.phase === 0) {
        if (f.t >= F.EASE_IN) {
          f.phase = 1;
          f.t = 0;
          f.k = 1;
        } else {
          f.k = SI.smoothstep(f.t / F.EASE_IN);
        }
      } else if (f.phase === 1) {
        f.k = 1;
        if (f.t >= F.HOLD) {
          f.phase = 2;
          f.t = 0;
        }
      } else if (f.t >= F.EASE_OUT) {
        this.endFormation();
      } else {
        f.k = 1 - SI.smoothstep(f.t / F.EASE_OUT);
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
        if (!a.alive || a.dive) { continue; }
        a.x = a.gx;
        a.y = a.gy;
      }
      return;
    }

    for (i = 0; i < this.aliens.length; i++) {
      a = this.aliens[i];
      if (!a.alive || a.dive) { continue; }
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

  Swarm.prototype.pickShooter = function () {
    var byCol = {};
    for (var i = 0; i < this.aliens.length; i++) {
      var a = this.aliens[i];
      // A committed rammer is out of the firing line: it is usually the
      // lowest alien in its column, so leaving it eligible would let it hog
      // the shooter role all the way down.
      if (!a.alive || a.dive) { continue; }
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
    return list.length ? SI.pick(list) : null;
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

  SI.Bullet = Bullet;
  SI.Player = Player;
  SI.Alien = Alien;
  SI.Swarm = Swarm;
})(window.SI = window.SI || {});
