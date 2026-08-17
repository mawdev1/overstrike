import { Game } from './core/game.js';

const canvas = document.getElementById('game-canvas');
const boot = document.getElementById('boot');
const bootMsg = boot?.querySelector('.boot-msg');
const bootBar = boot?.querySelector('.boot-bar i');

const STEPS = 8;
let done = 0;

function progress(label) {
  done++;
  if (bootMsg) bootMsg.textContent = label;
  if (bootBar) bootBar.style.width = `${Math.min(100, (done / STEPS) * 100)}%`;
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
    window.__GAME__ = game; // exposed for automated smoke tests + debugging
    await game.init(progress);
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
