/* game.js -- state machine, collisions, scoring and wave progression. */
(function (SI) {
  'use strict';

  var C = SI.CONFIG;

  var STATE = {
    MENU: 'MENU',
    PLAYING: 'PLAYING',
    PAUSED: 'PAUSED',
    WAVE_CLEAR: 'WAVE_CLEAR',
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
    this.particles.clear();
    this.startWave(1);
    this.setState(STATE.PLAYING);
    SI.Audio.startMusic(this.wave);
  };

  Game.prototype.startWave = function (wave) {
    this.wave = wave;
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

  Game.prototype.setState = function (s) {
    this.state = s;
    this.stateTimer = 0;
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
          this.setState(STATE.PAUSED);
          SI.Audio.stopMusic();
          SI.Audio.ufoStop();
          break;
        }
        this.updatePlaying(dt);
        break;

      case STATE.PAUSED:
        if (Input.pausePressed() || Input.confirmPressed()) {
          this.setState(STATE.PLAYING);
          SI.Audio.startMusic(this.wave);
          // pause silenced the saucer; bring it back if it is still flying.
          if (this.ufo && !this.ufo.dead) {
            SI.Audio.ufoStart();
          }
        }
        break;

      case STATE.WAVE_CLEAR:
        this.particles.update(dt);
        this.player.update(dt, this.syncWorld(dt, false));
        if (this.stateTimer > 2.4) {
          this.startWave(this.wave + 1);
          this.setState(STATE.PLAYING);
          SI.Audio.startMusic(this.wave);
        }
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
    return w;
  };

  Game.prototype.updatePlaying = function (dt) {
    var world = this.syncWorld(dt, true);
    var i;

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
              this.addScore(a.score);
              b.dead = true;
              hitAlien = true;
              break;
            }
          }
        }
        if (hitAlien) { continue; }

        // Player shot vs UFO.
        if (this.ufo && SI.aabb(box, this.ufo.box())) {
          var pts = this.ufo.kill(world);
          this.addScore(pts);
          this.banner = '+' + pts;
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

      // Both bullet kinds chew through bunkers.
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
    if (this.state === STATE.PLAYING) {
      this.setState(STATE.PAUSED);
      SI.Audio.stopMusic();
      SI.Audio.ufoStop();
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
