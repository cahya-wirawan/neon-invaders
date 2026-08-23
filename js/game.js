/* game.js -- state machine, collisions, scoring and wave progression. */
(function (SI) {
  'use strict';

  var C = SI.CONFIG;

  var STATE = {
    MENU: 'MENU',
    PLAYING: 'PLAYING',
    PAUSED: 'PAUSED',
    WAVE_CLEAR: 'WAVE_CLEAR',
    UPGRADE: 'UPGRADE',
    GAME_OVER: 'GAME_OVER'
  };

  var HI_KEY = 'neon-invaders-hi';

  function loadHi() {
    try {
      var v = window.localStorage.getItem(HI_KEY);
      // Corrupt storage must not poison the feature: a value like
      // "1e999" parses to Infinity, which no score could ever beat.
      var n = Math.floor(Number(v));
      return (isFinite(n) && n >= 0) ? Math.min(n, 9999999) : 0;
    } catch (e) {
      return 0;
    }
  }

  function saveHi(v) {
    try {
      window.localStorage.setItem(HI_KEY, String(v));
    } catch (e) {
      /* private mode / disabled storage -- score just won't persist */
    }
  }

  function Game() {
    var self = this;

    this.particles = new SI.Particles(SI.PARTICLE_CAP);
    this.player = new SI.Player();
    this.bullets = [];
    this.bunkers = [];
    this.swarm = null;
    this.ufo = null;

    this.state = STATE.MENU;
    this.stateTimer = 0;
    this.score = 0;
    // Kill-streak state: consecutive kills and the seconds left in the window
    // before the streak lapses. See CONFIG.COMBO / scoreKill().
    this.combo = 0;
    this.comboTimer = 0;
    this.hi = loadHi();
    // The hi-score as it stood when this run began: `hi` tracks the live
    // score during play, so beating the record needs a stable reference.
    this.baseHi = this.hi;
    // What is actually in localStorage right now. flushHi() writes only
    // when `hi` has moved past it, so persistence costs one setItem per
    // improvement instead of one per scoring event.
    this.savedHi = this.hi;
    this.lives = C.PLAYER.START_LIVES;
    this.wave = 1;
    this.nextExtraLife = 5000;
    this.ufoTimer = SI.rand(C.UFO.MIN_DELAY, C.UFO.MAX_DELAY);
    this.warpBoost = 0;
    this.flash = 0;
    this.banner = '';
    this.bannerTime = 0;
    this.time = 0;
    this.invaded = false;
    // Active cannon upgrade -- exactly one, chosen between waves. A new
    // pick REPLACES this, upgrades never stack.
    this.upgrade = 'none';
    this.upgradeIndex = 0;
    // The UPGRADE screen only accepts a confirm once the binding has been
    // seen RELEASED while the screen is up -- see setState/confirmHeld.
    this.upgradeArmed = false;
    // Which state PAUSED must return to, and the pick clock frozen across it.
    this.pausedFrom = null;
    this.pausedTimer = 0;

    // Context handed to every entity update -- avoids entities importing
    // the game module (which would be a dependency cycle).
    this.world = {
      dt: 0,
      particles: this.particles,
      audio: SI.Audio,
      moveAxis: 0,
      wantFire: false,
      pointer: null,
      livesLeft: this.lives,
      spawnBullet: function (b) { self.bullets.push(b); },
      shake: function (power, dur) { SI.FX.addShake(power, dur); },
      alienBulletCount: function () { return self.countBullets('alien'); },
      onDescend: function () { self.warpBoost = Math.max(self.warpBoost, 0.12); },
      onInvasion: function () { self.invaded = true; }
    };
  }

  Game.prototype.countBullets = function (from) {
    var n = 0;
    for (var i = 0; i < this.bullets.length; i++) {
      if (!this.bullets[i].dead && this.bullets[i].from === from) { n++; }
    }
    return n;
  };

  /* ----------------------------- lifecycle -------------------------- */

  Game.prototype.startGame = function () {
    this.score = 0;
    this.baseHi = this.hi;
    this.lives = C.PLAYER.START_LIVES;
    this.wave = 1;
    this.nextExtraLife = 5000;
    this.upgrade = 'none';
    this.upgradeIndex = 0;
    this.particles.clear();
    this.startWave(1);
    this.setState(STATE.PLAYING);
    SI.Audio.startMusic(this.wave);
  };

  Game.prototype.startWave = function (wave) {
    this.wave = wave;
    this.resetCombo();
    this.swarm = new SI.Swarm(wave);
    this.bullets.length = 0;
    this.invaded = false;
    this.player.reset(true);
    this.buildBunkers();
    SI.Audio.ufoStop();
    this.ufo = null;
    this.ufoTimer = SI.rand(C.UFO.MIN_DELAY, C.UFO.MAX_DELAY) * (wave > 3 ? 0.75 : 1);
    SI.Audio.setMusicWave(wave);
  };

  Game.prototype.buildBunkers = function () {
    this.bunkers.length = 0;
    var n = C.BUNKER.COUNT;
    for (var i = 0; i < n; i++) {
      var x = C.WORLD_W * (i + 0.5) / n;
      this.bunkers.push(new SI.Bunker(x, C.BUNKER.Y));
    }
  };

  // True while ANY confirm binding is physically down. confirmPressed() is an
  // edge, so it cannot answer this on its own; isDown/pointer can.
  Game.prototype.confirmHeld = function () {
    var Input = SI.Input;
    var p = Input.pointer();
    return !!(Input.isDown('Space') || Input.isDown('KeyZ') ||
              Input.isDown('Enter') || (p && (p.firing || p.active)));
  };

  Game.prototype.setState = function (s) {
    this.state = s;
    this.stateTimer = 0;
    if (s === STATE.UPGRADE) {
      // A confirm binding that is ALREADY down when the screen opens (the
      // fire key held through WAVE_CLEAR, a finger resting on the glass) must
      // never lock a card in: it has to be released at least once first.
      this.upgradeArmed = !this.confirmHeld();
    }
  };

  // PAUSED remembers where it came from, and freezes that state's clock.
  // STATE.UPGRADE needs both: its stateTimer IS the auto-select countdown.
  Game.prototype.pause = function (from) {
    this.pausedFrom = from;
    this.pausedTimer = this.stateTimer;
    this.setState(STATE.PAUSED);
    SI.Audio.stopMusic();
    SI.Audio.ufoStop();
  };

  Game.prototype.resume = function () {
    var back = this.pausedFrom || STATE.PLAYING;
    var timer = this.pausedTimer;
    this.pausedFrom = null;
    this.setState(back);
    if (back === STATE.UPGRADE) {
      // Give back exactly the countdown that was on screen, and make the
      // player release the key that resumed before it can also pick a card.
      this.stateTimer = timer;
      this.upgradeArmed = false;
      return;
    }
    SI.Audio.startMusic(this.wave);
    // pause silenced the saucer; bring it back if it is still flying.
    if (this.ufo && !this.ufo.dead) {
      SI.Audio.ufoStart();
    }
  };

  /* ------------------------------ update ---------------------------- */

  Game.prototype.update = function (dt) {
    var Input = SI.Input;
    this.time += dt;
    this.stateTimer += dt;
    this.flash = Math.max(0, this.flash - dt * 2.4);
    this.bannerTime = Math.max(0, this.bannerTime - dt);
    this.warpBoost = Math.max(0, this.warpBoost - dt * 0.6);

    if (Input.mutePressed()) {
      SI.Audio.toggleMute();
    }

    switch (this.state) {
      case STATE.MENU:
        this.particles.update(dt);
        if (Input.confirmPressed()) {
          this.startGame();
        }
        break;

      case STATE.PLAYING:
        if (Input.pausePressed()) {
          this.pause(STATE.PLAYING);
          break;
        }
        this.updatePlaying(dt);
        break;

      case STATE.PAUSED:
        if (Input.pausePressed() || Input.confirmPressed()) {
          this.resume();
        }
        break;

      case STATE.WAVE_CLEAR:
        this.particles.update(dt);
        this.player.update(dt, this.syncWorld(dt, false));
        if (this.stateTimer > 2.4) {
          // The wave no longer starts here: the player picks a cannon
          // first, and applyUpgrade() is what calls startWave().
          this.upgradeIndex = 0;
          this.setState(STATE.UPGRADE);
        }
        break;

      case STATE.UPGRADE:
        // The pick window is pausable too: PICK_TIMEOUT is a real clock and a
        // player who has to step away would otherwise be handed whatever card
        // happened to be highlighted.
        if (Input.pausePressed()) {
          this.pause(STATE.UPGRADE);
          break;
        }
        this.particles.update(dt);
        this.player.update(dt, this.syncWorld(dt, false));
        this.updateUpgradePick(dt);
        break;

      case STATE.GAME_OVER:
        this.particles.update(dt);
        this.flushHi();
        if (this.stateTimer > 1.2 && Input.confirmPressed()) {
          this.startGame();
        }
        break;
    }
  };

  Game.prototype.syncWorld = function (dt, live) {
    var w = this.world;
    var Input = SI.Input;
    w.dt = dt;
    w.livesLeft = this.lives;
    w.moveAxis = live ? Input.moveAxis() : 0;
    // firePressed() catches taps that begin and end inside a single frame
    // (touch, or keyboard faster than the refresh rate).
    w.wantFire = live ? (Input.firing() || Input.firePressed()) : false;
    w.pointer = live ? Input.pointer() : null;
    // Entities never reach into game.js: the active upgrade and the ship's
    // x (which a diving column aims at) travel through `world` like
    // everything else.
    w.upgrade = this.upgrade;
    w.playerX = this.player.x;
    return w;
  };

  /* -------------------------- cannon upgrade ------------------------ */

  // Hit-test for tapping a card. Geometry lives in hud.js so the drawing
  // and the hit box can never drift apart.
  Game.prototype.upgradeCardAt = function (x, y) {
    var ids = C.UPGRADE.IDS;
    if (!SI.HUD || typeof SI.HUD.upgradeCardRect !== 'function') {
      return -1;
    }
    for (var i = 0; i < ids.length; i++) {
      var r = SI.HUD.upgradeCardRect(i, ids.length);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        return i;
      }
    }
    return -1;
  };

  Game.prototype.updateUpgradePick = function (dt) {
    var Input = SI.Input;
    var U = C.UPGRADE;
    var n = U.IDS.length;
    var i;

    if (Input.justPressed('ArrowLeft') || Input.justPressed('KeyA')) {
      this.upgradeIndex = (this.upgradeIndex + n - 1) % n;
    }
    if (Input.justPressed('ArrowRight') || Input.justPressed('KeyD')) {
      this.upgradeIndex = (this.upgradeIndex + 1) % n;
    }
    for (i = 0; i < n; i++) {
      if (Input.justPressed('Digit' + (i + 1))) {
        this.upgradeIndex = i;
      }
    }

    // Touch: ONLY a genuine pointer-down edge moves the highlight, and only
    // when it lands on a card. Reading a held/resting pointer every frame
    // would silently overwrite the arrow keys on any device with a
    // touchscreen, and would make an idle finger "choose" a card.
    var p = Input.pointer();
    var tapEdge = Input.justPressed('Pointer');
    var tappedCard = -1;
    if (tapEdge && p) {
      tappedCard = this.upgradeCardAt(p.x, p.y);
      if (tappedCard >= 0) {
        this.upgradeIndex = tappedCard;
      }
    }

    // Gate 1: the confirm binding must have been RELEASED at least once since
    // the screen opened. Fire and confirm share Space/Z/tap, so without this
    // the key still held down from WAVE_CLEAR locks in card 0 instantly.
    if (!this.upgradeArmed && !this.confirmHeld()) {
      this.upgradeArmed = true;
    }

    var keyEdge = Input.justPressed('Enter') || Input.justPressed('Space') ||
                  Input.justPressed('KeyZ');
    var edge = Input.confirmPressed();
    // A tap that missed every card is not a choice -- only a key edge or a
    // tap ON a card may confirm.
    if (edge && !keyEdge && tapEdge && tappedCard < 0) {
      edge = false;
    }

    // Gate 2: a minimum dwell, which is what stops a player mashing fire
    // through the screen (they release constantly, so gate 1 alone lets them
    // straight through) from picking before the cards can be read.
    var confirmed = this.upgradeArmed && this.stateTimer >= U.MIN_DWELL && edge;
    if (confirmed || this.stateTimer >= U.PICK_TIMEOUT) {
      this.applyUpgrade(U.IDS[this.upgradeIndex]);
    }
  };

  Game.prototype.applyUpgrade = function (id) {
    var ids = C.UPGRADE.IDS;
    // Defence in depth: an id that is not in IDS has no Player.fire branch and
    // no HUD entry, so fall back to the first real one rather than shipping
    // the player a cannon that does nothing.
    this.upgrade = ids.indexOf(id) >= 0 ? id : ids[0];
    this.startWave(this.wave + 1);
    // MUST come after startWave(): it calls player.reset(true), which
    // unconditionally overwrites invuln with PLAYER.INVULN_TIME.
    if (this.upgrade === 'shield') {
      this.player.invuln = C.UPGRADE.SHIELD_TIME;
    }
    this.setState(STATE.PLAYING);
    SI.Audio.extraLife();
    SI.Audio.startMusic(this.wave);
  };

  Game.prototype.updatePlaying = function (dt) {
    var world = this.syncWorld(dt, true);
    var i;

    // Decay the kill-streak window BEFORE collide(): a kill later in this same
    // frame must re-arm the window, not be expired by this frame's decay.
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) { this.resetCombo(); }
    }

    this.player.update(dt, world);
    if (this.swarm) {
      this.swarm.update(dt, world);
    }

    for (i = 0; i < this.bullets.length; i++) {
      this.bullets[i].update(dt, world);
    }

    this.updateUfo(dt, world);
    this.particles.update(dt);
    this.collide(world);
    SI.compact(this.bullets);

    if (this.invaded) {
      this.invaded = false;
      this.loseLife(world, true);
    }

    if (this.swarm && this.swarm.aliveCount() === 0 && this.state === STATE.PLAYING) {
      this.clearWave();
    }
  };

  Game.prototype.updateUfo = function (dt, world) {
    if (this.ufo) {
      this.ufo.update(dt, world);
      if (this.ufo.dead) {
        SI.Audio.ufoStop();
        this.ufo = null;
        this.ufoTimer = SI.rand(C.UFO.MIN_DELAY, C.UFO.MAX_DELAY);
      }
      return;
    }
    this.ufoTimer -= dt;
    if (this.ufoTimer <= 0 && this.swarm && this.swarm.aliveCount() > 2) {
      this.ufo = new SI.Ufo(SI.chance(0.5) ? 1 : -1, this.wave);
      SI.Audio.ufoStart();
    }
  };

  /* ---------------------------- collisions -------------------------- */

  Game.prototype.collide = function (world) {
    var i, j, b, box;

    for (i = 0; i < this.bullets.length; i++) {
      b = this.bullets[i];
      if (b.dead) { continue; }
      box = b.box();

      if (b.from === 'player') {
        // Player shot vs aliens.
        var hitAlien = false;
        if (this.swarm) {
          var aliens = this.swarm.aliens;
          for (j = 0; j < aliens.length; j++) {
            var a = aliens[j];
            if (!a.alive) { continue; }
            if (SI.aabb(box, a.box())) {
              this.swarm.killAlien(a, world);
              this.scoreKill(a.score);
              // PIERCING LASER: survives the kill and flies on. One alien
              // per bullet per frame either way -- at MAX_DT a shot covers
              // far less than a grid row, so nothing is skipped.
              if (b.pierce > 0) {
                b.pierce--;
              } else {
                b.dead = true;
              }
              hitAlien = true;
              break;
            }
          }
        }
        if (hitAlien) { continue; }

        // Player shot vs UFO.
        if (this.ufo && SI.aabb(box, this.ufo.box())) {
          var pts = this.ufo.kill(world);
          // Banner shows what was ACTUALLY awarded, multiplier included.
          var gain = this.scoreKill(pts);
          this.banner = '+' + gain;
          this.bannerTime = 1.2;
          this.ufo = null;
          this.ufoTimer = SI.rand(C.UFO.MIN_DELAY, C.UFO.MAX_DELAY);
          b.dead = true;
          continue;
        }

        // Player shot vs incoming alien shots -- shooting them down feels great.
        for (j = 0; j < this.bullets.length; j++) {
          var ob = this.bullets[j];
          if (ob.dead || ob.from !== 'alien') { continue; }
          if (SI.aabb(box, ob.box())) {
            ob.dead = true;
            b.dead = true;
            this.particles.emitSparks(b.x, b.y, '#ffffff', 10, 0, -1, Math.PI);
            this.addScore(5);
            break;
          }
        }
        if (b.dead) { continue; }
      } else {
        // Alien shot vs player.
        if (this.player.alive && this.player.invuln <= 0 &&
            SI.aabb(box, this.player.box())) {
          b.dead = true;
          this.loseLife(world, false);
          continue;
        }
      }

      // Both bullet kinds chew through bunkers. Deliberately unchanged for
      // a piercing shot: the laser cuts through ALIENS, not through your
      // own cover, so camping behind a bunker still costs you the shot.
      for (j = 0; j < this.bunkers.length; j++) {
        var bunker = this.bunkers[j];
        // Pass travel direction so the scan starts at the row the shot
        // actually reaches first (its swept box can span several rows).
        var hit = bunker.hitTest(box, b.vy);
        if (hit) {
          bunker.damage(hit.x, hit.y, C.BUNKER.CELL * (b.from === 'player' ? 1.5 : 1.9));
          this.particles.emitSparks(hit.x, hit.y, C.COLORS.bunker, 8, 0, b.from === 'player' ? -1 : 1, 1.1);
          SI.Audio.bunkerHit();
          b.dead = true;
          break;
        }
      }
    }

    // The formation grinds bunkers away as it descends.
    if (this.swarm) {
      var swarmAliens = this.swarm.aliens;
      for (i = 0; i < swarmAliens.length; i++) {
        var al = swarmAliens[i];
        if (!al.alive || al.y + al.h / 2 < C.BUNKER.Y - 4) { continue; }
        for (j = 0; j < this.bunkers.length; j++) {
          if (this.bunkers[j].crushBelow(al.box())) {
            this.particles.emitSparks(al.x, al.y + al.h / 2, C.COLORS.bunker, 4, 0, 1, 1.2);
          }
        }
      }
      // No alien-vs-player contact test: the swarm always trips the
      // invasion floor (SWARM.FLOOR_Y) well before it can overlap the
      // ship, and invasion already ends the run.
    }
  };

  /* ------------------------- score / life flow ---------------------- */

  Game.prototype.resetCombo = function () {
    this.combo = 0;
    this.comboTimer = 0;
  };

  Game.prototype.comboMult = function () {
    if (this.wave < C.COMBO.FROM_WAVE) { return 1; }
    return Math.min(C.COMBO.MAX, 1 + Math.floor(this.combo / C.COMBO.STEP));
  };

  // The ONE scoring path a kill goes through. Returns what was actually
  // awarded, so the UFO banner can never disagree with the score.
  Game.prototype.scoreKill = function (points) {
    // Wave 1 is classic scoring, and so is anything that resolves after the
    // run has already ended. The second case is not hypothetical: collide()
    // keeps walking the SAME bullets array after the fatal alien shot is
    // resolved, so player shots at a higher index still land -- and still
    // score -- in the very frame that called gameOver(). Those points stand
    // (flushHi() already exists because of them), but they must not rebuild a
    // streak: updatePlaying() is the only place comboTimer decays, so a streak
    // re-armed here would freeze at a non-zero value forever and the HUD would
    // paint a stale COMBO readout over the death screen for good.
    if (this.wave < C.COMBO.FROM_WAVE || this.state === STATE.GAME_OVER) {
      this.addScore(points);
      return points;
    }
    this.combo++;
    this.comboTimer = C.COMBO.WINDOW;
    var gain = points * this.comboMult();
    this.addScore(gain);
    return gain;
  };

  Game.prototype.addScore = function (points) {
    this.score += points;
    // Track the live hi-score for the HUD, but do not touch localStorage
    // here: setItem is synchronous and this runs many times per second.
    // gameOver() is what persists it.
    if (this.score > this.hi) {
      this.hi = this.score;
    }
    if (this.score >= this.nextExtraLife) {
      this.nextExtraLife += 5000;
      this.lives++;
      SI.Audio.extraLife();
      this.flash = Math.max(this.flash, 0.5);
    }
  };

  Game.prototype.loseLife = function (world, invasion) {
    // Taking a hit drops the streak outright -- first thing, so it happens
    // even on the path that ends in gameOver().
    this.resetCombo();
    // An invasion ends the run outright -- no point decrementing first.
    this.lives = invasion ? 0 : this.lives - 1;
    this.world.livesLeft = this.lives;
    this.player.kill(world);
    this.flash = 1;
    SI.FX.addShake(invasion ? 30 : 20, 0.55);
    if (this.lives <= 0) {
      this.lives = 0;
      this.gameOver();
    }
  };

  Game.prototype.gameOver = function () {
    this.setState(STATE.GAME_OVER);
    // The run is over, so the streak is over. loseLife() cleared it a moment
    // ago, but clearing it HERE is what pins the invariant to the end of the
    // run rather than to one caller, and it deliberately sits AFTER setState()
    // -- that is what arms scoreKill()'s GAME_OVER guard for the rest of this
    // same collision pass, so the shots still in flight cannot rebuild the
    // streak behind it. Together the two are what keep a stale COMBO readout
    // off the death screen.
    this.resetCombo();
    SI.Audio.stopMusic();
    SI.Audio.ufoStop();
    SI.Audio.gameOver();
    this.flushHi();
  };

  // Idempotent: writes at most once per hi-score improvement. update()
  // calls it again on the GAME_OVER screen because points can still be
  // awarded after gameOver() inside the same collision pass.
  Game.prototype.flushHi = function () {
    if (this.score > this.hi) {
      this.hi = this.score;
    }
    if (this.hi > this.savedHi) {
      this.savedHi = this.hi;
      saveHi(this.hi);
    }
  };

  Game.prototype.clearWave = function () {
    // The readout must not linger into WAVE_CLEAR / UPGRADE.
    this.resetCombo();
    this.setState(STATE.WAVE_CLEAR);
    this.warpBoost = 1;
    this.bullets.length = 0;
    SI.Audio.ufoStop();
    this.ufo = null;
    SI.Audio.stopMusic();
    SI.Audio.waveClear();
    this.particles.emitExplosion(C.WORLD_W / 2, C.WORLD_H / 2, C.COLORS.accent, 40, 1.2);
  };

  /* ------------------------------- draw ----------------------------- */

  Game.prototype.draw = function (ctx) {
    var i;
    for (i = 0; i < this.bunkers.length; i++) {
      this.bunkers[i].draw(ctx);
    }
    if (this.swarm && this.state !== STATE.MENU) {
      this.swarm.draw(ctx);
    }
    if (this.ufo) {
      this.ufo.draw(ctx);
    }
    if (this.state !== STATE.MENU) {
      this.player.draw(ctx);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < this.bullets.length; i++) {
      if (!this.bullets[i].dead) {
        this.bullets[i].draw(ctx);
      }
    }
    ctx.restore();

    if (this.flash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.5, this.flash * 0.35);
      ctx.fillStyle = '#ff4d7d';
      ctx.fillRect(0, 0, C.WORLD_W, C.WORLD_H);
      ctx.restore();
    }
  };

  Game.prototype.drawHud = function (ctx) {
    SI.HUD.draw(ctx, this);
  };

  // Called when the tab is hidden: freeze play and silence the mix so
  // the music scheduler never runs against a throttled timer.
  Game.prototype.blurPause = function () {
    // The tab may never come back -- don't lose a record run.
    this.flushHi();
    // STATE.UPGRADE freezes here too: its stateTimer is the auto-select
    // countdown, and a hidden tab must not spend it.
    if (this.state === STATE.PLAYING || this.state === STATE.UPGRADE) {
      this.pause(this.state);
    }
    SI.Input.reset();
  };

  Game.prototype.starfieldBoost = function () {
    return this.warpBoost;
  };

  Game.STATE = STATE;
  SI.Game = Game;
  SI.STATE = STATE;
})(window.SI = window.SI || {});
