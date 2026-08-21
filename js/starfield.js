/* starfield.js -- three parallax star layers over a prerendered nebula. */
(function (SI) {
  'use strict';

  var C = SI.CONFIG;

  var LAYERS = [
    { count: 130, speed: 14, size: 1.1, alpha: 0.42, glow: 3.2, color: '#8fb6ff' },
    { count: 70, speed: 38, size: 1.8, alpha: 0.66, glow: 5.5, color: '#cfe6ff' },
    { count: 34, speed: 82, size: 2.7, alpha: 0.95, glow: 9.0, color: '#ffffff' }
  ];

  function Starfield() {
    this.layers = [];
    this.shooting = [];
    this.shootTimer = SI.rand(2.5, 6);
    this.warp = 0;
    for (var i = 0; i < LAYERS.length; i++) {
      var def = LAYERS[i];
      var stars = new Array(def.count);
      for (var j = 0; j < def.count; j++) {
        stars[j] = {
          x: SI.rand(0, C.WORLD_W),
          y: SI.rand(0, C.WORLD_H),
          s: def.size * SI.rand(0.6, 1.35),
          tw: SI.rand(0, Math.PI * 2),
          tws: SI.rand(1.2, 3.4)
        };
      }
      this.layers.push({ def: def, stars: stars, sprite: SI.FX.glow(def.color) });
    }
  }

  // `boost` (0..1) speeds the field up, e.g. during wave transitions.
  Starfield.prototype.update = function (dt, boost) {
    this.warp = SI.lerp(this.warp, boost || 0, Math.min(1, dt * 3));
    var mul = 1 + this.warp * 6;
    for (var i = 0; i < this.layers.length; i++) {
      var layer = this.layers[i];
      var sp = layer.def.speed * mul;
      var stars = layer.stars;
      for (var j = 0; j < stars.length; j++) {
        var st = stars[j];
        st.y += sp * dt;
        st.tw += st.tws * dt;
        if (st.y > C.WORLD_H + 4) {
          st.y -= C.WORLD_H + 8;
          st.x = SI.rand(0, C.WORLD_W);
        }
      }
    }

    this.shootTimer -= dt;
    if (this.shootTimer <= 0) {
      this.shootTimer = SI.rand(3.5, 9);
      this.shooting.push({
        x: SI.rand(-80, C.WORLD_W * 0.9),
        y: SI.rand(-40, C.WORLD_H * 0.5),
        vx: SI.rand(420, 700),
        vy: SI.rand(160, 300),
        life: 1,
        len: SI.rand(50, 110)
      });
    }
    for (var k = this.shooting.length - 1; k >= 0; k--) {
      var sh = this.shooting[k];
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      sh.life -= dt * 0.85;
      if (sh.life <= 0 || sh.x > C.WORLD_W + 140 || sh.y > C.WORLD_H + 140) {
        this.shooting.splice(k, 1);
      }
    }
  };

  Starfield.prototype.draw = function (ctx) {
    SI.FX.drawNebula(ctx);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < this.layers.length; i++) {
      var layer = this.layers[i];
      var def = layer.def;
      var stars = layer.stars;
      var sprite = layer.sprite;
      var glowSize = def.glow * (1 + this.warp * 0.6);
      for (var j = 0; j < stars.length; j++) {
        var st = stars[j];
        var twinkle = 0.72 + 0.28 * Math.sin(st.tw);
        var a = def.alpha * twinkle;
        SI.FX.drawGlow(ctx, sprite, st.x, st.y, glowSize * st.s, a * 0.55);
        ctx.globalAlpha = a;
        ctx.fillStyle = def.color;
        ctx.fillRect(st.x - st.s / 2, st.y - st.s / 2, st.s, st.s + this.warp * 26);
      }
    }

    for (var k = 0; k < this.shooting.length; k++) {
      var sh = this.shooting[k];
      var n = Math.hypot(sh.vx, sh.vy) || 1;
      var ux = sh.vx / n;
      var uy = sh.vy / n;
      var a2 = Math.max(0, sh.life);
      var grad = ctx.createLinearGradient(sh.x, sh.y, sh.x - ux * sh.len, sh.y - uy * sh.len);
      grad.addColorStop(0, 'rgba(255,255,255,' + (0.9 * a2).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(120,200,255,0)');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y);
      ctx.lineTo(sh.x - ux * sh.len, sh.y - uy * sh.len);
      ctx.stroke();
    }
    ctx.restore();
  };

  SI.Starfield = Starfield;
})(window.SI = window.SI || {});
