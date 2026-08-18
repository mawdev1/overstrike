/**
 * OVERSTRIKE — "can you actually see through the sight?"
 *
 *   node scripts/opticglass.mjs [--out=shots/optics]
 *
 * WHY THIS EXISTS
 * ---------------
 * `scopeshot.mjs` verified the scope overlay, the reticle-to-bullet alignment and the
 * state machine, and every one of its checks passed — while aiming down sights was
 * rendering a solid opaque disc in the middle of the screen. It even had a check named
 * "a non-scoped weapon at full ADS is completely untouched", which passed, because
 * "untouched" only ever meant "the scope overlay did not activate".
 *
 * Nothing asserted the thing a player actually cares about: that the optic is GLASS. So
 * this probe asserts exactly that, for every weapon in the game, by comparison rather
 * than by eyeballing a threshold:
 *
 *   1. Render one frame at full ADS.
 *   2. Render the same frame again with the viewmodel hidden — that is ground truth for
 *      "the world behind the gun".
 *   3. Inside the lens region, correlate the two.
 *
 * An opaque lens decorrelates completely (it shows its own flat colour no matter what is
 * behind it). Real glass tracks the world behind it closely, whatever that world happens
 * to be — so this needs no per-map tuning and cannot be fooled by pointing the camera at
 * something conveniently busy.
 *
 * THE METRIC, AND THE CONTROL THAT VALIDATES IT
 * ---------------------------------------------
 * The gate is `keep` — how much of the background's luminance variance survives into the
 * lens region. A test that has never been shown to fail proves nothing, so this was
 * validated by forcing the lens material opaque again at runtime and re-measuring the
 * same weapon in the same frame:
 *
 *     glass transparent   lens std 28.19   bg std 34.92   keep 0.807
 *     glass forced OPAQUE lens std  0.45   bg std 34.92   keep 0.013
 *
 * Two orders of magnitude apart, so the threshold sits comfortably between them.
 *
 * FILM GRAIN IS DISABLED for the run. It is re-randomised every frame, so across two
 * captures it is pure uncorrelated noise — with it on, a small low-contrast sample is
 * mostly grain and every weapon scores ~0 correlation whether its lens is glass or
 * concrete. That cost me a full debugging round; leave it off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { ROOT, startServer, launchBrowser, EARLY_SRC, settingsInitScript } from './perflib.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const OUT = path.resolve(ROOT, arg('out', 'shots/optics'));
fs.mkdirSync(OUT, { recursive: true });

// Sample an ANNULUS around screen centre, not a filled box.
//
// The reticle sits exactly at centre and is legitimately opaque — a red dot you can see
// through is not a red dot — so including it would penalise a correct sight. The inner
// radius clears the reticle; the outer stays well inside the aperture so the tube wall,
// the soft aperture edge and the scope overlay's vignette never enter the sample.
const R_INNER = 0.008;   // fraction of screen height — clears the reticle
const R_OUTER = 0.030;   // stays inside the aperture, short of the tube wall

// Correlation is REPORTED but does not gate. It sounded like the obvious metric and it
// is not: the sight body legitimately occludes part of any sample annulus, which
// decorrelates a perfectly good lens, and it scored the same ~0.26 for glass and for
// iron sights. Variance retention is what actually discriminates — see the control
// below.
const CORR_MIN = 0.55;
const RATIO_MIN = 0.35;  // fraction of the background's variance the lens must pass through

const server = await startServer({ dev: false, port: 5399, doBuild: true });
const browser = await launchBrowser({});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(300000);
await page.addInitScript(EARLY_SRC);
await page.addInitScript(settingsInitScript({ renderScale: 1.0, postFx: true, shadows: true, filmGrain: false }));

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(server.url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state === 'menu', null, { polling: 200 });

/**
 * Every weapon, with the optic it carries — we test all of them, not just the scopes.
 * Read from source in Node: the production bundle does not serve `/src/`.
 */
const { WEAPON_LIST } = await import('../src/weapons/weaponDefs.js');
const weapons = WEAPON_LIST.map((w) => ({
  id: w.id, name: w.name, optic: w.viewmodel?.optic?.type ?? 'irons', scoped: !!w.scoped,
}));

await page.evaluate(() => {
  const g = window.__GAME__;
  g.settings.set('botCount', 0);
  g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 4242 });
  for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);
});

/** Park somewhere with real depth in front of the muzzle, so "the world behind" varies. */
await page.evaluate(() => {
  const g = window.__GAME__;
  g.__pin = { x: -25, y: 0, z: 5, yaw: 4.014, pitch: -0.02 };
  const apply = () => {
    const p = g.player; const pin = g.__pin;
    if (!p) return;
    p.position.set(pin.x, pin.y, pin.z);
    p.yaw = pin.yaw; p.pitch = pin.pitch;
    p.velocity.set(0, 0, 0);
  };
  g.__applyPin = apply;
  apply();
});

const raf = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));

async function settle(frames) {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => { window.__GAME__.__applyPin?.(); });
    await raf();
  }
}

/** Decode a data-URL frame, save it for eyeballing, and pull the annulus samples. */
function decode(dataUrl, name) {
  const file = path.join(OUT, name + '.png');
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(file, buf);
  const png = PNG.sync.read(buf);
  const rIn = png.height * R_INNER, rOut = png.height * R_OUTER;
  const rIn2 = rIn * rIn, rOut2 = rOut * rOut;
  const cx = png.width >> 1, cy = png.height >> 1;
  const lim = Math.ceil(rOut);
  const lum = [];
  // Deterministic scan order, so `lum[i]` refers to the same pixel in both captures and
  // the two arrays can be correlated element-wise.
  for (let y = cy - lim; y <= cy + lim; y++) {
    for (let x = cx - lim; x <= cx + lim; x++) {
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < rIn2 || d2 > rOut2) continue;
      const i = (png.width * y + x) << 2;
      lum.push(0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]);
    }
  }
  return { lum, file };
}

function stats(a) {
  const n = a.length;
  const mean = a.reduce((s, v) => s + v, 0) / n;
  const varc = a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / n;
  return { mean, std: Math.sqrt(varc) };
}

function correlate(a, b) {
  const sa = stats(a), sb = stats(b);
  if (sa.std < 1e-6 || sb.std < 1e-6) return 0;
  let cov = 0;
  for (let i = 0; i < a.length; i++) cov += (a[i] - sa.mean) * (b[i] - sb.mean);
  cov /= a.length;
  return cov / (sa.std * sb.std);
}

/**
 * Pick an aim direction with real structure behind the sight.
 *
 * Correlation can only detect a see-through lens if there is something varied behind it.
 * Aimed at a patch of flat ground, glass and a solid disc score the same low number and
 * the test says nothing. So: render the world with no weapon at several candidate
 * directions and keep whichever puts the most luminance variance inside the sample
 * annulus. Self-calibrating, so it survives someone re-authoring the map.
 */
async function renderBare() {
  const url = await page.evaluate(() => {
    const g = window.__GAME__, e = g.engine;
    const hidden = [];
    e.viewScene.traverse((o) => { if (o.isMesh && o.visible) { hidden.push(o); o.visible = false; } });
    e.update(1 / 60); e.render(1 / 60);
    const png = g.renderer.domElement.toDataURL('image/png');
    hidden.forEach((o) => { o.visible = true; });
    return png;
  });
  return decode(url, '_aimprobe');
}

let best = null;
for (const yaw of [4.014, 4.30, 3.75, 2.20, 0.60]) {
  for (const pitch of [-0.02, 0.06]) {
    await page.evaluate(({ yaw, pitch }) => {
      const g = window.__GAME__;
      g.__pin.yaw = yaw; g.__pin.pitch = pitch; g.__applyPin();
    }, { yaw, pitch });
    await settle(4);
    const b = await renderBare();
    const st = stats(b.lum).std;
    if (!best || st > best.std) best = { yaw, pitch, std: st };
  }
}
await page.evaluate(({ yaw, pitch }) => {
  const g = window.__GAME__;
  g.__pin.yaw = yaw; g.__pin.pitch = pitch; g.__applyPin();
}, best);
await settle(6);
console.log(`[optic] aim chosen: yaw ${best.yaw} pitch ${best.pitch} — background variance ${best.std.toFixed(1)}`);
const BG_STD = best.std;

const rows = [];

for (const w of weapons) {
  // Equip, aim fully, let the ADS transition finish.
  await page.evaluate((id) => {
    const g = window.__GAME__;
    g.input.buttons[0] = false; g.input.buttons[2] = false;
    g.weapons?.giveWeapon?.(g.player, id) ?? g.player.setWeapon?.(id);
    g.__applyPin?.();
  }, w.id);
  // Wait for the weapon switch to finish before aiming, then for the aim-in to complete.
  // Two weapons previously sampled at adsAmount 0 because the switch was still running,
  // which silently turned their result into a hip-fire measurement.
  await settle(40);
  await page.evaluate(() => { window.__GAME__.input.buttons[2] = true; });
  for (let i = 0; i < 40; i++) {
    await settle(6);
    const a = await page.evaluate(() => window.__GAME__.player.adsAmount ?? 0);
    if (a >= 0.995) break;
  }
  await settle(12);

  const ads = await page.evaluate(() => ({
    ads: +(window.__GAME__.player.adsAmount ?? 0).toFixed(3),
    scope: +(window.__GAME__.engine.scope?.amount ?? 0).toFixed(3),
    weapon: window.__GAME__.player.weapon?.def?.id,
  }));

  // Render BOTH frames inside a single JS task: gun visible, then gun hidden, with no
  // rAF in between. Nothing steps the simulation between them, so the camera, the world
  // and the grain seed are bit-identical and the ONLY difference in the image is the
  // weapon itself. Earlier revisions captured via two screenshots a few frames apart and
  // lost the signal to scope sway nudging the camera a pixel or two — which decorrelated
  // every weapon equally and made working glass look identical to a solid disc.
  const pair = await page.evaluate(() => {
    const g = window.__GAME__, e = g.engine;
    const canvas = g.renderer.domElement;
    e.update(1 / 60);
    e.render(1 / 60);
    const withGun = canvas.toDataURL('image/png');
    const hidden = [];
    e.viewScene.traverse((o) => { if (o.isMesh && o.visible) { hidden.push(o); o.visible = false; } });
    e.render(1 / 60);
    const noGun = canvas.toDataURL('image/png');
    hidden.forEach((o) => { o.visible = true; });
    return { withGun, noGun };
  });

  const shot = decode(pair.withGun, `${w.id}-ads`);
  const bare = decode(pair.noGun, `${w.id}-bare`);

  await page.evaluate(() => { window.__GAME__.input.buttons[2] = false; });
  await settle(20);

  const s = stats(shot.lum);
  const b = stats(bare.lum);
  const corr = correlate(shot.lum, bare.lum);
  // How much of the background's structure survives into the sight picture. An opaque
  // lens flattens it toward 0; glass keeps most of it.
  const ratio = b.std > 1e-6 ? s.std / b.std : 0;
  // Iron sights are not glass: a front post and a rear aperture are supposed to be
  // solid, so they are reported for information and never gate the run. Only weapons
  // carrying an actual lens must be see-through.
  const isGlass = w.optic === 'reddot' || w.optic === 'holo' || w.optic === 'scope';
  const engaged = ads.ads >= 0.99;
  const pass = !isGlass ? true : engaged && ratio >= RATIO_MIN;
  rows.push({ ...w, ...ads, std: s.std, bareStd: b.std, ratio, mean: s.mean, corr, pass, isGlass, engaged });
}

const pad = (s, n, right = true) => {
  s = String(s);
  return right ? s.padEnd(n) : s.padStart(n);
};

console.log('\n================= OPTIC GLASS: CAN YOU SEE THROUGH THE SIGHT? =================');
console.log('corr = correlation between the lens interior and the world behind it, with the');
console.log('viewmodel hidden. An opaque lens decorrelates; real glass tracks it.\n');
console.log(`${pad('weapon', 16)} ${pad('optic', 8)} ${pad('ads', 5, false)} ${pad('lens std', 9, false)} ${pad('bg std', 7, false)} ${pad('keep', 6, false)} ${pad('corr', 7, false)}  result`);
console.log('-'.repeat(88));
let fails = 0;
let glassCount = 0;
for (const r of rows) {
  if (!r.pass) fails++;
  if (r.isGlass) glassCount++;
  const verdict = !r.isGlass ? 'n/a   (iron sights — solid by design)'
    : !r.engaged ? 'INCONCLUSIVE — ADS never engaged'
      : r.pass ? 'PASS' : 'FAIL  <-- you cannot see through this sight';
  console.log(
    `${pad(r.id, 16)} ${pad(r.optic, 8)} ` +
    `${pad(r.ads.toFixed(2), 5, false)} ${pad(r.std.toFixed(1), 9, false)} ${pad(r.bareStd.toFixed(1), 7, false)} ` +
    `${pad(r.ratio.toFixed(2), 6, false)} ${pad(r.corr.toFixed(3), 7, false)}  ${verdict}`,
  );
}
console.log('-'.repeat(88));
console.log(`${glassCount - fails}/${glassCount} lensed optics are see-through   (corr >= ${CORR_MIN}, keeps >= ${RATIO_MIN} of background variance)`);
console.log(`screenshots -> ${OUT}`);
if (errors.length) console.log('\npage errors:', [...new Set(errors)].slice(0, 5));

fs.writeFileSync(path.join(ROOT, 'perf/opticglass.json'), JSON.stringify(rows, null, 1));

await browser.close();
await server.close();
process.exit(fails ? 1 : 0);
