/**
 * OVERSTRIKE — audio engine (ARCHITECTURE.md §9).
 *
 * Everything is synthesised (see `synth.js`); this module is the mixer, the 3D stage and
 * the voice budget.
 *
 * Bus graph
 * ---------
 *   buffer source ─ gain ─ [air-absorption lowpass] ─ panner (HRTF near / equalpower far)
 *                                                       ├─ dry bus ──────────────┐
 *                                                       └─ send gain ─ convolver ┤
 *                                                                       (x3 IRs) │
 *                                                                    return gain ┤
 *                                                                                ▼
 *   music bus ──────────────────────────────────────────────────────────────► sfx gain
 *                                                                                │
 *                                            master gain ─ duck gain ─ deafen LPF ┤
 *                                                                                ▼
 *                                                              compressor ─ destination
 *
 *   (tinnitus ring bypasses the deafen filter and feeds the compressor directly, so it
 *    stays audible through the muffling — which is the whole point of the effect.)
 *
 * Rules this module lives by:
 *  - No `AudioContext` before a user gesture. `init()` only renders buffers, which
 *    `OfflineAudioContext` is happy to do while the page is still silent.
 *  - Nothing here may ever throw into the game loop. If audio is blocked, missing or
 *    broken, every method degrades to a silent no-op.
 *  - `setListener()` allocates nothing.
 */

import * as THREE from 'three';
import { clamp } from '../core/mathUtils.js';
import { renderSoundBank, createImpulseResponses, REQUIRED_SOUNDS } from './synth.js';
import { loadSampleBank, SAMPLE_MANIFEST, VO_NAMES } from './samples.js';
import { Music } from './music.js';

/* ---------------------------------------------------------------- *
 * Tuning
 * ---------------------------------------------------------------- */

const MAX_VOICES = 28;

const REF_DISTANCE = 4;
const MAX_DISTANCE = 120;
const ROLLOFF = 1.4;

/** Air absorption starts here; beyond it the per-voice lowpass closes down. */
const AIR_START = 26;
const AIR_HALF_LIFE = 16;   // metres per further -6 dB-ish of top end

/**
 * Panner quality budget.
 *
 * HRTF is roughly 250x the per-voice DSP cost of `equalpower` (measured: 28 HRTF voices
 * take ~15% of one core, 28 equalpower voices ~2%), and an overrunning audio thread does
 * not drop frames — it crackles. So HRTF is spent where it buys something: the handful of
 * nearest voices. Past ~30 m the image is dominated by distance attenuation and the air
 * -absorption lowpass anyway, and the binaural cues are not doing useful work.
 *
 * `HRTF_REACH` shrinks from FAR to NEAR as the budget fills, so a close sound arriving
 * late still wins HRTF over a mid-distance one, without having to re-model live panners.
 */
const HRTF_MAX_VOICES = 8;
const HRTF_REACH_FAR = 30;
const HRTF_REACH_NEAR = 8;

/**
 * Listener writes are skipped while the head has not actually moved. Every write to a
 * listener AudioParam invalidates the cached azimuth/elevation of *every* panner, so doing
 * it unconditionally at 60-plus fps made all 28 panners recompute their coefficients each
 * render quantum. 0.5 mm and ~0.01 degrees are far below anything audible.
 */
const LISTENER_EPS_POS = 5e-4;
const LISTENER_EPS_DIR = 2e-4;

/**
 * Voice-stealing guards (B2).
 *
 * `MIN_STEAL_AGE` — a voice that has been running for less than this is untouchable. A
 * gunshot buffer is only ~240 ms long; killing it at 80 ms leaves a click where a rifle
 * should be, which is what made sustained fire disintegrate above ~12 bots.
 *
 * `MAX_DEFEND` — how long a voice may defend its slot on the strength of its priority.
 * A voice past this point keeps playing but stops outranking newcomers, so it can be
 * recycled. This is what stops a 3 s `explosion` buffer played at `rate: 0.35` (a ~5.2 s
 * voice at priority 100) from locking every slot against gunfire for seconds.
 *
 * `VOICE_LIMIT` — hard cap on simultaneous voices of one sound. An airstrike fires three
 * `explosion` plays per detonation from three different systems; past a handful of
 * overlapping copies of the same buffer at the same place the extra ones are just level.
 */
const MIN_STEAL_AGE = 0.15;
const MAX_DEFEND = 1.2;
const VOICE_LIMIT = { explosion: 6, bombDetonation: 2, bombRumble: 2 };

/**
 * What a voice's priority is worth once it is past `defendUntil`. Scaled rather than
 * zeroed so the ranking still means something among tails: a lapsed explosion (25) is
 * still worth more than a fresh footstep (18), so footsteps do not chop up blast tails or
 * cut the match-start stinger — but any gunshot (76+) outranks it, which is the point.
 */
const LAPSED_SCALE = 0.25;

/** Fades used when a voice is recycled. Long tails need more than a click-free minimum. */
const STEAL_FADE = 0.012;
const STEAL_FADE_LONG = 0.03;

const OCC_CHECKS_PER_FRAME = 6;
const OCC_TTL = 0.15;       // seconds a line-of-sight result stays valid
const OCC_MIN_PRIORITY = 34;
const OCC_MIN_DISTANCE = 4;

/** Default random pitch scatter so repeats never sound identical. */
const PITCH_SCATTER = 0.035;
const GAIN_SCATTER = 0.07;

const DEFAULT_PRIORITY = 40;

/** Seconds between reads of `Match.aliveCounts`, which allocates on every access. */
const ALIVE_POLL = 0.5;

/** Higher wins a voice-stealing contest. Player weapons get +20 via `opts.self`. */
const PRIORITY = {
  bombDetonation: 110, bombRumble: 104,
  explosion: 100, matchStart: 96, matchEnd: 96, streakReady: 94, killConfirm: 92,
  uiClick: 88, uiBack: 88, uiHover: 84,
  headshot: 90, hitmarker: 90, hitmarkerHeadshot: 90,
  sniper: 80, dmr: 80, shotgun: 80, rifle: 78, smg: 78, lmg: 78, pistol: 76,
  death: 70, hurt: 70, fleshHit: 62, lowAmmo: 60, whizby: 58,
  magOut: 55, magIn: 55, boltBack: 55, boltForward: 55, switch: 55, dryfire: 55,
  grenadeBounce: 52, pinPull: 52, land: 42, reloadTail: 40,
  impactGlass: 36, impactConcrete: 34, impactMetal: 34, impactWood: 34,
  impactDirt: 34, impactSand: 34,
  jump: 26, footstepConcrete: 18, footstepDirt: 18, shellDrop: 14,
};

/**
 * Minimum spacing between two plays of the same sound. Stops eight simultaneous pellet
 * impacts from machine-gunning one buffer. Gunshots are deliberately absent — a 1200 rpm
 * SMG fires every 50 ms and must never drop a round.
 */
const COOLDOWN = {
  impactConcrete: 0.03, impactMetal: 0.03, impactWood: 0.03, impactDirt: 0.03,
  impactSand: 0.03, impactGlass: 0.04, fleshHit: 0.025,
  hitmarker: 0.035, hitmarkerHeadshot: 0.035, headshot: 0.05,
  whizby: 0.045, footstepConcrete: 0.05, footstepDirt: 0.05, shellDrop: 0.03,
  grenadeBounce: 0.05, uiHover: 0.03, lowAmmo: 0.4, reloadTail: 0.1,
};

/** How much of each sound goes to the reverb send before distance is factored in. */
const SEND_BASE = {
  rifle: 0.42, smg: 0.38, sniper: 0.5, dmr: 0.5, shotgun: 0.46, pistol: 0.36, lmg: 0.46,
  explosion: 0.55, bombDetonation: 0.75, bombRumble: 0.3,
  headshot: 0.2, fleshHit: 0.16, whizby: 0.2,
  impactConcrete: 0.22, impactMetal: 0.26, impactWood: 0.2, impactDirt: 0.14,
  impactSand: 0.12, impactGlass: 0.28,
  footstepConcrete: 0.12, footstepDirt: 0.08, land: 0.2, jump: 0.08,
  magOut: 0.16, magIn: 0.16, boltBack: 0.16, boltForward: 0.16, switch: 0.12,
  dryfire: 0.12, reloadTail: 0.14, shellDrop: 0.16,
  grenadeBounce: 0.24, pinPull: 0.12, death: 0.22, hurt: 0.12,
};

const REVERB_RETURN = { indoor: 0.55, outdoor: 0.5, concrete: 0.42 };

const SURFACE_SOUND = {
  concrete: 'impactConcrete', metal: 'impactMetal', wood: 'impactWood',
  dirt: 'impactDirt', glass: 'impactGlass', sand: 'impactSand', flesh: 'fleshHit',
};

const EMPTY = Object.freeze({});
const ANNOUNCER_SOUNDS = new Set(['matchStart', 'matchEnd', 'streakReady', 'killConfirm']);

/* ---------------------------------------------------------------- *
 * Recorded samples (see samples.js)
 * ---------------------------------------------------------------- */

/**
 * Gunfire past this distance is swapped for the dedicated distant recording.
 *
 * Attenuating and lowpassing a close-mic'd shot is not the same sound as a shot recorded
 * from 80 m away — the near buffer keeps its mechanical detail and just gets quiet, which
 * reads as "someone firing next to you, softly". Beyond ~55 m the engine's own treatment
 * has already thrown away most of what distinguishes the classes, so spending one shared
 * buffer there costs nothing and buys the crack-and-slap of real distance.
 */
const DISTANT_SWAP_M = 55;
const GUN_NAMES = new Set(['rifle', 'smg', 'lmg', 'sniper', 'dmr', 'shotgun', 'pistol']);

/** Announcer: one voice at a time, and never two lines on top of each other. */
const VO_GAP = 0.28;          // silence between consecutive lines
const VO_QUEUE_MAX = 2;       // deeper than this and the moment has passed — drop
const VO_REPEAT_LOCK = 1.5;   // same line twice inside this window is spam
/**
 * How long a line may keep re-trying after the voice pool refused it. The pool only
 * refuses when every one of its 28 voices is younger than `MIN_STEAL_AGE`, which is a
 * sub-150ms condition — one frame of a firefight, not a state. Retrying across a couple
 * of frames costs nothing and is the difference between "bomb planted" being spoken and
 * being silently deleted. Past this, the moment really has gone and a late call would
 * describe something the player has already lived through.
 */
const VO_MAX_RETRY = 1.5;
/** ...and how long it stays polite about voice age before it starts taking one. */
const VO_RETRY_GRACE = 0.35;

/** Announcer priorities. A losing line is dropped, not queued behind a stale one. */
const VO_PRIORITY = {
  voVictory: 100, voDefeat: 100, voAttackersWin: 96, voDefendersWin: 96,
  voTargetDestroyed: 94, voBombDefused: 94, voBombPlanted: 92,
  voMatchPoint: 88, voHalftime: 86, voSwitchingSides: 86, voOvertime: 86,
  voMissionLive: 84, voRoundStart: 82, voLastAlive: 80, voThirtySeconds: 76,
  voBombCarrierDown: 72, voUavOnline: 70, voEnemyUav: 70,
  voUnstoppable: 66, voKillingSpree: 64, voDoubleKill: 60,
  voCountdownThree: 58, voCountdownTwo: 58, voCountdownOne: 58,
  voDeploying: 88,
};

/** Sample names that belong to the music module rather than the sound bank. */
const MUSIC_TRACKS = { stingRoundWin: 'roundWin', stingRoundLoss: 'roundLoss' };

/** Ambience bed per map id. */
const MAP_AMBIENCE = {
  'the-square': 'ambienceDesert',
  meridian: 'ambienceCity',
  'meridian-fixture': 'ambienceCity',
  'square-extraction': 'ambienceRailYard',
};

/**
 * Mirrors `BOMB_PARAMS.roundsToWin` (game/bomb.js §2.1a). Copied rather than imported: the
 * announcer must not drag the referee — a simulation module — into the audio import graph
 * for one integer, and being wrong here costs one optional voice line, nothing else.
 */
const ROUNDS_TO_WIN = 7;

/** Ambience bed level, before `sfxVolume`. A bed you notice is a bed that is too loud. */
const AMBIENCE_GAIN = 0.32;
const AMBIENCE_FADE = 1.2;

/* ---------------------------------------------------------------- *
 * Module scratch — never allocate in a per-frame path.
 * ---------------------------------------------------------------- */

const _lpos = new THREE.Vector3();
const _lfwd = new THREE.Vector3();
const _lup = new THREE.Vector3();
const _occFrom = new THREE.Vector3();
const _occTo = new THREE.Vector3();

/* ---------------------------------------------------------------- *
 * Engine
 * ---------------------------------------------------------------- */

/** Escape hatch for the recorded sample bank — see `AudioEngine._deferSampleLoad`. */
function samplesDisabled() {
  try {
    const q = new URLSearchParams(globalThis.location?.search || '');
    if (q.get('samples') === '0') return true;
    return globalThis.localStorage?.getItem('overstrike.audio.samples') === '0';
  } catch { return false; }
}

export class AudioEngine {
  constructor(game) {
    this.game = game;

    /** @type {AudioContext|null} — created lazily on the first user gesture. */
    this.ctx = null;
    /** @type {Map<string, AudioBuffer[]>} */
    this.buffers = new Map();

    this.supported = false;
    this.failed = false;
    this.ready = false;          // buffers rendered
    this.initMs = 0;

    /** Default convolution space; `setSpace()` or `opts.space` overrides. */
    this.space = 'indoor';

    this._master = 0.8;
    this._sfx = 1.0;
    this._music = 0.45;
    this._ui = 0.8;
    this._announcer = 1.0;

    /** @type {any[]} live voices */
    this.voices = [];
    /** @type {any[]} recycled voice records */
    this._pool = [];
    this._cooldowns = new Map();

    /** Occlusion cache: quantised position -> ±(time+1); sign carries the boolean. */
    this._occCache = new Map();
    this._occBudget = OCC_CHECKS_PER_FRAME;

    this._lx = 0; this._ly = 0; this._lz = 0;
    this._listenerFrame = -1;
    this._listenerOk = true;

    /** Last values actually pushed at the AudioListener: px,py,pz,fx,fy,fz,ux,uy,uz. */
    this._lastListener = new Float64Array(9);
    this._listenerWritten = false;
    this._listenerWrites = 0;
    this._listenerSkips = 0;

    /** Live voices currently using an HRTF panner (see the HRTF budget above). */
    this._hrtfVoices = 0;

    this._now = 0;
    this._deafUntil = 0;
    this._deafAmt = 0;

    this._unsubs = [];
    this._gestureHandler = null;
    this._visibilityHandler = null;

    /**
     * Recorded-sample state. `sampled` is the set of names whose synth buffer has been
     * replaced by a real recording — nothing branches on it at play time (the map lookup
     * already resolves to whatever is there), it exists so a probe can prove the wiring.
     */
    this.sampled = new Set();
    this.sampleStats = null;
    this._sampleLoad = null;

    /** Last N plays: `{ name, src: 'sample'|'synth', t }`. Instrumentation only. */
    this.playLog = [];

    /** @type {Array<{name:string, priority:number, volume:number}>} announcer queue */
    this._voQueue = [];
    this._voFreeAt = 0;
    /** @type {Map<string, number>} line -> last time it was spoken */
    this._voLast = new Map();

    /** @type {{name:string, src:AudioBufferSourceNode, gain:GainNode}|null} */
    this._ambience = null;
    this._ambienceWant = null;
    /** @type {{src:AudioBufferSourceNode, gain:GainNode}|null} armed-bomb beep loop */
    this._bombBeep = null;

    /** Announcer state polled off the match (see `_pollMatch`). */
    this._lastCountSaid = 0;
    this._saidThirty = false;
    this._saidLastAlive = false;
    this._lastPhase = '';
    /** Next ctx time the (allocating) `aliveCounts` getter may be read. See `_pollMatch`. */
    this._aliveCheckAt = 0;

    this.music = new Music(game);

    try {
      const g = typeof window !== 'undefined' ? window : null;
      this.supported = !!(g && (g.AudioContext || g.webkitAudioContext));
    } catch {
      this.supported = false;
    }
  }

  /* -------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------- */

  async init() {
    this._readSettings();
    this._bindSettings();

    if (!this.supported) {
      console.warn('[audio] Web Audio unavailable — running silent.');
      return;
    }

    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    try {
      this.buffers = await renderSoundBank();
      this.ready = this.buffers.size > 0;
    } catch (err) {
      console.warn('[audio] sound bank render failed — running silent.', err);
      this.buffers = new Map();
      this.ready = false;
    }
    this.initMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - t0;

    if (this.ready) {
      // `dmr` exists so the marksman rifle can carry its own recording. Until the sample
      // lands it borrows the sniper's synth buffer rather than being a silent name — the
      // two share every synth parameter that matters anyway.
      const sniper = this.buffers.get('sniper');
      if (sniper && !this.buffers.has('dmr')) this.buffers.set('dmr', sniper);

      const missing = REQUIRED_SOUNDS.filter((n) => !this.buffers.has(n));
      if (missing.length) console.warn('[audio] missing sounds:', missing.join(', '));
      let count = 0;
      for (const arr of this.buffers.values()) count += arr.length;
      console.info(`[audio] ${this.buffers.size} sounds / ${count} buffers in ${this.initMs.toFixed(0)} ms`);
    }

    this._bindEvents();
    this._armGesture();
  }

  /**
   * Unlock / create the context. Safe to call as often as you like — the game calls it on
   * every match start and on the first gesture.
   */
  resume() {
    if (!this.supported || this.failed) return;
    try {
      if (!this.ctx) this._createContext();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') {
        const p = this.ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (err) {
      this._softFail(err);
    }
  }

  /**
   * Announcer cues that have no event to hang off.
   *
   * The pre-match countdown, the thirty-second warning and "last one standing" are all
   * STATE, not events: `Match` counts the countdown down inside `fixedUpdate` and the alive
   * counts are a derived view. Rather than push presentation triggers into the simulation —
   * which owns none of these files and would have to emit events nothing else wants — the
   * announcer watches the same state the HUD reads, once per visual frame, and remembers
   * what it has already said. Reading is free; the sim never learns this happened.
   */
  _pollMatch() {
    const match = this.game?.match;
    if (!match) return;

    const phase = match.phase;
    if (phase !== this._lastPhase) {
      if (phase === 'countdown') { this._lastCountSaid = 0; this._saidThirty = false; }
      if (phase === 'live' && this._lastPhase === 'countdown') {
        this.playUI('countdownGo', { volume: 0.9 });
        this.announce('voMissionLive', { volume: 1 });
      }
      this._lastPhase = phase;
    }

    if (phase === 'countdown') {
      const whole = Math.ceil(match.countdown || 0);
      if (whole > 0 && whole <= 3 && whole !== this._lastCountSaid) {
        this._lastCountSaid = whole;
        const line = whole === 3 ? 'voCountdownThree' : whole === 2 ? 'voCountdownTwo' : 'voCountdownOne';
        this.announce(line, { volume: 0.95, repeatLock: 0.4 });
      }
      return;
    }
    if (phase !== 'live') return;

    if (!this._saidThirty) {
      const left = match.timeRemaining;
      if (typeof left === 'number' && left > 0 && left <= 30) {
        this._saidThirty = true;
        this.announce('voThirtySeconds', { volume: 1 });
      }
    }

    // Last one standing on the player's side. `aliveCounts` is the referee's own view, so
    // this reads the same number the scoreboard does — but it is a GETTER that allocates a
    // fresh object (and in Bomb, an array plus two roster scans) on every read. This runs on
    // the render path, so it is gated twice: a dead player can never be the last one standing,
    // and even alive we only look every ALIVE_POLL seconds. "Last alive" is a slow-moving
    // fact; half a second of latency on the line is inaudible, per-frame garbage is not.
    if (!this._saidLastAlive && this.game?.player?.alive && this._now >= this._aliveCheckAt) {
      this._aliveCheckAt = this._now + ALIVE_POLL;
      const counts = match.aliveCounts;
      const team = this.game?.player?.team ?? this.game?.match?.playerTeam ?? 0;
      const mine = counts ? (team === 1 ? counts.bravo : counts.alpha) : null;
      const theirs = counts ? (team === 1 ? counts.alpha : counts.bravo) : null;
      if (mine === 1 && theirs > 1) {
        this._saidLastAlive = true;
        this.announce('voLastAlive', { volume: 1 });
      }
    }
  }

  reset() {
    this.stopAll();
    this._stopAmbience();
    this._stopBombBeep();
    this._ambienceWant = null;
    this._voQueue.length = 0;
    this._voLast.clear();
    this._voFreeAt = 0;
    this._lastCountSaid = 0;
    this._saidThirty = false;
    this._saidLastAlive = false;
    this._lastPhase = '';
    this._aliveCheckAt = 0;
    this._cooldowns.clear();
    this._occCache.clear();
    this._deafUntil = 0;
    this._deafAmt = 0;
    if (!this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      this.duckGain.gain.cancelScheduledValues(now);
      this.duckGain.gain.setValueAtTime(1, now);
      this.deafFilter.frequency.cancelScheduledValues(now);
      this.deafFilter.frequency.setValueAtTime(22000, now);
    } catch { /* ignore */ }
  }

  /** Visual-tick housekeeping: voice GC, listener fallback, music. */
  update(dtFrame) {
    if (this.failed) return;
    const dt = dtFrame > 0.1 ? 0.1 : dtFrame;
    if (this.ctx) {
      this._now = this.ctx.currentTime;
      this._occBudget = OCC_CHECKS_PER_FRAME;
      this._pruneVoices();
      if (this._listenerFrame !== (this.game?.frame ?? 0)) this._listenerFromCamera();
      this._pumpAnnouncer(this._now);
      this._pollMatch();
    }
    try { this.music.update(dt); } catch { /* ignore */ }
  }

  dispose() {
    for (const un of this._unsubs) { try { un(); } catch { /* ignore */ } }
    this._unsubs.length = 0;
    this._disarmGesture();
    if (this._visibilityHandler && typeof document !== 'undefined') {
      try { document.removeEventListener('visibilitychange', this._visibilityHandler); } catch { /* ignore */ }
      this._visibilityHandler = null;
    }
    this.stopAll();
    this._stopAmbience();
    this._stopBombBeep();
    this._voQueue.length = 0;
    try { this.music.dispose(); } catch { /* ignore */ }
    if (this.ctx) {
      try { const p = this.ctx.close(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
      this.ctx = null;
    }
    this.buffers = new Map();
    this.ready = false;
    this._hrtfVoices = 0;
    this._listenerWritten = false;
  }

  /* -------------------------------------------------------------- *
   * Volume / settings
   * -------------------------------------------------------------- */

  _readSettings() {
    const s = this.game?.settings;
    if (!s || typeof s.get !== 'function') return;
    const m = s.get('masterVolume'); if (typeof m === 'number') this._master = clamp(m, 0, 1);
    const x = s.get('sfxVolume'); if (typeof x === 'number') this._sfx = clamp(x, 0, 1);
    const u = s.get('musicVolume'); if (typeof u === 'number') this._music = clamp(u, 0, 1);
    const ui = s.get('uiVolume'); if (typeof ui === 'number') this._ui = clamp(ui, 0, 1);
    const ann = s.get('announcerVolume'); if (typeof ann === 'number') this._announcer = clamp(ann, 0, 1);
    this.music.volume = this._music;
  }

  _bindSettings() {
    const s = this.game?.settings;
    if (!s || typeof s.onChange !== 'function') return;
    try {
      this._unsubs.push(s.onChange((key) => {
        if (key !== '*' && !['masterVolume', 'sfxVolume', 'musicVolume', 'uiVolume',
          'announcerVolume'].includes(key)) return;
        this._readSettings();
        this._applyVolumes(0.08);
      }));
    } catch { /* ignore */ }
  }

  /** @param {number=} master @param {number=} sfx @param {number=} music */
  setVolume(master, sfx, music) {
    if (typeof master === 'number') this._master = clamp(master, 0, 1);
    if (typeof sfx === 'number') this._sfx = clamp(sfx, 0, 1);
    if (typeof music === 'number') this._music = clamp(music, 0, 1);
    this._applyVolumes(0.05);
  }

  _applyVolumes(ramp) {
    try { this.music.setVolume(this._music); } catch { /* ignore */ }
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const set = (param, v) => {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(v, now + ramp);
    };
    try {
      set(this.masterGain.gain, this._master);
      set(this.sfxGain.gain, this._sfx);
    } catch { /* ignore */ }
  }

  /* -------------------------------------------------------------- *
   * Graph construction
   * -------------------------------------------------------------- */

  _createContext() {
    const g = typeof window !== 'undefined' ? window : null;
    const Ctor = g && (g.AudioContext || g.webkitAudioContext);
    if (!Ctor) { this.supported = false; return; }

    let ctx;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      try { ctx = new Ctor(); } catch (err2) { this._softFail(err2); return; }
    }
    this.ctx = ctx;

    // Master limiter. A firefight with 20 voices must never clip the DAC; a hard-ish
    // ratio with a fast attack behaves like a gentle limiter rather than a pumping comp.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 8;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    this.compressor = comp;

    // Deafen stage — normally wide open, slammed shut after a close explosion.
    const deaf = ctx.createBiquadFilter();
    deaf.type = 'lowpass';
    deaf.frequency.value = 22000;
    deaf.Q.value = 0.6;
    deaf.connect(comp);
    this.deafFilter = deaf;

    const duck = ctx.createGain();
    duck.gain.value = 1;
    duck.connect(deaf);
    this.duckGain = duck;

    const master = ctx.createGain();
    master.gain.value = this._master;
    master.connect(duck);
    this.masterGain = master;

    const sfx = ctx.createGain();
    sfx.gain.value = this._sfx;
    sfx.connect(master);
    this.sfxGain = sfx;

    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(sfx);
    this.dryBus = dry;

    const musicBus = ctx.createGain();
    musicBus.gain.value = 1;
    musicBus.connect(master);
    this.musicBus = musicBus;

    // The tinnitus ring sits after the deafen filter on purpose.
    const ring = ctx.createGain();
    ring.gain.value = 1;
    ring.connect(comp);
    this.ringBus = ring;

    // Three convolution spaces on parallel sends. Idle convolvers cost effectively
    // nothing — Web Audio stops processing a node once its tail has run out.
    this.reverbs = null;
    const irs = createImpulseResponses(ctx);
    if (irs) {
      this.reverbs = {};
      for (const key of ['indoor', 'outdoor', 'concrete']) {
        try {
          const conv = ctx.createConvolver();
          conv.normalize = false;
          conv.buffer = irs[key];
          const ret = ctx.createGain();
          ret.gain.value = REVERB_RETURN[key];
          conv.connect(ret);
          ret.connect(sfx);
          this.reverbs[key] = { input: conv, ret };
        } catch (err) {
          console.warn(`[audio] convolver "${key}" unavailable`, err);
        }
      }
      if (!Object.keys(this.reverbs).length) this.reverbs = null;
    }

    // A fresh context has a fresh listener, so the "last written" cache from any previous
    // one is meaningless — force the next write through.
    this._listenerWritten = false;
    this._hrtfVoices = 0;

    // Push the listener somewhere sane before the first frame lands.
    this.setListener(_lpos.set(this._lx, this._ly, this._lz), _lfwd.set(0, 0, -1), _lup.set(0, 1, 0));

    // Ambience sits on the sfx bus: it must duck with everything else under a blast, and
    // follow `sfxVolume`, but it is never positional and never spends a voice.
    const amb = ctx.createGain();
    amb.gain.value = 0;
    amb.connect(sfx);
    this.ambienceBus = amb;

    try { this.music.attach(ctx, musicBus); } catch (err) { console.warn('[audio] music attach failed', err); }
    this._armVisibility();
    // NOT immediately. The gesture that creates this context is, in production, the same
    // click that enters a match — so starting 3.6 MB of fetch+decode+shape here put ~38 s
    // of main-thread work directly on top of the match handshake, and the client's 10 s
    // "no welcome from the game server" timer lost the race. Reported from production as
    // "super lagging then it crashes back to the lobby"; the console showed the WebSocket
    // closing before it was established while the sample bank was still loading.
    //
    // The bank has no deadline — every sound plays on the synth until its buffer lands —
    // so it yields to whatever else the tab is doing and only starts once the main thread
    // is genuinely idle. The timeout is the backstop for a tab that is never idle.
    this._deferSampleLoad();
  }

  /** Start the sample bank at the first idle moment, never on the critical path. */
  _deferSampleLoad() {
    // OFF BY DEFAULT, and that is a deliberate retreat rather than a tuning choice.
    //
    // Shipped, this system has hurt players four separate ways: it starved the match
    // handshake so joining a game failed outright; it took 38 s, then 84 s after I lowered
    // its concurrency, to fill; roughly half its files report `decoded silent` in the
    // browser even though the same mp3s decode to real audio (`ar_fire` peaks at 0.16 full
    // scale through afconvert); and its main-thread work is part of the first-minute stall.
    // The procedural synth bank it was meant to improve on is complete, instant, free and
    // has never broken a match.
    //
    // RESOLVED: the 'decoded silent' half was never a decode failure. `peakOf` reads
    // `getChannelData`, which Brave's fingerprinting protection farbles to near-zero while
    // the audio plays normally — so the silence CHECK rejected 36 healthy files. The check
    // is advisory now (see samples.js) and the bank is on by default again. `?samples=0`
    // turns it off if it ever misbehaves again.
    if (samplesDisabled()) return;
    if (this._sampleLoad || this._sampleLoadQueued) return;
    this._sampleLoadQueued = true;
    const go = () => { this._sampleLoadQueued = false; this._startSampleLoad(); };
    // The CORE tier is what the first ten seconds of a firefight needs, so it no longer
    // waits for an idle moment — the loading screen waits for IT instead (see
    // `coreSamplesReady`, awaited by `Game.init`). Idle scheduling stays for everything
    // after that: the announcer, beds, music and explosion layers have no deadline.
    go();
  }

  /**
   * Resolves when the core combat samples are in the bank (or have provably failed).
   *
   * Boot awaits this so a player never walks into a firefight whose weapons are still
   * synthesised — the fix a player asked for directly: "can't we have a loading screen
   * that makes sure all of that is loaded before the game begins?". Safe to await before
   * the context exists: it simply resolves.
   */
  coreSamplesReady() {
    return this._coreReady || Promise.resolve(false);
  }

  /* -------------------------------------------------------------- *
   * Recorded samples
   * -------------------------------------------------------------- */

  /**
   * Pull `public/audio/**` into the bank, on top of the synth.
   *
   * Deliberately started from `_createContext()` and nowhere else, which means: only in a
   * browser, only after a user gesture, and exactly once per context. ~3.6 MB of mp3 does
   * not belong in the boot path — the game is fully playable on the synth bank while this
   * is in flight, and every sound upgrades itself the moment its buffer lands.
   *
   * Two waves. `core` is combat and the menu clicks: what the first ten seconds of play
   * actually uses. `extra` and `vo` are the announcer, the beds, the music and the
   * explosion layers, which have either a synth fallback or no deadline.
   */
  _startSampleLoad() {
    if (this._sampleLoad || !this.ctx) return;
    const ctx = this.ctx;
    const take = (name, buffers) => {
      // A context that died mid-flight must not have buffers from it installed.
      if (this.ctx !== ctx || this.failed) return;
      // Music never enters the sound bank: a 22-second loop is not a voice, and letting
      // `play()` reach it would put it in the 28-slot budget where it would sit forever.
      const track = MUSIC_TRACKS[name];
      if (track) {
        this.sampled.add(name);
        try { this.music.setTrack(track, buffers[0]); } catch { /* ignore */ }
        return;
      }
      this.buffers.set(name, buffers);
      this.sampled.add(name);
      if (this._ambienceWant === name) this._startAmbience(name);
    };

    // Resolved as soon as the core tier settles, so `Game.init` can hold the loading
    // screen for combat audio and nothing else.
    let markCoreReady;
    this._coreReady = new Promise((r) => { markCoreReady = r; });

    const run = async () => {
      const merged = { loaded: 0, failed: 0, bytes: 0, ms: 0, seconds: 0, failures: [] };
      for (const tiers of [['core'], ['extra', 'vo']]) {
        let s;
        try {
          s = await loadSampleBank(ctx, { manifest: SAMPLE_MANIFEST, onSound: take, tiers });
        } catch (err) {
          console.warn('[audio] sample bank load failed — staying on the synth bank.', err);
          markCoreReady?.(false); markCoreReady = null;
          break;
        }
        merged.loaded += s.loaded;
        merged.failed += s.failed;
        merged.bytes += s.bytes;
        merged.ms += s.ms;
        merged.seconds += s.seconds;
        for (const f of s.failures) if (merged.failures.length < 12) merged.failures.push(f);
        this.sampleStats = { ...merged };
        // First pass through the loop IS the core tier — release the loading screen now,
        // regardless of what the remaining tiers do.
        markCoreReady?.(true); markCoreReady = null;
        if (this.ctx !== ctx) break;
      }
      markCoreReady?.(false); markCoreReady = null;
      const kb = (merged.bytes / 1024).toFixed(0);
      console.info(`[audio] samples: ${merged.loaded} loaded / ${merged.failed} failed, `
        + `${kb} KB, ${merged.seconds.toFixed(1)} s of audio in ${merged.ms.toFixed(0)} ms`);
      if (merged.failures.length) console.warn('[audio] sample failures:', merged.failures.join('; '));
      return merged;
    };

    this._sampleLoad = run().catch((err) => {
      console.warn('[audio] sample load aborted', err);
      return null;
    });
  }

  /** True when the bank can play `name` at all (synth or sample). */
  has(name) {
    const b = this.buffers.get(name);
    return !!(b && b.length);
  }

  /** True when `name` is backed by a real recording rather than the synth. */
  isSampled(name) { return this.sampled.has(name); }

  _softFail(err) {
    if (this.failed) return;
    this.failed = true;
    console.warn('[audio] disabled after an error — the game continues silently.', err);
    try { this.stopAll(); } catch { /* ignore */ }
  }

  /* -------------------------------------------------------------- *
   * Gesture unlock
   * -------------------------------------------------------------- */

  _armGesture() {
    if (typeof window === 'undefined' || this._gestureHandler) return;
    const handler = () => {
      this.resume();
      if (this.ctx && this.ctx.state === 'running') this._disarmGesture();
    };
    this._gestureHandler = handler;
    const opts = { passive: true };
    try {
      window.addEventListener('pointerdown', handler, opts);
      window.addEventListener('keydown', handler, opts);
      window.addEventListener('touchstart', handler, opts);
      window.addEventListener('mousedown', handler, opts);
    } catch { /* ignore */ }
  }

  _disarmGesture() {
    if (typeof window === 'undefined' || !this._gestureHandler) return;
    const h = this._gestureHandler;
    this._gestureHandler = null;
    try {
      window.removeEventListener('pointerdown', h);
      window.removeEventListener('keydown', h);
      window.removeEventListener('touchstart', h);
      window.removeEventListener('mousedown', h);
    } catch { /* ignore */ }
  }

  _armVisibility() {
    if (typeof document === 'undefined' || this._visibilityHandler) return;
    const h = () => {
      if (!this.ctx || this.failed) return;
      try {
        if (document.hidden) {
          this.stopAll();
          const p = this.ctx.suspend(); if (p && p.catch) p.catch(() => {});
        } else if (this.ctx.state === 'suspended') {
          const p = this.ctx.resume(); if (p && p.catch) p.catch(() => {});
        }
      } catch { /* ignore */ }
    };
    this._visibilityHandler = h;
    try { document.addEventListener('visibilitychange', h); } catch { /* ignore */ }
  }

  /* -------------------------------------------------------------- *
   * Listener
   * -------------------------------------------------------------- */

  /**
   * Drive the `AudioListener` from the camera. Called every frame — allocates nothing.
   * Handles both the AudioParam API and the deprecated `setPosition`/`setOrientation`.
   */
  setListener(position, forward, up) {
    if (!position) return;
    this._lx = position.x; this._ly = position.y; this._lz = position.z;
    this._listenerFrame = this.game?.frame ?? 0;

    const ctx = this.ctx;
    if (!ctx || !this._listenerOk) return;

    const fx = forward ? forward.x : 0;
    const fy = forward ? forward.y : 0;
    const fz = forward ? forward.z : -1;
    const ux = up ? up.x : 0;
    const uy = up ? up.y : 1;
    const uz = up ? up.z : 0;

    // Nothing moved => nothing to write. Skipping keeps every panner's cached direction
    // valid instead of dirtying all of them once per frame for no change in the mix.
    const L9 = this._lastListener;
    if (this._listenerWritten
      && Math.abs(this._lx - L9[0]) <= LISTENER_EPS_POS
      && Math.abs(this._ly - L9[1]) <= LISTENER_EPS_POS
      && Math.abs(this._lz - L9[2]) <= LISTENER_EPS_POS
      && Math.abs(fx - L9[3]) <= LISTENER_EPS_DIR
      && Math.abs(fy - L9[4]) <= LISTENER_EPS_DIR
      && Math.abs(fz - L9[5]) <= LISTENER_EPS_DIR
      && Math.abs(ux - L9[6]) <= LISTENER_EPS_DIR
      && Math.abs(uy - L9[7]) <= LISTENER_EPS_DIR
      && Math.abs(uz - L9[8]) <= LISTENER_EPS_DIR) {
      this._listenerSkips++;
      return;
    }

    try {
      const L = ctx.listener;
      if (L.positionX) {
        L.positionX.value = this._lx;
        L.positionY.value = this._ly;
        L.positionZ.value = this._lz;
        L.forwardX.value = fx;
        L.forwardY.value = fy;
        L.forwardZ.value = fz;
        L.upX.value = ux;
        L.upY.value = uy;
        L.upZ.value = uz;
      } else {
        L.setPosition(this._lx, this._ly, this._lz);
        L.setOrientation(fx, fy, fz, ux, uy, uz);
      }
      L9[0] = this._lx; L9[1] = this._ly; L9[2] = this._lz;
      L9[3] = fx; L9[4] = fy; L9[5] = fz;
      L9[6] = ux; L9[7] = uy; L9[8] = uz;
      this._listenerWritten = true;
      this._listenerWrites++;
    } catch (err) {
      // One failure is enough — stop hammering it every frame.
      this._listenerOk = false;
      console.warn('[audio] listener update failed', err);
    }
  }

  /** Fallback when no system claimed the listener this frame. */
  _listenerFromCamera() {
    const cam = this.game?.camera;
    if (!cam || !cam.matrixWorld) return;
    const e = cam.matrixWorld.elements;
    _lpos.set(e[12], e[13], e[14]);
    _lfwd.set(-e[8], -e[9], -e[10]);
    _lup.set(e[4], e[5], e[6]);
    this.setListener(_lpos, _lfwd, _lup);
  }

  /* -------------------------------------------------------------- *
   * Playback
   * -------------------------------------------------------------- */

  /**
   * @param {string} name
   * @param {{position?:{x:number,y:number,z:number}, volume?:number, rate?:number,
   *          delay?:number, priority?:number, self?:boolean, space?:string,
   *          reverb?:number, scatter?:number, cooldown?:number, ui?:boolean}=} opts
   * @returns {object|null} voice handle, or null if it wasn't played
   */
  play(name, opts) {
    if (this.failed || !this.ready) return null;
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return null;

    let bank = this.buffers.get(name);
    if (!bank || !bank.length) return null;

    const o = opts || EMPTY;
    const now = ctx.currentTime;
    this._now = now;

    const cd = o.cooldown != null ? o.cooldown : (COOLDOWN[name] || 0);
    if (cd > 0) {
      const last = this._cooldowns.get(name);
      if (last !== undefined && now - last < cd) return null;
    }

    let priority = o.priority != null ? o.priority : (PRIORITY[name] ?? DEFAULT_PRIORITY);
    if (o.self) priority += 20;

    const pos = o.position;
    let dist = 0;
    if (pos) {
      const dx = pos.x - this._lx;
      const dy = pos.y - this._ly;
      const dz = pos.z - this._lz;
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Past the panner's max distance it is inaudible; don't spend a voice on it.
      if (dist > MAX_DISTANCE * 1.1) return null;
      if (dist > DISTANT_SWAP_M && GUN_NAMES.has(name)) {
        const far = this.buffers.get('gunshotDistant');
        if (far && far.length) bank = far;
      }
    }

    if (!this._reserveVoice(name, priority, now, o.minStealAge)) return null;

    const buf = bank.length === 1 ? bank[0] : bank[(Math.random() * bank.length) | 0];
    if (!buf) return null;

    // Only a sound that actually gets a voice opens its cooldown window; a play that was
    // refused for budget reasons must not also block the next one.
    if (cd > 0) this._cooldowns.set(name, now);

    let src = null; let gain = null; let filt = null; let panner = null; let send = null;
    let hrtf = false;
    try {
      // Never seed playback variation from game.rng — that stream is simulation state.
      const scatter = o.scatter != null ? o.scatter : (o.ui ? 0 : PITCH_SCATTER);
      const rate = (o.rate != null ? o.rate : 1) * (1 + (Math.random() * 2 - 1) * scatter);

      src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = clamp(rate, 0.25, 4);

      let vol = (o.volume != null ? o.volume : 1);
      if (o.ui) vol *= o.channel === 'announcer' ? (this._announcer ?? 1) : (this._ui ?? 1);
      if (!o.ui) vol *= 1 + (Math.random() * 2 - 1) * GAIN_SCATTER;

      // Air absorption + occlusion decide the per-voice lowpass.
      let cutoff = 22000;
      let occluded = 0;
      if (pos) {
        if (dist > AIR_START) {
          cutoff = clamp(20000 * Math.pow(0.55, (dist - AIR_START) / AIR_HALF_LIFE), 400, 20000);
        }
        if (priority >= OCC_MIN_PRIORITY && dist > OCC_MIN_DISTANCE) {
          occluded = this._occlusion(pos);
          if (occluded) {
            cutoff = Math.min(cutoff * 0.28, 1100);
            vol *= 0.48;
          }
        }
      }

      gain = ctx.createGain();
      gain.gain.value = clamp(vol, 0, 4);
      src.connect(gain);
      let tail = gain;

      if (pos && cutoff < 19000) {
        filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.value = cutoff;
        filt.Q.value = 0.5;
        tail.connect(filt);
        tail = filt;
      }

      if (pos) {
        // Spend the HRTF budget on the near field; everything else gets equalpower, which
        // is ~250x cheaper on the audio thread and ~3x cheaper to construct.
        const reach = HRTF_REACH_NEAR
          + (HRTF_REACH_FAR - HRTF_REACH_NEAR) * (1 - this._hrtfVoices / HRTF_MAX_VOICES);
        hrtf = this._hrtfVoices < HRTF_MAX_VOICES && dist <= reach;

        panner = ctx.createPanner();
        panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
        panner.distanceModel = 'inverse';
        panner.refDistance = REF_DISTANCE;
        panner.maxDistance = MAX_DISTANCE;
        panner.rolloffFactor = ROLLOFF;
        this._setPannerPosition(panner, pos.x, pos.y, pos.z);
        tail.connect(panner);
        tail = panner;
      }

      tail.connect(this.dryBus);

      if (!o.ui) {
        const rv = this._pickReverb(o.space, dist);
        if (rv) {
          const amt = this._sendAmount(name, dist, occluded, o.reverb);
          if (amt > 0.002) {
            send = ctx.createGain();
            send.gain.value = amt;
            tail.connect(send);
            send.connect(rv.input);
          }
        }
      }

      const voice = this._acquireVoice();
      voice.name = name;
      voice.priority = priority;
      voice.src = src;
      voice.gain = gain;
      voice.n0 = filt;
      voice.n1 = panner;
      voice.n2 = send;
      voice.startedAt = now;
      voice.done = false;
      voice.stopping = false;
      voice.hrtf = hrtf;

      src.onended = voice._onEnded;

      const when = now + (o.delay > 0 ? o.delay : 0);
      src.start(when);
      const effDur = buf.duration / src.playbackRate.value;
      voice.endsAt = when + effDur + 0.08;
      // Slot tenure is derived from how long the voice will *actually* run, so a sound
      // stretched by a low `rate` cannot bank its priority for the stretched duration.
      voice.defendUntil = when + (effDur < MAX_DEFEND ? effDur : MAX_DEFEND);

      this.voices.push(voice);
      if (hrtf) this._hrtfVoices++;
      if (this.playLog.length >= 64) this.playLog.shift();
      this.playLog.push({
        name,
        src: bank === this.buffers.get(name) ? (this.sampled.has(name) ? 'sample' : 'synth') : 'distant',
        duration: buf.duration,
        t: now,
      });
      this.game?.bus?.emit?.('audioCaption', {
        name,
        channel: o.channel || (o.ui ? 'ui' : 'sfx'),
        position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
      });
      return voice;
    } catch (err) {
      try { src && src.disconnect(); } catch { /* ignore */ }
      try { gain && gain.disconnect(); } catch { /* ignore */ }
      try { filt && filt.disconnect(); } catch { /* ignore */ }
      try { panner && panner.disconnect(); } catch { /* ignore */ }
      try { send && send.disconnect(); } catch { /* ignore */ }
      this._softFail(err);
      return null;
    }
  }

  /** Non-positional, front-and-centre. Menus, hitmarkers, stingers. */
  playUI(name, opts) {
    const o = opts || EMPTY;
    return this.play(name, {
      volume: o.volume,
      rate: o.rate,
      delay: o.delay,
      priority: o.priority != null ? o.priority : (PRIORITY[name] ?? 86),
      scatter: o.scatter != null ? o.scatter : 0.012,
      minStealAge: o.minStealAge,
      ui: true,
      channel: o.channel
        || ((ANNOUNCER_SOUNDS.has(name) || VO_NAMES.has(name)) ? 'announcer' : 'ui'),
    });
  }

  /** Convenience for ballistics/FX: surface name -> the right impact sound. */
  playImpact(surface, position, opts) {
    const name = SURFACE_SOUND[surface] || 'impactConcrete';
    if (!position) return this.play(name, opts);
    const o = opts || EMPTY;
    return this.play(name, {
      position,
      volume: o.volume,
      rate: o.rate,
      delay: o.delay,
      priority: o.priority,
      space: o.space,
    });
  }

  /** Hitmarker feedback for the local player. */
  hitmarker(headshot) {
    return this.playUI(headshot ? 'hitmarkerHeadshot' : 'hitmarker', { volume: headshot ? 1 : 0.85 });
  }

  /* -------------------------------------------------------------- *
   * Announcer
   * -------------------------------------------------------------- */

  /**
   * Speak one announcer line.
   *
   * The rules are the ones that separate an announcer from a nuisance:
   *
   *  - **One voice, ever.** Lines are queued behind whatever is speaking, not mixed with
   *    it. Two overlapping announcer takes are unintelligible and instantly read as a bug.
   *  - **Queue by importance, and shallowly.** The queue holds two lines. A third arriving
   *    means the round moved on faster than the announcer can talk, so the LOWEST-priority
   *    line in the backlog is dropped rather than the newest — "bomb defused" must not lose
   *    its slot to a double-kill call that arrived first.
   *  - **No repeats.** The same line inside `VO_REPEAT_LOCK` is spam and is dropped.
   *  - **Never silently deleted.** A line the voice pool refuses goes back on the queue and
   *    is retried on the next pump (see `_pumpAnnouncer`), because the refusal is a
   *    one-frame budget condition and the callers have no way to detect the loss.
   *  - **Music yields.** The bed ducks under the voice for exactly as long as it speaks.
   *
   * Returns whether the line was accepted (spoken or queued) — the callers do not care,
   * but a probe does.
   */
  announce(name, opts) {
    if (this.failed || !this.ctx) return false;
    if (!this.has(name)) return false;      // sample not loaded (or offline) — stay quiet
    const o = opts || EMPTY;
    const now = this.ctx.currentTime;

    const lock = o.repeatLock != null ? o.repeatLock : VO_REPEAT_LOCK;
    const last = this._voLast.get(name);
    if (last !== undefined && now - last < lock) return false;

    const priority = o.priority != null ? o.priority : (VO_PRIORITY[name] ?? 70);
    if (this._voQueue.some((q) => q.name === name)) return false;

    this._voQueue.push({ name, priority, volume: o.volume != null ? o.volume : 1 });
    while (this._voQueue.length > VO_QUEUE_MAX) {
      let worstAt = 0;
      for (let i = 1; i < this._voQueue.length; i++) {
        if (this._voQueue[i].priority < this._voQueue[worstAt].priority) worstAt = i;
      }
      this._voQueue.splice(worstAt, 1);
    }
    this._pumpAnnouncer(now);
    return true;
  }

  _pumpAnnouncer(now) {
    if (!this._voQueue.length || now < this._voFreeAt) return;
    let bestAt = 0;
    for (let i = 1; i < this._voQueue.length; i++) {
      if (this._voQueue[i].priority > this._voQueue[bestAt].priority) bestAt = i;
    }
    const line = this._voQueue.splice(bestAt, 1)[0];
    const bank = this.buffers.get(line.name);
    if (!bank || !bank.length) return;   // nothing to play — dropping is the only option
    const dur = bank[0].duration;

    // Priority 120 — above the bomb detonation. An announcer line that loses a voice to
    // gunfire is worse than no announcer: the player hears half a word.
    // After VO_RETRY_GRACE of unbroken saturation, stop being polite about voice age.
    const waited = line.retryFrom != null ? now - line.retryFrom : 0;
    const voice = this.playUI(line.name, {
      volume: line.volume, priority: 120, channel: 'announcer', scatter: 0,
      minStealAge: waited > VO_RETRY_GRACE ? 0 : undefined,
    });
    if (!voice) {
      // The pool refused: every live voice is younger than MIN_STEAL_AGE, so priority was
      // never consulted and the 120 above bought nothing. That is a one-frame condition —
      // put the line back where it was and let the next pump take it, rather than deleting
      // the exact call the system exists for. `_voFreeAt` deliberately stays put: nothing
      // was spoken, so nothing is owed silence.
      if (line.retryFrom == null) line.retryFrom = now;
      if (now - line.retryFrom <= VO_MAX_RETRY) this._voQueue.splice(bestAt, 0, line);
      return;
    }
    this._voLast.set(line.name, now);
    this._voFreeAt = now + dur + VO_GAP;
    this._duckMusic(0.55, dur + 0.2);
  }

  /** Pull the music bed down under something that has to be heard over it. */
  _duckMusic(amount, duration) {
    if (!this.musicBus || !this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      const g = this.musicBus.gain;
      const target = clamp(1 - amount, 0.05, 1);
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(target, now + 0.12);
      g.linearRampToValueAtTime(1, now + Math.max(0.3, duration) + 0.35);
    } catch { /* ignore */ }
  }

  /* -------------------------------------------------------------- *
   * Ambience
   * -------------------------------------------------------------- */

  /**
   * Looping, non-positional, distance-free bed for the current map.
   *
   * Not a voice: it holds no slot in the 28-voice budget (it would hold one forever and it
   * has nothing to compete for), it never steals and it is never stolen. It is one
   * `AudioBufferSourceNode` with `loop = true` straight into its own gain on the sfx bus,
   * so it ducks under blasts and follows `sfxVolume` like everything else.
   *
   * @param {string|null} name a bank name, or null to fade the bed out
   */
  setAmbience(name) {
    this._ambienceWant = name || null;
    if (!name) { this._stopAmbience(); return; }
    if (this._ambience && this._ambience.name === name) return;
    this._startAmbience(name);
  }

  /** Map id -> bed. Called on match start; unknown maps simply get no bed. */
  setAmbienceForMap(mapId) {
    this.setAmbience(MAP_AMBIENCE[mapId] || null);
  }

  _startAmbience(name) {
    if (!this.ctx || this.failed || !this.ambienceBus) return;
    const bank = this.buffers.get(name);
    if (!bank || !bank.length) return;          // not loaded yet — `take()` retries for us
    if (this._ambience && this._ambience.name === name) return;
    this._stopAmbience();
    try {
      const ctx = this.ctx;
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = bank[0];
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(AMBIENCE_GAIN, now + AMBIENCE_FADE);
      src.connect(gain);
      gain.connect(this.ambienceBus);
      // The bus itself is the on/off switch, so a bed can be started before the first
      // match without leaking into the menu.
      this.ambienceBus.gain.setValueAtTime(1, now);
      src.start(now + 0.02);
      this._ambience = { name, src, gain };
    } catch { /* a bed is never worth failing the engine over */ }
  }

  _stopAmbience() {
    const a = this._ambience;
    this._ambience = null;
    if (!a || !this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      a.gain.gain.cancelScheduledValues(now);
      a.gain.gain.setValueAtTime(a.gain.gain.value, now);
      a.gain.gain.linearRampToValueAtTime(0.0001, now + 0.4);
      a.src.stop(now + 0.45);
      a.src.onended = () => {
        try { a.src.disconnect(); a.gain.disconnect(); } catch { /* ignore */ }
      };
    } catch {
      try { a.src.disconnect(); a.gain.disconnect(); } catch { /* ignore */ }
    }
  }

  /** Which convolution space new voices default to. */
  setSpace(name) {
    if (name === 'indoor' || name === 'outdoor' || name === 'concrete') this.space = name;
  }

  stopAll() {
    // Fade rather than cut — killing 20 sources on the same sample is an audible pop.
    for (let i = this.voices.length - 1; i >= 0; i--) this._stopVoice(this.voices[i], 0.015);
  }

  /* -------------------------------------------------------------- *
   * Voices
   * -------------------------------------------------------------- */

  _acquireVoice() {
    const v = this._pool.pop();
    if (v) return v;
    const voice = {
      name: '', priority: 0, startedAt: 0, endsAt: 0, defendUntil: 0,
      done: false, stopping: false, hrtf: false,
      src: null, gain: null, n0: null, n1: null, n2: null,
      _onEnded: null, stop: null,
    };
    voice._onEnded = () => this._releaseVoice(voice);
    voice.stop = (fade) => this._stopVoice(voice, fade == null ? 0.02 : fade);
    return voice;
  }

  _releaseVoice(voice) {
    if (voice.done) return;
    voice.done = true;
    voice.stopping = false;
    if (voice.hrtf) {
      voice.hrtf = false;
      if (this._hrtfVoices > 0) this._hrtfVoices--;
    }
    try { voice.src && (voice.src.onended = null); } catch { /* ignore */ }
    try { voice.src && voice.src.disconnect(); } catch { /* ignore */ }
    try { voice.gain && voice.gain.disconnect(); } catch { /* ignore */ }
    try { voice.n0 && voice.n0.disconnect(); } catch { /* ignore */ }
    try { voice.n1 && voice.n1.disconnect(); } catch { /* ignore */ }
    try { voice.n2 && voice.n2.disconnect(); } catch { /* ignore */ }
    voice.src = null; voice.gain = null; voice.n0 = null; voice.n1 = null; voice.n2 = null;
    const i = this.voices.indexOf(voice);
    if (i >= 0) this.voices.splice(i, 1);
    if (this._pool.length < MAX_VOICES * 2) this._pool.push(voice);
  }

  _stopVoice(voice, fade) {
    if (!voice || voice.done || voice.stopping) return;
    const ctx = this.ctx;
    if (!ctx) { this._releaseVoice(voice); return; }
    try {
      const now = ctx.currentTime;
      const f = fade > 0 ? fade : 0.012;
      const g = voice.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + f);
      voice.src.stop(now + f + 0.005);
      // Flagged rather than freed: the fade has to actually play out, and `ended` will
      // recycle the record. Until then it no longer counts against the budget.
      voice.stopping = true;
      voice.endsAt = now + f + 0.02;
    } catch {
      this._releaseVoice(voice);
    }
  }

  /** Drop finished voices whose `ended` never fired (suspended contexts, stolen voices). */
  _pruneVoices() {
    const now = this._now;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.done || (v.endsAt > 0 && now > v.endsAt + 0.25)) this._releaseVoice(v);
    }
  }

  /**
   * Voice budget.
   *
   * Under the cap, always yes. At the cap we find the cheapest *stealable* voice: if it
   * outranks the newcomer the newcomer is dropped, otherwise it is faded out and reused.
   * Equal priority steals the oldest, so sustained fire stays current rather than jamming.
   *
   * Two rules keep that from turning gunfire into clicks (B2):
   *
   *  - A voice younger than `MIN_STEAL_AGE` is not a candidate at all. Bot rifles all share
   *    priority 78 and arrive at ~240/s into 28 slots, so without this every rifle voice
   *    was guillotined after ~80 ms of a 240 ms buffer — 100% of plays "granted" and almost
   *    none of them audible. Refusing the newcomer instead costs one shot and keeps the
   *    ones already sounding intact.
   *  - Past `defendUntil` a voice stops trading on its priority. Priority describes how
   *    much a sound matters *when it happens*; a 5 s stretched explosion tail at priority
   *    100 was using it to lock out every gunshot for the whole tail.
   *
   * `minAge` exists for the one caller that cannot be told "no": the announcer. When the
   * whole pool is younger than `MIN_STEAL_AGE` this returns false before priority is ever
   * consulted, so an announcer line's priority 120 buys it nothing. The announcer retries
   * across frames first, and only if saturation persists does it lower `minAge` to steal a
   * young voice. One clipped gunshot beats a deleted "bomb planted".
   *
   * @param {string} name @param {number} priority @param {number} now @param {number=} minAge
   */
  _reserveVoice(name, priority, now, minAge) {
    const youngLimit = minAge != null ? minAge : MIN_STEAL_AGE;
    this._pruneVoices();

    const limit = VOICE_LIMIT[name] || 0;

    let live = 0;
    let victim = null;
    let worst = Infinity;
    let worstStart = Infinity;
    let sameName = 0;
    let oldestSame = null;
    let oldestSameStart = Infinity;
    let victimLapsed = false;

    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.stopping || v.done) continue;   // already fading out — doesn't hold a slot
      live++;

      if (limit && v.name === name) {
        sameName++;
        if (v.startedAt < oldestSameStart) { oldestSameStart = v.startedAt; oldestSame = v; }
      }

      if (now - v.startedAt < youngLimit) continue;   // too young to interrupt
      const lapsed = now >= v.defendUntil;
      const eff = lapsed ? v.priority * LAPSED_SCALE : v.priority;
      if (eff < worst || (eff === worst && v.startedAt < worstStart)) {
        worst = eff;
        worstStart = v.startedAt;
        victim = v;
        victimLapsed = lapsed;
      }
    }

    // Same-sound cap: keep the newest copies rather than the oldest, so a running barrage
    // stays current, but never at the price of cutting a copy that only just started.
    if (limit && sameName >= limit) {
      if (!oldestSame || now - oldestSameStart < MIN_STEAL_AGE) return false;
      this._stopVoice(oldestSame, STEAL_FADE_LONG);
      return true;
    }

    if (live < MAX_VOICES) return true;
    if (!victim) return false;            // everything live is too young to interrupt
    if (worst > priority) return false;   // everything playing matters more than this
    // A lapsed voice is by definition a long tail — often sub-bass — so give it a longer
    // fade than a gunshot recycled mid-envelope, which would otherwise click.
    this._stopVoice(victim, victimLapsed ? STEAL_FADE_LONG : STEAL_FADE);
    return true;
  }

  _setPannerPosition(panner, x, y, z) {
    try {
      if (panner.positionX) {
        panner.positionX.value = x;
        panner.positionY.value = y;
        panner.positionZ.value = z;
      } else {
        panner.setPosition(x, y, z);
      }
    } catch { /* ignore */ }
  }

  _pickReverb(space, dist) {
    const r = this.reverbs;
    if (!r) return null;
    let key = space || this.space;
    // Distant sounds get a bigger, longer space — that is what makes far gunfire read
    // as far rather than merely quiet.
    if (dist > 45) key = 'concrete';
    else if (dist > 20 && key === 'indoor') key = 'outdoor';
    return r[key] || r.indoor || r.outdoor || r.concrete || null;
  }

  _sendAmount(name, dist, occluded, override) {
    if (override != null) return clamp(override, 0, 1.5);
    let amt = SEND_BASE[name] != null ? SEND_BASE[name] : 0.25;
    amt += clamp((dist - 6) / 70, 0, 1) * 0.45;
    if (occluded) amt *= 1.35;
    return clamp(amt, 0, 1.2);
  }

  /* -------------------------------------------------------------- *
   * Occlusion
   * -------------------------------------------------------------- */

  /**
   * 1 when the sound is behind geometry, 0 otherwise. Results are cached per 2 m cell for
   * 150 ms and the raycast budget is capped per frame, so a wall of impacts costs at most
   * a handful of line-of-sight queries.
   */
  _occlusion(pos) {
    const world = this.game?.world;
    if (!world || typeof world.losClear !== 'function') return 0;

    const qx = clamp(Math.round(pos.x * 0.5) + 256, 0, 511) | 0;
    const qy = clamp(Math.round(pos.y * 0.5) + 64, 0, 255) | 0;
    const qz = clamp(Math.round(pos.z * 0.5) + 256, 0, 511) | 0;
    const key = (qx * 256 + qy) * 512 + qz;

    const now = this._now;
    const cached = this._occCache.get(key);
    if (cached !== undefined) {
      const t = Math.abs(cached) - 1;
      if (now - t < OCC_TTL) return cached < 0 ? 1 : 0;
    }
    if (this._occBudget <= 0) return cached !== undefined && cached < 0 ? 1 : 0;
    this._occBudget--;

    let blocked = 0;
    try {
      _occFrom.set(this._lx, this._ly, this._lz);
      _occTo.set(pos.x, pos.y, pos.z);
      blocked = world.losClear(_occFrom, _occTo) ? 0 : 1;
    } catch {
      blocked = 0;
    }

    if (this._occCache.size > 512) this._occCache.clear();
    this._occCache.set(key, blocked ? -(now + 1) : (now + 1));
    return blocked;
  }

  /* -------------------------------------------------------------- *
   * Ducking / deafen
   * -------------------------------------------------------------- */

  /**
   * Briefly pull the whole mix down. Used on explosions so the blast owns the moment.
   * @param {number} amount 0..1 — how far down
   * @param {number} duration seconds to recover
   */
  duck(amount = 0.4, duration = 0.6) {
    if (!this.ctx || this.failed) return;
    try {
      const now = this.ctx.currentTime;
      const g = this.duckGain.gain;
      const target = clamp(1 - amount, 0.05, 1);
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(target, now + 0.025);
      g.linearRampToValueAtTime(1, now + 0.025 + Math.max(0.05, duration));
    } catch { /* ignore */ }
  }

  /**
   * Tinnitus. A close blast slams a lowpass across the master and leaves a fading sine
   * ring sitting on top of it. Recovers over `duration`.
   * @param {number} intensity 0..1
   * @param {number} duration seconds
   */
  deafen(intensity = 1, duration = 3.5) {
    if (!this.ctx || this.failed) return;
    const amt = clamp(intensity, 0, 1);
    if (amt < 0.03) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    // A weaker blast must not cut short a stronger one already ringing.
    if (now < this._deafUntil && amt <= this._deafAmt * 0.85) return;
    const dur = Math.max(0.6, duration);
    this._deafUntil = now + dur;
    this._deafAmt = amt;

    try {
      const f = this.deafFilter.frequency;
      const target = 1500 - amt * 1150;
      f.cancelScheduledValues(now);
      f.setValueAtTime(Math.min(f.value, 22000), now);
      f.linearRampToValueAtTime(target, now + 0.04);
      f.setValueAtTime(target, now + 0.04 + dur * 0.22);
      f.exponentialRampToValueAtTime(20000, now + 0.04 + dur);
    } catch { /* ignore */ }

    try {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f0 = 3500 + Math.random() * 1500;
      osc.frequency.setValueAtTime(f0, now);
      osc.frequency.linearRampToValueAtTime(f0 * 0.88, now + dur);

      const g = ctx.createGain();
      const peak = Math.max(0.0006, 0.055 * amt * this._master);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(peak, now + 0.06);
      g.gain.setValueAtTime(peak, now + 0.06 + dur * 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

      // A slow tremolo keeps it shimmering instead of sitting there like a test tone.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 4.7 + Math.random() * 2.4;
      const lfoAmt = ctx.createGain();
      lfoAmt.gain.value = peak * 0.35;
      lfo.connect(lfoAmt);
      lfoAmt.connect(g.gain);

      osc.connect(g);
      g.connect(this.ringBus);
      osc.start(now);
      osc.stop(now + dur + 0.1);
      lfo.start(now);
      lfo.stop(now + dur + 0.1);
      osc.onended = () => {
        try { osc.disconnect(); lfo.disconnect(); lfoAmt.disconnect(); g.disconnect(); } catch { /* ignore */ }
      };
    } catch { /* ignore */ }

    this.duck(0.3 * amt, dur * 0.35);
  }

  /* -------------------------------------------------------------- *
   * Event bus wiring
   *
   * Deliberately minimal. Weapons, the player and FX call `play()` explicitly for their
   * own sounds; duplicating them here would double every shot.
   * -------------------------------------------------------------- */

  _bindEvents() {
    const bus = this.game?.bus;
    if (!bus || typeof bus.on !== 'function') return;
    const on = (name, fn) => {
      try { this._unsubs.push(bus.on(name, fn)); } catch { /* ignore */ }
    };

    on('explosion', (e) => this._onExplosion(e));

    // The bomb detonation rides the objective bus (game/bomb.js locally, net/session.js
    // online — both re-emit `bombDetonated` as an `objective` row), NOT the `explosion`
    // damage event: the bomb ends the round without an `applyExplosionDamage` pass, so
    // `_onExplosion` never fires for it.
    on('objective', (e) => this._onObjective(e));

    /*
     * Flash and smoke both already have a `present.play('explosion', { rate: 0.35 })` at
     * their call site — the pitched-down synth pop that stands in for the pop. These add
     * the CHARACTERISTIC part on top, from the bus rather than by editing the simulation:
     * the ringing after a stun, and the hiss of a canister venting.
     *
     * The duration guard matters: `fx.js` re-uses the `flashbang` event for the brief white
     * frame on any nearby explosion, and a full 3.5 s ring on every frag would be absurd.
     * That flash tops out at 0.8 s (`0.35 + 0.45 * far`); a real stun starts at `blindMin`
     * 0.55 s and reaches 4.2 s, so 0.85 s separates them cleanly with room either side.
     */
    on('flashbang', (e) => {
      if (!e || (e.duration ?? 0) < 0.85) return;
      const amt = clamp(e.amount ?? 1, 0, 1);
      this.play('flashRing', { volume: 0.35 + 0.65 * amt, priority: 92, scatter: 0 });
    });

    on('smokeStart', (e) => {
      this.play('smokeHiss', { position: e?.position, volume: 0.7, priority: 44 });
    });

    on('kill', (e) => {
      if (e && e.attacker && e.attacker.isPlayer) {
        this.playUI('killConfirm', { volume: e.headshot ? 1 : 0.9 });
      }
      this._saidLastAlive = false;   // re-arm; the poll decides if it is true again
    });

    on('killstreak', (e) => {
      if (!e || !e.entity || !e.entity.isPlayer) return;
      this.playUI('streakReady', { volume: 0.85 });
      // The announcer marks the milestones, not every kill: 2 / 5 / 8 is the ladder the
      // recorded lines were written for.
      const n = e.count | 0;
      if (n === 2) this.announce('voDoubleKill', { volume: 0.95 });
      else if (n === 5) this.announce('voKillingSpree');
      else if (n >= 8) this.announce('voUnstoppable');
    });

    on('killstreakActivated', (e) => {
      if (!e || e.id !== 'uav') return;
      const mine = e.entity?.isPlayer || e.team === (this.game?.player?.team ?? 0);
      this.announce(mine ? 'voUavOnline' : 'voEnemyUav', { volume: 0.95 });
    });

    on('matchStart', () => {
      this.resume();
      this.playUI('matchStart', { volume: 0.9 });
      this.setAmbienceForMap(this.game?.world?.mapId);
      this.announce('voDeploying', { volume: 1 });
      try { this.music.start('match'); } catch { /* ignore */ }
    });

    on('matchEnd', (e) => this._onMatchEnd(e));

    on('ready', () => { try { this.music.start('menu'); } catch { /* ignore */ } });
    on('toMenu', () => {
      this.setAmbience(null);
      this._stopBombBeep();
      try { this.music.start('menu'); } catch { /* ignore */ }
    });
  }

  /**
   * The objective bus (`game/bomb.js` locally, `net/session.js` online) is the real source
   * for every bomb and round-flow line — these are the same rows the HUD and the killfeed
   * read, so the announcer can never disagree with what is on screen.
   */
  _onObjective(e) {
    if (!e) return;
    switch (e.kind) {
      case 'bombDetonated':
        this._onBombDetonated(e);
        this.announce('voTargetDestroyed', { volume: 1 });
        break;
      case 'plantStart':
        this._playObjectiveCue('bombPlant', e, 0.9);
        break;
      case 'plantComplete':
        this.announce('voBombPlanted', { volume: 1 });
        this._startBombBeep(e);
        break;
      case 'defuseStart':
        this._playObjectiveCue('bombDefuse', e, 0.9);
        break;
      case 'defuseComplete':
        this._stopBombBeep();
        this.announce('voBombDefused', { volume: 1 });
        break;
      case 'roundStart':
        this._stopBombBeep();
        this._saidLastAlive = false;
        this.announce('voRoundStart', { volume: 1 });
        // Match point is a fact about the score at the START of a round, which is the only
        // objective row that carries `roundWins`.
        if (Array.isArray(e.roundWins)
          && (e.roundWins[0] === ROUNDS_TO_WIN - 1 || e.roundWins[1] === ROUNDS_TO_WIN - 1)) {
          this.announce('voMatchPoint', { volume: 1, repeatLock: 30 });
        }
        break;
      case 'liveStart':
        this.announce('voMissionLive', { volume: 1 });
        break;
      case 'sideSwitch':
        this.announce('voHalftime', { volume: 1 });
        this.announce('voSwitchingSides', { volume: 1 });
        break;
      case 'bombDropped':
        this.announce('voBombCarrierDown', { volume: 0.9, repeatLock: 6 });
        break;
      case 'roundEnd':
        this._onRoundEnd(e);
        break;
      case 'matchEnd':
        this._onSeriesEnd(e);
        break;
      default: break;
    }
  }

  /** A positional one-shot for a bomb interaction, at the bomb if we were told where. */
  _playObjectiveCue(name, e, volume) {
    const p = e.position ?? (typeof e.x === 'number' ? { x: e.x, y: e.y, z: e.z } : null)
      ?? this.game?.match?.bomb?.position ?? null;
    this.play(name, { position: p, volume, priority: 88, scatter: 0.005 });
  }

  /**
   * The armed-bomb beep. A loop rather than a scheduled one-shot per beep: the beep has to
   * survive a tab switch, a stolen voice and a frame hitch without drifting, and a looping
   * source is the only thing here that is immune to all three.
   */
  _startBombBeep(e) {
    if (!this.ctx || this.failed || !this.has('bombBeep')) return;
    this._stopBombBeep();
    const p = e?.position ?? this.game?.match?.bomb?.position ?? null;
    try {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.buffers.get('bombBeep')[0];
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0.55;
      src.connect(gain);
      let tail = gain;
      if (p) {
        const panner = ctx.createPanner();
        panner.panningModel = 'equalpower';
        panner.distanceModel = 'inverse';
        panner.refDistance = REF_DISTANCE;
        panner.maxDistance = MAX_DISTANCE;
        panner.rolloffFactor = ROLLOFF;
        this._setPannerPosition(panner, p.x, p.y, p.z);
        gain.connect(panner);
        tail = panner;
      }
      tail.connect(this.dryBus);
      src.start(ctx.currentTime + 0.02);
      this._bombBeep = { src, gain };
    } catch { /* ignore */ }
  }

  _stopBombBeep() {
    const b = this._bombBeep;
    this._bombBeep = null;
    if (!b || !this.ctx) return;
    try {
      const now = this.ctx.currentTime;
      b.gain.gain.cancelScheduledValues(now);
      b.gain.gain.setValueAtTime(b.gain.gain.value, now);
      b.gain.gain.linearRampToValueAtTime(0.0001, now + 0.12);
      b.src.stop(now + 0.15);
      b.src.onended = () => { try { b.src.disconnect(); b.gain.disconnect(); } catch { /* ignore */ } };
    } catch {
      try { b.src.disconnect(); b.gain.disconnect(); } catch { /* ignore */ }
    }
  }

  /**
   * Round outcome. Whether it was "attackers" or "defenders" is not a property of the round
   * record — it is the winner's relationship to the SITE, which `homeSites` carries: the
   * team that owns the planted site defended it.
   */
  _onRoundEnd(e) {
    this._stopBombBeep();
    this._saidLastAlive = false;
    const win = e.winnerTeam;
    if (win == null || win < 0) return;

    const planter = e.plantedByTeam;
    const defended = planter != null && win !== planter;
    this.announce(defended ? 'voDefendersWin' : 'voAttackersWin', { volume: 1, repeatLock: 4 });

    const mine = (this.game?.player?.team ?? 0) === win;
    // Through the music bus, so it follows `musicVolume` and ducks under the announcer
    // line it always arrives with.
    try { this.music.playSting(mine ? 'roundWin' : 'roundLoss', 0.9); } catch { /* ignore */ }
  }

  /** The Bomb series result, which arrives on the objective bus rather than `matchEnd`. */
  _onSeriesEnd(series) {
    this._stopBombBeep();
    this.setAmbience(null);
    const win = series?.winnerTeam;
    if (win == null || win < 0) return;
    const mine = (this.game?.player?.team ?? 0) === win;
    this.announce(mine ? 'voVictory' : 'voDefeat', { volume: 1, repeatLock: 30 });
  }

  /**
   * Layer the recorded blast over the synth one, mixed by distance.
   *
   * The synth `explosion` stays exactly as tuned — it is the transient, and it is what the
   * duck, the deafen and the voice budget were balanced against. What the recordings add is
   * the part synthesis is worst at:
   *
   *   `explosionCore`    the initial detonation, only close, only where it is not just
   *                      louder but *different* — it doubles the crack, it does not replace it.
   *   `explosionTail`    the decay through the streets, faded IN with distance.
   *   `explosionDistant` the far-off thud, which is all you get past ~45 m.
   *
   * Every layer is optional: before the samples land (or offline) not one of these plays
   * and the blast is precisely the synth blast it has always been.
   *
   * @param {{x:number,y:number,z:number}|null} p
   * @param {number} close 1 at the blast, 0 at the far edge of its reach
   * @param {number} scale overall level multiplier
   */
  _layerBlast(p, close, scale) {
    const far = 1 - close;
    if (close > 0.25 && this.has('explosionCore')) {
      this.play('explosionCore', {
        position: p, volume: 0.55 * close * scale, priority: 99, scatter: 0.01,
      });
    }
    if (this.has('explosionTail')) {
      this.play('explosionTail', {
        position: p, volume: (0.3 + 0.4 * far) * scale, priority: 26,
        delay: 0.12, scatter: 0.01, reverb: 0.7,
      });
    }
    if (far > 0.4 && this.has('explosionDistant')) {
      // Non-positional on purpose: this layer exists to be heard where the positional one
      // has already rolled off to nothing, so a panner would defeat the point.
      this.play('explosionDistant', {
        volume: 0.45 * far * scale, priority: 24, delay: 0.06, scatter: 0.01,
      });
    }
  }

  _onExplosion(e) {
    if (!e) return;
    const p = e.point;
    this.play('explosion', { position: p, priority: 100, volume: 1 });

    if (!this.ctx) return;
    let close = 1;
    if (p) {
      const dx = p.x - this._lx, dy = p.y - this._ly, dz = p.z - this._lz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const reach = Math.max(5, (e.radius || 7) * 2.2);
      close = clamp(1 - d / reach, 0, 1);
    }
    this._layerBlast(p, close, 0.8);
    this.duck(0.3 + 0.35 * close, 0.55 + 0.7 * close);
    if (close > 0.4) this.deafen(close, 2.2 + close * 3.4);
  }

  /**
   * The bomb detonation is authored to be HEARD MAP-WIDE, in two layers:
   *
   *   `bombDetonation` — the full crack+blast+tail, positional. The engine's existing
   *     distance treatment does the heavy lifting: inverse rolloff, the air-absorption
   *     lowpass past 26 m (the "muffled far away"), and the long `concrete` convolution
   *     picked automatically past 45 m (the echo tail).
   *   `bombRumble` — lows only, NON-positional, mixed IN as the positional layer
   *     attenuates OUT with distance. This is what keeps the far corner of the map —
   *     ~120 m out, where inverse rolloff leaves almost nothing — with a felt, muffled
   *     boom instead of silence. Sub-bass carries no useful direction anyway.
   *
   * Plus the moment-ownership treatment: a hard duck of everything else, and the
   * deafen/tinnitus ring when it goes off close.
   */
  _onBombDetonated(e) {
    const p = e.position
      ?? (typeof e.x === 'number' ? { x: e.x, y: e.y, z: e.z } : null);

    this.play('bombDetonation', { position: p, volume: 1.6, scatter: 0.01 });

    let close = 1;
    if (p && this.ctx) {
      const dx = p.x - this._lx, dy = p.y - this._ly, dz = p.z - this._lz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      close = clamp(1 - d / 60, 0, 1);
    }

    // Crossfade: barely-there at the site (the positional layer owns it), dominant far.
    const farVol = 0.2 + 0.7 * (1 - close);
    this.play('bombRumble', { volume: farVol, priority: PRIORITY.bombRumble, scatter: 0.01 });
    this._layerBlast(p, close, 1.15);

    this.duck(0.45 + 0.35 * close, 1.1 + 1.4 * close);
    if (close > 0.3) this.deafen(close, 2.6 + close * 3.2);
  }

  _onMatchEnd(e) {
    this.playUI('matchEnd', { volume: 0.9 });
    this.setAmbience(null);
    this._stopBombBeep();
    let win = null;
    if (e) {
      if (typeof e.victory === 'boolean') win = e.victory;
      else if (typeof e.win === 'boolean') win = e.win;
      else if (e.result === 'victory' || e.result === 'win') win = true;
      else if (e.result === 'defeat' || e.result === 'loss') win = false;
      else if (Array.isArray(e.scores)) {
        const team = this.game?.player?.team ?? 0;
        const mine = e.scores[team] ?? 0;
        const theirs = e.scores[team === 0 ? 1 : 0] ?? 0;
        if (mine !== theirs) win = mine > theirs;
      }
    }
    if (win !== null) this.announce(win ? 'voVictory' : 'voDefeat', { volume: 1, repeatLock: 30 });
    try { this.music.start(win === false ? 'defeat' : 'victory'); } catch { /* ignore */ }
  }
}
