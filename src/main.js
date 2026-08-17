import { Game } from './core/game.js';

/**
 * Boot timeline, in ms from navigation start. Read by `scripts/` harnesses and by
 * `window.__BOOTPROF__` in devtools; costs four `performance.now()` calls.
 */
const PROF = (window.__BOOTPROF__ = {
  moduleEval: +performance.now().toFixed(1),
  bootPainted: 0, gameConstructed: 0, menu: 0, firstFrame: 0, phases: null,
});

requestAnimationFrame(() => { PROF.bootPainted = +performance.now().toFixed(1); });

const canvas = document.getElementById('game-canvas');
const boot = document.getElementById('boot');
const bootMsg = boot?.querySelector('.boot-msg');
const bootBar = boot?.querySelector('.boot-bar i');

/**
 * Progress the loading screen.
 *
 * `fraction` comes from `Game.init` and is honest: it counts the phases that actually
 * exist and advances *within* the long ones as they yield, rather than a step counter
 * that had to be kept in sync with `game.js` by hand and jumped in eighths.
 */
let shown = 0;
function progress(label, fraction) {
  if (bootMsg && bootMsg.textContent !== label) bootMsg.textContent = label;
  // Never let the bar go backwards — a phase that finishes early would otherwise
  // rewind it when the next one reports its opening 0.
  const pct = Math.min(100, Math.max(shown, fraction * 100));
  if (pct > shown && bootBar) bootBar.style.width = `${pct}%`;
  shown = pct;
}

function fatal(err) {
  console.error(err);
  if (!boot) return;
  boot.classList.add('failed');
  boot.innerHTML = `
    <div class="boot-logo">OVERSTRIKE</div>
    <div class="boot-error">
      <strong>Failed to start.</strong>
      <pre>${String(err && err.stack ? err.stack : err).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>
      <p>WebGL 2 and a desktop-class GPU are required.</p>
    </div>`;
}

async function boot_() {
  try {
    const game = new Game(canvas);
    PROF.gameConstructed = +performance.now().toFixed(1);
    window.__GAME__ = game; // exposed for automated smoke tests + debugging
    // Hand the browser a frame before boot starts. Parsing the bundle already ran to
    // completion inside the first task, so without this the loading screen's first
    // painted state is whatever it looks like *after* the renderer is up.
    progress('initialising', 0);
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    await game.init(progress);
    PROF.menu = +performance.now().toFixed(1);
    PROF.phases = game.bootProfile.phases;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      PROF.firstFrame = +performance.now().toFixed(1);
    }));
    if (bootBar) bootBar.style.width = '100%';
    boot?.classList.add('done');
    setTimeout(() => boot?.remove(), 700);
  } catch (err) {
    fatal(err);
  }
}

window.addEventListener('error', (e) => {
  if (!window.__GAME__) fatal(e.error || e.message);
});

boot_();
