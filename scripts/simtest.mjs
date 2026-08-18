/**
 * Headless simulation tests — the parts of the game that must be provably deterministic
 * and DOM-free, run in plain Node with no browser.
 *
 * This is the regression net for the authoritative-server work. Everything here asserts a
 * property the netcode depends on (determinism, purity, replayability), not a rendered
 * result — those live in the playwright harnesses (`smoke.mjs`, `review_*.mjs`).
 *
 *   npm run simtest
 */
import * as THREE from 'three';
import { World } from '../src/world/world.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertEq(got, want, msg) {
  if (got !== want) throw new Error(`${msg}\n       got:  ${got}\n       want: ${want}`);
}

// ═══════════════════════════════════════════════════ world broadphase visit stamps ══
//
// `_query`/`_march` dedup candidate boxes with a per-query stamp: `_stamp` is an
// Int32Array, `_tick` is a plain number. Past 2^31 the store truncates to negative while
// the counter keeps climbing as a double, so `stamp[bi] === tick` can never match again
// and the dedup is broken *permanently*. `_cand` is sized to the box count, so a box
// re-entered once per cell it touches overflows it, and writes past the end of a typed
// array are silently dropped — boxes vanish from the broadphase entirely.
//
// A tab never runs long enough. A server process at a full match does, in hours.

console.log('\nworld broadphase');

function pillarWorld() {
  const w = new World(null);
  w.addBoxRaw(-20, -1, -20, 20, 0, 20, 'concrete');
  for (let x = -16; x <= 16; x += 3) {
    for (let z = -16; z <= 16; z += 3) w.addBoxRaw(x - 0.6, 0, z - 0.6, x + 0.6, 3, z + 0.6, 'metal');
  }
  w.setBounds({ x: -25, y: -5, z: -25 }, { x: 25, y: 10, z: 25 });
  w.build();
  return w;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Rays + capsule moves reduced to a comparable digest. */
function probe(w) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    _o.set(Math.cos(a) * 2, 1.2, Math.sin(a) * 2);
    _d.set(Math.cos(a + 0.7), 0, Math.sin(a + 0.7)).normalize();
    const hit = w.raycast(_o, _d, 40);
    out.push(hit ? `${hit.distance.toFixed(5)}:${hit.surface}` : 'miss');
  }
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const p = new THREE.Vector3(Math.cos(a) * 5, 0.5, Math.sin(a) * 5);
    const v = new THREE.Vector3(Math.cos(a) * 6, -2, Math.sin(a) * 6);
    const r = w.move(p, v, 0.36, 1.8, 1 / 120);
    out.push(`${r.position.x.toFixed(5)},${r.position.y.toFixed(5)},${r.position.z.toFixed(5)},${r.grounded}`);
  }
  return out.join('|');
}

const baseline = probe(pillarWorld());

test('queries are unchanged with the stamp counter near the Int32 ceiling', () => {
  const w = pillarWorld();
  w._tick = 0x7ffffff0;
  assertEq(probe(w), baseline, 'probe digest diverged near the ceiling');
});

test('queries are unchanged across a stamp-counter wrap', () => {
  const w = pillarWorld();
  w._tick = 0x7ffffffd;
  assertEq(probe(w), baseline, 'probe digest diverged across the wrap');
  assert(w._tick < 0x7ffffffd, 'the guard never fired, so this proved nothing');
});

test('a wide query keeps every distinct box (the failure the guard prevents)', () => {
  const w = new World(null);
  w.addBoxRaw(-40, -1, -40, 40, 0, 40, 'concrete');     // spans every cell of the grid
  for (let i = 0; i < 40; i++) w.addBoxRaw(i, 0, 0, i + 0.5, 2, 0.5, 'metal');
  w.setBounds({ x: -45, y: -5, z: -45 }, { x: 45, y: 10, z: 45 });
  w.build();

  const wide = () => w._query(-40, -2, -40, 40, 4, 40);
  const goodCount = wide();
  const good = new Set(Array.from(w._cand.slice(0, goodCount)));
  assertEq(good.size, w.boxes.length, 'guarded query did not return every box');
  assert(goodCount <= w._cand.length, `candidate count ${goodCount} exceeded _cand capacity`);

  // 0x7fffffff is the last value that survives the store; ++ takes it to 2^31.
  w._tick = 0x7fffffff;
  const guarded = w._nextStamp;
  w._nextStamp = function () { return ++this._tick; };   // the pre-fix code
  const badCount = wide();
  const bad = new Set(Array.from(w._cand.slice(0, badCount)));
  w._nextStamp = guarded;

  assert(bad.size < good.size,
    'the unguarded path did not lose boxes, so the guard is not load-bearing here');
});

// ══════════════════════════════════════════════════════════════════════════ report ══

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n`, f.err);
  process.exit(1);
}
