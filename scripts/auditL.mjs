/**
 * AUDIT L — CPU simulation cost, measured on a quiet machine.
 *
 * Headless Chromium rasterises through SwiftShader, so rendered FPS is meaningless.
 * What IS meaningful is the cost of one fixed simulation step, because that is pure
 * CPU: at 120 Hz the whole frame budget is 8.33 ms, and a stalled frame can ask for
 * up to 6 substeps in a row.
 *
 * Run this alone — nothing else on the box — or the numbers are upper bounds.
 */
import { boot } from './auditlib.mjs';

const h = await boot({ port: 5371, viewport: { width: 640, height: 480 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const rows = [];
  const measure = (label, botCount, difficulty, steps) => {
    g.settings.set('botCount', botCount);
    g.startMatch({ mode: 'tdm', difficulty, seed: 900 + botCount });
    for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);   // countdown + settle
    // Warm up the JIT before timing.
    for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) g._fixedUpdate(1 / 120);
    const ms = (performance.now() - t0) / steps;
    rows.push({
      label, bots: g.bots.bots.length, difficulty,
      msPerFixedStep: +ms.toFixed(4),
      msPerFrameAt1Substep: +ms.toFixed(4),
      msPer6SubstepCatchUp: +(ms * 6).toFixed(3),
      pctOf120HzBudget: +((ms / 8.333) * 100).toFixed(1),
    });
    g.returnToMenu();
  };

  measure('idle-ish', 0, 'regular', 2400);
  measure('typical', 7, 'regular', 2400);
  measure('typical-veteran', 7, 'veteran', 2400);
  measure('busy', 12, 'veteran', 2400);
  measure('max roster', 24, 'veteran', 2400);

  // Render-side counters at the default viewport (SwiftShader draws them for real,
  // the counts are exact even though the timing is not).
  g.settings.set('botCount', 12);
  g.startMatch({ mode: 'tdm', difficulty: 'veteran', seed: 4242 });
  for (let i = 0; i < 900; i++) g._fixedUpdate(1 / 120);
  g._update(1 / 60); g.engine.update(1 / 60); g.engine.render(1 / 60);
  const info = g.renderer.info;
  const render = {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs?.length ?? 0,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    budget: { drawCalls: 220, triangles: 450000 },
  };
  return { rows, render };
});

console.log('\n=========== AUDIT L — SIM COST ===========');
console.log('scenario           bots  diff       ms/step   ms for a 6-substep catch-up   % of the 8.33 ms budget');
for (const r of out.rows) {
  console.log(
    `${r.label.padEnd(18)} ${String(r.bots).padStart(4)}  ${r.difficulty.padEnd(9)} ${String(r.msPerFixedStep).padStart(7)}   ${String(r.msPer6SubstepCatchUp).padStart(24)}   ${String(r.pctOf120HzBudget).padStart(6)}%`,
  );
}
console.log('\nrender counters (12 bots, 640x480):', JSON.stringify(out.render, null, 1));
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 8));

await h.close();
