/* main.js -- canvas setup, letterbox resize, and the rAF game loop. */
(function (SI) {
  'use strict';

  var C = SI.CONFIG;

  var canvas = null;
  var ctx = null;
  var game = null;
  var starfield = null;

  // Letterbox transform state, recomputed on resize only.
  var view = { scale: 1, dpr: 1, offX: 0, offY: 0, cssW: 0, cssH: 0 };

  var last = 0;
  var running = false;

  function resize() {
    var cssW = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 960);
    var cssH = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 720);
    var dpr = Math.min(window.devicePixelRatio || 1, C.MAX_DPR);

    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    var scale = Math.min(cssW / C.WORLD_W, cssH / C.WORLD_H);
    view.scale = scale;
    view.dpr = dpr;
    view.cssW = cssW;
    view.cssH = cssH;
    view.offX = (cssW - C.WORLD_W * scale) / 2;
    view.offY = (cssH - C.WORLD_H * scale) / 2;
  }

  // Screen (client) coordinates -> world units, for pointer/touch aiming.
  function toWorld(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.offX) / view.scale,
      y: (clientY - rect.top - view.offY) / view.scale
    };
  }

  function applyTransform() {
    var shake = SI.FX.shakeOffset();
    var s = view.scale * view.dpr;
    ctx.setTransform(
      s, 0, 0, s,
      (view.offX + shake.x * view.scale) * view.dpr,
      (view.offY + shake.y * view.scale) * view.dpr
    );
  }

  function frame(now) {
    if (!running) {
      return;
    }
    window.requestAnimationFrame(frame);

    if (!last) {
      last = now;
    }
    // Delta time in seconds, clamped so a stall never teleports entities.
    var dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) {
      dt = 0;
    }
    if (dt > C.MAX_DT) {
      dt = C.MAX_DT;
    }

    // ---- update -------------------------------------------------
    game.update(dt);
    starfield.update(dt, game.starfieldBoost());
    SI.FX.updateShake(dt);

    // ---- draw ---------------------------------------------------
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#04030b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    applyTransform();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, C.WORLD_W, C.WORLD_H);
    ctx.clip();

    starfield.draw(ctx);
    game.draw(ctx);
    game.particles.draw(ctx);
    game.drawHud(ctx);
    SI.FX.drawOverlay(ctx);

    ctx.restore();
    SI.Input.endFrame();
  }

  function onVisibility() {
    if (document.hidden) {
      game.blurPause();
    } else {
      // Reset the clock so the first frame back is not a huge delta.
      last = 0;
    }
  }

  function boot() {
    canvas = document.getElementById('game');
    if (!canvas) {
      // Nothing to draw into; fail loudly but without throwing on load.
      if (window.console && window.console.warn) {
        window.console.warn('NEON INVADERS: #game canvas not found.');
      }
      return;
    }
    ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
      ctx = canvas.getContext('2d');
    }

    SI.FX.init();
    starfield = new SI.Starfield();
    game = new SI.Game();
    SI.game = game;

    SI.Input.attach(canvas);
    SI.Input.setMapper(toWorld);
    SI.Input.onFirstGesture(function () {
      SI.Audio.unlock();
    });

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    document.addEventListener('visibilitychange', onVisibility);

    running = true;
    last = 0;
    window.requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.SI = window.SI || {});
