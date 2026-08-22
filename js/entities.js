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
    if (up === 'pierce') {
      b.pierce = U.PIERCE_COUNT;
      b.color = C.COLORS.playerGlow;
    } else if (up === 'bounce') {
      b.bounce = U.BOUNCE_MAX;
      b.vx = U.BOUNCE_VX * this.bounceSide;
      // A bouncing shot climbs SLOWER than a normal one (BOUNCE_VY, not
      // PLAYER_SPEED). At the standard 720 it leaves the top of the world in
      // 0.93s and covers only ~520 units sideways, which is not enough to
      // reach a wall from mid-screen -- the upgrade would be inert. See the
      // arithmetic in CONFIG.UPGRADE.
      b.vy = -U.BOUNCE_VY;
      this.bounceSide = -this.bounceSide;
      b.color = C.COLORS.warn;
    }
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
    // -- still an additive sprite blit, never per-alien shadowBlur.
    if (this.commander) {
      SI.FX.drawGlow(ctx, SI.FX.glow(C.COLORS.commander), this.x, this.y + bob, this.w * 3.1, 0.5);
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
      ctx.fillStyle = C.COLORS.commander;
      ctx.fillRect(ox + cw * 1.6, oy - ch * 0.5, this.w * 0.72, ch * 0.6);
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
    if (this.formationsEnabled) {
      this.formationTimer = F.FIRST_DELAY + SI.rand(0, F.MAX_GAP - F.MIN_GAP);
    }

    this.commander = null;
    if (wave >= C.COMMANDER.FROM_WAVE) {
      // Row 0 occupies indices 0 .. COLS-1 of `aliens`.
      var cmd = this.aliens[SI.randInt(0, S.COLS - 1)];
      cmd.commander = true;
      cmd.score += C.COMMANDER.SCORE_BONUS;
      cmd.color = C.COLORS.commander;
      this.commander = cmd;
    }
  }

  Swarm.prototype.aliveCount = function () {
    var n = 0;
    for (var i = 0; i < this.aliens.length; i++) {
      if (this.aliens[i].alive) { n++; }
    }
    return n;
  };

  Swarm.prototype.bounds = function () {
    var minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < this.aliens.length; i++) {
      var a = this.aliens[i];
      if (!a.alive) { continue; }
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

    // Aliens shoot: timer + probability, from the lowest alien in a
    // random occupied column so nobody shoots through a friend.
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) {
      var delay = this.fireDelay * SI.rand(0.55, 1.35) * (0.55 + alive / Math.max(1, this.total) * 0.9);
      this.fireTimer = Math.max(0.16, delay);
      if (world.alienBulletCount() < this.maxBullets && SI.chance(0.86)) {
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
      a.fx = 0;
      a.fy = 0;
      a.x = a.gx;
      a.y = a.gy;
    }
    this.formation = null;
  };

  Swarm.prototype.endFormation = function () {
    this.snapToGrid();
    this.formationTimer = SI.rand(C.FORMATION.MIN_GAP, C.FORMATION.MAX_GAP);
  };

  // `kind` may be 'wedge', 'dive', or null to alternate.
  Swarm.prototype.startFormation = function (kind, world) {
    var F = C.FORMATION;
    var S = C.SWARM;
    var i, a;

    if (!kind) {
      kind = (this.formationCount % 2 === 0) ? 'wedge' : 'dive';
    }
    for (i = 0; i < this.aliens.length; i++) {
      this.aliens[i].fx = 0;
      this.aliens[i].fy = 0;
    }

    var col = -1;
    if (kind === 'dive') {
      var cols = [];
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (a.alive && cols.indexOf(a.col) < 0) { cols.push(a.col); }
      }
      if (!cols.length) { return null; }
      col = SI.pick(cols);
      // Sampled ONCE, at dive start: the column commits to where the ship
      // was, it does not track it.
      var targetX = (world && typeof world.playerX === 'number') ?
        world.playerX : C.WORLD_W / 2;
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive || a.col !== col) { continue; }
        a.fy = F.DIVE_DEPTH;
        a.fx = targetX - a.gx;
      }
    } else {
      // V-shape: apex at the centre column, pinched inwards.
      var m = (S.COLS - 1) / 2;
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (!a.alive) { continue; }
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
          this.formationTimer = SI.rand(F.MIN_GAP, F.MAX_GAP);
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
        if (!a.alive) { continue; }
        a.x = a.gx;
        a.y = a.gy;
      }
      return;
    }

    for (i = 0; i < this.aliens.length; i++) {
      a = this.aliens[i];
      if (!a.alive) { continue; }
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
      if (!a.alive) { continue; }
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
