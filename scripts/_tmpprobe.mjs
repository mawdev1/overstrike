import path from 'node:path';
import { startServer, launchBrowser, settingsInitScript } from './perflib.mjs';

const server = await startServer({ port: 5399, doBuild: false });
const browser = await launchBrowser({});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.addInitScript({ content: settingsInitScript() });
await page.goto(server.url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 300000, polling: 100 });

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const eng = g.engine;
  const comp = eng.composer;
  const probe = { calls: [] };
  const ao = eng.aoPass;
  const orig = ao.render.bind(ao);
  ao.render = function (renderer, writeBuffer, readBuffer) {
    if (probe.calls.length < 6) {
      probe.calls.push({
        hasDepth: !!(readBuffer && readBuffer.depthTexture),
        readIsRT2: readBuffer === comp.renderTarget2,
        readIsRT1: readBuffer === comp.renderTarget1,
        writeIsRT2: writeBuffer === comp.renderTarget2,
        enabled: ao.enabled,
        needsSwap: ao.needsSwap,
      });
    }
    return orig(renderer, writeBuffer, readBuffer);
  };
  g.startMatch({ mode: 'tdm', botCount: 4, difficulty: 'regular', seed: 1 });
  await new Promise((r) => setTimeout(r, 800));
  return {
    calls: probe.calls,
    rt1Depth: !!comp.renderTarget1.depthTexture,
    rt2Depth: !!comp.renderTarget2.depthTexture,
    rt1Size: [comp.renderTarget1.width, comp.renderTarget1.height],
    rt2Size: [comp.renderTarget2.width, comp.renderTarget2.height],
    passes: comp.passes.map((p, i) => ({
      i, enabled: p.enabled, needsSwap: p.needsSwap, renderToScreen: p.renderToScreen,
      isAO: p === eng.aoPass, isRender: p === eng.renderPass, isBloom: p === eng.bloomPass,
      isView: p === eng.viewPass, isOut: p === eng.outputPass, isComp: p === eng.compositePass,
    })),
    aoEnabled: eng.aoPass.enabled,
    postFx: g.settings.get('postFx'),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
await server.close();
