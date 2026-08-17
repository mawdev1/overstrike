/**
 * Dumps every texture in `assets.textures` to PNG + a content hash, so a
 * generation rewrite can be proven pixel-identical (or shown exactly where it drifts).
 * Usage: node _texdump.mjs --out=shots/tex-before
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const OUT = path.resolve(ROOT, arg('out', 'shots/tex'));
await mkdir(OUT, { recursive: true });

const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), server: { port: 5233, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.setDefaultTimeout(180000);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 100 });

const dump = await page.evaluate(async () => {
  const out = [];
  const A = window.__GAME__.assets;
  const all = [...A.textures, ['cloud', window.__GAME__.engine.cloudTex]];
  for (const [name, tex] of all) {
    const src = tex.image;
    const w = src.width, h = src.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    // FNV-1a over the raw pixels.
    let hsh = 0x811c9dc5;
    for (let i = 0; i < d.length; i++) { hsh ^= d[i]; hsh = Math.imul(hsh, 0x01000193) >>> 0; }
    out.push({ name, w, h, hash: hsh.toString(16).padStart(8, '0'), png: c.toDataURL('image/png') });
  }
  return out;
});

const index = {};
for (const t of dump) {
  index[t.name] = { w: t.w, h: t.h, hash: t.hash };
  await writeFile(path.join(OUT, `${t.name}.png`), Buffer.from(t.png.split(',')[1], 'base64'));
}
await writeFile(path.join(OUT, 'hashes.json'), JSON.stringify(index, null, 2));
console.log(`[texdump] ${dump.length} textures -> ${OUT}`);
for (const t of dump) console.log(`  ${t.name.padEnd(20)} ${t.w}x${t.h}  ${t.hash}`);

await browser.close();
await server.close();
