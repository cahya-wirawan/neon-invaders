/* props.js -- destructible bunkers and the bonus UFO.
 * Split out of entities.js to keep each file small and single-purpose.
 */
(function (SI) {
  'use strict';

  var C = SI.CONFIG;

  /* ------------------------------ Bunker ---------------------------- */

  function Bunker(x, y) {
    var B = C.BUNKER;
    this.cols = B.COLS;
    this.rows = B.ROWS;
    this.cell = B.CELL;
    this.w = this.cols * this.cell;
    this.h = this.rows * this.cell;
    this.x = x - this.w / 2;
    this.y = y;
    this.cells = new Uint8Array(this.cols * this.rows);
    this.build();
  }

  // Classic arch silhouette: solid block with a notch cut from the base
  // and rounded top corners.
  Bunker.prototype.build = function () {
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var solid = 1;
        if (r === 0 && (c < 2 || c >= this.cols - 2)) { solid = 0; }
        if (r === 1 && (c < 1 || c >= this.cols - 1)) { solid = 0; }
        var mid = this.cols / 2;
        var notchHalf = 2 + (this.rows - r) * 0.15;
        if (r >= this.rows - 3 && Math.abs(c + 0.5 - mid) < notchHalf) { solid = 0; }
        this.cells[r * this.cols + c] = solid;
      }
    }
  };

  Bunker.prototype.alive = function () {
    for (var i = 0; i < this.cells.length; i++) {
      if (this.cells[i]) { return true; }
    }
    return false;
  };

  Bunker.prototype.box = function () {
    return { x: this.x, y: this.y, w: this.w, h: this.h };
  };

  // Returns the world-space centre of the first solid cell overlapping
  // `box`, or null. Callers should bounding-box test first.
  //
  // `vy` is the projectile's vertical velocity. A swept bullet box can
  // span several rows, so the scan must start at the row the projectile
  // reaches first: top-down for shots falling (vy > 0), bottom-up for
  // player shots climbing (vy < 0). Defaults to top-down.
  Bunker.prototype.hitTest = function (box, vy) {
    if (!SI.aabb(box, this.box())) {
      return null;
    }
    var c0 = Math.max(0, Math.floor((box.x - this.x) / this.cell));
    var c1 = Math.min(this.cols - 1, Math.floor((box.x + box.w - this.x) / this.cell));
    var r0 = Math.max(0, Math.floor((box.y - this.y) / this.cell));
    var r1 = Math.min(this.rows - 1, Math.floor((box.y + box.h - this.y) / this.cell));
    var up = vy < 0;
    var rStart = up ? r1 : r0;
    var rEnd = up ? r0 : r1;
    var rStep = up ? -1 : 1;
    for (var r = rStart; up ? r >= rEnd : r <= rEnd; r += rStep) {
      for (var c = c0; c <= c1; c++) {
        if (this.cells[r * this.cols + c]) {
          return {
            x: this.x + (c + 0.5) * this.cell,
            y: this.y + (r + 0.5) * this.cell
          };
        }
      }
    }
    return null;
  };

  // Erodes cells around an impact point; edge cells survive randomly so
  // the damage looks chewed rather than circular.
  Bunker.prototype.damage = function (wx, wy, radius) {
    var rad = radius || this.cell * 1.6;
    var removed = 0;
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var idx = r * this.cols + c;
        if (!this.cells[idx]) { continue; }
        var cx = this.x + (c + 0.5) * this.cell;
        var cy = this.y + (r + 0.5) * this.cell;
        var d = Math.hypot(cx - wx, cy - wy);
        if (d < rad * 0.65 || (d < rad && SI.chance(0.55))) {
          this.cells[idx] = 0;
          removed++;
        }
      }
    }
    return removed;
  };

  // Aliens grind bunkers away when the formation reaches them.
  Bunker.prototype.crushBelow = function (box) {
    var removed = 0;
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var idx = r * this.cols + c;
        if (!this.cells[idx]) { continue; }
        var cell = {
          x: this.x + c * this.cell,
          y: this.y + r * this.cell,
          w: this.cell,
          h: this.cell
        };
        if (SI.aabb(cell, box)) {
          this.cells[idx] = 0;
          removed++;
        }
      }
    }
    return removed;
  };

  Bunker.prototype.draw = function (ctx) {
    var color = C.COLORS.bunker;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    SI.FX.drawGlow(ctx, SI.FX.glow(color), this.x + this.w / 2, this.y + this.h / 2, this.w * 1.5, 0.22);
    ctx.restore();

    ctx.globalAlpha = 1;
    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        if (!this.cells[r * this.cols + c]) { continue; }
        // Slight vertical shading so the block reads as 3D.
        ctx.fillStyle = r < 2 ? '#7dffc4' : (r > this.rows - 3 ? '#2fd48d' : color);
        ctx.fillRect(this.x + c * this.cell, this.y + r * this.cell, this.cell - 0.5, this.cell - 0.5);
      }
    }
  };

  /* -------------------------------- UFO ----------------------------- */

  function Ufo(dir, wave) {
    var U = C.UFO;
    this.w = U.W;
    this.h = U.H;
    this.dir = dir;
    this.y = U.Y;
    this.speed = U.SPEED * (1 + Math.min(wave || 1, 8) * 0.05);
    this.x = dir > 0 ? -this.w : C.WORLD_W + this.w;
    this.dead = false;
    this.phase = 0;
    this.isSaboteur = !!(wave >= 5 && (wave % 2 === 1));
    this.color = this.isSaboteur ? (C.COLORS.saboteurUfo || '#d680ff') : C.COLORS.ufo;
    this.score = this.isSaboteur ? 500 : SI.pick(U.SCORES);
  }

  Ufo.prototype.box = function () {
    return { x: this.x - this.w / 2, y: this.y - this.h / 2, w: this.w, h: this.h };
  };

  Ufo.prototype.update = function (dt, world) {
    this.phase += dt;
    this.x += this.dir * this.speed * dt;
    if (this.isSaboteur && world && typeof world.empCharge === 'number') {
      world.empCharge = Math.max(0, world.empCharge - 0.05 * dt);
    }
    if ((this.dir > 0 && this.x > C.WORLD_W + this.w) ||
        (this.dir < 0 && this.x < -this.w)) {
      this.dead = true;
      this.escaped = true;
      return;
    }
    if (world.particles && Math.random() < 0.5) {
      world.particles.emitTrail(this.x - this.dir * this.w * 0.4, this.y + 6, this.color, 10, 0.3);
    }
  };

  Ufo.prototype.kill = function (world) {
    this.dead = true;
    if (world.particles) {
      world.particles.emitExplosion(this.x, this.y, this.color, 40, 1.35);
      world.particles.emitDebris(this.x, this.y, '#ffffff', 14, 1.1);
    }
    if (world.audio) {
      world.audio.ufoKilled();
    }
    if (world.shake) {
      world.shake(12, 0.3);
    }
    return this.score;
  };

  Ufo.prototype.draw = function (ctx) {
    var w = this.w;
    var h = this.h;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    SI.FX.drawGlow(ctx, SI.FX.glow(this.color), 0, 0, w * 2.0, this.isSaboteur ? 0.75 : 0.5);
    ctx.restore();

    var ufoAlpha = this.isSaboteur ? 0.7 + 0.3 * Math.sin(this.phase * 6) : 1;
    ctx.globalAlpha = ufoAlpha;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.35, w * 0.22, h * 0.42, 0, Math.PI, Math.PI * 2);
    ctx.fill();

    // Rotating running lights.
    for (var i = 0; i < 5; i++) {
      var t = this.phase * 5 + i * 1.25;
      var lx = (i - 2) * (w * 0.17);
      var a = 0.35 + 0.65 * Math.abs(Math.sin(t));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      SI.FX.drawGlow(ctx, SI.FX.glow(i % 2 ? '#ffe066' : '#66fff0'), lx, h * 0.22, 14, a);
      ctx.restore();
    }
    ctx.restore();
  };

  SI.Bunker = Bunker;
  SI.Ufo = Ufo;
})(window.SI = window.SI || {});
