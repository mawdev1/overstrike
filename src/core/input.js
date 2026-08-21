/**
 * Input: pointer lock mouse look + action-mapped keyboard.
 *
 * Mouse deltas accumulate between simulation steps and are drained by the player
 * controller via `consumeLook()`. Raw deltas are never smoothed here — smoothing is a
 * camera concern and would add input latency for everyone if done at this layer.
 */
import { mouseCode } from './mouseCodes.js';
export class Input {
  constructor(game, canvas) {
    this.game = game;
    this.canvas = canvas;
    this.settings = game.settings;

    /** @type {Set<string>} action names currently held */
    this.actions = new Set();
    /** @type {Set<string>} actions that went down this frame */
    this.pressed = new Set();
    /** @type {Set<string>} actions that went up this frame */
    this.released = new Set();
    /** @type {Set<string>} raw key codes currently held */
    this.codes = new Set();

    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.buttons = [false, false, false, false, false];
    this.buttonsPressed = [false, false, false, false, false];
    this.buttonsReleased = [false, false, false, false, false];

    this.locked = false;
    this.enabled = true;
    /** In-flight requestLock(), resolved by pointerlockchange or by its own timeout. */
    this._lockPending = null;
    /** Set while the UI is capturing a key for rebinding. */
    this.captureBind = null;

    this._onLockChange = this._onLockChange.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onCanvasDown = this._onCanvasDown.bind(this);
    this._onContext = (e) => e.preventDefault();

    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('pointerlockerror', () => { this.locked = false; this._settleLock(); });
    document.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('blur', this._onBlur);
    canvas.addEventListener('contextmenu', this._onContext);
    canvas.addEventListener('mousedown', this._onCanvasDown);
  }

  /**
   * Pointer lock can only be taken during a user gesture. Every failure path here is
   * expected and must be swallowed: an uncaught rejection from requestPointerLock
   * surfaces as a page error and, in a browser, a console full of red.
   *
   * Resolves true only once the lock is genuinely held. Callers need that answer: a
   * refused lock — macOS browsers do not count Escape as a gesture, and Chrome
   * throttles re-locking for about a second after a user-initiated exit — used to be
   * indistinguishable from success, which left the player unpaused and alive with the
   * system cursor sitting on top of the window.
   */
  requestLock() {
    if (this.locked) return Promise.resolve(true);
    if (!this.canvas.requestPointerLock) return Promise.resolve(false);

    if (!this._lockPending) {
      const pending = {};
      pending.promise = new Promise((res) => { pending.resolve = res; });
      // Engines that return no promise (Safari) never report refusal at all, so the
      // timeout is the only honest answer available for them.
      pending.timer = setTimeout(() => this._settleLock(), 700);
      this._lockPending = pending;
    }
    const result = this._lockPending.promise;

    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      // Chrome returns a promise when options are passed; older engines return undefined.
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          try {
            const q = this.canvas.requestPointerLock();
            if (q && typeof q.catch === 'function') q.catch(() => this._settleLock());
          } catch { this._settleLock(); }
        });
      }
    } catch { this._settleLock(); }

    return result;
  }

  /** Answer a pending requestLock() with the real lock state, whatever it is. */
  _settleLock() {
    const p = this._lockPending;
    if (!p) return;
    this._lockPending = null;
    clearTimeout(p.timer);
    p.resolve(this.locked);
  }

  exitLock() { if (this.locked) document.exitPointerLock(); }

  _onLockChange() {
    this.locked = document.pointerLockElement === this.canvas;
    this._settleLock();
    this.game.bus.emit(this.locked ? 'pointerLock' : 'pointerUnlock', {});
    if (!this.locked) this._clearHeld();
  }

  /**
   * Last-resort recovery: clicking the canvas while unlocked but in play takes the
   * lock back. A click is always a valid gesture, so this works even when the browser
   * refused every earlier request.
   */
  _onCanvasDown() {
    if (this.locked || this.game.state !== 'playing' || this.game.paused) return;
    if (this.game.menu?.isOpen) return;
    this.requestLock();
  }

  _clearHeld() {
    this.actions.clear();
    this.codes.clear();
    this.buttons.fill(false);
    this.mouseDX = this.mouseDY = 0;
  }

  _onBlur() { this._clearHeld(); }

  _onMouseMove(e) {
    if (!this.locked || !this.enabled) return;
    // Some browsers report huge spurious deltas on lock acquisition; clamp them.
    const dx = Math.abs(e.movementX) > 300 ? 0 : e.movementX;
    const dy = Math.abs(e.movementY) > 300 ? 0 : e.movementY;
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  _onKeyDown(e) {
    if (this.captureBind) {
      e.preventDefault();
      const cb = this.captureBind;
      this.captureBind = null;
      cb(e.code);
      return;
    }
    if (e.repeat) return;
    if (e.code === 'Tab' || (e.code === 'Space' && this.locked)) e.preventDefault();
    this.codes.add(e.code);
    const action = this.settings.actionFor(e.code);
    if (action) {
      this.actions.add(action);
      this.pressed.add(action);
      if (action === 'nextWeapon') this.wheelDelta += 1;
      else if (action === 'previousWeapon') this.wheelDelta -= 1;
    }
    this.game.bus.emit('keydown', { code: e.code, action });
  }

  _onKeyUp(e) {
    this.codes.delete(e.code);
    const action = this.settings.actionFor(e.code);
    if (action) {
      if (!this._actionHeld(action)) {
        this.actions.delete(action);
        this.released.add(action);
      }
    }
    this.game.bus.emit('keyup', { code: e.code, action });
  }

  _onMouseDown(e) {
    if (e.button >= 0 && e.button < this.buttons.length) {
      this.buttons[e.button] = true;
      this.buttonsPressed[e.button] = true;
      const action = this.settings.actionFor(mouseCode(e.button));
      if (action) {
        this.actions.add(action);
        this.pressed.add(action);
      }
    }
    this.game.bus.emit('mousedown', { button: e.button, target: e.target });
  }

  _onMouseUp(e) {
    if (e.button >= 0 && e.button < this.buttons.length) {
      this.buttons[e.button] = false;
      this.buttonsReleased[e.button] = true;
      const action = this.settings.actionFor(mouseCode(e.button));
      if (action) {
        if (!this._actionHeld(action)) {
          this.actions.delete(action);
          this.released.add(action);
        }
      }
    }
  }

  _onWheel(e) {
    if (this.locked) e.preventDefault();
    const action = this.settings.actionFor(e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
    if (action) {
      this.pressed.add(action);
      if (action === 'nextWeapon') this.wheelDelta += 1;
      else if (action === 'previousWeapon') this.wheelDelta -= 1;
    }
  }

  _actionHeld(action) {
    for (const code of this.codes) if (this.settings.actionFor(code) === action) return true;
    for (let button = 0; button < this.buttons.length; button += 1) {
      if (this.buttons[button] && this.settings.actionFor(mouseCode(button)) === action) return true;
    }
    return false;
  }

  // ---- query API ----
  isDown(action) { return this.enabled && this.actions.has(action); }
  wasPressed(action) { return this.enabled && this.pressed.has(action); }
  wasReleased(action) { return this.enabled && this.released.has(action); }
  isCode(code) { return this.codes.has(code); }
  get fire() { return this.isDown('fire'); }
  get aim() { return this.isDown('aim'); }
  get firePressed() { return this.wasPressed('fire'); }
  get aimPressed() { return this.wasPressed('aim'); }
  get aimReleased() { return this.wasReleased('aim'); }

  /** Drain accumulated mouse movement. Returns raw pixels. */
  consumeLook(out = { x: 0, y: 0 }) {
    out.x = this.mouseDX;
    out.y = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return out;
  }

  consumeWheel() { const w = this.wheelDelta; this.wheelDelta = 0; return w; }

  /** Called at the very end of each rendered frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.buttonsPressed.fill(false);
    this.buttonsReleased.fill(false);
  }

  dispose() {
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
    this.canvas.removeEventListener('contextmenu', this._onContext);
    this.canvas.removeEventListener('mousedown', this._onCanvasDown);
    this._settleLock();
  }
}
