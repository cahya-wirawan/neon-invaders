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

  // Cannon upgrade presentation. Keyed by the ids in CONFIG.UPGRADE.IDS, plus
  // CONFIG.UPGRADE.COMBINED_ID -- the one shipped weapon combination, which is
  // offered by SUBSTITUTING the complementary card (see Game.upgradeChoices)
  // rather than by adding a fifth one, because five cards do not fit the world
  // width (see the CARD table below).
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
    },
    // Literal, like the four above -- kept in sync with CONFIG.COLORS
    // .pierceBounce, which is what Player.fire() paints the combined shot
    // with. check-game.js scenario 30 pins the two together.
    pierce_bounce: {
      name: 'PIERCE + BOUNCE',
      blurb: 'Pierces aliens AND\nricochets off walls.',
      color: '#b6ff4d'
    },
    spread_bounce: {
      name: 'PRISM SCATTER',
      blurb: '3-way spread volley,\nall shots ricochet.',
      color: '#ffaa40'
    },
    spread_shield: {
      name: 'AEGIS SCATTER',
      blurb: '3-way energy cone,\ndestroys alien bullets.',
      color: '#38ef7d'
    }
  };

  // FOUR cards is a hard layout constraint, not a preference:
  //   4 * 196 + 3 * 18 =  838 <= WORLD_W (960)
  //   5 * 196 + 4 * 18 = 1052 >  WORLD_W (960)
  // which is exactly why the weapon combination is offered by substitution.
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

    // Kill-streak readout. Sits on the SCORE baseline, just right of the
    // digits: a 7-digit score is ~130px at 30px/800, i.e. it ends around
    // x 156, and the centred HI-SCORE block starts around x 415 -- so x 176 is
    // clear of both. Seven digits is the practical bound, not an enforced one:
    // formatScore() does NOT clamp (the 9999999 cap lives in game.js's
    // loadHi(), and only guards values read back from localStorage), so an
    // 8-digit live score would run under this label. Nothing near 10,000,000
    // is reachable -- the anti-cheat ceiling in server/src/anticheat.js puts
    // the game's peak sustained rate in the hundreds of points per second, so
    // that is hours of flawless play -- which is why this stays a layout note
    // rather than a clamp. Drawn only while the
    // multiplier is actually above x1, which is also why wave 1 (COMBO
    // .FROM_WAVE) never draws it at all. The alpha fades with the remaining
    // streak window, which is the whole tell that it is about to lapse.
    var mult = game.comboMult();
    if (mult > 1) {
      var left = SI.clamp(game.comboTimer / C.COMBO.WINDOW, 0, 1);
      G(ctx, 'COMBO  x' + mult, 176, 66, {
        font: font(16, 800), color: C.COLORS.bunker, glow: C.COLORS.bunker,
        blur: 14, alpha: 0.45 + 0.55 * left
      });
    }

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

    // OWN properties only -- see the same idiom in game.js's upgradeChoices()
    // and entities.js's byCol walk. game.upgrade is a plain string key, so a
    // bare UPGRADES[game.upgrade] would answer for inherited Object.prototype
    // members with a truthy non-entry and this draw would then read .name and
    // .color off it. The `if (active)` below would not catch that.
    var active = Object.prototype.hasOwnProperty.call(UPGRADES, game.upgrade)
      ? UPGRADES[game.upgrade] : null;
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

    // Boss Health Bar. Centred just below the separator bar during milestone boss encounters.
    if (game.boss && game.boss.alive) {
      var boss = game.boss;
      var bx = C.WORLD_W / 2;
      var by = 96;
      var barW = 320;
      var barH = 8;
      var ratio = SI.clamp(boss.hp / boss.maxHp, 0, 1);
      var bossColor = boss.phase === 3 ? '#ff007f' : (boss.phase === 2 ? '#ff2d55' : boss.color);
      var phaseLabel = boss.phase === 3 ? '  [OVERLOAD]' : (boss.phase === 2 ? '  [ENRAGED]' : '  [PHASE 1]');

      G(ctx, boss.name + phaseLabel, bx, by - 4, {
        font: font(11, 800), color: bossColor, align: 'center', blur: 8
      });

      ctx.save();
      ctx.fillStyle = '#0f0a1c';
      ctx.strokeStyle = bossColor;
      ctx.lineWidth = 1.5;
      ctx.fillRect(bx - barW / 2, by, barW, barH);
      ctx.strokeRect(bx - barW / 2, by, barW, barH);

      if (ratio > 0) {
        var fillW = Math.max(2, (barW - 4) * ratio);
        ctx.fillStyle = boss.phase === 3 ? '#ff007f' : (boss.phase === 2 ? '#ff2d55' : (ratio > 0.4 ? '#54ffa8' : '#ffd166'));
        ctx.fillRect(bx - barW / 2 + 2, by + 2, fillW, barH - 4);
      }
      ctx.restore();
    }

    // Secondary EMP super ability meter (bottom-left overlay).
    if (game.state === SI.STATE.PLAYING) {
      var empRatio = SI.clamp(game.emp / C.EMP.MAX, 0, 1);
      var empReady = empRatio >= 1;
      var empColor = empReady ? C.EMP.COLOR_READY : C.EMP.COLOR;
      var empLabel = empReady ? 'EMP READY  [X / LT]' : 'EMP ' + Math.floor(empRatio * 100) + '%';
      G(ctx, empLabel, 26, C.WORLD_H - 45, {
        font: font(11, 800), color: empColor, blur: empReady ? 10 : 5, alpha: 0.92
      });
      ctx.save();
      ctx.fillStyle = '#0f0a1c';
      ctx.strokeStyle = empColor;
      ctx.lineWidth = 1;
      ctx.fillRect(26, C.WORLD_H - 38, 100, 5);
      ctx.strokeRect(26, C.WORLD_H - 38, 100, 5);
      if (empRatio > 0) {
        ctx.fillStyle = empColor;
        ctx.fillRect(27, C.WORLD_H - 37, Math.max(2, 98 * empRatio), 3);
      }
      ctx.restore();
    }

    // Toast notification for unlockable achievements.
    if (game.toastTimer > 0 && game.toast) {
      var ta = Math.min(1, game.toastTimer);
      G(ctx, game.toast, C.WORLD_W / 2, 160 - (1 - ta) * 15, {
        font: font(17, 800), color: '#ffd166', glow: '#ff2d55',
        blur: 16, align: 'center', alpha: ta
      });
    }
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
      'MOVE: ← → / A D / GAMEPAD STICK      FIRE: SPACE / Z / BTN A',
      'EMP BOMB: X / SHIFT / BTN B          PAUSE: P / START',
      'Defeat boss flagships at Wave 7, 14 & 21. Discover weapon fusions.'
    ];
    for (var i = 0; i < lines.length; i++) {
      G(ctx, lines[i], C.WORLD_W / 2, 520 + i * 34, {
        font: font(16, 600), color: '#8fb6d8', blur: 6, align: 'center', alpha: 0.9
      });
    }

    var achCount = SI.Achievements ? SI.Achievements.count() : 0;
    G(ctx, 'ACHIEVEMENTS: ' + achCount + ' / 10 UNLOCKED', C.WORLD_W / 2, 640, {
      font: font(14, 700), color: '#00f5d4', blur: 8, align: 'center', alpha: 0.9
    });

    G(ctx, 'HI-SCORE  ' + SI.formatScore(game.hi), C.WORLD_W / 2, 672, {
      font: font(17, 700), color: '#ffd166', blur: 12, align: 'center', alpha: 0.9
    });

    // Bottom-LEFT version tag
    G(ctx, 'v' + C.VERSION, 16, C.WORLD_H - 14, {
      font: font(13, 600), color: '#8fb6d8', blur: 6, align: 'left', alpha: 0.85
    });

    var crtName = SI.FX && SI.FX.getCRTModeName ? SI.FX.getCRTModeName() : 'OFF';
    G(ctx, 'CRT MODE [C]: ' + crtName, C.WORLD_W / 2, C.WORLD_H - 14, {
      font: font(12, 600), color: '#5ffbf1', blur: 6, align: 'center', alpha: 0.85
    });
  }

  function drawPaused(ctx, game) {
    var G = SI.FX.glowText;
    var crtName = SI.FX && SI.FX.getCRTModeName ? SI.FX.getCRTModeName() : 'OFF';
    dim(ctx, 0.55);
    G(ctx, 'PAUSED', C.WORLD_W / 2, C.WORLD_H / 2 - 18, {
      font: font(62, 900), color: '#eafcff', glow: C.COLORS.playerGlow, blur: 30, align: 'center'
    });
    G(ctx, 'PRESS  P  TO  RESUME      CRT MODE [C]: ' + crtName, C.WORLD_W / 2, C.WORLD_H / 2 + 42, {
      font: font(18), color: '#9df3ff', blur: 14, align: 'center',
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
    } else if (id === C.UPGRADE.COMBINED_ID) {
      // Both halves in one glyph, built only from the primitives the two
      // source icons already use: the BOUNCE icon's pair of wall posts, and
      // the PIERCE icon's long shaft plus its two cross-bar markers -- the
      // shaft tilted so it reads as a ricochet rather than a straight lance.
      ctx.save();
      ctx.rotate(-0.42);
      ctx.fillRect(-3, -24, 6, 48);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(-12, -9, 24, 4);
      ctx.fillRect(-12, 5, 24, 4);
      ctx.restore();
      ctx.globalAlpha = 0.5;
      ctx.fillRect(-20, -24, 3, 48);
      ctx.fillRect(17, -24, 3, 48);
    } else if (id === 'spread_bounce') {
      // 3 angled bars with wall posts on the flanks
      var sbAngles = [-0.34, 0, 0.34];
      for (i = 0; i < sbAngles.length; i++) {
        ctx.save();
        ctx.rotate(sbAngles[i]);
        ctx.fillRect(-2.5, -20, 5, 30);
        ctx.restore();
      }
      ctx.globalAlpha = 0.5;
      ctx.fillRect(-20, -24, 3, 48);
      ctx.fillRect(17, -24, 3, 48);
    } else if (id === 'spread_shield') {
      // 3 spread lines plus an aegis shield chevron
      var ssAngles = [-0.32, 0, 0.32];
      for (i = 0; i < ssAngles.length; i++) {
        ctx.save();
        ctx.rotate(ssAngles[i]);
        ctx.fillRect(-2, -22, 4, 26);
        ctx.restore();
      }
      ctx.beginPath();
      ctx.moveTo(0, 4);
      ctx.lineTo(16, 12);
      ctx.lineTo(0, 24);
      ctx.lineTo(-16, 12);
      ctx.closePath();
      ctx.globalAlpha = 0.65;
      ctx.fill();
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

  // `count` is the length of the list the CALLER is drawing, so the rect a
  // card is drawn in can never drift from the rect game.upgradeCardAt()
  // hit-tests (which passes its own list's length).
  function drawUpgradeCard(ctx, game, i, id, selected, count) {
    var G = SI.FX.glowText;
    // This table is keyed by CONFIG.UPGRADE.IDS + COMBINED_ID. If an id ever
    // gains an entry there without one here, skip its card rather than
    // throwing through the whole HUD draw. OWN properties only, for the same
    // reason as the CANNON readout above: an inherited Object.prototype key
    // would sail past the `if (!meta)` guard as a truthy non-entry.
    var meta = Object.prototype.hasOwnProperty.call(UPGRADES, id)
      ? UPGRADES[id] : null;
    if (!meta) {
      return;
    }
    var r = upgradeCardRect(i, count || C.UPGRADE.IDS.length);
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
    // Ask the game which cards THIS screen offers: normally CONFIG.UPGRADE
    // .IDS, but with the complementary card swapped for the combine card when
    // the active cannon is one half of it. Always the same length.
    var ids = game.upgradeChoices ? game.upgradeChoices() : C.UPGRADE.IDS;
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
      drawUpgradeCard(ctx, game, i, ids[i], i === game.upgradeIndex, ids.length);
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
