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
  }

  Bullet.prototype.update = function (dt, world) {
    this.prevY = this.y;
    this.y += this.vy * dt;
    this.age += dt;
    if (this.y < -40 || this.y > C.WORLD_H + 40) {
      this.dead = true;
      return;
    }
    if (world.particles && Math.random() < 0.6) {
      world.particles.emitTrail(this.x, this.y + (this.vy > 0 ? -6 : 6), this.color, 9, 0.2);
    }
  };

  // Swept box: covers the travel since the previous frame so fast
  // bullets cannot tunnel through thin targets.
  Bullet.prototype.box = function () {
    var top = Math.min(this.y, this.prevY) - this.h / 2;
    var bottom = Math.max(this.y, this.prevY) + this.h / 2;
    return { x: this.x - this.w / 2, y: top, w: this.w, h: bottom - top };
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
      world.spawnBullet(new Bullet(
        this.x,
        this.y - this.h / 2 - 6,
        -C.BULLET.PLAYER_SPEED,
        'player',
        C.COLORS.bullet
      ));
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

  function Alien(col, row, type, color, score) {
    this.col = col;
    this.row = row;
    this.type = type;
    this.color = color;
    this.score = score;
    this.alive = true;
    this.x = 0;
    this.y = 0;
    this.w = C.SWARM.ALIEN_W;
    this.h = C.SWARM.ALIEN_H;
    this.hitFlash = 0;
  }

  Alien.prototype.box = function () {
    return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h };
  };

  Alien.prototype.draw = function (ctx, frame, bob) {
    var shape = SHAPES[this.type % SHAPES.length];
    var cols = shape[0].length;
    var rows = shape.length;
    var cw = this.w / cols;
    var ch = this.h / rows;
    var ox = this.x - this.w / 2;
    var oy = this.y - this.h / 2 + bob;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    SI.FX.drawGlow(ctx, SI.FX.glow(this.color), this.x, this.y + bob, this.w * 1.8, 0.4);
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
    // Eye highlight.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(ox + cw * 3, oy + ch * 2, cw, ch);
    ctx.fillRect(ox + cw * 7, oy + ch * 2, cw, ch);
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
        a.x = S.ORIGIN_X + c * S.CELL_W;
        a.y = cfg.startY + r * S.CELL_H;
        this.aliens.push(a);
        this.total++;
      }
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
    var b = this.bounds();
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
          a.y += C.SWARM.DESCEND;
        }
      }
      if (world.onDescend) {
        world.onDescend();
      }
    } else {
      for (i = 0; i < this.aliens.length; i++) {
        a = this.aliens[i];
        if (a.alive) {
          a.x += dx;
        }
      }
    }

    for (i = 0; i < this.aliens.length; i++) {
      a = this.aliens[i];
      if (a.hitFlash > 0) { a.hitFlash -= dt; }
    }

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

    if (this.bounds().maxY >= C.SWARM.FLOOR_Y && world.onInvasion) {
      world.onInvasion();
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
