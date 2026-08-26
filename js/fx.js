/* fx.js -- prerendered glow sprites, screen shake and CRT overlay.
 *
 * Particles must never use ctx.shadowBlur (it is per-draw expensive and
 * destroys framerate at ~1000 particles). Instead we prerender a handful
 * of radial-gradient sprites once, then blit them with
 * globalCompositeOperation = 'lighter' for an additive bloom look.
 */
(function (SI) {
  'use strict';

  var SPRITE_SIZE = 64;
  var cache = {};
  var overlayCanvas = null;
  var nebula = null;

  function makeGlowSprite(color, softness) {
    var c = document.createElement('canvas');
    c.width = SPRITE_SIZE;
    c.height = SPRITE_SIZE;
    var g = c.getContext('2d');
    var r = SPRITE_SIZE / 2;
    var grad = g.createRadialGradient(r, r, 0, r, r, r);
    var core = softness == null ? 0.16 : softness;
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(core, hexToRgba(color, 0.85));
    grad.addColorStop(0.55, hexToRgba(color, 0.28));
    grad.addColorStop(1, hexToRgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    return c;
  }

  function hexToRgba(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    var n = parseInt(h, 16);
    if (isNaN(n)) {
      n = 0xffffff;
    }
    var r = (n >> 16) & 255;
    var g = (n >> 8) & 255;
    var b = n & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  // Returns (and lazily builds) a cached glow sprite for a colour.
  function glow(color, softness) {
    var key = color + '|' + (softness == null ? 'd' : softness);
    var sprite = cache[key];
    if (!sprite) {
      sprite = makeGlowSprite(color, softness);
      cache[key] = sprite;
    }
    return sprite;
  }

  // Additive blit of a glow sprite centred on (x, y).
  // Caller is responsible for save/restore of composite mode when batching.
  function drawGlow(ctx, sprite, x, y, size, alpha) {
    if (alpha <= 0 || size <= 0) {
      return;
    }
    ctx.globalAlpha = alpha > 1 ? 1 : alpha;
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
  }

  function beginAdditive(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
  }

  function endAdditive(ctx) {
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* Screen shake                                                        */
  /* ------------------------------------------------------------------ */

  var shake = {
    time: 0,
    duration: 0,
    power: 0,
    x: 0,
    y: 0
  };

  function addShake(power, duration) {
    if (power > shake.power || shake.time <= 0) {
      shake.power = Math.max(shake.power, power);
      shake.duration = Math.max(duration || 0.28, 0.05);
      shake.time = shake.duration;
    }
  }

  function updateShake(dt) {
    if (shake.time > 0) {
      shake.time -= dt;
      if (shake.time <= 0) {
        shake.time = 0;
        shake.power = 0;
        shake.x = 0;
        shake.y = 0;
        return;
      }
      var k = shake.time / shake.duration;
      var amp = shake.power * k * k;
      shake.x = SI.rand(-amp, amp);
      shake.y = SI.rand(-amp, amp);
    } else {
      shake.x = 0;
      shake.y = 0;
    }
  }

  function shakeOffset() {
    return shake;
  }

  /* ------------------------------------------------------------------ */
  /* Overlay: CRT Scanlines + Phosphor Bloom modes                       */
  /* ------------------------------------------------------------------ */

  var CRT_KEY = 'neon_invaders_crt_mode';
  var CRT_MODES = ['OFF', 'SCANLINES', 'PHOSPHOR'];
  var currentCRTMode = 1;
  var scanlinesCanvas = null;
  var phosphorCanvas = null;

  function loadCRTMode() {
    if (typeof localStorage !== 'undefined') {
      try {
        var v = localStorage.getItem(CRT_KEY);
        if (v !== null) {
          var idx = parseInt(v, 10);
          if (!isNaN(idx) && idx >= 0 && idx < CRT_MODES.length) {
            currentCRTMode = idx;
          }
        }
      } catch (e) { /* ignore */ }
    }
  }

  function saveCRTMode() {
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(CRT_KEY, String(currentCRTMode));
      } catch (e) { /* ignore */ }
    }
  }

  function getCRTMode() {
    return currentCRTMode;
  }

  function getCRTModeName() {
    return CRT_MODES[currentCRTMode] || 'OFF';
  }

  function setCRTMode(mode) {
    if (typeof mode === 'number') {
      currentCRTMode = (mode % CRT_MODES.length + CRT_MODES.length) % CRT_MODES.length;
    } else if (typeof mode === 'string') {
      var idx = CRT_MODES.indexOf(mode.toUpperCase());
      if (idx >= 0) { currentCRTMode = idx; }
    }
    saveCRTMode();
    return currentCRTMode;
  }

  function cycleCRTMode() {
    currentCRTMode = (currentCRTMode + 1) % CRT_MODES.length;
    saveCRTMode();
    return currentCRTMode;
  }

  function buildOverlay() {
    var W = SI.CONFIG.WORLD_W;
    var H = SI.CONFIG.WORLD_H;

    // Scanlines mode: standard 3px scanline + radial vignette
    var c1 = document.createElement('canvas');
    c1.width = W;
    c1.height = H;
    var g1 = c1.getContext('2d');
    g1.fillStyle = 'rgba(0,0,0,0.16)';
    for (var y = 0; y < H; y += 3) {
      g1.fillRect(0, y, W, 1);
    }
    var vg1 = g1.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.82);
    vg1.addColorStop(0, 'rgba(0,0,0,0)');
    vg1.addColorStop(1, 'rgba(0,0,0,0.62)');
    g1.fillStyle = vg1;
    g1.fillRect(0, 0, W, H);
    scanlinesCanvas = c1;

    // Phosphor mode: denser 2px scanlines + phosphor curvature vignette
    var c2 = document.createElement('canvas');
    c2.width = W;
    c2.height = H;
    var g2 = c2.getContext('2d');
    g2.fillStyle = 'rgba(0,0,0,0.24)';
    for (var y2 = 0; y2 < H; y2 += 2) {
      g2.fillRect(0, y2, W, 1);
    }
    var vg2 = g2.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.78);
    vg2.addColorStop(0, 'rgba(0,0,0,0)');
    vg2.addColorStop(0.7, 'rgba(0,20,10,0.22)');
    vg2.addColorStop(1, 'rgba(0,0,0,0.78)');
    g2.fillStyle = vg2;
    g2.fillRect(0, 0, W, H);
    phosphorCanvas = c2;

    overlayCanvas = scanlinesCanvas;
    loadCRTMode();
  }

  function buildNebula() {
    var W = SI.CONFIG.WORLD_W;
    var H = SI.CONFIG.WORLD_H;
    var c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    var g = c.getContext('2d');

    var base = g.createLinearGradient(0, 0, 0, H);
    base.addColorStop(0, '#0b0a24');
    base.addColorStop(0.55, '#07061a');
    base.addColorStop(1, '#04030d');
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);

    var blobs = [
      { x: 0.22, y: 0.28, r: 0.55, c: 'rgba(94,44,190,0.30)' },
      { x: 0.78, y: 0.18, r: 0.48, c: 'rgba(20,110,190,0.26)' },
      { x: 0.55, y: 0.82, r: 0.62, c: 'rgba(190,30,140,0.16)' },
      { x: 0.10, y: 0.72, r: 0.40, c: 'rgba(30,180,180,0.13)' }
    ];
    g.globalCompositeOperation = 'lighter';
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var cx = b.x * W;
      var cy = b.y * H;
      var rr = b.r * W;
      var grad = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
      grad.addColorStop(0, b.c);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, W, H);
    }
    g.globalCompositeOperation = 'source-over';
    nebula = c;
  }

  function drawNebula(ctx) {
    if (nebula) {
      ctx.drawImage(nebula, 0, 0);
    }
  }

  function drawOverlay(ctx) {
    if (currentCRTMode === 0) {
      return;
    }
    var activeCanvas = currentCRTMode === 2 ? phosphorCanvas : scanlinesCanvas;
    if (activeCanvas) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(activeCanvas, 0, 0);
      ctx.restore();
    }
  }

  // Draws text with a soft neon glow. Cheap enough for HUD-sized use only.
  function glowText(ctx, text, x, y, opts) {
    var o = opts || {};
    ctx.save();
    ctx.font = o.font || '20px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.baseline || 'alphabetic';
    ctx.shadowColor = o.glow || o.color || '#9df3ff';
    ctx.shadowBlur = o.blur == null ? 14 : o.blur;
    ctx.fillStyle = o.color || '#9df3ff';
    ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
    ctx.fillText(text, x, y);
    // Opt-in brighter core. The second pass is drawn with the blur off,
    // so it costs a plain fillText instead of a second full shadow pass.
    if (o.double) {
      ctx.shadowBlur = 0;
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }

  function init() {
    buildOverlay();
    buildNebula();
    // Warm the most common sprites so the first explosion does not hitch.
    var colors = SI.CONFIG.COLORS;
    glow(colors.player);
    glow(colors.bullet);
    glow(colors.alienBullet);
    glow(colors.accent);
    glow(colors.warn);
    glow(colors.ufo);
    for (var i = 0; i < colors.alienRows.length; i++) {
      glow(colors.alienRows[i]);
    }
  }

  SI.FX = {
    init: init,
    glow: glow,
    drawGlow: drawGlow,
    beginAdditive: beginAdditive,
    endAdditive: endAdditive,
    addShake: addShake,
    updateShake: updateShake,
    shakeOffset: shakeOffset,
    drawOverlay: drawOverlay,
    drawNebula: drawNebula,
    glowText: glowText,
    hexToRgba: hexToRgba,
    getCRTMode: getCRTMode,
    getCRTModeName: getCRTModeName,
    setCRTMode: setCRTMode,
    cycleCRTMode: cycleCRTMode
  };
})(window.SI = window.SI || {});
