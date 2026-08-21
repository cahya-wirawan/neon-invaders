/* hud.js -- on-canvas HUD and state overlays.
 * No DOM elements: everything is drawn into the canvas so there are no
 * element ids to get out of sync with index.html.
 */
(function (SI) {
  'use strict';

  var C = SI.CONFIG;
  var FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

  function font(size, weight) {
    return (weight || 700) + ' ' + size + 'px ' + FONT;
  }

  function drawLifeIcon(ctx, x, y, scale, alpha) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.shadowColor = C.COLORS.playerGlow;
    ctx.shadowBlur = 10;
    ctx.fillStyle = C.COLORS.player;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(9, 0);
    ctx.lineTo(14, 8);
    ctx.lineTo(-14, 8);
    ctx.lineTo(-9, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawBar(ctx, game) {
    var G = SI.FX.glowText;
    var t = game.time;

    G(ctx, 'SCORE', 26, 36, { font: font(14), color: '#6fd9ff', blur: 8, alpha: 0.85 });
    G(ctx, SI.formatScore(game.score), 26, 66, { font: font(30, 800), color: '#eafcff', glow: C.COLORS.hud, blur: 18 });

    G(ctx, 'HI-SCORE', C.WORLD_W / 2, 36, { font: font(14), color: '#ff9ae0', blur: 8, align: 'center', alpha: 0.85 });
    G(ctx, SI.formatScore(game.hi), C.WORLD_W / 2, 66, { font: font(30, 800), color: '#ffd9f6', glow: C.COLORS.accent, blur: 18, align: 'center' });

    G(ctx, 'WAVE ' + game.wave, C.WORLD_W - 26, 36, { font: font(14), color: '#ffd166', blur: 8, align: 'right', alpha: 0.9 });

    for (var i = 0; i < Math.min(game.lives, 6); i++) {
      drawLifeIcon(ctx, C.WORLD_W - 40 - i * 40, 60, 0.9, 0.95);
    }
    if (game.lives > 6) {
      G(ctx, 'x' + game.lives, C.WORLD_W - 26, 96, { font: font(16), color: C.COLORS.hud, align: 'right', blur: 8 });
    }

    if (SI.Audio.isMuted()) {
      G(ctx, 'MUTED (M)', 26, C.WORLD_H - 20, { font: font(14), color: '#ff8ba0', blur: 10, alpha: 0.9 });
    }

    if (game.bannerTime > 0 && game.banner) {
      var a = Math.min(1, game.bannerTime);
      G(ctx, game.banner, C.WORLD_W / 2, 130 - (1 - a) * 20, {
        font: font(26, 800), color: '#ffe9a8', glow: C.COLORS.warn,
        blur: 20, align: 'center', alpha: a
      });
    }

    // Thin animated separator under the HUD bar.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var grad = ctx.createLinearGradient(0, 0, C.WORLD_W, 0);
    var pulse = 0.35 + 0.2 * Math.sin(t * 2.2);
    grad.addColorStop(0, 'rgba(80,220,255,0)');
    grad.addColorStop(0.5, 'rgba(120,240,255,' + pulse.toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(255,120,220,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 86, C.WORLD_W, 2);
    ctx.restore();
  }

  function dim(ctx, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#050411';
    ctx.fillRect(0, 0, C.WORLD_W, C.WORLD_H);
    ctx.restore();
  }

  function drawTitle(ctx, game) {
    var G = SI.FX.glowText;
    var t = game.time;
    dim(ctx, 0.45);

    var bob = Math.sin(t * 1.6) * 6;
    G(ctx, 'NEON', C.WORLD_W / 2, 250 + bob, {
      font: font(96, 900), color: '#eafcff', glow: C.COLORS.playerGlow, blur: 34, align: 'center'
    });
    G(ctx, 'INVADERS', C.WORLD_W / 2, 340 + bob, {
      font: font(76, 900), color: '#ffd0f4', glow: C.COLORS.accent, blur: 34, align: 'center'
    });

    var blink = 0.55 + 0.45 * Math.sin(t * 4);
    G(ctx, 'PRESS  SPACE  /  ENTER  /  TAP  TO  START', C.WORLD_W / 2, 440, {
      font: font(22), color: '#9df3ff', blur: 18, align: 'center', alpha: blink
    });

    var lines = [
      'MOVE   ←  →   or   A  D        FIRE   SPACE  /  Z',
      'PAUSE   P              MUTE   M              RESTART   ENTER',
      'Shoot down incoming fire for bonus points. The saucer pays big.'
    ];
    for (var i = 0; i < lines.length; i++) {
      G(ctx, lines[i], C.WORLD_W / 2, 520 + i * 34, {
        font: font(17, 600), color: '#8fb6d8', blur: 6, align: 'center', alpha: 0.9
      });
    }
    G(ctx, 'HI-SCORE  ' + SI.formatScore(game.hi), C.WORLD_W / 2, 650, {
      font: font(18), color: '#ffd166', blur: 12, align: 'center', alpha: 0.9
    });
  }

  function drawPaused(ctx, game) {
    var G = SI.FX.glowText;
    dim(ctx, 0.55);
    G(ctx, 'PAUSED', C.WORLD_W / 2, C.WORLD_H / 2 - 10, {
      font: font(62, 900), color: '#eafcff', glow: C.COLORS.playerGlow, blur: 30, align: 'center'
    });
    G(ctx, 'PRESS  P  TO  RESUME', C.WORLD_W / 2, C.WORLD_H / 2 + 46, {
      font: font(20), color: '#9df3ff', blur: 14, align: 'center',
      alpha: 0.6 + 0.4 * Math.sin(game.time * 4)
    });
  }

  function drawWaveClear(ctx, game) {
    var G = SI.FX.glowText;
    var k = Math.min(1, game.stateTimer / 0.4);
    G(ctx, 'WAVE  ' + game.wave + '  CLEARED', C.WORLD_W / 2, C.WORLD_H / 2 - 20, {
      font: font(54, 900), color: '#d9fff2', glow: C.COLORS.bunker, blur: 30, align: 'center', alpha: k
    });
    G(ctx, 'GET  READY  FOR  WAVE  ' + (game.wave + 1), C.WORLD_W / 2, C.WORLD_H / 2 + 40, {
      font: font(24, 700), color: '#ffd166', blur: 18, align: 'center', alpha: k
    });
  }

  function drawGameOver(ctx, game) {
    var G = SI.FX.glowText;
    dim(ctx, Math.min(0.6, game.stateTimer * 0.6));
    G(ctx, 'GAME  OVER', C.WORLD_W / 2, C.WORLD_H / 2 - 40, {
      font: font(74, 900), color: '#ffd3e4', glow: '#ff3d7f', blur: 34, align: 'center'
    });
    G(ctx, 'SCORE  ' + SI.formatScore(game.score) + '     WAVE  ' + game.wave,
      C.WORLD_W / 2, C.WORLD_H / 2 + 20, {
        font: font(26, 700), color: '#eafcff', blur: 18, align: 'center'
      });
    if (game.score >= game.hi && game.score > 0) {
      G(ctx, 'NEW  HI-SCORE!', C.WORLD_W / 2, C.WORLD_H / 2 + 66, {
        font: font(22, 800), color: '#ffd166', glow: C.COLORS.warn, blur: 20, align: 'center',
        alpha: 0.6 + 0.4 * Math.sin(game.time * 6)
      });
    }
    if (game.stateTimer > 1.2) {
      G(ctx, 'PRESS  ENTER  /  SPACE  /  TAP  TO  PLAY  AGAIN',
        C.WORLD_W / 2, C.WORLD_H / 2 + 130, {
          font: font(20), color: '#9df3ff', blur: 16, align: 'center',
          alpha: 0.55 + 0.45 * Math.sin(game.time * 4)
        });
    }
  }

  function draw(ctx, game) {
    var S = SI.STATE;
    if (game.state !== S.MENU) {
      drawBar(ctx, game);
    }
    switch (game.state) {
      case S.MENU: drawTitle(ctx, game); break;
      case S.PAUSED: drawPaused(ctx, game); break;
      case S.WAVE_CLEAR: drawWaveClear(ctx, game); break;
      case S.GAME_OVER: drawGameOver(ctx, game); break;
      default: break;
    }
  }

  SI.HUD = { draw: draw };
})(window.SI = window.SI || {});
