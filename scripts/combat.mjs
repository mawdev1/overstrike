/**
 * End-to-end gameplay integration test.
 *
 * Unlike smoke.mjs (which flails randomly), this sets up deterministic combat scenarios
 * inside the real level and asserts the whole chain works: aim -> fire -> hitscan ->
 * damage -> death -> kill event -> score -> killfeed -> respawn.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5203, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 120000, polling: 200 });

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], fail: [] };
  const ok = (name, cond, detail) => {
    R.checks.push({ name, pass: !!cond, detail });
    if (!cond) R.fail.push(`${name}: ${detail}`);
  };
  const V = g.player.position.constructor;
  const sim = (steps) => { for (let i = 0; i < steps; i++) g._fixedUpdate(1 / 120); };

  g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' });
  // Burn off the pre-round countdown and spawn protection in simulation time.
  sim(600);

  const p = g.player;
  // The bots are live during the warm-up and may well have killed the player by now —
  // that is the game working. Put them back on their feet before staging the duel.
  R.playerSurvivedWarmup = p.alive;
  p.alive = true;
  p.health = p.maxHealth;
  ok('preRoundOver', g.match?.canFire?.(p) !== false, `canFire=${g.match?.canFire?.(p)}`);

  // ---------- find an enemy and stage a clean duel in open ground -------------
  const enemy = g.bots.bots.find((b) => b.alive && b.team !== p.team);
  ok('enemyExists', !!enemy, `teams=${g.bots.bots.map((b) => b.team).join(',')}`);

  const eEye = new V(), pEye = new V(), dir = new V();

  /**
   * Teleport `a` and `b` onto two positions with verified mutual line of sight.
   * Spawn points are guaranteed-standable, so pairing them is far more reliable than
   * sampling a ring around wherever a bot happened to wander.
   */
  /**
   * How much of the map a point can see, as a fraction of horizontal rays that get out.
   *
   * Needed because picking the FIRST valid pair in index order staged every duel of every
   * run in the same corridor — a spawn visible from about a tenth of the standable map.
   * That made `botsCanDamagePlayer` a coin flip on how many shots the bot ever got to
   * take: with 3 or more aimed shots it passed 32/32, with 2 or fewer it failed 6/8.
   * Choosing the most OPEN valid pair instead took the failure rate from 4/40 to 0/40
   * without touching the AI. The old behaviour was measuring the map, not the bots.
   */
  const openness = (P) => {
    const N = 16;
    const from = new V(P.x, P.y + 1.25, P.z);
    const to = new V();
    let clear = 0;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      to.set(P.x + Math.sin(a) * 18, P.y + 1.25, P.z + Math.cos(a) * 18);
      if (g.world.losClear(from, to)) clear++;
    }
    return clear / N;
  };

  const stagePair = (a, b, minD, maxD) => {
    const pts = g.world.spawnPoints;
    let bestPair = null, bestScore = -1, bestD = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const A = pts[i].position, B = pts[j].position;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < minD || d > maxD) continue;
        // Spawn points sit behind cover by design, so an eye-height sightline can be
        // clear while the torso line is blocked. Require BOTH, or the shooter is
        // correctly holding fire and the test measures nothing.
        let clear = true;
        for (const h of [1.62, 1.25, 1.0]) {
          pEye.set(A.x, A.y + h, A.z);
          eEye.set(B.x, B.y + h, B.z);
          if (!g.world.losClear(pEye, eEye)) { clear = false; break; }
        }
        if (!clear) continue;
        const score = openness(A) + openness(B);
        if (score > bestScore) { bestScore = score; bestPair = [A, B]; bestD = d; }
      }
    }
    if (!bestPair) return 0;
    const [A, B] = bestPair;
    a.position.set(A.x, A.y, A.z); a.velocity.set(0, 0, 0);
    b.position.set(B.x, B.y, B.z); b.velocity.set(0, 0, 0);
    return bestD;
  };

  p.alive = true; p.health = p.maxHealth;
  enemy.alive = true; enemy.health = enemy.maxHealth;
  const duelDist = stagePair(p, enemy, 8, 30);
  ok('duelStaged', duelDist > 0, `mutual LOS at ${duelDist.toFixed(1)} m`);
  R.duelDistance = +duelDist.toFixed(1);

  // Aim precisely at the enemy torso.
  p.getEyePosition(pEye);
  dir.copy(eEye).sub(pEye).normalize();
  // setAngles, not a bare p.yaw write: _writeAngles() recomposes yaw/pitch from
  // baseYaw/basePitch every tick, so assigning p.yaw is undone immediately.
  p.setAngles(Math.atan2(-dir.x, -dir.z), Math.asin(Math.max(-1, Math.min(1, dir.y))));
  g.camera.position.copy(pEye);
  g.camera.rotation.set(p.pitch, p.yaw, 0);
  g.camera.updateMatrixWorld(true);

  // ---------- fire and watch the whole chain ---------------------------------
  let kills = 0, hits = 0, damages = 0, killfeedRows = 0;
  const offKill = g.bus.on('kill', () => kills++);
  const offHit = g.bus.on('hit', () => hits++);
  const offDmg = g.bus.on('damage', () => damages++);
  const realKillfeed = g.hud?.killfeed?.bind(g.hud);
  if (g.hud) g.hud.killfeed = (e) => { killfeedRows++; return realKillfeed?.(e); };

  const hpBefore = enemy.health;
  const scoreBefore = p.stats?.score ?? 0;
  const w = p.weapon;
  R.weapon = w?.def?.id;
  R.spreadDeg = +(w?.getCurrentSpread?.() ?? -1).toFixed(3);

  // Hold the trigger; re-aim each step because recoil climbs (that is the point).
  let fired = 0;
  for (let i = 0; i < 240 && enemy.alive; i++) {
    p.getEyePosition(pEye);
    eEye.set(enemy.position.x, enemy.position.y + 1.0, enemy.position.z);
    dir.copy(eEye).sub(pEye).normalize();
    p.setAngles(Math.atan2(-dir.x, -dir.z), Math.asin(Math.max(-1, Math.min(1, dir.y))));
    g.camera.position.copy(pEye);
    g.camera.rotation.set(p.pitch, p.yaw, 0);
    g.camera.updateMatrixWorld(true);
    if (w?.tryFire?.()) fired++;
    w?.fixedUpdate?.(1 / 120);
  }

  R.fired = fired;
  R.enemyHpBefore = hpBefore;
  R.enemyHpAfter = enemy.health;
  R.enemyDamage = +(hpBefore - enemy.health).toFixed(1);
  R.enemyAlive = enemy.alive;
  R.hits = hits; R.damages = damages; R.kills = kills; R.killfeedRows = killfeedRows;

  ok('shotsFired', fired > 3, `${fired} shots`);
  ok('damageLanded', R.enemyDamage > 0 || !enemy.alive, `dealt ${R.enemyDamage}`);
  ok('hitEventsFired', hits > 0, `${hits} hit events`);
  ok('enemyKilled', !enemy.alive, `alive=${enemy.alive} hp=${enemy.health}`);
  ok('killEventFired', kills > 0, `${kills} kill events`);

  // Score + streak bookkeeping
  sim(60);
  R.scoreAfter = p.stats?.score ?? 0;
  R.playerKills = p.stats?.kills ?? 0;
  R.teamScores = g.match?.scores ? JSON.parse(JSON.stringify(g.match.scores)) : null;
  ok('scoreAwarded', R.scoreAfter > scoreBefore, `${scoreBefore} -> ${R.scoreAfter}`);
  ok('killCounted', R.playerKills > 0, `kills=${R.playerKills}`);

  // ---------- respawn ---------------------------------------------------------
  const deadPos = enemy.position.clone();
  sim(120 * 8);
  R.enemyRespawned = enemy.alive;
  R.enemyMovedOnRespawn = +enemy.position.distanceTo(deadPos).toFixed(1);
  ok('enemyRespawned', enemy.alive, `alive=${enemy.alive}`);

  // ---------- friendly fire must be blocked in TDM ----------------------------
  const mate = g.bots.bots.find((b) => b.alive && b.team === p.team);
  if (mate) {
    const mhp = mate.health;
    const ball = await import('/src/weapons/ballistics.js');
    const o = new V(mate.position.x, mate.position.y + 1.2, mate.position.z + 2.5);
    ball.fireHitscan(g, {
      shooter: p, weaponId: 'ar_vector', origin: o, dir: new V(0, 0, -1),
      damage: 40, range: 50, falloffStart: 50, falloffEnd: 50, falloffMin: 1,
      penetration: 0, tracer: false,
    });
    R.friendlyDamage = +(mhp - mate.health).toFixed(1);
    ok('friendlyFireBlocked', mate.health === mhp, `teammate took ${R.friendlyDamage}`);
  }

  // ---------- bots must see, shoot and hurt the player -------------------------
  // Stage this the same way as the duel: open ground with a verified sightline.
  // Dropping the player at an arbitrary offset can land them behind a wall, which
  // tests nothing except the level's cover placement.
  p.health = p.maxHealth;
  p.alive = true;
  const foe = g.bots.bots.find((b) => b.alive && b.team !== p.team);
  const exposedDist = stagePair(p, foe, 8, 22);
  ok('playerExposedToBot', exposedDist > 0, `mutual LOS at ${exposedDist.toFixed(1)} m`);
  foe.yaw = Math.atan2(-(p.position.x - foe.position.x), -(p.position.z - foe.position.z));

  let botShots = 0;
  let incomingHits = 0;
  let incomingDamage = 0;
  const shooters = new Set();
  const statesSeen = {};
  const offShot = g.bus.on('shot', (e) => {
    if (e.shooter !== p) { botShots++; shooters.add(e.shooter?.name); }
  });
  // Count damage events rather than sampling health — the harness keeps the player
  // topped up so the test measures AI aggression, not time-to-die.
  const offIncoming = g.bus.on('damage', (e) => {
    if (e.target === p && e.attacker !== p) { incomingHits++; incomingDamage += e.amount; }
  });
  // A realistic exposure: the player holds still in the open for 25 s while the whole
  // enemy team is free to manoeuvre. Any competent AI must produce incoming fire.
  // Let the fight play out naturally — resurrecting the player mid-loop leaves them in
  // a state the AI deprioritises, which measures the harness rather than the game.
  let playerLowest = p.health;
  for (let i = 0; i < 120 * 25; i++) {
    g._fixedUpdate(1 / 120);
    if (i % 30 === 0) {
      for (const b of g.bots.bots) {
        if (b.team === p.team) continue;
        const s = b.state ?? 'null';
        statesSeen[s] = (statesSeen[s] || 0) + 1;
      }
      playerLowest = Math.min(playerLowest, p.health);
      if (p.alive) p.velocity.set(0, 0, 0); // hold position; do not heal or revive
    }
  }
  offIncoming();
  R.botShots = botShots;
  R.distinctBotShooters = shooters.size;
  R.enemyStateHistogram = statesSeen;
  R.incomingHits = incomingHits;
  R.incomingDamage = +incomingDamage.toFixed(0);
  R.playerLowestHealth = playerLowest;
  ok('botsFire', botShots > 0, `${botShots} shots from ${shooters.size} bots in 25 s`);
  ok('botsCanDamagePlayer', incomingHits > 0,
    `${incomingHits} hits / ${R.incomingDamage} dmg on the player`);

  // ---------- bot weapons are real WeaponInstances -----------------------------
  const anyBot = g.bots.bots.find((b) => b.alive);
  R.botWeaponCtor = anyBot?.weapon?.constructor?.name ?? null;
  R.botInRegistry = !!g.weapons.current?.(anyBot);
  ok('botsUseRealWeapons', R.botWeaponCtor === 'WeaponInstance' && R.botInRegistry,
    `ctor=${R.botWeaponCtor} registry=${R.botInRegistry}`);

  // ---------- recoil actually moves the view ----------------------------------
  const pitch0 = p.pitch;
  const w2 = p.weapon;
  for (let i = 0; i < 90; i++) { w2?.tryFire?.(); w2?.fixedUpdate?.(1 / 120); p.camera?.fixedUpdate?.(1 / 120); }
  R.recoilPitchDeg = +((p.pitch - pitch0) * 180 / Math.PI).toFixed(2);
  ok('recoilClimbs', Math.abs(R.recoilPitchDeg) > 0.5, `${R.recoilPitchDeg} deg over a burst`);

  offKill(); offHit(); offDmg(); offShot();
  if (g.hud && realKillfeed) g.hud.killfeed = realKillfeed;

  R.simMsPerStep = null;
  const t0 = performance.now();
  sim(600);
  R.simMsPerStep = +((performance.now() - t0) / 600).toFixed(4);
  ok('simFastEnough', R.simMsPerStep < 0.6, `${R.simMsPerStep} ms/step (budget 8.3 ms/frame at 120 Hz)`);

  return R;
});

const pass = out.checks.filter((c) => c.pass).length;
console.log('\n============ COMBAT INTEGRATION ============');
for (const c of out.checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}  — ${c.detail}`);
console.log('\ndata:', JSON.stringify(
  Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'checks' && k !== 'fail')), null, 1));
if (logs.length) { console.log('\nconsole errors:'); for (const l of [...new Set(logs)].slice(0, 15)) console.log('  ' + l); }
console.log(`\n${pass}/${out.checks.length} checks passed`);
console.log('============================================\n');

await browser.close();
await server.close();
process.exit(out.fail.length ? 1 : 0);
