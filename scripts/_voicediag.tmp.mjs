import { boot } from './auditlib.mjs';
const LABEL = process.argv[2] || 'run';
const { page, close, errors } = await boot({ port: 5249 });
const out = await page.evaluate(() => {
  const g = window.__GAME__;
  const R = {};
  const plays = [];
  const origPlay = g.audio.play.bind(g.audio);
  g.audio.play = (name, o) => { plays.push(name); return origPlay(name, o); };
  let busExplosions = 0;
  g.bus.on('explosion', () => { busExplosions++; });

  g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 4 });
  g.match.timeLimit = 1e9;
  for (let i = 0; i < 120 * 4; i++) { g.frame++; g._fixedUpdate(1/120); }
  const ks = g.match.killstreaks;
  R.hasBallistics = !!ks._ballistics && typeof ks._ballistics.applyExplosionDamage === 'function';

  // --- one airstrike-style detonation
  plays.length = 0; busExplosions = 0;
  ks._detonate(g.player.position.clone().add({x:0,y:0,z:-12}), 8, 165, g.player, 'airstrike');
  R.detonate = { explosionPlays: plays.filter(n => n === 'explosion').length, busExplosions, allPlays: plays.slice() };

  // --- a full 9-bomb airstrike run through the real path
  plays.length = 0; busExplosions = 0;
  ks.inventory.set(g.player.id, ['airstrike']);
  ks.activate(g.player, 'airstrike');
  ks.activate(g.player);
  for (let i = 0; i < 120 * 6; i++) { g.frame++; g._fixedUpdate(1/120); }
  R.airstrikeRun = { explosionPlays: plays.filter(n => n === 'explosion').length, busExplosions };

  // --- sentry destruction
  plays.length = 0; busExplosions = 0;
  ks.inventory.set(g.player.id, ['sentry']);
  const deployed = ks.activate(g.player, 'sentry');
  const s = ks._sentries.find(x => x.active);
  R.sentryDeployed = !!deployed && !!s;
  if (s) ks._damageSentry(s, 99999, g.player);
  R.sentryDestroyed = { active: s ? s.active : null, explosionPlays: plays.filter(n => n === 'explosion').length, busExplosions, allPlays: plays.slice() };

  // --- sentry expiry (life <= 0 -> _despawnSentry(s, true))
  plays.length = 0; busExplosions = 0;
  ks.inventory.set(g.player.id, ['sentry']);
  ks.activate(g.player, 'sentry');
  const s2 = ks._sentries.find(x => x.active);
  if (s2) { s2.life = 0.001; g.frame++; g._fixedUpdate(1/120); }
  R.sentryExpiry = { active: s2 ? s2.active : null, explosionPlays: plays.filter(n => n === 'explosion').length, busExplosions };

  g.returnToMenu();
  return R;
});
console.log(LABEL, JSON.stringify(out, null, 1));
if (errors.length) console.log('errors', errors.slice(0,3));
await close();
