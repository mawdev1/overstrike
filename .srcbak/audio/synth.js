/**
 * OVERSTRIKE — procedural sound bank.
 *
 * Every sound in the game is synthesised here, once, at boot. Nothing is fetched and
 * nothing is decoded. Two `OfflineAudioContext` passes (one mono, one stereo) render a
 * long timeline containing every sound laid end to end; the timeline is then sliced,
 * trimmed and peak-guarded into individual `AudioBuffer`s. Playback at runtime is a bare
 * `AudioBufferSourceNode`, which is the cheapest voice Web Audio can give us.
 *
 * Rendering the whole bank as two big timelines rather than ~100 tiny contexts matters:
 * context construction dominates the cost at this scale, and the batched form keeps the
 * whole bank inside the ~250 ms boot budget on an integrated laptop.
 *
 * Design notes that keep it sounding like a gun and not a beep:
 *  - Gunshots are four layers (transient click / resonant noise body / pitched-down thump
 *    / decaying tail) plus a mechanical action tick, saturated through a tanh shaper.
 *  - Impacts get material-correct physics: metal rings with inharmonic partials, glass is
 *    a scattered cluster of tinkles, dirt is a soft filtered thud.
 *  - Multiple variants per sound, plus per-voice pitch/gain scatter at play time, so a
 *    30-round mag never sounds like a loop.
 */

/** Bank render rate. `AudioBufferSourceNode` resamples to the live context rate. */
export const SYNTH_SAMPLE_RATE = 48000;

/** Silence below this is trimmed off the end of a rendered slot. */
const TRIM_FLOOR = 1.2e-4;

/** Gap between slots on the render timeline (absorbs filter ring-out). */
const SLOT_PAD = 0.05;

/** Chunk limits — see `renderBatch` for why these matter so much. */
const MAX_SLOTS_PER_CHUNK = 8;
const MAX_CHUNK_SECONDS = 3.0;

/* ------------------------------------------------------------------ *
 * Deterministic RNG — the bank must be byte-identical between boots.
 * ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const r = mulberry32(seed);
  r.range = (a, b) => a + (b - a) * r();
  r.pick = (arr) => arr[(r() * arr.length) | 0];
  /** Symmetric jitter: `r.jit(0.05)` -> [-0.05, 0.05]. */
  r.jit = (a) => (r() * 2 - 1) * a;
  return r;
}

/* ------------------------------------------------------------------ *
 * Waveshaper curves (module scope — shared by every context).
 * ------------------------------------------------------------------ */

function makeCurve(k) {
  const n = 1024;
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

const DRIVE_CURVE = makeCurve(2.6);

/* ------------------------------------------------------------------ *
 * Per-context shared resources.
 * ------------------------------------------------------------------ */

/**
 * The two noise beds are the same every time: same seed, same length, same sample rate.
 * `makeShared()` runs once per render chunk (21 chunks per boot), so generating them there
 * meant 4 M redundant sample generations and ~40 M flops on the main thread at every boot.
 * They are generated once here instead, keyed by sample rate.
 *
 * These arrays are the master copies and are never handed out: `makeShared()` copies them
 * into fresh per-context `AudioBuffer`s, so no consumer can mutate them, and because they
 * are plain `Float32Array`s holding no context reference they survive an `AudioContext`
 * being closed and recreated.
 *
 * @type {{sr:number, white:Float32Array, pink:Float32Array}|null}
 */
let _noiseBeds = null;

function noiseBeds(sr) {
  if (_noiseBeds && _noiseBeds.sr === sr) return _noiseBeds;

  const len = Math.floor(sr * 2);
  const r = mulberry32(0x5eed1a7e);

  const white = new Float32Array(len);
  for (let i = 0; i < len; i++) white[i] = r() * 2 - 1;

  // Paul Kellet pink filter — a fuller, more "air moving" noise for bodies and tails.
  const pink = new Float32Array(len);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const x = r() * 2 - 1;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    pink[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.16;
    b6 = x * 0.115926;
  }

  _noiseBeds = { sr, white, pink };
  return _noiseBeds;
}

/** Copy a master bed into a buffer owned by `ctx`. */
function bedBuffer(ctx, sr, data) {
  const buf = ctx.createBuffer(1, data.length, sr);
  if (typeof buf.copyToChannel === 'function') buf.copyToChannel(data, 0);
  else buf.getChannelData(0).set(data);
  return buf;
}

function makeShared(ctx) {
  const sr = ctx.sampleRate;
  const beds = noiseBeds(sr);
  return {
    white: bedBuffer(ctx, sr, beds.white),
    pink: bedBuffer(ctx, sr, beds.pink),
    hasPan: typeof ctx.createStereoPanner === 'function',
  };
}

/* ------------------------------------------------------------------ *
 * Node helpers.
 * ------------------------------------------------------------------ */

function noiseSource(ctx, sh, R, t, dur, kind) {
  const buf = kind === 'pink' ? sh.pink : sh.white;
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.start(t, R() * (buf.duration - 0.05), Math.max(0.004, dur));
  return s;
}

function biquad(ctx, type, f0, q, t, f1, sweep) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.Q.value = q == null ? 1 : q;
  b.frequency.setValueAtTime(Math.max(20, f0), t);
  if (f1 && sweep > 0) b.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + sweep);
  return b;
}

/** Percussive AR envelope. Exponential decay is what makes a hit read as a hit. */
function envGain(ctx, t, peak, atk, dec, hold) {
  const g = ctx.createGain();
  const pk = Math.max(peak, 2e-4);
  const a = Math.max(atk, 3e-4);
  const h = hold > 0 ? hold : 0;
  g.gain.setValueAtTime(1e-4, t);
  g.gain.exponentialRampToValueAtTime(pk, t + a);
  if (h > 0) g.gain.setValueAtTime(pk, t + a + h);
  g.gain.exponentialRampToValueAtTime(1e-4, t + a + h + Math.max(dec, 1e-3));
  return g;
}

function terminate(ctx, sh, node, dest, o) {
  let tail = node;
  if (o.drive) {
    const ws = ctx.createWaveShaper();
    ws.curve = DRIVE_CURVE;
    // Deliberately no oversampling: an oversampled shaper never reports silence, so it
    // keeps churning for the whole offline timeline and costs seconds of boot time. The
    // aliasing it saves is inaudible on noise transients this short.
    ws.oversample = 'none';
    tail.connect(ws);
    const mk = ctx.createGain();
    mk.gain.value = o.gain;
    ws.connect(mk);
    tail = mk;
  }
  if (o.pan != null && sh.hasPan) {
    const sp = ctx.createStereoPanner();
    sp.pan.value = Math.max(-1, Math.min(1, o.pan));
    tail.connect(sp);
    tail = sp;
  }
  tail.connect(dest);
}

/**
 * A filtered noise layer.
 * o: { dur, atk, hold, gain, noise:'white'|'pink', type, f0, f1, sweep, q, hp, drive, pan }
 */
function noiseLayer(ctx, dest, sh, R, t, o) {
  const atk = o.atk || 8e-4;
  const hold = o.hold || 0;
  const total = atk + hold + o.dur + 0.01;
  let node = noiseSource(ctx, sh, R, t, total, o.noise);

  if (o.hp) {
    const h = biquad(ctx, 'highpass', o.hp, o.hpQ || 0.7, t);
    node.connect(h);
    node = h;
  }
  if (o.type) {
    const sweep = o.sweep == null ? o.dur * 0.85 : o.sweep;
    const f = biquad(ctx, o.type, o.f0, o.q, t, o.f1, sweep);
    node.connect(f);
    node = f;
  }

  const peak = o.drive ? Math.min(1, o.gain * o.drive) : o.gain;
  const g = envGain(ctx, t, peak, atk, o.dur, hold);
  node.connect(g);
  terminate(ctx, sh, g, dest, o);
  return g;
}

/**
 * A pitched layer.
 * o: { type, f0, f1, sweep, dur, atk, hold, gain, filter, ff0, ff1, fq, fsweep, drive, pan }
 */
function toneLayer(ctx, dest, sh, R, t, o) {
  const atk = o.atk || 1e-3;
  const hold = o.hold || 0;
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(Math.max(8, o.f0), t);
  if (o.f1) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(8, o.f1), t + (o.sweep == null ? o.dur : o.sweep),
    );
  }
  let node = osc;
  if (o.filter) {
    const f = biquad(ctx, o.filter, o.ff0, o.fq, t, o.ff1, o.fsweep == null ? o.dur : o.fsweep);
    node.connect(f);
    node = f;
  }

  const peak = o.drive ? Math.min(1, o.gain * o.drive) : o.gain;
  const g = envGain(ctx, t, peak, atk, o.dur, hold);
  node.connect(g);
  terminate(ctx, sh, g, dest, o);

  osc.start(t);
  osc.stop(t + atk + hold + o.dur + 0.02);
  return g;
}

/** Scattered micro-grains — debris, grit, glass shards. */
function grains(ctx, dest, sh, R, t, o) {
  for (let i = 0; i < o.count; i++) {
    const at = t + R.range(o.t0, o.t1);
    noiseLayer(ctx, dest, sh, R, at, {
      type: 'bandpass',
      f0: R.range(o.f0, o.f1),
      q: o.q == null ? 6 : o.q,
      dur: R.range(o.dMin || 0.012, o.dMax || 0.03),
      gain: R.range(o.gMin, o.gMax),
      atk: 5e-4,
      pan: o.spread ? R.jit(o.spread) : null,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Gunshots.
 * ------------------------------------------------------------------ */

const GUN_PARAMS = {
  rifle: {
    dur: 0.54, pv: 0.045,
    click: 0.62, clickF: 2800, clickDur: 0.014,
    bodyF0: 4600, bodyF1: 330, bodyDur: 0.15, bodyQ: 6.5, body: 0.72, bodyDrive: 2.2,
    punchF: 1250, punchQ: 1.6, punchDur: 0.075, punch: 0.4,
    thumpF0: 215, thumpF1: 50, thumpDur: 0.17, thump: 0.66,
    tailF0: 1500, tailF1: 380, tailDur: 0.32, tail: 0.17, er: 3,
    mech: 0.13, mechF: 2600, mechAt: 0.036,
  },
  smg: {
    dur: 0.40, pv: 0.06,
    click: 0.66, clickF: 3400, clickDur: 0.011,
    bodyF0: 5400, bodyF1: 600, bodyDur: 0.095, bodyQ: 7.5, body: 0.62, bodyDrive: 2.4,
    punchF: 1700, punchQ: 2.0, punchDur: 0.05, punch: 0.34,
    thumpF0: 190, thumpF1: 72, thumpDur: 0.10, thump: 0.44,
    tailF0: 1900, tailF1: 620, tailDur: 0.20, tail: 0.12, er: 2,
    mech: 0.17, mechF: 3100, mechAt: 0.028,
  },
  sniper: {
    dur: 0.98, pv: 0.03,
    click: 0.80, clickF: 3000, clickDur: 0.018,
    bodyF0: 7000, bodyF1: 300, bodyDur: 0.22, bodyQ: 5.5, body: 0.80, bodyDrive: 2.0,
    punchF: 980, punchQ: 1.3, punchDur: 0.11, punch: 0.42,
    thumpF0: 165, thumpF1: 36, thumpDur: 0.30, thump: 0.80,
    tailF0: 1200, tailF1: 260, tailDur: 0.72, tail: 0.24, er: 4,
    mech: 0.10, mechF: 2300, mechAt: 0.055,
    crack: true,
  },
  shotgun: {
    dur: 0.76, pv: 0.05,
    click: 0.44, clickF: 2200, clickDur: 0.016,
    bodyF0: 3000, bodyF1: 175, bodyDur: 0.26, bodyQ: 4.0, body: 0.82, bodyDrive: 2.6,
    punchF: 700, punchQ: 1.1, punchDur: 0.12, punch: 0.40,
    thumpF0: 130, thumpF1: 34, thumpDur: 0.30, thump: 0.85,
    tailF0: 900, tailF1: 240, tailDur: 0.50, tail: 0.21, er: 3,
    mech: 0.09, mechF: 1900, mechAt: 0.070,
    stagger: true,
  },
  pistol: {
    dur: 0.44, pv: 0.05,
    click: 0.60, clickF: 3200, clickDur: 0.012,
    bodyF0: 4900, bodyF1: 520, bodyDur: 0.11, bodyQ: 7.0, body: 0.58, bodyDrive: 2.2,
    punchF: 1500, punchQ: 1.8, punchDur: 0.06, punch: 0.33,
    thumpF0: 200, thumpF1: 66, thumpDur: 0.12, thump: 0.50,
    tailF0: 1700, tailF1: 500, tailDur: 0.24, tail: 0.13, er: 2,
    mech: 0.15, mechF: 2900, mechAt: 0.032,
  },
  lmg: {
    dur: 0.70, pv: 0.05,
    click: 0.54, clickF: 2500, clickDur: 0.016,
    bodyF0: 3800, bodyF1: 250, bodyDur: 0.20, bodyQ: 5.5, body: 0.84, bodyDrive: 2.7,
    punchF: 950, punchQ: 1.4, punchDur: 0.10, punch: 0.44,
    thumpF0: 175, thumpF1: 40, thumpDur: 0.26, thump: 0.86,
    tailF0: 1150, tailF1: 300, tailDur: 0.46, tail: 0.21, er: 3,
    mech: 0.20, mechF: 2100, mechAt: 0.040,
  },
};

function gunBuilder(P) {
  return (ctx, dest, t, R, sh) => {
    const p = 1 + R.jit(P.pv);

    // 1 — muzzle transient. Short, bright, and the thing that reads as "gunshot" first.
    noiseLayer(ctx, dest, sh, R, t, {
      type: 'highpass', f0: P.clickF * p, f1: P.clickF * 2.4 * p, sweep: 0.007, q: 0.6,
      dur: P.clickDur, gain: P.click, atk: 4e-4,
    });

    // 2 — body: pink noise through a resonant lowpass collapsing from bright to chesty.
    const bodies = P.stagger ? 3 : 1;
    for (let i = 0; i < bodies; i++) {
      noiseLayer(ctx, dest, sh, R, t + i * R.range(0.003, 0.006), {
        noise: 'pink', type: 'lowpass',
        f0: P.bodyF0 * p, f1: P.bodyF1 * p, sweep: P.bodyDur * 0.8, q: P.bodyQ,
        dur: P.bodyDur * (1 - i * 0.18), gain: P.body / (1 + i * 0.7),
        atk: 7e-4, drive: P.bodyDrive,
      });
    }

    // 3 — mid punch: the bandpassed slap that carries over a mix.
    noiseLayer(ctx, dest, sh, R, t + 0.001, {
      type: 'bandpass', f0: P.punchF * p, f1: P.punchF * 0.55 * p, sweep: P.punchDur,
      q: P.punchQ, dur: P.punchDur, gain: P.punch, atk: 6e-4, drive: 1.6,
    });

    // 4 — low thump: pitched sine dive. This is the "weight" the speakers feel.
    toneLayer(ctx, dest, sh, R, t, {
      type: 'sine', f0: P.thumpF0 * p, f1: P.thumpF1, sweep: P.thumpDur * 0.55,
      dur: P.thumpDur, gain: P.thump, atk: 1e-3, drive: 1.5,
    });
    toneLayer(ctx, dest, sh, R, t, {
      type: 'triangle', f0: P.thumpF0 * 0.55 * p, f1: P.thumpF1 * 0.7,
      sweep: P.thumpDur * 0.7, dur: P.thumpDur * 1.2, gain: P.thump * 0.35, atk: 2e-3,
    });

    // Sniper supersonic crack: a thin descending whistle riding the blast.
    if (P.crack) {
      noiseLayer(ctx, dest, sh, R, t + 0.004, {
        type: 'bandpass', f0: 5200 * p, f1: 1400 * p, sweep: 0.09, q: 5.5,
        dur: 0.10, gain: 0.30, atk: 8e-4,
      });
      toneLayer(ctx, dest, sh, R, t + 0.006, {
        type: 'sine', f0: 3400 * p, f1: 900, sweep: 0.07, dur: 0.08, gain: 0.10, atk: 1e-3,
      });
    }

    // 5 — early reflections then a decaying tail. The live convolver adds the room on
    //     top; this is the shot's own close-field character so it never sounds dry.
    for (let i = 0; i < P.er; i++) {
      const at = t + 0.016 + i * 0.021 + R.range(0, 0.008);
      noiseLayer(ctx, dest, sh, R, at, {
        noise: 'pink', type: 'bandpass', f0: P.tailF0 * R.range(0.8, 1.2), q: 0.9,
        dur: 0.045, gain: P.tail * (0.75 - i * 0.16), atk: 2e-3,
      });
    }
    noiseLayer(ctx, dest, sh, R, t + 0.026, {
      noise: 'pink', type: 'bandpass', f0: P.tailF0 * 0.6, f1: P.tailF1, sweep: P.tailDur * 0.9,
      q: 0.7, dur: P.tailDur, gain: P.tail * 0.6, atk: 0.014,
    });

    // 6 — mechanical action: bolt/slide cycling under the blast.
    noiseLayer(ctx, dest, sh, R, t + P.mechAt, {
      type: 'bandpass', f0: P.mechF * R.range(0.92, 1.08), q: 7,
      dur: 0.035, gain: P.mech, atk: 5e-4,
    });
    noiseLayer(ctx, dest, sh, R, t + P.mechAt + 0.018, {
      type: 'lowpass', f0: 900, f1: 380, q: 2, dur: 0.03, gain: P.mech * 0.55, atk: 8e-4,
    });
  };
}

/* ------------------------------------------------------------------ *
 * Surface impacts.
 * ------------------------------------------------------------------ */

function impactConcrete(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.10);
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'lowpass', f0: 4200 * p, f1: 520 * p, sweep: 0.05, q: 3.2,
    dur: 0.07, gain: 0.55, atk: 5e-4, drive: 1.8,
  });
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 1600 * p, q: 2.2, dur: 0.05, gain: 0.26, atk: 6e-4,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 165 * p, f1: 72, sweep: 0.05, dur: 0.06, gain: 0.22,
  });
  grains(ctx, dest, sh, R, t, {
    count: 4, t0: 0.018, t1: 0.16, f0: 2200, f1: 5400, gMin: 0.035, gMax: 0.085,
  });
}

function impactMetal(ctx, dest, t, R, sh) {
  const base = R.range(1250, 2700);
  noiseLayer(ctx, dest, sh, R, t, {
    hp: 4200, dur: 0.009, gain: 0.52, atk: 3e-4,
  });
  // Inharmonic partials — a struck plate, not a tuned bell.
  const ratios = [1, 2.41, 3.87, 5.11];
  const gains = [0.24, 0.15, 0.09, 0.05];
  for (let i = 0; i < ratios.length; i++) {
    const f = base * ratios[i] * R.range(0.97, 1.03);
    toneLayer(ctx, dest, sh, R, t, {
      type: 'sine', f0: f, f1: f * 0.985, sweep: 0.2,
      dur: 0.30 * R.range(0.7, 1.2) / (1 + i * 0.45), gain: gains[i], atk: 8e-4,
    });
  }
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: base * 1.6, q: 11, dur: 0.10, gain: 0.28, atk: 5e-4,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 280, f1: 150, sweep: 0.04, dur: 0.05, gain: 0.18,
  });
}

function impactWood(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.12);
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'lowpass', f0: 2800 * p, f1: 380 * p, sweep: 0.04, q: 2.4,
    dur: 0.05, gain: 0.46, atk: 5e-4, drive: 1.7,
  });
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 640 * p, q: 4.5, dur: 0.09, gain: 0.30, atk: 7e-4,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'triangle', f0: 215 * p, f1: 140, sweep: 0.05, dur: 0.075, gain: 0.32,
  });
  grains(ctx, dest, sh, R, t, {
    count: 3, t0: 0.01, t1: 0.09, f0: 1400, f1: 3400, gMin: 0.03, gMax: 0.06,
  });
}

function impactDirt(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.12);
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'lowpass', f0: 1300 * p, f1: 250, sweep: 0.07, q: 1.2,
    dur: 0.09, gain: 0.52, atk: 1.4e-3,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 115 * p, f1: 55, sweep: 0.05, dur: 0.07, gain: 0.26,
  });
  grains(ctx, dest, sh, R, t, {
    count: 3, t0: 0.02, t1: 0.13, f0: 1600, f1: 3200, gMin: 0.02, gMax: 0.045,
  });
}

function impactSand(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'lowpass', f0: 2400, f1: 600, sweep: 0.06, q: 0.8,
    dur: 0.10, gain: 0.34, atk: 3e-3,
  });
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 3600, q: 1.4, dur: 0.07, gain: 0.14, atk: 2e-3,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 95, f1: 52, sweep: 0.04, dur: 0.05, gain: 0.14,
  });
}

function impactGlass(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, {
    hp: 2600, dur: 0.045, gain: 0.42, atk: 4e-4,
  });
  // A cluster of shards falling away from the break.
  const shards = 9;
  for (let i = 0; i < shards; i++) {
    const at = t + R.range(0.004, 0.20) * R.range(0.5, 1.4);
    const f = R.range(2600, 8200);
    toneLayer(ctx, dest, sh, R, at, {
      type: R() > 0.55 ? 'triangle' : 'sine', f0: f, f1: f * 0.99, sweep: 0.08,
      dur: R.range(0.05, 0.14), gain: R.range(0.04, 0.13), atk: 6e-4,
      filter: 'bandpass', ff0: f, fq: 3,
    });
  }
  grains(ctx, dest, sh, R, t, {
    count: 5, t0: 0.01, t1: 0.24, f0: 4000, f1: 9000, gMin: 0.02, gMax: 0.05,
    dMin: 0.008, dMax: 0.02, q: 9,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 190, f1: 110, sweep: 0.04, dur: 0.05, gain: 0.14,
  });
}

/* ------------------------------------------------------------------ *
 * Flesh / feedback.
 * ------------------------------------------------------------------ */

function fleshHit(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.10);
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'lowpass', f0: 950 * p, f1: 240, sweep: 0.055, q: 1.6,
    dur: 0.075, gain: 0.60, atk: 8e-4, drive: 1.6,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 135 * p, f1: 60, sweep: 0.07, dur: 0.10, gain: 0.50,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.006, {
    type: 'bandpass', f0: 1450 * p, q: 3.2, dur: 0.045, gain: 0.20, atk: 1e-3,
  });
}

function headshot(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.05);
  // Sharper crack than a body hit...
  noiseLayer(ctx, dest, sh, R, t, {
    hp: 3400, dur: 0.013, gain: 0.72, atk: 3e-4,
  });
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'lowpass', f0: 2400 * p, f1: 420, sweep: 0.045, q: 4.5,
    dur: 0.06, gain: 0.52, atk: 5e-4, drive: 2.0,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 155 * p, f1: 68, sweep: 0.06, dur: 0.09, gain: 0.46,
  });
  // ...and a short high ring that says "that one counted".
  toneLayer(ctx, dest, sh, R, t + 0.004, {
    type: 'sine', f0: 3150 * p, dur: 0.19, gain: 0.15, atk: 1.2e-3,
    filter: 'bandpass', ff0: 3150 * p, fq: 6,
  });
  toneLayer(ctx, dest, sh, R, t + 0.004, {
    type: 'sine', f0: 4720 * p, dur: 0.13, gain: 0.07, atk: 1.2e-3,
  });
}

function hitmarker(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, { hp: 5200, dur: 0.006, gain: 0.26, atk: 3e-4 });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'triangle', f0: 2350, dur: 0.020, gain: 0.34, atk: 4e-4,
    filter: 'bandpass', ff0: 2350, fq: 3.5,
  });
  toneLayer(ctx, dest, sh, R, t + 0.013, {
    type: 'triangle', f0: 3450, dur: 0.022, gain: 0.24, atk: 4e-4,
    filter: 'bandpass', ff0: 3450, fq: 3.5,
  });
}

function killConfirm(ctx, dest, t, R, sh) {
  const notes = [880, 1320, 1760];
  for (let i = 0; i < notes.length; i++) {
    toneLayer(ctx, dest, sh, R, t + i * 0.052, {
      type: 'triangle', f0: notes[i], dur: 0.13, gain: 0.20 - i * 0.03, atk: 1.5e-3,
      filter: 'lowpass', ff0: notes[i] * 3, fq: 1,
    });
  }
  noiseLayer(ctx, dest, sh, R, t + 0.02, {
    type: 'bandpass', f0: 6200, q: 1.2, dur: 0.26, gain: 0.055, atk: 0.012,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 220, f1: 150, sweep: 0.08, dur: 0.10, gain: 0.16,
  });
}

/* ------------------------------------------------------------------ *
 * Reload mechanics.
 * ------------------------------------------------------------------ */

function magOut(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.07);
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 1650 * p, q: 7, dur: 0.035, gain: 0.50, atk: 4e-4,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.004, {
    type: 'lowpass', f0: 760, f1: 300, sweep: 0.04, q: 2.2, dur: 0.05, gain: 0.32, atk: 8e-4,
  });
  toneLayer(ctx, dest, sh, R, t + 0.006, {
    type: 'sine', f0: 2450 * p, dur: 0.09, gain: 0.065, atk: 1e-3,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.05, {
    type: 'bandpass', f0: 2100 * p, q: 5, dur: 0.05, gain: 0.10, atk: 3e-3,
  });
}

function magIn(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.07);
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 900, f1: 1600, sweep: 0.03, q: 3, dur: 0.032, gain: 0.16, atk: 3e-3,
  });
  const seat = t + 0.048;
  noiseLayer(ctx, dest, sh, R, seat, {
    type: 'bandpass', f0: 1250 * p, q: 6, dur: 0.030, gain: 0.58, atk: 4e-4,
  });
  noiseLayer(ctx, dest, sh, R, seat, {
    type: 'lowpass', f0: 900, f1: 190, sweep: 0.05, q: 2.6, dur: 0.07, gain: 0.48,
    atk: 6e-4, drive: 1.5,
  });
  toneLayer(ctx, dest, sh, R, seat, {
    type: 'sine', f0: 175, f1: 105, sweep: 0.05, dur: 0.07, gain: 0.22,
  });
}

function boltBack(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.06);
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 820 * p, f1: 2500 * p, sweep: 0.065, q: 4.5,
    dur: 0.055, hold: 0.015, gain: 0.28, atk: 3e-3,
  });
  const stop = t + 0.078;
  noiseLayer(ctx, dest, sh, R, stop, { hp: 3200, dur: 0.011, gain: 0.42, atk: 3e-4 });
  toneLayer(ctx, dest, sh, R, stop, {
    type: 'sine', f0: 2900 * p, dur: 0.055, gain: 0.11, atk: 6e-4,
  });
  noiseLayer(ctx, dest, sh, R, stop, {
    type: 'lowpass', f0: 1100, f1: 420, sweep: 0.03, q: 2, dur: 0.035, gain: 0.24, atk: 6e-4,
  });
}

function boltForward(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.06);
  noiseLayer(ctx, dest, sh, R, t, { hp: 2900, dur: 0.010, gain: 0.58, atk: 3e-4 });
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 1550 * p, q: 5.5, dur: 0.032, gain: 0.54, atk: 4e-4,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.002, {
    type: 'lowpass', f0: 1000, f1: 175, sweep: 0.05, q: 2.8, dur: 0.06, gain: 0.44,
    atk: 6e-4, drive: 1.6,
  });
  toneLayer(ctx, dest, sh, R, t + 0.002, {
    type: 'sine', f0: 3250 * p, dur: 0.10, gain: 0.095, atk: 8e-4,
  });
}

function weaponSwitch(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'lowpass', f0: 1600, f1: 480, sweep: 0.11, q: 1.1,
    dur: 0.12, gain: 0.20, atk: 0.028,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.10, {
    type: 'bandpass', f0: 1850 * (1 + R.jit(0.08)), q: 6, dur: 0.028, gain: 0.34, atk: 4e-4,
  });
  toneLayer(ctx, dest, sh, R, t + 0.10, {
    type: 'sine', f0: 2700, dur: 0.06, gain: 0.07, atk: 8e-4,
  });
}

function dryfire(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, { hp: 2700, dur: 0.008, gain: 0.38, atk: 3e-4 });
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 1950 * (1 + R.jit(0.05)), q: 8, dur: 0.032, gain: 0.30, atk: 4e-4,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 320, f1: 210, sweep: 0.02, dur: 0.025, gain: 0.11,
  });
}

function reloadTail(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'lowpass', f0: 1400, f1: 500, sweep: 0.10, q: 1,
    dur: 0.11, gain: 0.10, atk: 0.02,
  });
  for (let i = 0; i < 3; i++) {
    const at = t + R.range(0.01, 0.22);
    noiseLayer(ctx, dest, sh, R, at, {
      type: 'bandpass', f0: R.range(2200, 4400), q: 10,
      dur: R.range(0.03, 0.07), gain: R.range(0.05, 0.10), atk: 5e-4,
    });
  }
}

function shellDrop(ctx, dest, t, R, sh) {
  const f = R.range(2600, 4600);
  noiseLayer(ctx, dest, sh, R, t, { hp: 4000, dur: 0.005, gain: 0.16, atk: 3e-4 });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: f, f1: f * 0.99, sweep: 0.08, dur: 0.10, gain: 0.13, atk: 5e-4,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: f * 2.37, dur: 0.06, gain: 0.06, atk: 5e-4,
  });
  // A second, quieter bounce.
  const b = t + R.range(0.06, 0.12);
  toneLayer(ctx, dest, sh, R, b, {
    type: 'sine', f0: f * 1.01, dur: 0.06, gain: 0.055, atk: 5e-4,
  });
}

function grenadeBounce(ctx, dest, t, R, sh) {
  const f = R.range(1450, 2700);
  noiseLayer(ctx, dest, sh, R, t, { hp: 3400, dur: 0.006, gain: 0.24, atk: 3e-4 });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: f, f1: f * 0.985, sweep: 0.1, dur: 0.13, gain: 0.30, atk: 5e-4,
    filter: 'bandpass', ff0: f, fq: 11,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: f * 2.62, dur: 0.07, gain: 0.10, atk: 5e-4,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 225, f1: 120, sweep: 0.04, dur: 0.055, gain: 0.20,
  });
}

function pinPull(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 1800, f1: 3100, sweep: 0.055, q: 6,
    dur: 0.055, gain: 0.22, atk: 2.5e-3,
  });
  toneLayer(ctx, dest, sh, R, t + 0.01, {
    type: 'sine', f0: 3400, dur: 0.08, gain: 0.10, atk: 8e-4,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.09, { hp: 3000, dur: 0.008, gain: 0.28, atk: 3e-4 });
  toneLayer(ctx, dest, sh, R, t + 0.09, {
    type: 'sine', f0: 2200, dur: 0.05, gain: 0.09, atk: 6e-4,
  });
}

/* ------------------------------------------------------------------ *
 * Movement / player.
 * ------------------------------------------------------------------ */

function footstepConcrete(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.14);
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'lowpass', f0: 2700 * p, f1: 680 * p, sweep: 0.035, q: 1.6,
    dur: 0.045, gain: 0.42, atk: 1e-3,
  });
  noiseLayer(ctx, dest, sh, R, t, { hp: 4200, dur: 0.006, gain: 0.14, atk: 3e-4 });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 128 * p, f1: 72, sweep: 0.03, dur: 0.04, gain: 0.13,
  });
  grains(ctx, dest, sh, R, t, {
    count: 2, t0: 0.008, t1: 0.06, f0: 2600, f1: 5200, gMin: 0.012, gMax: 0.03,
  });
}

function footstepDirt(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.16);
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'lowpass', f0: 1200 * p, f1: 300, sweep: 0.06, q: 0.9,
    dur: 0.075, gain: 0.44, atk: 3e-3,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 98 * p, f1: 56, sweep: 0.035, dur: 0.05, gain: 0.15,
  });
  grains(ctx, dest, sh, R, t, {
    count: 3, t0: 0.006, t1: 0.09, f0: 1800, f1: 3600, gMin: 0.014, gMax: 0.035,
  });
}

function land(ctx, dest, t, R, sh) {
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 96, f1: 42, sweep: 0.10, dur: 0.16, gain: 0.60, drive: 1.4,
  });
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'lowpass', f0: 1800, f1: 280, sweep: 0.07, q: 1.8,
    dur: 0.10, gain: 0.44, atk: 1e-3, drive: 1.8,
  });
  for (let i = 0; i < 3; i++) {
    noiseLayer(ctx, dest, sh, R, t + R.range(0.015, 0.13), {
      type: 'bandpass', f0: R.range(1700, 3400), q: 9,
      dur: R.range(0.03, 0.06), gain: R.range(0.04, 0.08), atk: 5e-4,
    });
  }
}

function jump(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'lowpass', f0: 1900, f1: 620, sweep: 0.10, q: 1,
    dur: 0.10, gain: 0.17, atk: 0.018,
  });
  noiseLayer(ctx, dest, sh, R, t, { hp: 2400, dur: 0.028, gain: 0.09, atk: 1.5e-3 });
  toneLayer(ctx, dest, sh, R, t + 0.01, {
    type: 'sawtooth', f0: 178, f1: 138, sweep: 0.09, dur: 0.10, gain: 0.085,
    atk: 8e-3, filter: 'lowpass', ff0: 900, ff1: 480, fq: 2.4,
  });
}

function hurt(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.10);
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'bandpass', f0: 760 * p, f1: 380, sweep: 0.16, q: 1.4,
    dur: 0.19, gain: 0.26, atk: 0.011,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sawtooth', f0: 172 * p, f1: 122, sweep: 0.13, dur: 0.16, gain: 0.13,
    atk: 6e-3, filter: 'lowpass', ff0: 860, ff1: 420, fq: 2.6,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 122 * p, f1: 58, sweep: 0.05, dur: 0.07, gain: 0.24,
  });
}

function death(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'bandpass', f0: 940, f1: 200, sweep: 0.62, q: 1.1,
    dur: 0.70, gain: 0.27, atk: 0.045,
  });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sawtooth', f0: 190, f1: 62, sweep: 0.60, dur: 0.66, gain: 0.14,
    atk: 0.02, filter: 'lowpass', ff0: 780, ff1: 260, fq: 2.2,
  });
  const thud = t + 0.34;
  toneLayer(ctx, dest, sh, R, thud, {
    type: 'sine', f0: 112, f1: 42, sweep: 0.13, dur: 0.20, gain: 0.42, drive: 1.4,
  });
  noiseLayer(ctx, dest, sh, R, thud, {
    noise: 'pink', type: 'lowpass', f0: 1400, f1: 260, sweep: 0.09, q: 1.6,
    dur: 0.11, gain: 0.30, atk: 1.2e-3,
  });
  for (let i = 0; i < 4; i++) {
    noiseLayer(ctx, dest, sh, R, thud + R.range(0.01, 0.22), {
      type: 'bandpass', f0: R.range(1800, 3800), q: 10,
      dur: R.range(0.03, 0.07), gain: R.range(0.03, 0.07), atk: 5e-4,
    });
  }
}

function whizby(ctx, dest, t, R, sh) {
  const p = 1 + R.jit(0.16);
  // Doppler-ish: bandpass centre sweeps down hard as the round passes the ear.
  noiseLayer(ctx, dest, sh, R, t, {
    type: 'bandpass', f0: 3800 * p, f1: 680 * p, sweep: 0.15, q: 3.6,
    dur: 0.11, gain: 0.34, atk: 0.045,
  });
  toneLayer(ctx, dest, sh, R, t + 0.01, {
    type: 'sine', f0: 2300 * p, f1: 620, sweep: 0.13, dur: 0.10, gain: 0.06, atk: 0.035,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.12, {
    hp: 1900, dur: 0.035, gain: 0.09, atk: 1.5e-3,
  });
}

function lowAmmo(ctx, dest, t, R, sh) {
  for (let i = 0; i < 2; i++) {
    const at = t + i * 0.13;
    noiseLayer(ctx, dest, sh, R, at, { hp: 5000, dur: 0.005, gain: 0.11, atk: 3e-4 });
    toneLayer(ctx, dest, sh, R, at, {
      type: 'triangle', f0: 2650, dur: 0.035, gain: 0.20, atk: 5e-4,
      filter: 'bandpass', ff0: 2650, fq: 7,
    });
  }
}

/* ------------------------------------------------------------------ *
 * UI.
 * ------------------------------------------------------------------ */

function uiClick(ctx, dest, t, R, sh) {
  noiseLayer(ctx, dest, sh, R, t, { hp: 4200, dur: 0.005, gain: 0.13, atk: 3e-4 });
  toneLayer(ctx, dest, sh, R, t, {
    type: 'triangle', f0: 1900, dur: 0.022, gain: 0.22, atk: 5e-4,
    filter: 'bandpass', ff0: 1900, fq: 5,
  });
  toneLayer(ctx, dest, sh, R, t + 0.008, {
    type: 'sine', f0: 2850, dur: 0.02, gain: 0.09, atk: 5e-4,
  });
}

function uiHover(ctx, dest, t, R, sh) {
  toneLayer(ctx, dest, sh, R, t, {
    type: 'triangle', f0: 1280, dur: 0.018, gain: 0.10, atk: 6e-4,
    filter: 'bandpass', ff0: 1280, fq: 4,
  });
  noiseLayer(ctx, dest, sh, R, t, { hp: 5600, dur: 0.004, gain: 0.045, atk: 3e-4 });
}

function uiBack(ctx, dest, t, R, sh) {
  toneLayer(ctx, dest, sh, R, t, {
    type: 'triangle', f0: 940, dur: 0.032, gain: 0.17, atk: 6e-4,
    filter: 'lowpass', ff0: 2600, fq: 1,
  });
  toneLayer(ctx, dest, sh, R, t + 0.046, {
    type: 'triangle', f0: 620, dur: 0.055, gain: 0.14, atk: 8e-4,
    filter: 'lowpass', ff0: 1900, fq: 1,
  });
}

/* ------------------------------------------------------------------ *
 * Big stereo pieces.
 * ------------------------------------------------------------------ */

function explosion(ctx, dest, t, R, sh) {
  // Ignition crack.
  noiseLayer(ctx, dest, sh, R, t, { hp: 2400, dur: 0.022, gain: 0.80, atk: 3e-4 });

  // Blast body — heavily saturated pink noise collapsing to a sub-bass roar.
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'lowpass', f0: 2800, f1: 105, sweep: 0.42, q: 1.5,
    dur: 0.55, gain: 0.90, atk: 1.2e-3, drive: 2.8,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.004, {
    type: 'bandpass', f0: 430, f1: 190, sweep: 0.6, q: 0.7,
    dur: 0.80, gain: 0.30, atk: 6e-3,
  });

  // The sub drop you feel in your chest.
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 98, f1: 26, sweep: 0.65, dur: 1.05, gain: 0.92, atk: 2e-3, drive: 1.3,
  });
  toneLayer(ctx, dest, sh, R, t + 0.02, {
    type: 'triangle', f0: 62, f1: 21, sweep: 0.9, dur: 1.30, gain: 0.36, atk: 8e-3,
  });

  // Debris scatter, thrown wide.
  grains(ctx, dest, sh, R, t, {
    count: 20, t0: 0.10, t1: 1.9, f0: 500, f1: 4800,
    gMin: 0.022, gMax: 0.085, dMin: 0.015, dMax: 0.05, q: 7, spread: 0.9,
  });

  // Decorrelated tail: two noise beds panned hard apart give it real width.
  for (let i = 0; i < 2; i++) {
    noiseLayer(ctx, dest, sh, R, t + 0.05, {
      noise: 'pink', type: 'bandpass', f0: 560, f1: 175, sweep: 1.9, q: 0.6,
      dur: 2.10, gain: 0.15, atk: 0.055, pan: i === 0 ? -0.72 : 0.72,
    });
  }
  noiseLayer(ctx, dest, sh, R, t + 0.03, {
    noise: 'pink', type: 'lowpass', f0: 240, f1: 70, sweep: 1.8, q: 1.1,
    dur: 2.25, gain: 0.22, atk: 0.10,
  });
}

function streakReady(ctx, dest, t, R, sh) {
  const notes = [440, 554.4, 659.3, 880];
  for (let i = 0; i < notes.length; i++) {
    const at = t + i * 0.115;
    toneLayer(ctx, dest, sh, R, at, {
      type: 'sawtooth', f0: notes[i], dur: 0.34, gain: 0.115, atk: 5e-3,
      filter: 'lowpass', ff0: 700, ff1: 5200, fsweep: 0.3, fq: 3.5,
      pan: -0.4 + i * 0.27,
    });
    toneLayer(ctx, dest, sh, R, at, {
      type: 'sine', f0: notes[i] * 2, dur: 0.20, gain: 0.045, atk: 4e-3,
    });
  }
  toneLayer(ctx, dest, sh, R, t + 0.24, {
    type: 'sine', f0: 82, f1: 41, sweep: 0.25, dur: 0.40, gain: 0.34,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.1, {
    type: 'bandpass', f0: 5200, q: 1.1, dur: 0.55, gain: 0.05, atk: 0.14,
  });
}

function matchStart(ctx, dest, t, R, sh) {
  // Rising swell...
  for (let i = 0; i < 2; i++) {
    toneLayer(ctx, dest, sh, R, t, {
      type: 'sawtooth', f0: i === 0 ? 55 : 82.4, dur: 0.55, hold: 0.35, gain: 0.115,
      atk: 0.42, filter: 'lowpass', ff0: 170, ff1: 1000, fsweep: 0.85, fq: 4,
      pan: i === 0 ? -0.35 : 0.35,
    });
  }
  noiseLayer(ctx, dest, sh, R, t, {
    noise: 'pink', type: 'bandpass', f0: 420, f1: 4200, sweep: 0.85, q: 2.2,
    dur: 0.22, hold: 0.05, gain: 0.10, atk: 0.62,
  });

  // ...into the hit.
  const hit = t + 0.92;
  toneLayer(ctx, dest, sh, R, hit, {
    type: 'sine', f0: 112, f1: 33, sweep: 0.4, dur: 0.62, gain: 0.62, drive: 1.3,
  });
  noiseLayer(ctx, dest, sh, R, hit, {
    noise: 'pink', type: 'lowpass', f0: 2000, f1: 200, sweep: 0.28, q: 1.6,
    dur: 0.34, gain: 0.40, atk: 1e-3, drive: 2.2,
  });
  for (let i = 0; i < 2; i++) {
    noiseLayer(ctx, dest, sh, R, hit + 0.03, {
      noise: 'pink', type: 'bandpass', f0: 640, f1: 260, sweep: 0.75, q: 0.7,
      dur: 0.85, gain: 0.075, atk: 0.03, pan: i === 0 ? -0.65 : 0.65,
    });
  }
}

function matchEnd(ctx, dest, t, R, sh) {
  toneLayer(ctx, dest, sh, R, t, {
    type: 'sine', f0: 92, f1: 32, sweep: 0.55, dur: 0.85, gain: 0.50,
  });
  for (let i = 0; i < 2; i++) {
    toneLayer(ctx, dest, sh, R, t + 0.02, {
      type: 'sawtooth', f0: i === 0 ? 220 : 164.8, f1: i === 0 ? 110 : 82.4, sweep: 1.25,
      dur: 1.30, gain: 0.10, atk: 0.12,
      filter: 'lowpass', ff0: 1500, ff1: 300, fsweep: 1.2, fq: 2.4,
      pan: i === 0 ? -0.45 : 0.45,
    });
  }
  toneLayer(ctx, dest, sh, R, t + 0.52, {
    type: 'triangle', f0: 329.6, dur: 0.50, gain: 0.11, atk: 8e-3,
    filter: 'lowpass', ff0: 2200, fq: 1,
  });
  toneLayer(ctx, dest, sh, R, t + 0.88, {
    type: 'triangle', f0: 246.9, dur: 0.62, gain: 0.10, atk: 8e-3,
    filter: 'lowpass', ff0: 1800, fq: 1,
  });
  noiseLayer(ctx, dest, sh, R, t + 0.05, {
    noise: 'pink', type: 'bandpass', f0: 430, f1: 190, sweep: 1.4, q: 0.7,
    dur: 1.55, gain: 0.065, atk: 0.06,
  });
}

/* ------------------------------------------------------------------ *
 * The bank manifest.
 * ------------------------------------------------------------------ */

/**
 * Each entry is normalised to its `peak` after rendering. Authoring loudness this way
 * rather than by hand-balancing layer gains means a narrow bandpass layer (which throws
 * away most of its noise energy) still lands where the mix expects it, and the relative
 * levels below are the actual mix balance rather than an accident of filter design.
 *
 * @type {{name:string,dur:number,variants:number,peak:number,stereo:boolean,build:Function}[]}
 */
const SPECS = [];

function spec(name, dur, variants, build, peak, stereo) {
  SPECS.push({ name, dur, variants, build, peak, stereo: !!stereo });
}

for (const id of Object.keys(GUN_PARAMS)) {
  spec(id, GUN_PARAMS[id].dur, 3, gunBuilder(GUN_PARAMS[id]), 0.92);
}

spec('impactConcrete', 0.34, 3, impactConcrete, 0.62);
spec('impactMetal', 0.44, 3, impactMetal, 0.66);
spec('impactWood', 0.30, 3, impactWood, 0.60);
spec('impactDirt', 0.28, 3, impactDirt, 0.50);
spec('impactSand', 0.26, 3, impactSand, 0.42);
spec('impactGlass', 0.46, 3, impactGlass, 0.62);

spec('fleshHit', 0.30, 3, fleshHit, 0.72);
spec('headshot', 0.38, 2, headshot, 0.88);
spec('hitmarker', 0.10, 2, hitmarker, 0.60);
spec('killConfirm', 0.44, 1, killConfirm, 0.58);

spec('magOut', 0.24, 2, magOut, 0.50);
spec('magIn', 0.28, 2, magIn, 0.54);
spec('boltBack', 0.24, 2, boltBack, 0.48);
spec('boltForward', 0.24, 2, boltForward, 0.54);
spec('switch', 0.30, 2, weaponSwitch, 0.42);
spec('dryfire', 0.14, 2, dryfire, 0.46);
spec('reloadTail', 0.38, 2, reloadTail, 0.30);
spec('shellDrop', 0.28, 3, shellDrop, 0.30);

spec('grenadeBounce', 0.30, 3, grenadeBounce, 0.52);
spec('pinPull', 0.30, 2, pinPull, 0.40);

spec('footstepConcrete', 0.18, 4, footstepConcrete, 0.38);
spec('footstepDirt', 0.22, 4, footstepDirt, 0.34);
spec('land', 0.40, 2, land, 0.72);
spec('jump', 0.30, 2, jump, 0.28);
spec('hurt', 0.44, 3, hurt, 0.56);
spec('death', 1.15, 2, death, 0.62);

spec('whizby', 0.32, 3, whizby, 0.58);
spec('lowAmmo', 0.32, 1, lowAmmo, 0.44);

spec('uiClick', 0.10, 2, uiClick, 0.40);
spec('uiHover', 0.08, 2, uiHover, 0.22);
spec('uiBack', 0.18, 1, uiBack, 0.38);

spec('explosion', 3.05, 2, explosion, 0.95, true);
spec('streakReady', 1.30, 1, streakReady, 0.70, true);
spec('matchStart', 2.05, 1, matchStart, 0.86, true);
spec('matchEnd', 2.45, 1, matchEnd, 0.70, true);

/** Every sound name the bank produces (aliases included). */
export const SOUND_NAMES = SPECS.map((s) => s.name).concat(['hitmarkerHeadshot']);

/** ARCHITECTURE.md §9 required names — asserted after render. */
export const REQUIRED_SOUNDS = [
  'rifle', 'smg', 'sniper', 'shotgun', 'pistol', 'lmg', 'dryfire',
  'magOut', 'magIn', 'boltBack', 'boltForward', 'switch', 'impactConcrete', 'impactMetal',
  'impactDirt', 'impactWood', 'impactGlass', 'fleshHit', 'headshot', 'hitmarker',
  'explosion', 'grenadeBounce', 'pinPull', 'footstepConcrete', 'footstepDirt', 'land',
  'jump', 'hurt', 'death', 'killConfirm', 'uiClick', 'uiHover', 'uiBack', 'matchStart',
  'matchEnd', 'whizby', 'reloadTail', 'lowAmmo', 'streakReady',
];

/* ------------------------------------------------------------------ *
 * Batch renderer.
 * ------------------------------------------------------------------ */

/**
 * Give the event loop a real turn.
 *
 * `await Promise.resolve()` would only drain a microtask, which does not end the current
 * task and so would not break up a long block at all.
 *
 * `setTimeout` is deliberately *not* the mechanism: a hidden tab has its timers throttled
 * to one per second, and to one per minute after five minutes, so a player who alt-tabs
 * while the bank is rendering would stall audio init for minutes. `MessageChannel` is
 * exempt from timer throttling and fires as soon as the current task ends, so it costs
 * task boundaries and nothing else. The timer is kept only as a last resort.
 */
const _yieldChannel = (() => {
  try {
    if (typeof MessageChannel !== 'function') return null;
    const ch = new MessageChannel();
    const queue = [];
    ch.port1.onmessage = () => { const fn = queue.shift(); if (fn) fn(); };
    ch.port1.start?.();
    return { queue, post: () => ch.port2.postMessage(0) };
  } catch {
    return null;
  }
})();

function yieldToEventLoop() {
  if (_yieldChannel) {
    return new Promise((resolve) => {
      _yieldChannel.queue.push(resolve);
      _yieldChannel.post();
    });
  }
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

function getOfflineCtor() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  return g.OfflineAudioContext || g.webkitOfflineAudioContext || null;
}

function startRendering(ctx) {
  // Safari's older implementation resolves through `oncomplete` instead of a promise.
  let p;
  try {
    p = ctx.startRendering();
  } catch (e) {
    return Promise.reject(e);
  }
  if (p && typeof p.then === 'function') return p;
  return new Promise((resolve, reject) => {
    ctx.oncomplete = (ev) => resolve(ev.renderedBuffer);
    setTimeout(() => reject(new Error('offline render timed out')), 15000);
  });
}

/**
 * Renders one chunk of slots as a single timeline, then slices it back apart.
 * @returns {Promise<{name:string, buffer:AudioBuffer}[]>}
 */
async function renderChunk(slots, channels, sampleRate, OAC) {
  const out = [];

  let cursor = 0.02;
  for (const slot of slots) {
    slot.start = cursor;
    slot.dur = slot.spec.dur;
    cursor += slot.dur + SLOT_PAD;
  }
  const frames = Math.ceil((cursor + 0.15) * sampleRate);

  const ctx = new OAC(channels, frames, sampleRate);
  const shared = makeShared(ctx);

  for (const slot of slots) {
    // A per-slot gate guarantees nothing bleeds into the next slot's window.
    const gate = ctx.createGain();
    gate.gain.setValueAtTime(1, slot.start);
    gate.gain.setValueAtTime(1, slot.start + slot.dur - 0.006);
    gate.gain.linearRampToValueAtTime(0, slot.start + slot.dur);
    gate.connect(ctx.destination);
    try {
      slot.spec.build(ctx, gate, slot.start, makeRng(slot.seed), shared);
    } catch (err) {
      console.warn(`[synth] "${slot.spec.name}" failed to build`, err);
    }
  }

  const rendered = await startRendering(ctx);

  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(rendered.getChannelData(c));

  for (const slot of slots) {
    const i0 = Math.floor(slot.start * sampleRate);
    const iMax = Math.min(chans[0].length, i0 + Math.ceil(slot.dur * sampleRate));

    let peak = 0;
    for (let c = 0; c < channels; c++) {
      const d = chans[c];
      for (let i = i0; i < iMax; i++) {
        const a = d[i] < 0 ? -d[i] : d[i];
        if (a > peak) peak = a;
      }
    }

    // Trim the trailing silence, relative to this slot's own peak (~ -74 dB).
    const floor = Math.max(TRIM_FLOOR, peak * 2e-4);
    let end = iMax;
    while (end > i0 + 64) {
      let quiet = true;
      for (let c = 0; c < channels; c++) {
        if (Math.abs(chans[c][end - 1]) > floor) { quiet = false; break; }
      }
      if (!quiet) break;
      end--;
    }

    const len = Math.max(64, end - i0);
    // Normalise to the authored level. Everything stays below unity so a full firefight
    // has headroom before the master limiter has to work. The boost is capped so a
    // near-silent render can never be amplified into a wall of noise.
    const target = slot.spec.peak || 0.9;
    const norm = peak > 1e-5 ? Math.min(target / peak, 12) : 1;
    // Short fade-out in case the trim landed mid-cycle.
    const fade = Math.min(64, (len / 4) | 0);

    const buf = ctx.createBuffer(channels, len, sampleRate);
    for (let c = 0; c < channels; c++) {
      const src = chans[c];
      const dst = buf.getChannelData(c);
      for (let i = 0; i < len; i++) dst[i] = src[i0 + i] * norm;
      for (let i = 0; i < fade; i++) dst[len - 1 - i] *= i / fade;
    }

    out.push({ name: slot.spec.name, buffer: buf });
  }

  return out;
}

/**
 * Expands specs into slots, packs them into short chunks and renders those concurrently.
 *
 * Chunking is the whole performance story here. An offline graph is pulled once per
 * 128-sample quantum and every still-connected node is visited, so the cost of one big
 * timeline scales with (node count x length) — quadratic in the size of the bank. Slicing
 * the same work into ~3 s chunks turns a ~2.7 s boot into a ~200 ms one.
 *
 * @returns {Promise<Map<string, AudioBuffer[]>>}
 */
async function renderBatch(specs, channels, sampleRate) {
  const out = new Map();
  if (!specs.length) return out;

  const OAC = getOfflineCtor();
  if (!OAC) return out;

  let seed = channels === 1 ? 0x1f2e3d4c : 0x7a6b5c4d;
  const chunks = [];
  let cur = [];
  let curDur = 0;
  for (const s of specs) {
    for (let v = 0; v < s.variants; v++) {
      if (cur.length >= MAX_SLOTS_PER_CHUNK || (cur.length && curDur + s.dur > MAX_CHUNK_SECONDS)) {
        chunks.push(cur);
        cur = [];
        curDur = 0;
      }
      seed = (seed * 1664525 + 1013904223) >>> 0;
      cur.push({ spec: s, seed, start: 0, dur: s.dur });
      curDur += s.dur + SLOT_PAD;
    }
  }
  if (cur.length) chunks.push(cur);

  // Building a chunk's graph is pure main-thread work, and `renderChunk` runs synchronously
  // up to its first `await`. Mapping every chunk at once therefore built all ~16 graphs
  // inside one uninterrupted task. Yielding between builds keeps each block short. The
  // renders themselves still overlap: each is started as it is built and they are all
  // awaited together below, so wall-clock time is unaffected.
  const pending = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await yieldToEventLoop();
    pending.push(renderChunk(chunks[i], channels, sampleRate, OAC).catch((err) => {
      console.warn('[synth] chunk render failed', err);
      return [];
    }));
  }
  const rendered = await Promise.all(pending);

  // Chunks are consumed in order, so variants stay in a stable, deterministic sequence.
  for (const chunk of rendered) {
    for (const { name, buffer } of chunk) {
      let arr = out.get(name);
      if (!arr) out.set(name, (arr = []));
      arr.push(buffer);
    }
  }

  return out;
}

/**
 * Renders the whole bank. Never throws — a failure yields an empty/partial map and the
 * engine degrades to silence rather than taking the game down with it.
 * @returns {Promise<Map<string, AudioBuffer[]>>}
 */
export async function renderSoundBank(opts = {}) {
  const sampleRate = opts.sampleRate || SYNTH_SAMPLE_RATE;
  const bank = new Map();

  const monoSpecs = SPECS.filter((s) => !s.stereo);
  const stereoSpecs = SPECS.filter((s) => s.stereo);

  const results = await Promise.all([
    renderBatch(monoSpecs, 1, sampleRate).catch((e) => {
      console.warn('[synth] mono batch failed', e);
      return new Map();
    }),
    renderBatch(stereoSpecs, 2, sampleRate).catch((e) => {
      console.warn('[synth] stereo batch failed', e);
      return new Map();
    }),
  ]);

  for (const r of results) for (const [k, v] of r) bank.set(k, v);

  // The headshot confirm doubles as the "better" headshot hitmarker.
  const hs = bank.get('headshot');
  if (hs) bank.set('hitmarkerHeadshot', hs);

  return bank;
}

/* ------------------------------------------------------------------ *
 * Impulse responses — written sample-by-sample, no context render needed.
 * ------------------------------------------------------------------ */

const IR_DEFS = {
  // Tight interior: a stairwell / bunker room. Dense, bright, gone fast.
  indoor: {
    dur: 0.36, tau: 0.075, lp: 5400, hp: 220, target: 1.05, spread: 0.0009,
    taps: [[0.006, 0.55], [0.011, -0.44], [0.018, 0.36], [0.026, -0.27], [0.037, 0.20]],
  },
  // Open ground with hard surfaces at a distance: a distinct slap-back.
  outdoor: {
    dur: 0.95, tau: 0.17, lp: 3000, hp: 150, target: 1.25, spread: 0.0026, thin: 0.55,
    taps: [[0.022, 0.50], [0.049, -0.42], [0.081, 0.33], [0.121, -0.23], [0.176, 0.15]],
  },
  // Big concrete volume: hangar / parking structure. Long, dark, and a bit fearsome.
  concrete: {
    dur: 2.10, tau: 0.58, lp: 1900, hp: 85, target: 1.45, spread: 0.0038, build: 0.02,
    taps: [[0.014, 0.40], [0.031, -0.34], [0.055, 0.29], [0.090, -0.22], [0.142, 0.17], [0.212, -0.12]],
  },
};

function onePoleLowpass(d, sr, cutoff) {
  const a = Math.exp((-2 * Math.PI * cutoff) / sr);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    y = (1 - a) * d[i] + a * y;
    d[i] = y;
  }
}

function onePoleHighpass(d, sr, cutoff) {
  const a = Math.exp((-2 * Math.PI * cutoff) / sr);
  let y = 0;
  for (let i = 0; i < d.length; i++) {
    y = (1 - a) * d[i] + a * y;
    d[i] -= y;
  }
}

function buildIR(ctx, def, seed) {
  const sr = ctx.sampleRate;
  const len = Math.max(64, Math.floor(def.dur * sr));
  const buf = ctx.createBuffer(2, len, sr);

  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const r = mulberry32(seed + c * 0x9e3779b9);
    const build = def.build || 0;

    // exp(-t/tau) with t = i/sr is a geometric series, so one multiply per sample replaces
    // a `Math.exp()` per sample — this loop runs 327 k times and lands on the first user
    // click. The decay is advanced on every iteration, including the ones the `thin` test
    // skips, so the envelope stays a function of `i` exactly as it was before.
    const decayPerSample = Math.exp(-1 / (def.tau * sr));
    let env = 1;

    for (let i = 0; i < len; i++) {
      const e = env;
      env *= decayPerSample;
      // Sparse taps for the outdoor slap keep it from turning into a wash.
      if (def.thin && r() > def.thin) continue;
      let amp = e;
      if (build > 0) {
        const t = i / sr;
        if (t < build) amp *= t / build;
      }
      d[i] = (r() * 2 - 1) * amp;
    }

    onePoleLowpass(d, sr, def.lp);
    onePoleHighpass(d, sr, def.hp);

    // Early reflections. A small per-channel time offset decorrelates the stereo image.
    for (const [tapT, tapG] of def.taps) {
      const off = tapT + (c === 0 ? -def.spread : def.spread) * (0.6 + r());
      const idx = Math.floor(off * sr);
      if (idx < 2 || idx >= len - 3) continue;
      const g = tapG * (0.85 + r() * 0.3);
      d[idx - 1] += g * 0.35;
      d[idx] += g;
      d[idx + 1] += g * 0.35;
    }

    // Fade the very tail so the convolver never clicks out.
    const fade = Math.min(len >> 2, Math.floor(0.02 * sr));
    for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade;
  }

  // Energy-normalise so the send return gains mean the same thing for every space.
  let sumSq = 0;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) sumSq += d[i] * d[i];
  }
  const rms = Math.sqrt(sumSq) || 1;
  const scale = def.target / rms;
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] *= scale;
  }

  return buf;
}

/**
 * Three convolution spaces for the reverb sends. Cheap enough (~5 ms total) to build on
 * the live context the moment it exists.
 * @returns {{indoor:AudioBuffer, outdoor:AudioBuffer, concrete:AudioBuffer}|null}
 */
export function createImpulseResponses(ctx) {
  if (!ctx || typeof ctx.createBuffer !== 'function') return null;
  try {
    return {
      indoor: buildIR(ctx, IR_DEFS.indoor, 0x1234abcd),
      outdoor: buildIR(ctx, IR_DEFS.outdoor, 0x51de2f01),
      concrete: buildIR(ctx, IR_DEFS.concrete, 0xc0ffee11),
    };
  } catch (err) {
    console.warn('[synth] impulse responses failed', err);
    return null;
  }
}
