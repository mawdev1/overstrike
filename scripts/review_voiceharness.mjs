/**
 * THROWAWAY REVIEW PROBE (read-only) — loads the REAL AudioEngine class from
 * src/audio/audio.js with its imports stubbed, and drives it against a mock Web Audio
 * implementation with a manually-advanced clock.
 *
 * Nothing in src/ is modified: the source text is read, the three `import` lines are
 * replaced with local shims, and the result is imported from a temp file.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SHIM = `
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const THREE = { Vector3: class { constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
  set(x,y,z){this.x=x;this.y=y;this.z=z;return this;} copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;} } };
async function renderSoundBank(){ return new Map(); }
function createImpulseResponses(){ return null; }
const REQUIRED_SOUNDS = [];
class Music { constructor(){} update(){} attach(){} dispose(){} start(){} setVolume(){} }
`;

export async function loadEngine() {
  let src = await readFile(path.join(ROOT, 'src/audio/audio.js'), 'utf8');
  src = src
    .replace(/^import \* as THREE from 'three';$/m, '')
    .replace(/^import \{ clamp \} from '\.\.\/core\/mathUtils\.js';$/m, '')
    .replace(/^import \{ renderSoundBank, createImpulseResponses, REQUIRED_SOUNDS \} from '\.\/synth\.js';$/m, '')
    .replace(/^import \{ Music \} from '\.\/music\.js';$/m, '');
  if (src.includes("from 'three'")) throw new Error('three import not stripped');
  src = SHIM + src;
  const dir = path.join(os.tmpdir(), 'overstrike-review');
  await mkdir(dir, { recursive: true });
  const f = path.join(dir, `audio.shimmed.${Date.now()}.mjs`);
  await writeFile(f, src, 'utf8');
  const mod = await import('file://' + f.replace(/\\/g, '/'));
  return mod.AudioEngine;
}

/* ------------------------------------------------------------------ *
 * Mock Web Audio with a manual clock.
 * ------------------------------------------------------------------ */

export class MockCtx {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = this._node('destination');
    this.listener = { setPosition() {}, setOrientation() {} };
    this.pending = [];        // sources awaiting start/stop
    this.endedQueue = [];     // onended callbacks waiting for a "frame"
    this.created = { source: 0, gain: 0, biquad: 0, panner: 0 };
    this.hrtfCreated = 0;
    this.equalCreated = 0;
    this.liveNodes = 0;
  }
  _param(v) {
    return {
      value: v,
      cancelScheduledValues() {}, setValueAtTime() {},
      linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    };
  }
  _node(kind) {
    const ctx = this;
    ctx.liveNodes++;
    return {
      kind,
      connect() {}, disconnect() { ctx.liveNodes--; },
    };
  }
  createGain() { this.created.gain++; const n = this._node('gain'); n.gain = this._param(1); return n; }
  createBiquadFilter() {
    this.created.biquad++; const n = this._node('biquad');
    n.frequency = this._param(0); n.Q = this._param(1); n.type = 'lowpass'; return n;
  }
  createPanner() {
    this.created.panner++; const n = this._node('panner');
    n.positionX = this._param(0); n.positionY = this._param(0); n.positionZ = this._param(0);
    let model = 'equalpower';
    Object.defineProperty(n, 'panningModel', {
      get: () => model,
      set: (v) => { model = v; if (v === 'HRTF') this.hrtfCreated++; else this.equalCreated++; },
    });
    return n;
  }
  createDynamicsCompressor() {
    const n = this._node('comp');
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = this._param(0);
    return n;
  }
  createConvolver() { const n = this._node('conv'); n.normalize = true; n.buffer = null; return n; }
  createBufferSource() {
    const ctx = this;
    const n = this._node('src');
    n.playbackRate = this._param(1);
    n.buffer = null;
    n.onended = null;
    n._startAt = null; n._stopAt = null; n._ended = false;
    n.start = (when) => { n._startAt = when == null ? ctx.currentTime : when; ctx.pending.push(n); };
    n.stop = (when) => { const t = when == null ? ctx.currentTime : when; n._stopAt = n._stopAt == null ? t : Math.min(n._stopAt, t); };
    return n;
  }
  createBuffer() { return { duration: 1, getChannelData: () => new Float32Array(1) }; }
  createOscillator() {
    const n = this._node('osc');
    n.frequency = this._param(0); n.type = 'sine'; n.onended = null;
    n.start = () => {}; n.stop = () => {};
    return n;
  }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }

  /** Advance the audio clock. Queues onended for sources that finished. */
  advance(dt) {
    if (this.state !== 'running') return;
    this.currentTime += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const s = this.pending[i];
      const natural = s._startAt + (s.buffer ? s.buffer.duration / s.playbackRate.value : 0);
      let end = natural;
      if (s._stopAt != null) end = Math.min(end, s._stopAt);
      // Spec: stop <= start -> never plays, but `ended` still fires.
      if (this.currentTime >= end) {
        this.pending.splice(i, 1);
        s._ended = true;
        this.endedQueue.push(s);
      }
    }
  }
  /** Emulate the main thread dispatching queued `ended` events. */
  flushEnded() {
    const q = this.endedQueue; this.endedQueue = [];
    for (const s of q) { if (typeof s.onended === 'function') s.onended(); }
  }
}

export function makeBuffers(durations) {
  const m = new Map();
  for (const [name, d] of Object.entries(durations)) {
    m.set(name, [{ duration: d, numberOfChannels: 1 }]);
  }
  return m;
}

/** Real measured buffer durations (perf/audio-fingerprint-after.json, first variant). */
export const DUR = {
  rifle: 0.239, smg: 0.174, sniper: 0.530, shotgun: 0.378, pistol: 0.193, lmg: 0.331,
  impactConcrete: 0.097, impactMetal: 0.283, impactWood: 0.098, impactDirt: 0.135,
  impactSand: 0.086, impactGlass: 0.337, fleshHit: 0.094, headshot: 0.176,
  hitmarker: 0.041, hitmarkerHeadshot: 0.176, killConfirm: 0.277,
  magOut: 0.106, magIn: 0.116, boltBack: 0.132, boltForward: 0.100, switch: 0.159,
  dryfire: 0.027, reloadTail: 0.212, shellDrop: 0.139, grenadeBounce: 0.127,
  pinPull: 0.139, footstepConcrete: 0.053, footstepDirt: 0.070, land: 0.172,
  jump: 0.117, hurt: 0.184, death: 0.693, whizby: 0.166, lowAmmo: 0.164,
  uiClick: 0.044, uiHover: 0.018, uiBack: 0.100, explosion: 1.768,
  streakReady: 0.752, matchStart: 1.618, matchEnd: 1.520,
};

export async function makeEngine() {
  const AudioEngine = await loadEngine();
  const game = { frame: 0, bus: null, settings: null, camera: null, world: null };
  const eng = new AudioEngine(game);
  const ctx = new MockCtx();
  eng.supported = true;
  eng.ctx = ctx;
  eng.buffers = makeBuffers(DUR);
  eng.ready = true;
  // Minimal graph the play() path touches.
  eng.dryBus = ctx.createGain();
  eng.sfxGain = ctx.createGain();
  eng.masterGain = ctx.createGain();
  eng.duckGain = ctx.createGain();
  eng.reverbs = null;
  return { eng, ctx, game };
}
