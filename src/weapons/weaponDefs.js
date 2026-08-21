/**
 * OVERSTRIKE — weapon data tables.
 *
 * Pure data. No imports, no side effects: every other weapon module reads these objects
 * and never mutates them (they are frozen at the bottom of the file).
 *
 * ---------------------------------------------------------------------------------
 * BALANCE MODEL (entity health = 100, no armour)
 *
 *   shots-to-kill  = ceil(100 / (damage * falloffMul(range)))
 *   time-to-kill   = (shotsToKill - 1) * (60 / rpm)          [+ burstDelay penalties]
 *
 * The whole roster is tuned around a 0.20 s .. 0.55 s TTK band. Nothing kills faster
 * than the battle rifle's 3-shot 0.200 s, and nothing that reaches that speed is
 * forgiving: the fast guns have small magazines, savage recoil or brutal falloff.
 *
 *   id                class   dmg   rpm   STK@10m  TTK@10m   STK@30m  TTK@30m
 *   ar_vector         ar       27   720      4      0.250       4      0.250
 *   ar_havoc          ar       36   600      3      0.200       3      0.200
 *   ar_falcon         ar       26   850      4      0.212       5      0.282
 *   smg_wasp          smg      23  1000      5      0.240      10      0.540
 *   smg_kestrel       smg      22   800      5      0.300       7      0.450
 *   lmg_bulwark       lmg      31   650      4      0.277       4      0.277
 *   sr_reaver         sniper  112    45      1      0.000       1      0.000
 *   dmr_meridian      sniper   55   200      2      0.300       2      0.300
 *   sg_breacher       shotgun 8x16   85      1*     0.000       -      never
 *   pistol_viper      pistol   28   420      4      0.429       5      0.571
 *
 *   * the shotgun one-shots inside ~8 m where 7+ of its 8 pellets land on a torso;
 *     by 16 m a full 8-pellet hit totals ~12 damage and it is a melee prop.
 *
 * ---------------------------------------------------------------------------------
 * RECOIL PATTERNS
 *
 * `recoil.pattern` is an array of NORMALISED `[side, up]` pairs, one per shot, that
 * loops. The instance multiplies them by `recoil.side` / `recoil.up` (both in DEGREES
 * of camera kick for that shot). Authoring in normalised space means a gun can be
 * re-tuned by touching two numbers without redrawing its 30-shot signature.
 *
 * Every pattern is deliberately LEARNABLE: a hard vertical climb for the first third,
 * then a lateral drift to one side, then a reversal, then back toward centre so the
 * loop point is not a discontinuity. Pull down-and-opposite and the gun goes flat.
 * ---------------------------------------------------------------------------------
 */

// ------------------------------------------------------------------ recoil patterns

/** VK-7 VECTOR — textbook: straight up, drift right, sweep left, recentre. */
const P_VECTOR = [
  [0.00, 1.00], [0.05, 0.98], [-0.04, 0.95], [0.08, 0.92], [0.02, 0.88],
  [0.12, 0.84], [0.18, 0.80], [0.26, 0.76], [0.34, 0.72], [0.42, 0.68],
  [0.50, 0.64], [0.56, 0.60], [0.60, 0.56], [0.62, 0.52], [0.60, 0.50],
  [0.54, 0.48], [0.44, 0.46], [0.30, 0.44], [0.14, 0.44], [-0.04, 0.44],
  [-0.22, 0.45], [-0.38, 0.46], [-0.50, 0.47], [-0.58, 0.48], [-0.60, 0.49],
  [-0.56, 0.50], [-0.46, 0.50], [-0.32, 0.50], [-0.16, 0.50], [0.00, 0.50],
];

/** MR-9 HAVOC — heavy battle rifle. Kicks up-LEFT hard, then swings right. */
const P_HAVOC = [
  [0.00, 1.00], [-0.10, 1.00], [-0.22, 0.96], [-0.34, 0.92], [-0.44, 0.88],
  [-0.52, 0.84], [-0.56, 0.82], [-0.56, 0.80], [-0.52, 0.78], [-0.44, 0.76],
  [-0.32, 0.74], [-0.18, 0.72], [-0.02, 0.72], [0.14, 0.72], [0.30, 0.72],
  [0.44, 0.72], [0.54, 0.72], [0.60, 0.72], [0.62, 0.72], [0.58, 0.72],
  [0.50, 0.72], [0.38, 0.72], [0.24, 0.72], [0.08, 0.72], [-0.08, 0.72],
  [-0.24, 0.72], [-0.38, 0.72], [-0.48, 0.72], [-0.52, 0.72], [-0.30, 0.74],
];

/** FN-99 FALCON — 850 rpm. Violent zig-zag opener, then a huge right hook. */
const P_FALCON = [
  [0.00, 1.00], [0.06, 1.00], [-0.08, 1.00], [0.14, 0.98], [-0.16, 0.96],
  [0.22, 0.94], [-0.20, 0.92], [0.30, 0.90], [0.40, 0.88], [0.52, 0.86],
  [0.64, 0.84], [0.74, 0.82], [0.82, 0.80], [0.86, 0.78], [0.84, 0.76],
  [0.76, 0.74], [0.62, 0.72], [0.44, 0.70], [0.24, 0.70], [0.02, 0.70],
  [-0.20, 0.70], [-0.42, 0.70], [-0.60, 0.70], [-0.72, 0.70], [-0.78, 0.70],
  [-0.74, 0.70], [-0.62, 0.70], [-0.44, 0.70], [-0.22, 0.70], [0.00, 0.70],
];

/** MP-9 WASP — 1000 rpm. Chatters left/right early then rips right and back. */
const P_WASP = [
  [0.00, 1.00], [-0.12, 0.96], [0.16, 0.92], [-0.20, 0.88], [0.26, 0.84],
  [-0.28, 0.80], [0.34, 0.78], [0.44, 0.76], [0.54, 0.74], [0.62, 0.72],
  [0.68, 0.70], [0.70, 0.68], [0.66, 0.66], [0.56, 0.64], [0.42, 0.62],
  [0.24, 0.60], [0.04, 0.58], [-0.16, 0.58], [-0.36, 0.58], [-0.54, 0.58],
  [-0.68, 0.58], [-0.76, 0.58], [-0.78, 0.58], [-0.72, 0.58], [-0.60, 0.58],
  [-0.44, 0.58], [-0.26, 0.58], [-0.08, 0.58], [0.10, 0.58], [0.24, 0.60],
];

/** K-6 KESTREL — the tamest automatic in the game. Gentle right, gentle left. */
const P_KESTREL = [
  [0.00, 1.00], [0.02, 0.94], [0.06, 0.88], [0.10, 0.82], [0.14, 0.78],
  [0.20, 0.74], [0.26, 0.70], [0.32, 0.66], [0.38, 0.62], [0.42, 0.58],
  [0.46, 0.56], [0.48, 0.54], [0.48, 0.52], [0.46, 0.50], [0.42, 0.48],
  [0.36, 0.46], [0.28, 0.46], [0.18, 0.46], [0.08, 0.46], [-0.02, 0.46],
  [-0.12, 0.46], [-0.22, 0.46], [-0.30, 0.46], [-0.36, 0.46], [-0.40, 0.46],
  [-0.40, 0.46], [-0.36, 0.46], [-0.28, 0.46], [-0.18, 0.46], [-0.08, 0.46],
];

/** M250 BULWARK — brutal for a dozen rounds, then it lies down and hoses. */
const P_BULWARK = [
  [0.00, 1.00], [-0.06, 1.00], [0.10, 0.98], [-0.14, 0.94], [0.18, 0.88],
  [-0.22, 0.82], [0.26, 0.74], [-0.24, 0.66], [0.22, 0.58], [-0.18, 0.50],
  [0.14, 0.44], [-0.10, 0.38], [0.08, 0.34], [-0.06, 0.30], [0.06, 0.28],
  [-0.04, 0.26], [0.04, 0.24], [-0.02, 0.23], [0.02, 0.22], [0.00, 0.21],
  [0.02, 0.20], [0.04, 0.20], [0.06, 0.19], [0.08, 0.19], [0.10, 0.18],
  [0.10, 0.18], [0.08, 0.18], [0.06, 0.18], [0.04, 0.18], [0.02, 0.18],
];

/** AX-70 REAVER — bolt gun. Every shot is a fresh mountain; the loop barely matters. */
const P_REAVER = [
  [0.00, 1.00], [0.12, 0.98], [-0.14, 1.00], [0.10, 0.96], [-0.10, 0.98],
  [0.16, 1.00], [-0.16, 0.96], [0.08, 0.98], [-0.08, 1.00], [0.14, 0.96],
  [-0.12, 0.98], [0.06, 1.00], [-0.06, 0.96], [0.18, 0.98], [-0.18, 1.00],
  [0.10, 0.96], [-0.10, 0.98], [0.12, 1.00], [-0.14, 0.96], [0.08, 0.98],
  [-0.08, 1.00], [0.16, 0.96], [-0.16, 0.98], [0.06, 1.00], [-0.06, 0.96],
  [0.14, 0.98], [-0.12, 1.00], [0.10, 0.96], [-0.10, 0.98], [0.00, 1.00],
];

/** SVK MERIDIAN — semi-auto marksman. Consistent up-right so double-taps track. */
const P_MERIDIAN = [
  [0.00, 1.00], [0.14, 0.96], [0.22, 0.92], [0.28, 0.90], [0.32, 0.88],
  [0.34, 0.86], [0.34, 0.86], [0.32, 0.86], [0.28, 0.86], [0.22, 0.86],
  [0.14, 0.86], [0.06, 0.86], [-0.04, 0.86], [-0.14, 0.86], [-0.22, 0.86],
  [-0.28, 0.86], [-0.32, 0.86], [-0.34, 0.86], [-0.34, 0.86], [-0.30, 0.86],
  [-0.24, 0.86], [-0.16, 0.86], [-0.08, 0.86], [0.00, 0.86], [0.08, 0.86],
  [0.16, 0.86], [0.24, 0.86], [0.30, 0.88], [0.32, 0.90], [0.20, 0.94],
];

/** TX-12 BREACHER — pump. Enormous single kick, alternating shoulder roll. */
const P_BREACHER = [
  [0.00, 1.00], [-0.20, 1.00], [0.24, 0.98], [-0.26, 1.00], [0.28, 0.96],
  [-0.22, 1.00], [0.20, 0.98], [-0.24, 0.96], [0.26, 1.00], [-0.28, 0.98],
  [0.22, 0.96], [-0.20, 1.00], [0.24, 0.98], [-0.26, 0.96], [0.28, 1.00],
  [-0.22, 0.98], [0.20, 0.96], [-0.24, 1.00], [0.26, 0.98], [-0.28, 0.96],
  [0.22, 1.00], [-0.20, 0.98], [0.24, 0.96], [-0.26, 1.00], [0.28, 0.98],
  [-0.22, 0.96], [0.20, 1.00], [-0.24, 0.98], [0.26, 0.96], [0.00, 1.00],
];

/** P-11 VIPER — light and predictable; rewards a fast trigger finger. */
const P_VIPER = [
  [0.00, 1.00], [0.06, 0.92], [0.12, 0.86], [0.18, 0.80], [0.22, 0.76],
  [0.26, 0.72], [0.28, 0.70], [0.28, 0.68], [0.26, 0.66], [0.22, 0.64],
  [0.16, 0.62], [0.10, 0.62], [0.02, 0.62], [-0.06, 0.62], [-0.14, 0.62],
  [-0.20, 0.62], [-0.24, 0.62], [-0.26, 0.62], [-0.26, 0.62], [-0.22, 0.62],
  [-0.16, 0.62], [-0.10, 0.62], [-0.02, 0.62], [0.06, 0.62], [0.12, 0.64],
  [0.18, 0.66], [0.22, 0.68], [0.24, 0.72], [0.22, 0.80], [0.12, 0.90],
];

// ------------------------------------------------------------------ the arsenal
//
// The `viewmodel` block is consumed by `viewmodel.js`. Note that firearms no longer
// carry a `hipPos`: the rest pose is COMPUTED from the built model's bounds so that
// every gun sits the same distance below the crosshair and none of them clip the
// bottom of the frame. Use `hipBias` / `frame` to nudge that result, `hipRot` for the
// resting cant.

/** @type {Object.<string, object>} */
export const WEAPONS = {

  // =============================================================== ASSAULT RIFLES

  ar_vector: {
    id: 'ar_vector', name: 'VK-7 VECTOR', shortName: 'VECTOR', class: 'ar',
    desc: '5.56 workhorse. No weakness, no gimmick. Four rounds centre mass, every range.',
    slot: 'primary',
    damage: 27, rpm: 720, magSize: 30, reserve: 210,
    fireMode: 'auto', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 2.4, spreadAds: 0.20,
    spreadMoveMul: 1.4, spreadAirMul: 2.8, spreadCrouchMul: 0.72,
    bloomPerShot: 0.16, bloomMax: 1.9, bloomRecovery: 3.2, bloomAdsMul: 0.55,
    recoil: {
      up: 0.52, side: 0.30, kick: 0.055, recovery: 7.5,
      resetTime: 0.34, returnAmount: 0.62, pattern: P_VECTOR,
    },
    adsTime: 0.24, adsFov: 54, adsSpeedMul: 0.62,
    reloadTime: 2.05, reloadEmptyTime: 2.62, switchTime: 0.55, raiseTime: 0.42,
    range: 140, falloffStart: 34, falloffEnd: 68, falloffMin: 0.70,
    penetration: 0.45,
    headshotMul: 3.3,
    moveSpeedMul: 0.95,
    tracerEvery: 2, tracerColor: 0xffd08a,
    audio: { fire: 'rifle', reload: 'magIn', tail: 'indoor' },
    unlockLevel: 1,
    /** Black-rifle carbine: anodised receiver, M-LOK polymer handguard, buffer-tube stock. */
    viewmodel: {
      hipRot: [0.015, -0.030, 0.020], adsDepth: -0.335, vmFovAds: 54,
      body: { mat: 'gunmetal', len: 0.30, h: 0.076, w: 0.052 },
      upper: { mat: 'gunmetal', len: 0.34, h: 0.030, w: 0.044, railSlots: 7 },
      handguard: { mat: 'gunPolymer', len: 0.23, h: 0.056, w: 0.048, railSlots: 6, vents: 2 },
      hgStyle: 'mlok',
      barrel: { mat: 'gunmetal', len: 0.20, r: 0.0105 },
      muzzle: { type: 'brake', len: 0.055, r: 0.018 },
      stock: { type: 'carbine', mat: 'gunPolymer', len: 0.200, h: 0.070, drop: 0.006 },
      grip: { mat: 'rubber', len: 0.115, angle: 0.38 },
      mag: { type: 'curved', mat: 'gunPolymer', len: 0.175, w: 0.028, d: 0.056, curve: 0.16 },
      optic: { type: 'reddot', mat: 'gunmetal', height: 0.052, len: 0.076, w: 0.038, reticle: 'dot' },
      charging: { side: 'right', len: 0.058 },
      accentMat: 'brass', padMat: 'rubber',
      foregrip: true, bipod: false, sling: true,
      ejectSide: 1, boltThrow: 0.030, shell: 'rifle',
    },
  },

  ar_havoc: {
    id: 'ar_havoc', name: 'MR-9 HAVOC', shortName: 'HAVOC', class: 'ar',
    desc: '7.62 battle rifle. Three-round kill at any range you can see — if you can hold it.',
    slot: 'primary',
    damage: 36, rpm: 600, magSize: 20, reserve: 140,
    fireMode: 'auto', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 3.1, spreadAds: 0.18,
    spreadMoveMul: 1.35, spreadAirMul: 3.2, spreadCrouchMul: 0.68,
    bloomPerShot: 0.30, bloomMax: 2.6, bloomRecovery: 2.6, bloomAdsMul: 0.6,
    recoil: {
      up: 0.86, side: 0.44, kick: 0.086, recovery: 6.2,
      resetTime: 0.38, returnAmount: 0.55, pattern: P_HAVOC,
    },
    adsTime: 0.29, adsFov: 50, adsSpeedMul: 0.56,
    reloadTime: 2.45, reloadEmptyTime: 3.05, switchTime: 0.62, raiseTime: 0.50,
    range: 175, falloffStart: 40, falloffEnd: 85, falloffMin: 0.72,
    penetration: 0.62,
    headshotMul: 2.6,
    moveSpeedMul: 0.90,
    tracerEvery: 1, tracerColor: 0xffc070,
    audio: { fire: 'rifle', reload: 'magIn', tail: 'outdoor' },
    unlockLevel: 6,
    /** Full FDE furniture over a steel barrel — the loudest silhouette in the roster. */
    viewmodel: {
      hipRot: [0.02, -0.028, 0.018], adsDepth: -0.35, vmFovAds: 50,
      body: { mat: 'gunTan', len: 0.34, h: 0.084, w: 0.056 },
      upper: { mat: 'gunTan', len: 0.36, h: 0.034, w: 0.048, railSlots: 9 },
      handguard: { mat: 'gunTan', len: 0.26, h: 0.062, w: 0.054, railSlots: 4, vents: 0 },
      hgStyle: 'quad',
      barrel: { mat: 'gunmetal', len: 0.26, r: 0.0125 },
      muzzle: { type: 'flash', len: 0.062, r: 0.020 },
      stock: { type: 'fixed', mat: 'gunTan', len: 0.235, h: 0.082, drop: 0.008 },
      grip: { mat: 'rubber', len: 0.122, angle: 0.34 },
      mag: { type: 'curved', mat: 'gunmetal', len: 0.20, w: 0.030, d: 0.062, curve: 0.22 },
      optic: { type: 'holo', mat: 'gunmetal', height: 0.060, len: 0.096, w: 0.048, reticle: 'ring' },
      charging: { side: 'left', len: 0.062 },
      accentMat: 'brass', metalMat: 'gunmetal',
      foregrip: false, bipod: false, sling: true, kickMul: 1.15,
      ejectSide: 1, boltThrow: 0.038, shell: 'rifle',
    },
  },

  ar_falcon: {
    id: 'ar_falcon', name: 'FN-99 FALCON', shortName: 'FALCON', class: 'ar',
    desc: '850 rpm bullpup. Wins every close duel it survives the first half-second of.',
    slot: 'primary',
    damage: 26, rpm: 850, magSize: 30, reserve: 210,
    fireMode: 'auto', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 2.7, spreadAds: 0.26,
    spreadMoveMul: 1.35, spreadAirMul: 2.6, spreadCrouchMul: 0.75,
    bloomPerShot: 0.20, bloomMax: 2.3, bloomRecovery: 3.6, bloomAdsMul: 0.6,
    recoil: {
      up: 0.66, side: 0.46, kick: 0.062, recovery: 8.4,
      resetTime: 0.30, returnAmount: 0.60, pattern: P_FALCON,
    },
    adsTime: 0.22, adsFov: 55, adsSpeedMul: 0.66,
    reloadTime: 2.20, reloadEmptyTime: 2.85, switchTime: 0.52, raiseTime: 0.40,
    range: 130, falloffStart: 22, falloffEnd: 54, falloffMin: 0.62,
    penetration: 0.35,
    headshotMul: 3.4,
    moveSpeedMul: 0.96,
    tracerEvery: 3, tracerColor: 0x9fe0ff,
    audio: { fire: 'rifle', reload: 'magIn', tail: 'indoor' },
    unlockLevel: 12,
    /** Bullpup: mag behind the grip, ribbed polymer shell, tan magazine, laser module. */
    viewmodel: {
      hipRot: [0.01, -0.034, 0.022], adsDepth: -0.32, vmFovAds: 55,
      body: { mat: 'gunPolymer', len: 0.40, h: 0.090, w: 0.050 },
      upper: { mat: 'gunmetal', len: 0.30, h: 0.028, w: 0.042, railSlots: 7 },
      handguard: { mat: 'gunPolymer', len: 0.17, h: 0.052, w: 0.046, railSlots: 4, vents: 0 },
      hgStyle: 'ribbed',
      barrel: { mat: 'gunmetal', len: 0.16, r: 0.0100 },
      muzzle: { type: 'brake', len: 0.048, r: 0.017 },
      stock: { type: 'bullpup', mat: 'gunPolymer', len: 0.0, h: 0.090, drop: 0.0 },
      grip: { mat: 'rubber', len: 0.112, angle: 0.42 },
      mag: { type: 'box', mat: 'gunTan', len: 0.145, w: 0.028, d: 0.052, curve: 0.04, rearMounted: true },
      optic: { type: 'reddot', mat: 'gunmetal', height: 0.048, len: 0.068, w: 0.036, reticle: 'chevron' },
      charging: { side: 'left', len: 0.050 },
      accentMat: 'brass',
      foregrip: true, bipod: false, sling: true, laser: true,
      ejectSide: 1, boltThrow: 0.026, shell: 'rifle',
    },
  },

  // ========================================================================= SMGS

  smg_wasp: {
    id: 'smg_wasp', name: 'MP-9 WASP', shortName: 'WASP', class: 'smg',
    desc: '1000 rpm. Fastest kill in the game inside nine metres, a water pistol past twenty.',
    slot: 'primary',
    damage: 23, rpm: 1000, magSize: 32, reserve: 224,
    fireMode: 'auto', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 2.2, spreadAds: 0.55,
    spreadMoveMul: 1.25, spreadAirMul: 1.9, spreadCrouchMul: 0.85,
    bloomPerShot: 0.15, bloomMax: 2.4, bloomRecovery: 4.4, bloomAdsMul: 0.7,
    recoil: {
      up: 0.44, side: 0.42, kick: 0.044, recovery: 9.6,
      resetTime: 0.26, returnAmount: 0.66, pattern: P_WASP,
    },
    adsTime: 0.17, adsFov: 62, adsSpeedMul: 0.82,
    reloadTime: 1.72, reloadEmptyTime: 2.25, switchTime: 0.42, raiseTime: 0.33,
    range: 80, falloffStart: 9, falloffEnd: 24, falloffMin: 0.45,
    penetration: 0.12,
    headshotMul: 3.4,
    moveSpeedMul: 1.04,
    tracerEvery: 3, tracerColor: 0xffe0a0,
    audio: { fire: 'smg', reload: 'magIn', tail: 'indoor' },
    unlockLevel: 3,
    /** Machine-pistol: tiny polymer body, exposed steel wire stock, long stick mag. */
    viewmodel: {
      hipRot: [0.02, -0.040, 0.026], adsDepth: -0.30, vmFovAds: 62,
      body: { mat: 'gunPolymer', len: 0.24, h: 0.072, w: 0.048 },
      upper: { mat: 'gunmetal', len: 0.22, h: 0.026, w: 0.040, railSlots: 5 },
      handguard: { mat: 'gunPolymer', len: 0.14, h: 0.050, w: 0.046, railSlots: 3, vents: 0 },
      hgStyle: 'mlok',
      barrel: { mat: 'gunmetal', len: 0.10, r: 0.0090 },
      muzzle: { type: 'flash', len: 0.036, r: 0.014 },
      stock: { type: 'folding', mat: 'gunmetal', len: 0.155, h: 0.052, drop: 0.006 },
      grip: { mat: 'rubber', len: 0.108, angle: 0.44 },
      mag: { type: 'stick', mat: 'gunPolymer', len: 0.20, w: 0.024, d: 0.040, curve: 0.06 },
      optic: { type: 'reddot', mat: 'gunmetal', height: 0.044, len: 0.058, w: 0.032, reticle: 'dot' },
      charging: { side: 'top', len: 0.044 },
      accentMat: 'brass',
      foregrip: true, bipod: false, sling: true, kickMul: 0.8,
      ejectSide: 1, boltThrow: 0.024, shell: 'pistol',
    },
  },

  smg_kestrel: {
    id: 'smg_kestrel', name: 'K-6 KESTREL', shortName: 'KESTREL', class: 'smg',
    desc: 'The safe pick. Flat recoil, honest falloff, still competitive at thirty metres.',
    slot: 'primary',
    damage: 22, rpm: 800, magSize: 30, reserve: 210,
    fireMode: 'auto', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 2.0, spreadAds: 0.34,
    spreadMoveMul: 1.35, spreadAirMul: 2.1, spreadCrouchMul: 0.80,
    bloomPerShot: 0.12, bloomMax: 1.7, bloomRecovery: 4.0, bloomAdsMul: 0.55,
    recoil: {
      up: 0.40, side: 0.26, kick: 0.042, recovery: 10.5,
      resetTime: 0.30, returnAmount: 0.70, pattern: P_KESTREL,
    },
    adsTime: 0.19, adsFov: 58, adsSpeedMul: 0.75,
    reloadTime: 1.90, reloadEmptyTime: 2.44, switchTime: 0.46, raiseTime: 0.36,
    range: 100, falloffStart: 16, falloffEnd: 34, falloffMin: 0.62,
    penetration: 0.22,
    headshotMul: 3.6,
    moveSpeedMul: 1.01,
    tracerEvery: 3, tracerColor: 0xffd08a,
    audio: { fire: 'smg', reload: 'magIn', tail: 'indoor' },
    unlockLevel: 8,
    /** Two-tone: tan handguard and brace on a steel receiver, fat suppressor up front. */
    viewmodel: {
      hipRot: [0.018, -0.036, 0.024], adsDepth: -0.315, vmFovAds: 58,
      body: { mat: 'gunmetal', len: 0.27, h: 0.070, w: 0.048 },
      upper: { mat: 'gunmetal', len: 0.26, h: 0.028, w: 0.042, railSlots: 6 },
      handguard: { mat: 'gunTan', len: 0.18, h: 0.052, w: 0.048, railSlots: 5, vents: 2 },
      hgStyle: 'mlok',
      barrel: { mat: 'gunmetal', len: 0.13, r: 0.0095 },
      muzzle: { type: 'suppressor', len: 0.11, r: 0.019 },
      stock: { type: 'brace', mat: 'gunTan', len: 0.17, h: 0.058, drop: 0.008 },
      grip: { mat: 'gunPolymer', len: 0.110, angle: 0.40 },
      mag: { type: 'curved', mat: 'gunPolymer', len: 0.165, w: 0.026, d: 0.046, curve: 0.12 },
      optic: { type: 'holo', mat: 'gunmetal', height: 0.050, len: 0.084, w: 0.044, reticle: 'ring' },
      charging: { side: 'right', len: 0.050 },
      accentMat: 'brass',
      foregrip: true, bipod: false, sling: true, laser: true, kickMul: 0.9,
      ejectSide: 1, boltThrow: 0.026, shell: 'pistol',
    },
  },

  // ========================================================================== LMG

  lmg_bulwark: {
    id: 'lmg_bulwark', name: 'M250 BULWARK', shortName: 'BULWARK', class: 'lmg',
    desc: '100 belt-fed rounds. Fights the first dozen, then flattens out and eats a room.',
    slot: 'primary',
    damage: 31, rpm: 650, magSize: 100, reserve: 200,
    fireMode: 'auto', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 4.4, spreadAds: 0.30,
    spreadMoveMul: 2.4, spreadAirMul: 3.6, spreadCrouchMul: 0.60,
    bloomPerShot: 0.13, bloomMax: 2.2, bloomRecovery: 2.4, bloomAdsMul: 0.5,
    recoil: {
      up: 0.78, side: 0.50, kick: 0.078, recovery: 5.4,
      resetTime: 0.42, returnAmount: 0.48, pattern: P_BULWARK,
    },
    adsTime: 0.42, adsFov: 52, adsSpeedMul: 0.48,
    reloadTime: 5.40, reloadEmptyTime: 6.60, switchTime: 0.85, raiseTime: 0.70,
    range: 190, falloffStart: 42, falloffEnd: 95, falloffMin: 0.70,
    penetration: 0.75,
    headshotMul: 3.0,
    moveSpeedMul: 0.82,
    tracerEvery: 4, tracerColor: 0xff8844,
    audio: { fire: 'lmg', reload: 'magIn', tail: 'outdoor' },
    unlockLevel: 15,
    /** Belt-fed: louvred steel heat shield, carry handle, folded bipod, brass belt. */
    viewmodel: {
      hipRot: [0.022, -0.026, 0.014], adsDepth: -0.36, vmFovAds: 52,
      body: { mat: 'gunmetal', len: 0.40, h: 0.100, w: 0.064 },
      upper: { mat: 'gunmetal', len: 0.40, h: 0.038, w: 0.052, railSlots: 10 },
      handguard: { mat: 'gunmetal', len: 0.24, h: 0.066, w: 0.058, railSlots: 6, vents: 0 },
      hgStyle: 'shield',
      barrel: { mat: 'gunmetal', len: 0.30, r: 0.0135 },
      muzzle: { type: 'flash', len: 0.070, r: 0.022 },
      stock: { type: 'fixed', mat: 'gunPolymer', len: 0.245, h: 0.088, drop: 0.006 },
      grip: { mat: 'gunPolymer', len: 0.125, angle: 0.32 },
      mag: { type: 'belt', mat: 'gunmetal', len: 0.130, w: 0.072, d: 0.115 },
      optic: { type: 'irons', mat: 'gunmetal', height: 0.046, len: 0.060, w: 0.030, reticle: 'post' },
      charging: { side: 'right', len: 0.070 },
      accentMat: 'brass',
      foregrip: false, bipod: true, sling: true, carryHandle: true, kickMul: 1.3,
      ejectSide: 1, boltThrow: 0.044, shell: 'rifle',
    },
  },

  // ====================================================================== SNIPERS

  sr_reaver: {
    id: 'sr_reaver', name: 'AX-70 REAVER', shortName: 'REAVER', class: 'sniper',
    desc: 'Bolt action .338. One hit anywhere on the chest. Miss and you owe a second and a half.',
    slot: 'primary',
    damage: 112, rpm: 45, magSize: 5, reserve: 45,
    fireMode: 'semi', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 6.5, spreadAds: 0.0,
    spreadMoveMul: 2.0, spreadAirMul: 3.4, spreadCrouchMul: 0.70,
    bloomPerShot: 0.0, bloomMax: 0.0, bloomRecovery: 1.0, bloomAdsMul: 0.0,
    recoil: {
      up: 3.20, side: 0.90, kick: 0.150, recovery: 4.4,
      resetTime: 0.90, returnAmount: 0.80, pattern: P_REAVER,
    },
    adsTime: 0.44, adsFov: 22, adsSpeedMul: 0.42,
    reloadTime: 3.10, reloadEmptyTime: 3.70, switchTime: 0.80, raiseTime: 0.66,
    range: 300, falloffStart: 110, falloffEnd: 240, falloffMin: 0.92,
    penetration: 0.90,
    headshotMul: 2.2,
    moveSpeedMul: 0.84,
    /** Bolt cycle locks the weapon after each shot; drives the viewmodel bolt-throw. */
    rechamberTime: 1.05,
    scoped: true, scopeSwayMul: 1.6, breathHoldTime: 3.2,
    tracerEvery: 1, tracerColor: 0xffffff,
    audio: { fire: 'sniper', reload: 'magIn', tail: 'outdoor' },
    unlockLevel: 10,
    /** Tan precision chassis, fluted barrel, skeleton stock with a riser, 6x glass. */
    viewmodel: {
      hipRot: [0.025, -0.022, 0.012], adsDepth: -0.30, vmFovAds: 30,
      body: { mat: 'gunmetal', len: 0.36, h: 0.080, w: 0.054 },
      upper: { mat: 'gunmetal', len: 0.30, h: 0.032, w: 0.044, railSlots: 6 },
      handguard: { mat: 'gunTan', len: 0.30, h: 0.062, w: 0.056, railSlots: 4, vents: 0 },
      hgStyle: 'mlok',
      barrel: { mat: 'gunmetal', len: 0.40, r: 0.0125 },
      muzzle: { type: 'brake', len: 0.085, r: 0.024 },
      stock: { type: 'skeleton', mat: 'gunTan', len: 0.27, h: 0.096, drop: 0.004 },
      grip: { mat: 'gunPolymer', len: 0.128, angle: 0.30 },
      mag: { type: 'box', mat: 'gunmetal', len: 0.105, w: 0.028, d: 0.058, curve: 0.0 },
      optic: { type: 'scope', mat: 'gunmetal', height: 0.072, len: 0.230, w: 0.052, reticle: 'cross', mag: 6, scopeReticle: 'mildot' },
      charging: { side: 'right', len: 0.095, bolt: true },
      accentMat: 'brass', fluted: true, irons: false,
      foregrip: false, bipod: true, sling: true, kickMul: 1.5,
      ejectSide: 1, boltThrow: 0.075, shell: 'magnum',
    },
  },

  dmr_meridian: {
    id: 'dmr_meridian', name: 'SVK MERIDIAN', shortName: 'MERIDIAN', class: 'sniper',
    desc: 'Semi-auto marksman. Two centre-mass or one through the eye, as fast as you can pull.',
    slot: 'primary',
    damage: 55, rpm: 200, magSize: 10, reserve: 90,
    fireMode: 'semi', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 4.2, spreadAds: 0.06,
    spreadMoveMul: 2.1, spreadAirMul: 3.0, spreadCrouchMul: 0.70,
    bloomPerShot: 0.34, bloomMax: 1.4, bloomRecovery: 2.2, bloomAdsMul: 0.45,
    recoil: {
      up: 1.35, side: 0.52, kick: 0.105, recovery: 5.6,
      resetTime: 0.55, returnAmount: 0.72, pattern: P_MERIDIAN,
    },
    adsTime: 0.34, adsFov: 34, adsSpeedMul: 0.52,
    reloadTime: 2.60, reloadEmptyTime: 3.25, switchTime: 0.70, raiseTime: 0.58,
    range: 250, falloffStart: 55, falloffEnd: 130, falloffMin: 0.80,
    penetration: 0.70,
    headshotMul: 2.6,
    moveSpeedMul: 0.88,
    scoped: true, scopeSwayMul: 1.2, breathHoldTime: 2.6,
    tracerEvery: 1, tracerColor: 0xfff0c0,
    audio: { fire: 'sniper', reload: 'magIn', tail: 'outdoor' },
    unlockLevel: 18,
    /** All-black marksman: quad-rail handguard, skeleton stock, long steel magazine. */
    viewmodel: {
      hipRot: [0.02, -0.024, 0.014], adsDepth: -0.315, vmFovAds: 40,
      body: { mat: 'gunmetal', len: 0.34, h: 0.082, w: 0.052 },
      upper: { mat: 'gunmetal', len: 0.34, h: 0.032, w: 0.046, railSlots: 8 },
      handguard: { mat: 'gunPolymer', len: 0.26, h: 0.058, w: 0.052, railSlots: 4, vents: 0 },
      hgStyle: 'quad',
      barrel: { mat: 'gunmetal', len: 0.32, r: 0.0115 },
      muzzle: { type: 'brake', len: 0.068, r: 0.021 },
      stock: { type: 'skeleton', mat: 'gunPolymer', len: 0.24, h: 0.086, drop: 0.008 },
      grip: { mat: 'rubber', len: 0.120, angle: 0.34 },
      mag: { type: 'curved', mat: 'gunmetal', len: 0.195, w: 0.030, d: 0.060, curve: 0.18 },
      optic: { type: 'scope', mat: 'gunmetal', height: 0.064, len: 0.180, w: 0.046, reticle: 'cross', mag: 3.5, scopeReticle: 'ranging' },
      charging: { side: 'right', len: 0.060 },
      accentMat: 'brass', irons: false,
      foregrip: false, bipod: false, sling: true, kickMul: 1.25,
      ejectSide: 1, boltThrow: 0.048, shell: 'rifle',
    },
  },

  // ====================================================================== SHOTGUN

  sg_breacher: {
    id: 'sg_breacher', name: 'TX-12 BREACHER', shortName: 'BREACHER', class: 'shotgun',
    desc: 'Eight pellets of 12-gauge. Deletes anything inside eight metres. Beyond sixteen it is a club.',
    slot: 'primary',
    damage: 16, rpm: 85, magSize: 6, reserve: 42,
    fireMode: 'semi', burstCount: 0, burstDelay: 0,
    pellets: 8,
    spreadHip: 3.0, spreadAds: 2.0,
    spreadMoveMul: 1.15, spreadAirMul: 1.4, spreadCrouchMul: 0.92,
    bloomPerShot: 0.0, bloomMax: 0.0, bloomRecovery: 1.0, bloomAdsMul: 1.0,
    recoil: {
      up: 2.10, side: 0.85, kick: 0.130, recovery: 5.0,
      resetTime: 0.60, returnAmount: 0.75, pattern: P_BREACHER,
    },
    adsTime: 0.20, adsFov: 66, adsSpeedMul: 0.78,
    reloadTime: 2.90, reloadEmptyTime: 3.40, switchTime: 0.52, raiseTime: 0.42,
    range: 34, falloffStart: 8, falloffEnd: 16, falloffMin: 0.10,
    penetration: 0.0,
    headshotMul: 1.5,
    moveSpeedMul: 0.98,
    /** Pump cycle after every shell — the gun is locked while it runs. */
    rechamberTime: 0.48,
    tracerEvery: 0, tracerColor: 0xffc888,
    audio: { fire: 'shotgun', reload: 'magIn', tail: 'indoor' },
    unlockLevel: 5,
    /** Pump gun: grooved polymer forend, fat steel bore, tube mag under the barrel. */
    viewmodel: {
      hipRot: [0.02, -0.030, 0.020], adsDepth: -0.345, vmFovAds: 66,
      body: { mat: 'gunmetal', len: 0.30, h: 0.086, w: 0.056 },
      upper: { mat: 'gunmetal', len: 0.24, h: 0.030, w: 0.042, railSlots: 4 },
      handguard: { mat: 'gunPolymer', len: 0.22, h: 0.058, w: 0.056, railSlots: 0, vents: 0, pump: true },
      hgStyle: 'pump',
      barrel: { mat: 'gunmetal', len: 0.34, r: 0.0165 },
      muzzle: { type: 'breach', len: 0.055, r: 0.024 },
      stock: { type: 'fixed', mat: 'gunPolymer', len: 0.215, h: 0.080, drop: 0.014 },
      grip: { mat: 'rubber', len: 0.116, angle: 0.36 },
      mag: { type: 'tube', mat: 'gunmetal', len: 0.30, w: 0.026, d: 0.026, curve: 0.0 },
      optic: { type: 'irons', mat: 'gunmetal', height: 0.042, len: 0.050, w: 0.028, reticle: 'bead' },
      charging: { side: 'none', len: 0 },
      accentMat: 'brass', gasBlock: false, irons: false,
      foregrip: false, bipod: false, sling: true, kickMul: 1.4,
      ejectSide: 1, boltThrow: 0.0, pumpThrow: 0.075, shell: 'shotgun',
    },
  },

  // ======================================================================= PISTOL

  pistol_viper: {
    id: 'pistol_viper', name: 'P-11 VIPER', shortName: 'VIPER', class: 'pistol',
    desc: 'Sidearm. Up in a fifth of a second — the answer to an empty magazine.',
    slot: 'secondary',
    damage: 28, rpm: 420, magSize: 15, reserve: 90,
    fireMode: 'semi', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 1.9, spreadAds: 0.30,
    spreadMoveMul: 1.4, spreadAirMul: 2.2, spreadCrouchMul: 0.80,
    bloomPerShot: 0.22, bloomMax: 2.0, bloomRecovery: 4.6, bloomAdsMul: 0.6,
    recoil: {
      up: 0.72, side: 0.30, kick: 0.058, recovery: 11.0,
      resetTime: 0.34, returnAmount: 0.78, pattern: P_VIPER,
    },
    adsTime: 0.145, adsFov: 64, adsSpeedMul: 0.92,
    reloadTime: 1.55, reloadEmptyTime: 2.05, switchTime: 0.30, raiseTime: 0.24,
    range: 90, falloffStart: 18, falloffEnd: 42, falloffMin: 0.62,
    penetration: 0.15,
    headshotMul: 3.3,
    moveSpeedMul: 1.06,
    tracerEvery: 0, tracerColor: 0xffd08a,
    audio: { fire: 'pistol', reload: 'magIn', tail: 'indoor' },
    unlockLevel: 1,
    /** Serrated steel slide over a polymer frame, mini red dot, accessory rail. */
    viewmodel: {
      hipRot: [0.02, -0.055, 0.030], adsDepth: -0.28, vmFovAds: 64,
      frame: { relY: 0.24, minDepth: 0.40, near: 0.16 },
      body: { mat: 'gunPolymer', len: 0.175, h: 0.048, w: 0.030 },
      upper: { mat: 'gunmetal', len: 0.175, h: 0.030, w: 0.030, railSlots: 0 },
      handguard: { mat: 'gunPolymer', len: 0.022, h: 0.020, w: 0.028, railSlots: 2, vents: 0 },
      hgStyle: 'quad',
      barrel: { mat: 'gunmetal', len: 0.016, r: 0.0075 },
      muzzle: { type: 'none', len: 0.0, r: 0.010 },
      stock: { type: 'none', mat: 'gunPolymer', len: 0.0, h: 0.0, drop: 0.0 },
      grip: { mat: 'rubber', len: 0.112, angle: 0.26 },
      mag: { type: 'box', mat: 'gunmetal', len: 0.108, w: 0.022, d: 0.034, curve: 0.0, inGrip: true },
      optic: { type: 'reddot', mat: 'gunmetal', height: 0.026, len: 0.042, w: 0.024, reticle: 'dot' },
      charging: { side: 'slide', len: 0.030 },
      accentMat: 'brass', gasBlock: false, irons: false,
      foregrip: false, bipod: false, sling: false, kickMul: 0.9,
      ejectSide: 1, boltThrow: 0.032, shell: 'pistol',
    },
  },

  // ======================================================================== MELEE

  melee_knife: {
    id: 'melee_knife', name: 'TRENCH KNIFE', shortName: 'KNIFE', class: 'melee',
    desc: 'Silent, instant, and only useful when you are already too close.',
    slot: 'melee',
    damage: 135, rpm: 90, magSize: 0, reserve: 0,
    fireMode: 'semi', burstCount: 0, burstDelay: 0,
    pellets: 1,
    spreadHip: 0, spreadAds: 0,
    spreadMoveMul: 1, spreadAirMul: 1, spreadCrouchMul: 1,
    bloomPerShot: 0, bloomMax: 0, bloomRecovery: 1, bloomAdsMul: 1,
    recoil: { up: 0, side: 0, kick: 0.02, recovery: 12, resetTime: 1, returnAmount: 1, pattern: null },
    adsTime: 0.14, adsFov: 70, adsSpeedMul: 1.0,
    reloadTime: 0, reloadEmptyTime: 0, switchTime: 0.28, raiseTime: 0.22,
    /** Melee is a swept sphere, not a hitscan: `range` is reach, `radius` is forgiveness. */
    range: 2.2, meleeRadius: 0.55, meleeWindup: 0.11, meleeDuration: 0.55,
    falloffStart: 2.2, falloffEnd: 2.2, falloffMin: 1.0,
    penetration: 0,
    headshotMul: 1.0,
    moveSpeedMul: 1.12,
    tracerEvery: 0, tracerColor: 0xffffff,
    audio: { fire: 'switch', reload: 'switch', tail: 'indoor' },
    unlockLevel: 1,
    viewmodel: {
      hipPos: [0.16, -0.18, -0.34], hipRot: [0.05, -0.14, 0.10], adsDepth: -0.32, vmFovAds: 70,
      knife: { bladeLen: 0.185, bladeW: 0.030, bladeT: 0.006, gripLen: 0.105, mat: 'gunmetal', gripMat: 'rubber' },
      body: { mat: 'gunmetal', len: 0.0, h: 0.0, w: 0.0 },
      shell: 'none',
    },
  },

  // =================================================================== THROWABLES

  frag: {
    id: 'frag', name: 'M67 FRAG', shortName: 'FRAG', class: 'grenade',
    desc: 'Three-second fuse. Cook it or you are just redecorating.',
    slot: 'lethal',
    damage: 130, rpm: 40, magSize: 1, reserve: 1,
    fireMode: 'semi', burstCount: 0, burstDelay: 0, pellets: 1,
    spreadHip: 0, spreadAds: 0, spreadMoveMul: 1, spreadAirMul: 1, spreadCrouchMul: 1,
    bloomPerShot: 0, bloomMax: 0, bloomRecovery: 1, bloomAdsMul: 1,
    recoil: { up: 0, side: 0, kick: 0.03, recovery: 10, resetTime: 1, returnAmount: 1, pattern: null },
    adsTime: 0.18, adsFov: 70, adsSpeedMul: 0.9,
    reloadTime: 0, reloadEmptyTime: 0, switchTime: 0.36, raiseTime: 0.30,
    range: 6.5, falloffStart: 0, falloffEnd: 6.5, falloffMin: 0.0,
    penetration: 0, headshotMul: 1.0, moveSpeedMul: 1.0,
    audio: { fire: 'pinPull', reload: 'switch', tail: 'outdoor' },
    unlockLevel: 1,
    projectile: {
      kind: 'frag',
      fuse: 3.1,
      radius: 6.5,
      damage: 130,
      falloffPow: 1.35,          // damage *= (1 - d/r) ^ falloffPow
      minDamageFrac: 0.0,
      throwSpeed: 17.5,          // m/s at full power
      throwSpeedMin: 6.0,        // m/s on a lob (power 0)
      upBias: 0.20,              // how much of a throw is arced upward
      gravity: -22,
      restitution: 0.32,
      friction: 0.68,
      radiusMesh: 0.055,
      spin: 14.0,
      detonateOnImpact: false,
      shakeAmount: 0.9, shakeDuration: 0.85,
      warnRadius: 12.0,
      selfDamageMul: 0.75,
    },
    viewmodel: {
      hipPos: [0.15, -0.20, -0.30], hipRot: [0.0, -0.10, 0.0], adsDepth: -0.30, vmFovAds: 70,
      grenade: { r: 0.052, segments: 1, mat: 'gunPolymer', leverMat: 'gunmetal' },
      body: { mat: 'gunPolymer', len: 0.0, h: 0.0, w: 0.0 },
      shell: 'none',
    },
  },

  smoke: {
    id: 'smoke', name: 'M18 SCREEN', shortName: 'SMOKE', class: 'grenade',
    desc: 'Fourteen seconds of a wall that bullets go through and eyes do not.',
    slot: 'tactical',
    damage: 0, rpm: 40, magSize: 1, reserve: 1,
    fireMode: 'semi', burstCount: 0, burstDelay: 0, pellets: 1,
    spreadHip: 0, spreadAds: 0, spreadMoveMul: 1, spreadAirMul: 1, spreadCrouchMul: 1,
    bloomPerShot: 0, bloomMax: 0, bloomRecovery: 1, bloomAdsMul: 1,
    recoil: { up: 0, side: 0, kick: 0.03, recovery: 10, resetTime: 1, returnAmount: 1, pattern: null },
    adsTime: 0.18, adsFov: 70, adsSpeedMul: 0.9,
    reloadTime: 0, reloadEmptyTime: 0, switchTime: 0.36, raiseTime: 0.30,
    range: 5.0, falloffStart: 0, falloffEnd: 5.0, falloffMin: 0,
    penetration: 0, headshotMul: 1.0, moveSpeedMul: 1.0,
    audio: { fire: 'pinPull', reload: 'switch', tail: 'outdoor' },
    unlockLevel: 4,
    projectile: {
      kind: 'smoke',
      fuse: 1.6,
      radius: 5.0,
      damage: 0,
      duration: 14.0,            // seconds the cloud persists
      growTime: 1.8,
      throwSpeed: 16.0, throwSpeedMin: 5.5, upBias: 0.18,
      gravity: -22, restitution: 0.24, friction: 0.80,
      radiusMesh: 0.05, spin: 9.0,
      detonateOnImpact: false,
      shakeAmount: 0, shakeDuration: 0,
      warnRadius: 0,
      puffRate: 7.0,             // fx puffs per second while burning
    },
    viewmodel: {
      hipPos: [0.15, -0.20, -0.30], hipRot: [0.0, -0.10, 0.0], adsDepth: -0.30, vmFovAds: 70,
      grenade: { r: 0.048, cylinder: true, len: 0.13, mat: 'gunmetal', leverMat: 'gunmetal' },
      body: { mat: 'gunmetal', len: 0.0, h: 0.0, w: 0.0 },
      shell: 'none',
    },
  },

  flash: {
    id: 'flash', name: 'M84 STUN', shortName: 'FLASH', class: 'grenade',
    desc: 'Line of sight is the whole contract. Bank it off a wall and walk in.',
    slot: 'tactical',
    damage: 6, rpm: 40, magSize: 1, reserve: 1,
    fireMode: 'semi', burstCount: 0, burstDelay: 0, pellets: 1,
    spreadHip: 0, spreadAds: 0, spreadMoveMul: 1, spreadAirMul: 1, spreadCrouchMul: 1,
    bloomPerShot: 0, bloomMax: 0, bloomRecovery: 1, bloomAdsMul: 1,
    recoil: { up: 0, side: 0, kick: 0.03, recovery: 10, resetTime: 1, returnAmount: 1, pattern: null },
    adsTime: 0.18, adsFov: 70, adsSpeedMul: 0.9,
    reloadTime: 0, reloadEmptyTime: 0, switchTime: 0.34, raiseTime: 0.28,
    range: 12.0, falloffStart: 0, falloffEnd: 12.0, falloffMin: 0,
    penetration: 0, headshotMul: 1.0, moveSpeedMul: 1.0,
    audio: { fire: 'pinPull', reload: 'switch', tail: 'indoor' },
    unlockLevel: 7,
    projectile: {
      kind: 'flash',
      fuse: 1.5,
      radius: 12.0,
      damage: 6,
      blindMax: 4.2,             // seconds of full blindness looking straight at it
      blindMin: 0.55,            // seconds at the edge of the radius / peripheral
      deafTime: 3.0,
      throwSpeed: 16.5, throwSpeedMin: 5.5, upBias: 0.18,
      gravity: -22, restitution: 0.40, friction: 0.62,
      radiusMesh: 0.048, spin: 16.0,
      detonateOnImpact: false,
      shakeAmount: 0.35, shakeDuration: 0.3,
      warnRadius: 10.0,
    },
    viewmodel: {
      hipPos: [0.15, -0.20, -0.30], hipRot: [0.0, -0.10, 0.0], adsDepth: -0.30, vmFovAds: 70,
      grenade: { r: 0.046, cylinder: true, len: 0.115, mat: 'gunmetal', leverMat: 'gunmetal' },
      body: { mat: 'gunmetal', len: 0.0, h: 0.0, w: 0.0 },
      shell: 'none',
    },
  },
};

// ------------------------------------------------------------------ derived views

/** Every id in the table (guns + melee + throwables). */
export const ALL_WEAPON_IDS = Object.keys(WEAPONS);

/**
 * Weapon id -> small integer, for the wire.
 *
 * Derived from declaration order, which is stable for a given build — both ends of a
 * connection run the same bundle, so this never needs to be authored by hand. Used to tell
 * a client WHICH gun a remote player just fired, so a sniper does not sound like a rifle.
 */
export const WEAPON_WIRE_IDX = new Map(ALL_WEAPON_IDS.map((id, i) => [id, i]));
export const WEAPON_BY_WIRE_IDX = ALL_WEAPON_IDS.map((id) => WEAPONS[id]);

/** The ten selectable firearms, in armoury display order (primaries then the sidearm). */
export const WEAPON_LIST = [
  WEAPONS.ar_vector, WEAPONS.smg_wasp, WEAPONS.sg_breacher, WEAPONS.ar_havoc,
  WEAPONS.smg_kestrel, WEAPONS.sr_reaver, WEAPONS.ar_falcon, WEAPONS.lmg_bulwark,
  WEAPONS.dmr_meridian, WEAPONS.pistol_viper,
];

export const PRIMARIES = WEAPON_LIST.filter((w) => w.slot === 'primary');
export const SECONDARIES = WEAPON_LIST.filter((w) => w.slot === 'secondary');

export const MELEE = WEAPONS.melee_knife;
export const FRAG = WEAPONS.frag;
export const SMOKE = WEAPONS.smoke;
export const FLASH = WEAPONS.flash;

export const DEFAULT_LOADOUT = ['ar_vector', 'pistol_viper'];

/** Bot loadout pool — one entry is picked per bot so a match reads as varied. */
export const BOT_LOADOUTS = [
  ['ar_vector', 'pistol_viper'],
  ['smg_kestrel', 'pistol_viper'],
  ['ar_falcon', 'pistol_viper'],
  ['smg_wasp', 'pistol_viper'],
  ['sg_breacher', 'pistol_viper'],
  ['ar_havoc', 'pistol_viper'],
  ['lmg_bulwark', 'pistol_viper'],
  ['dmr_meridian', 'pistol_viper'],
  ['sr_reaver', 'pistol_viper'],
];

/** Safe lookup — never returns undefined for a live weaponId. */
export function getWeapon(id) {
  return WEAPONS[id] || WEAPONS.ar_vector;
}

/** Seconds between rounds. Exact, never quantised to the simulation tick. */
export function fireInterval(def) {
  return 60 / Math.max(1, def.rpm);
}

/** Shots needed to kill `hp` at `dist`, ignoring headshots. Used by the AI + UI. */
export function shotsToKill(def, dist, hp = 100) {
  const per = def.damage * damageFalloff(def, dist) * (def.pellets > 1 ? def.pellets * 0.72 : 1);
  if (per <= 0) return Infinity;
  return Math.ceil(hp / per);
}

/** The falloff multiplier curve shared by ballistics, the AI and the stats screen. */
export function damageFalloff(def, dist) {
  if (dist <= def.falloffStart) return 1;
  if (dist >= def.falloffEnd) return def.falloffMin;
  const t = (dist - def.falloffStart) / Math.max(1e-4, def.falloffEnd - def.falloffStart);
  return 1 + (def.falloffMin - 1) * t;
}

/** Theoretical TTK in seconds at `dist` (first shot at t=0). */
export function timeToKill(def, dist, hp = 100) {
  const n = shotsToKill(def, dist, hp);
  if (!Number.isFinite(n)) return Infinity;
  let t = (n - 1) * fireInterval(def);
  if (def.rechamberTime) t = (n - 1) * Math.max(fireInterval(def), def.rechamberTime);
  if (def.fireMode === 'burst' && def.burstCount > 1) {
    const bursts = Math.ceil(n / def.burstCount);
    t = (n - bursts) * def.burstDelay + (bursts - 1) * fireInterval(def);
  }
  return t;
}

// Freeze so a rogue system can never scribble on the balance table mid-match.
for (const def of Object.values(WEAPONS)) {
  Object.freeze(def.recoil);
  Object.freeze(def.audio);
  Object.freeze(def);
}
Object.freeze(WEAPONS);
