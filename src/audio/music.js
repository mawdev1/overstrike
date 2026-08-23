/**
 * OVERSTRIKE — procedural music & ambience.
 *
 * Three jobs, all oscillator-driven, no samples:
 *   - a low tense drone bed under the menu,
 *   - a subtle pulsing percussive layer during a match that tightens as combat heats up,
 *   - short victory / defeat stings.
 *
 * The brief for this layer is "you should notice it stop, not notice it start". Everything
 * here sits well below the gunfire: the module's own trim is 0.42, on top of `musicVolume`,
 * and the whole bed is lowpassed so it never competes with a muzzle blast for the 2-5 kHz
 * band where weapons live.
 *
 * The engine owns the graph — `attach()` is called by `AudioEngine` the moment a live
 * `AudioContext` exists (i.e. after a user gesture), and everything before that is queued.
 */

import { clamp } from '../core/mathUtils.js';

/** Module trim. Music is a bed, not a soundtrack. */
const MUSIC_TRIM = 0.42;

/** Lookahead scheduler cadence / horizon, in seconds. */
const TICK_MS = 40;
const LOOKAHEAD = 0.28;

/** A natural-minor-ish set of scale degrees (semitones) for the match bass. */
const SCALE = [0, 3, 5, 7, 10];

/** Root of the match bed — D1. */
const ROOT_HZ = 36.71;

const semi = (root, n) => root * Math.pow(2, n / 12);

export class Music {
  constructor(game) {
    this.game = game;

    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null} */
    this.out = null;      // module output -> engine's music bus
    /** @type {GainNode|null} */
    this.bedGain = null;  // drone bed level (state-dependent)

    this.state = 'none';   // 'none' | 'menu' | 'match' | 'victory' | 'defeat'
    this._pending = null;  // state requested before attach

    this.volume = 0.45;    // settings musicVolume
    this.enabled = true;

    this.intensity = 0;    // smoothed, drives the match layer
    this._auto = 0;        // combat-activity derived target
    this._manual = 0;      // last explicit setIntensity, decays away
    this._manualHold = 0;

    /** @type {any[]} Persistent bed voices, torn down on state change. */
    this._bed = [];
    /** @type {BiquadFilterNode|null} Bed lowpass — intensity opens it up. */
    this._bedFilter = null;
    /** @type {number|null} */
    this._timer = null;
    this._nextBeat = 0;
    this._beat = 0;

    /**
     * Recorded stings, handed over by `AudioEngine` as `public/audio/music/**` decodes.
     *
     * Only the ROUND stings live here. The menu bed, the victory theme and the defeat theme
     * are the SHELL's (`ui/shell/audio.js`) — the shell is on screen for all three and it
     * stops its own music on the way into a match, so playing them here too would be two
     * copies of the same file, slightly out of phase. What the shell cannot cover is a round
     * ending mid-match, which is exactly what is left.
     *
     * The match bed stays procedural on purpose: it tightens with combat intensity, which is
     * what `update()` spends its time on, and a fixed loop cannot do that.
     *
     * @type {Map<string, AudioBuffer>}
     */
    this.tracks = new Map();

    this._unsubs = [];
    this._bindBus();
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  _bindBus() {
    const bus = this.game?.bus;
    if (!bus) return;
    const add = (name, fn) => {
      try { this._unsubs.push(bus.on(name, fn)); } catch { /* bus may be mid-build */ }
    };
    // Combat activity feeds the intensity envelope.
    add('shot', (e) => { if (e?.isPlayer) this._auto = Math.min(1, this._auto + 0.10); else this._auto = Math.min(1, this._auto + 0.045); });
    add('kill', () => { this._auto = Math.min(1, this._auto + 0.28); });
    add('playerDamaged', () => { this._auto = Math.min(1, this._auto + 0.16); });
    add('explosion', () => { this._auto = Math.min(1, this._auto + 0.22); });
  }

  /** Called by AudioEngine once a real context exists. */
  attach(ctx, destination) {
    if (!ctx || this.ctx === ctx) return;
    try {
      this.ctx = ctx;
      this.out = ctx.createGain();
      this.out.gain.value = this._level();
      this.out.connect(destination);
      this.bedGain = ctx.createGain();
      this.bedGain.gain.value = 1;
      this.bedGain.connect(this.out);
    } catch (err) {
      console.warn('[music] attach failed', err);
      this.ctx = null;
      return;
    }
    const want = this._pending || (this.state !== 'none' ? this.state : null);
    this._pending = null;
    if (want) this.start(want);
  }

  _level() {
    return MUSIC_TRIM * clamp(this.volume, 0, 1) * (this.enabled ? 1 : 0);
  }

  setVolume(v) {
    this.volume = clamp(v ?? 0, 0, 1);
    if (!this.out || !this.ctx) return;
    try {
      const g = this.out.gain;
      const now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(this._level(), now + 0.12);
    } catch { /* ignore */ }
  }

  /* ---------------------------------------------------------------- */
  /* Recorded stings                                                   */
  /* ---------------------------------------------------------------- */

  /** @param {'roundWin'|'roundLoss'} key */
  setTrack(key, buffer) {
    if (key && buffer) this.tracks.set(key, buffer);
  }

  hasTrack(key) { return this.tracks.has(key); }

  /**
   * A short recorded sting on the music bus, over whatever bed is running. Deliberately not
   * registered in `_bed`: a state change during it must not cut it off, and it ends on its
   * own in a few seconds either way.
   *
   * @returns {boolean} false when there is no such recording — the caller then stays silent,
   *   which is what round ends did before there was one.
   */
  playSting(key, volume = 1) {
    const buf = this.tracks.get(key);
    const ctx = this.ctx;
    if (!buf || !ctx || !this.out) return false;
    try {
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(this.out);
      src.start(now + 0.01);
      src.onended = () => { try { src.disconnect(); gain.disconnect(); } catch { /* ignore */ } };
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  /** @param {'menu'|'match'|'victory'|'defeat'|'none'} state */
  start(state) {
    if (!this.ctx || !this.out) {
      this._pending = state;
      this.state = state;
      return;
    }
    if (state === this.state && (state === 'menu' || state === 'match')) return;

    this._teardownBed(state === 'none' ? 0.5 : 0.35);
    this._stopScheduler();
    this.state = state;

    try {
      if (state === 'menu') {
        this._auto = 0;
        this._manual = 0;
        this.intensity = 0;
        this._buildMenuBed();
      } else if (state === 'match') {
        this._auto = 0.12;
        this.intensity = 0.12;
        this._buildMatchBed();
        this._startScheduler();
      } else if (state === 'victory') {
        this._sting(true);
      } else if (state === 'defeat') {
        this._sting(false);
      }
    } catch (err) {
      console.warn('[music] start failed', err);
    }
  }

  /** Manual intensity push, 0..1. Decays back to the combat-derived value over ~6 s. */
  setIntensity(v) {
    this._manual = clamp(v ?? 0, 0, 1);
    this._manualHold = 1;
  }

  stop() {
    this._stopScheduler();
    this._teardownBed(0.4);
    this.state = 'none';
    this._pending = null;
  }

  /** Real frame delta. Cheap: smoothing plus a couple of AudioParam writes. */
  update(dt) {
    if (!this.ctx || !this.out) return;
    const d = dt > 0.1 ? 0.1 : dt;

    // Combat activity bleeds away; manual pushes bleed away slower.
    this._auto = Math.max(0, this._auto - d * 0.22);
    if (this._manualHold > 0) {
      this._manualHold = Math.max(0, this._manualHold - d * 0.167);
      this._manual *= 1 - d * 0.05;
    }

    const target = Math.max(this._auto, this._manualHold > 0 ? this._manual : 0);
    // Rise fast, fall slow — combat should feel like it grabs you and lets go gently.
    const rate = target > this.intensity ? 2.6 : 0.45;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-rate * d));

    if (this.state === 'match' && this.bedGain) {
      try {
        this.bedGain.gain.setTargetAtTime(0.55 + this.intensity * 0.6, this.ctx.currentTime, 0.25);
      } catch { /* ignore */ }
      if (this._bedFilter) {
        try {
          this._bedFilter.frequency.setTargetAtTime(
            180 + this.intensity * 620, this.ctx.currentTime, 0.35,
          );
        } catch { /* ignore */ }
      }
    }
  }

  dispose() {
    for (const un of this._unsubs) { try { un(); } catch { /* ignore */ } }
    this._unsubs.length = 0;
    this._stopScheduler();
    this._teardownBed(0.05);
    try { this.out?.disconnect(); } catch { /* ignore */ }
    this.out = null;
    this.bedGain = null;
    this.ctx = null;
  }

  /* ---------------------------------------------------------------- */
  /* Beds                                                              */
  /* ---------------------------------------------------------------- */

  _teardownBed(fade) {
    const ctx = this.ctx;
    if (!ctx) { this._bed.length = 0; this._bedFilter = null; return; }
    const now = ctx.currentTime;
    const filt = this._bedFilter;
    if (filt) {
      setTimeout(() => { try { filt.disconnect(); } catch { /* ignore */ } }, (fade + 0.3) * 1000);
    }
    for (const v of this._bed) {
      try {
        if (v.gain) {
          v.gain.gain.cancelScheduledValues(now);
          v.gain.gain.setValueAtTime(v.gain.gain.value, now);
          v.gain.gain.linearRampToValueAtTime(0.0001, now + fade);
        }
        if (v.node && typeof v.node.stop === 'function') v.node.stop(now + fade + 0.05);
        const n = v.node;
        if (n) {
          if (typeof n.addEventListener === 'function') {
            n.addEventListener('ended', () => { try { n.disconnect(); } catch { /* ignore */ } });
          } else {
            setTimeout(() => { try { n.disconnect(); } catch { /* ignore */ } }, (fade + 0.2) * 1000);
          }
        }
      } catch { /* ignore */ }
    }
    this._bed.length = 0;
    this._bedFilter = null;
  }

  /** Low, slow, uneasy. Two detuned saws plus a filtered noise pad under a drifting LPF. */
  _buildMenuBed() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 240;
    filt.Q.value = 3.5;
    filt.connect(this.bedGain);
    this._bedFilter = filt;

    // Slow cutoff drift — the thing that makes a drone breathe.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.062;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 110;
    lfo.connect(lfoAmt);
    lfoAmt.connect(filt.frequency);
    lfo.start(now);
    this._bed.push({ node: lfo, gain: lfoAmt });

    const voices = [
      { f: 55.0, type: 'sawtooth', g: 0.30, det: -4 },
      { f: 55.0, type: 'sawtooth', g: 0.26, det: +5 },
      { f: 82.41, type: 'triangle', g: 0.20, det: +2 },
      { f: 110.0, type: 'sine', g: 0.10, det: -3 },
    ];
    for (const v of voices) {
      const osc = ctx.createOscillator();
      osc.type = v.type;
      osc.frequency.value = v.f;
      osc.detune.value = v.det;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(v.g, now + 2.2);
      osc.connect(g);
      g.connect(filt);
      osc.start(now);
      this._bed.push({ node: osc, gain: g });
    }

    // A whisper of air so it isn't purely synthetic.
    const air = this._noiseVoice(0.055, 'bandpass', 340, 0.7, 3.0);
    if (air) air.connect(filt);
  }

  /** Darker, tighter bed for the match — the pulse layer rides on top of this. */
  _buildMatchBed() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 200;
    filt.Q.value = 2.2;
    filt.connect(this.bedGain);
    this._bedFilter = filt;

    const voices = [
      { f: ROOT_HZ * 2, type: 'sawtooth', g: 0.22, det: -6 },
      { f: ROOT_HZ * 2, type: 'sawtooth', g: 0.20, det: +7 },
      { f: ROOT_HZ * 3, type: 'triangle', g: 0.12, det: 0 },
    ];
    for (const v of voices) {
      const osc = ctx.createOscillator();
      osc.type = v.type;
      osc.frequency.value = v.f;
      osc.detune.value = v.det;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(v.g, now + 1.6);
      osc.connect(g);
      g.connect(filt);
      osc.start(now);
      this._bed.push({ node: osc, gain: g });
    }

    this.bedGain.gain.setValueAtTime(0.55, now);
    this._beat = 0;
    this._nextBeat = now + 0.25;
  }

  /** Looping filtered-noise pad. Returns the tail node, already tracked for teardown. */
  _noiseVoice(level, type, f, q, fadeIn) {
    const ctx = this.ctx;
    try {
      const now = ctx.currentTime;
      const sr = ctx.sampleRate;
      const buf = ctx.createBuffer(1, Math.floor(sr * 1.5), sr);
      const d = buf.getChannelData(0);
      let seed = 0x2f6e2b1;
      for (let i = 0; i < d.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        d[i] = (seed / 2147483648) - 1;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = type;
      filt.frequency.value = f;
      filt.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(level, now + fadeIn);
      src.connect(filt);
      filt.connect(g);
      src.start(now);
      this._bed.push({ node: src, gain: g });
      return g;
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Match pulse scheduler                                             */
  /* ---------------------------------------------------------------- */

  _startScheduler() {
    if (this._timer != null) return;
    this._timer = setInterval(() => {
      try { this._schedule(); } catch (err) {
        console.warn('[music] scheduler stopped', err);
        this._stopScheduler();
      }
    }, TICK_MS);
  }

  _stopScheduler() {
    if (this._timer != null) { clearInterval(this._timer); this._timer = null; }
  }

  _schedule() {
    const ctx = this.ctx;
    if (!ctx || this.state !== 'match' || ctx.state === 'closed') return;
    const now = ctx.currentTime;
    if (this._nextBeat < now) this._nextBeat = now + 0.05;

    const bpm = 84 + this.intensity * 44;
    const beatDur = 60 / bpm;

    let guard = 0;
    while (this._nextBeat < now + LOOKAHEAD && guard++ < 16) {
      this._emitBeat(this._nextBeat, this._beat);
      this._beat = (this._beat + 1) & 15;
      this._nextBeat += beatDur / 2; // scheduling on eighths
    }
  }

  _emitBeat(t, step) {
    const ctx = this.ctx;
    const I = this.intensity;
    const onBeat = (step & 1) === 0;
    const quarter = step >> 1;

    // Sub pulse — a heartbeat, not a kick drum.
    if (onBeat && (quarter % 2 === 0 || I > 0.45)) {
      this._thump(t, 96, 40, 0.085, 0.30 * (0.45 + I * 0.75));
    }

    // Ticking hat layer appears as things get hot.
    if (I > 0.18 && (!onBeat || quarter % 2 === 1)) {
      this._tick(t, 7200, 0.018, 0.035 * I);
    }

    // Off-beat bass note keeps it moving once the fight is real.
    if (I > 0.34 && onBeat && quarter % 4 === 2) {
      const deg = SCALE[(quarter >> 2) % SCALE.length];
      this._bass(t, semi(ROOT_HZ * 2, deg), 0.26, 0.11 * I);
    }

    // Every four bars, a low swell to reset the tension.
    if (I > 0.55 && step === 0) {
      this._swell(t, 0.09 * I);
    }
  }

  _thump(t, f0, f1, dur, gain) {
    const ctx = this.ctx;
    try {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.7);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
      osc.connect(g);
      g.connect(this.out);
      osc.start(t);
      osc.stop(t + dur + 0.2);
      osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  }

  _tick(t, f, dur, gain) {
    const ctx = this.ctx;
    try {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 4200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(hp);
      hp.connect(g);
      g.connect(this.out);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      osc.onended = () => { try { osc.disconnect(); hp.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  }

  _bass(t, f, dur, gain) {
    const ctx = this.ctx;
    try {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(340, t);
      lp.frequency.exponentialRampToValueAtTime(140, t + dur);
      lp.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(Math.max(0.0002, gain), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.out);
      osc.start(t);
      osc.stop(t + dur + 0.08);
      osc.onended = () => { try { osc.disconnect(); lp.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  }

  _swell(t, gain) {
    const ctx = this.ctx;
    try {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(ROOT_HZ * 4, t);
      osc.frequency.exponentialRampToValueAtTime(ROOT_HZ * 2, t + 1.1);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(200, t);
      lp.frequency.exponentialRampToValueAtTime(1100, t + 0.9);
      lp.Q.value = 5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(Math.max(0.0002, gain), t + 0.85);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.out);
      osc.start(t);
      osc.stop(t + 1.6);
      osc.onended = () => { try { osc.disconnect(); lp.disconnect(); g.disconnect(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  }

  /* ---------------------------------------------------------------- */
  /* Stings                                                            */
  /* ---------------------------------------------------------------- */

  _sting(win) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.03;
    const root = win ? 220 : 196;
    const notes = win ? [0, 4, 7, 12] : [0, -3, -5, -12];
    const step = win ? 0.16 : 0.30;

    for (let i = 0; i < notes.length; i++) {
      const t = t0 + i * step;
      const f = semi(root, notes[i]);
      const last = i === notes.length - 1;
      const dur = last ? 1.9 : 0.55;

      for (let v = 0; v < 2; v++) {
        try {
          const osc = ctx.createOscillator();
          osc.type = v === 0 ? 'sawtooth' : 'triangle';
          osc.frequency.value = f * (v === 0 ? 1 : 2);
          osc.detune.value = v === 0 ? -6 : 5;
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.setValueAtTime(win ? 900 : 700, t);
          lp.frequency.exponentialRampToValueAtTime(win ? 3200 : 420, t + dur * 0.6);
          lp.Q.value = 1.4;
          const g = ctx.createGain();
          const peak = (v === 0 ? 0.16 : 0.07) * (last ? 1 : 0.85);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.linearRampToValueAtTime(peak, t + (win ? 0.03 : 0.10));
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          osc.connect(lp);
          lp.connect(g);
          g.connect(this.out);
          osc.start(t);
          osc.stop(t + dur + 0.1);
          osc.onended = () => { try { osc.disconnect(); lp.disconnect(); g.disconnect(); } catch { /* ignore */ } };
        } catch { /* ignore */ }
      }
    }

    // A low anchor under the whole phrase.
    this._thump(t0, win ? 110 : 92, win ? 55 : 34, win ? 0.5 : 0.9, 0.34);
    if (!win) this._thump(t0 + 0.62, 74, 28, 1.1, 0.24);
  }
}
