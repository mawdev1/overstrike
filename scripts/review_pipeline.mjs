/**
 * THROWAWAY REVIEW PROBE — verifies engine.js post-chain claims on a real GPU.
 * Safe to delete. Prefix `review_` per reviewer instructions.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = {};
let server, browser;

try {
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 5187, strictPort: false },
    logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log('[probe] server', url);

  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle', '--use-angle=d3d11', '--enable-gpu',
      '--ignore-gpu-blocklist', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,720',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(120000);
  const logs = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state === 'menu', null, { timeout: 120000 });

  // ---- start a match
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' }));
  await page.waitForFunction(() => window.__GAME__.state === 'playing', null, { timeout: 60000 });
  await page.waitForTimeout(2500);

  out.gl = await page.evaluate(() => {
    const g = window.__GAME__;
    const e = g.engine;
    const gl = e.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
      isWebGL2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      colorBufferFloatExt: !!gl.getExtension('EXT_color_buffer_float'),
      glErrorAfterFrames: gl.getError(),
    };
  });

  // ---- CLAIM 1: shader composition
  out.claim1 = await page.evaluate(() => {
    const e = window.__GAME__.engine;
    const gl = e.renderer.getContext();
    const mat = e.compositePass.material;
    const props = e.renderer.properties.get(mat);
    const prog = props.currentProgram || props.programs?.values?.().next?.().value;
    let frag = null;
    if (prog && prog.fragmentShader) {
      try { frag = gl.getShaderSource(prog.fragmentShader); } catch (_) {}
    }
    if (typeof frag !== 'string' && prog && prog.program) {
      const shaders = gl.getAttachedShaders(prog.program) || [];
      for (const s of shaders) {
        if (gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER) frag = gl.getShaderSource(s);
      }
    }
    if (typeof frag !== 'string') frag = null;
    const count = (re) => (frag ? (frag.match(re) || []).length : -1);
    return {
      gotSource: !!frag,
      toneMappedFlag: mat.toneMapped,
      // definition of the ACES function (body), not call sites
      acesDefs: count(/vec3\s+ACESFilmicToneMapping\s*\(\s*vec3/g),
      acesCalls: count(/ACESFilmicToneMapping\s*\(/g),
      linearToOutputTexelDefs: count(/vec4\s+linearToOutputTexel\s*\(/g),
      toneMappingFnDefs: count(/vec3\s+toneMapping\s*\(\s*vec3/g),
      toneMappingMacro: frag ? /#define\s+TONE_MAPPING/.test(frag) : null,
      sRGBTransferPresent: frag ? /sRGBTransferOETF/.test(frag) : null,
      toneMappingExposureDecls: count(/uniform\s+float\s+toneMappingExposure/g),
      programCount: e.renderer.info.programs.length,
      uBloom: e.compositePass.uniforms.uBloom.value,
      tBloomBound: !!e.compositePass.uniforms.tBloom.value,
      exposureUniform: e.compositePass.uniforms.toneMappingExposure.value,
      rendererExposure: e.renderer.toneMappingExposure,
    };
  });

  // ---- CLAIM 2: HDR buffer formats
  out.claim2 = await page.evaluate(() => {
    const THREE = window.__GAME__.THREE || null;
    const e = window.__GAME__.engine;
    const gl = e.renderer.getContext();
    const desc = (rt, name) => {
      const t = rt.texture;
      const p = e.renderer.properties.get(t);
      let internal = null, redBits = null, greenBits = null, blueBits = null, alphaBits = null;
      try {
        const props = e.renderer.properties.get(rt);
        const fb = props.__webglFramebuffer;
        const target = Array.isArray(fb) ? fb[0] : fb;
        const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target);
        internal = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
          gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE);
        redBits = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_RED_SIZE);
        greenBits = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE);
        blueBits = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE);
        alphaBits = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
        return { name, format: t.format, type: t.type, internalFormat: t.internalFormat,
          hasGpuTex: !!p.__webglTexture, redBits, greenBits, blueBits, alphaBits,
          complete: status === gl.FRAMEBUFFER_COMPLETE, status, uploaded: !!p.__webglTexture };
      } catch (err) {
        return { name, error: String(err) };
      }
    };
    const c = e.composer;
    const res = [desc(c.renderTarget1, 'rt1'), desc(c.renderTarget2, 'rt2')];
    const b = e.bloomPass;
    res.push(desc(b.renderTargetBright, 'bloomBright'));
    b.renderTargetsHorizontal.forEach((t, i) => res.push(desc(t, 'bloomH' + i)));
    return { targets: res, glError: gl.getError() };
  });

  // ---- CLAIM 4: SSAO depth textures — sample over many frames
  out.claim4 = await page.evaluate(async () => {
    const e = window.__GAME__.engine;
    const seen = [];
    const origRender = e.aoPass.render.bind(e.aoPass);
    let frames = 0;
    e.aoPass.render = function (renderer, wb, rb) {
      seen.push({
        readIsRt1: rb === e.composer.renderTarget1,
        hasDepth: !!rb.depthTexture,
        depthIsShared: e.composer.renderTarget1.depthTexture === e.composer.renderTarget2.depthTexture,
        depthSrcShared: !!(e.composer.renderTarget1.depthTexture && e.composer.renderTarget2.depthTexture)
          && e.composer.renderTarget1.depthTexture.source === e.composer.renderTarget2.depthTexture.source,
        depthW: rb.depthTexture?.image?.width, rtW: rb.width,
      });
      frames++;
      return origRender(renderer, wb, rb);
    };
    await new Promise((r) => setTimeout(r, 1200));
    e.aoPass.render = origRender;
    const bailed = seen.filter((s) => !s.hasDepth).length;
    const mismatched = seen.filter((s) => s.depthW !== s.rtW).length;
    return {
      framesObserved: seen.length,
      framesWithoutDepth: bailed,
      framesSizeMismatch: mismatched,
      sharedDepthInstance: seen[0]?.depthIsShared,
      sharedDepthSource: seen[0]?.depthSrcShared,
      distinctReadBuffers: new Set(seen.map((s) => s.readIsRt1)).size,
      first: seen[0], last: seen[seen.length - 1],
    };
  });

  // ---- CLAIM 4b: resize actually reallocates (REAL viewport change)
  const snapSizes = () => page.evaluate(() => {
    const e = window.__GAME__.engine;
    const gl = e.renderer.getContext();
    const d1 = e.composer.renderTarget1.depthTexture;
    const d2 = e.composer.renderTarget2.depthTexture;
    return {
      rt1: [e.composer.renderTarget1.width, e.composer.renderTarget1.height],
      d1: [d1.image.width, d1.image.height],
      d2: [d2.image.width, d2.image.height],
      aoTarget: [e.aoPass.aoTarget.width, e.aoPass.aoTarget.height],
      aoRes: e.aoPass.aoMaterial.uniforms.uResolution.value.toArray(),
      uRes: e.compositePass.uniforms.uResolution.value.toArray(),
      d1Uploaded: !!e.renderer.properties.get(d1).__webglTexture,
      aoWarned: !!e.aoPass._warnedNoDepth,
      glError: gl.getError(),
    };
  });
  const beforeResize = await snapSizes();
  await page.setViewportSize({ width: 900, height: 620 });
  await page.waitForTimeout(900);
  const afterShrink = await snapSizes();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(900);
  const afterGrow = await snapSizes();
  // AO must still be alive after resizes
  const aoAlive = await page.evaluate(async () => {
    const e = window.__GAME__.engine;
    let ok = 0, bad = 0;
    const orig = e.aoPass.render.bind(e.aoPass);
    e.aoPass.render = function (r, w, rb) {
      if (rb.depthTexture && rb.depthTexture.image.width === rb.width) ok++; else bad++;
      return orig(r, w, rb);
    };
    await new Promise((r) => setTimeout(r, 900));
    e.aoPass.render = orig;
    return { ok, bad };
  });
  out.claim4b = { beforeResize, afterShrink, afterGrow, aoAliveAfterResize: aoAlive };

  // ---- CLAIM 3: far-plane clipping survey
  out.claim3 = await page.evaluate(() => {
    const e = window.__GAME__.engine;
    const cam = e.camera;
    const camPos = cam.getWorldPosition(new (cam.position.constructor)());
    let maxD = 0, maxName = null, beyond = [];
    const p = new (cam.position.constructor)();
    e.scene.traverse((o) => {
      if (o === e.sky) return;
      if (!o.visible) return;
      o.getWorldPosition(p);
      const d = p.distanceTo(camPos);
      let radius = 0;
      if (o.geometry) {
        if (!o.geometry.boundingSphere) { try { o.geometry.computeBoundingSphere(); } catch (_) {} }
        radius = o.geometry.boundingSphere ? o.geometry.boundingSphere.radius * Math.max(o.scale.x, o.scale.y, o.scale.z) : 0;
      }
      const far = d + radius;
      if (far > maxD) { maxD = far; maxName = o.name || o.type; }
      if (far > cam.far) beyond.push({ name: o.name || o.type, d: +d.toFixed(1), r: +radius.toFixed(1) });
    });
    return {
      near: cam.near, far: cam.far,
      viewCamNear: e.viewCamera.near, viewCamFar: e.viewCamera.far,
      skyRadius: e.sky.geometry.parameters?.radius,
      skyRenderOrder: e.sky.renderOrder,
      skyDepthTest: e.sky.material.depthTest,
      skyPosMatchesCam: e.sky.position.distanceTo(cam.position) < 1e-6,
      maxObjectExtent: +maxD.toFixed(1), maxName,
      beyondFar: beyond.slice(0, 12),
      worldBounds: window.__GAME__.world?.bounds,
      fogType: e.scene.fog?.type ?? e.scene.fog?.constructor?.name,
      fogDensity: e.scene.fog?.density,
    };
  });

  // ---- CLAIM 10: light counts constant through a firefight
  out.claim10 = await page.evaluate(async () => {
    const g = window.__GAME__;
    const e = g.engine;
    const counts = new Set();
    const progs = [];
    const t0 = performance.now();
    const sample = () => {
      let n = 0;
      e.scene.traverse((o) => { if (o.isPointLight) n++; });
      counts.add(n);
      progs.push(e.renderer.info.programs.length);
    };
    sample();
    // hammer the fx light pool
    for (let i = 0; i < 40; i++) {
      const p = g.player.position.clone();
      p.x += (Math.random() - 0.5) * 8; p.z += (Math.random() - 0.5) * 8; p.y += 1;
      g.fx?.explosion?.(p, 4);
      await new Promise((r) => requestAnimationFrame(r));
      sample();
    }
    await new Promise((r) => setTimeout(r, 1500));
    sample();
    const lights = g.fx?.lights || [];
    return {
      distinctPointLightCounts: [...counts],
      allVisible: lights.every((l) => l.visible === true),
      intensitiesAfterSettle: lights.map((l) => +l.intensity.toFixed(4)),
      programsStart: progs[0], programsEnd: progs[progs.length - 1],
      ms: +(performance.now() - t0).toFixed(0),
    };
  });

  // ---- CLAIM 1b: postFx toggle mid-match (stale bloom / uBloom)
  out.claim1b = await page.evaluate(async () => {
    const g = window.__GAME__;
    const e = g.engine;
    const snap = () => ({
      uBloom: e.compositePass.uniforms.uBloom.value,
      bloomEnabled: e.bloomPass.enabled,
      aoEnabled: e.aoPass.enabled,
      compositeEnabled: e.compositePass.enabled,
      uAberration: e.compositePass.uniforms.uAberration.value,
      tBloom: !!e.compositePass.uniforms.tBloom.value,
    });
    const before = snap();
    g.settings.set('postFx', false);
    await new Promise((r) => setTimeout(r, 400));
    const off = snap();
    g.settings.set('postFx', true);
    await new Promise((r) => setTimeout(r, 400));
    const on = snap();
    return { before, off, on };
  });

  // ---- CLAIM 9: soft particles / SOFT_PARTICLES define
  out.claim9 = await page.evaluate(() => {
    const g = window.__GAME__;
    const ps = g.fx?.particles;
    const order = ps?._order || [];
    return {
      softFlag: ps?._soft,
      groups: order.map((grp) => ({
        hasDefine: !!(grp.mat.defines && grp.mat.defines.SOFT_PARTICLES !== undefined),
        uDepth: !!grp.mat.uniforms.uDepth.value,
        uNearFar: grp.mat.uniforms.uNearFar.value.toArray(),
        uMaxSize: grp.mat.uniforms.uMaxSize.value,
        uInvRes: grp.mat.uniforms.uInvRes.value.toArray(),
      })),
      camNear: g.engine.camera.near, camFar: g.engine.camera.far,
      drawingBufferH: g.engine.renderer.getContext().drawingBufferHeight,
    };
  });

  // ---- context loss / restore rebuild
  out.contextLoss = await page.evaluate(async () => {
    const e = window.__GAME__.engine;
    const gl = e.renderer.getContext();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (!ext) return { skipped: 'no WEBGL_lose_context' };
    const beforeIds = {
      bloom: e.bloomPass.uuid ?? null,
      composite: e.compositePass.material.uuid,
      rt1: e.composer.renderTarget1.uuid,
    };
    // count live render targets three thinks it has
    const memBefore = { textures: e.renderer.info.memory.textures, geometries: e.renderer.info.memory.geometries };
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 400));
    const lost = e._contextLost;
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 2500));
    const memAfter = { textures: e.renderer.info.memory.textures, geometries: e.renderer.info.memory.geometries };
    return {
      lostFlagSet: lost,
      restored: e._contextLost === false,
      compositeMaterialReplaced: e.compositePass.material.uuid !== beforeIds.composite,
      rt1Replaced: e.composer.renderTarget1.uuid !== beforeIds.rt1,
      rt1HasDepth: !!e.composer.renderTarget1.depthTexture,
      rt2HasDepth: !!e.composer.renderTarget2.depthTexture,
      aoWarned: !!e.aoPass._warnedNoDepth,
      memBefore, memAfter,
      drawCalls: e.stats.drawCalls,
      glError: gl.getError(),
    };
  });

  await page.waitForTimeout(800);
  out.stats = await page.evaluate(() => ({ ...window.__GAME__.engine.stats }));
  out.logs = logs.filter((l) => /error|warn|GL_|INVALID|incomplete/i.test(l)).slice(0, 40);
} catch (err) {
  out.fatal = String(err && err.stack ? err.stack : err);
} finally {
  await browser?.close();
  await server?.close();
}

console.log(JSON.stringify(out, null, 2));
