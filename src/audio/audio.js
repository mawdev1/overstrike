/**
 * OVERSTRIKE — audio engine (ARCHITECTURE.md §9).
 *
 * Everything is synthesised (see `synth.js`); this module is the mixer, the 3D stage and
 * the voice budget.
 *
 * Bus graph
 * ---------
 *   buffer source ─ gain ─ [air-absorption lowpass] ─ panner (HRTF)
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

const OCC_CHECKS_PER_FRAME = 6;
const OCC_TTL = 0.15;       // seconds a line-of-sight result stays valid
const OCC_MIN_PRIORITY = 34;
const OCC_MIN_DISTANCE = 4;

/** Default random pitch scatter so repeats never sound identical. */
const PITCH_SCATTER = 0.035;
const GAIN_SCATTER = 0.07;

const DEFAULT_PRIORITY = 40;

/** Higher wins a voice-stealing contest. Player weapons get +20 via `opts.self`. */
const PRIORITY = {
  explosion: 100, matchStart: 96, matchEnd: 96, streakReady: 94, killConfirm: 92,
  uiClick: 88, uiBack: 88, uiHover: 84,
  headshot: 90, hitmarker: 90, hitmarkerHeadshot: 90,
  sniper: 80, shotgun: 80, rifle: 78, smg: 78, lmg: 78, pistol: 76,
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
  rifle: 0.42, smg: 0.38, sniper: 0.5, shotgun: 0.46, pistol: 0.36, lmg: 0.46,
  explosion: 0.55, headshot: 0.2, fleshHit: 0.16, whizby: 0.2,
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

    this._now = 0;
    this._deafUntil = 0;
    this._deafAmt = 0;

    this._unsubs = [];
    this._gestureHandler = null;
    this._visibilityHandler = null;

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

  reset() {
    this.stopAll();
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
    try { this.music.dispose(); } catch { /* ignore */ }
    if (this.ctx) {
      try { const p = this.ctx.close(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
      this.ctx = null;
    }
    this.buffers = new Map();
    this.ready = false;
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
    this.music.volume = this._music;
  }

  _bindSettings() {
    const s = this.game?.settings;
    if (!s || typeof s.onChange !== 'function') return;
    try {
      this._unsubs.push(s.onChange((key) => {
        if (key !== '*' && key !== 'masterVolume' && key !== 'sfxVolume' && key !== 'musicVolume') return;
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

    // Push the listener somewhere sane before the first frame lands.
    this.setListener(_lpos.set(this._lx, this._ly, this._lz), _lfwd.set(0, 0, -1), _lup.set(0, 1, 0));

    try { this.music.attach(ctx, musicBus); } catch (err) { console.warn('[audio] music attach failed', err); }
    this._armVisibility();
  }

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

    const bank = this.buffers.get(name);
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
    }

    if (!this._reserveVoice(priority)) return null;

    const buf = bank.length === 1 ? bank[0] : bank[(Math.random() * bank.length) | 0];
    if (!buf) return null;

    // Only a sound that actually gets a voice opens its cooldown window; a play that was
    // refused for budget reasons must not also block the next one.
    if (cd > 0) this._cooldowns.set(name, now);

    let src = null; let gain = null; let filt = null; let panner = null; let send = null;
    try {
      // Never seed playback variation from game.rng — that stream is simulation state.
      const scatter = o.scatter != null ? o.scatter : (o.ui ? 0 : PITCH_SCATTER);
      const rate = (o.rate != null ? o.rate : 1) * (1 + (Math.random() * 2 - 1) * scatter);

      src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = clamp(rate, 0.25, 4);

      let vol = (o.volume != null ? o.volume : 1);
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
        panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
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

      src.onended = voice._onEnded;

      const when = now + (o.delay > 0 ? o.delay : 0);
      src.start(when);
      voice.endsAt = when + buf.duration / src.playbackRate.value + 0.08;

      this.voices.push(voice);
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
      ui: true,
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
      name: '', priority: 0, startedAt: 0, endsAt: 0, done: false, stopping: false,
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
   * Voice budget. Under the cap, always yes. At the cap we find the cheapest voice: if it
   * outranks the newcomer the newcomer is dropped, otherwise it is faded out and reused.
   * Equal priority steals the oldest, so sustained fire stays current rather than jamming.
   */
  _reserveVoice(priority) {
    this._pruneVoices();

    let live = 0;
    let victim = null;
    let worst = Infinity;
    let worstStart = Infinity;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.stopping || v.done) continue;   // already fading out — doesn't hold a slot
      live++;
      if (v.priority < worst || (v.priority === worst && v.startedAt < worstStart)) {
        worst = v.priority;
        worstStart = v.startedAt;
        victim = v;
      }
    }
    if (live < MAX_VOICES) return true;
    if (!victim) return true;
    if (worst > priority) return false;   // everything playing matters more than this
    this._stopVoice(victim, 0.01);
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

    on('kill', (e) => {
      if (e && e.attacker && e.attacker.isPlayer) {
        this.playUI('killConfirm', { volume: e.headshot ? 1 : 0.9 });
      }
    });

    on('killstreak', (e) => {
      if (e && e.entity && e.entity.isPlayer) this.playUI('streakReady', { volume: 0.85 });
    });

    on('matchStart', () => {
      this.resume();
      this.playUI('matchStart', { volume: 0.9 });
      try { this.music.start('match'); } catch { /* ignore */ }
    });

    on('matchEnd', (e) => this._onMatchEnd(e));

    on('ready', () => { try { this.music.start('menu'); } catch { /* ignore */ } });
    on('toMenu', () => { try { this.music.start('menu'); } catch { /* ignore */ } });
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
    this.duck(0.3 + 0.35 * close, 0.55 + 0.7 * close);
    if (close > 0.4) this.deafen(close, 2.2 + close * 3.4);
  }

  _onMatchEnd(e) {
    this.playUI('matchEnd', { volume: 0.9 });
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
    try { this.music.start(win === false ? 'defeat' : 'victory'); } catch { /* ignore */ }
  }
}
