/**
 * AUDIT H — root-cause probes for the two failures auditD found, plus the
 * duplicated-input-handler question auditG raised.
 *
 *  H1. Same seed, two consecutive matches diverge at fixed step 0. Is the cause that
 *      the spawn placement is scored against entity positions LEFT OVER from the
 *      previous match? Normalise every entity to a canonical position before each
 *      startMatch and see whether the divergence disappears.
 *  H2. With that normalisation applied, is the simulation frame-rate independent?
 *      (auditD's frame-rate test was confounded by H1.)
 *  H3. Melee and grenade are each handled by two systems off the same input action.
 *      Count the actual calls and the actual projectiles.
 */
import { boot } from './auditlib.mjs';

const h = await boot({ port: 5331, viewport: { width: 400, height: 300 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], data: {} };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };

  const digest = () => g.entities.map((e) => [
    e.name, e.team, e.alive ? 1 : 0,
    +e.position.x.toFixed(4), +e.position.y.toFixed(4), +e.position.z.toFixed(4),
    +e.yaw.toFixed(4), +e.health.toFixed(2), e.state ?? '-', +(e.stateTimer ?? 0).toFixed(3),
  ].join(':')).join(' | ');

  /** Park every entity on one spot so nothing about the previous match can be read. */
  const normalise = () => {
    const b = g.world.bounds;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    for (const e of g.entities) {
      e.position.set(cx, b.min.y + 1, cz);
      e.velocity.set(0, 0, 0);
      e.yaw = 0; e.pitch = 0;
      e.alive = true;
      e.health = e.maxHealth;
      if (e.forgetTarget) e.forgetTarget();
    }
  };

  // ─────────────────────────────────── H1a. baseline: no normalisation
  const runPlain = (seed) => {
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'veteran', seed });
    const at0 = digest();
    sim(1200);
    const at1200 = digest();
    g.returnToMenu();
    return { at0, at1200 };
  };
  const p1 = runPlain(4242);
  const p2 = runPlain(4242);
  R.data.plain = { step0Same: p1.at0 === p2.at0, step1200Same: p1.at1200 === p2.at1200 };

  // ─────────────────────────────────── H1b. same, but normalised first
  const runNorm = (seed) => {
    normalise();
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'veteran', seed });
    const at0 = digest();
    sim(1200);
    const at1200 = digest();
    g.returnToMenu();
    return { at0, at1200 };
  };
  const n1 = runNorm(4242);
  const n2 = runNorm(4242);
  R.data.normalised = { step0Same: n1.at0 === n2.at0, step1200Same: n1.at1200 === n2.at1200 };
  R.data.normalisedFirstDiff0 = n1.at0 === n2.at0 ? null : { a: n1.at0.slice(0, 200), b: n2.at0.slice(0, 200) };

  ok('determinism:causeIsStaleEntityPositions',
    R.data.plain.step0Same === false && R.data.normalised.step0Same === true,
    `without normalisation two same-seed starts match at step 0: ${R.data.plain.step0Same}; ` +
    `after parking every entity on one spot first: ${R.data.normalised.step0Same}`);
  ok('determinism:sameSeedReproducesMatch', R.data.normalised.step1200Same,
    `with a normalised start, 1200 fixed steps reproduce exactly: ${R.data.normalised.step1200Same}`);

  // ─────────────────────────────────── H2. frame-rate independence, normalised
  {
    const run = (substepsPerFrame) => {
      normalise();
      g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'veteran', seed: 999 });
      const TOTAL = 120 * 20;
      for (let i = 0; i < TOTAL; i++) {
        g._fixedUpdate(1 / 120);
        if ((i + 1) % substepsPerFrame === 0) { g.frame++; g._update(substepsPerFrame / 120); }
      }
      const d = digest();
      g.returnToMenu();
      return d;
    };
    const a = run(1);
    const b = run(6);
    const c = run(1);
    R.data.frameRate = { at120fpsVs20fps: a === b, at120fpsRepeatable: a === c };
    ok('sim:frameRateIndependent', a === b,
      `2400 fixed steps delivered 1-per-frame vs 6-per-frame: identical=${a === b} (control: two 1-per-frame runs identical=${a === c})`);
    if (a !== b) R.data.frameRateDiff = { a: a.slice(0, 260), b: b.slice(0, 260) };
  }

  // ─────────────────────────────────── H3. duplicated input handlers
  {
    g.settings.set('botCount', 6);
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 77 });
    sim(600);
    const p = g.player;
    p.alive = true; p.health = p.maxHealth;

    // Count every route that can spawn a grenade or resolve a melee.
    let projCalls = 0;
    const realThrow = g.projectiles.throwGrenade.bind(g.projectiles);
    g.projectiles.throwGrenade = (...a) => { projCalls++; return realThrow(...a); };
    let wsMelee = 0;
    const realWsMelee = g.weapons.meleeAttack.bind(g.weapons);
    g.weapons.meleeAttack = (...a) => { wsMelee++; return realWsMelee(...a); };
    let playerMelee = 0;
    const realPlayerMelee = g.player._melee.bind(g.player);
    g.player._melee = (...a) => { playerMelee++; return realPlayerMelee(...a); };
    let wsResolve = 0;
    const realResolve = g.weapons._resolveMelee.bind(g.weapons);
    g.weapons._resolveMelee = (...a) => { wsResolve++; return realResolve(...a); };

    const press = (action, steps) => {
      g.input.pressed.add(action);
      g.input.actions.add(action);
      g.frame++;
      for (let i = 0; i < steps; i++) g._fixedUpdate(1 / 120);
      g.input.endFrame();
      g.input.actions.delete(action);
    };

    // --- grenade
    const lo = g.weapons.getLoadout(p);
    p._grenadeReadyAt = -999;
    const g0 = { player: p.grenades, lethal: lo.equipment.lethalCount };
    press('grenade', 1);
    sim(120);
    R.data.grenadePress = {
      projectileSystemCalls: projCalls,
      playerGrenades: `${g0.player} -> ${p.grenades}`,
      loadoutLethal: `${g0.lethal} -> ${lo.equipment.lethalCount}`,
    };
    ok('grenade:oneProjectilePerPress', projCalls === 1,
      `one grenade press called projectiles.throwGrenade ${projCalls}x; player.grenades ${g0.player}->${p.grenades}, loadout.lethalCount ${g0.lethal}->${lo.equipment.lethalCount}`);

    // --- melee
    const foe = g.bots.bots.find((b) => g.match.areEnemies(p, b));
    foe.alive = true; foe.health = 900; foe.maxHealth = 900;
    p.yaw = 0; p.pitch = 0;
    foe.position.set(p.position.x, p.position.y, p.position.z - 1.2);
    g.match.clearProtection(foe);
    p._meleeReadyAt = -999;
    g.weapons._meleeTimer = 0;
    g.weapons._meleeEntity = null;
    let dmgEvents = 0;
    let dmgTotal = 0;
    const off = g.bus.on('damage', (e) => { if (e.target === foe) { dmgEvents++; dmgTotal += e.amount; } });
    const hp0 = foe.health;
    press('melee', 1);
    sim(120);
    off();
    R.data.meleePress = {
      playerMeleeCalls: playerMelee, wsMeleeAttackCalls: wsMelee, wsResolveMeleeCalls: wsResolve,
      damageEvents: dmgEvents, damageTotal: +dmgTotal.toFixed(1), hpLost: +(hp0 - foe.health).toFixed(1),
    };
    ok('melee:oneHandlerPerPress', playerMelee + wsMelee <= 1,
      `one melee press: player._melee ${playerMelee}x, weaponSystem.meleeAttack ${wsMelee}x (-> _resolveMelee ${wsResolve}x); ` +
      `${dmgEvents} damage events totalling ${R.data.meleePress.damageTotal} for ${R.data.meleePress.hpLost} HP`);

    g.projectiles.throwGrenade = realThrow;
    g.weapons.meleeAttack = realWsMelee;
    g.player._melee = realPlayerMelee;
    g.weapons._resolveMelee = realResolve;
  }

  // ─────────────────── H4. melee vs the damage gate, isolated and repeatable
  {
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 88 });
    sim(30);                       // countdown: match.canFire() === false for everyone
    const p = g.player;
    p.alive = true; p.health = p.maxHealth;
    const foe = g.bots.bots.find((b) => g.match.areEnemies(p, b));
    foe.alive = true; foe.health = 900; foe.maxHealth = 900;
    p.yaw = 0; p.pitch = 0;
    foe.position.set(p.position.x, p.position.y, p.position.z - 1.2);
    p._meleeReadyAt = -999;

    const ball = await import('/src/weapons/ballistics.js');
    const scaleFrozen = ball.damageScale(g, p, foe);
    const hp0 = foe.health;
    g.player._melee();
    const meleeFrozen = +(hp0 - foe.health).toFixed(1);

    sim(600);                      // live
    g.bus.emit('spawn', { entity: foe });
    const protectedNow = g.match.isProtected(foe);
    const scaleProtected = ball.damageScale(g, p, foe);
    foe.health = 900;
    p._meleeReadyAt = -999;
    foe.position.set(p.position.x, p.position.y, p.position.z - 1.2);
    g.player._melee();
    const meleeProtected = +(900 - foe.health).toFixed(1);

    R.data.meleeGate = {
      phaseWasCountdown: true, damageScaleDuringCountdown: scaleFrozen, meleeDamageDuringCountdown: meleeFrozen,
      isProtected: protectedNow, damageScaleWhenProtected: scaleProtected, meleeDamageWhenProtected: meleeProtected,
    };
    ok('melee:usesTheSharedDamageGate', meleeFrozen === 0 && meleeProtected === 0,
      `damageScale() says ${scaleFrozen} during the countdown and ${scaleProtected} against a spawn-protected enemy, ` +
      `but player._melee() dealt ${meleeFrozen} and ${meleeProtected} damage respectively`);
  }

  return R;
});

console.log('\n=========== AUDIT H — ROOT CAUSES ===========');
let fails = 0;
for (const c of out.checks) { if (!c.pass) fails++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`); }
console.log(`\n  ${out.checks.length - fails}/${out.checks.length} passed`);
console.log('\ndata:', JSON.stringify(out.data, null, 1));
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 12));
if (h.consoleErrors.length) console.log('\nconsole errors:', [...new Set(h.consoleErrors)].slice(0, 12));

await h.close();
