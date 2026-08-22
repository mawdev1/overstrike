import { projectRaidPresentation } from './model.js';
import { renderRaidHudHtml } from './view.js';

const RENDER_INTERVAL = 1 / 10;
const TRANSIENT_MS = 1_800;

/**
 * Mount adapter for the raid HUD, mirroring `createLocalBombHud`'s shape so `hud.js` hosts
 * both the same way. The mount's markup comes exclusively from `renderRaidHudHtml`, which
 * HTML-escapes every dynamic value — no caller-supplied HTML ever reaches it.
 *
 * The client-side extraction match runtime does not exist yet (P3-05/P3-07 are the streams
 * that will surface a live raid view to this tab), so activation is deliberately narrow: the
 * mount stays hidden unless the game is in an `extraction` match AND that match exposes a
 * `raidView()` sample in the documented v1 shape (`model.js`). Until then this is inert in
 * every shipped mode — the fixture-driven package (`fixtures.js` + `scripts/uiraid.mjs`) is
 * the tested surface, exactly how the Bomb HUD shipped ahead of its facade.
 */
export function createRaidHud({ game, root, document: documentRef = globalThis.document } = {}) {
  if (!root || !documentRef) throw new TypeError('Raid HUD requires a root and document.');
  const mount = documentRef.createElement('div');
  mount.className = 'raid-hud-mount';
  mount.hidden = true;
  root.appendChild(mount);

  let accumulator = RENDER_INTERVAL;
  let lastMarkup = '';
  let transient = null;
  let transientUntil = 0;
  const unsubs = [];
  const on = game?.bus?.on?.bind(game.bus);
  if (on) {
    // The raid runtime, when it lands, reports loot/channel outcomes on one bus topic in the
    // projection's own typed-event vocabulary (model.js): lootRefused / pickedUp / dropped /
    // containerOpened / exitCompleted / channelInterrupted.
    unsubs.push(on('raid', (row) => {
      transient = row && typeof row === 'object' ? row : null;
      transientUntil = performance.now() + TRANSIENT_MS;
      accumulator = RENDER_INTERVAL;
    }));
    unsubs.push(on('matchStart', () => { transient = null; lastMarkup = ''; accumulator = RENDER_INTERVAL; }));
    unsubs.push(on('toMenu', () => { transient = null; lastMarkup = ''; mount.hidden = true; }));
  }

  const update = (dt = RENDER_INTERVAL) => {
    const match = game?.match;
    const active = match?.modeId === 'extraction'
      && typeof match?.raidView === 'function'
      && ['playing', 'paused'].includes(game?.state);
    mount.hidden = !active;
    root.classList.toggle('raid-mode', active);
    if (!active) return null;
    accumulator += Math.max(0, Number(dt) || 0);
    if (accumulator < RENDER_INTERVAL) return null;
    accumulator %= RENDER_INTERVAL;
    const nowMs = performance.now();
    if (transientUntil && nowMs >= transientUntil) { transient = null; transientUntil = 0; }
    const runState = match.raidView();
    if (!runState) return null;
    const model = projectRaidPresentation({
      runState,
      nowMs,
      typedEvent: transient,
      bindings: {
        interact: game?.settings?.keyForAction?.('interact') || 'E',
        // §3.3 drop intent (extractionRules.js `drop`): rebindable via the 'drop' action.
        drop: game?.settings?.keyForAction?.('drop') || 'H',
      },
      preferences: {
        reduceMotion: game?.settings?.get?.('reduceMotion') === true,
        colorVisionPreset: game?.settings?.get?.('colorVisionPreset') || 'default',
        hudScaleFactor: (Number(game?.settings?.get?.('hudScale')) || 100) / 100,
      },
    });
    const markup = renderRaidHudHtml(model);
    if (markup !== lastMarkup) {
      lastMarkup = markup;
      mount.innerHTML = markup;
    }
    return model;
  };

  return Object.freeze({
    element: mount,
    update,
    reset() { transient = null; transientUntil = 0; lastMarkup = ''; accumulator = RENDER_INTERVAL; mount.innerHTML = ''; },
    destroy() { for (const off of unsubs) off?.(); mount.remove(); },
  });
}
