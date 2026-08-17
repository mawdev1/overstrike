/**
 * Shared boot/teardown for the audit probes (scripts/audit*.mjs).
 *
 * Every probe drives the real game through window.__GAME__ inside headless Chromium.
 * SwiftShader rasterises, so wall-clock FPS is meaningless — probes measure CPU sim
 * cost, renderer.info counters, object counts and heap.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function boot(opts = {}) {
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    // HMR and the file watcher are OFF on purpose: other engineers are editing `src/`
    // while these probes run, and a mid-run full reload destroys the page context
    // (and silently invalidates a long measurement).
    server: {
      port: opts.port ?? 0,
      strictPort: false,
      hmr: false,
      watch: null,
    },
    logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--mute-audio',
      // performance.memory is only exposed with precise memory info enabled.
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
      ...(opts.args ?? []),
    ],
  });
  const page = await browser.newPage({
    viewport: opts.viewport ?? { width: 800, height: 600 },
  });
  page.setDefaultTimeout(opts.timeout ?? 300000);

  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  if (opts.init) await page.addInitScript(opts.init);

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (opts.waitForGame !== false) {
    await page.waitForFunction(
      () => window.__GAME__ && window.__GAME__.state === 'menu',
      null,
      { timeout: opts.timeout ?? 300000, polling: 200 },
    );
  }

  return {
    page,
    errors,
    consoleErrors,
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

export function report(title, out) {
  console.log(`\n===== ${title} =====`);
  console.log(JSON.stringify(out, null, 1));
}

/** Pretty pass/fail table from a probe that returned { checks: [{name, pass, detail}] }. */
export function table(out) {
  if (!out?.checks) return 0;
  let pass = 0;
  for (const c of out.checks) {
    if (c.pass) pass++;
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  — ${c.detail}`);
  }
  console.log(`  ${pass}/${out.checks.length} checks passed`);
  return out.checks.length - pass;
}
