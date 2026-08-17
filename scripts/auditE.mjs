/**
 * AUDIT E — contract conformance.
 *
 *  §3  every canonical event carries the documented payload shape (and the enums hold)
 *  §4  player and bots expose the identical entity shape
 *  §5/§6  POOLED-OBJECT RETENTION — the important one.
 *      `world.move()` returns one shared object, `world.raycast()` cycles a ring of 8,
 *      and ballistics reuses its bus payloads and its damage `info`. This probe captures
 *      the identity of every pooled object, plays real combat, then walks the whole
 *      `game` object graph looking for anyone still holding one. A hit is a real bug:
 *      the holder will read mutated data on a later frame.
 */
import { boot } from './auditlib.mjs';

const h = await boot({ port: 5305, viewport: { width: 640, height: 480 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], events: {}, entity: {}, pooled: {}, retention: [] };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };

  // ══════════════════════════════════════════════════════ §3 event payload shapes
  const SPEC = {
    damage: ['target', 'attacker', 'amount', 'hitPart', 'point', 'normal', 'weaponId', 'headshot'],
    kill: ['victim', 'attacker', 'weaponId', 'headshot', 'distance'],
    shot: ['shooter', 'weaponId', 'origin', 'dir', 'isPlayer'],
    hit: ['shooter', 'target', 'point', 'normal', 'headshot', 'surface'],
    impact: ['point', 'normal', 'surface', 'weaponId'],
    reloadStart: ['shooter', 'weaponId'],
    reloadEnd: ['shooter', 'weaponId'],
    weaponSwitch: ['shooter', 'weaponId'],
    explosion: ['point', 'radius', 'damage', 'attacker', 'weaponId'],
    spawn: ['entity'],
    playerDamaged: ['amount', 'dirWorld'],
    matchStart: ['mode', 'scores'],
    matchEnd: ['mode', 'scores'],
    killstreak: ['entity', 'count'],
    notice: ['text', 'sub', 'duration'],
  };
  const HIT_PARTS = new Set(['head', 'torso', 'limb']);
  const SURFACES = new Set(['concrete', 'metal', 'wood', 'dirt', 'glass', 'flesh', 'sand']);

  const seen = {};           // event -> { count, missing:Set, identities:Set }
  const identityProbe = {};  // event -> array of payload object refs (first 3)
  const unsubs = [];
  for (const name of Object.keys(SPEC)) {
    seen[name] = { count: 0, missing: new Set(), badEnum: new Set(), sameObject: true, firstRef: null };
    identityProbe[name] = [];
    unsubs.push(g.bus.on(name, (p) => {
      const s = seen[name];
      s.count++;
      if (s.firstRef === null) s.firstRef = p;
      else if (p !== s.firstRef) s.sameObject = false;
      if (identityProbe[name].length < 3) identityProbe[name].push(p);
      if (p == null || typeof p !== 'object') { s.missing.add('<not an object>'); return; }
      for (const k of SPEC[name]) if (!(k in p)) s.missing.add(k);
      if (name === 'damage' && p.hitPart != null && !HIT_PARTS.has(p.hitPart)) s.badEnum.add(`hitPart=${p.hitPart}`);
      if ((name === 'hit' || name === 'impact') && p.surface != null && !SURFACES.has(p.surface)) s.badEnum.add(`surface=${p.surface}`);
    }));
  }

  // ── play a real, violent match so every event actually fires
  g.settings.set('botCount', 8);
  g.startMatch({ mode: 'tdm', botCount: 8, difficulty: 'veteran', seed: 2468 });
  sim(600);
  const p = g.player;
  for (let i = 0; i < 120 * 60; i++) {
    g._fixedUpdate(1 / 120);
    if (p.alive) {
      p.weapon?.tryFire?.();
      if (i % 200 === 0) p.yaw += 0.9;
      if (i % 900 === 0) g.weapons.throwGrenade?.(p, 'lethal', 0.7, 0);
      if (i % 1500 === 0) p.weapon?.reload?.();
      if (i % 1800 === 0) g.weapons.nextWeapon?.(p);
    }
    if (i % 400 === 0) g._update(1 / 60);
  }

  for (const [name, s] of Object.entries(seen)) {
    R.events[name] = {
      count: s.count,
      missing: [...s.missing],
      badEnum: [...s.badEnum],
      pooledSingleInstance: s.count > 1 ? s.sameObject : null,
    };
  }
  const neverFired = Object.entries(R.events).filter(([, v]) => v.count === 0).map(([k]) => k);
  const malformed = Object.entries(R.events).filter(([, v]) => v.count > 0 && (v.missing.length || v.badEnum.length));
  ok('§3:allCanonicalEventsFire', neverFired.length === 0, `never fired: ${neverFired.join(', ') || 'none'}`);
  ok('§3:payloadShapes', malformed.length === 0,
    malformed.length ? malformed.map(([k, v]) => `${k} missing[${v.missing}] bad[${v.badEnum}]`).join(' | ') : 'all payloads carry the documented fields');

  // Non-canonical events actually in use (informational — §3 says do not invent variants).
  R.busEventNames = [...g.bus.map.keys()].sort();
  R.nonCanonical = R.busEventNames.filter((n) => !SPEC[n]);

  // ══════════════════════════════════════════════════════ §4 entity contract
  const FIELDS = {
    id: 'number', isPlayer: 'boolean', team: 'number', alive: 'boolean', name: 'string',
    yaw: 'number', pitch: 'number', height: 'number', radius: 'number', eyeHeight: 'number',
    health: 'number', maxHealth: 'number', armor: 'number',
  };
  const checkEntity = (e, label) => {
    const bad = [];
    for (const [k, t] of Object.entries(FIELDS)) if (typeof e[k] !== t) bad.push(`${k}:${typeof e[k]}!=${t}`);
    for (const k of ['position', 'velocity']) if (!e[k]?.isVector3) bad.push(`${k} not Vector3`);
    for (const k of ['applyDamage', 'die', 'getEyePosition', 'getAimDirection']) {
      if (typeof e[k] !== 'function') bad.push(`${k} not a function`);
    }
    if (!Array.isArray(e.hitboxes) || e.hitboxes.length === 0) bad.push('hitboxes missing');
    else {
      const parts = new Set(e.hitboxes.map((hb) => hb.part));
      for (const hb of e.hitboxes) {
        if (!HIT_PARTS.has(hb.part)) bad.push(`hitbox part ${hb.part}`);
        if (!hb.offset?.isVector3 || !hb.size?.isVector3) bad.push('hitbox offset/size not Vector3');
      }
      if (!parts.has('head')) bad.push('no head hitbox');
      if (!parts.has('torso')) bad.push('no torso hitbox');
    }
    if (!e.stats || ['kills', 'deaths', 'score', 'streak'].some((k) => typeof e.stats[k] !== 'number')) bad.push('stats shape');
    if (Math.abs(e.radius - 0.36) > 1e-6) bad.push(`radius=${e.radius} (spec 0.36)`);
    if (!('weapon' in e)) bad.push('no weapon field');
    return { label, bad, hitboxes: e.hitboxes?.length ?? 0 };
  };
  const entReports = [checkEntity(g.player, 'player'), ...g.bots.bots.slice(0, 3).map((b, i) => checkEntity(b, `bot${i}`))];
  R.entity.reports = entReports;
  ok('§4:entityShape', entReports.every((r) => r.bad.length === 0),
    entReports.filter((r) => r.bad.length).map((r) => `${r.label}: ${r.bad.join(', ')}`).join(' | ') || 'player and bots match the §4 contract');

  // ══════════════════════════════════════════ §5/§6 pooled-object retention hunt
  // Collect the identity of every pooled object the engine hands out.
  const pooledObjs = new Map();   // object -> label
  const mark = (obj, label) => {
    if (!obj || typeof obj !== 'object') return;
    if (!pooledObjs.has(obj)) pooledObjs.set(obj, label);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object' && v.isVector3 && !pooledObjs.has(v)) pooledObjs.set(v, `${label}.${k}`);
    }
  };

  // world.move() — one shared result object.
  const V = g.player.position.constructor;
  const mv1 = g.world.move(g.player.position, new V(1, 0, 0), 0.36, 1.8, 1 / 120);
  const mv2 = g.world.move(g.player.position, new V(0, 0, 1), 0.36, 1.8, 1 / 120);
  R.pooled.moveIsShared = mv1 === mv2;
  mark(mv1, 'world.move()');

  // world.raycast() — ring of 8.
  const rays = [];
  for (let i = 0; i < 10; i++) {
    const dir = new V(Math.cos(i), -0.2, Math.sin(i)).normalize();
    const r = g.world.raycast(g.player.position, dir, 200);
    if (r) { rays.push(r); mark(r, `world.raycast()[${i}]`); }
  }
  R.pooled.raycastDistinct = new Set(rays).size;
  R.pooled.raycastCalls = rays.length;

  // ballistics bus payloads + the `info` passed to applyDamage.
  for (const [name, arr] of Object.entries(identityProbe)) {
    if (arr.length) mark(arr[0], `bus:${name}`);
  }
  // The `info` object ballistics hands to entity.applyDamage is the same pooled _evDamage.
  let infoRef = null;
  const bot = g.bots.bots.find((b) => b.alive) || g.bots.bots[0];
  const realApply = bot.applyDamage.bind(bot);
  bot.applyDamage = (amount, info) => { infoRef = info; return realApply(amount, info); };
  const ball = await import('/src/weapons/ballistics.js');
  ball.applyExplosionDamage(g, { point: bot.position.clone(), radius: 5, damage: 30, attacker: g.player, weaponId: 'frag' });
  bot.applyDamage = realApply;
  if (infoRef) mark(infoRef, 'ballistics applyDamage(info)');
  R.pooled.applyDamageInfoIsBusPayload = infoRef === identityProbe.damage[0];

  ok('§5:moveResultPooled', R.pooled.moveIsShared, 'world.move() returns one shared object (as documented)');
  ok('§5:raycastRingOf8', R.pooled.raycastDistinct <= 8 && R.pooled.raycastDistinct > 1,
    `${R.pooled.raycastCalls} raycasts returned ${R.pooled.raycastDistinct} distinct objects`);

  // ── let the game breathe, then hunt for anyone still holding a pooled object
  sim(120 * 3);
  g._update(1 / 60);

  const SKIP = new Set(['__proto__']);
  const found = [];
  const visited = new Set();
  const walk = (obj, pathStr, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 7) return;
    if (visited.has(obj)) return;
    visited.add(obj);
    let keys;
    try { keys = Object.keys(obj); } catch { return; }
    for (const k of keys) {
      if (SKIP.has(k)) continue;
      let v;
      try { v = obj[k]; } catch { continue; }
      if (!v || typeof v !== 'object') continue;
      const path = `${pathStr}.${k}`;
      if (pooledObjs.has(v)) { found.push({ path, pooled: pooledObjs.get(v) }); continue; }
      // Do not descend into THREE render objects — enormous and irrelevant.
      if (v.isObject3D || v.isBufferGeometry || v.isMaterial || v.isTexture || v.isWebGLRenderer) continue;
      walk(v, path, depth + 1);
    }
  };
  walk(g, 'game', 0);
  R.retention = found;
  ok('§5:noPooledObjectRetained', found.length === 0,
    found.length ? found.map((f) => `${f.path} holds ${f.pooled}`).join(' | ') : 'nothing in the game graph holds a pooled object');

  // Focused check on the HUD path that stores a `damage` payload for later frames.
  R.hudPendingSelfDamage = {
    holds: g.hud?._pendingSelfDamage != null,
    isPooledBusPayload: g.hud?._pendingSelfDamage === identityProbe.damage[0],
  };

  for (const u of unsubs) u();
  return R;
});

console.log('\n=========== AUDIT E — CONTRACTS ===========');
let fails = 0;
for (const c of out.checks) { if (!c.pass) fails++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`); }
console.log(`\n  ${out.checks.length - fails}/${out.checks.length} passed`);
console.log('\n§3 events:', JSON.stringify(out.events, null, 1));
console.log('\nnon-canonical bus events in use:', JSON.stringify(out.nonCanonical));
console.log('\n§4 entity:', JSON.stringify(out.entity, null, 1));
console.log('\npooled:', JSON.stringify(out.pooled, null, 1));
console.log('\nretention hits:', JSON.stringify(out.retention, null, 1));
console.log('\nhud._pendingSelfDamage:', JSON.stringify(out.hudPendingSelfDamage));
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 12));
if (h.consoleErrors.length) console.log('\nconsole errors:', [...new Set(h.consoleErrors)].slice(0, 12));

await h.close();
