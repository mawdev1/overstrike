/**
 * AUDIT C — numerical robustness and edge cases.
 *
 * NaN/Infinity injection, map bounds, falling out of the world, simultaneous deaths,
 * 0 and 24 bots, the last bot dying, empty reserve, reload cancelled on the chambering
 * frame, an explosion from a dead attacker, and a bot whose target vanishes mid-path.
 *
 * Each case restores the match afterwards so a failure does not poison the next case.
 */
import { boot } from './auditlib.mjs';

const h = await boot({ port: 5303, viewport: { width: 640, height: 480 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], data: {}, thrown: [] };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };
  const guard = (name, fn) => {
    try { return fn(); } catch (e) { R.thrown.push(`${name}: ${e.message}`); ok(`${name}:noThrow`, false, e.message); return null; }
  };
  const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
  const allEntitiesFinite = () => g.entities.every((e) => finite(e.position) && finite(e.velocity)
    && Number.isFinite(e.yaw) && Number.isFinite(e.pitch) && Number.isFinite(e.health));

  const fresh = (opts = {}) => {
    g.startMatch(Object.assign({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 1234 }, opts));
    sim(600);
  };

  // ─────────────────────────────────────────────────── 1. NaN in player position
  fresh();
  guard('nanPlayerPos', () => {
    const p = g.player;
    p.position.x = NaN;
    sim(240);
    R.data.nanPlayerPos = {
      pos: [p.position.x, p.position.y, p.position.z],
      vel: [p.velocity.x, p.velocity.y, p.velocity.z],
      alive: p.alive, health: p.health,
      othersFinite: g.bots.bots.every((b) => finite(b.position)),
    };
    ok('nanPlayerPos:selfRecovers', finite(p.position), `pos=${R.data.nanPlayerPos.pos}`);
    ok('nanPlayerPos:doesNotSpread', R.data.nanPlayerPos.othersFinite, 'bots stayed finite');
  });

  // ───────────────────────────────────────────── 2. Infinity in player velocity
  fresh();
  guard('infVelocity', () => {
    const p = g.player;
    p.velocity.set(0, Infinity, 0);
    sim(240);
    R.data.infVelocity = { pos: [p.position.x, p.position.y, p.position.z], vel: [p.velocity.x, p.velocity.y, p.velocity.z] };
    ok('infVelocity:contained', finite(p.position) && finite(p.velocity), JSON.stringify(R.data.infVelocity));
  });

  // ───────────────────────────────────────────────────── 3. NaN in a bot's state
  fresh();
  guard('nanBot', () => {
    const b = g.bots.bots[0];
    b.position.set(NaN, NaN, NaN);
    b.yaw = NaN;
    sim(600);
    R.data.nanBot = {
      selfFinite: finite(b.position), yawFinite: Number.isFinite(b.yaw),
      othersFinite: g.entities.filter((e) => e !== b).every((e) => finite(e.position)),
      playerFinite: finite(g.player.position),
    };
    ok('nanBot:doesNotSpread', R.data.nanBot.othersFinite && R.data.nanBot.playerFinite,
      JSON.stringify(R.data.nanBot));
    ok('nanBot:selfRecovers', R.data.nanBot.selfFinite && R.data.nanBot.yawFinite,
      `pos finite=${R.data.nanBot.selfFinite} yaw finite=${R.data.nanBot.yawFinite}`);
  });

  // ───────────────────────────────────────────────────── 4. exactly on the bounds
  fresh();
  guard('atBounds', () => {
    const p = g.player;
    const bmin = g.world.bounds.min, bmax = g.world.bounds.max;
    const probe = [];
    for (const [label, v] of [['min', bmin], ['max', bmax]]) {
      p.alive = true; p.health = p.maxHealth;
      p.position.set(v.x, v.y + 1, v.z);
      p.velocity.set(0, 0, 0);
      sim(240);
      probe.push({ label, pos: [+p.position.x.toFixed(2), +p.position.y.toFixed(2), +p.position.z.toFixed(2)], finite: finite(p.position), alive: p.alive });
    }
    R.data.atBounds = probe;
    ok('atBounds:stable', probe.every((x) => x.finite), JSON.stringify(probe));
  });

  // ───────────────────────────────────────────── 5. falling out of the world
  fresh();
  guard('fallOut', () => {
    const p = g.player;
    p.alive = true; p.health = p.maxHealth;
    p.position.set(0, g.world.bounds.min.y - 60, 0);
    p.velocity.set(0, -40, 0);
    const before = { alive: p.alive, y: p.position.y };
    sim(120 * 20);
    R.data.fallOut = {
      before, afterY: +p.position.y.toFixed(1), alive: p.alive, health: p.health,
      deaths: g.player.stats.deaths,
      recovered: p.position.y > g.world.bounds.min.y - 5,
    };
    ok('fallOut:handled', p.alive === false || R.data.fallOut.recovered,
      `y=${R.data.fallOut.afterY} alive=${p.alive} (a killplane or a respawn must catch this)`);
  });

  // ──────────────────────────────────────────────────── 6. simultaneous deaths
  fresh();
  const ball = await import('/src/weapons/ballistics.js');
  guard('simultaneousDeaths', () => {
    const foes = g.bots.bots.filter((b) => b.alive && b.team !== g.player.team).slice(0, 3);
    // Stack them on one spot and drop a big blast on it.
    const at = foes[0].position.clone();
    for (const f of foes) { f.position.copy(at); f.health = 20; f.alive = true; }
    let killEvents = 0;
    const victims = new Map();
    const off = g.bus.on('kill', (p) => { killEvents++; victims.set(p.victim, (victims.get(p.victim) || 0) + 1); });
    const deathsBefore = foes.map((f) => g.match.statsFor(f).deaths);
    ball.applyExplosionDamage(g, { point: at, radius: 8, damage: 400, attacker: g.player, weaponId: 'frag' });
    sim(2);
    off();
    const deathsAfter = foes.map((f) => g.match.statsFor(f).deaths);
    R.data.simultaneousDeaths = {
      killEvents,
      perVictim: [...victims.values()],
      deathDelta: deathsAfter.map((d, i) => d - deathsBefore[i]),
      playerKills: g.match.statsFor(g.player).kills,
      allDead: foes.every((f) => !f.alive),
    };
    ok('simultaneousDeaths:bookedOnce',
      R.data.simultaneousDeaths.deathDelta.every((d) => d === 1),
      `death deltas=${R.data.simultaneousDeaths.deathDelta}, kill events=${killEvents}`);
  });

  // ───────────────────────────────────────────── 7. explosion by a dead attacker
  guard('deadAttackerExplosion', () => {
    const attacker = g.bots.bots.find((b) => b.team !== g.player.team) || g.bots.bots[0];
    attacker.alive = false;
    const victim = g.bots.bots.find((b) => b.alive && b !== attacker);
    if (!victim) { ok('deadAttackerExplosion:noThrow', true, 'no live victim to test'); return; }
    victim.health = victim.maxHealth;
    const hpBefore = victim.health;
    const n = ball.applyExplosionDamage(g, {
      point: victim.position.clone(), radius: 6, damage: 150, attacker, weaponId: 'frag',
    });
    sim(2);
    R.data.deadAttackerExplosion = { damaged: n, hpBefore, hpAfter: victim.health, attackerAlive: attacker.alive };
    ok('deadAttackerExplosion:noThrow', true, `damaged ${n} entities, victim ${hpBefore}->${victim.health}`);
  });

  // ───────────────────────────────────────────────────────── 8. zero bots
  guard('zeroBots', () => {
    g.settings.set('botCount', 0);
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 7 });
    sim(600 + 120 * 20);
    R.data.zeroBots = {
      roster: g.bots.bots.length,
      state: g.state, phase: g.match.phase,
      playerAlive: g.player.alive,
      scores: [g.match.scores[0], g.match.scores[1]],
    };
    ok('zeroBots:survives', g.state === 'playing' && g.bots.bots.length === 0,
      JSON.stringify(R.data.zeroBots));
  });

  // ───────────────────────────────────────────────────────── 9. 24 bots
  guard('maxBots', () => {
    g.settings.set('botCount', 24);
    g.startMatch({ mode: 'tdm', botCount: 24, difficulty: 'veteran', seed: 8 });
    sim(600);
    const t0 = performance.now();
    sim(1200);
    const msPerStep = (performance.now() - t0) / 1200;
    R.data.maxBots = {
      roster: g.bots.bots.length,
      alive: g.bots.bots.filter((b) => b.alive).length,
      msPerStep: +msPerStep.toFixed(4),
      budgetMsPerFrameAt120: +(msPerStep).toFixed(4),
    };
    ok('maxBots:roster', g.bots.bots.length === 24, `roster=${g.bots.bots.length}`);
    ok('maxBots:withinBudget', msPerStep < 1.5, `${msPerStep.toFixed(3)} ms per fixed step with 24 bots`);
  });

  // ───────────────────────────────────────────── 10. the last enemy bot dying
  guard('lastBotDies', () => {
    g.settings.set('botCount', 2);
    g.startMatch({ mode: 'ffa', botCount: 2, difficulty: 'regular', seed: 9 });
    sim(600);
    for (const b of g.bots.bots) if (b.alive) b.die({ attacker: g.player, weaponId: 'ar_vector' });
    sim(2);
    const allDeadState = { state: g.state, phase: g.match.phase, alive: g.bots.bots.filter((b) => b.alive).length };
    sim(120 * 12);
    R.data.lastBotDies = {
      afterKill: allDeadState,
      afterWait: { state: g.state, phase: g.match.phase, alive: g.bots.bots.filter((b) => b.alive).length },
    };
    ok('lastBotDies:respawnOrEnd',
      g.match.phase === 'ended' || g.bots.bots.some((b) => b.alive),
      JSON.stringify(R.data.lastBotDies));
  });

  // ───────────────────────────────────────── 11. empty reserve + dry reload
  g.settings.set('botCount', 6);
  fresh();
  guard('emptyReserve', () => {
    const w = g.player.weapon;
    w.ammo = 0; w.reserve = 0;
    const before = { ammo: w.ammo, reserve: w.reserve, state: w.state };
    w.reload();
    for (let i = 0; i < 600; i++) { w.fixedUpdate(1 / 120); }
    const fired = w.tryFire();
    R.data.emptyReserve = { before, after: { ammo: w.ammo, reserve: w.reserve, state: w.state }, firedOnEmpty: !!fired };
    ok('emptyReserve:noNegative', w.ammo >= 0 && w.reserve >= 0, `ammo=${w.ammo} reserve=${w.reserve}`);
    ok('emptyReserve:noStuckState', w.state !== 'reloading', `state=${w.state}`);
    ok('emptyReserve:cannotFire', !fired, `tryFire returned ${fired}`);
  });

  // ─────────────────────────── 12. reload cancelled on the chambering frame
  fresh();
  guard('reloadCancel', () => {
    const ws = g.weapons;
    const lo = ws.getLoadout(g.player);
    const w = ws.current(g.player);
    const rows = [];
    // Sweep the cancel point across the last 12 steps of the reload so we land
    // exactly on whichever step commits the magazine.
    for (let offset = 0; offset <= 12; offset++) {
      w.ammo = 3;
      w.reserve = 90;
      w.state = 'idle';
      w.stateTimer = 0;
      const total0 = w.ammo + w.reserve;
      w.reload();
      const dur = w.stateDuration || w.def.reloadTime;
      const steps = Math.max(1, Math.round(dur * 120) - offset);
      for (let i = 0; i < steps; i++) w.fixedUpdate(1 / 120);
      const midState = w.state;
      // Cancel by switching weapons (the real cancel path).
      if (lo && lo.weapons.length > 1) ws.switchTo(g.player, (lo.index + 1) % lo.weapons.length, true);
      for (let i = 0; i < 30; i++) w.fixedUpdate(1 / 120);
      const total1 = w.ammo + w.reserve;
      rows.push({ offset, midState, ammo: w.ammo, reserve: w.reserve, total0, total1, delta: total1 - total0 });
      if (lo && lo.weapons.length > 1) ws.switchTo(g.player, 0, true);
    }
    R.data.reloadCancel = rows;
    const bad = rows.filter((r) => r.delta !== 0);
    ok('reloadCancel:ammoConserved', bad.length === 0,
      bad.length ? `ammo created/destroyed at offsets ${bad.map((b) => `${b.offset}(${b.delta > 0 ? '+' : ''}${b.delta})`).join(', ')}` : 'ammo+reserve conserved at every cancel point');
  });

  // ─────────────────────────── 13. a bot whose target vanishes mid-path
  fresh();
  guard('targetVanishes', () => {
    sim(120 * 10);
    const b = g.bots.bots.find((x) => x.alive && x.target);
    if (!b) { R.data.targetVanishes = 'no bot had a target'; ok('targetVanishes:noThrow', true, 'no bot had acquired a target'); return; }
    const victim = b.target;
    // Simulate a disconnect: remove the entity from the roster entirely while a bot
    // is actively pathing to it.
    const idx = g.bots.bots.indexOf(victim);
    if (idx >= 0) g.bots.bots.splice(idx, 1);
    victim.alive = false;
    sim(120 * 10);
    R.data.targetVanishes = {
      removed: idx >= 0, botState: b.state, stillTargets: b.target === victim,
      rosterNow: g.bots.bots.length, botFinite: finite(b.position),
    };
    ok('targetVanishes:recovers', !R.data.targetVanishes.stillTargets && finite(b.position),
      JSON.stringify(R.data.targetVanishes));
    if (idx >= 0) g.bots.bots.splice(idx, 0, victim);
  });

  // ───────────────────── 14. everything finite after a long chaotic match
  g.settings.set('botCount', 10);
  fresh({ botCount: 10, difficulty: 'veteran' });
  guard('longRunFinite', () => {
    for (let i = 0; i < 120 * 90; i++) {
      g._fixedUpdate(1 / 120);
      if (g.player.alive && i % 3 === 0) g.player.weapon?.tryFire?.();
    }
    R.data.longRunFinite = {
      allFinite: allEntitiesFinite(),
      offenders: g.entities.filter((e) => !finite(e.position) || !Number.isFinite(e.yaw)).map((e) => e.name),
    };
    ok('longRunFinite', R.data.longRunFinite.allFinite, JSON.stringify(R.data.longRunFinite.offenders));
  });

  return R;
});

console.log('\n=========== AUDIT C — ROBUSTNESS ===========');
let fails = 0;
for (const c of out.checks) { if (!c.pass) fails++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`); }
console.log(`\n  ${out.checks.length - fails}/${out.checks.length} passed`);
console.log('\ndata:', JSON.stringify(out.data, null, 1));
if (out.thrown.length) console.log('\nexceptions:', out.thrown);
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 12));
if (h.consoleErrors.length) console.log('\nconsole errors:', [...new Set(h.consoleErrors)].slice(0, 12));

await h.close();
