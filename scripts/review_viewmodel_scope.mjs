/**
 * THROWAWAY REVIEW PROBE — viewmodel scope-takeover ordering.
 *
 * `Viewmodel.update()` runs inside `game._update()`, which game.js:358 calls BEFORE
 * `engine.update()` (game.js:364) — and `engine.update()` is where `ScopeFX.update()`
 * recomputes `scope.amount` (engine.js:1188), immediately before `engine.render()`.
 *
 * So the viewmodel decides whether to hide the gun from LAST frame's `scope.amount`,
 * while `ViewLayerPass` (engine.js:491) decides whether to draw the view scene at all
 * from THIS frame's value. This probe wraps `ViewLayerPass.render` and records, at the
 * exact moment the pass makes its decision, whether the view scene is about to be drawn
 * with the weapon group invisible.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5193, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 120000, polling: 200 });

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  g.startMatch({ mode: 'tdm', botCount: 2, difficulty: 'recruit' });

  const wait = (n) => new Promise((res) => {
    let k = 0;
    const tick = () => (++k >= n ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

  await wait(40);
  const p = g.player;
  p.alive = true; p.health = p.maxHealth;

  const ws = g.weapons;
  const vm = ws.viewmodel;
  // Equip the scoped bolt gun.
  const defs = await import('/src/weapons/weaponDefs.js');
  const scopedDef = defs.WEAPON_LIST.find((d) => d.scoped);
  const inst = ws.entries?.get?.(p) || null;
  // Force the loadout through the public path if there is one, else patch the instance.
  let equipped = null;
  const slots = ws.loadoutFor?.(p) || null;
  try { ws.setWeaponById?.(p, scopedDef.id); } catch { /* ignore */ }
  if (p.weapon?.def?.id !== scopedDef.id) {
    // Fall back: rebuild the player's current instance onto the scoped def.
    p.weapon.def = scopedDef;
    p.weapon.ammo = scopedDef.magSize;
    vm.setWeapon(scopedDef);
  }
  equipped = p.weapon?.def?.id;

  // ---- instrument the pass that decides whether the view scene is drawn ----
  const pass = g.engine.viewPass;
  const samples = [];
  const orig = pass.render.bind(pass);
  let recording = false;
  pass.render = function (...a) {
    if (recording) {
      const amt = g.engine.scope?.amount ?? 0;
      samples.push({
        f: g.frame,
        amount: +amt.toFixed(4),
        drawn: !(amt > 0.5),                       // engine.js:491 bail condition
        gunVisible: !!vm.current?.group?.visible,
        scopeHidden: !!vm._scopeHidden,
        ads: +(p.weapon?.adsAmount ?? 0).toFixed(3),
      });
    }
    return orig(...a);
  };

  // ---- drive scope.amount directly, preserving the real call ORDER ----------
  // ScopeFX.update() is invoked from engine.update() (engine.js:1188), i.e. AFTER every
  // system update() including the viewmodel's, and immediately before render. Replacing
  // its body with a scripted ramp keeps that ordering exactly and isolates it from
  // ScopeFX's own ADS dynamics, which is what we are testing.
  const scope = g.engine.scope;
  const origScopeUpdate = scope.update.bind(scope);
  let scripted = 0;
  scope.update = function () {
    this.amount = scripted;
    this.active = scripted > 0;
    this._write(scripted, this.apertureR, 0.0045, 0);
  };

  recording = true;
  scripted = 1;                        // scoped in
  await wait(20);
  const peak = g.engine.scope?.amount ?? 0;
  scripted = 0;                        // hard un-scope (swap / death / fast release)
  await wait(12);
  recording = false;
  pass.render = orig;
  scope.update = origScopeUpdate;

  // The bug frame: the pass DRAWS the view scene while the gun group is invisible.
  const bad = samples.filter((s) => s.drawn && !s.gunVisible);
  return { equipped, wanted: scopedDef.id, peak: +peak.toFixed(3), samples, bad };
});

console.log('equipped =', out.equipped, '(wanted', out.wanted + ')  peak scope.amount =', out.peak);
console.log('\nframe-by-frame (viewPass.render decision point):');
for (const s of out.samples) {
  const mark = (s.drawn && !s.gunVisible) ? '   <-- VIEW SCENE DRAWN WITH NO GUN' : '';
  console.log(`  f=${s.f} ads=${s.ads} scope=${s.amount} drawn=${s.drawn} gunVisible=${s.gunVisible} _scopeHidden=${s.scopeHidden}${mark}`);
}
console.log(`\nBAD FRAMES (view scene rendered with the weapon group invisible): ${out.bad.length}`);
if (errs.length) console.log('page errors:', errs);

await browser.close();
await server.close();
process.exit(0);
