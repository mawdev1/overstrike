/**
 * FILL PROBE — visual + measured verification for the fill-rate / vertex-submission pass.
 *
 * Modelled on scripts/auditlib.mjs, but launched against the REAL GPU (ANGLE/D3D11)
 * rather than SwiftShader, because the whole point of this probe is to look at pixels.
 *
 * Three sections, one browser session (other engineers are probing concurrently):
 *
 *   FX      — detonates a frag, freezes the particle sim, then screenshots the SAME
 *             frozen particle set at several camera distances and several `uMaxSize`
 *             values. Freezing is what makes this a controlled A/B: nothing changes
 *             between the shots except the clamp. Also computes MEASURED transparent
 *             overdraw (in "screens") by projecting every live particle exactly the way
 *             PARTICLE_VERT does.
 *   BOTS    — 12 bots, measures per-mesh instance counts and bot triangle submission,
 *             then screenshots bots centred / at the screen edge / behind the player.
 *   DECALS  — fires into a wall, expires the decals, and reports how many dead decal
 *             instances still carry a full-size matrix (i.e. are still rasterised).
 *
 * Usage: node scripts/fillprobe.mjs --tag=before   (or --tag=after)
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const TAG = arg('tag', 'run');
const OUT = path.resolve(ROOT, 'shots', `fill-${TAG}`);
const VIEW = { width: 1280, height: 720 };

/** Candidate smoke/additive point-size clamps to sweep, in px. */
const SWEEP = [512, 320, 256, 224, 192];

const out = { tag: TAG, gl: null, fx: {}, bots: {}, decals: {}, errors: [] };

let server, browser;
try {
  await mkdir(OUT, { recursive: true });

  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    // HMR + watcher off: other engineers are editing src/ while this runs and a
    // mid-run reload silently destroys the measurement (auditlib.mjs does the same).
    server: { port: 0, strictPort: false, hmr: false, watch: null },
    logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log(`[fill] dev server ${url}`);

  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=d3d11',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--mute-audio',
    ],
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(300000);
  page.on('pageerror', (e) => out.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push(`console: ${m.text()}`); });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state === 'menu',
    null, { timeout: 300000, polling: 200 });

  out.gl = await page.evaluate(() => {
    const gl = window.__GAME__.renderer.getContext();
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    };
  });
  console.log(`[fill] GPU: ${out.gl.renderer}  buffer ${out.gl.drawingBuffer.join('x')}`);

  // ------------------------------------------------------------------ helpers
  await page.evaluate(() => {
    const g = window.__GAME__;
    const H = {};
    window.__H = H;

    H.step = (n) => new Promise((res) => {
      let i = 0;
      const t = () => { if (++i >= n) return res(); requestAnimationFrame(t); };
      requestAnimationFrame(t);
    });

    /** Park the camera. yaw/pitch per ARCHITECTURE §1. */
    H.cam = (px, py, pz, yaw, pitch = 0) => {
      const p = g.player;
      p.position.set(px, py, pz);
      p.velocity.set(0, 0, 0);
      p.yaw = yaw; p.pitch = pitch;
      p.camera.setAngles(yaw, pitch);
      // Kill every transient the camera owns so two screenshots differ only by what
      // we changed on purpose.
      const c = p.camera;
      c.shakeTime = 0; c.shakeAmp = 0;
      c.punch = 0; c.punchVel = 0;
      c.landOffset = 0; c.landVel = 0; c.bobAmp = 0;
      c.lagYaw = 0; c.lagPitch = 0;
    };

    H.fwd = (yaw) => ({ x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) });

    /** Pick the spawn point + yaw with the most open space ahead of it. */
    H.findOpen = (minDist) => {
      const w = g.world;
      let best = null;
      const eye = { x: 0, y: 0, z: 0 };
      for (const sp of w.spawnPoints) {
        for (let k = 0; k < 24; k++) {
          const yaw = (k / 24) * Math.PI * 2;
          const d = H.fwd(yaw);
          eye.x = sp.position.x; eye.y = sp.position.y + 1.62; eye.z = sp.position.z;
          const hit = w.raycast(eye, d, 60);
          const dist = hit ? hit.distance : 60;
          if (!best || dist > best.dist) best = { pos: sp.position.clone(), yaw, dist };
        }
      }
      return best && best.dist >= (minDist || 0) ? best : best;
    };

    /**
     * MEASURED transparent overdraw, in units of "full screens of blended fragments".
     * Projects every live particle exactly the way PARTICLE_VERT does
     * (gl_PointSize = min(aSize * uScale / max(-mvz, 0.05), uMaxSize)) and sums the
     * on-screen area of each square sprite.
     */
    H.overdraw = (overrides) => {
      const ps = g.fx.particles;
      const cam = g.camera;
      const gl = g.renderer.getContext();
      const W = gl.drawingBufferWidth, Hh = gl.drawingBufferHeight;
      const scale = 0.5 * Hh * cam.projectionMatrix.elements[5];
      const v = cam.matrixWorldInverse.elements;
      const res = { total: 0, groups: {}, live: 0 };
      for (const key of ['smoke', 'debris', 'add']) {
        const grp = ps.groups[key];
        const maxSize = (overrides && overrides[key] !== undefined)
          ? overrides[key] : grp.mat.uniforms.uMaxSize.value;
        let px2 = 0, clamped = 0;
        for (let i = 0; i < grp.count; i++) {
          const x = grp.pos[i * 3], y = grp.pos[i * 3 + 1], z = grp.pos[i * 3 + 2];
          const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
          if (vz > -0.05) continue;                       // behind the eye
          const raw = grp.siz[i] * scale / Math.max(-vz, 0.05);
          const s = Math.min(raw, maxSize);
          if (raw > maxSize) clamped++;
          // Clip to the viewport: a sprite whose centre is off screen still bleeds in,
          // so clamp the covered box rather than dropping it outright.
          const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
          const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
          const pe = cam.projectionMatrix.elements;
          const cx = (pe[0] * vx / -vz) * 0.5 * W + W * 0.5;
          const cy = (pe[5] * vy / -vz) * 0.5 * Hh + Hh * 0.5;
          const h = s * 0.5;
          const w0 = Math.max(0, Math.min(W, cx + h) - Math.max(0, cx - h));
          const h0 = Math.max(0, Math.min(Hh, cy + h) - Math.max(0, cy - h));
          px2 += w0 * h0;
        }
        res.groups[key] = {
          count: grp.count,
          clamped,
          screens: +(px2 / (W * Hh)).toFixed(3),
        };
        res.live += grp.count;
        res.total += px2 / (W * Hh);
      }
      res.total = +res.total.toFixed(3);
      return res;
    };

    H.setClamp = (smoke, add) => {
      g.fx.particles.groups.smoke.mat.uniforms.uMaxSize.value = smoke;
      g.fx.particles.groups.add.mat.uniforms.uMaxSize.value = add;
    };
    H.getClamp = () => ({
      smoke: g.fx.particles.groups.smoke.mat.uniforms.uMaxSize.value,
      debris: g.fx.particles.groups.debris.mat.uniforms.uMaxSize.value,
      add: g.fx.particles.groups.add.mat.uniforms.uMaxSize.value,
    });

    H.freezeFx = () => {
      const ps = g.fx.particles;
      if (ps.__origUpdate) return;
      ps.__origUpdate = ps.update;
      ps.update = () => {};
      // The flash billboards and lights decay too — pin them so only the clamp moves.
      const fx = g.fx;
      fx.__origUpdate = fx.update;
      fx.update = () => {};
    };
    H.thawFx = () => {
      const ps = g.fx.particles;
      if (ps.__origUpdate) { ps.update = ps.__origUpdate; ps.__origUpdate = null; }
      if (g.fx.__origUpdate) { g.fx.update = g.fx.__origUpdate; g.fx.__origUpdate = null; }
    };

    /** Bot rig meshes live in a module-private pool; find them by name in the scene. */
    H.rigMeshes = () => {
      const list = [];
      g.scene.traverse((o) => { if (o.isInstancedMesh && /^bot[01]_/.test(o.name || '')) list.push(o); });
      return list;
    };
    H.rigStats = () => {
      const list = H.rigMeshes();
      let tris = 0, instances = 0;
      for (const m of list) {
        const per = m.geometry.attributes.position.count / 3;
        tris += per * m.count;
        instances += m.count;
      }
      return {
        meshes: list.length,
        instances,
        triangles: tris,
        counts: list.slice(0, 4).map((m) => `${m.name}=${m.count}`),
        culled: list.filter((m) => m.frustumCulled).length,
      };
    };
  });

  // ================================================================ FX section
  console.log('[fill] --- FX ---');
  await page.evaluate(() => {
    const g = window.__GAME__;
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 0x51ded });
    g.setPaused(true);
  });
  await page.waitForTimeout(800);

  const spot = await page.evaluate(() => {
    const g = window.__GAME__, H = window.__H;
    const best = H.findOpen(14);
    g.__spot = best;
    H.cam(best.pos.x, best.pos.y, best.pos.z, best.yaw, 0);
    return { pos: [best.pos.x, best.pos.y, best.pos.z], yaw: best.yaw, dist: best.dist };
  });
  console.log(`[fill] open spot: ${spot.pos.map((n) => n.toFixed(1)).join(',')} yaw ${spot.yaw.toFixed(2)} clear ${spot.dist.toFixed(1)} m`);
  out.fx.spot = spot;
  out.fx.clampAtBoot = await page.evaluate(() => window.__H.getClamp());

  /**
   * Detonate a frag, let it develop for `ms`, then FREEZE the particle sim.
   * Everything after that is a controlled A/B: only the clamp and the camera move.
   */
  const detonate = async (ms) => {
    await page.evaluate(() => {
      const g = window.__GAME__, H = window.__H;
      H.thawFx();
      g.fx.particles.clear();
      const s = g.__spot;
      H.cam(s.pos.x, s.pos.y, s.pos.z, s.yaw, 0);
      const d = H.fwd(s.yaw);
      g.__boom = { x: s.pos.x + d.x * 5, y: s.pos.y + 0.35, z: s.pos.z + d.z * 5 };
      g.fx.explosion(g.__boom, 4);
      g.player.camera.shakeTime = 0; g.player.camera.shakeAmp = 0;
    });
    await page.waitForTimeout(ms);
    await page.evaluate(() => window.__H.freezeFx());
  };

  /** Look at the frozen burst from `dist` metres. */
  const lookFrom = async (dist) => page.evaluate((d) => {
    const g = window.__GAME__, H = window.__H;
    const s = g.__spot, b = g.__boom;
    const f = H.fwd(s.yaw);
    H.cam(b.x - f.x * d, s.pos.y, b.z - f.z * d, s.yaw, 0);
  }, dist);

  const shot = async (name) => {
    await page.waitForTimeout(140);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };

  // ---- moment 1: smoke column at full size (t ~ 1.1 s) -----------------------
  await detonate(1100);
  out.fx.smokePeak = {};
  for (const dist of [3, 6, 12]) {
    await lookFrom(dist);
    for (const v of SWEEP) {
      await page.evaluate((val) => window.__H.setClamp(val, val), v);
      await shot(`fx-smoke-d${dist}-clamp${v}`);
      if (dist === 3) {
        out.fx.smokePeak[`d3-clamp${v}`] = await page.evaluate(
          (val) => window.__H.overdraw({ smoke: val, add: val, debris: 192 }), v);
      }
    }
  }

  // ---- moment 2: fireball / flash (t ~ 0.13 s) ------------------------------
  await detonate(130);
  out.fx.fireball = {};
  for (const dist of [3, 6]) {
    await lookFrom(dist);
    for (const v of [512, 256, 224]) {
      await page.evaluate((val) => window.__H.setClamp(val, val), v);
      await shot(`fx-fire-d${dist}-clamp${v}`);
      if (dist === 3) {
        out.fx.fireball[`d3-clamp${v}`] = await page.evaluate(
          (val) => window.__H.overdraw({ smoke: val, add: val, debris: 192 }), v);
      }
    }
  }

  // ---- moment 3: standing inside a smoke cloud ------------------------------
  console.log('[fill] --- smoke cloud ---');
  await page.evaluate(async () => {
    const g = window.__GAME__, H = window.__H;
    H.thawFx();
    g.fx.particles.clear();
    const s = g.__spot;
    const d = H.fwd(s.yaw);
    // Deploy a real smoke cloud through the pooled cloud record, then pump the
    // projectile system's own emitter so the puff distribution is the shipping one.
    const c = g.projectiles.smokeClouds[0];
    c.id = 9001; c.active = true;
    c.position.set(s.pos.x + d.x * 4, s.pos.y + 0.35, s.pos.z + d.z * 4);
    c.radius = 0.4; c.targetRadius = 4.2; c.duration = 14; c.growTime = 1.6;
    c.t = 0; c.puffAccum = 0; c.owner = null; c.puffRate = 6;
    g.__cloud = { x: c.position.x, y: c.position.y, z: c.position.z };
    for (let i = 0; i < 600; i++) g.projectiles._updateSmoke(1 / 120);   // 5 s of cloud
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__H.freezeFx());

  out.fx.cloud = {};
  for (const [name, dist] of [['inside', 0.2], ['edge', 3], ['outside', 9]]) {
    await page.evaluate((d) => {
      const g = window.__GAME__, H = window.__H;
      const s = g.__spot, c = g.__cloud, f = H.fwd(s.yaw);
      H.cam(c.x - f.x * d, s.pos.y, c.z - f.z * d, s.yaw, 0);
    }, dist);
    for (const v of SWEEP) {
      await page.evaluate((val) => window.__H.setClamp(val, val), v);
      await shot(`fx-cloud-${name}-clamp${v}`);
      if (name === 'inside') {
        out.fx.cloud[`clamp${v}`] = await page.evaluate(
          (val) => window.__H.overdraw({ smoke: val, add: val, debris: 192 }), v);
      }
    }
  }

  // ---- moment 4: gunfire into a surface (impact FX + decals look) -----------
  await page.evaluate(() => {
    const g = window.__GAME__, H = window.__H;
    H.thawFx();
    g.fx.particles.clear();
    const s = g.__spot;
    H.cam(s.pos.x, s.pos.y, s.pos.z, s.yaw, 0);
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const g = window.__GAME__, H = window.__H;
    const s = g.__spot;
    const eye = { x: s.pos.x, y: s.pos.y + 1.62, z: s.pos.z };
    const d = H.fwd(s.yaw);
    // 24 hitscan shots into whatever is ahead — real impacts, real decals.
    for (let i = 0; i < 24; i++) {
      const jx = (i % 5 - 2) * 0.02, jy = ((i / 5 | 0) - 2) * 0.02;
      const dir = { x: d.x + jx, y: jy, z: d.z + jx * 0.3 };
      const len = Math.hypot(dir.x, dir.y, dir.z);
      dir.x /= len; dir.y /= len; dir.z /= len;
      const hit = g.world.raycast(eye, dir, 60);
      if (hit) {
        g.fx.impact(hit.point, hit.normal, hit.surface || 'concrete');
        g.fx.decal(hit.point, hit.normal, hit.surface || 'concrete', 0.16);
      }
    }
  });
  await page.waitForTimeout(260);
  await page.evaluate(() => window.__H.freezeFx());
  for (const v of [512, 256, 224]) {
    await page.evaluate((val) => window.__H.setClamp(val, val), v);
    await shot(`fx-impacts-clamp${v}`);
  }
  await page.evaluate(() => window.__H.thawFx());

  // ============================================================== DECAL section
  console.log('[fill] --- decals ---');
  out.decals = await page.evaluate(async () => {
    const g = window.__GAME__, H = window.__H;
    const ds = g.fx.decals;
    const s = g.__spot;
    const eye = { x: s.pos.x, y: s.pos.y + 1.62, z: s.pos.z };
    const d = H.fwd(s.yaw);

    // Two big scorches plus a spread of bullet holes, then age them all out.
    for (let i = 0; i < 40; i++) {
      const jx = (i % 7 - 3) * 0.018, jy = ((i / 7 | 0) - 3) * 0.018;
      const dir = { x: d.x + jx, y: jy, z: d.z + jx * 0.3 };
      const len = Math.hypot(dir.x, dir.y, dir.z);
      const hit = g.world.raycast(eye, { x: dir.x / len, y: dir.y / len, z: dir.z / len }, 60);
      if (hit) ds.add(hit.point, hit.normal, i % 13 === 0 ? 'scorch' : 'concrete', i % 13 === 0 ? 5.85 : 0.12);
    }
    const placed = { live: ds.liveCount, drawn: ds.mesh.count };

    // Age every decal past its life so the whole set expires.
    ds.update(60);
    ds.update(0.016);

    // How many EXPIRED slots still carry a full-size (rasterised) instance matrix?
    const m = ds.mesh.instanceMatrix.array;
    let deadFullSize = 0, deadParked = 0;
    for (let i = 0; i < ds.mesh.count; i++) {
      if (ds.alive[i]) continue;
      const o = i * 16;
      const sx = Math.hypot(m[o], m[o + 1], m[o + 2]);
      if (sx > 1e-6) deadFullSize++; else deadParked++;
    }
    return {
      afterPlacing: placed,
      afterExpiry: { live: ds.liveCount, drawn: ds.mesh.count },
      deadFullSize,
      deadParked,
      instanceMatrixHasUpdateRange:
        !!(ds.mesh.instanceMatrix.updateRanges && ds.mesh.instanceMatrix.updateRanges.length) ||
        (ds.mesh.instanceMatrix.updateRange ? ds.mesh.instanceMatrix.updateRange.count !== -1 : false),
    };
  });
  console.log('[fill] decals', JSON.stringify(out.decals));

  // =============================================================== BOTS section
  console.log('[fill] --- bots ---');
  await page.evaluate(() => {
    const g = window.__GAME__;
    g.setPaused(false);
    g.startMatch({ mode: 'tdm', botCount: 12, difficulty: 'regular', seed: 0xB07 });
  });
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__GAME__.setPaused(true));
  await page.waitForTimeout(300);

  out.bots.live = await page.evaluate(() => {
    const g = window.__GAME__;
    return {
      bots: g.bots.bots.length,
      alive: g.bots.bots.filter((b) => b.alive).length,
      teams: g.bots.bots.map((b) => b.team).join(''),
    };
  });

  /** Park 12 bots in a fixed arc in front of the camera and hold them there. */
  const placeBots = async (mode) => page.evaluate((m) => {
    const g = window.__GAME__, H = window.__H;
    const s = g.__spot;
    const f = H.fwd(s.yaw);
    const rx = -f.z, rz = f.x;                       // right vector
    H.cam(s.pos.x, s.pos.y, s.pos.z, s.yaw, 0);
    const bots = g.bots.bots;
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      b.alive = true;
      b.health = b.maxHealth;
      b.velocity.set(0, 0, 0);
      let fwdD, sideD;
      if (m === 'centre') { fwdD = 6 + (i % 4) * 3; sideD = ((i % 3) - 1) * 1.8; }
      else if (m === 'edge') { fwdD = 7 + (i % 3) * 2.5; sideD = (i % 2 ? 1 : -1) * (5.5 + (i % 4) * 0.8); }
      else { fwdD = -(5 + (i % 4) * 2); sideD = ((i % 3) - 1) * 2.2; }   // behind
      b.position.set(s.pos.x + f.x * fwdD + rx * sideD, s.pos.y, s.pos.z + f.z * fwdD + rz * sideD);
      b.yaw = s.yaw + Math.PI;
      b.pitch = 0;
      b.model?.setVisible(true);
      b.model?.update(1 / 60, b);
    }
  }, mode);

  for (const mode of ['centre', 'edge', 'behind']) {
    await placeBots(mode);
    // Hold the bots in place for a few frames — botManager.update() drives the model.
    await page.evaluate(async (m) => {
      const g = window.__GAME__;
      g.__hold = setInterval(() => {
        for (const b of g.bots.bots) { b.velocity.set(0, 0, 0); b.alive = true; }
      }, 16);
    }, mode);
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `bots-${mode}.png`) });
    out.bots[mode] = await page.evaluate(() => {
      const g = window.__GAME__;
      return {
        rig: window.__H.rigStats(),
        sceneTriangles: g.engine.stats.triangles,
        drawCalls: g.engine.stats.drawCalls,
      };
    });
    await page.evaluate(() => clearInterval(window.__GAME__.__hold));
  }
  console.log('[fill] bots', JSON.stringify(out.bots, null, 1));

  // A moving-bot sanity pass: unpause and let them run, then screenshot.
  await page.evaluate(() => window.__GAME__.setPaused(false));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, 'bots-live-play.png') });
  out.bots.livePlay = await page.evaluate(() => ({
    rig: window.__H.rigStats(),
    sceneTriangles: window.__GAME__.engine.stats.triangles,
    drawCalls: window.__GAME__.engine.stats.drawCalls,
    alive: window.__GAME__.bots.bots.filter((b) => b.alive).length,
  }));
} catch (err) {
  out.errors.push(`harness: ${err.message}\n${err.stack}`);
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}

await writeFile(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));
console.log('\n================ FILL PROBE (' + TAG + ') ================');
console.log(JSON.stringify({ gl: out.gl, fx: out.fx, decals: out.decals, bots: out.bots }, null, 1));
if (out.errors.length) {
  console.log(`\n${out.errors.length} error(s):`);
  for (const e of [...new Set(out.errors)].slice(0, 20)) console.log('  ! ' + e);
}
console.log(`\nscreenshots -> ${OUT}`);
