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
    GAME_OVER: 'GAME_OVER',
    HANGAR: 'HANGAR',
    PERK_DRAFT: 'PERK_DRAFT'
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
    this.boss = null;
    this.ufo = null;
    this.hazards = [];
    this.hazardTimer = 0;
    this.drones = [];
    this.perks = [];
    this.perkChoices = [];
    this.perkIndex = 0;
    this.hangarIndex = 0;
    this.isGlitchIncursion = false;
    this.shieldTimer = 0;

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
    // Secondary EMP super ability meter and active shockwave timer.
    this.emp = 0;
    this.empTimer = 0;
    // Toast banner for achievements.
    this.toast = '';
    this.toastTimer = 0;
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
      spawnAsteroid: function (ast) {
        self.hazards.push(ast);
      },
      spawnAlienFromUfo: function (x, y) {
        if (self.swarm) {
          return self.swarm.spawnFromUfo(x, y, self.world);
        }
        return null;
      },
      spawnAlienFromBoss: function (x, y, boss) {
        return self.spawnAlienFromBoss(x, y, boss);
      },
      spawnBullet: function (b) { self.bullets.push(b); },
      shake: function (power, dur) { SI.FX.addShake(power, dur); },
      alienBulletCount: function () { return self.countBullets('alien'); },
      onDescend: function () { self.warpBoost = Math.max(self.warpBoost, 0.12); },
      onInvasion: function () { self.invaded = true; }
    };
  }

  Game.prototype.spawnAlienFromUfo = function (x, y) {
    if (this.swarm) {
      return this.swarm.spawnFromUfo(x, y, this.world);
    }
    return null;
  };

  Game.prototype.spawnAlienFromBoss = function (x, y, boss) {
    if (!this.swarm) {
      this.swarm = new SI.Swarm(this.wave);
      this.swarm.aliens.length = 0;
    }
    return this.swarm.spawnFromBoss(x, y, this.world, boss);
  };

  Game.prototype.countBullets = function (from) {
    var n = 0;
    for (var i = 0; i < this.bullets.length; i++) {
      if (!this.bullets[i].dead && this.bullets[i].from === from) { n++; }
    }
    return n;
  };

  /* ----------------------------- lifecycle -------------------------- */

  Game.prototype.startGame = function () {
    this.isBossRush = false;
    this.bossRushWon = false;
    this.bossRushTime = 0;
    this.isGlitchIncursion = false;
    this.perks = [];
    this.drones = [];
    this.hazards = [];
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

  Game.prototype.startBossRush = function () {
    this.isBossRush = true;
    this.bossRushWon = false;
    this.bossRushTime = 0;
    this.isGlitchIncursion = false;
    this.perks = [];
    this.drones = [];
    this.hazards = [];
    this.score = 0;
    this.baseHi = this.hi;
    this.lives = C.PLAYER.START_LIVES;
    this.wave = 7;
    this.nextExtraLife = 5000;
    this.upgrade = 'none';
    this.upgradeIndex = 0;
    this.particles.clear();
    this.startWave(7);
    this.setState(STATE.PLAYING);
    SI.Audio.startMusic(this.wave);
  };

  Game.prototype.startGlitchIncursion = function () {
    this.isBossRush = false;
    this.bossRushWon = false;
    this.bossRushTime = 0;
    this.isGlitchIncursion = true;
    this.perks = [];
    this.drones = [];
    this.hazards = [];
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

  Game.prototype.openHangar = function () {
    this.state = STATE.HANGAR;
    this.hangarIndex = 0;
    if (SI.Audio && SI.Audio.hangarSelect) {
      SI.Audio.hangarSelect();
    }
  };

  Game.prototype.hasPerk = function (id) {
    return this.perks.indexOf(id) >= 0;
  };

  Game.prototype.rollPerkChoices = function () {
    var all = (C.GLITCH_INCURSION && C.GLITCH_INCURSION.PERKS) ? C.GLITCH_INCURSION.PERKS.slice() : [];
    var choices = [];
    while (all.length > 0 && choices.length < 3) {
      var idx = Math.floor(Math.random() * all.length);
      choices.push(all.splice(idx, 1)[0]);
    }
    this.perkChoices = choices;
    return choices;
  };

  Game.prototype.applyPerk = function (perkId) {
    this.perks.push(perkId);
    if (perkId === 'titan_plating') {
      this.lives++;
    }
    if (SI.Audio && SI.Audio.perkDraft) {
      SI.Audio.perkDraft();
    }
    this.startWave(this.wave + 1);
    this.setState(STATE.PLAYING);
  };

  Game.prototype.startWave = function (wave) {
    this.wave = wave;
    this.resetCombo();
    if (SI.isBossWave(wave) && !this.isGlitchIncursion) {
      this.swarm = null;
      this.boss = new SI.Boss(wave);
    } else {
      this.boss = null;
      this.swarm = new SI.Swarm(wave);
    }
    this.bullets.length = 0;
    this.invaded = false;
    this.player.reset(true);

    var selShip = SI.getSelectedShip ? SI.getSelectedShip() : 'ALPHA';
    this.player.applyShipClass(selShip);
    var shipCfg = (C.SHIPS && C.SHIPS.CLASSES) ? C.SHIPS.CLASSES[selShip] : null;
    if (shipCfg && shipCfg.startLives && wave === 1) {
      this.lives = Math.max(this.lives, shipCfg.startLives);
    }
    if (shipCfg && shipCfg.startShield) {
      this.shieldTimer = C.UPGRADE.SHIELD_TIME || 3.0;
    }
    if (this.hasPerk('titan_plating')) {
      this.shieldTimer = C.UPGRADE.SHIELD_TIME || 3.0;
    }

    this.drones = [];
    var wingmanCount = 0;
    for (var pi = 0; pi < this.perks.length; pi++) {
      if (this.perks[pi] === 'wingman') { wingmanCount++; }
    }
    for (var di = 0; di < wingmanCount; di++) {
      this.drones.push(new SI.Drone(di, wingmanCount));
    }

    this.hazards = [];
    if (C.ASTEROID && (wave >= (C.ASTEROID.FROM_WAVE || 3) || this.isGlitchIncursion)) {
      this.hazardTimer = SI.rand(C.ASTEROID.MIN_INTERVAL || 6.5, C.ASTEROID.MAX_INTERVAL || 13.0);
    } else {
      this.hazardTimer = Infinity;
    }

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
    if (Input.crtPressed && Input.crtPressed()) {
      if (SI.FX && typeof SI.FX.cycleCRTMode === 'function') {
        SI.FX.cycleCRTMode();
      }
    }

    if (this.isBossRush && this.state === STATE.PLAYING) {
      this.bossRushTime += dt;
    }

    if (SI.Audio && typeof SI.Audio.setMusicState === 'function') {
      if (this.boss && this.boss.alive) {
        SI.Audio.setMusicState(this.boss.phase >= 2 ? 'boss_enraged' : 'boss');
      } else if (this.swarm && typeof this.swarm.isFrenzy === 'function' && this.swarm.isFrenzy()) {
        SI.Audio.setMusicState('frenzy');
      } else {
        SI.Audio.setMusicState('normal');
      }
    }

    switch (this.state) {
      case STATE.MENU:
        this.particles.update(dt);
        var p = Input.pointer();
        var isClick = Input.confirmPressed();
        if (Input.bossRushPressed && Input.bossRushPressed()) {
          this.startBossRush();
        } else if (Input.glitchIncursionPressed && Input.glitchIncursionPressed()) {
          this.startGlitchIncursion();
        } else if (Input.hangarPressed && Input.hangarPressed()) {
          this.openHangar();
        } else if (isClick && p && p.active && p.y >= 445 && p.y <= 495 && p.x >= 240 && p.x <= 720) {
          this.startBossRush();
        } else if (isClick && p && p.active && p.y >= 500 && p.y <= 550) {
          this.startGlitchIncursion();
        } else if (isClick && p && p.active && p.y >= 560 && p.y <= 620) {
          this.openHangar();
        } else if (isClick) {
          this.startGame();
        }
        break;

      case STATE.HANGAR:
        this.particles.update(dt);
        this.updateHangar(dt);
        break;

      case STATE.PERK_DRAFT:
        this.particles.update(dt);
        this.updatePerkDraft(dt);
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
          if (this.isGlitchIncursion) {
            this.rollPerkChoices();
            this.perkIndex = 0;
            this.setState(STATE.PERK_DRAFT);
          } else {
            this.upgradeIndex = 0;
            this.setState(STATE.UPGRADE);
          }
        }
        break;

      case STATE.UPGRADE:
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
        if (this.isGlitchIncursion && SI.saveGlitchRecord) {
          SI.saveGlitchRecord(this.wave, this.score);
        }
        if (this.stateTimer > 1.2 && Input.confirmPressed()) {
          this.startGame();
        }
        break;
    }
  };

  Game.prototype.updateHangar = function (dt) {
    var Input = SI.Input;
    var shipIds = ['ALPHA', 'VECTOR', 'AEGIS', 'PHANTOM'];
    var n = shipIds.length;
    var i;

    if (Input.justPressed('ArrowLeft') || Input.justPressed('KeyA')) {
      this.hangarIndex = (this.hangarIndex + n - 1) % n;
      if (SI.Audio && SI.Audio.hangarSelect) { SI.Audio.hangarSelect(); }
    }
    if (Input.justPressed('ArrowRight') || Input.justPressed('KeyD')) {
      this.hangarIndex = (this.hangarIndex + 1) % n;
      if (SI.Audio && SI.Audio.hangarSelect) { SI.Audio.hangarSelect(); }
    }
    for (i = 0; i < n; i++) {
      if (Input.justPressed('Digit' + (i + 1))) {
        this.hangarIndex = i;
        if (SI.Audio && SI.Audio.hangarSelect) { SI.Audio.hangarSelect(); }
      }
    }

    var p = Input.pointer();
    var tapEdge = Input.justPressed('Pointer');
    if (tapEdge && p) {
      var cardW = 205, gap = 16, cardY = 150, cardH = 360;
      var totalW = n * cardW + (n - 1) * gap;
      var startX = (C.WORLD_W - totalW) / 2;
      for (i = 0; i < n; i++) {
        var rx = startX + i * (cardW + gap);
        if (p.x >= rx && p.x <= rx + cardW && p.y >= cardY && p.y <= cardY + cardH) {
          this.hangarIndex = i;
          break;
        }
      }
    }

    if (Input.justPressed('Escape') || Input.justPressed('KeyB')) {
      this.setState(STATE.MENU);
      return;
    }

    if (Input.confirmPressed()) {
      var targetId = shipIds[this.hangarIndex];
      if (SI.isShipUnlocked(targetId)) {
        SI.setSelectedShip(targetId);
        this.player.applyShipClass(targetId);
        if (SI.Audio && SI.Audio.hangarSelect) { SI.Audio.hangarSelect(); }
        this.setState(STATE.MENU);
      }
    }
  };

  Game.prototype.updatePerkDraft = function (dt) {
    var Input = SI.Input;
    var perks = this.perkChoices || [];
    var n = perks.length;
    var i;

    if (Input.justPressed('ArrowLeft') || Input.justPressed('KeyA')) {
      this.perkIndex = (this.perkIndex + n - 1) % n;
    }
    if (Input.justPressed('ArrowRight') || Input.justPressed('KeyD')) {
      this.perkIndex = (this.perkIndex + 1) % n;
    }
    for (i = 0; i < n; i++) {
      if (Input.justPressed('Digit' + (i + 1))) {
        this.perkIndex = i;
      }
    }

    var p = Input.pointer();
    var tapEdge = Input.justPressed('Pointer');
    if (tapEdge && p && SI.HUD && typeof SI.HUD.perkCardRect === 'function') {
      for (i = 0; i < n; i++) {
        var r = SI.HUD.perkCardRect(i, n);
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
          this.perkIndex = i;
          break;
        }
      }
    }

    if (Input.confirmPressed() && perks[this.perkIndex]) {
      this.applyPerk(perks[this.perkIndex].id);
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
    w.empCharge = this.emp / (C.EMP.MAX || 100);
    return w;
  };

  /* -------------------------- cannon upgrade ------------------------ */

  Game.prototype.upgradeChoices = function () {
    var U = C.UPGRADE;
    var out = U.IDS.slice();
    if (!U.COMBINES || !Object.prototype.hasOwnProperty.call(U.COMBINES, this.upgrade)) {
      return out;
    }
    var map = U.COMBINES[this.upgrade];
    if (typeof map === 'string') {
      var mateIdx = out.indexOf(map);
      if (mateIdx >= 0) { out[mateIdx] = U.COMBINED_ID; }
      return out;
    }
    for (var src in map) {
      if (Object.prototype.hasOwnProperty.call(map, src)) {
        var i = out.indexOf(src);
        if (i >= 0) {
          out[i] = map[src];
        }
      }
    }
    return out;
  };

  // Hit-test for tapping a card. Geometry lives in hud.js so the drawing
  // and the hit box can never drift apart.
  Game.prototype.upgradeCardAt = function (x, y) {
    var ids = this.upgradeChoices();
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
    // The live card list -- IDS, or IDS with the complementary card swapped
    // for the combine card. Its length is always IDS.length, so the arrow
    // wrap, the 1-4 digit bindings and the card geometry are unchanged.
    var ids = this.upgradeChoices();
    var n = ids.length;
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
      this.applyUpgrade(ids[this.upgradeIndex]);
    }
  };

  Game.prototype.applyUpgrade = function (id) {
    // Defence in depth, against the list THIS pick screen actually offered --
    // not against the static IDS pool. Checking IDS needed a special case for
    // COMBINED_ID (which is deliberately not in IDS) and still would have
    // waved through a card that was never on screen; upgradeChoices() is by
    // definition the set of legal answers, so it needs neither. An id that is
    // not on it has no Player.fire branch or no business being picked, so
    // fall back to the first real one rather than shipping the player a
    // cannon that does nothing.
    var ids = this.upgradeChoices();
    this.upgrade = ids.indexOf(id) >= 0 ? id : C.UPGRADE.IDS[0];
    if (this.upgrade && this.upgrade.indexOf('_') >= 0) {
      this.unlockAchievement('weapon_fused');
    }
    if (this.isBossRush) {
      var nextWave = this.wave === 7 ? 14 : (this.wave === 14 ? 21 : (this.wave + 1));
      this.startWave(nextWave);
    } else {
      this.startWave(this.wave + 1);
    }
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

    if (this.shieldTimer > 0) {
      this.shieldTimer -= dt;
    }

    if (SI.Input && SI.Input.empPressed && SI.Input.empPressed()) {
      this.triggerEmp(world);
    }
    if (SI.Input && SI.Input.dashPressed && SI.Input.dashPressed()) {
      if (this.player.startDash(world.moveAxis)) {
        if (SI.Audio && SI.Audio.phaseDash) { SI.Audio.phaseDash(); }
        if (this.particles) {
          this.particles.emitSparks(this.player.x, this.player.y, this.player.glow || '#d066ff', 8, 0, 0, Math.PI * 2);
        }
      }
    }

    if (this.empTimer > 0) {
      this.empTimer -= dt;
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
    }

    this.player.update(dt, world);
    for (i = 0; i < this.drones.length; i++) {
      this.drones[i].update(dt, world, this.player.x, this.player.y);
    }

    if (this.swarm) {
      this.swarm.update(dt, world);
    }
    if (this.boss) {
      this.boss.update(dt, world);
    }

    // Cosmic Space Hazards (Asteroids)
    if (C.ASTEROID && (this.wave >= (C.ASTEROID.FROM_WAVE || 3) || this.isGlitchIncursion)) {
      this.hazardTimer -= dt;
      if (this.hazardTimer <= 0) {
        this.hazardTimer = SI.rand(C.ASTEROID.MIN_INTERVAL || 6.5, C.ASTEROID.MAX_INTERVAL || 13.0);
        var fromLeft = SI.chance(0.5);
        var hx = fromLeft ? -30 : (C.WORLD_W + 30);
        var hy = SI.rand(C.ASTEROID.MIN_Y || 340, C.ASTEROID.MAX_Y || 480);
        var ast = new SI.Asteroid(hx, hy, 'large', fromLeft ? 1 : -1);
        this.hazards.push(ast);
      }
    }
    for (i = 0; i < this.hazards.length; i++) {
      this.hazards[i].update(dt, world);
    }
    SI.compact(this.hazards);

    for (i = 0; i < this.bullets.length; i++) {
      this.bullets[i].update(dt, world);
    }

    this.updateUfo(dt, world);
    this.particles.update(dt);
    this.collide(world);
    if (typeof world.empCharge === 'number') {
      this.emp = Math.max(0, Math.min(C.EMP.MAX || 100, world.empCharge * (C.EMP.MAX || 100)));
    }
    SI.compact(this.bullets);

    if (this.invaded) {
      this.invaded = false;
      this.loseLife(world, true);
    }

    if (this.boss && !this.boss.alive && this.state === STATE.PLAYING) {
      this.clearWave();
    } else if (this.swarm && this.swarm.aliveCount() === 0 && this.state === STATE.PLAYING) {
      this.clearWave();
    }
  };

  Game.prototype.updateUfo = function (dt, world) {
    if (this.ufo) {
      this.ufo.update(dt, world);
      if (this.ufo.dead) {
        if (this.ufo.escaped) {
          SI.Audio.ufoStop();
        }
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
        if (this.swarm && !b.defensiveOnly) {
          var aliens = this.swarm.aliens;
          for (j = 0; j < aliens.length; j++) {
            var a = aliens[j];
            if (!a.alive) { continue; }
            if (a.role === 'phase' && a.phased) { continue; }
            if (SI.aabb(box, a.box())) {
              var shield = this.swarm.shieldFor(a);
              if (shield) {
                a.hitFlash = C.ALIEN_CLASS.SHIELD.FLASH;
                a = shield;
                this.addEmp(C.EMP.GAIN_SHIELD);
              } else if (a.role === 'kamikaze') {
                this.addEmp(C.EMP.GAIN_KAMIKAZE);
              }
              if (a.commander) {
                this.addEmp(C.EMP.GAIN_COMMANDER);
                this.unlockAchievement('commander_slayer');
              }
              this.swarm.killAlien(a, world, b);
              this.scoreKill(a.score);

              // Chain Lightning Perk in Glitch Incursion
              if (this.hasPerk('chain_lightning') && this.swarm) {
                var sAliens = this.swarm.aliens;
                var chainKills = 0;
                for (var ci = 0; ci < sAliens.length && chainKills < 2; ci++) {
                  var ca = sAliens[ci];
                  if (ca.alive && ca !== a && Math.abs(ca.x - a.x) < 120 && Math.abs(ca.y - a.y) < 100) {
                    this.swarm.killAlien(ca, world);
                    this.scoreKill(ca.score);
                    if (world.particles) {
                      world.particles.emitSparks(ca.x, ca.y, '#ffd166', 8, 0, 0, Math.PI * 2);
                    }
                    chainKills++;
                  }
                }
              }

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

        // Player shot vs Boss.
        if (this.boss && this.boss.alive && !b.defensiveOnly && SI.aabb(box, this.boss.box())) {
          this.boss.takeDamage(1, world);
          this.addEmp(C.EMP.GAIN_BOSS_HIT);
          if (!this.boss.alive) {
            this.addEmp(C.EMP.GAIN_BOSS_KILL);
            this.scoreKill(this.boss.score);
            this.banner = 'BOSS DEFEATED +' + (this.boss.score * this.comboMult());
            this.bannerTime = 2.5;
          }
          if (b.pierce > 0) {
            b.pierce--;
          } else {
            b.dead = true;
          }
          continue;
        }

        // Player shot vs UFO.
        if (this.ufo && !b.defensiveOnly && SI.aabb(box, this.ufo.box())) {
          var isSab = !!this.ufo.isSaboteur;
          var pts = this.ufo.kill(world);
          this.addEmp(C.EMP.GAIN_UFO);
          if (isSab) {
            this.addEmp((C.EMP.MAX || 100) * 0.50);
          }
          var gain = this.scoreKill(pts);
          this.banner = isSab ? 'SABOTEUR DOWN! +50% EMP' : ('+' + gain);
          this.bannerTime = 1.4;
          this.ufo = null;
          this.ufoTimer = SI.rand(C.UFO.MIN_DELAY, C.UFO.MAX_DELAY);
          b.dead = true;
          continue;
        }

        // Player shot vs Asteroids & Space Hazards
        var hitHazard = false;
        for (j = 0; j < this.hazards.length; j++) {
          var hz = this.hazards[j];
          if (!hz.dead && SI.aabb(box, hz.box())) {
            hitHazard = true;
            if (b.bounce > 0 || this.hasPerk('prism_ricochet')) {
              b.bounce = Math.max(0, b.bounce - 1);
              b.vx = -b.vx;
              b.vy = -b.vy;
            } else if (b.pierce > 0) {
              b.pierce--;
            } else {
              b.dead = true;
            }
            var scr = hz.hit(1, world, b);
            if (scr > 0) { this.scoreKill(scr); }
            break;
          }
        }
        if (hitHazard && b.dead) { continue; }

        // Player shot vs incoming alien shots
        for (j = 0; j < this.bullets.length; j++) {
          var ob = this.bullets[j];
          if (ob.dead || ob.from !== 'alien') { continue; }
          if (SI.aabb(box, ob.box())) {
            ob.dead = true;
            this.unlockAchievement('sharpshooter');
            if (!b.antiBullet) {
              b.dead = true;
            }
            if (world.particles) {
              world.particles.emitSparks(ob.x, ob.y, C.COLORS.alienBullet, 6, 0, 0, Math.PI);
              this.particles.emitSparks(b.x, b.y, '#ffffff', 10, 0, -1, Math.PI);
            }
            this.addScore(5);
            break;
          }
        }
        if (b.dead) { continue; }
      } else {
        // Alien shot vs Asteroids
        for (j = 0; j < this.hazards.length; j++) {
          var ahz = this.hazards[j];
          if (!ahz.dead && SI.aabb(box, ahz.box())) {
            b.dead = true;
            ahz.hit(1, world, b);
            break;
          }
        }
        if (b.dead) { continue; }

        // Alien shot vs player.
        if (this.player.alive && this.player.invuln <= 0 && (!this.shieldTimer || this.shieldTimer <= 0) &&
            SI.aabb(box, this.player.box())) {
          b.dead = true;
          this.loseLife(world, false);
          continue;
        }
      }

      // Bunkers
      for (j = 0; j < this.bunkers.length; j++) {
        var bunker = this.bunkers[j];
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

    // Hyper-Graze Detection: Proximity checks for alive player vs un-grazed alien bullets on Wave 2+
    if (this.player.alive && (this.wave >= (C.GRAZE ? (C.GRAZE.FROM_WAVE || 2) : 2) || this.isGlitchIncursion)) {
      var gBox = this.player.grazeBox ? this.player.grazeBox() : null;
      var lBox = this.player.box();
      if (gBox) {
        for (j = 0; j < this.bullets.length; j++) {
          var ab = this.bullets[j];
          if (ab.from === 'alien' && !ab.dead && !ab.grazed) {
            if (SI.aabb(ab.box(), gBox) && !SI.aabb(ab.box(), lBox)) {
              ab.grazed = true;
              this.player.grazeEnergy = Math.min(100, (this.player.grazeEnergy || 0) + (C.GRAZE ? C.GRAZE.CHARGE_PER_GRAZE : 12));
              this.addScore((C.GRAZE ? C.GRAZE.SCORE : 25) * this.comboMult());
              if (SI.Audio && SI.Audio.graze) { SI.Audio.graze(); }
              if (world.particles) { world.particles.emitSparks(ab.x, ab.y, '#ffd166', 3, 0, -1, 0.6); }
              if (this.hasPerk('graze_dynamo')) {
                this.addEmp(15);
              }
            }
          }
        }
      }
    }

    // Asteroids vs Player Contact
    if (this.player.alive && this.player.invuln <= 0 && (!this.shieldTimer || this.shieldTimer <= 0)) {
      for (j = 0; j < this.hazards.length; j++) {
        var hzrd = this.hazards[j];
        if (!hzrd.dead && SI.aabb(this.player.box(), hzrd.box())) {
          hzrd.hit(10, world);
          this.loseLife(world, false);
          break;
        }
      }
    }

    // Swarm vs bunkers and Kamikaze / Soaring collision
    if (this.swarm) {
      var swarmAliens = this.swarm.aliens;
      for (i = 0; i < swarmAliens.length; i++) {
        var al = swarmAliens[i];
        if (!al.alive || al.dive || al.swoop || al.y + al.h / 2 < C.BUNKER.Y - 4) { continue; }
        for (j = 0; j < this.bunkers.length; j++) {
          if (this.bunkers[j].crushBelow(al.box())) {
            this.particles.emitSparks(al.x, al.y + al.h / 2, C.COLORS.bunker, 4, 0, 1, 1.2);
          }
        }
      }
      if (this.player.alive && this.player.invuln <= 0 && (!this.shieldTimer || this.shieldTimer <= 0)) {
        for (i = 0; i < swarmAliens.length; i++) {
          var kz = swarmAliens[i];
          if (!kz.alive) { continue; }
          if ((kz.dive || kz.swoop || (this.swarm.isFrenzy() && kz.soar)) && SI.aabb(kz.box(), this.player.box())) {
            this.swarm.killAlien(kz, world);
            this.loseLife(world, false);
            break;
          }
        }
      }
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

  Game.prototype.scoreKill = function (points) {
    if (this.wave < C.COMBO.FROM_WAVE || this.state === STATE.GAME_OVER) {
      this.addScore(points);
      return points;
    }
    this.combo++;
    this.comboTimer = C.COMBO.WINDOW;
    this.addEmp(C.EMP.GAIN_KILL);
    if (this.comboMult() === 4) {
      this.unlockAchievement('combo_master');
    }
    var gain = points * this.comboMult();
    this.addScore(gain);
    return gain;
  };

  Game.prototype.addScore = function (points) {
    this.score += points;
    if (this.score >= 20000) {
      this.unlockAchievement('high_roller');
    }
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
    this.resetCombo();
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
    this.resetCombo();
    SI.Audio.stopMusic();
    SI.Audio.ufoStop();
    SI.Audio.gameOver();
    this.flushHi();
    if (this.isGlitchIncursion && SI.saveGlitchRecord) {
      SI.saveGlitchRecord(this.wave, this.score);
    }
  };

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
    this.resetCombo();
    if (this.wave === 1) {
      this.unlockAchievement('first_blood');
    } else if (this.wave === 7) {
      this.unlockAchievement('mothership_down');
    } else if (this.wave === 14) {
      this.unlockAchievement('sovereign_fall');
    }
    if (this.isBossRush && this.wave === 21) {
      this.bossRushWon = true;
      var timeStr = (this.bossRushTime || 0).toFixed(2);
      this.banner = 'BOSS RUSH VICTORY! ' + timeStr + 's';
      this.bannerTime = 4.0;
      var rawPb = localStorage.getItem('neon_invaders_boss_rush_pb');
      var parsedPb = parseFloat(rawPb);
      var prevPb = (isFinite(parsedPb) && parsedPb > 0) ? parsedPb : Infinity;
      if (this.bossRushTime < prevPb) {
        localStorage.setItem('neon_invaders_boss_rush_pb', timeStr);
      }
      this.setState(STATE.GAME_OVER);
      SI.Audio.stopMusic();
      SI.Audio.waveClear();
      this.particles.emitExplosion(C.WORLD_W / 2, C.WORLD_H / 2, C.COLORS.accent, 50, 1.5);
      return;
    }
    var intactBunkers = this.bunkers.filter(function (bk) {
      return bk.alive && bk.alive() && bk.damage && bk.damage.length === 0;
    });
    if (intactBunkers.length === 4) {
      this.unlockAchievement('bunker_guardian');
    }
    this.setState(STATE.WAVE_CLEAR);
    this.warpBoost = 1;
    this.bullets.length = 0;
    SI.Audio.ufoStop();
    this.ufo = null;
    SI.Audio.stopMusic();
    SI.Audio.waveClear();
    this.particles.emitExplosion(C.WORLD_W / 2, C.WORLD_H / 2, C.COLORS.accent, 40, 1.2);
  };

  Game.prototype.unlockAchievement = function (id) {
    if (!SI.Achievements || typeof SI.Achievements.unlock !== 'function') {
      return false;
    }
    var unlocked = SI.Achievements.unlock(id);
    if (unlocked) {
      var cfg = C.ACHIEVEMENTS[id.toUpperCase()] || C.ACHIEVEMENTS[id];
      var name = cfg ? cfg.name : id;
      this.toast = 'ACHIEVEMENT UNLOCKED: ' + name;
      this.toastTimer = 3.5;
    }
    return unlocked;
  };

  Game.prototype.addEmp = function (amt) {
    if (this.state !== STATE.PLAYING) { return; }
    this.emp = Math.min(C.EMP.MAX, this.emp + (amt || 1));
  };

  Game.prototype.triggerEmp = function (world) {
    if (this.emp < C.EMP.MAX || this.state !== STATE.PLAYING) {
      return false;
    }
    var w = world || this.world;
    this.emp = 0;
    this.empTimer = 0.5;

    if (w && w.shake) {
      w.shake(22, 0.45);
    }
    if (w && w.audio && w.audio.ufoKilled) {
      w.audio.ufoKilled();
    }
    SI.Input.vibrate(300, 0.8, 1.0);

    var px = this.player.x;
    var py = this.player.y - 20;

    if (w && w.particles) {
      w.particles.emitExplosion(px, py, C.EMP.COLOR, 60, 2.5);
      w.particles.emitDebris(px, py, C.EMP.COLOR_READY, 20, 1.8);
      w.particles.emitSparks(px, py, '#ffffff', 32, 0, 0, Math.PI * 2);
    }

    for (var i = 0; i < this.bullets.length; i++) {
      var b = this.bullets[i];
      if (b.from === 'alien' && !b.dead) {
        b.dead = true;
        if (w && w.particles) {
          w.particles.emitSparks(b.x, b.y, C.COLORS.alienBullet, 5, 0, 0, Math.PI);
        }
      }
    }

    if (this.boss && this.boss.alive) {
      this.boss.takeDamage(C.EMP.DAMAGE_BOSS, w);
      if (!this.boss.alive) {
        this.addEmp(C.EMP.GAIN_BOSS_KILL);
        this.scoreKill(this.boss.score);
        this.banner = 'BOSS DEFEATED +' + (this.boss.score * this.comboMult());
        this.bannerTime = 2.5;
      }
    }

    if (this.swarm) {
      if (w) { w.isEmp = true; }
      var live = this.swarm.aliens.filter(function (a) { return a.alive && !a.commander; });
      for (var k = 0; k < Math.min(8, live.length); k++) {
        var victim = live[k];
        this.swarm.killAlien(victim, w);
        this.scoreKill(victim.score);
      }
      if (w) { w.isEmp = false; }
    }

    this.emp = 0;
    this.unlockAchievement('emp_blast');
    this.banner = 'EMP SHOCKWAVE!';
    this.bannerTime = 1.5;
    return true;
  };

  /* ------------------------------- draw ----------------------------- */

  Game.prototype.draw = function (ctx) {
    var i;
    for (i = 0; i < this.bunkers.length; i++) {
      this.bunkers[i].draw(ctx);
    }
    for (i = 0; i < this.hazards.length; i++) {
      if (!this.hazards[i].dead) {
        this.hazards[i].draw(ctx);
      }
    }
    if (this.swarm && this.state !== STATE.MENU && this.state !== STATE.HANGAR) {
      this.swarm.draw(ctx);
    }
    if (this.boss && this.state !== STATE.MENU && this.state !== STATE.HANGAR) {
      this.boss.draw(ctx);
    }
    if (this.ufo) {
      this.ufo.draw(ctx);
    }
    if (this.state !== STATE.MENU && this.state !== STATE.HANGAR) {
      this.player.draw(ctx);
      for (i = 0; i < this.drones.length; i++) {
        this.drones[i].draw(ctx);
      }
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
