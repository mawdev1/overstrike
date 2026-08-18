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
import { createRNG, mixSeed } from '../src/core/rng.js';
import { defineSnapshot } from '../src/core/snapshot.js';

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

// ═══════════════════════════════════════════════════════════ rng snapshot / restore ══
//
// Reconciliation replays a tick and demands an identical result. Any draw taken during
// that tick must come from the same stream position both times, so the position is
// simulation state and has to be capturable.
//
// The trap is `gauss`: it rejection-samples (a variable number of draws) and banks its
// second Box-Muller sample. Two streams with the same `a` but different banked samples
// are NOT in the same state, and the difference only shows up on the next gauss call —
// i.e. several ticks later, as a shot that lands somewhere else.

console.log('\nrng snapshot / restore');

test('a restored stream replays an identical sequence', () => {
  const r = createRNG(0xBEEF);
  for (let i = 0; i < 17; i++) r();               // arbitrary starting offset
  const st = r.getState();
  const first = Array.from({ length: 32 }, () => r());
  r.setState(st);
  const second = Array.from({ length: 32 }, () => r());
  for (let i = 0; i < first.length; i++) {
    assertEq(second[i], first[i], `draw ${i} diverged after restore`);
  }
});

test('restore rewinds a stream that has run on past the capture', () => {
  const r = createRNG(0x1234);
  const st = r.getState();
  const want = r();
  for (let i = 0; i < 500; i++) r();             // run far past the snapshot
  r.setState(st);
  assertEq(r(), want, 'the first draw after restore was not the captured one');
});

test('getState fills a provided out-object without allocating', () => {
  const r = createRNG(7);
  const out = {};
  const ret = r.getState(out);
  assert(ret === out, 'getState did not return the out-object it was given');
  assert(typeof out.a === 'number', 'out.a was not populated');
});

test('gauss replays identically across a restore', () => {
  const r = createRNG(0xC0FFEE);
  const st = r.getState();
  const first = Array.from({ length: 16 }, () => r.gauss());
  r.setState(st);
  const second = Array.from({ length: 16 }, () => r.gauss());
  for (let i = 0; i < first.length; i++) {
    assertEq(second[i], first[i], `gauss ${i} diverged after restore`);
  }
});

test('the banked gauss sample is part of the state, not incidental', () => {
  // Capture with a sample banked (odd number of gauss calls leaves `spare` set), then
  // restore and confirm the very next gauss returns the banked one. Capturing `a` alone
  // would drop it and return a freshly drawn value instead.
  const r = createRNG(0x5EED);
  r.gauss();                                      // banks the second sample
  const st = r.getState();
  assert(st.spare !== null && st.spare !== undefined,
    'test precondition: expected a banked sample after an odd number of gauss calls');
  const want = r.gauss();                         // should consume the bank
  assertEq(want, st.spare, 'precondition: the next gauss did not return the banked sample');
  r.setState(st);
  assertEq(r.gauss(), want, 'the banked sample did not survive the restore');
});

test('a state restored without a banked sample does not inherit a stale one', () => {
  const r = createRNG(0x5EED);
  r.gauss(); r.gauss();                           // even count — bank is spent
  const clean = r.getState();
  assertEq(clean.spare, null, 'precondition: expected an empty bank');
  r.gauss();                                      // re-bank
  r.setState(clean);
  const after = r.getState();
  assertEq(after.spare, null, 'restoring an empty bank left the previous sample behind');
});

test('setState tolerates a state that has been through JSON', () => {
  // `spare: null` survives JSON; a state captured mid-bank keeps its number. Both must
  // restore identically to the in-memory object, or a snapshot sent over the wire
  // desyncs from the same snapshot kept locally.
  const r = createRNG(0xABCD);
  r.gauss();
  const st = r.getState();
  const viaJson = JSON.parse(JSON.stringify(st));
  const want = r.gauss();
  r.setState(viaJson);
  assertEq(r.gauss(), want, 'a JSON round-tripped state did not restore identically');
});

test('mixSeed gives each index an independent stream', () => {
  const base = 0x12345678;
  const firstDraws = new Set();
  for (let i = 0; i < 32; i++) {
    const seed = mixSeed(base, i);
    assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xFFFFFFFF,
      `mixSeed(${base}, ${i}) produced a non-uint32: ${seed}`);
    firstDraws.add(createRNG(seed)());
  }
  assertEq(firstDraws.size, 32, 'two indices produced the same first draw — streams are not independent');
});

// ══════════════════════════════════════════════════ snapshot manifest machinery ══
//
// Save/restore is generated from a declared field list rather than hand-written, because
// a Player carries ~70 mutable fields and a missed one does not fail loudly — it produces
// rare rubber-banding under conditions nobody can reproduce. These tests cover the
// machinery; the manifests themselves are audited separately against live instances.

console.log('\nsnapshot manifest machinery');

const makeSpec = () => defineSnapshot('Thing', {
  scalars: ['health', 'alive', 'name'],
  vec3s: ['position'],
  objects: { held: ['fwd', 'jump'] },
  ignore: ['game'],
});

const makeThing = () => ({
  health: 100,
  alive: true,
  name: 'a',
  position: { x: 1, y: 2, z: 3 },
  held: { fwd: 1, jump: false },
  game: { huge: true },
});

test('save then restore round-trips every declared field', () => {
  const m = makeSpec();
  const t = makeThing();
  const snap = m.save(t);
  t.health = 5; t.alive = false; t.name = 'b';
  t.position.x = 99; t.position.y = 98; t.position.z = 97;
  t.held.fwd = -1; t.held.jump = true;
  m.restore(t, snap);
  assertEq(t.health, 100, 'scalar not restored');
  assertEq(t.alive, true, 'bool not restored');
  assertEq(t.name, 'a', 'string not restored');
  assertEq(t.position.x, 1, 'vec3.x not restored');
  assertEq(t.position.z, 3, 'vec3.z not restored');
  assertEq(t.held.fwd, 1, 'nested field not restored');
  assertEq(t.held.jump, false, 'nested bool not restored');
});

test('a vec3 snapshot does not alias the live entity', () => {
  // The bug this prevents: assigning the reference instead of copying components means
  // the "snapshot" IS the entity's vector, so mutating the entity silently rewrites
  // history and restore becomes a no-op.
  const m = makeSpec();
  const t = makeThing();
  const snap = m.save(t);
  t.position.x = 42;
  assertEq(snap.position.x, 1, 'the snapshot tracked the live vector — it aliases');
  m.restore(t, snap);
  assertEq(t.position.x, 1, 'restore did not undo the mutation');
});

test('a nested object snapshot does not alias the live entity', () => {
  const m = makeSpec();
  const t = makeThing();
  const snap = m.save(t);
  t.held.fwd = 42;
  assertEq(snap.held.fwd, 1, 'the snapshot tracked the live sub-object — it aliases');
});

test('restore writes into the existing vec3 rather than replacing it', () => {
  // Player.position is handed to systems that keep the reference (hitboxes, bots reading
  // a noise origin). Replacing the object on restore would leave them pointing at the
  // pre-restore vector, so the entity would move while its hitboxes did not.
  const m = makeSpec();
  const t = makeThing();
  const snap = m.save(t);
  const held = t.position;
  t.position.x = 9;
  m.restore(t, snap);
  assert(t.position === held, 'restore replaced the Vector3 instead of writing into it');
});

test('save reuses a provided out-object', () => {
  const m = makeSpec();
  const t = makeThing();
  const out = {};
  const a = m.save(t, out);
  assert(a === out, 'save did not return the out-object it was given');
  const vec = out.position;
  t.position.x = 7;
  m.save(t, out);
  assert(out.position === vec, 'save reallocated the nested vec3 instead of reusing it');
  assertEq(out.position.x, 7, 'the reused out-object was not updated');
});

test('diff names the fields that actually differ', () => {
  const m = makeSpec();
  const a = m.save(makeThing());
  const t2 = makeThing();
  t2.health = 50;
  t2.position.z = 0;
  t2.held.jump = true;
  const b = m.save(t2);
  const d = m.diff(a, b);
  assert(d.includes('health'), `diff missed health: ${d}`);
  assert(d.includes('position'), `diff missed position: ${d}`);
  assert(d.includes('held.jump'), `diff missed held.jump: ${d}`);
  assertEq(d.length, 3, `diff reported extra fields: ${d}`);
});

test('diff is empty for identical states', () => {
  const m = makeSpec();
  assertEq(m.diff(m.save(makeThing()), m.save(makeThing())).length, 0,
    'two identical entities compared as divergent');
});

test('diff treats NaN as agreement and -0 as divergence', () => {
  // NaN on both sides is the same state; +0 vs -0 is not, because it flips the sign of
  // anything that divides by it.
  const m = makeSpec();
  const a = makeThing(); a.health = NaN;
  const b = makeThing(); b.health = NaN;
  assertEq(m.diff(m.save(a), m.save(b)).length, 0, 'NaN vs NaN reported as divergence');
  const c = makeThing(); c.health = 0;
  const d = makeThing(); d.health = -0;
  assert(m.diff(m.save(c), m.save(d)).includes('health'), '+0 vs -0 reported as agreement');
});

test('audit reports a field that is neither captured nor ignored', () => {
  // The forgotten-field guard: this is what fails on the branch of whoever adds a field
  // to Player without thinking about reconciliation.
  const m = makeSpec();
  const t = makeThing();
  t.newlyAddedField = 3;
  const { missing } = m.audit(t);
  assertEq(missing.length, 1, `expected exactly one uncovered field, got ${missing}`);
  assertEq(missing[0], 'newlyAddedField', 'audit named the wrong field');
});

test('audit is silent for a fully declared instance', () => {
  const m = makeSpec();
  assert(m.audit(makeThing()).ok, 'audit flagged a fully declared instance');
});

test('audit ignores prototype getters', () => {
  // Derived values have nothing to restore, and a manifest should not have to list them.
  const m = makeSpec();
  const proto = { get derived() { return 1; } };
  const t = Object.assign(Object.create(proto), makeThing());
  assert(m.audit(t).ok, 'audit flagged a prototype getter');
});

test('audit flags a manifest name that is not on the instance', () => {
  // The mirror image of a forgotten field, and the same class of bug. A mistyped scalar
  // is the dangerous one: save records `undefined` and restore writes it back, silently
  // and permanently, while the manifest reads as though the field were covered.
  const m = defineSnapshot('Typo', { scalars: ['health', 'helth'] });
  const { stale, ok } = m.audit({ health: 1 });
  assert(!ok, 'audit passed an instance missing a declared field');
  assertEq(stale.length, 1, `expected one stale name, got ${stale}`);
  assertEq(stale[0], 'helth', 'audit named the wrong stale field');
});

test('a null vec3 is refused loudly at save, naming the field', () => {
  // Nullable vectors are not supported, and the refusal is the feature. `restore` writes
  // into the existing object so the references other systems hold stay valid; if a field
  // can be null there is nothing to write into, and handing back a plain {x,y,z} would
  // break the first `.copy()` the fixed step makes — moving the crash one tick later
  // rather than preventing it. Fail where the message can name the field.
  const m = defineSnapshot('Nullable', { vec3s: ['target'] });
  let msg = '';
  try { m.save({ target: null }); } catch (e) { msg = e.message; }
  assert(msg.includes('target'), `expected the error to name the field, got: ${msg || '(no throw)'}`);
  assert(msg.includes('Nullable'), `expected the error to name the manifest, got: ${msg}`);
});

test('diff reports every differing key of a nested object, not just the first', () => {
  // `_edge` has 15 keys and `_held` 10. Stopping at the first would mean re-running to
  // find the rest, which is the opposite of what diff is for.
  const m = defineSnapshot('Nested', { objects: { o: ['a', 'b', 'c'] } });
  const d = m.diff(m.save({ o: { a: 1, b: 1, c: 1 } }), m.save({ o: { a: 2, b: 1, c: 2 } }));
  assertEq(d.length, 2, `expected both differing keys, got ${d}`);
  assert(d.includes('o.a') && d.includes('o.c'), `wrong keys reported: ${d}`);
});

test('verify names the keys a wire-arrived snapshot is missing', () => {
  const m = defineSnapshot('Wire', { scalars: ['a', 'b'], objects: { o: ['x'] } });
  const good = m.save({ a: 1, b: 2, o: { x: 3 } });
  assertEq(m.verify(good).length, 0, 'verify flagged a complete snapshot');
  delete good.b;
  delete good.o.x;
  const absent = m.verify(good);
  assert(absent.includes('b'), `verify missed the dropped scalar: ${absent}`);
  assert(absent.includes('o.x'), `verify missed the dropped nested key: ${absent}`);
});

test('declaring a field twice throws at definition time', () => {
  let threw = false;
  try {
    defineSnapshot('Bad', { scalars: ['a'], ignore: ['a'] });
  } catch { threw = true; }
  assert(threw, 'a field declared as both captured and ignored was accepted');
});

// ══════════════════════════════════════════════════════════════════════════ report ══

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`\n${f.name}:\n`, f.err);
  process.exit(1);
}
