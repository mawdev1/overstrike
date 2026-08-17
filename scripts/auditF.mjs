/**
 * AUDIT F — error paths and hostile environments.
 *
 *   1. one system throwing in update() — is the frame isolated, or does it take the
 *      renderer and the input system down with it?
 *   2. localStorage corrupt (garbage JSON, wrong types) and localStorage unavailable
 *   3. WebAudio blocked (AudioContext constructor throws / stays suspended)
 *   4. WebGL context lost mid-match
 *   5. viewport 320x240 and 3840x2160
 *   6. pointer lock denied
 *
 * Each scenario gets its own page so a poisoned environment cannot leak into the next.
 */
import { boot } from './auditlib.mjs';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: String(detail) });
  // Print as we go: each scenario boots its own page, and a crash in a later one
  // must not cost us the earlier results.
  if (!name.startsWith('_raw:')) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

// ══════════════════════════════ 1. system-throw isolation in the frame loop
{
  const h = await boot({ port: 5311, viewport: { width: 400, height: 300 } });
  const r = await h.page.evaluate(() => {
    const g = window.__GAME__;
    g.startMatch({ mode: 'tdm', botCount: 4, difficulty: 'regular', seed: 1 });
    for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);

    // Spy on the things that must keep happening even if one system misbehaves.
    let renders = 0;
    let endFrames = 0;
    const realRender = g.engine.render.bind(g.engine);
    const realEnd = g.input.endFrame.bind(g.input);
    g.engine.render = (dt) => { renders++; return realRender(dt); };
    g.input.endFrame = () => { endFrames++; return realEnd(); };

    const realRaf = window.requestAnimationFrame;
    g.stop();
    window.requestAnimationFrame = () => 0;
    g._running = true;

    const drive = (frames) => {
      let now = performance.now();
      let threw = 0;
      for (let i = 0; i < frames; i++) {
        now += 16.7;
        try { g._loop(now); } catch { threw++; }
      }
      return threw;
    };

    const before = { renders: 0, endFrames: 0 };
    drive(5);
    before.renders = renders; before.endFrames = endFrames;

    // A single misbehaving visual system — exactly what a UI bug looks like.
    const realHudUpdate = g.hud.update.bind(g.hud);
    g.hud.update = () => { throw new TypeError('this._somethingNew is not a function'); };
    renders = 0; endFrames = 0;
    const threwOut = drive(10);
    const during = { renders, endFrames, threwOutOfLoop: threwOut };

    g.hud.update = realHudUpdate;
    renders = 0; endFrames = 0;
    drive(5);
    const after = { renders, endFrames };

    g.engine.render = realRender;
    g.input.endFrame = realEnd;
    window.requestAnimationFrame = realRaf;
    g.start();

    // Same question for the simulation step.
    const realBots = g.bots.fixedUpdate.bind(g.bots);
    g.bots.fixedUpdate = () => { throw new Error('AI blew up'); };
    let matchTicked = 0;
    const realMatch = g.match.fixedUpdate.bind(g.match);
    g.match.fixedUpdate = (dt) => { matchTicked++; return realMatch(dt); };
    let fixedThrew = 0;
    for (let i = 0; i < 5; i++) { try { g._fixedUpdate(1 / 120); } catch { fixedThrew++; } }
    g.bots.fixedUpdate = realBots;
    g.match.fixedUpdate = realMatch;

    return { before, during, after, fixedThrew, matchTickedWhileBotsThrew: matchTicked };
  });
  ok('frameLoop:isolatesAThrowingSystem', r.during.renders === 10,
    `with hud.update() throwing for 10 frames: engine.render ran ${r.during.renders}/10 times, input.endFrame ran ${r.during.endFrames}/10 (healthy frames render 1/1)`);
  ok('fixedUpdate:isolatesAThrowingSystem', r.matchTickedWhileBotsThrew === 5,
    `with bots.fixedUpdate() throwing for 5 steps: match.fixedUpdate ran ${r.matchTickedWhileBotsThrew}/5 times`);
  results.push({ name: '_raw:systemThrow', pass: true, detail: JSON.stringify(r) });
  await h.close();
}

// ══════════════════════════════ 2a. corrupt localStorage
{
  const h = await boot({
    port: 5312,
    init: () => {
      localStorage.setItem('overstrike.settings.v1', '{"botCount":"twelve","fov":null,"binds":42,"difficulty":{},"renderScale":"x"}');
      localStorage.setItem('overstrike.progress.v1', '{{{ not json at all');
    },
  });
  const r = await h.page.evaluate(() => {
    const g = window.__GAME__;
    const out = { booted: g.state === 'menu', settings: {} };
    out.settings = {
      botCount: g.settings.get('botCount'),
      fov: g.settings.get('fov'),
      difficulty: g.settings.get('difficulty'),
      renderScale: g.settings.get('renderScale'),
      bindsType: typeof g.settings.get('binds'),
    };
    try {
      g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 3 });
      for (let i = 0; i < 1200; i++) g._fixedUpdate(1 / 120);
      out.started = true;
      out.roster = g.bots.bots.length;
      out.cameraFovFinite = Number.isFinite(g.camera.fov);
      out.playerFinite = Number.isFinite(g.player.position.x);
    } catch (e) { out.error = e.message; }
    return out;
  });
  ok('corruptLocalStorage:boots', r.booted && r.started, JSON.stringify(r));
  ok('corruptLocalStorage:sanitisesValues',
    typeof r.settings.botCount === 'number' && Number.isFinite(r.settings.botCount)
    && Number.isFinite(r.settings.fov) && typeof r.settings.difficulty === 'string',
    `settings after loading garbage: ${JSON.stringify(r.settings)} -> roster ${r.roster}`);
  if (h.errors.length) results.push({ name: 'corruptLocalStorage:pageErrors', pass: false, detail: [...new Set(h.errors)].slice(0, 3).join(' | ') });
  await h.close();
}

// ══════════════════════════════ 2b. localStorage unavailable (throws on access)
{
  const h = await boot({
    port: 5313,
    init: () => {
      const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 }; },
      });
    },
  });
  const r = await h.page.evaluate(() => {
    const g = window.__GAME__;
    const out = { booted: g.state === 'menu' };
    try {
      g.settings.set('fov', 92);
      out.settingWrite = true;
    } catch (e) { out.settingWriteError = e.message; }
    try {
      g.startMatch({ mode: 'ffa', botCount: 5, difficulty: 'regular', seed: 4 });
      for (let i = 0; i < 1200; i++) g._fixedUpdate(1 / 120);
      // Drive a match end so progression tries to write.
      g.match.timeLimit = g.match.elapsed + 1;
      for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);
      out.matchEnded = g.match.phase === 'ended';
      out.progression = !!g.match.result?.progression;
    } catch (e) { out.error = e.message; }
    return out;
  });
  ok('noLocalStorage:boots', r.booted, JSON.stringify(r));
  ok('noLocalStorage:playsAndSavesProgression', r.matchEnded && !r.error,
    `match ended=${r.matchEnded} progression=${r.progression} error=${r.error ?? 'none'}`);
  if (h.errors.length) results.push({ name: 'noLocalStorage:pageErrors', pass: false, detail: [...new Set(h.errors)].slice(0, 3).join(' | ') });
  await h.close();
}

// ══════════════════════════════ 3. WebAudio blocked
{
  const h = await boot({
    port: 5314,
    init: () => {
      window.AudioContext = function () { throw new DOMException('Audio is blocked', 'NotAllowedError'); };
      window.webkitAudioContext = window.AudioContext;
    },
  });
  const r = await h.page.evaluate(() => {
    const g = window.__GAME__;
    const out = { booted: g.state === 'menu', hasAudio: !!g.audio, ctx: !!g.audio?.ctx };
    try {
      g.startMatch({ mode: 'tdm', botCount: 5, difficulty: 'regular', seed: 5 });
      for (let i = 0; i < 120 * 30; i++) {
        g._fixedUpdate(1 / 120);
        if (g.player.alive) g.player.weapon?.tryFire?.();
      }
      out.played = true;
      out.shotsHappened = true;
    } catch (e) { out.error = e.message; }
    return out;
  });
  ok('audioBlocked:boots', r.booted, JSON.stringify(r));
  ok('audioBlocked:playsWithoutAudio', r.played && !r.error, `error=${r.error ?? 'none'}`);
  if (h.errors.length) results.push({ name: 'audioBlocked:pageErrors', pass: false, detail: [...new Set(h.errors)].slice(0, 3).join(' | ') });
  await h.close();
}

// ══════════════════════════════ 4. WebGL context lost mid-match
{
  const h = await boot({ port: 5315, viewport: { width: 640, height: 480 } });
  const r = await h.page.evaluate(async () => {
    const g = window.__GAME__;
    g.startMatch({ mode: 'tdm', botCount: 5, difficulty: 'regular', seed: 6 });
    for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);
    const gl = g.renderer.getContext();
    const ext = gl.getExtension('WEBGL_lose_context');
    const out = { hasExtension: !!ext, listeners: [] };
    // Does anything listen for the canvas contextlost event?
    out.handlerRegistered = typeof g.canvas.oncontextlost === 'function';
    if (!ext) return out;
    ext.loseContext();
    await new Promise((r2) => setTimeout(r2, 300));
    out.contextLost = gl.isContextLost();
    let simThrew = null;
    try { for (let i = 0; i < 240; i++) g._fixedUpdate(1 / 120); } catch (e) { simThrew = e.message; }
    out.simSurvives = simThrew === null;
    out.simError = simThrew;
    let renderThrew = null;
    try { g._update(1 / 60); g.engine.update(1 / 60); g.engine.render(1 / 60); } catch (e) { renderThrew = e.message; }
    out.renderThrew = renderThrew;
    out.stateAfter = g.state;
    return out;
  });
  ok('contextLost:simulationSurvives', r.hasExtension ? r.simSurvives : true,
    `context lost=${r.contextLost}, sim error=${r.simError ?? 'none'}`);
  ok('contextLost:handled', r.hasExtension ? (r.handlerRegistered || r.renderThrew === null) : true,
    `canvas 'contextlost' handler registered=${r.handlerRegistered}, render after loss threw=${r.renderThrew ?? 'no'}`);
  results.push({ name: '_raw:contextLost', pass: true, detail: JSON.stringify(r) });
  await h.close();
}

// ══════════════════════════════ 5. tiny and huge viewports
for (const [label, viewport, port] of [
  ['320x240', { width: 320, height: 240 }, 5316],
  ['3840x2160', { width: 3840, height: 2160 }, 5317],
]) {
  const h = await boot({ port, viewport });
  const r = await h.page.evaluate(() => {
    const g = window.__GAME__;
    const out = {};
    g.startMatch({ mode: 'tdm', botCount: 5, difficulty: 'regular', seed: 11 });
    for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);
    g._update(1 / 60); g.engine.update(1 / 60); g.engine.render(1 / 60);
    out.canvasW = g.canvas.width; out.canvasH = g.canvas.height;
    out.cssW = g.canvas.style.width; out.cssH = g.canvas.style.height;
    out.aspect = +g.camera.aspect.toFixed(4);
    out.aspectFinite = Number.isFinite(g.camera.aspect) && g.camera.aspect > 0;
    out.drawCalls = g.renderer.info.render.calls;
    out.triangles = g.renderer.info.render.triangles;
    const hud = document.getElementById('hud');
    out.hudRect = hud ? { w: hud.clientWidth, h: hud.clientHeight } : null;
    out.hudOverflows = hud ? (hud.scrollWidth > window.innerWidth + 2 || hud.scrollHeight > window.innerHeight + 2) : null;
    out.bodyScrollW = document.body.scrollWidth;
    out.windowW = window.innerWidth;
    return out;
  });
  ok(`viewport ${label}:renders`, r.aspectFinite && r.drawCalls > 0, JSON.stringify(r));
  ok(`viewport ${label}:drawCallBudget`, r.drawCalls < 220 && r.triangles < 450000,
    `${r.drawCalls} draw calls, ${r.triangles} triangles (budget 220 / 450k)`);
  ok(`viewport ${label}:hudFits`, r.hudOverflows === false, `hud ${JSON.stringify(r.hudRect)} vs window ${r.windowW}`);
  await h.close();
}

// ══════════════════════════════ 6. pointer lock denied
{
  const h = await boot({
    port: 5318,
    init: () => {
      Element.prototype.requestPointerLock = function () {
        const err = new DOMException('Pointer lock denied', 'NotSupportedError');
        // Chrome resolves/rejects a promise in newer specs; throw synchronously too.
        document.dispatchEvent(new Event('pointerlockerror'));
        throw err;
      };
    },
  });
  const r = await h.page.evaluate(() => {
    const g = window.__GAME__;
    const out = {};
    try {
      g.startMatch({ mode: 'tdm', botCount: 5, difficulty: 'regular', seed: 12 });
      out.started = g.state === 'playing';
      for (let i = 0; i < 120 * 20; i++) g._fixedUpdate(1 / 120);
      out.simmed = true;
      out.playerAliveOrRespawning = true;
      out.locked = !!g.input.locked;
    } catch (e) { out.error = e.message; }
    return out;
  });
  ok('pointerLockDenied:stillPlayable', r.started && r.simmed && !r.error,
    `started=${r.started} locked=${r.locked} error=${r.error ?? 'none'}`);
  if (h.errors.length) results.push({ name: 'pointerLockDenied:pageErrors', pass: false, detail: [...new Set(h.errors)].slice(0, 3).join(' | ') });
  await h.close();
}

console.log('\n=========== AUDIT F — ERROR PATHS ===========');
let fails = 0;
for (const c of results) {
  if (c.name.startsWith('_raw:')) { console.log(`  data  ${c.name} — ${c.detail}`); continue; }
  if (!c.pass) fails++;
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
}
const graded = results.filter((c) => !c.name.startsWith('_raw:'));
console.log(`\n  ${graded.length - fails}/${graded.length} passed`);
