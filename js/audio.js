/* audio.js -- 100% synthesized sound. No audio files, no network.
 *
 * The AudioContext is created lazily inside the first user gesture
 * (see SI.Input.onFirstGesture -> SI.Audio.unlock) so browser autoplay
 * policies never leave us with a permanently suspended context.
 */
(function (SI) {
  'use strict';

  var ctx = null;
  var master = null;
  var sfxBus = null;
  var musicBus = null;
  var noiseBuffer = null;
  var muted = false;
  var unlocked = false;

  var ufoNodes = null;

  /* ---------------------------- lifecycle --------------------------- */

  function unlock() {
    if (unlocked && ctx) {
      if (ctx.state === 'suspended' && ctx.resume) {
        ctx.resume();
      }
      return true;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      return false;
    }
    try {
      ctx = new AC();
    } catch (e) {
      ctx = null;
      return false;
    }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.85;
    sfxBus.connect(master);

    musicBus = ctx.createGain();
    musicBus.gain.value = 0.34;
    musicBus.connect(master);

    noiseBuffer = makeNoiseBuffer(1.2);
    unlocked = true;
    if (ctx.state === 'suspended' && ctx.resume) {
      ctx.resume();
    }
    return true;
  }

  function ready() {
    return unlocked && ctx && ctx.state !== 'closed';
  }

  function now() {
    return ctx ? ctx.currentTime : 0;
  }

  function makeNoiseBuffer(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  function setMuted(v) {
    muted = !!v;
    if (master) {
      var t = now();
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(muted ? 0.0001 : 0.9, t, 0.05);
    }
    return muted;
  }

  function toggleMute() {
    return setMuted(!muted);
  }

  function isMuted() {
    return muted;
  }

  /* ------------------------------ voices ---------------------------- */

  function tone(opts) {
    if (!ready()) {
      return null;
    }
    var t0 = opts.at == null ? now() : opts.at;
    var dur = opts.dur == null ? 0.2 : opts.dur;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = opts.type || 'square';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.toFreq != null) {
      if (opts.exp === false) {
        osc.frequency.linearRampToValueAtTime(opts.toFreq, t0 + dur);
      } else {
        osc.frequency.exponentialRampToValueAtTime(Math.max(opts.toFreq, 1), t0 + dur);
      }
    }
    if (opts.detune) {
      osc.detune.setValueAtTime(opts.detune, t0);
    }
    var peak = opts.gain == null ? 0.25 : opts.gain;
    var attack = opts.attack == null ? 0.006 : opts.attack;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    var out = opts.bus || sfxBus;
    if (opts.filter) {
      var flt = ctx.createBiquadFilter();
      flt.type = opts.filter;
      flt.frequency.setValueAtTime(opts.filterFreq || 1200, t0);
      if (opts.filterTo != null) {
        flt.frequency.exponentialRampToValueAtTime(Math.max(opts.filterTo, 20), t0 + dur);
      }
      osc.connect(flt);
      flt.connect(gain);
    } else {
      osc.connect(gain);
    }
    gain.connect(out);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    return osc;
  }

  function noise(opts) {
    if (!ready() || !noiseBuffer) {
      return null;
    }
    var t0 = opts.at == null ? now() : opts.at;
    var dur = opts.dur == null ? 0.25 : opts.dur;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    var flt = ctx.createBiquadFilter();
    flt.type = opts.filter || 'bandpass';
    flt.frequency.setValueAtTime(opts.freq || 900, t0);
    if (opts.toFreq != null) {
      flt.frequency.exponentialRampToValueAtTime(Math.max(opts.toFreq, 20), t0 + dur);
    }
    flt.Q.value = opts.q == null ? 1.1 : opts.q;
    var gain = ctx.createGain();
    var peak = opts.gain == null ? 0.3 : opts.gain;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + (opts.attack == null ? 0.005 : opts.attack));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt);
    flt.connect(gain);
    gain.connect(opts.bus || sfxBus);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
    return src;
  }

  /* ------------------------------- SFX ------------------------------ */

  function shoot() {
    if (!ready()) { return; }
    var t = now();
    tone({ type: 'square', freq: 880, toFreq: 190, dur: 0.16, gain: 0.16, at: t });
    tone({ type: 'sawtooth', freq: 1320, toFreq: 300, dur: 0.1, gain: 0.07, at: t });
    noise({ freq: 2400, toFreq: 700, dur: 0.09, gain: 0.07, at: t });
  }

  function alienHit() {
    if (!ready()) { return; }
    var t = now();
    noise({ freq: 1500, toFreq: 180, dur: 0.3, gain: 0.26, q: 0.9, at: t });
    tone({ type: 'triangle', freq: 420, toFreq: 70, dur: 0.26, gain: 0.16, at: t });
  }

  function bunkerHit() {
    if (!ready()) { return; }
    noise({ freq: 800, toFreq: 260, dur: 0.12, gain: 0.11, q: 1.4 });
  }

  function playerHit() {
    if (!ready()) { return; }
    var t = now();
    noise({ freq: 900, toFreq: 60, dur: 0.9, gain: 0.4, q: 0.6, at: t });
    tone({ type: 'sawtooth', freq: 260, toFreq: 40, dur: 0.85, gain: 0.24, at: t, filter: 'lowpass', filterFreq: 1800, filterTo: 120 });
    tone({ type: 'square', freq: 130, toFreq: 30, dur: 0.7, gain: 0.16, at: t + 0.03 });
  }

  function waveClear() {
    if (!ready()) { return; }
    var t = now();
    var notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    for (var i = 0; i < notes.length; i++) {
      tone({ type: 'triangle', freq: notes[i], dur: 0.32, gain: 0.2, at: t + i * 0.085 });
      tone({ type: 'square', freq: notes[i] * 2, dur: 0.16, gain: 0.05, at: t + i * 0.085 });
    }
  }

  function gameOver() {
    if (!ready()) { return; }
    var t = now();
    var notes = [392.0, 349.23, 293.66, 233.08, 174.61];
    for (var i = 0; i < notes.length; i++) {
      tone({ type: 'sawtooth', freq: notes[i], toFreq: notes[i] * 0.985, dur: 0.5, gain: 0.16, at: t + i * 0.19, filter: 'lowpass', filterFreq: 2200, filterTo: 400 });
      tone({ type: 'sine', freq: notes[i] / 2, dur: 0.6, gain: 0.13, at: t + i * 0.19 });
    }
    noise({ freq: 300, toFreq: 60, dur: 1.4, gain: 0.12, q: 0.5, at: t });
  }

  function extraLife() {
    if (!ready()) { return; }
    var t = now();
    var notes = [659.25, 880, 1174.7];
    for (var i = 0; i < notes.length; i++) {
      tone({ type: 'triangle', freq: notes[i], dur: 0.3, gain: 0.18, at: t + i * 0.07 });
    }
  }

  // Continuous warbling saucer tone; call ufoStop() when it leaves.
  function ufoStart() {
    if (!ready() || ufoNodes) { return; }
    var t = now();
    var osc = ctx.createOscillator();
    var lfo = ctx.createOscillator();
    var lfoGain = ctx.createGain();
    var gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(560, t);
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(11, t);
    lfoGain.gain.setValueAtTime(150, t);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    var flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.setValueAtTime(900, t);
    flt.Q.value = 3;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.11, t + 0.15);
    osc.connect(flt);
    flt.connect(gain);
    gain.connect(sfxBus);
    osc.start(t);
    lfo.start(t);
    ufoNodes = { osc: osc, lfo: lfo, gain: gain };
  }

  function ufoStop() {
    if (!ufoNodes || !ready()) {
      ufoNodes = null;
      return;
    }
    var t = now();
    var n = ufoNodes;
    ufoNodes = null;
    try {
      n.gain.gain.cancelScheduledValues(t);
      // Never start an exponential ramp from 0 -- clamp to epsilon first.
      n.gain.gain.setValueAtTime(Math.max(n.gain.gain.value, 0.0001), t);
      n.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      n.osc.stop(t + 0.2);
      n.lfo.stop(t + 0.2);
    } catch (e) {
      /* node already stopped -- ignore */
    }
  }

  function ufoKilled() {
    ufoStop();
    if (!ready()) { return; }
    var t = now();
    var notes = [1318.5, 1046.5, 1568, 2093];
    for (var i = 0; i < notes.length; i++) {
      tone({ type: 'square', freq: notes[i], dur: 0.14, gain: 0.14, at: t + i * 0.06 });
    }
    noise({ freq: 2000, toFreq: 200, dur: 0.4, gain: 0.2, at: t });
  }

  /* ------------------------------ music ----------------------------- */
  /* Lookahead scheduler: a timer wakes every LOOKAHEAD_MS and schedules
   * every note that falls inside the next SCHEDULE_AHEAD seconds against
   * ctx.currentTime (never Date.now()), so timing survives GC pauses. */

  var LOOKAHEAD_MS = 25;
  var SCHEDULE_AHEAD = 0.12;

  var music = {
    timer: null,
    step: 0,
    nextNoteTime: 0,
    bpm: 108,
    playing: false,
    intensity: 0
  };

  // Natural-minor-ish riff in A: bass root pattern + arpeggio pattern.
  var BASS = [0, 0, 7, 0, 5, 0, 3, 0, 0, 0, 7, 0, 8, 7, 5, 3];
  var ARP = [12, 15, 19, 15, 12, 19, 22, 19, 10, 14, 17, 14, 10, 17, 20, 17];
  var ROOT = 110; // A2

  function midiRatio(semi) {
    return Math.pow(2, semi / 12);
  }

  function scheduleStep(step, time) {
    var i = step % 16;
    var bassSemi = BASS[i];
    var stepDur = 60 / music.bpm / 4;

    // Bass: only on the pulse steps to keep the groove readable.
    if (i % 2 === 0) {
      tone({
        type: 'sawtooth',
        freq: ROOT * midiRatio(bassSemi),
        dur: stepDur * 1.7,
        gain: 0.22,
        at: time,
        bus: musicBus,
        filter: 'lowpass',
        filterFreq: 900 + music.intensity * 700,
        filterTo: 220
      });
    }

    // Arpeggio line, brighter as waves progress.
    tone({
      type: 'square',
      freq: ROOT * 2 * midiRatio(ARP[i]),
      dur: stepDur * 0.9,
      gain: 0.055 + music.intensity * 0.03,
      at: time,
      bus: musicBus
    });

    // Percussion: kick on 0/8, hat off-beats, snare on 4/12.
    if (i === 0 || i === 8) {
      tone({ type: 'sine', freq: 150, toFreq: 42, dur: 0.2, gain: 0.4, at: time, bus: musicBus });
    }
    if (i === 4 || i === 12) {
      noise({ freq: 1800, toFreq: 900, dur: 0.16, gain: 0.16, q: 0.8, at: time, bus: musicBus });
    }
    if (i % 2 === 1) {
      noise({ freq: 7000, dur: 0.045, gain: 0.055, q: 1.5, at: time, bus: musicBus, filter: 'highpass' });
    }
  }

  function tick() {
    if (!ready() || !music.playing) {
      return;
    }
    var stepDur = 60 / music.bpm / 4;
    var horizon = now() + SCHEDULE_AHEAD;
    var guard = 0;
    while (music.nextNoteTime < horizon && guard++ < 64) {
      scheduleStep(music.step, music.nextNoteTime);
      music.step++;
      music.nextNoteTime += stepDur;
    }
  }

  function startMusic(wave) {
    if (!ready()) {
      return;
    }
    setMusicWave(wave || 1);
    if (music.playing) {
      return;
    }
    music.playing = true;
    music.step = 0;
    music.nextNoteTime = now() + 0.08;
    if (musicBus) {
      var t = now();
      musicBus.gain.cancelScheduledValues(t);
      musicBus.gain.setValueAtTime(0.0001, t);
      musicBus.gain.linearRampToValueAtTime(0.34, t + 0.6);
    }
    if (music.timer === null) {
      music.timer = window.setInterval(tick, LOOKAHEAD_MS);
    }
    tick();
  }

  function stopMusic() {
    music.playing = false;
    if (music.timer !== null) {
      window.clearInterval(music.timer);
      music.timer = null;
    }
    if (musicBus && ready()) {
      var t = now();
      musicBus.gain.cancelScheduledValues(t);
      musicBus.gain.setValueAtTime(musicBus.gain.value, t);
      musicBus.gain.linearRampToValueAtTime(0.0001, t + 0.25);
    }
  }

  // Tempo/brightness ramp with the wave number, capped so late waves
  // stay playable rather than turning into a buzz.
  function setMusicWave(wave) {
    var w = Math.max(1, wave || 1);
    music.bpm = Math.min(108 + (w - 1) * 7, 168);
    music.intensity = Math.min((w - 1) / 8, 1);
  }

  SI.Audio = {
    unlock: unlock,
    ready: ready,
    setMuted: setMuted,
    toggleMute: toggleMute,
    isMuted: isMuted,
    shoot: shoot,
    alienHit: alienHit,
    bunkerHit: bunkerHit,
    playerHit: playerHit,
    waveClear: waveClear,
    gameOver: gameOver,
    extraLife: extraLife,
    ufoStart: ufoStart,
    ufoStop: ufoStop,
    ufoKilled: ufoKilled,
    startMusic: startMusic,
    stopMusic: stopMusic,
    setMusicWave: setMusicWave
  };
})(window.SI = window.SI || {});
