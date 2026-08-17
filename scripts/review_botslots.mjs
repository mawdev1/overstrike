/**
 * THROWAWAY REVIEW PROBE (review_*). Drives the REAL src/ai/botModel.js in node.
 *
 * Verifies the InstancedMesh slot-compaction invariants under fuzzed
 * allocate / release / hide / blit sequences:
 *   I1  count[team] === number of live (non-disposed, slot>=0) models on that team
 *   I2  owner[team][s] for s < count is non-null, and owner[s].slot === s
 *   I3  owner[team][s] for s >= count is null
 *   I4  every live model owns a UNIQUE slot
 *   I5  every mesh.count === RIG.count[team]
 *   I6  slots >= count hold the zero matrix (nothing garbage is drawn)
 *   I7  after a blit pass, the matrix at model.slot equals that model's own
 *       bone matrixWorld  (i.e. no bot is drawn at another bot's transform)
 *   I8  the shared bounding sphere contains every live/visible bot's geometry
 */
import * as THREE from 'three';
import { BotModel, disposeBotRigs } from '../src/ai/botModel.js';

// ---------------------------------------------------------------- harness
let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL: ' + msg); };
const ok = (msg) => console.log('  ok: ' + msg);

function makeGame() {
  return {
    scene: new THREE.Scene(),
    frame: 0,
    rng: Object.assign(() => 0.37, { range: (a, b) => (a + b) * 0.5 }),
  };
}

// Reach into the module's private RIG through the meshes that were added to the scene.
function rigView(game, team) {
  const meshes = game.scene.children.filter((o) => o.name?.startsWith(`bot${team}_`));
  return meshes;
}

const _m = new THREE.Matrix4();
function matAt(mesh, i) { mesh.getMatrixAt(i, _m); return _m.elements.slice(); }
function isZeroMatrix(e) {
  // makeScale(0,0,0): diagonal 0, translation 0, [15] === 1
  return e[0] === 0 && e[5] === 0 && e[10] === 0 && e[12] === 0 && e[13] === 0 && e[14] === 0;
}

/** A fake Bot entity good enough for BotModel.update(). */
function makeBot(x, z, alive = true) {
  return {
    position: new THREE.Vector3(x, 0, z),
    velocity: new THREE.Vector3(1, 0, 0),
    yaw: x * 0.1, pitch: 0.1, height: 1.8, alive,
    anim: { aim: 1, reload: 0, deathYaw: 0 },
  };
}

// ---------------------------------------------------------------- checks
function checkInvariants(game, models, label) {
  for (const team of [0, 1]) {
    const meshes = rigView(game, team);
    if (!meshes.length) continue;
    const live = models.filter((m) => !m.disposed && m.team === team && m.slot >= 0);
    const count = meshes[0].count;

    // I5
    for (const mesh of meshes) {
      if (mesh.count !== count) fail(`${label} t${team}: mesh ${mesh.name} count ${mesh.count} != ${count}`);
    }
    // I1
    if (count !== live.length) fail(`${label} t${team}: count ${count} != live ${live.length}`);
    // I4 + I2
    const seen = new Map();
    for (const m of live) {
      if (m.slot >= count) fail(`${label} t${team}: model slot ${m.slot} >= count ${count} (would never be drawn)`);
      if (seen.has(m.slot)) fail(`${label} t${team}: slot ${m.slot} shared by two live models`);
      seen.set(m.slot, m);
    }
    for (let s = 0; s < count; s++) {
      if (!seen.has(s)) fail(`${label} t${team}: slot ${s} < count has no owner (garbage instance drawn)`);
    }
    // I6
    for (const mesh of meshes) {
      for (let s = count; s < 32; s++) {
        if (!isZeroMatrix(matAt(mesh, s))) fail(`${label} t${team}: parked slot ${s} of ${mesh.name} is not zeroed`);
      }
    }
    // I7 — matrix at each live model's slot must equal that model's own bone world matrix
    const BONES = meshes.map((mm) => mm.name.split('_')[1]);
    for (const m of live) {
      // Only meaningful once the model has actually written its own pose and has not
      // been hidden since (a hidden slot legitimately holds the zero matrix).
      if (!m.visible || !m.__authoritative) continue;
      for (let i = 0; i < meshes.length; i++) {
        const want = m.bones[BONES[i]].matrixWorld.elements;
        const got = matAt(meshes[i], m.slot);
        for (let k = 0; k < 16; k++) {
          if (Math.abs(want[k] - got[k]) > 1e-6) {
            fail(`${label} t${team}: bone ${BONES[i]} at slot ${m.slot} is NOT this model's matrix `
              + `(el${k} want ${want[k].toFixed(4)} got ${got[k].toFixed(4)}) — drawn at another bot's pose`);
            k = 16; i = meshes.length;
          }
        }
      }
    }
  }
}

function blitAll(game, models, bots) {
  game.frame++;
  for (let i = 0; i < models.length; i++) {
    if (models[i].disposed) continue;
    models[i].update(1 / 120, bots[i]);
    if (models[i].visible) models[i].__authoritative = true;
  }
}

/** setVisible(false) legitimately zeroes the slot, so the pose is no longer authoritative. */
function hide(m, v) { m.setVisible(v); if (!v) m.__authoritative = false; }

/** I8 — sphere must contain every visible bot's geometry. */
function checkSphere(game, models, bots, label) {
  for (const team of [0, 1]) {
    const meshes = rigView(game, team);
    if (!meshes.length) continue;
    const sphere = meshes[0].boundingSphere;
    if (!sphere) { fail(`${label} t${team}: no boundingSphere`); continue; }
    for (const mm of meshes) {
      if (mm.boundingSphere !== sphere) fail(`${label} t${team}: ${mm.name} has a different sphere object`);
    }
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      if (m.disposed || m.team !== team || m.slot < 0 || !m.visible) continue;
      // sample each bone origin; must be inside the sphere with room for the geometry
      for (const name of Object.keys(m.bones)) {
        const e = m.bones[name].matrixWorld.elements;
        const d = Math.hypot(e[12] - sphere.center.x, e[13] - sphere.center.y, e[14] - sphere.center.z);
        if (d > sphere.radius) {
          fail(`${label} t${team}: bone ${name} of slot ${m.slot} is ${d.toFixed(2)} from sphere centre, `
            + `radius ${sphere.radius.toFixed(2)} — bot frustum-culled while alive`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- tests
console.log('\n=== T1: release the TOP slot (slot === count-1) ===');
{
  const game = makeGame();
  const models = [], bots = [];
  for (let i = 0; i < 4; i++) { models.push(new BotModel(game, 0)); bots.push(makeBot(i * 3, 0)); }
  blitAll(game, models, bots);
  checkInvariants(game, models, 'T1 pre');
  models[3].dispose();
  models.splice(3, 1); bots.splice(3, 1);
  checkInvariants(game, models, 'T1 post-top-release');
  blitAll(game, models, bots);
  checkInvariants(game, models, 'T1 post-blit');
  ok('top-slot release');
  for (const m of models) m.dispose();
  disposeBotRigs();
}

console.log('\n=== T2: release the BOTTOM slot, then render WITHOUT another update ===');
{
  const game = makeGame();
  const models = [], bots = [];
  for (let i = 0; i < 4; i++) { models.push(new BotModel(game, 0)); bots.push(makeBot(i * 5, i * 2)); }
  blitAll(game, models, bots);
  const topModel = models[3];
  models[0].dispose();
  models.splice(0, 1); bots.splice(0, 1);
  if (topModel.slot !== 0) fail(`T2: expected top model to move into slot 0, got ${topModel.slot}`);
  // NO blit here — this is the "one frame" window the claim depends on.
  checkInvariants(game, models, 'T2 immediately-after-release-no-update');
  ok('bottom-slot release, matrices carried across without a re-blit');
  for (const m of models) m.dispose();
  disposeBotRigs();
}

console.log('\n=== T3: multiple releases in one frame (2, 3, all) ===');
for (const nKill of [2, 3, 6]) {
  const game = makeGame();
  const models = [], bots = [];
  for (let i = 0; i < 6; i++) { models.push(new BotModel(game, 0)); bots.push(makeBot(i * 4, -i)); }
  blitAll(game, models, bots);
  // kill from the middle outwards in one "frame"
  const order = [2, 0, 4, 1, 5, 3].slice(0, nKill);
  const doomed = order.map((i) => models[i]);
  for (const d of doomed) {
    d.dispose();
    const ix = models.indexOf(d); models.splice(ix, 1); bots.splice(ix, 1);
    checkInvariants(game, models, `T3(n=${nKill}) mid`);
  }
  checkInvariants(game, models, `T3(n=${nKill}) after`);
  blitAll(game, models, bots);
  checkInvariants(game, models, `T3(n=${nKill}) after-blit`);
  for (const m of models) m.dispose();
  disposeBotRigs();
}
ok('multi-release in one frame');

console.log('\n=== T4: fuzz — 4000 random acquire/release/hide/blit ops, both teams ===');
{
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const game = makeGame();
  let models = [], bots = [];
  for (let step = 0; step < 4000; step++) {
    const r = rnd();
    if (r < 0.35 && models.length < 40) {
      const team = rnd() < 0.5 ? 0 : 1;
      const m = new BotModel(game, team);
      models.push(m); bots.push(makeBot(rnd() * 60 - 30, rnd() * 60 - 30, rnd() > 0.15));
    } else if (r < 0.6 && models.length) {
      const ix = Math.floor(rnd() * models.length);
      models[ix].dispose();
      models.splice(ix, 1); bots.splice(ix, 1);
      if (models.length === 0) { /* rig auto-teardown */ }
    } else if (r < 0.72 && models.length) {
      const ix = Math.floor(rnd() * models.length);
      hide(models[ix], rnd() < 0.5);
    } else {
      blitAll(game, models, bots);
      checkSphere(game, models, bots, `T4@${step}`);
    }
    checkInvariants(game, models, `T4@${step}`);
    if (failures > 12) { console.error('  (aborting fuzz — too many failures)'); break; }
  }
  for (const m of models) m.dispose();
  disposeBotRigs();
  ok('fuzz complete');
}

console.log('\n=== T5: capacity exhaustion (33 on one team) then release ===');
{
  const game = makeGame();
  const models = [], bots = [];
  const warn = console.warn; let warns = 0; console.warn = () => { warns++; };
  for (let i = 0; i < 34; i++) { models.push(new BotModel(game, 0)); bots.push(makeBot(i, 0)); }
  console.warn = warn;
  if (warns !== 2) fail(`T5: expected 2 capacity warnings, got ${warns}`);
  blitAll(game, models, bots);
  checkInvariants(game, models, 'T5 full');
  // release one from the middle; the two overflow models must NOT get promoted
  models[5].dispose(); models.splice(5, 1); bots.splice(5, 1);
  checkInvariants(game, models, 'T5 after-release');
  const orphans = models.filter((m) => m.slot < 0);
  if (orphans.length !== 2) fail(`T5: expected 2 permanently-invisible overflow models, got ${orphans.length}`);
  else ok('overflow models stay invisible forever even after a slot frees up (capacity regression)');
  for (const m of models) m.dispose();
  disposeBotRigs();
}

console.log('\n=== T6: hidden (deactivated) model gets compacted; must stay hidden ===');
{
  const game = makeGame();
  const models = [], bots = [];
  for (let i = 0; i < 3; i++) { models.push(new BotModel(game, 0)); bots.push(makeBot(i * 6, 0)); }
  blitAll(game, models, bots);
  hide(models[2], false);                 // top model hidden
  models[0].dispose(); models.splice(0, 1); bots.splice(0, 1);
  const hidden = models[1];
  const meshes = rigView(game, 0);
  let bad = false;
  for (const mesh of meshes) if (!isZeroMatrix(matAt(mesh, hidden.slot))) bad = true;
  if (bad) fail('T6: hidden model was compacted into a slot holding a VISIBLE stale matrix — ghost bot rendered');
  else ok('hidden model stays zeroed after compaction');
  checkInvariants(game, models, 'T6');
  for (const m of models) m.dispose();
  disposeBotRigs();
}

console.log('\n=== T7: sphere freshness — bot that does NOT blit this frame ===');
{
  const game = makeGame();
  const models = [], bots = [];
  for (let i = 0; i < 3; i++) { models.push(new BotModel(game, 0)); bots.push(makeBot(i * 30, 0)); }
  blitAll(game, models, bots);
  const meshes = rigView(game, 0);
  const s0 = meshes[0].boundingSphere.clone();
  console.log(`  all 3 blitted: centre (${s0.center.x.toFixed(1)}, ${s0.center.y.toFixed(1)}, `
    + `${s0.center.z.toFixed(1)}) r=${s0.radius.toFixed(2)}`);
  // Now only ONE of the three updates this frame (simulates a bot whose update is skipped)
  game.frame++;
  models[0].update(1 / 120, bots[0]);
  const s1 = meshes[0].boundingSphere;
  console.log(`  only slot 0 blitted: centre (${s1.center.x.toFixed(1)}, ${s1.center.y.toFixed(1)}, `
    + `${s1.center.z.toFixed(1)}) r=${s1.radius.toFixed(2)}`);
  // slots 1 and 2 are still DRAWN (count is 3) but are they inside the sphere?
  for (let i = 1; i < 3; i++) {
    const e = models[i].bones.head.matrixWorld.elements;
    const d = Math.hypot(e[12] - s1.center.x, e[13] - s1.center.y, e[14] - s1.center.z);
    if (d > s1.radius) {
      console.log(`  >> model ${i} head is ${d.toFixed(2)} outside a sphere of r=${s1.radius.toFixed(2)} `
        + `— it is still drawn (count=${meshes[0].count}) but the WHOLE TEAM culls together, `
        + `so a camera that sees only model ${i} draws nothing.`);
    }
  }
  for (const m of models) m.dispose();
  disposeBotRigs();
}

console.log('\n=== T8: game.frame undefined (headless / mock game) ===');
{
  const game = makeGame();
  delete game.frame;
  const models = [], bots = [];
  for (let i = 0; i < 3; i++) { models.push(new BotModel(game, 0)); bots.push(makeBot(i * 25, 0)); }
  for (let i = 0; i < models.length; i++) models[i].update(1 / 120, bots[i]);
  const s = rigView(game, 0)[0].boundingSphere;
  console.log(`  sphere r=${s.radius.toFixed(2)} centre x=${s.center.x.toFixed(1)} `
    + `(3 bots spread over 50 m)`);
  if (s.radius < 20) console.log('  >> sphere only covers the LAST bot — every other bot of the team culled.');
  for (const m of models) m.dispose();
  disposeBotRigs();
}

console.log(failures === 0 ? '\nALL INVARIANTS HELD\n' : `\n${failures} INVARIANT FAILURES\n`);
process.exit(0);
