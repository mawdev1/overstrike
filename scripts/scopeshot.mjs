/**
 * Telescopic sight probe.
 *
 * Boots the real game, hands the player a scoped weapon, parks them at the most open
 * viewpoint the map has, and screenshots the sight picture at every stage that matters:
 * hip, mid-aim-in, fully scoped, breath held, and the frame after a shot.
 *
 * Unlike the audit probes this launches Chromium on the REAL GPU (ANGLE → D3D11), not
 * SwiftShader, because the whole point is to look at pixels a player would actually see —
 * the composite pass, the bloom and the scope's own lens work all render differently under
 * a software rasteriser.
 *
 * It also measures the two things that decide whether the feature is acceptable:
 *   1. RETICLE vs BULLET. Screen centre is where the reticle is drawn. The probe fires
 *      the real ballistics path, projects the impact point back through the live camera,
 *      and reports the offset in pixels. Anything above a couple of pixels at 6× means
 *      the sight lies and the feature is worse than nothing.
 *   2. COST. Frame time and draw calls with the scope up versus down.
 *
 * Usage: node scripts/scopeshot.mjs [--out=shots/scope] [--weapon=sr_reaver|dmr_meridian] [--scale=1]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const OUT = path.resolve(ROOT, arg('out', 'shots/scope'));
const WEAPON = arg('weapon', 'sr_reaver');
const SCALE = Number(arg('scale', 1));

await mkdir(OUT, { recursive: true });

const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5211, strictPort: false, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--mute-audio',
    // Without these rAF is pinned to the display refresh and every cost measurement
    // below would read exactly 16.7 ms whatever the scope costs.
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(180000);
await page.addInitScript((s) => {
  try {
    const KEY = 'overstrike.settings.v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: s }));
  } catch { /* private mode */ }
}, SCALE);

const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 250 });

const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`[scope] GPU: ${gpu}`);

await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' }));
await page.waitForTimeout(2200);

// ── park the player somewhere with a long sightline and give them the scope ──
const setup = await page.evaluate((weaponId) => {
  const g = window.__GAME__;
  const p = g.player;
  const V = p.position.constructor;
  const eye = new V(), dir = new V();

  let best = null;
  for (const sp of g.world.spawnPoints) {
    for (let i = 0; i < 48; i++) {
      const yaw = (i / 48) * Math.PI * 2;
      eye.set(sp.position.x, sp.position.y + 1.62, sp.position.z);
      dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      const hit = g.world.raycast(eye, dir, 200);
      const open = hit ? hit.distance : 200;
      if (!best || open > best.open) best = { x: sp.position.x, y: sp.position.y, z: sp.position.z, yaw, open };
    }
  }

  p.position.set(best.x, best.y, best.z);
  p.velocity.set(0, 0, 0);
  p.camera.setAngles(best.yaw, -0.02);
  p.camera.reset();
  p.camera.baseYaw = best.yaw;
  p.camera.basePitch = -0.02;

  g.weapons.giveLoadout(p, [weaponId, 'pistol_sidewinder']);
  g.weapons.switchTo(p, 0, true);

  g.input.enabled = true;
  g.input.actions.clear();
  g.input.buttons[0] = g.input.buttons[2] = false;

  return { open: Math.round(best.open), weapon: p.weapon?.def?.id ?? null, mag: p.weapon?.def?.viewmodel?.optic?.mag ?? null };
}, WEAPON);
console.log(`[scope] weapon=${setup.weapon} mag=${setup.mag}x  sightline=${setup.open} m`);
if (setup.weapon !== WEAPON) console.log(`[scope] WARNING: expected ${WEAPON}`);

/** Hold the rig still so a screenshot is not a random frame of a wobble. */
const freeze = async () => page.evaluate(() => {
  const g = window.__GAME__;
  g.player.velocity.set(0, 0, 0);
  g.input.actions.clear();
});

const shoot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`[scope] ${name}.png`);
};

const setAds = async (on) => page.evaluate((v) => { window.__GAME__.input.buttons[2] = v; }, on);
const setHold = async (on) => page.evaluate((v) => {
  const a = window.__GAME__.input.actions;
  if (v) a.add('sprint'); else a.delete('sprint');
}, on);

const scopeState = async () => page.evaluate(() => {
  const s = window.__GAME__.engine.scope;
  const c = window.__GAME__.player.camera;
  return {
    amount: +s.amount.toFixed(3),
    aperture: +s.apertureR.toFixed(3),
    shift: [+s.shiftX.toFixed(4), +s.shiftY.toFixed(4)],
    glint: +s.glintI.toFixed(3),
    ads: +window.__GAME__.player.adsAmount.toFixed(3),
    breath: +c.breath.toFixed(3),
    swayDeg: +((Math.hypot(c.scopeSwayYaw, c.scopeSwayPitch)) * 180 / Math.PI).toFixed(3),
    gunVisible: !!window.__GAME__.weapons.viewmodel?.current?.group?.visible,
    fov: +window.__GAME__.camera.fov.toFixed(2),
  };
});

// ═══════════════════════════════════════════════════════════════ stage 1: hip ══
await freeze();
await page.waitForTimeout(500);
await shoot('01-hip');
console.log('[scope]   ', JSON.stringify(await scopeState()));

// ══════════════════════════════════════════════════════ stage 2: mid-transition ══
// A screenshot takes longer than the 0.44 s aim-in, so the frame has to be frozen at a
// known point rather than raced. `game.stop()` cancels the rAF and leaves the last
// composed frame on the canvas exactly as it was.
await setAds(true);
const mid = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__GAME__;
  const tick = () => {
    const a = g.engine.scope.amount;
    if (a > 0.34 && a < 0.72) {
      g.stop();
      resolve({ amount: +a.toFixed(3), ads: +g.player.adsAmount.toFixed(3) });
    } else if (a >= 0.72) { resolve({ amount: +a.toFixed(3), missed: true }); }
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));
console.log('[scope]   frozen mid-transition:', JSON.stringify(mid));
await shoot('02-transition');
await page.evaluate(() => window.__GAME__.start());

// And again just past the point where the viewmodel is pulled — the one frame in the
// whole animation that could pop.
await setAds(false);
await page.waitForTimeout(900);
await setAds(true);
const mid2 = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__GAME__;
  const tick = () => {
    const a = g.engine.scope.amount;
    if (a > 0.60) { g.stop(); resolve({ amount: +a.toFixed(3), gunVisible: !!g.weapons.viewmodel?.current?.group?.visible }); }
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));
console.log('[scope]   frozen late-transition:', JSON.stringify(mid2));
await shoot('02b-transition-late');
await page.evaluate(() => window.__GAME__.start());

// ══════════════════════════════════════════════════════════ stage 3: fully scoped ══
await page.waitForTimeout(1200);
await freeze();
const scoped = await scopeState();
console.log('[scope]   ', JSON.stringify(scoped));
await shoot('03-scoped');
// A 1:1 crop of the middle of the sight picture — the reticle is hairlines, and a
// downscaled 1600×900 frame cannot tell you whether they are crisp.
await page.screenshot({
  path: path.join(OUT, '03b-reticle-1to1.png'),
  clip: { x: 800 - 320, y: 450 - 200, width: 640, height: 400 },
});
console.log('[scope] 03b-reticle-1to1.png');

// ═══════════════════════════════════════════════════════ stage 4: breath held ══
await setHold(true);
await page.waitForTimeout(700);
await shoot('04-breath-held');
console.log('[scope]   ', JSON.stringify(await scopeState()));
await setHold(false);

// ══════════════════════════════════════ stage 5: RETICLE vs BULLET, then firing ══
// Screen centre is where the reticle is drawn. Fire the real ballistics path, project
// the impact back through the live camera, and measure the disagreement in pixels.
const aimTruth = await page.evaluate(() => {
  const g = window.__GAME__;
  const p = g.player;
  const V = p.position.constructor;
  const eye = new V(), dir = new V(), pt = new V();
  p.getEyePosition(eye);
  p.getAimDirection(dir);
  const hit = g.world.raycast(eye, dir, 400);
  if (!hit) return { ok: false };
  pt.copy(hit.point);
  // Project the point the bullet is about to hit through the camera that is on screen.
  g.camera.updateMatrixWorld();
  pt.project(g.camera);
  const w = window.innerWidth, h = window.innerHeight;
  return {
    ok: true,
    distance: +hit.distance.toFixed(2),
    px: +(pt.x * w * 0.5).toFixed(3),
    py: +(-pt.y * h * 0.5).toFixed(3),
    fov: +g.camera.fov.toFixed(2),
    // How much of a pixel one arcminute is worth here — context for the number above.
    pxPerDeg: +((h * 0.5) / Math.tan(g.camera.fov * 0.5 * Math.PI / 180) * Math.tan(Math.PI / 180)).toFixed(2),
  };
});
console.log('[scope] reticle-vs-bullet:', JSON.stringify(aimTruth));

// Now actually pull the trigger, freeze on the recoil frame, and look at it. The shot
// goes through the real WeaponInstance so ballistics, recoil and audio all run.
const firing = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__GAME__;
  g.__impact = null;
  const grab = (e) => { if (!g.__impact && e?.point) g.__impact = { x: e.point.x, y: e.point.y, z: e.point.z }; };
  g.bus.on('impact', grab);
  g.bus.on('hit', grab);
  const ammo0 = g.player.weapon.ammo;
  // A swap latches the trigger on purpose ("require a fresh pull"), so release first.
  g.player.weapon.stopFire();
  g.player.weapon.tryFire();
  let n = 0;
  const tick = () => {
    // Freeze three frames in: the camera punch has landed, the sight picture is
    // maximally disrupted, and the muzzle flash is still alive.
    if (++n >= 3) {
      g.stop();
      resolve({ ammoBefore: ammo0, ammoAfter: g.player.weapon.ammo, impact: !!g.__impact });
    } else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));
console.log('[scope]   fired:', JSON.stringify(firing));
console.log('[scope]   ', JSON.stringify(await scopeState()));
await shoot('05-firing');
await page.evaluate(() => { window.__GAME__.start(); window.__GAME__.input.buttons[0] = false; });
await page.waitForTimeout(900);
await shoot('06-post-recoil');

// Where did the round that was actually fired land, in screen pixels, at the moment of
// firing? (Recoil has moved the camera since, so this is measured against the impact
// point the ballistics layer reported.)
const fired = await page.evaluate(() => {
  const g = window.__GAME__;
  if (!g.__impact) return { ok: false };
  const V = g.player.position.constructor;
  const pt = new V(g.__impact.x, g.__impact.y, g.__impact.z);
  const eye = new V(), dir = new V();
  g.player.getEyePosition(eye);
  const d = pt.clone().sub(eye);
  const dist = d.length();
  g.player.getAimDirection(dir);
  const cosA = d.normalize().dot(dir);
  return { ok: true, distance: +dist.toFixed(2), offAxisDeg: +(Math.acos(Math.min(1, cosA)) * 180 / Math.PI).toFixed(4) };
});
console.log('[scope] fired round vs aim axis:', JSON.stringify(fired));

// ═══════════════════════════ stage 5b: RETICLE vs BULLET, every frame, live ══
// One sample at one still moment proves very little. This tracks the disagreement
// between screen centre (where the HUD draws the reticle) and the point the CURRENT
// aim ray hits, once per rendered frame, through sway, breathing, mouse lag and the
// recoil of live rounds — and fires real ones part-way through. If the sight ever
// lies, it lies while the rifle is moving, which is the only time it matters.
await page.evaluate(() => window.__GAME__.start());
await setAds(true);
await page.waitForTimeout(1400);
const track = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__GAME__;
  const V = g.player.position.constructor;
  const eye = new V(), dir = new V(), pt = new V();
  const w = window.innerWidth, h = window.innerHeight;
  let n = 0, worst = 0, worstAt = null, sum = 0, samples = 0, misses = 0, shots = 0;
  g.player.weapon.stopFire();
  const tick = () => {
    // Fire a live round every 40 frames so recoil, the bolt cycle and the reticle
    // fade are all in the sample.
    // Through the REAL input path, not weapon.tryFire(): the trigger is polled inside
    // _fixedUpdate, so the recoil impulse and the camera that composes the frame land in
    // the same tick. Calling tryFire() from rAF applies recoil AFTER the camera has
    // already been written and manufactures a one-frame disagreement that no player can
    // ever see.
    g.input.enabled = true;
    g.input.buttons[0] = (n > 20 && (n % 40 === 0 || n % 40 === 1));
    if (g.player.weapon) {
      if (g.player.weapon.ammo <= 0) g.player.weapon.ammo = g.player.weapon.def.magSize;
      if (n > 20 && n % 40 === 2) shots++;
    }
    if (!g.player.alive && g.match?.respawn) g.match.respawn(g.player);
    g.player.health = g.player.maxHealth;
    g.player.getEyePosition(eye);
    g.player.getAimDirection(dir);
    const hit = g.world.raycast(eye, dir, 400);
    if (!hit) { misses++; } else {
      pt.copy(hit.point);
      g.camera.updateMatrixWorld();
      pt.project(g.camera);
      const dx = pt.x * w * 0.5, dy = -pt.y * h * 0.5;
      const d = Math.hypot(dx, dy);
      sum += d; samples++;
      if (d > worst) { worst = d; worstAt = { px: +dx.toFixed(3), py: +dy.toFixed(3), frame: n }; }
    }
    if (++n < 260) requestAnimationFrame(tick);
    else {
      resolve({
        samples, misses, shots,
        meanPx: +(sum / Math.max(1, samples)).toFixed(4),
        worstPx: +worst.toFixed(4),
        worstAt,
        pxPerDeg: +((h * 0.5) / Math.tan(g.camera.fov * 0.5 * Math.PI / 180) * Math.tan(Math.PI / 180)).toFixed(2),
      });
    }
  };
  requestAnimationFrame(tick);
}));
console.log('[scope] reticle-vs-bullet, 260 live frames:', JSON.stringify(track));

// Same measurement for every real round the ballistics layer actually reported an
// impact for: the angle between the shot's own origin/direction and where it landed.
const rounds = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__GAME__;
  const V = g.player.position.constructor;
  const out = [];
  let pending = null;
  const onShot = (e) => {
    if (!e?.isPlayer) return;
    pending = { o: new V(e.origin.x, e.origin.y, e.origin.z), d: new V(e.dir.x, e.dir.y, e.dir.z) };
  };
  const onLand = (e) => {
    if (!pending || !e?.point) return;
    const v = new V(e.point.x, e.point.y, e.point.z).sub(pending.o);
    const dist = v.length();
    const cos = Math.min(1, v.normalize().dot(pending.d.normalize()));
    out.push({ dist: +dist.toFixed(2), offDeg: +(Math.acos(cos) * 180 / Math.PI).toFixed(5) });
    pending = null;
  };
  const u1 = g.bus.on('shot', onShot);
  const u2 = g.bus.on('impact', onLand);
  const u3 = g.bus.on('hit', onLand);
  let n = 0;
  const tick = () => {
    g.input.enabled = true;
    g.input.buttons[0] = (n % 30 === 0 || n % 30 === 1);
    if (g.player.weapon && g.player.weapon.ammo <= 0) g.player.weapon.ammo = g.player.weapon.def.magSize;
    if (!g.player.alive && g.match?.respawn) g.match.respawn(g.player);
    g.player.health = g.player.maxHealth;
    if (++n < 200) requestAnimationFrame(tick);
    else { g.input.buttons[0] = false; u1(); u2(); u3(); resolve(out); }
  };
  requestAnimationFrame(tick);
}));
const offs = rounds.map((r) => r.offDeg);
console.log(`[scope] live rounds: n=${rounds.length} max off-axis=${offs.length ? Math.max(...offs) : 'n/a'} deg`);

// ══════════════════════════════════ stage 5c: resize while fully scoped ══════
const resized = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__GAME__;
  const before = { amount: +g.engine.scope.amount.toFixed(3), res: g.engine.compositePass.uniforms.uResolution.value.toArray() };
  window.dispatchEvent(new Event('resize'));
  setTimeout(() => resolve({
    before,
    after: { amount: +g.engine.scope.amount.toFixed(3), res: g.engine.compositePass.uniforms.uResolution.value.toArray() },
    aoDepth1: !!g.engine.composer.renderTarget1.depthTexture,
    aoDepth2: !!g.engine.composer.renderTarget2.depthTexture,
  }), 240);
}));
await page.setViewportSize({ width: 1280, height: 720 });
await page.waitForTimeout(700);
await shoot('09-scoped-720p');
const small = await scopeState();
console.log('[scope] resize while scoped:', JSON.stringify(resized), JSON.stringify(small));
await page.setViewportSize({ width: 1600, height: 900 });
await page.waitForTimeout(700);

// ═════════════════════ stage 5d: control — a NON-scoped weapon at full ADS ══
await setAds(false);
await page.waitForTimeout(500);
const control = await page.evaluate(async () => {
  const g = window.__GAME__;
  g.weapons.giveLoadout(g.player, ['ar_vector', 'pistol_sidewinder']);
  g.weapons.switchTo(g.player, 0, true);
  await new Promise((r) => setTimeout(r, 900));
  g.input.buttons[2] = true;
  await new Promise((r) => setTimeout(r, 1200));
  const u = g.engine.compositePass.uniforms;
  return {
    weapon: g.player.weapon?.def?.id,
    scopedFlag: !!g.player.weapon?.def?.scoped,
    ads: +g.player.adsAmount.toFixed(3),
    scopeAmount: +g.engine.scope.amount.toFixed(3),
    uScope: u.uScope.value,
    scopeActive: g.engine.scope.active,
    reticleVisible: (() => {
      const el = document.querySelector('#hud .scope');
      if (!el) return 'missing';
      const cs = getComputedStyle(el);
      return cs.visibility === 'hidden' || Number(cs.opacity) === 0 ? 'hidden' : 'visible';
    })(),
    gunVisible: !!g.weapons.viewmodel?.current?.group?.visible,
  };
});
await shoot('10-control-ar-ads');
console.log('[scope] non-scoped control:', JSON.stringify(control));
await page.evaluate((wid) => {
  const g = window.__GAME__;
  g.input.buttons[0] = g.input.buttons[2] = false;
  if (!g.player.alive) g.match?.respawn?.(g.player) ?? g.player.respawn?.();
  g.player.health = g.player.maxHealth;
  g.weapons.giveLoadout(g.player, [wid, 'pistol_sidewinder']);
  g.weapons.switchTo(g.player, 0, true);
  // Keep the player upright for the cost measurement — a corpse cannot hold a scope up.
  g.__heal = g.__heal || setInterval(() => {
    if (!g.player.alive) g.match?.respawn?.(g.player) ?? g.player.respawn?.();
    g.player.health = g.player.maxHealth;
  }, 80);
}, WEAPON);
await page.waitForTimeout(1400);

// ═══════════════════════════════════════════════════════════ stage 6: unscope ══
await setAds(false);
await page.waitForTimeout(160);
await shoot('07-unscoping');
await page.waitForTimeout(900);
await shoot('08-hip-again');
console.log('[scope]   ', JSON.stringify(await scopeState()));

// ══════════════════════════════════════════════════════════════════ cost ══════
const cost = async (label, adsOn, bypassShader = false) => {
  await setAds(adsOn);
  await page.waitForTimeout(1400);
  // Isolation run: keep the scope logic, the hidden viewmodel, the 22° FOV and the HUD
  // reticle, but stop the composite pass from taking the scope branch. The difference
  // between this and the full run is the pixel cost of the sight picture and nothing
  // else — comparing straight against un-scoped would also be measuring the FOV change.
  await page.evaluate((bypass) => {
    const s = window.__GAME__.engine.scope;
    if (bypass && !s.__origWrite) {
      s.__origWrite = s._write;
      s._write = function () { const u = this.engine?.compositePass?.uniforms; if (u?.uScope) u.uScope.value = 0; };
    } else if (!bypass && s.__origWrite) {
      s._write = s.__origWrite;
      s.__origWrite = null;
    }
  }, bypassShader);
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => new Promise((resolve) => {
    const g = window.__GAME__;
    // Two clocks. `cpuMs` is the CPU time inside composer.render() — command
    // submission. `frameMs` is the wall-clock gap between presented frames with vsync
    // off, which is the only number here that contains the GPU's fill cost, and fill is
    // exactly what an extra six texture taps per pixel buys.
    const cpu = [];
    const wall = [];
    let n = -80;                       // discard warm-up
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      if (n >= 0) { cpu.push(g.engine.stats.frameMs); wall.push(now - last); }
      last = now;
      if (++n < 420) requestAnimationFrame(tick);
      else {
        const med = (a) => { a.sort((x, y) => x - y); return +a[a.length >> 1].toFixed(3); };
        // The 5th percentile is the frame the GPU got to itself — no GC, no bot
        // re-plan, no driver hiccup. It is the only estimator here stable enough to
        // resolve a few hundred microseconds of fill.
        const p5 = (a) => { const b = a.slice().sort((x, y) => x - y); return +b[Math.floor(b.length * 0.05)].toFixed(3); };
        resolve({
          cpuMs: med(cpu),
          cleanMs: p5(wall),
          frameMs: med(wall),
          draws: g.engine.stats.drawCalls,
          tris: g.engine.stats.triangles,
          scope: +g.engine.scope.amount.toFixed(2),
        });
      }
    };
    requestAnimationFrame(tick);
  }));
  console.log(`[scope] cost ${label}: ${JSON.stringify(out)}`);
  return out;
};
const off = await cost('hip, no scope     ', false);
// Interleaved A/B, three times each: run-to-run drift on a desktop GPU is comparable to
// the effect being measured, so a single pair proves nothing.
const bypassRuns = [];
const onRuns = [];
for (let i = 0; i < 3; i++) {
  bypassRuns.push(await cost(`scoped, no overlay #${i + 1}`, true, true));
  onRuns.push(await cost(`scoped, full       #${i + 1}`, true, false));
}
const mean = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
const on = onRuns[onRuns.length - 1];
console.log(`[scope] sight-picture pixel cost: ${(mean(onRuns, 'cleanMs') - mean(bypassRuns, 'cleanMs')).toFixed(3)} ms `
  + `on a clean ${mean(bypassRuns, 'cleanMs').toFixed(2)} ms frame `
  + `(${Math.round(1000 / mean(bypassRuns, 'cleanMs'))} fps), mean of 3 A/B pairs`);
console.log(`[scope] scoped vs hip total:      ${(mean(onRuns, 'cleanMs') - off.cleanMs).toFixed(3)} ms clean-frame, `
  + `${on.draws - off.draws} draw calls, ${on.tris - off.tris} tris`);

// ═══════════════════════════════════════════════════ state-reset edge cases ══
const edge = await page.evaluate(async (weaponId) => {
  const g = window.__GAME__;
  const out = {};
  // Hand over to this block's own heal loop — the death test below has to be able to
  // actually kill the player.
  if (g.__heal) { clearInterval(g.__heal); g.__heal = null; }
  // Wall-clock, not frame counts: vsync is off for the cost measurement, so "90 frames"
  // is a quarter of a second and every timed transition below would be sampled early.
  // Also keep the player upright — seven bots have had several seconds of free shots at
  // them by now, and a corpse cannot demonstrate anything about a sight picture.
  const heal = setInterval(() => {
    const p = g.player;
    if (!p.alive) g.match?.respawn?.(p) ?? p.respawn?.();
    p.health = p.maxHealth;
  }, 60);
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  // The stages above fire live rounds for several hundred frames with seven bots
  // shooting back; put the player back on their feet and back on the scoped rifle
  // before measuring anything about the sight picture.
  g.input.buttons[0] = false;
  if (!g.player.alive) g.match?.respawn?.(g.player) ?? g.player.respawn?.();
  g.weapons.giveLoadout(g.player, [weaponId, 'pistol_sidewinder']);
  g.weapons.switchTo(g.player, 0, true);
  await settle(1000);
  out.weapon = g.player.weapon?.def?.id ?? null;

  g.input.buttons[2] = true;
  await settle(1200);
  out.scopedBefore = +g.engine.scope.amount.toFixed(2);

  // weapon swap while scoped
  g.weapons.switchTo(g.player, 1, true);
  await settle(60);
  out.afterSwap = +g.engine.scope.amount.toFixed(2);
  g.weapons.switchTo(g.player, 0, true);
  const t0 = performance.now();
  while (g.engine.scope.amount < 0.99 && performance.now() - t0 < 6000) await settle(50);
  out.backOnScope = +g.engine.scope.amount.toFixed(2);
  out.reScopeMs = Math.round(performance.now() - t0);

  // reload while scoped — the weapon system refuses ADS while reloading, so the sight
  // picture has to come down with it and come back afterwards.
  g.player.weapon.stopFire();
  g.player.weapon.tryFire();
  await settle(1400);
  g.player.weapon.stopFire();
  g.player.weapon.reload();
  await settle(500);
  out.reloadStarted = !!g.player.weapon.isReloading;
  out.duringReload = +g.engine.scope.amount.toFixed(2);
  await settle(3600);

  // pause while scoped
  g.input.buttons[2] = true;
  await settle(1200);
  out.rescoped = +g.engine.scope.amount.toFixed(2);
  g.paused = true;
  await settle(60);
  out.whilePaused = +g.engine.scope.amount.toFixed(2);
  g.paused = false;
  await settle(900);

  // death while scoped
  clearInterval(heal);
  out.beforeDeath = +g.engine.scope.amount.toFixed(2);
  g.player.die({ attacker: null, weaponId: 'world', hitPart: 'torso', point: g.player.position, normal: null });
  await settle(60);
  out.afterDeath = +g.engine.scope.amount.toFixed(2);
  out.gunVisible = !!g.weapons.viewmodel?.current?.group?.visible;

  g.input.buttons[2] = false;
  return out;
}, WEAPON);
console.log('[scope] edge cases:', JSON.stringify(edge));

const checks = [
  ['reticle within 2 px of the bullet path', aimTruth.ok && Math.hypot(aimTruth.px, aimTruth.py) < 2,
    aimTruth.ok ? `${Math.hypot(aimTruth.px, aimTruth.py).toFixed(2)} px (1° = ${aimTruth.pxPerDeg} px)` : 'no world hit'],
  ['reticle tracks the bullet path through sway + recoil', track.samples > 100 && track.worstPx < 2,
    `worst ${track.worstPx} px over ${track.samples} frames, ${track.shots} live rounds (1° = ${track.pxPerDeg} px)`],
  ['every fired round leaves along its own aim axis', rounds.length > 0 && Math.max(...offs) < 0.001,
    `n=${rounds.length}, max ${offs.length ? Math.max(...offs) : '-'}°`],
  ['resize while scoped keeps the sight up and resizes the buffers',
    resized.after.amount > 0.99 && resized.aoDepth1 && resized.aoDepth2 && small.amount > 0.99,
    `amount ${resized.before.amount} -> ${resized.after.amount}, 720p amount=${small.amount}`],
  ['a non-scoped weapon at full ADS is completely untouched',
    control.scopedFlag === false && control.ads > 0.99 && control.uScope === 0
      && control.scopeActive === false && control.reticleVisible === 'hidden' && control.gunVisible === true,
    `${control.weapon} ads=${control.ads} uScope=${control.uScope} reticle=${control.reticleVisible} gun=${control.gunVisible}`],
  ['scope reaches full strength', scoped.amount > 0.99, `amount=${scoped.amount}`],
  ['gun hidden while scoped', scoped.gunVisible === false, `gunVisible=${scoped.gunVisible}`],
  ['zero extra draw calls when scoped', on.draws - off.draws <= 0, `${off.draws} -> ${on.draws}`],
  ['round leaves the barrel while scoped', firing.ammoAfter === firing.ammoBefore - 1,
    `${firing.ammoBefore} -> ${firing.ammoAfter}, impact=${firing.impact}`],
  ['sight picture drops during a reload', edge.reloadStarted && edge.duringReload < 0.05,
    `started=${edge.reloadStarted} amount=${edge.duringReload}`],
  ['scope clears on weapon swap', edge.afterSwap === 0, `${edge.scopedBefore} -> ${edge.afterSwap}`],
  ['scope returns after swapping back', edge.backOnScope > 0.99, `amount=${edge.backOnScope} after ${edge.reScopeMs} ms`],
  ['scope clears on pause', edge.rescoped > 0.99 && edge.whilePaused === 0, `${edge.rescoped} -> ${edge.whilePaused}`],
  ['scope clears on death', edge.beforeDeath > 0.99 && edge.afterDeath === 0, `${edge.beforeDeath} -> ${edge.afterDeath}`],
  ['viewmodel restored on death', edge.gunVisible === true, `gunVisible=${edge.gunVisible}`],
];
let failed = 0;
console.log('');
for (const [name, pass, detail] of checks) {
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`);
}
if (errs.length) console.log('[scope] page errors:', [...new Set(errs)].slice(0, 6));
console.log(`[scope] -> ${OUT}`);

await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
