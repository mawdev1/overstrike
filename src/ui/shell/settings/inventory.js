export const LOCAL_SETTINGS_SCHEMA_VERSION = 2;
export const ROAMING_SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_SCHEMA_VERSION = LOCAL_SETTINGS_SCHEMA_VERSION;

export const SETTINGS_SCOPES = Object.freeze({
  ROAM: Object.freeze({ id: 'ROAM', label: 'Saved to account', persisted: true }),
  DEVICE: Object.freeze({ id: 'DEVICE', label: 'This device', persisted: true }),
  SESSION: Object.freeze({ id: 'SESSION', label: 'This session', persisted: false }),
  PRACTICE: Object.freeze({ id: 'PRACTICE', label: 'Practice only', persisted: true }),
});

export const SETTINGS_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'input', label: 'Input', description: 'Look, movement, and camera response.' }),
  Object.freeze({ id: 'bindings', label: 'Bindings', description: 'Keyboard and mouse controls.' }),
  Object.freeze({ id: 'graphics', label: 'Graphics', description: 'Visual quality and display effects.' }),
  Object.freeze({ id: 'audioCaptions', label: 'Audio & captions', description: 'Mix, subtitles, and directional captions.' }),
  Object.freeze({ id: 'crosshairHud', label: 'Crosshair & HUD', description: 'Reticle, HUD, and combat feedback.' }),
  Object.freeze({ id: 'accessibility', label: 'Accessibility', description: 'Motion, text, and color assistance.' }),
  Object.freeze({ id: 'network', label: 'Network', description: 'Diagnostics display and connection information.' }),
]);

const number = (key, category, scope, label, min, max, step, defaultValue, extra = {}) =>
  Object.freeze({ key, category, scope, label, type: 'number', min, max, step, defaultValue, ...extra });
const bool = (key, category, scope, label, defaultValue, extra = {}) =>
  Object.freeze({ key, category, scope, label, type: 'boolean', defaultValue, ...extra });
const choice = (key, category, scope, label, options, defaultValue, extra = {}) =>
  Object.freeze({ key, category, scope, label, type: 'enum', options: Object.freeze(options), defaultValue, ...extra });

export const SETTINGS_INVENTORY = Object.freeze([
  number('sensitivity', 'input', 'ROAM', 'Mouse sensitivity', 0.05, 10, 0.01, 0.9, { unit: '×', synonyms: ['mouse', 'look speed'] }),
  number('adsSensitivity', 'input', 'ROAM', 'Aim-down-sights sensitivity', 0.05, 4, 0.01, 0.75, { unit: '×', synonyms: ['ads', 'scope'] }),
  bool('invertY', 'input', 'ROAM', 'Invert vertical look', false, { synonyms: ['invert y', 'mouse'] }),
  choice('toggleAds', 'input', 'ROAM', 'Aim behavior', ['hold', 'toggle'], 'hold', { synonyms: ['ads'] }),
  choice('toggleCrouch', 'input', 'ROAM', 'Crouch behavior', ['hold', 'toggle'], 'hold'),
  bool('autoSprint', 'input', 'ROAM', 'Automatic sprint', false),
  number('fov', 'input', 'ROAM', 'Field of view', 60, 120, 1, 85, { unit: '°', synonyms: ['fov'] }),
  number('cameraShake', 'input', 'ROAM', 'Camera shake', 0, 100, 5, 100, { unit: '%' }),
  number('viewBob', 'input', 'ROAM', 'View bob', 0, 100, 5, 60, { unit: '%' }),
  number('weaponSway', 'input', 'ROAM', 'Weapon sway', 0, 100, 5, 100, { unit: '%' }),

  number('renderScale', 'graphics', 'DEVICE', 'Render scale', 40, 100, 5, 100, { unit: '%' }),
  bool('shadows', 'graphics', 'DEVICE', 'Shadows', true),
  choice('shadowQuality', 'graphics', 'DEVICE', 'Shadow quality', ['off', 'low', 'high'], 'high', { enabledWhen: { key: 'shadows', equals: true } }),
  bool('postFx', 'graphics', 'DEVICE', 'Post-processing effects', true, { synonyms: ['post fx'] }),
  number('filmGrain', 'graphics', 'DEVICE', 'Film grain', 0, 100, 10, 100, { unit: '%' }),
  bool('motionBlur', 'graphics', 'DEVICE', 'Motion blur', false),
  bool('vignette', 'graphics', 'DEVICE', 'Vignette', true),
  choice('maxFps', 'graphics', 'DEVICE', 'Frame-rate limit', ['off', '60', '75', '120', '144', '165', '240'], 'off', { unit: 'fps', synonyms: ['fps', 'frame rate'] }),
  bool('showFps', 'graphics', 'DEVICE', 'Show frame rate', false, { synonyms: ['fps counter'] }),
  number('brightness', 'graphics', 'DEVICE', 'Brightness', 80, 120, 1, 100, { unit: '%' }),
  number('flashIntensity', 'graphics', 'ROAM', 'Flash intensity', 0, 100, 10, 100, { unit: '%', synonyms: ['flashing'] }),
  number('screenEffectIntensity', 'graphics', 'ROAM', 'Screen-effect intensity', 0, 100, 10, 100, { unit: '%' }),

  number('masterVolume', 'audioCaptions', 'DEVICE', 'Master volume', 0, 100, 1, 80, { unit: '%' }),
  number('sfxVolume', 'audioCaptions', 'DEVICE', 'Sound-effects volume', 0, 100, 1, 100, { unit: '%', synonyms: ['sfx'] }),
  number('musicVolume', 'audioCaptions', 'DEVICE', 'Music volume', 0, 100, 1, 45, { unit: '%' }),
  number('uiVolume', 'audioCaptions', 'DEVICE', 'Interface volume', 0, 100, 1, 80, { unit: '%', synonyms: ['ui'] }),
  number('announcerVolume', 'audioCaptions', 'DEVICE', 'Announcer volume', 0, 100, 1, 100, { unit: '%' }),
  bool('subtitles', 'audioCaptions', 'ROAM', 'Subtitles', true),
  bool('closedCaptions', 'audioCaptions', 'ROAM', 'Closed captions', false, { synonyms: ['sound descriptions'] }),
  choice('subtitleSize', 'audioCaptions', 'ROAM', 'Subtitle size', ['small', 'default', 'large', 'extraLarge'], 'default'),
  number('captionBackground', 'audioCaptions', 'ROAM', 'Caption background', 40, 100, 5, 75, { unit: '%', synonyms: ['subtitle background'] }),
  bool('captionDirection', 'audioCaptions', 'ROAM', 'Directional captions', true),

  choice('crosshairStyle', 'crosshairHud', 'ROAM', 'Crosshair style', ['dynamic', 'static', 'dot'], 'dynamic', { synonyms: ['reticle'] }),
  Object.freeze({ key: 'crosshairColor', category: 'crosshairHud', scope: 'ROAM', label: 'Crosshair color', type: 'color', defaultValue: '#8EF7C4', synonyms: Object.freeze(['reticle color']) }),
  number('crosshairOpacity', 'crosshairHud', 'ROAM', 'Crosshair opacity', 30, 100, 5, 100, { unit: '%' }),
  number('crosshairSize', 'crosshairHud', 'ROAM', 'Crosshair size', 50, 200, 5, 100, { unit: '%' }),
  number('crosshairThickness', 'crosshairHud', 'ROAM', 'Crosshair thickness', 1, 6, 1, 2),
  number('crosshairGap', 'crosshairHud', 'ROAM', 'Crosshair gap', 0, 20, 1, 6),
  bool('crosshairOutline', 'crosshairHud', 'ROAM', 'Crosshair outline', true),
  number('hudScale', 'crosshairHud', 'ROAM', 'HUD scale', 70, 160, 5, 100, { unit: '%' }),
  choice('hudTextSize', 'crosshairHud', 'ROAM', 'HUD text size', ['small', 'default', 'large', 'extraLarge'], 'default'),
  bool('showMinimap', 'crosshairHud', 'ROAM', 'Show minimap', true),
  choice('minimapRotation', 'crosshairHud', 'ROAM', 'Minimap orientation', ['northUp', 'playerUp'], 'playerUp'),
  bool('showDamageNumbers', 'crosshairHud', 'ROAM', 'Show damage numbers', true),
  bool('showKillfeed', 'crosshairHud', 'ROAM', 'Show killfeed', true),
  choice('showObjectiveMarkers', 'crosshairHud', 'ROAM', 'Objective markers', ['minimal', 'full'], 'full'),
  choice('damageVignette', 'crosshairHud', 'ROAM', 'Damage vignette', ['off', 'low', 'full'], 'full'),

  choice('colorVisionPreset', 'accessibility', 'ROAM', 'Color-vision preset', ['default', 'deuteranopia', 'protanopia', 'tritanopia'], 'default', { synonyms: ['color blind', 'colour vision'] }),
  bool('reduceMotion', 'accessibility', 'ROAM', 'Reduce motion', false, { synonyms: ['animation', 'camera motion'] }),

  choice('networkDiagnosticsOverlay', 'network', 'DEVICE', 'Diagnostics overlay', ['off', 'compact', 'full'], 'off', { synonyms: ['ping', 'latency', 'packet loss'] }),

  choice('difficulty', 'input', 'PRACTICE', 'Practice bot difficulty', ['recruit', 'regular', 'hardened', 'veteran'], 'regular'),
  number('botCount', 'input', 'PRACTICE', 'Practice bot count', 0, 15, 1, 7, { synonyms: ['bots'] }),
  number('killLimit', 'input', 'PRACTICE', 'Practice kill limit', 5, 200, 5, 75, { synonyms: ['score limit'] }),
  choice('mode', 'input', 'PRACTICE', 'Practice mode', ['tdm'], 'tdm', { readOnly: true, synonyms: ['team deathmatch'] }),
]);

const action = (id, label, primary, secondary = null, extra = {}) =>
  Object.freeze({ id, label, primary, secondary, ...extra });

export const BINDING_ACTIONS = Object.freeze([
  action('forward', 'Move forward', 'KeyW', null, { required: true, synonyms: ['w', 'movement'] }),
  action('back', 'Move backward', 'KeyS', null, { required: true, synonyms: ['s', 'movement'] }),
  action('left', 'Move left', 'KeyA', null, { required: true, synonyms: ['a', 'strafe'] }),
  action('right', 'Move right', 'KeyD', null, { required: true, synonyms: ['d', 'strafe'] }),
  action('jump', 'Jump', 'Space'),
  action('sprint', 'Sprint', 'ShiftLeft'),
  action('crouch', 'Crouch', 'ControlLeft', 'KeyC'),
  action('lean', 'Lean', 'KeyQ'),
  action('fire', 'Fire', 'Mouse1', null, { required: true, synonyms: ['shoot'] }),
  action('aim', 'Aim down sights', 'Mouse2', null, { required: true, synonyms: ['ads', 'scope'] }),
  action('reload', 'Reload', 'KeyR'),
  action('melee', 'Melee', 'KeyF'),
  action('grenade', 'Grenade', 'KeyG'),
  action('tacticalEquipment', 'Tactical equipment', null),
  action('interact', 'Interact', 'KeyE', null, { required: true, synonyms: ['use'] }),
  action('weapon1', 'Weapon slot 1', 'Digit1'),
  action('weapon2', 'Weapon slot 2', 'Digit2'),
  action('weapon3', 'Weapon slot 3', 'Digit3'),
  action('nextWeapon', 'Next weapon', 'WheelDown'),
  action('previousWeapon', 'Previous weapon', 'WheelUp'),
  action('lastWeapon', 'Last weapon', 'KeyV'),
  action('killstreak', 'Killstreak', 'KeyB'),
  action('inspect', 'Inspect weapon', 'KeyX'),
  action('scoreboard', 'Scoreboard', 'Tab'),
  action('textChat', 'Text chat', 'Enter'),
  action('teamChat', 'Team chat', 'KeyY'),
  action('tacticalPing', 'Tactical ping', 'Mouse3'),
  action('muteCurrentTarget', 'Mute current target', null),
  action('spectatePrevious', 'Spectate previous', 'ArrowLeft'),
  action('spectateNext', 'Spectate next', 'ArrowRight'),
  action('pause', 'Pause / menu', 'Escape', null, { required: true, fixed: true, synonyms: ['escape', 'menu'] }),
]);

export const RESERVED_BINDING_CODES = Object.freeze(new Set([
  'Escape',
  'F5',
  'F11',
  'F12',
  'MetaLeft',
  'MetaRight',
]));

export const SETTINGS_BY_KEY = Object.freeze(Object.fromEntries(SETTINGS_INVENTORY.map((item) => [item.key, item])));
export const BINDINGS_BY_ID = Object.freeze(Object.fromEntries(BINDING_ACTIONS.map((item) => [item.id, item])));

export function defaultsForScope(scope) {
  return Object.fromEntries(
    SETTINGS_INVENTORY.filter((item) => item.scope === scope).map((item) => [item.key, item.defaultValue]),
  );
}

export function defaultBindings() {
  return Object.fromEntries(
    BINDING_ACTIONS.map((item) => [item.id, { primary: item.primary, secondary: item.secondary }]),
  );
}

export function validateSettingValue(definition, value) {
  if (!definition) return false;
  if (definition.type === 'boolean') return typeof value === 'boolean';
  if (definition.type === 'enum') return typeof value === 'string' && definition.options.includes(value);
  if (definition.type === 'color') return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  if (definition.type !== 'number' || typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (value < definition.min || value > definition.max) return false;
  const steps = (value - definition.min) / definition.step;
  return Math.abs(steps - Math.round(steps)) < 1e-7;
}

export function formatSettingValue(definition, value) {
  if (definition.type === 'boolean') return value ? 'On' : 'Off';
  if (definition.type === 'enum') {
    const labels = {
      extraLarge: 'Extra large',
      northUp: 'North up',
      playerUp: 'Player up',
      deuteranopia: 'Deuteranopia',
      protanopia: 'Protanopia',
      tritanopia: 'Tritanopia',
      tdm: 'Team deathmatch',
    };
    return labels[value] || String(value).replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  return `${value}${definition.unit || ''}`;
}

export function bindingCodeLabel(code) {
  if (!code) return 'Unbound';
  const aliases = {
    Space: 'Space',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    Mouse1: 'Mouse 1',
    Mouse2: 'Mouse 2',
    Mouse3: 'Mouse 3',
    Mouse4: 'Mouse 4',
    Mouse5: 'Mouse 5',
    WheelUp: 'Wheel up',
    WheelDown: 'Wheel down',
    ArrowLeft: 'Left Arrow',
    ArrowRight: 'Right Arrow',
    ArrowUp: 'Up Arrow',
    ArrowDown: 'Down Arrow',
    Escape: 'Escape',
    Enter: 'Enter',
    Tab: 'Tab',
  };
  if (aliases[code]) return aliases[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function isRecognizedBindingCode(code) {
  return typeof code === 'string' && (
    /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Left|Right|Up|Down))$/.test(code)
    || /^(Space|Enter|Tab|Backspace|Delete|Home|End|PageUp|PageDown|CapsLock|Escape)$/.test(code)
    || /^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code)
    || /^Mouse[1-5]$/.test(code)
    || /^Wheel(Up|Down)$/.test(code)
  );
}
