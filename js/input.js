/* input.js -- keyboard + pointer/touch state.
 *
 * `justPressed` entries live for exactly one frame; game.js reads them
 * during update and main.js calls endFrame() at the end of the frame.
 * The first gesture of any kind fires the onFirstGesture callbacks --
 * that is where the AudioContext gets created (autoplay policy).
 */
(function (SI) {
  'use strict';

  var down = Object.create(null);
  var pressed = Object.create(null);
  var gestureCallbacks = [];
  var gestureFired = false;

  // Keys we own: never let the page scroll or the button re-trigger.
  var SWALLOW = {
    ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1,
    Space: 1, Enter: 1, KeyA: 1, KeyD: 1, KeyZ: 1, KeyX: 1, KeyC: 1,
    KeyP: 1, KeyM: 1, ShiftLeft: 1, ShiftRight: 1,
    Digit1: 1, Digit2: 1, Digit3: 1, Digit4: 1
  };

  var pointer = {
    active: false,
    firing: false,
    x: SI.CONFIG.WORLD_W / 2,
    y: SI.CONFIG.WORLD_H / 2
  };

  // main.js installs the screen -> world coordinate mapper once the
  // letterbox transform is known.
  var mapper = null;

  function setMapper(fn) {
    mapper = fn;
  }

  function onFirstGesture(fn) {
    if (typeof fn === 'function') {
      gestureCallbacks.push(fn);
    }
  }

  // SI.Audio.unlock() is idempotent: it creates the context on the first
  // call and afterwards only resumes a suspended one. Calling it on every
  // gesture (not just the first) is what recovers audio after the OS or
  // the browser interrupts/suspends the context mid-session.
  function resumeAudio() {
    var A = SI.Audio;
    if (A && A.unlock) {
      try {
        A.unlock();
      } catch (e) {
        /* audio must never break input */
      }
    }
  }

  function fireGesture() {
    resumeAudio();
    if (gestureFired) {
      return;
    }
    gestureFired = true;
    for (var i = 0; i < gestureCallbacks.length; i++) {
      try {
        gestureCallbacks[i]();
      } catch (e) {
        /* a broken listener must not kill input */
      }
    }
  }

  function keyDown(e) {
    var code = e.code || e.key;
    if (SWALLOW[code]) {
      e.preventDefault();
    }
    fireGesture();
    if (!down[code]) {
      pressed[code] = true;
    }
    down[code] = true;
  }

  function keyUp(e) {
    var code = e.code || e.key;
    if (SWALLOW[code]) {
      e.preventDefault();
    }
    down[code] = false;
  }

  function blur() {
    down = Object.create(null);
    pointer.active = false;
    pointer.firing = false;
  }

  function updatePointer(e) {
    if (!mapper) {
      return;
    }
    var p = mapper(e.clientX, e.clientY);
    if (p) {
      pointer.x = p.x;
      pointer.y = p.y;
    }
  }

  function pointerDown(e) {
    fireGesture();
    updatePointer(e);
    pointer.active = true;
    if (!pointer.firing) {
      pressed.Pointer = true;
    }
    pointer.firing = true;
    if (e.preventDefault) {
      e.preventDefault();
    }
  }

  function pointerMove(e) {
    if (pointer.active) {
      updatePointer(e);
    }
  }

  function pointerUp() {
    pointer.active = false;
    pointer.firing = false;
  }

  function attach(target) {
    var el = target || window;
    window.addEventListener('keydown', keyDown, { passive: false });
    window.addEventListener('keyup', keyUp, { passive: false });
    window.addEventListener('blur', blur);

    if (window.PointerEvent) {
      el.addEventListener('pointerdown', pointerDown, { passive: false });
      el.addEventListener('pointermove', pointerMove, { passive: false });
      window.addEventListener('pointerup', pointerUp);
      window.addEventListener('pointercancel', pointerUp);
    } else {
      el.addEventListener('mousedown', pointerDown, { passive: false });
      el.addEventListener('mousemove', pointerMove, { passive: false });
      window.addEventListener('mouseup', pointerUp);
      el.addEventListener('touchstart', function (e) {
        if (e.touches && e.touches.length) {
          pointerDown(e.touches[0]);
        }
        e.preventDefault();
      }, { passive: false });
      el.addEventListener('touchmove', function (e) {
        if (e.touches && e.touches.length) {
          pointerMove(e.touches[0]);
        }
        e.preventDefault();
      }, { passive: false });
      window.addEventListener('touchend', pointerUp);
      window.addEventListener('touchcancel', pointerUp);
    }
  }

  function isDown(code) {
    return !!down[code];
  }

  var gamepadPrevButtons = [];

  function pollGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) {
      return null;
    }
    var pads = navigator.getGamepads();
    if (!pads) {
      return null;
    }
    for (var i = 0; i < pads.length; i++) {
      var pad = pads[i];
      if (pad && pad.connected) {
        return pad;
      }
    }
    return null;
  }

  function gamepadJustPressed(btnIndex) {
    var pad = pollGamepad();
    if (!pad || !pad.buttons || !pad.buttons[btnIndex]) {
      return false;
    }
    var isPressed = pad.buttons[btnIndex].pressed;
    var wasPressed = !!gamepadPrevButtons[btnIndex];
    return isPressed && !wasPressed;
  }

  function justPressed(code) {
    return !!pressed[code];
  }

  function endFrame() {
    pressed = Object.create(null);
    var pad = pollGamepad();
    if (pad && pad.buttons) {
      for (var i = 0; i < pad.buttons.length; i++) {
        gamepadPrevButtons[i] = pad.buttons[i].pressed;
      }
    } else {
      gamepadPrevButtons = [];
    }
  }

  /* ------------------------- semantic actions ----------------------- */

  function moveAxis() {
    var a = 0;
    if (down.ArrowLeft || down.KeyA) { a -= 1; }
    if (down.ArrowRight || down.KeyD) { a += 1; }
    var pad = pollGamepad();
    if (pad) {
      if (pad.buttons) {
        if (pad.buttons[14] && pad.buttons[14].pressed) { a -= 1; }
        if (pad.buttons[15] && pad.buttons[15].pressed) { a += 1; }
      }
      if (pad.axes && pad.axes.length > 0) {
        var stickX = pad.axes[0];
        if (Math.abs(stickX) > 0.18) {
          a += stickX;
        }
      }
    }
    return Math.max(-1, Math.min(1, a));
  }

  function firing() {
    if (down.Space || down.KeyZ || pointer.firing) {
      return true;
    }
    var pad = pollGamepad();
    if (pad && pad.buttons) {
      if ((pad.buttons[0] && pad.buttons[0].pressed) ||
          (pad.buttons[2] && pad.buttons[2].pressed) ||
          (pad.buttons[7] && pad.buttons[7].pressed)) {
        return true;
      }
    }
    return false;
  }

  function firePressed() {
    if (pressed.Space || pressed.KeyZ || pressed.Pointer) {
      return true;
    }
    return gamepadJustPressed(0) || gamepadJustPressed(2) || gamepadJustPressed(7);
  }

  function empPressed() {
    if (pressed.KeyX || pressed.ShiftLeft || pressed.ShiftRight) {
      return true;
    }
    return gamepadJustPressed(1) || gamepadJustPressed(3) || gamepadJustPressed(6);
  }

  function pausePressed() {
    if (pressed.KeyP) {
      return true;
    }
    return gamepadJustPressed(9);
  }

  function mutePressed() {
    if (pressed.KeyM) {
      return true;
    }
    return gamepadJustPressed(8);
  }

  function crtPressed() {
    if (pressed.KeyC) {
      return true;
    }
    return false;
  }

  function confirmPressed() {
    if (pressed.Enter || pressed.Space || pressed.KeyZ || pressed.Pointer) {
      return true;
    }
    return gamepadJustPressed(0) || gamepadJustPressed(9);
  }

  function cardPressed(idx) {
    if (pressed['Digit' + (idx + 1)]) {
      return true;
    }
    return false;
  }

  function vibrate(durationMs, weak, strong) {
    var d = durationMs || 120;
    var w = typeof weak === 'number' ? weak : 0.4;
    var s = typeof strong === 'number' ? strong : 0.7;
    var pad = pollGamepad();
    if (pad && pad.vibrationActuator && typeof pad.vibrationActuator.playEffect === 'function') {
      try {
        pad.vibrationActuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration: d,
          weakMagnitude: w,
          strongMagnitude: s
        });
      } catch (e) { /* ignore */ }
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(d);
      } catch (e) { /* ignore */ }
    }
  }

  function pointerState() {
    return pointer;
  }

  SI.Input = {
    attach: attach,
    setMapper: setMapper,
    onFirstGesture: onFirstGesture,
    isDown: isDown,
    justPressed: justPressed,
    endFrame: endFrame,
    moveAxis: moveAxis,
    firing: firing,
    firePressed: firePressed,
    empPressed: empPressed,
    pausePressed: pausePressed,
    mutePressed: mutePressed,
    crtPressed: crtPressed,
    confirmPressed: confirmPressed,
    cardPressed: cardPressed,
    vibrate: vibrate,
    pointer: pointerState,
    reset: blur
  };
})(window.SI = window.SI || {});
