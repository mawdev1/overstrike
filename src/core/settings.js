const KEY = 'overstrike.settings.v1';

export const DEFAULTS = {
  // input
  sensitivity: 0.9,          // multiplier
  adsSensitivity: 0.75,      // multiplier applied on top while aiming
  invertY: false,
  toggleAds: false,
  toggleCrouch: false,
  autoSprint: false,
  // video
  fov: 85,
  renderScale: 1.0,          // 0.5 .. 1.0
  shadows: true,
  shadowQuality: 'high',     // 'off' | 'low' | 'high'
  postFx: true,
  filmGrain: true,
  motionBlur: false,
  vignette: true,
  maxFps: 0,                 // 0 = uncapped
  showFps: true,
  // audio
  masterVolume: 0.8,
  sfxVolume: 1.0,
  musicVolume: 0.45,
  // hud
  crosshairStyle: 'dynamic', // 'dynamic' | 'static' | 'dot'
  crosshairColor: '#8ef7c4',
  showMinimap: true,
  showDamageNumbers: true,
  hudScale: 1.0,
  // gameplay
  difficulty: 'regular',     // 'recruit' | 'regular' | 'hardened' | 'veteran'
  botCount: 7,
  mode: 'tdm',
  loadoutPrimary: 'ar_vector',
  loadoutSecondary: 'pistol_sidewinder',
  // keybinds — code -> action
  binds: {
    KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right',
    Space: 'jump', ShiftLeft: 'sprint', ControlLeft: 'crouch', KeyC: 'crouch',
    KeyR: 'reload', KeyF: 'melee', KeyG: 'grenade', KeyQ: 'lean',
    KeyE: 'interact', Tab: 'scoreboard', KeyV: 'lastWeapon',
    Digit1: 'weapon1', Digit2: 'weapon2', Digit3: 'weapon3',
    KeyX: 'inspect', KeyB: 'killstreak',
  },
};

/**
 * Is there a usable Web Storage implementation?
 *
 * Checks the METHOD, not the global. Node defines `localStorage` as an object whose
 * accessors throw or are absent without `--localstorage-file`, so `typeof localStorage
 * !== 'undefined'` passes and the call then fails — which is why a headless boot warned
 * about unreadable settings it had simply never written.
 */
function hasStorage() {
  try {
    return typeof localStorage !== 'undefined'
      && typeof localStorage.getItem === 'function'
      && typeof localStorage.setItem === 'function';
  } catch { return false; }
}

export class Settings {
  constructor() {
    this.data = structuredClone(DEFAULTS);
    this.listeners = new Set();
    this.load();
  }

  get(k) { return this.data[k]; }

  set(k, v) {
    if (k in DEFAULTS && k !== 'binds') {
      const coerced = this._coerce(k, v);
      if (coerced === undefined) {
        console.warn(`[settings] rejected invalid value for "${k}":`, v);
        return;
      }
      v = coerced;
    }
    if (this.data[k] === v) return;
    this.data[k] = v;
    this.save();
    for (const fn of this.listeners) { try { fn(k, v); } catch (e) { console.error(e); } }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  actionFor(code) { return this.data.binds[code]; }

  rebind(code, action) {
    // Remove any existing binding of this action to keep the map single-purpose.
    for (const [c, a] of Object.entries(this.data.binds)) {
      if (a === action && c !== code) delete this.data.binds[c];
    }
    this.data.binds[code] = action;
    this.save();
  }

  reset() {
    this.data = structuredClone(DEFAULTS);
    this.save();
    for (const fn of this.listeners) { try { fn('*', null); } catch (e) { console.error(e); } }
  }

  /**
   * Numeric settings that must stay inside a range. A value outside it (or of the
   * wrong type) is discarded rather than clamped-and-kept, so a corrupt store can
   * never leave the game in a state the UI has no way to express.
   */
  static RANGES = {
    sensitivity: [0.05, 10], adsSensitivity: [0.05, 4],
    fov: [60, 120], renderScale: [0.4, 1], maxFps: [0, 480],
    masterVolume: [0, 1], sfxVolume: [0, 1], musicVolume: [0, 1],
    hudScale: [0.6, 2], botCount: [0, 24],
  };

  static ENUMS = {
    shadowQuality: ['off', 'low', 'high'],
    crosshairStyle: ['dynamic', 'static', 'dot'],
    difficulty: ['recruit', 'regular', 'hardened', 'veteran'],
    mode: ['tdm', 'bomb'],
  };

  /**
   * localStorage is untrusted input: another tab, an older build, or a user poking at
   * devtools can put anything in it. Validating each key against the shape of its
   * default is the difference between "settings reset" and an unplayable game — a
   * string `botCount` yields an empty match, and a null `fov` yields a NaN projection
   * matrix that renders nothing at all.
   */
  _coerce(key, value) {
    const def = DEFAULTS[key];
    if (typeof def === 'boolean') return typeof value === 'boolean' ? value : undefined;
    if (typeof def === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      const r = Settings.RANGES[key];
      if (r && (value < r[0] || value > r[1])) return undefined;
      return value;
    }
    if (typeof def === 'string') {
      if (typeof value !== 'string') return undefined;
      const allowed = Settings.ENUMS[key];
      if (allowed && !allowed.includes(value)) return undefined;
      return value;
    }
    return undefined;
  }

  load() {
    // Absence of storage is not an error, so it must not warn. `typeof localStorage` is
    // not the right test: Node exposes the global while its methods are missing unless
    // started with --localstorage-file, so a server booted every match with a stack
    // trace about "unreadable settings" that were simply never there.
    if (!hasStorage()) return;
    let parsed;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('[settings] stored settings were unreadable, using defaults', e);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    let rejected = 0;
    for (const k of Object.keys(DEFAULTS)) {
      if (k === 'binds' || parsed[k] === undefined) continue;
      const v = this._coerce(k, parsed[k]);
      if (v === undefined) { rejected++; continue; }
      this.data[k] = v;
    }

    if (parsed.binds && typeof parsed.binds === 'object' && !Array.isArray(parsed.binds)) {
      const binds = { ...DEFAULTS.binds };
      for (const [code, action] of Object.entries(parsed.binds)) {
        if (typeof code === 'string' && typeof action === 'string' && code && action) binds[code] = action;
        else rejected++;
      }
      this.data.binds = binds;
    }

    if (rejected) console.warn(`[settings] discarded ${rejected} invalid stored value(s)`);
  }

  save() {
    if (!hasStorage()) return;
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }
}
