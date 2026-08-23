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

  // Cannon upgrade presentation. Keyed by the ids in CONFIG.UPGRADE.IDS.
  var UPGRADES = {
    spread: {
      name: 'SPREAD SHOT',
      blurb: 'Three shots per volley,\nfanned outward.',
      color: '#5ffbf1'
    },
    pierce: {
      name: 'PIERCING LASER',
      blurb: 'Cuts through several\naliens before it dies.',
      color: '#1ce8ff'
    },
    bounce: {
      name: 'BOUNCING SHOT',
      blurb: 'Slower angled shot,\nreflects off the walls.',
      color: '#ffd166'
    },
    shield: {
      name: 'TEMP SHIELD',
      blurb: 'Start the wave briefly\ninvulnerable.',
      color: '#ff56d5'
    }
  };

  var CARD = { W: 196, H: 214, GAP: 18, Y: 296 };

  // Shared by the drawing below and game.js's tap hit-test, so the card a
  // player taps is always the card they can see.
  function upgradeCardRect(i, n) {
    var count = n || C.UPGRADE.IDS.length;
    var total = count * CARD.W + (count - 1) * CARD.GAP;
    var x0 = (C.WORLD_W - total) / 2;
    return { x: x0 + i * (CARD.W + CARD.GAP), y: CARD.Y, w: CARD.W, h: CARD.H };
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

    var active = UPGRADES[game.upgrade];
    if (active) {
      G(ctx, 'CANNON  ' + active.name, C.WORLD_W - 26, C.WORLD_H - 20, {
        font: font(14), color: active.color, blur: 10, align: 'right', alpha: 0.92
      });
    }

    // Which commander personality is choreographing this wave. Centred on
    // the same baseline as MUTED (bottom-left) and CANNON (bottom-right):
    // the longest label, 'COMMANDER  TACTICIAN', is ~150px at 14px bold, so
    // it spans roughly x 405..555 -- clear of both. It disappears the
    // instant the commander dies -- via Swarm.activePersonality(), which is
    // the single accessor that owns the "alive commander or nothing"
    // invariant, rather than re-deriving it here.
    var pers = game.swarm && game.swarm.activePersonality();
    if (pers) {
      G(ctx, 'COMMANDER  ' + pers.name, C.WORLD_W / 2, C.WORLD_H - 20, {
        font: font(14), color: pers.color, blur: 10,
        align: 'center', alpha: 0.92
      });
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

  // Small vector badge per upgrade -- plain rects/paths, no new assets.
  function drawUpgradeIcon(ctx, id, cx, cy, color) {
    var i;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = color;
    if (id === 'spread') {
      var angles = [-0.34, 0, 0.34];
      for (i = 0; i < angles.length; i++) {
        ctx.save();
        ctx.rotate(angles[i]);
        ctx.fillRect(-2.5, -22, 5, 34);
        ctx.restore();
      }
    } else if (id === 'pierce') {
      ctx.fillRect(-3, -24, 6, 48);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(-13, -8, 26, 4);
      ctx.fillRect(-13, 6, 26, 4);
    } else if (id === 'bounce') {
      var pts = [[-16, -22], [14, -6], [-14, 8], [12, 22]];
      for (i = 0; i < pts.length; i++) {
        ctx.fillRect(pts[i][0] - 3, pts[i][1] - 3, 6, 6);
      }
      ctx.globalAlpha = 0.5;
      ctx.fillRect(-20, -24, 3, 48);
      ctx.fillRect(17, -24, 3, 48);
    } else {
      ctx.beginPath();
      ctx.moveTo(0, -24);
      ctx.lineTo(18, -14);
      ctx.lineTo(18, 6);
      ctx.lineTo(0, 24);
      ctx.lineTo(-18, 6);
      ctx.lineTo(-18, -14);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#050411';
      ctx.fillRect(-9, -10, 18, 18);
    }
    ctx.restore();
  }

  function drawUpgradeCard(ctx, game, i, id, selected) {
    var G = SI.FX.glowText;
    var meta = UPGRADES[id];
    // This table is keyed by CONFIG.UPGRADE.IDS. If an id ever gains an entry
    // there without one here, skip its card rather than throwing through the
    // whole HUD draw.
    if (!meta) {
      return;
    }
    var r = upgradeCardRect(i, C.UPGRADE.IDS.length);
    var pulse = selected ? 0.5 + 0.5 * Math.sin(game.time * 6) : 0;

    ctx.save();
    ctx.globalAlpha = selected ? 0.28 + 0.1 * pulse : 0.14;
    ctx.fillStyle = selected ? meta.color : '#0d1030';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha = selected ? 1 : 0.35;
    ctx.fillStyle = meta.color;
    // Frame drawn as four thin rects (no stroke: keeps the look flat/CRT).
    var t = selected ? 3 : 1.5;
    ctx.fillRect(r.x, r.y, r.w, t);
    ctx.fillRect(r.x, r.y + r.h - t, r.w, t);
    ctx.fillRect(r.x, r.y, t, r.h);
    ctx.fillRect(r.x + r.w - t, r.y, t, r.h);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = selected ? 1 : 0.6;
    drawUpgradeIcon(ctx, id, r.x + r.w / 2, r.y + 62, meta.color);
    ctx.restore();

    var cx = r.x + r.w / 2;
    G(ctx, String(i + 1), r.x + 16, r.y + 30, {
      font: font(18, 800), color: meta.color, blur: 10, alpha: selected ? 1 : 0.5
    });
    G(ctx, meta.name, cx, r.y + 126, {
      font: font(17, 800), color: '#eafcff', glow: meta.color, blur: selected ? 18 : 8,
      align: 'center', alpha: selected ? 1 : 0.65
    });
    var lines = meta.blurb.split('\n');
    for (var k = 0; k < lines.length; k++) {
      G(ctx, lines[k], cx, r.y + 158 + k * 22, {
        font: font(14, 600), color: '#9fb8d8', blur: 4, align: 'center',
        alpha: selected ? 0.95 : 0.5
      });
    }
  }

  function drawUpgrade(ctx, game) {
    var G = SI.FX.glowText;
    var ids = C.UPGRADE.IDS;
    dim(ctx, 0.62);

    G(ctx, 'WAVE  ' + game.wave + '  CLEARED', C.WORLD_W / 2, 168, {
      font: font(34, 900), color: '#d9fff2', glow: C.COLORS.bunker, blur: 24, align: 'center'
    });
    G(ctx, 'REFIT  YOUR  CANNON', C.WORLD_W / 2, 224, {
      font: font(46, 900), color: '#eafcff', glow: C.COLORS.playerGlow, blur: 28, align: 'center'
    });
    G(ctx, 'ONE  ONLY  -  IT  REPLACES  YOUR  CURRENT  CANNON', C.WORLD_W / 2, 262, {
      font: font(15, 600), color: '#8fb6d8', blur: 6, align: 'center', alpha: 0.85
    });

    for (var i = 0; i < ids.length; i++) {
      drawUpgradeCard(ctx, game, i, ids[i], i === game.upgradeIndex);
    }

    G(ctx, '←  →  /  A  D  or  1-4  TO  CHOOSE        SPACE  /  ENTER  /  TAP  A  CARD  TO  LOCK  IN',
      C.WORLD_W / 2, 556, {
        font: font(17, 700), color: '#9df3ff', blur: 14, align: 'center',
        alpha: 0.6 + 0.4 * Math.sin(game.time * 4)
      });

    var left = Math.max(0, C.UPGRADE.PICK_TIMEOUT - game.stateTimer);
    G(ctx, 'AUTO-SELECT  IN  ' + (Math.ceil(left * 10) / 10).toFixed(1) + 's',
      C.WORLD_W / 2, 596, {
        font: font(15, 700), color: left < 3 ? '#ff8ba0' : '#ffd166', blur: 12, align: 'center',
        alpha: 0.9
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
    // Strictly beating the record, not merely matching it. `game.hi` moves
    // with the live score, so compare against the record this run started on.
    if (game.score > game.baseHi && game.score > 0) {
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
      case S.UPGRADE: drawUpgrade(ctx, game); break;
      case S.GAME_OVER: drawGameOver(ctx, game); break;
      default: break;
    }
  }

  SI.HUD = { draw: draw, upgradeCardRect: upgradeCardRect };
})(window.SI = window.SI || {});
