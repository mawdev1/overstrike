/**
 * OVERSTRIKE — shell key art.
 *
 * Every image here is decorative: it carries no information the surrounding text does not
 * already carry, so it is rendered with `alt=""` / `aria-hidden` and never becomes the only
 * way to learn something. Each art surface is a container with a scrim baked into the CSS
 * (see `shell.css`, "key art"), so contrast of the text over it does not depend on which
 * pixels the generator happened to produce.
 *
 * The loading art is chosen from the MAP THE HANDOFF NAMES, not from whatever the rotation
 * currently points at. That distinction is not academic — a shipped bug had the client
 * reading the rotation head while the server had already allocated a different map, so the
 * player watched the wrong map's loading screen. `loadingArt()` takes the handoff first and
 * only falls back to a loose map id when there is no handoff at all.
 */

export const HERO_ART = '/art/hero_welcome.jpg';
export const MENU_BACKDROP = '/art/menu_backdrop.jpg';

/** map-data.md ids. `square-extraction` is the raid map. */
export const MAP_ART = Object.freeze({
  'the-square': '/art/loading_square.jpg',
  meridian: '/art/loading_meridian.jpg',
  'square-extraction': '/art/loading_extraction.jpg',
});

/** Shown when the handoff names a map we have no art for — a new map must not render a hole. */
export const FALLBACK_LOADING_ART = '/art/loading_square.jpg';

export function artForMap(mapId) {
  const key = typeof mapId === 'string' ? mapId.trim() : '';
  return MAP_ART[key] || null;
}

/**
 * @param {object|null} handoff the authoritative match handoff (`handoff.mapId` wins)
 * @param {object|null} data the match-loading view data, used only when there is no handoff
 */
export function loadingArt(handoff, data = null) {
  return artForMap(handoff?.mapId)
    || artForMap(data?.mapId)
    || FALLBACK_LOADING_ART;
}

/**
 * A decorative art layer. `element()` is not used here because this file is imported by both
 * screens.js and the shell mount, and keeping it dependency-free makes it trivially testable.
 */
export function artLayer(src, { className = '', document: doc = globalThis.document } = {}) {
  if (!src || !doc) return null;
  const layer = doc.createElement('div');
  layer.className = `os-keyart ${className}`.trim();
  layer.dataset.art = src;
  layer.setAttribute('aria-hidden', 'true');
  const image = doc.createElement('img');
  image.src = src;
  image.alt = '';
  image.decoding = 'async';
  image.loading = 'lazy';
  image.className = 'os-keyart__image';
  layer.append(image);
  return layer;
}
