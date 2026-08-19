/**
 * Vertical-occupancy probe: how much of the map's upper half the bots actually use.
 *
 * node scripts/vertprobe.mjs [--ticks=24000] [--bots=8] [--seeds=1,2,3]
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const TICKS = Number(arg('ticks', 24000));
const BOTS = Number(arg('bots', 8));
const SEEDS = String(arg('seeds', '12345,777,20260819')).split(',').map(Number);
const SAMPLE = 15;

const ZONES = [
  { name: 'market hall roof', at: new THREE.Vector3(0, 8.05, 0), r: 11, ylo: 6.5, yhi: 10 },
  { name: 'market hall L1', at: new THREE.Vector3(0, 4.15, 0), r: 11, ylo: 3.0, yhi: 6.0 },
  { name: 'warehouse mezzanine', at: new THREE.Vector3(25, 4.0, -30), r: 9, ylo: 2.8, yhi: 6.5 },
  { name: 'customs L1', at: new THREE.Vector3(25, 4.15, 20), r: 9, ylo: 3.0, yhi: 6.5 },
  { name: 'old town rampart', at: new THREE.Vector3(-38, 3.95, -8), r: 8, ylo: 2.8, yhi: 6.5 },
  { name: 'old town terrace', at: new THREE.Vector3(-23, 5.0, 0), r: 20, ylo: 3.5, yhi: 7.5 },
];

const results = [];
for (const SEED of SEEDS) {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'tdm', botCount: BOTS, difficulty: 'regular', seed: SEED });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const zoneHits = new Array(ZONES.length).fill(0);
  const yhist = new Array(24).fill(0);
  let samples = 0;
  let above3 = 0, above1 = 0;
  const DT = 1 / 120;
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) {
    game._fixedUpdate(DT);
    if (i % SAMPLE !== 0) continue;
    for (const b of game.bots.bots) {
      if (!b.alive) continue;
      samples++;
      const y = b.position.y;
      const bin = Math.min(yhist.length - 1, Math.max(0, Math.round(y)));
      yhist[bin]++;
      if (y > 3) above3++;
      if (y > 1) above1++;
      for (let z = 0; z < ZONES.length; z++) {
        const Z = ZONES[z];
        if (y < Z.ylo || y > Z.yhi) continue;
        if (Math.hypot(b.position.x - Z.at.x, b.position.z - Z.at.z) > Z.r) continue;
        zoneHits[z]++;
      }
    }
  }
  const ms = performance.now() - t0;
  results.push({ SEED, zoneHits, yhist, samples, above3, above1,
    kills: game.match.scores.reduce((a, b) => a + b, 0), ms });
}

const pc = (a, b) => b ? (100 * a / b).toFixed(2) + '%' : 'n/a';
console.log(`\nvertical occupancy — ${BOTS} bots, ${TICKS} ticks (${(TICKS / 120) | 0}s), seeds ${SEEDS.join(',')}`);
for (let z = 0; z < ZONES.length; z++) {
  const row = results.map((r) => pc(r.zoneHits[z], r.samples).padStart(8)).join(' ');
  console.log(`  ${ZONES[z].name.padEnd(22)}${row}`);
}
console.log(`  ${'ANY y>3m'.padEnd(22)}${results.map((r) => pc(r.above3, r.samples).padStart(8)).join(' ')}`);
console.log(`  ${'ANY y>1m'.padEnd(22)}${results.map((r) => pc(r.above1, r.samples).padStart(8)).join(' ')}`);
for (const r of results) {
  const bins = r.yhist.map((v, i) => (v ? `${i}m ${pc(v, r.samples)}` : null)).filter(Boolean);
  console.log(`  seed ${r.SEED}: ${bins.join(' · ')}`);
  console.log(`    kills ${r.kills}, samples ${r.samples}, ${Math.round(r.ms)} ms`);
}
process.exit(0);
