/* particles.js -- fixed-capacity pooled particle system.
 *
 * The pool is a flat array; active particles are kept packed at the
 * front (`count`). Killing a particle swaps it with the last active one,
 * so there is no allocation and no free-list scan at runtime.
 *
 * Rendering is additive blitting of prerendered glow sprites -- never
 * ctx.shadowBlur, which would collapse the framerate at this count.
 */
(function (SI) {
  'use strict';

  var CAP = 1200;

  function makeParticle() {
    return {
      x: 0, y: 0, vx: 0, vy: 0,
      life: 0, maxLife: 1,
      size: 4, endSize: 0,
      drag: 0.9, gravity: 0,
      alpha: 1,
      kind: 0,          // 0 = glow blob, 1 = debris shard
      angle: 0, spin: 0,
      sprite: null,
      color: '#ffffff'
    };
  }

  function Particles(cap) {
    this.cap = cap || CAP;
    this.pool = new Array(this.cap);
    for (var i = 0; i < this.cap; i++) {
      this.pool[i] = makeParticle();
    }
    this.count = 0;
  }

  Particles.prototype.clear = function () {
    this.count = 0;
  };

  Particles.prototype.active = function () {
    return this.count;
  };

  // Returns a particle slot, or null when the pool is saturated.
  Particles.prototype.spawn = function () {
    if (this.count >= this.cap) {
      return null;
    }
    return this.pool[this.count++];
  };

  Particles.prototype.update = function (dt) {
    var i = 0;
    while (i < this.count) {
      var p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.count--;
        if (i !== this.count) {
          this.pool[i] = this.pool[this.count];
          this.pool[this.count] = p;
        }
        continue;
      }
      var d = Math.pow(p.drag, dt * 60);
      p.vx *= d;
      p.vy *= d;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 1) {
        p.angle += p.spin * dt;
      }
      i++;
    }
  };

  Particles.prototype.draw = function (ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < this.count; i++) {
      var p = this.pool[i];
      var t = p.life / p.maxLife;
      if (t < 0) { t = 0; }
      var a = p.alpha * t;
      var size = p.endSize + (p.size - p.endSize) * t;
      if (p.kind === 1) {
        // save/restore keeps the outer letterbox transform intact.
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillRect(-size / 2, -size / 6, size, size / 3);
        ctx.restore();
      } else {
        SI.FX.drawGlow(ctx, p.sprite, p.x, p.y, size, a);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* ----------------------------- emitters --------------------------- */

  Particles.prototype.emitExplosion = function (x, y, color, count, power) {
    var sprite = SI.FX.glow(color);
    var n = count || 26;
    var pw = power || 1;
    for (var i = 0; i < n; i++) {
      var p = this.spawn();
      if (!p) { return; }
      var ang = SI.rand(0, Math.PI * 2);
      var sp = SI.rand(40, 260) * pw;
      p.kind = 0;
      p.sprite = sprite;
      p.color = color;
      p.x = x + SI.rand(-4, 4);
      p.y = y + SI.rand(-4, 4);
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp;
      p.maxLife = SI.rand(0.35, 0.95) * (0.7 + pw * 0.4);
      p.life = p.maxLife;
      p.size = SI.rand(10, 30) * pw;
      p.endSize = 1;
      p.drag = 0.90;
      p.gravity = SI.rand(20, 90);
      p.alpha = 0.95;
    }
    // A short-lived bright core.
    var core = this.spawn();
    if (core) {
      core.kind = 0;
      core.sprite = SI.FX.glow('#ffffff');
      core.x = x;
      core.y = y;
      core.vx = 0;
      core.vy = 0;
      core.maxLife = 0.16;
      core.life = core.maxLife;
      core.size = 90 * pw;
      core.endSize = 10;
      core.drag = 1;
      core.gravity = 0;
      core.alpha = 1;
    }
  };

  Particles.prototype.emitSparks = function (x, y, color, count, dirX, dirY, spread) {
    var sprite = SI.FX.glow(color);
    var n = count || 8;
    var baseAng = Math.atan2(dirY == null ? -1 : dirY, dirX == null ? 0 : dirX);
    var sp2 = spread == null ? 0.9 : spread;
    for (var i = 0; i < n; i++) {
      var p = this.spawn();
      if (!p) { return; }
      var ang = baseAng + SI.rand(-sp2, sp2);
      var sp = SI.rand(90, 320);
      p.kind = 0;
      p.sprite = sprite;
      p.color = color;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp;
      p.maxLife = SI.rand(0.16, 0.4);
      p.life = p.maxLife;
      p.size = SI.rand(6, 14);
      p.endSize = 0;
      p.drag = 0.86;
      p.gravity = 140;
      p.alpha = 0.9;
    }
  };

  Particles.prototype.emitDebris = function (x, y, color, count, power) {
    var n = count || 10;
    var pw = power || 1;
    for (var i = 0; i < n; i++) {
      var p = this.spawn();
      if (!p) { return; }
      var ang = SI.rand(0, Math.PI * 2);
      var sp = SI.rand(60, 220) * pw;
      p.kind = 1;
      p.color = color;
      p.sprite = null;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp - SI.rand(20, 90);
      p.maxLife = SI.rand(0.5, 1.3);
      p.life = p.maxLife;
      p.size = SI.rand(6, 16);
      p.endSize = 2;
      p.drag = 0.97;
      p.gravity = SI.rand(260, 460);
      p.angle = ang;
      p.spin = SI.rand(-9, 9);
      p.alpha = 0.85;
    }
  };

  Particles.prototype.emitTrail = function (x, y, color, size, life) {
    var p = this.spawn();
    if (!p) { return; }
    p.kind = 0;
    p.sprite = SI.FX.glow(color);
    p.color = color;
    p.x = x;
    p.y = y;
    p.vx = SI.rand(-14, 14);
    p.vy = SI.rand(10, 60);
    p.maxLife = life || 0.28;
    p.life = p.maxLife;
    p.size = size || 12;
    p.endSize = 0;
    p.drag = 0.9;
    p.gravity = 0;
    p.alpha = 0.7;
  };

  SI.Particles = Particles;
  SI.PARTICLE_CAP = CAP;
})(window.SI = window.SI || {});
