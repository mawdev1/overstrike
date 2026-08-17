/**
 * OVERSTRIKE — audio verification / measurement probe.
 *
 * Four modes, all driven through headless Chromium so the numbers come from a real
 * Web Audio implementation rather than a simulation:
 *
 *   --mode=fingerprint   Render the whole sound bank in an OfflineAudioContext and dump
 *                        per-sound summary statistics (peak, RMS, duration, an 8-band
 *                        spectral fingerprint, stereo width and an exact content hash),
 *                        plus the same for the three reverb impulse responses.
 *                        This is the "did the sounds change?" oracle.
 *   --mode=bench         Micro-benchmarks: sound-bank render time (C3), impulse-response
 *                        build time (C4), panner construction cost and listener-write
 *                        cost, and audio-thread render capacity for 28 concurrent voices
 *                        with HRTF vs equalpower panning (B1).
 *   --mode=load          Boots the real game, starts a match, drives a heavy firefight and
 *                        samples concurrent voice count + audio-thread load + main-thread
 *                        cost (B1 in situ).
 *   --mode=b2            Voice-stealing regression test: plays a barrage of long
 *                        rate-shifted explosions, then fires many bot rifles and asserts
 *                        the gunshots still get voices (B2).
 *   --mode=all           fingerprint + bench + load + b2 in ONE browser session.
 *
 * Results are written to `perf/audio-<mode>-<tag>.json`.
 *
 * Usage:
 *   node scripts/audioprobe.mjs --mode=all --tag=before
 *   node scripts/audioprobe.mjs --mode=all --tag=after
 *   node scripts/audioprobe.mjs --diff=before,after
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, report } from './auditlib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'perf');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const MODE = arg('mode', 'fingerprint');
const TAG = arg('tag', 'current');
const DIFF = arg('diff', null);

/* ================================================================== *
 * Page-side payloads. These are stringified into the browser, so they
 * must be self-contained.
 * ================================================================== */

/**
 * Shared analysis helpers injected into the page once.
 * Defines window.__AP__ = { fft, statsFor, BANDS }.
 */
function installAnalysis() {
  const BANDS = [
    [0, 100], [100, 250], [250, 500], [500, 1000],
    [1000, 2000], [2000, 4000], [4000, 8000], [8000, 24000],
  ];

  /** In-place iterative radix-2 FFT. re/im are Float64Array of length n (power of two). */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  /** FNV-1a over the raw float32 bytes — exact-identity oracle. */
  function hashChannels(chans) {
    let h = 0x811c9dc5;
    for (const c of chans) {
      const bytes = new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
      for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return h.toString(16).padStart(8, '0');
  }

  const r6 = (x) => Number(x.toFixed(6));

  /** Summary statistics + coarse spectral fingerprint for one AudioBuffer. */
  function statsFor(buf) {
    const nch = buf.numberOfChannels;
    const len = buf.length;
    const sr = buf.sampleRate;
    const chans = [];
    for (let c = 0; c < nch; c++) chans.push(buf.getChannelData(c));

    let peak = 0, sumSq = 0, sumAbs = 0;
    for (const d of chans) {
      for (let i = 0; i < len; i++) {
        const v = d[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sumSq += v * v;
        sumAbs += a;
      }
    }
    const rms = Math.sqrt(sumSq / (len * nch));

    // Stereo width: RMS of the difference signal relative to the sum.
    let width = 0;
    if (nch === 2) {
      let dSq = 0;
      for (let i = 0; i < len; i++) {
        const d = chans[0][i] - chans[1][i];
        dSq += d * d;
      }
      width = Math.sqrt(dSq / len);
    }

    // Spectral fingerprint from the mono sum, zero-padded to a power of two.
    let n = 1;
    while (n < len) n <<= 1;
    if (n > 1 << 19) n = 1 << 19;      // cap: 524288 bins is plenty of resolution
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const take = Math.min(len, n);
    for (let i = 0; i < take; i++) {
      let s = 0;
      for (let c = 0; c < nch; c++) s += chans[c][i];
      re[i] = s / nch;
    }
    fft(re, im);

    const bands = new Array(BANDS.length).fill(0);
    const half = n >> 1;
    let total = 0;
    for (let k = 1; k < half; k++) {
      const f = (k * sr) / n;
      const mag = re[k] * re[k] + im[k] * im[k];
      total += mag;
      for (let b = 0; b < BANDS.length; b++) {
        if (f >= BANDS[b][0] && f < BANDS[b][1]) { bands[b] += mag; break; }
      }
    }
    // Normalised band energies (fraction of total) — level-independent shape, plus the
    // absolute total so a pure gain change is still visible.
    const shape = bands.map((b) => (total > 0 ? r6(b / total) : 0));

    return {
      ch: nch,
      len,
      sr,
      durMs: r6((len / sr) * 1000),
      peak: r6(peak),
      rms: r6(rms),
      meanAbs: r6(sumAbs / (len * nch)),
      width: r6(width),
      energy: r6(Math.log10(total + 1e-30)),
      bands: shape,
      hash: hashChannels(chans),
    };
  }

  window.__AP__ = { fft, statsFor, hashChannels, BANDS };
}

/** Renders the sound bank + IRs and returns the full fingerprint object. */
async function pageFingerprint() {
  const synth = await import('/src/audio/synth.js');
  const { statsFor } = window.__AP__;

  const t0 = performance.now();
  const bank = await synth.renderSoundBank();
  const renderMs = performance.now() - t0;

  const sounds = {};
  for (const [name, arr] of bank) {
    sounds[name] = arr.map((b) => statsFor(b));
  }

  // Impulse responses: built on a throwaway offline context so the numbers are
  // sample-rate stable regardless of the machine's audio device.
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const irCtx = new OAC(2, 48000, 48000);
  const irs = synth.createImpulseResponses(irCtx);
  const impulses = {};
  if (irs) {
    for (const k of Object.keys(irs)) {
      impulses[k] = statsFor(irs[k]);
      // A handful of raw samples so a numerical-equivalence claim can be checked directly.
      const d = irs[k].getChannelData(0);
      const idx = [0, 1, 2, 7, 31, 127, 1024, 4096, 16384, Math.max(0, d.length - 1)];
      impulses[k].samples = idx
        .filter((i) => i < d.length)
        .map((i) => [i, Number(d[i].toPrecision(12))]);
    }
  }

  const missing = synth.REQUIRED_SOUNDS.filter((n) => !bank.has(n));

  return {
    renderMs: Number(renderMs.toFixed(2)),
    soundCount: bank.size,
    bufferCount: Object.values(sounds).reduce((a, v) => a + v.length, 0),
    missing,
    sounds,
    impulses,
  };
}

/** Micro-benchmarks for C3, C4 and B1. */
async function pageBench() {
  const synth = await import('/src/audio/synth.js');
  const out = {};
  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    return Number(s[(s.length / 2) | 0].toFixed(2));
  };

  // ---- C3: whole sound bank render (this is the audio boot cost) ----
  // Wall time is the honest number, but it also includes the offline renders themselves,
  // which run off-thread. `longTaskMs` is the part that actually blocks the main thread:
  // the longest uninterrupted synchronous stretch observed while the bank builds.
  const bankRuns = [];
  const bankBlocking = [];
  for (let i = 0; i < 5; i++) {
    let maxGap = 0;
    let last = performance.now();
    const beat = setInterval(() => {
      const n = performance.now();
      if (n - last > maxGap) maxGap = n - last;
      last = n;
    }, 4);
    const t = performance.now();
    // eslint-disable-next-line no-await-in-loop
    await synth.renderSoundBank();
    const ms = performance.now() - t;
    clearInterval(beat);
    bankRuns.push(ms);
    bankBlocking.push(maxGap);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));   // let contexts and buffers be reclaimed
  }
  out.renderSoundBankMs = {
    runs: bankRuns.map((x) => Number(x.toFixed(2))),
    first: Number(bankRuns[0].toFixed(2)),
    median: median(bankRuns),
  };
  out.renderSoundBankLongestBlockMs = {
    runs: bankBlocking.map((x) => Number(x.toFixed(2))),
    median: median(bankBlocking),
  };

  // ---- C3b: isolated cost of the shared-noise generation, version independent ----
  // 21 chunks x (2 s white + 2 s pink) at 48 kHz — what makeShared() used to redo per chunk.
  const noiseRuns = [];
  for (let run = 0; run < 3; run++) {
    const t = performance.now();
    const len = 48000 * 2;
    let sink = 0;
    for (let chunk = 0; chunk < 21; chunk++) {
      let a = 0x5eed1a7e >>> 0;
      const rng = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let x = a;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
      const w = new Float32Array(len);
      for (let i = 0; i < len; i++) w[i] = rng() * 2 - 1;
      const p = new Float32Array(len);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const x = rng() * 2 - 1;
        b0 = 0.99886 * b0 + x * 0.0555179;
        b1 = 0.99332 * b1 + x * 0.0750759;
        b2 = 0.969 * b2 + x * 0.153852;
        b3 = 0.8665 * b3 + x * 0.3104856;
        b4 = 0.55 * b4 + x * 0.5329522;
        b5 = -0.7616 * b5 - x * 0.016898;
        p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.16;
        b6 = x * 0.115926;
      }
      sink += w[0] + p[0];
    }
    noiseRuns.push(performance.now() - t);
    out._sink = sink;
  }
  out.sharedNoise21xMs = { runs: noiseRuns.map((x) => Number(x.toFixed(2))), median: median(noiseRuns) };

  // ---- C4: impulse-response construction (first user click) ----
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const irCtx = new OAC(2, 48000, 48000);
  const irRuns = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    synth.createImpulseResponses(irCtx);
    irRuns.push(performance.now() - t);
  }
  out.createImpulseResponsesMs = { runs: irRuns.map((x) => Number(x.toFixed(2))), median: median(irRuns) };

  // ---- B1: panner construction + listener writes on the main thread ----
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });
  try { await ctx.resume(); } catch { /* ignore */ }
  out.ctxState = ctx.state;
  out.ctxSampleRate = ctx.sampleRate;

  // Batches of 64 (roughly the live panner population), released between batches, so the
  // figure is per-node construction cost and not the cost of hoarding 2000 of them.
  const BATCH = 64;
  const REPS = 24;
  for (const model of ['HRTF', 'equalpower']) {
    const per = [];
    for (let rep = 0; rep < REPS; rep++) {
      const nodes = [];
      const t = performance.now();
      for (let i = 0; i < BATCH; i++) {
        const p = ctx.createPanner();
        p.panningModel = model;
        p.distanceModel = 'inverse';
        p.refDistance = 4;
        p.maxDistance = 120;
        p.rolloffFactor = 1.4;
        p.positionX.value = i * 0.01;
        p.positionY.value = 1;
        p.positionZ.value = -i * 0.01;
        nodes.push(p);
      }
      per.push(((performance.now() - t) / BATCH) * 1000);
      for (const p of nodes) { try { p.disconnect(); } catch { /* ignore */ } }
    }
    out[`pannerCreate_${model}_us`] = Number(median(per).toFixed(3));
  }

  // Listener AudioParam writes: 9 params, as the per-frame path does.
  {
    const L = ctx.listener;
    const M = 20000;
    const t = performance.now();
    for (let i = 0; i < M; i++) {
      const f = i * 1e-6;
      L.positionX.value = f; L.positionY.value = 1.62; L.positionZ.value = f;
      L.forwardX.value = 0; L.forwardY.value = 0; L.forwardZ.value = -1;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    }
    const ms = performance.now() - t;
    out.listenerWrite9_us = Number(((ms / M) * 1000).toFixed(3));
    // And the cost of the epsilon comparison that replaces them when nothing moved.
    let lx = 0, sink = 0;
    const t2 = performance.now();
    for (let i = 0; i < M; i++) {
      const f = 0.5;
      if (Math.abs(f - lx) > 1e-4) { lx = f; sink++; }
    }
    out.listenerSkip_us = Number((((performance.now() - t2) / M) * 1000).toFixed(4));
    out._sink2 = sink;
  }

  // ---- B1: audio-thread render capacity, 28 concurrent voices, HRTF vs equalpower ----
  out.dspCost = await window.__AP__.measureCapacity();

  try { await ctx.close(); } catch { /* ignore */ }
  return out;
}

/**
 * Audio-thread DSP cost for 28 concurrent panned voices, per panning model.
 *
 * `AudioRenderCapacity` is not exposed in this Chromium build, so the measurement is done
 * with an `OfflineAudioContext` instead: it runs the identical `PannerNode` DSP kernels,
 * as fast as the CPU allows, so `wallMs / (audioSeconds * 1000)` is directly the fraction
 * of one core the same graph would need to keep up in real time. A live context that needs
 * more than 1.0 of a core does not drop frames — it underruns, which is the crackling the
 * audit describes.
 */
async function measureCapacity() {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return { supported: false };
  const SR = 48000;
  const SECONDS = 4;

  const build = (ctx, count, modelFor) => {
    const noise = ctx.createBuffer(1, SR, SR);
    const d = noise.getChannelData(0);
    let a = 0x1234567 >>> 0;
    for (let i = 0; i < d.length; i++) {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
      d[i] = (a / 4294967296) * 2 - 1;
    }
    const sink = ctx.createGain();
    sink.gain.value = 0.02;
    sink.connect(ctx.destination);
    for (let i = 0; i < count; i++) {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0.02;
      let tail = g;
      s.connect(g);
      const model = modelFor(i);
      if (model) {
        const p = ctx.createPanner();
        p.panningModel = model;
        p.distanceModel = 'inverse';
        p.refDistance = 4;
        p.maxDistance = 120;
        p.rolloffFactor = 1.4;
        const ang = (i / count) * Math.PI * 2;
        p.positionX.value = Math.cos(ang) * 12;
        p.positionY.value = 1.6;
        p.positionZ.value = Math.sin(ang) * 12;
        tail.connect(p);
        tail = p;
      }
      tail.connect(sink);
      s.start(0);
    }
  };

  const run = async (label, count, modelFor) => {
    const times = [];
    for (let rep = 0; rep < 3; rep++) {
      const ctx = new OAC(2, SR * SECONDS, SR);
      build(ctx, count, modelFor);
      const t = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await ctx.startRendering();
      times.push(performance.now() - t);
    }
    times.sort((x, y) => x - y);
    const ms = times[1];
    return {
      label,
      voices: count,
      renderWallMsPer4s: Number(ms.toFixed(1)),
      coreFraction: Number((ms / (SECONDS * 1000)).toFixed(4)),
    };
  };

  const res = { supported: true, method: 'OfflineAudioContext render of 4 s', runs: [] };
  res.runs.push(await run('no panner (baseline)', 28, () => null));
  res.runs.push(await run('28x equalpower', 28, () => 'equalpower'));
  res.runs.push(await run('28x HRTF (before)', 28, () => 'HRTF'));
  res.runs.push(await run('8 HRTF + 20 equalpower (after)', 28, (i) => (i < 8 ? 'HRTF' : 'equalpower')));
  return res;
}

/* ------------------------------------------------------------------ *
 * In-game measurements.
 * ------------------------------------------------------------------ */

/** Heavy-firefight audio load sample: voice count, audio-thread load, main-thread cost. */
async function pageLoad(seconds) {
  const game = window.__GAME__;
  const audio = game.audio;
  audio.resume();
  await new Promise((r) => setTimeout(r, 200));

  const ctx = audio.ctx;
  const out = {
    ctxState: ctx ? ctx.state : 'none',
    audioInitMs: Number((audio.initMs || 0).toFixed(1)),
    samples: [], playMs: 0, playCalls: 0, granted: 0,
  };
  if (!ctx) return out;

  const listenerWrites0 = audio._listenerWrites ?? null;
  const listenerSkips0 = audio._listenerSkips ?? null;

  // Instrument play() so the main-thread cost of graph construction is separated out.
  const realPlay = audio.play.bind(audio);
  let playMs = 0, playCalls = 0, granted = 0;
  audio.play = function instrumented(name, opts) {
    const t = performance.now();
    const v = realPlay(name, opts);
    playMs += performance.now() - t;
    playCalls++;
    if (v) granted++;
    return v;
  };

  const cap = ctx.renderCapacity;
  const capSamples = [];
  const onUpdate = (e) => capSamples.push({ avg: e.averageLoad, peak: e.peakLoad });
  if (cap) { cap.addEventListener('update', onUpdate); cap.start({ updateInterval: 0.2 }); }

  // Synthetic firefight: 24 shooters at 600 rpm scattered around the listener, plus the
  // impacts and whizbys those rounds produce. This is what the audit's "~240 arrivals/sec"
  // actually sounds like at the audio engine's front door.
  const px = audio._lx, py = audio._ly, pz = audio._lz;
  const guns = ['rifle', 'rifle', 'smg', 'lmg', 'sniper', 'pistol'];
  const pos = { x: 0, y: 0, z: 0 };
  const t0 = performance.now();
  const voiceCounts = [];
  const liveCounts = [];
  const hrtfCounts = [];
  const nodeCounts = [];
  let tick = 0;
  const end = t0 + seconds * 1000;
  while (performance.now() < end) {
    for (let b = 0; b < 24; b++) {
      const a = (b / 24) * Math.PI * 2 + tick * 0.01;
      const r = 6 + (b % 7) * 5;
      pos.x = px + Math.cos(a) * r;
      pos.y = py + 0.2;
      pos.z = pz + Math.sin(a) * r;
      audio.play(guns[b % guns.length], { position: pos, volume: 0.9 });
      if (b % 3 === 0) audio.playImpact('concrete', pos);
      if (b % 8 === 0) audio.play('whizby', { position: pos });
    }
    voiceCounts.push(audio.voices.length);
    let live = 0, hrtf = 0, nodes = 0;
    for (const v of audio.voices) {
      if (v.done || v.stopping) continue;
      live++;
      if (v.hrtf) hrtf++;
      if (v.src) nodes++;
      if (v.gain) nodes++;
      if (v.n0) nodes++;
      if (v.n1) nodes++;
      if (v.n2) nodes++;
    }
    liveCounts.push(live);
    hrtfCounts.push(hrtf);
    nodeCounts.push(nodes);
    tick++;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  const elapsed = performance.now() - t0;

  if (cap) { cap.stop(); cap.removeEventListener('update', onUpdate); }
  audio.play = realPlay;
  audio.stopAll();

  const use = capSamples.slice(2);
  out.seconds = Number((elapsed / 1000).toFixed(2));
  out.playCalls = playCalls;
  out.granted = granted;
  out.grantRate = Number((granted / Math.max(1, playCalls)).toFixed(3));
  out.callsPerSec = Number((playCalls / (elapsed / 1000)).toFixed(1));
  out.mainThreadPlayMsTotal = Number(playMs.toFixed(2));
  out.mainThreadPlayUsPerCall = Number(((playMs / Math.max(1, playCalls)) * 1000).toFixed(2));
  out.mainThreadPlayMsPerSec = Number((playMs / (elapsed / 1000)).toFixed(2));
  const avg = (a) => Number((a.reduce((x, v) => x + v, 0) / Math.max(1, a.length)).toFixed(1));
  out.voiceRecordsAvg = avg(voiceCounts);
  out.voiceRecordsMax = Math.max(0, ...voiceCounts);
  out.voiceCountAvg = avg(liveCounts);
  out.voiceCountMax = Math.max(0, ...liveCounts);
  out.hrtfVoiceAvg = avg(hrtfCounts);
  out.hrtfVoiceMax = Math.max(0, ...hrtfCounts);
  out.liveNodesAvg = avg(nodeCounts);
  out.liveNodesMax = Math.max(0, ...nodeCounts);
  out.listenerWrites = audio._listenerWrites != null && listenerWrites0 != null
    ? audio._listenerWrites - listenerWrites0 : null;
  out.listenerSkips = audio._listenerSkips != null && listenerSkips0 != null
    ? audio._listenerSkips - listenerSkips0 : null;
  if (cap && use.length) {
    out.audioThreadAvgLoad = Number((use.reduce((a, s) => a + s.avg, 0) / use.length).toFixed(4));
    out.audioThreadPeakLoad = Number(Math.max(...use.map((s) => s.peak)).toFixed(4));
    out.capWindows = use.length;
  } else {
    out.audioThreadAvgLoad = null;
  }
  out.samples = undefined;
  return out;
}

/**
 * B2 regression test.
 *
 * Two scenarios, each followed by a sustained volley of bot rifle fire:
 *
 *  - "airstrike": what killstreaks.js actually produces. Nine bombs, 160 ms apart, and
 *    each detonation plays THREE `explosion` voices (fx.explosion, the killstreak layer
 *    and the `explosion` bus handler in audio.js all play one), i.e. 27 voices of a 3.05 s
 *    buffer at priority 100 inside 1.4 s — enough to own every slot in a 28-voice budget.
 *  - "grenadePops": the rate-shifted case from projectiles.js:456 / :482 — the same 3.05 s
 *    buffer at rate 0.35 / 0.4, which becomes 8.7 s and 7.6 s voices at priority 100.
 *
 * Reports how much of the gunfire got a voice at all, the longest stretch with no gunshot
 * granted, and how long a gunshot voice survives before something steals it.
 */
async function pageB2() {
  const game = window.__GAME__;
  const audio = game.audio;
  audio.resume();
  await new Promise((r) => setTimeout(r, 200));
  if (!audio.ctx) return { skipped: 'no audio context' };

  const scenario = async (label, blasts) => {
    audio.stopAll();
    await new Promise((r) => setTimeout(r, 250));

    // Record the age at which voices get stolen, so "gunfire disintegrates" is measurable.
    const stolen = [];
    const realStop = audio._stopVoice.bind(audio);
    audio._stopVoice = function instrumented(v, fade) {
      if (v && !v.done && !v.stopping && audio.ctx) {
        stolen.push({ name: v.name, age: audio.ctx.currentTime - v.startedAt });
      }
      return realStop(v, fade);
    };

    const px = audio._lx, py = audio._ly, pz = audio._lz;
    const pos = { x: 0, y: 0, z: 0 };

    // --- Phase 1: the barrage.
    let explosionsGranted = 0;
    for (const b of blasts) {
      pos.x = px + b.dx; pos.y = py; pos.z = pz + b.dz;
      for (let k = 0; k < b.copies; k++) {
        const v = audio.play('explosion', { position: pos, volume: b.volume, rate: b.rate });
        if (v) explosionsGranted++;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, b.gapMs));
    }
    const explosionVoicesLive = audio.voices.filter((v) => v.name === 'explosion' && !v.done && !v.stopping).length;
    const voicesAfterBarrage = audio.voices.filter((v) => !v.done && !v.stopping).length;

    // --- Phase 2: 24 bots firing for 2.5 s while those blasts are still ringing.
    let shots = 0, gunGranted = 0;
    let longestSilenceMs = 0;
    let lastGrantAt = performance.now();
    const t0 = performance.now();
    const guns = ['rifle', 'rifle', 'rifle', 'smg', 'lmg'];
    while (performance.now() - t0 < 2500) {
      for (let b = 0; b < 24; b++) {
        const a = (b / 24) * Math.PI * 2;
        const r = 8 + (b % 6) * 4;
        pos.x = px + Math.cos(a) * r;
        pos.y = py + 0.2;
        pos.z = pz + Math.sin(a) * r;
        const v = audio.play(guns[b % guns.length], { position: pos, volume: 0.9 });
        shots++;
        if (v) {
          gunGranted++;
          const now = performance.now();
          if (now - lastGrantAt > longestSilenceMs) longestSilenceMs = now - lastGrantAt;
          lastGrantAt = now;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }
    const dur = performance.now() - t0;
    const nowMs = performance.now();
    if (nowMs - lastGrantAt > longestSilenceMs) longestSilenceMs = nowMs - lastGrantAt;

    audio._stopVoice = realStop;
    audio.stopAll();

    const gunSteals = stolen.filter((s) => s.name === 'rifle' || s.name === 'smg' || s.name === 'lmg');
    const avgStealAge = gunSteals.length
      ? gunSteals.reduce((a, s) => a + s.age, 0) / gunSteals.length
      : null;

    return {
      label,
      explosionPlaysAttempted: blasts.reduce((a, b) => a + b.copies, 0),
      explosionsGranted,
      explosionVoicesLiveAfterBarrage: explosionVoicesLive,
      voicesLiveAfterBarrage: voicesAfterBarrage,
      gunshotAttempts: shots,
      gunshotsGranted: gunGranted,
      gunshotGrantRate: Number((gunGranted / Math.max(1, shots)).toFixed(3)),
      gunshotsPerSec: Number((gunGranted / (dur / 1000)).toFixed(1)),
      longestGunfireSilenceMs: Number(longestSilenceMs.toFixed(0)),
      gunVoiceStealCount: gunSteals.length,
      avgGunVoiceStealAgeMs: avgStealAge == null ? null : Number((avgStealAge * 1000).toFixed(1)),
      gunVoicesStolenUnder150ms: gunSteals.filter((s) => s.age < 0.15).length,
    };
  };

  // killstreaks.js: AIRSTRIKE_BOMBS 9, AIRSTRIKE_INTERVAL 0.16, AIRSTRIKE_SPACING 6.5.
  const airstrike = [];
  for (let i = 0; i < 9; i++) {
    airstrike.push({ dx: (i - 4) * 6.5, dz: 0, copies: 3, volume: 1, rate: 1, gapMs: 160 });
  }
  // projectiles.js: flashbang rate 0.35, smoke pop rate 0.4.
  const pops = [];
  for (let i = 0; i < 14; i++) {
    pops.push({
      dx: (i % 5) * 3 - 6, dz: ((i / 5) | 0) * 3 - 4, copies: 1,
      volume: i % 2 ? 0.5 : 0.35, rate: i % 2 ? 0.35 : 0.4, gapMs: 90,
    });
  }

  const results = {};
  results.airstrike = await scenario('airstrike (9 bombs x 3 voices, rate 1)', airstrike);
  results.grenadePops = await scenario('grenade pops (14 x rate 0.35/0.4)', pops);

  // Pass/fail. Under an airstrike the engine must still be granting most gunshots and must
  // never go more than ~250 ms without one, and it must stop guillotining gunshot voices
  // inside their first 150 ms.
  results.checks = [
    {
      name: 'airstrike: gunfire still gets voices',
      pass: results.airstrike.gunshotGrantRate > 0.5,
      detail: `grant rate ${results.airstrike.gunshotGrantRate}`,
    },
    {
      name: 'airstrike: no multi-second gunfire blackout',
      pass: results.airstrike.longestGunfireSilenceMs < 400,
      detail: `longest silence ${results.airstrike.longestGunfireSilenceMs} ms`,
    },
    {
      name: 'grenade pops: gunfire still gets voices',
      pass: results.grenadePops.gunshotGrantRate > 0.5,
      detail: `grant rate ${results.grenadePops.gunshotGrantRate}`,
    },
    {
      name: 'gunshot voices are not stolen inside their first 150 ms',
      pass: results.airstrike.gunVoicesStolenUnder150ms === 0
        && results.grenadePops.gunVoicesStolenUnder150ms === 0,
      detail: `airstrike ${results.airstrike.gunVoicesStolenUnder150ms}, pops ${results.grenadePops.gunVoicesStolenUnder150ms}`,
    },
  ];
  results.failed = results.checks.filter((c) => !c.pass).length;
  return results;
}

/* ================================================================== *
 * Node-side driver.
 * ================================================================== */

function pct(before, after) {
  if (before == null || after == null || before === 0) return null;
  return Number((((after - before) / before) * 100).toFixed(1));
}

async function runDiff(tags) {
  const [a, b] = tags.split(',');
  const load = async (t) => JSON.parse(await readFile(path.join(OUT_DIR, `audio-all-${t}.json`), 'utf8'));
  const A = await load(a);
  const B = await load(b);

  const fa = A.fingerprint, fb = B.fingerprint;
  const rows = [];
  const names = new Set([...Object.keys(fa.sounds), ...Object.keys(fb.sounds)]);
  let identical = 0, changed = 0;

  for (const name of [...names].sort()) {
    const va = fa.sounds[name] || [];
    const vb = fb.sounds[name] || [];
    if (va.length !== vb.length) {
      rows.push({ name, verdict: 'VARIANT COUNT CHANGED', before: va.length, after: vb.length });
      changed++;
      continue;
    }
    let worst = null;
    let allSameHash = true;
    for (let i = 0; i < va.length; i++) {
      const x = va[i], y = vb[i];
      if (x.hash !== y.hash) allSameHash = false;
      const dPeak = Math.abs(y.peak - x.peak);
      const dRms = x.rms > 0 ? Math.abs(y.rms - x.rms) / x.rms : 0;
      const dDur = Math.abs(y.durMs - x.durMs);
      const dWidth = Math.abs(y.width - x.width);
      let dBand = 0;
      for (let bIdx = 0; bIdx < x.bands.length; bIdx++) {
        dBand = Math.max(dBand, Math.abs(y.bands[bIdx] - x.bands[bIdx]));
      }
      const dEnergy = Math.abs(y.energy - x.energy);
      const score = Math.max(dPeak, dRms, dBand, dEnergy, dDur / 1000, dWidth);
      if (!worst || score > worst.score) {
        worst = { variant: i, score, dPeak, dRmsRel: dRms, dDurMs: dDur, dBandMax: dBand, dEnergyLog10: dEnergy, dWidth };
      }
    }
    if (allSameHash) {
      identical++;
      rows.push({ name, verdict: 'IDENTICAL (bit-exact)' });
    } else {
      changed++;
      rows.push({
        name,
        verdict: worst.score < 1e-4 ? 'equivalent (< 1e-4)' : 'CHANGED',
        ...Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, typeof v === 'number' ? Number(v.toPrecision(4)) : v])),
      });
    }
  }

  // Impulse responses.
  const irRows = [];
  for (const k of Object.keys(fa.impulses || {})) {
    const x = fa.impulses[k], y = (fb.impulses || {})[k];
    if (!y) { irRows.push({ ir: k, verdict: 'MISSING AFTER' }); continue; }
    let maxSampleDiff = 0, maxRel = 0;
    for (let i = 0; i < x.samples.length; i++) {
      const [idx, va] = x.samples[i];
      const hit = y.samples.find((s) => s[0] === idx);
      if (!hit) continue;
      const d = Math.abs(hit[1] - va);
      maxSampleDiff = Math.max(maxSampleDiff, d);
      if (Math.abs(va) > 1e-9) maxRel = Math.max(maxRel, d / Math.abs(va));
    }
    let dBand = 0;
    for (let i = 0; i < x.bands.length; i++) dBand = Math.max(dBand, Math.abs(y.bands[i] - x.bands[i]));
    irRows.push({
      ir: k,
      hashMatch: x.hash === y.hash,
      dPeak: Number(Math.abs(y.peak - x.peak).toPrecision(4)),
      dRmsRel: Number((x.rms ? Math.abs(y.rms - x.rms) / x.rms : 0).toPrecision(4)),
      dBandMax: Number(dBand.toPrecision(4)),
      maxSampleAbsDiff: Number(maxSampleDiff.toPrecision(4)),
      maxSampleRelDiff: Number(maxRel.toPrecision(4)),
      dLenSamples: y.len - x.len,
    });
  }

  const cmp = (get) => {
    const a = get(A), b = get(B);
    return { before: a, after: b, deltaPct: pct(a, b) };
  };
  const perf = {
    C3_renderSoundBankMs_cold: cmp((x) => x.bench?.renderSoundBankMs?.first),
    C3_renderSoundBankMs_median: cmp((x) => x.bench?.renderSoundBankMs?.median),
    C3_longestMainThreadBlockMs: cmp((x) => x.bench?.renderSoundBankLongestBlockMs?.median),
    C3_audioInitMs_inGame: cmp((x) => x.load?.audioInitMs),
    C4_createImpulseResponsesMs: cmp((x) => x.bench?.createImpulseResponsesMs?.median),
    B1_pannerCreate_us: {
      HRTF: cmp((x) => x.bench?.pannerCreate_HRTF_us),
      equalpower: cmp((x) => x.bench?.pannerCreate_equalpower_us),
    },
    B1_audioThreadCoreFraction_28voices: {
      before: (A.bench?.dspCost?.runs || []).map((r) => `${r.label}: ${r.coreFraction}`),
      after: (B.bench?.dspCost?.runs || []).map((r) => `${r.label}: ${r.coreFraction}`),
    },
    firefight: {
      concurrentVoicesAvg: cmp((x) => x.load?.voiceCountAvg),
      concurrentVoicesMax: cmp((x) => x.load?.voiceCountMax),
      hrtfVoicesAvg: cmp((x) => x.load?.hrtfVoiceAvg),
      hrtfVoicesMax: cmp((x) => x.load?.hrtfVoiceMax),
      liveNodesAvg: cmp((x) => x.load?.liveNodesAvg),
      mainThreadPlayMsPerSec: cmp((x) => x.load?.mainThreadPlayMsPerSec),
      mainThreadPlayUsPerCall: cmp((x) => x.load?.mainThreadPlayUsPerCall),
      grantRate: cmp((x) => x.load?.grantRate),
    },
    b2: { before: A.b2, after: B.b2 },
  };

  const summary = {
    soundsIdentical: identical,
    soundsChanged: changed,
    changedNames: rows.filter((r) => r.verdict === 'CHANGED').map((r) => r.name),
  };

  report('SOUND FINGERPRINT DIFF', { summary, sounds: rows, impulses: irRows });
  report('PERFORMANCE DIFF', perf);
  await writeFile(
    path.join(OUT_DIR, `audio-diff-${a}-${b}.json`),
    JSON.stringify({ summary, sounds: rows, impulses: irRows, perf }, null, 1),
  );
  return summary.changedNames.length === 0 ? 0 : 1;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  if (DIFF) {
    process.exit(await runDiff(DIFF));
  }

  const wantFP = MODE === 'fingerprint' || MODE === 'all';
  const wantBench = MODE === 'bench' || MODE === 'all';
  const wantLoad = MODE === 'load' || MODE === 'all';
  const wantB2 = MODE === 'b2' || MODE === 'all';
  const needGame = wantLoad || wantB2;

  const ctxArgs = ['--autoplay-policy=no-user-gesture-required'];
  const h = await boot({ args: ctxArgs, waitForGame: needGame });
  const out = { tag: TAG, mode: MODE, when: new Date().toISOString() };

  try {
    await h.page.evaluate(installAnalysis);
    // Helpers that page-side payloads call by name have to be installed explicitly —
    // page.evaluate only serialises the single function it is handed.
    await h.page.evaluate(
      `window.__AP__.measureCapacity = ${measureCapacity.toString()};`,
    );

    if (wantFP) {
      process.stdout.write('[audioprobe] fingerprinting sound bank...\n');
      out.fingerprint = await h.page.evaluate(pageFingerprint);
      process.stdout.write(`[audioprobe]   ${out.fingerprint.soundCount} sounds / ${out.fingerprint.bufferCount} buffers, render ${out.fingerprint.renderMs} ms\n`);
      if (out.fingerprint.missing.length) {
        process.stdout.write(`[audioprobe]   MISSING: ${out.fingerprint.missing.join(', ')}\n`);
      }
    }

    if (wantBench) {
      process.stdout.write('[audioprobe] benchmarking...\n');
      out.bench = await h.page.evaluate(pageBench);
    }

    if (wantB2) {
      process.stdout.write('[audioprobe] B2 voice-stealing stress...\n');
      out.b2 = await h.page.evaluate(pageB2);
    }

    if (wantLoad) {
      process.stdout.write('[audioprobe] firefight load...\n');
      out.load = await h.page.evaluate(pageLoad, 6);
    }
  } finally {
    out.pageErrors = h.errors;
    out.consoleErrors = h.consoleErrors.filter((e) => !/favicon|WebGL|SwiftShader/i.test(e));
    await h.close();
  }

  const file = path.join(OUT_DIR, `audio-${MODE}-${TAG}.json`);
  await writeFile(file, JSON.stringify(out, null, 1));

  const brief = {
    tag: TAG,
    renderSoundBankMs: out.bench?.renderSoundBankMs,
    renderSoundBankLongestBlockMs: out.bench?.renderSoundBankLongestBlockMs?.median,
    sharedNoise21xMs: out.bench?.sharedNoise21xMs?.median,
    createImpulseResponsesMs: out.bench?.createImpulseResponsesMs?.median,
    pannerCreate_HRTF_us: out.bench?.pannerCreate_HRTF_us,
    pannerCreate_equalpower_us: out.bench?.pannerCreate_equalpower_us,
    listenerWrite9_us: out.bench?.listenerWrite9_us,
    dspCost: out.bench?.dspCost,
    load: out.load,
    b2: out.b2,
    pageErrors: out.pageErrors,
  };
  report(`AUDIO PROBE (${MODE} / ${TAG})`, brief);
  process.stdout.write(`\nwrote ${path.relative(ROOT, file)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
