/** Second diagnostic: ballistics correctness, spawn clearance, recoil units, bot wiring. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5202, strictPort: false }, logLevel: 'error',
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
  const r = {};
  g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' });
  await new Promise((res) => setTimeout(res, 400));

  const THREE_V = g.player.position.constructor;
  const ball = await import('/src/weapons/ballistics.js');
  r.ballisticsExports = Object.keys(ball);

  const p = g.player;
  const bot = g.bots.bots.find((b) => b.alive);

  // ---- A. entity contract shape on the bot
  r.botShape = {
    hasHitboxes: Array.isArray(bot.hitboxes),
    hitboxCount: bot.hitboxes?.length ?? 0,
    hitboxParts: (bot.hitboxes || []).map((h) => h.part),
    hasApplyDamage: typeof bot.applyDamage === 'function',
    alive: bot.alive, team: bot.team, health: bot.health,
    radius: bot.radius, height: bot.height, eyeHeight: bot.eyeHeight,
  };
  r.playerTeam = p.team;
  r.botTeams = g.bots.bots.map((b) => b.team);

  // ---- B. raycastEntity directly against a bot from 3 m away, aimed at its chest
  const origin = new THREE_V(bot.position.x, bot.position.y + 1.2, bot.position.z + 3);
  const dir = new THREE_V(0, 0, -1);
  const hb = ball.raycastEntity?.(bot, origin, dir, 50);
  r.raycastEntity = hb ? { part: hb.part, distance: +hb.distance.toFixed(3) } : null;

  const hb2 = ball.raycastEntities?.(g, origin, dir, 50, p);
  r.raycastEntities = hb2 ? { part: hb2.part, distance: +hb2.distance.toFixed(3), isBot: hb2.entity === bot } : null;

  // ---- C. world in the way?
  const wr = g.world.raycast(origin, dir, 50);
  r.worldRayFromTestOrigin = wr ? { dist: +wr.distance.toFixed(2), surface: wr.surface } : null;

  // ---- D. fireHitscan directly
  const hpBefore = bot.health;
  const def = g.player.weapon?.def;
  const res = ball.fireHitscan?.(g, {
    shooter: p, weaponId: def?.id ?? 'ar_vector', origin, dir,
    damage: def?.damage ?? 30, range: 120,
    falloffStart: def?.falloffStart ?? 28, falloffEnd: def?.falloffEnd ?? 70,
    falloffMin: def?.falloffMin ?? 0.55, penetration: def?.penetration ?? 0.3, tracer: true,
  });
  r.fireHitscanResult = res ? {
    hitEntity: !!res.hitEntity, isBot: res.hitEntity === bot,
    distance: res.distance != null ? +res.distance.toFixed(2) : null, headshot: !!res.headshot,
  } : null;
  r.botHpAfterDirectFire = bot.health;
  r.directFireDamage = hpBefore - bot.health;

  // ---- E. spawn protection interference
  r.matchIsProtected = g.match?.isProtected?.(bot) ?? 'no such method';
  r.matchDamageMul = g.match?.damageMultiplierFor?.(bot) ?? 'no such method';
  r.matchCanFire = g.match?.canFire?.(p) ?? 'no such method';
  r.preRound = g.match?.preRound ?? g.match?.countdown ?? null;

  // ---- F. full weapon path: aim the real camera at the bot and fire
  await new Promise((res) => setTimeout(res, 2000)); // let spawn protection & countdown lapse
  const bot2 = g.bots.bots.find((b) => b.alive);
  p.position.set(bot2.position.x, bot2.position.y, bot2.position.z + 4);
  p.yaw = Math.atan2(-(bot2.position.x - p.position.x), -(bot2.position.z - p.position.z));
  p.pitch = 0;
  p.camera?.update?.(1 / 60);
  g.camera.position.set(p.position.x, p.position.y + p.eyeHeight, p.position.z);
  g.camera.rotation.set(0, p.yaw, 0);
  g.camera.updateMatrixWorld(true);
  const hp2 = bot2.health;
  let fired = 0;
  for (let i = 0; i < 90; i++) {
    if (g.player.weapon?.tryFire?.()) fired++;
    g.player.weapon?.fixedUpdate?.(1 / 120);
  }
  r.fullPath = { fired, hpBefore: hp2, hpAfter: bot2.health, damage: hp2 - bot2.health };

  // ---- G. what is the fire origin/direction the weapon system actually uses?
  const o = new THREE_V(), d = new THREE_V();
  g.weapons.getFireOrigin?.(p, o);
  g.weapons.getFireDirection?.(p, d);
  r.fireOrigin = { x: +o.x.toFixed(2), y: +o.y.toFixed(2), z: +o.z.toFixed(2) };
  r.fireDir = { x: +d.x.toFixed(3), y: +d.y.toFixed(3), z: +d.z.toFixed(3) };
  r.botPos = { x: +bot2.position.x.toFixed(2), y: +bot2.position.y.toFixed(2), z: +bot2.position.z.toFixed(2) };
  r.playerPos = { x: +p.position.x.toFixed(2), y: +p.position.y.toFixed(2), z: +p.position.z.toFixed(2) };

  // ---- H. recoil units check
  r.addRecoilArity = g.player.camera?.addRecoil?.length ?? null;
  const yaw0 = p.yaw, pitch0 = p.pitch;
  g.player.camera?.addRecoil?.(0.55, 0.22, 0.06);
  for (let i = 0; i < 4; i++) { g.player.camera?.fixedUpdate?.(1 / 120); }
  r.recoilPitchDeltaDeg = +((p.pitch - pitch0) * 180 / Math.PI).toFixed(3);
  r.recoilYawDeltaDeg = +((p.yaw - yaw0) * 180 / Math.PI).toFixed(3);

  // ---- I. bot weapon wiring: real instance or shim?
  r.botWeapon = {
    hasWeapon: !!bot2.weapon,
    defId: bot2.weapon?.def?.id ?? null,
    ctor: bot2.weapon?.constructor?.name ?? null,
    inSystemRegistry: !!g.weapons.current?.(bot2),
    systemCtor: g.weapons.current?.(bot2)?.constructor?.name ?? null,
  };
  r.weaponSystemApi = Object.getOwnPropertyNames(Object.getPrototypeOf(g.weapons)).filter((k) => k !== 'constructor');
  r.weaponsAutoInput = g.weapons.autoInput;

  // ---- J. spawn clearance for every spawn point
  r.spawnClearance = g.world.spawnPoints.map((sp, i) => {
    const eye = new THREE_V(sp.position.x, sp.position.y + 1.62, sp.position.z);
    const fwd = new THREE_V(-Math.sin(sp.yaw), 0, -Math.cos(sp.yaw));
    const hit = g.world.raycast(eye, fwd, 60);
    return { i, team: sp.team, fwdClear: hit ? +hit.distance.toFixed(1) : 60 };
  });
  return r;
});

console.log(JSON.stringify(out, null, 2));
if (logs.length) { console.log('\n--- console errors ---'); for (const l of [...new Set(logs)].slice(0, 20)) console.log('  ' + l); }
await browser.close();
await server.close();
