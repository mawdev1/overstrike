/**
 * AUDIT K — final verification of the defects this audit intends to report, re-run
 * against whatever `src/` looks like right now. Every case carries a CONTROL so a probe
 * that silently fails to stage its scenario cannot be mistaken for a passing game.
 *
 *  K1. player._melee() vs the shared damage gate (pre-round freeze, spawn protection)
 *  K2. one grenade keypress -> how many projectiles
 *  K3. startMatch({ botCount }) honoured?
 *  K4. a throwing system vs the frame loop
 *  K5. entities placed exactly once per match start
 */
import { boot } from './auditlib.mjs';

const h = await boot({ port: 5361, viewport: { width: 480, height: 360 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], data: {} };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };
  const V = g.player.position.constructor;

  /**
   * Put `foe` at melee range in front of the player on a spot with verified line of
   * sight, and confirm a melee actually connects there. Returns the damage the control
   * swing dealt — if that is 0 the staging failed and no conclusion may be drawn.
   */
  const stage = (p, foe) => {
    const eyeA = new V(), eyeB = new V();
    p.alive = true; p.health = p.maxHealth;
    foe.alive = true; foe.maxHealth = 2000; foe.health = 2000; foe.armor = 0;
    p.pitch = 0;
    for (let a = 0; a < 16; a++) {
      const yaw = (a / 16) * Math.PI * 2;
      p.yaw = yaw;
      const dx = -Math.sin(yaw) * 1.2;
      const dz = -Math.cos(yaw) * 1.2;
      foe.position.set(p.position.x + dx, p.position.y, p.position.z + dz);
      foe.velocity.set(0, 0, 0);
      p.getEyePosition(eyeA);
      foe.getEyePosition(eyeB);
      if (!g.world.losClear(eyeA, eyeB)) continue;
      // Control swing, fully legal: live phase, no protection.
      g.match.clearProtection(foe);
      g.match.clearProtection(p);
      p._meleeReadyAt = -999;
      const hp = foe.health;
      p._melee();
      const dealt = hp - foe.health;
      foe.health = 2000;
      if (dealt > 0) return dealt;
    }
    return 0;
  };

  // ══════════════════════════════ K1. melee vs the damage gate
  {
    const ball = await import('/src/weapons/ballistics.js');
    g.settings.set('botCount', 7);
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 4001 });
    sim(600);                                   // live
    const p = g.player;
    const foe = g.bots.bots.find((b) => g.match.areEnemies(p, b));
    const control = stage(p, foe);

    // (a) spawn-protected enemy, match live
    g.bus.emit('spawn', { entity: foe });
    const isProt = g.match.isProtected(foe);
    const scaleProt = ball.damageScale(g, p, foe);
    foe.health = 2000;
    p._meleeReadyAt = -999;
    p._melee();
    const dmgProtected = +(2000 - foe.health).toFixed(1);

    // (b) pre-round countdown, when match.canFire() is false for everyone
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 4002 });
    sim(30);
    const phase = g.match.phase;
    const p2 = g.player;
    const foe2 = g.bots.bots.find((b) => g.match.areEnemies(p2, b));
    const control2 = stage(p2, foe2);           // staging control (also proves reach)
    const scaleFrozen = ball.damageScale(g, p2, foe2);
    foe2.health = 2000;
    p2._meleeReadyAt = -999;
    p2._melee();
    const dmgFrozen = +(2000 - foe2.health).toFixed(1);

    R.data.meleeGate = {
      controlSwingDamage: control, controlSwingDamageDuringCountdown: control2,
      phaseForFrozenTest: phase,
      isProtected: isProt, damageScaleSaysProtected: scaleProt, meleeDealtToProtected: dmgProtected,
      damageScaleSaysFrozen: scaleFrozen, meleeDealtWhileFrozen: dmgFrozen,
    };
    ok('K1:controlStaged', control > 0, `control melee dealt ${control} damage (0 would invalidate this case)`);
    ok('K1:meleeRespectsSpawnProtection', control === 0 || dmgProtected === 0,
      `damageScale()=${scaleProt} for a spawn-protected enemy (isProtected=${isProt}), player._melee() dealt ${dmgProtected}`);
    ok('K1:meleeRespectsPreRoundFreeze', control2 === 0 || dmgFrozen === 0,
      `damageScale()=${scaleFrozen} during phase='${phase}', player._melee() dealt ${dmgFrozen}`);
  }

  // ══════════════════════════════ K2. grenade double-throw
  {
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 4003 });
    sim(600);
    const p = g.player;
    p.alive = true; p.health = p.maxHealth; p._grenadeReadyAt = -999;
    const lo = g.weapons.getLoadout(p);
    let calls = 0;
    const args = [];
    const real = g.projectiles.throwGrenade.bind(g.projectiles);
    g.projectiles.throwGrenade = (...a) => { calls++; args.push(a[4]?.id ?? 'no-def'); return real(...a); };
    const g0 = { grenades: p.grenades, lethal: lo.equipment.lethalCount };
    g.input.pressed.add('grenade'); g.input.actions.add('grenade');
    g.frame++;
    g._fixedUpdate(1 / 120);
    g.input.endFrame(); g.input.actions.delete('grenade');
    sim(60);
    g.projectiles.throwGrenade = real;
    R.data.grenade = {
      throwGrenadeCalls: calls, defsUsed: args,
      playerGrenades: `${g0.grenades} -> ${p.grenades}`,
      loadoutLethal: `${g0.lethal} -> ${lo.equipment.lethalCount}`,
    };
    ok('K2:oneGrenadePerPress', calls === 1,
      `one press -> projectiles.throwGrenade x${calls} (defs: ${args.join(', ')}); player.grenades ${g0.grenades}->${p.grenades}, loadout.lethalCount ${g0.lethal}->${lo.equipment.lethalCount}`);
  }

  // ══════════════════════════════ K3. botCount option
  {
    g.settings.set('botCount', 7);
    g.startMatch({ mode: 'tdm', botCount: 16, difficulty: 'regular', seed: 4004 });
    const r16 = g.bots.bots.length;
    const m16 = g.match.botCount;
    R.data.botCount = { settings: 7, requested: 16, roster: r16, matchBotCount: m16, hasSetCount: typeof g.bots.setCount };
    ok('K3:botCountHonoured', r16 === 16,
      `settings.botCount=7, startMatch({botCount:16}) -> roster ${r16}, match.botCount ${m16}, typeof bots.setCount=${typeof g.bots.setCount}`);
  }

  // ══════════════════════════════ K4. frame-loop error isolation
  {
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 4005 });
    sim(600);
    let renders = 0, ends = 0;
    const realRender = g.engine.render.bind(g.engine);
    const realEnd = g.input.endFrame.bind(g.input);
    g.engine.render = (dt) => { renders++; return realRender(dt); };
    g.input.endFrame = () => { ends++; return realEnd(); };
    const realRaf = window.requestAnimationFrame;
    g.stop(); window.requestAnimationFrame = () => 0; g._running = true;
    const drive = (n) => { let now = performance.now(); g._last = now; for (let i = 0; i < n; i++) { now += 16.7; try { g._loop(now); } catch { /* counted below */ } } };
    drive(5);
    const healthy = { renders, ends };
    const realHud = g.hud.update.bind(g.hud);
    g.hud.update = () => { throw new TypeError('a UI method that does not exist yet'); };
    renders = 0; ends = 0;
    drive(10);
    const broken = { renders, ends };
    g.hud.update = realHud;
    window.requestAnimationFrame = realRaf;
    g.engine.render = realRender; g.input.endFrame = realEnd;
    g.start();

    let matchTicks = 0;
    const realBots = g.bots.fixedUpdate.bind(g.bots);
    const realMatch = g.match.fixedUpdate.bind(g.match);
    g.bots.fixedUpdate = () => { throw new Error('AI threw'); };
    g.match.fixedUpdate = (dt) => { matchTicks++; return realMatch(dt); };
    for (let i = 0; i < 5; i++) { try { g._fixedUpdate(1 / 120); } catch { /* counted */ } }
    g.bots.fixedUpdate = realBots; g.match.fixedUpdate = realMatch;

    R.data.isolation = { healthy, withHudThrowing: broken, matchTicksWithBotsThrowing: matchTicks };
    ok('K4:frameSurvivesAThrowingSystem', broken.renders === 10,
      `10 frames with hud.update() throwing: engine.render ran ${broken.renders}x, input.endFrame ran ${ends}x (healthy control: ${healthy.renders} renders in 5 frames)`);
    ok('K4:simSurvivesAThrowingSystem', matchTicks === 5,
      `5 fixed steps with bots.fixedUpdate() throwing: match.fixedUpdate (clock, respawns, win condition) ran ${matchTicks}/5`);
  }

  // ══════════════════════════════ K5. entities placed exactly once per start
  {
    const sp = g.match.spawner;
    const real = sp.spawnEntity.bind(sp);
    let calls = 0;
    const per = new Map();
    sp.spawnEntity = (e) => { calls++; per.set(e.name, (per.get(e.name) || 0) + 1); return real(e); };
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 4006 });
    const first = { calls, entities: g.entities.length, worst: Math.max(...per.values()) };
    sim(600);
    for (const b of g.bots.bots) b.alive = true;
    calls = 0; per.clear();
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 4007 });
    const second = { calls, entities: g.entities.length, worst: Math.max(...per.values()) };
    sp.spawnEntity = real;
    R.data.spawnCounts = { afterDeaths: first, afterAllAlive: second };
    ok('K5:placedExactlyOnce', first.calls === first.entities && second.calls === second.entities,
      `spawner.spawnEntity called ${first.calls}x for ${first.entities} entities (worst entity placed ${first.worst}x) and ${second.calls}x when every bot was left alive`);
  }

  return R;
});

console.log('\n=========== AUDIT K — FINAL VERIFICATION ===========');
let fails = 0;
for (const c of out.checks) { if (!c.pass) fails++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`); }
console.log(`\n  ${out.checks.length - fails}/${out.checks.length} passed`);
console.log('\ndata:', JSON.stringify(out.data, null, 1));
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 12));
if (h.consoleErrors.length) console.log('\nconsole errors:', [...new Set(h.consoleErrors)].slice(0, 12));

await h.close();
