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
    Space: 1, Enter: 1, KeyA: 1, KeyD: 1, KeyZ: 1, KeyP: 1, KeyM: 1
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

  function justPressed(code) {
    return !!pressed[code];
  }

  function endFrame() {
    pressed = Object.create(null);
  }

  /* ------------------------- semantic actions ----------------------- */

  function moveAxis() {
    var a = 0;
    if (down.ArrowLeft || down.KeyA) { a -= 1; }
    if (down.ArrowRight || down.KeyD) { a += 1; }
    return a;
  }

  function firing() {
    return !!(down.Space || down.KeyZ || pointer.firing);
  }

  function firePressed() {
    return !!(pressed.Space || pressed.KeyZ || pressed.Pointer);
  }

  function pausePressed() {
    return !!pressed.KeyP;
  }

  function mutePressed() {
    return !!pressed.KeyM;
  }

  function confirmPressed() {
    return !!(pressed.Enter || pressed.Space || pressed.KeyZ || pressed.Pointer);
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
    pausePressed: pausePressed,
    mutePressed: mutePressed,
    confirmPressed: confirmPressed,
    pointer: pointerState,
    reset: blur
  };
})(window.SI = window.SI || {});
