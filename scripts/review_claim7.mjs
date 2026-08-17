/** THROWAWAY REVIEW PROBE — CLAIM 7 (shared noise beds + MessageChannel yield pump). */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = await readFile(path.join(ROOT, 'src/audio/synth.js'), 'utf8');
const ARCH = await readFile(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
const b = (t) => console.log('\n=== ' + t + ' ' + '='.repeat(Math.max(0, 68 - t.length)));

/* ---- 1. Are the module-scope beds Float32Array or AudioBuffer? ---- */
b('bed type');
console.log('white:', /const white = new Float32Array\(len\);/.test(SRC) ? 'Float32Array (context-free)' : '??');
console.log('pink :', /const pink = new Float32Array\(len\);/.test(SRC) ? 'Float32Array (context-free)' : '??');
console.log('createBuffer inside noiseBeds():', /function noiseBeds[\s\S]*?\n}/.exec(SRC)[0].includes('createBuffer') ? 'YES (context-bound!)' : 'no');

/* ---- 2. Every read site of the shared beds ---- */
b('every read site of sh.white / sh.pink / _noiseBeds');
SRC.split('\n').forEach((l, i) => {
  if (/sh\.(white|pink)|beds\.(white|pink)|_noiseBeds/.test(l)) console.log(`  ${String(i + 1).padStart(4)}: ${l.trim()}`);
});
const noiseSourceBody = /function noiseSource[\s\S]*?\n}/.exec(SRC)[0];
console.log('noiseSource() mutates the buffer?',
  /getChannelData|copyToChannel|\.set\(/.test(noiseSourceBody) ? 'YES — MUTATION' : 'no — assigns s.buffer and reads .duration only');

/* ---- 3. buildIR: geometric decay vs Math.exp, bit-level ---- */
b('buildIR envelope: geometric vs Math.exp (relative error)');
for (const [name, tau, dur] of [['indoor', 0.075, 0.36], ['outdoor', 0.17, 0.95], ['concrete', 0.58, 2.10]]) {
  const sr = 48000, len = Math.floor(dur * sr);
  const dps = Math.exp(-1 / (tau * sr));
  let env = 1, worst = 0;
  for (let i = 0; i < len; i++) {
    const ref = Math.exp(-(i / sr) / tau);
    const err = ref > 1e-12 ? Math.abs(env - ref) / ref : 0;
    if (err > worst) worst = err;
    env *= dps;
  }
  console.log(`  ${name.padEnd(9)} len=${len}  max relative error = ${worst.toExponential(3)}`);
}

/* ---- 4. MessageChannel yield pump ---- */
b('MessageChannel yield pump');
const chSrc = /const _yieldChannel = \(\(\) => \{[\s\S]*?\}\)\(\);/.exec(SRC)[0];
console.log('port close anywhere in file?', /\.close\(\)/.test(SRC.replace(/ctx\.close\(\)/g, '')) ? 'yes' : 'NO — ports never closed');
console.log('onmessage ever cleared?', /onmessage\s*=\s*null/.test(SRC) ? 'yes' : 'NO — listener never removed');
console.log('abort/cancel token in renderBatch?', /abort|signal|cancel/i.test(SRC) ? 'yes' : 'NO — no abort path');
console.log('created eagerly at module load (IIFE):', chSrc.trim().endsWith('})();') ? 'YES' : 'no');

// Live behaviour test: replicate the pump and hammer it from two concurrent producers.
const pump = (() => {
  const ch = new MessageChannel();
  const queue = [];
  ch.port1.onmessage = () => { const fn = queue.shift(); if (fn) fn(); };
  ch.port1.start?.();
  return { queue, ch, post: () => ch.port2.postMessage(0) };
})();
const yieldToEventLoop = () => new Promise((res) => { pump.queue.push(res); pump.post(); });
let done = 0;
const producer = async (n) => { for (let i = 0; i < n; i++) { await yieldToEventLoop(); done++; } };
const t0 = Date.now();
await Promise.race([
  Promise.all([producer(200), producer(200)]),
  new Promise((_, rej) => setTimeout(() => rej(new Error('HUNG')), 4000)),
]).catch((e) => console.log('  ' + e.message));
console.log(`  two concurrent producers, 400 yields: resolved=${done}, leftover queue=${pump.queue.length}, ${Date.now() - t0} ms`);
console.log(`  => interleaved producers ${done === 400 && pump.queue.length === 0 ? 'all resolve, no hang, no queue growth' : 'LEAK/HANG'}`);
pump.ch.port1.close(); pump.ch.port2.close();

/* ---- 5. required sound names vs ARCHITECTURE §9 ---- */
b('ARCHITECTURE §9 required sound names');
const sec = ARCH.slice(ARCH.indexOf('Required sound names:'));
const archNames = [...sec.slice(0, sec.indexOf('##') > 0 ? sec.indexOf('##') : 900).matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]);
const req = eval('[' + /export const REQUIRED_SOUNDS = \[([\s\S]*?)\];/.exec(SRC)[1] + ']');
const specNames = [...SRC.matchAll(/^spec\('([^']+)'/gm)].map((m) => m[1])
  .concat([...SRC.matchAll(/for \(const id of Object\.keys\(GUN_PARAMS\)\)/g)].length ? ['rifle', 'smg', 'sniper', 'shotgun', 'pistol', 'lmg'] : []);
console.log('§9 names:', archNames.length, ' REQUIRED_SOUNDS:', req.length);
const missingFromReq = archNames.filter((n) => !req.includes(n));
const missingFromBank = archNames.filter((n) => !specNames.includes(n));
console.log('in §9 but not in REQUIRED_SOUNDS:', missingFromReq.length ? missingFromReq.join(', ') : 'none');
console.log('in §9 but not produced by SPECS   :', missingFromBank.length ? missingFromBank.join(', ') : 'none');
console.log('extra names the bank produces     :', specNames.filter((n) => !archNames.includes(n)).join(', '));
