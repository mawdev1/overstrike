/**
 * THROWAWAY REVIEW PROBE — CLAIM 6, part 3.
 * A/B: current MIN_STEAL_AGE=0.15 vs MIN_STEAL_AGE=0 (i.e. the pre-diff candidacy rule),
 * with REAL weapon rpms (weaponDefs: smg 1000, lmg 800, ar 720) and real bot counts
 * (settings botCount range [0,24], default 7).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { MockCtx, makeBuffers, DUR } from './review_voiceharness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAME = 1 / 120;

const SHIM = `
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const THREE = { Vector3: class { constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
  set(x,y,z){this.x=x;this.y=y;this.z=z;return this;} copy(v){this.x=v.x;this.y=v.y;this.z=v.z;return this;} } };
async function renderSoundBank(){ return new Map(); }
function createImpulseResponses(){ return null; }
const REQUIRED_SOUNDS = [];
class Music { constructor(){} update(){} attach(){} dispose(){} start(){} setVolume(){} }
`;

let n = 0;
async function loadEngine(minStealAge) {
  let src = await readFile(path.join(ROOT, 'src/audio/audio.js'), 'utf8');
  src = src.replace(/^import .*$/gm, '');
  if (minStealAge != null) {
    const before = src;
    src = src.replace('const MIN_STEAL_AGE = 0.15;', `const MIN_STEAL_AGE = ${minStealAge};`);
    if (src === before) throw new Error('MIN_STEAL_AGE not patched');
  }
  src = SHIM + src;
  const dir = path.join(os.tmpdir(), 'overstrike-review');
  await mkdir(dir, { recursive: true });
  const f = path.join(dir, `audio.ab.${Date.now()}.${n++}.mjs`);
  await writeFile(f, src, 'utf8');
  return (await import('file://' + f.replace(/\\/g, '/'))).AudioEngine;
}

async function makeEngine(minStealAge) {
  const AudioEngine = await loadEngine(minStealAge);
  const game = { frame: 0 };
  const eng = new AudioEngine(game);
  const ctx = new MockCtx();
  eng.supported = true; eng.ctx = ctx; eng.buffers = makeBuffers(DUR); eng.ready = true;
  eng.dryBus = ctx.createGain(); eng.sfxGain = ctx.createGain();
  eng.masterGain = ctx.createGain(); eng.duckGain = ctx.createGain(); eng.reverbs = null;
  return { eng, ctx, game };
}

async function run(minStealAge, bots, rpm, gun) {
  const { eng, ctx, game } = await makeEngine(minStealAge);
  const SIM = 8, shotEvery = 60 / rpm;
  const next = new Array(bots).fill(0).map((_, i) => (i * shotEvery) / bots);
  let gunOk = 0, gunNo = 0;
  const crit = { hitmarker: [0, 0], killConfirm: [0, 0], death: [0, 0], headshot: [0, 0], explosion: [0, 0], hurt: [0, 0] };
  let nextHit = 0.31, nextFoot = 0.05, nextWhiz = 0.2, nextKill = 1.0, nextImp = 0, nextFlesh = 0.11, nextBoom = 2.0;
  for (let step = 0; ctx.currentTime < SIM; step++) {
    ctx.advance(FRAME); game.frame = step; ctx.flushEnded();
    const now = ctx.currentTime;
    for (let b = 0; b < bots; b++) {
      while (next[b] <= now) {
        next[b] += shotEvery;
        if (eng.play(gun, { position: { x: 4 + b * 2.5, y: 1.6, z: 8 + (b % 5) * 3 } })) gunOk++; else gunNo++;
      }
    }
    while (nextImp <= now) { nextImp += 0.03; eng.play('impactConcrete', { position: { x: 3, y: 1, z: 4 } }); }
    while (nextFlesh <= now) { nextFlesh += 0.025; eng.play('fleshHit', { position: { x: 7, y: 1.4, z: 9 } }); }
    while (nextWhiz <= now) { nextWhiz += 0.045; eng.play('whizby', { position: { x: 0.4, y: 1.6, z: 0.4 } }); }
    while (nextFoot <= now) { nextFoot += 0.25; eng.play('footstepConcrete', { position: { x: 0, y: 0, z: 0 } }); }
    const tally = (k, v) => { crit[k][v ? 0 : 1]++; };
    while (nextHit <= now) { nextHit += 0.09; tally('hitmarker', eng.hitmarker(false)); }
    while (nextKill <= now) {
      nextKill += 1.3;
      tally('killConfirm', eng.playUI('killConfirm', {}));
      tally('death', eng.play('death', { position: { x: 8, y: 0, z: 12 } }));
      tally('headshot', eng.play('headshot', { position: { x: 8, y: 1.6, z: 12 } }));
      tally('hurt', eng.play('hurt', { position: { x: 0, y: 1.6, z: 0 } }));
    }
    while (nextBoom <= now) { nextBoom += 2.5; tally('explosion', eng.play('explosion', { position: { x: 6, y: 1, z: 8 }, priority: 100 })); }
  }
  return { gunOk, gunNo, crit };
}

const scenarios = [
  { bots: 7, rpm: 1000, gun: 'smg', label: 'DEFAULT lobby: 7 bots, smg 1000 rpm' },
  { bots: 12, rpm: 1000, gun: 'smg', label: '12 bots, smg 1000 rpm' },
  { bots: 16, rpm: 800, gun: 'lmg', label: '16 bots, lmg 800 rpm' },
  { bots: 24, rpm: 720, gun: 'rifle', label: 'MAX lobby: 24 bots, rifle 720 rpm' },
];

for (const s of scenarios) {
  const cur = await run(null, s.bots, s.rpm, s.gun);      // shipped: MIN_STEAL_AGE=0.15
  const base = await run(0, s.bots, s.rpm, s.gun);        // MIN_STEAL_AGE disabled
  console.log('\n=== ' + s.label + ' ' + '='.repeat(Math.max(0, 52 - s.label.length)));
  console.log(`  ${s.gun}:  shipped ${cur.gunOk}/${cur.gunOk + cur.gunNo} granted   |  no-age-gate ${base.gunOk}/${base.gunOk + base.gunNo}`);
  console.log('  critical sound        shipped(played/dropped)   no-age-gate(played/dropped)');
  for (const k of Object.keys(cur.crit)) {
    const c = cur.crit[k], b = base.crit[k];
    const flag = (c[1] > 0 && b[1] === 0) ? '   <== REGRESSION' : '';
    console.log(`    ${k.padEnd(14)}       ${String(c[0]).padStart(4)} / ${String(c[1]).padStart(4)}              ${String(b[0]).padStart(4)} / ${String(b[1]).padStart(4)}${flag}`);
  }
}
