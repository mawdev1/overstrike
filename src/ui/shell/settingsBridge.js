/**
 * The shell⇄game settings bridge, declared ONCE in both directions.
 *
 * This was a one-way table: shell snapshot → `game.settings`, applied on every game creation.
 * The in-game pause menu writes to `game.settings`, which persists to localStorage and nowhere
 * else — so every change a player made there was overwritten from the shell snapshot the next
 * time they entered a match or practice, and never reached their account at all. Reported as
 * "my settings aren't being saved", which is exactly what it looked like from the outside.
 *
 * The fix needs the inverse of ~60 entries, a third of which are scaled (÷100) or enum⇄boolean.
 * Writing that inverse out by hand is how the two halves drift, and a wrong transform here does
 * not throw — it silently rescales a player's sensitivity. So each key declares its pair, or
 * nothing at all when it is a straight copy, and both directions are generated from this table.
 */
export const PERCENT = { toGame: (v) => Number(v) / 100, toShell: (v) => Math.round(Number(v) * 100) };
export const SETTING_BRIDGE = Object.freeze({
  sensitivity: {}, adsSensitivity: {}, invertY: {}, autoSprint: {}, fov: {},
  toggleAds: { toGame: (v) => v === 'toggle', toShell: (v) => (v ? 'toggle' : 'hold') },
  toggleCrouch: { toGame: (v) => v === 'toggle', toShell: (v) => (v ? 'toggle' : 'hold') },
  renderScale: PERCENT,
  shadows: {}, shadowQuality: {}, postFx: {},
  filmGrain: PERCENT,
  motionBlur: {}, vignette: {},
  maxFps: {
    toGame: (v) => (v === 'off' ? 0 : Number(v)),
    toShell: (v) => (Number(v) > 0 ? String(v) : 'off'),
  },
  showFps: {},
  masterVolume: PERCENT, sfxVolume: PERCENT, musicVolume: PERCENT,
  uiVolume: PERCENT, announcerVolume: PERCENT,
  subtitles: {}, closedCaptions: {}, subtitleSize: {},
  captionBackground: PERCENT,
  captionDirection: {},
  cameraShake: PERCENT, viewBob: PERCENT, weaponSway: PERCENT,
  flashIntensity: PERCENT, screenEffectIntensity: PERCENT,
  crosshairStyle: {}, crosshairColor: {},
  crosshairOpacity: PERCENT, crosshairSize: PERCENT,
  crosshairThickness: {}, crosshairGap: {}, crosshairOutline: {},
  showMinimap: {}, showDamageNumbers: {},
  hudScale: PERCENT,
  hudTextSize: {}, minimapRotation: {}, showKillfeed: {}, showObjectiveMarkers: {},
  damageVignette: {}, colorVisionPreset: {}, reduceMotion: {}, networkDiagnosticsOverlay: {},
  brightness: PERCENT,
  difficulty: {}, botCount: {}, killLimit: {},
  // Read is feature-gated — an unshipped mode must not load even if the stored value names it.
  // The WRITE is not: the player chose it, and gating the write would silently discard a
  // selection the UI had already accepted.
  // No transform: the feature gate lives with the feature flags, in `configureGameFromSettings`.
  // Putting it here would make this table impure and untestable for the one entry most likely
  // to be got wrong.
  mode: {},
});

const identity = (v) => v;

/** Shell value → the form `game.settings` stores. */
export function toGameValue(key, value) {
  return (SETTING_BRIDGE[key]?.toGame ?? identity)(value);
}

/** `game.settings` value → the form the shell (and the player's account) stores. */
export function toShellValue(key, value) {
  return (SETTING_BRIDGE[key]?.toShell ?? identity)(value);
}

/** Every key the two systems share, so neither side has to restate the list. */
export const BRIDGED_KEYS = Object.freeze(Object.keys(SETTING_BRIDGE));
