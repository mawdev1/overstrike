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
  filmGrain: 1,
  motionBlur: false,
  vignette: true,
  maxFps: 0,                 // 0 = uncapped
  showFps: true,
  brightness: 1,
  cameraShake: 1,
  viewBob: 0.6,
  weaponSway: 1,
  flashIntensity: 1,
  screenEffectIntensity: 1,
  // audio
  masterVolume: 0.8,
  sfxVolume: 1.0,
  musicVolume: 0.45,
  uiVolume: 0.8,
  announcerVolume: 1,
  subtitles: true,
  closedCaptions: false,
  subtitleSize: 'default',
  captionBackground: 0.75,
  captionDirection: true,
  // hud
  crosshairStyle: 'dynamic', // 'dynamic' | 'static' | 'dot'
  crosshairColor: '#8ef7c4',
  crosshairOpacity: 1,
  crosshairSize: 1,
  crosshairThickness: 2,
  crosshairGap: 6,
  crosshairOutline: true,
  showMinimap: true,
  showDamageNumbers: true,
  hudScale: 1.0,
  hudTextSize: 'default',
  minimapRotation: 'playerUp',
  showKillfeed: true,
  showObjectiveMarkers: 'full',
  damageVignette: 'full',
  colorVisionPreset: 'default',
  reduceMotion: false,
  networkDiagnosticsOverlay: 'off',
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
    KeyX: 'inspect', KeyB: 'killstreak', KeyH: 'drop',
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
    if (k === 'binds') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        console.warn('[settings] rejected invalid value for "binds":', v);
        return;
      }
      // A wholesale binds write wins for every code and every action it names — but it must
      // not silently UNBIND actions it does not govern. The shell settings bridge rebuilds
      // this map from its own action inventory on every game creation, and actions that
      // inventory does not yet carry (e.g. the raid HUD's 'drop', pending the roaming
      // keybind vocabulary) would otherwise lose their key each time a game starts.
      const incomingActions = new Set(Object.values(v));
      const merged = { ...v };
      for (const [code, action] of Object.entries(this.data.binds)) {
        if (!incomingActions.has(action) && !(code in merged)) merged[code] = action;
      }
      v = merged;
    }
    if (this.data[k] === v) return;
    this.data[k] = v;
    this.save();
    for (const fn of this.listeners) { try { fn(k, v); } catch (e) { console.error(e); } }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  actionFor(code) { return this.data.binds[code]; }

  /**
   * Short display label for the first key bound to `action` ('E', 'H', 'Mouse2'), or null when
   * unbound. This is what HUD hints render — `src/ui/raid/local.js` was already calling it
   * optioned (`keyForAction?.`) and silently falling back to a hardcoded key.
   */
  keyForAction(action) {
    for (const [code, bound] of Object.entries(this.data.binds)) {
      if (bound === action) return code.replace(/^(Key|Digit)/, '');
    }
    return null;
  }

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
    uiVolume: [0, 1], announcerVolume: [0, 1], brightness: [0.8, 1.2],
    cameraShake: [0, 1], viewBob: [0, 1], weaponSway: [0, 1], filmGrain: [0, 1],
    flashIntensity: [0, 1], screenEffectIntensity: [0, 1], captionBackground: [0.4, 1],
    crosshairOpacity: [0.3, 1], crosshairSize: [0.5, 2],
    crosshairThickness: [1, 6], crosshairGap: [0, 20],
    hudScale: [0.6, 2], botCount: [0, 24],
  };

  static ENUMS = {
    shadowQuality: ['off', 'low', 'high'],
    crosshairStyle: ['dynamic', 'static', 'dot'],
    subtitleSize: ['small', 'default', 'large', 'extraLarge'],
    hudTextSize: ['small', 'default', 'large', 'extraLarge'],
    minimapRotation: ['northUp', 'playerUp'],
    showObjectiveMarkers: ['minimal', 'full'],
    damageVignette: ['off', 'low', 'full'],
    colorVisionPreset: ['default', 'deuteranopia', 'protanopia', 'tritanopia'],
    networkDiagnosticsOverlay: ['off', 'compact', 'full'],
    difficulty: ['recruit', 'regular', 'hardened', 'veteran'],
    mode: ['tdm', 'bomb', 'extraction'],
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
