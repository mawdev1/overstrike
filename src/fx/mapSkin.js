import * as THREE from 'three';
import { assets, ATMOSPHERE } from '../core/assets.js';

/**
 * OVERSTRIKE — photographic map skins.
 *
 * Lives under `src/fx/` rather than `src/world/` because that is what it is: a
 * presentation layer over geometry someone else built. `docs/lane-ownership.json` agrees
 * — `src/fx/**` is CX, while `src/world/**` is CC apart from `level.js` and `props.js`.
 *
 * `core/assets.js` builds the whole material library procedurally at boot, and that
 * library stays the FLOOR: it is what the game renders with on a cold, offline or
 * failed load, and it is the only thing a headless server ever sees. This module is the
 * optional CEILING — a per-map-family set of authored JPEG albedo maps under
 * `public/textures/**` that is fetched *after* the level has already been built and
 * swapped onto the shared materials in place, one file at a time as each arrives.
 *
 * The consequences of that shape are the point:
 *
 *  • **Nothing blocks.** `applyMapSkin()` is fire-and-forget. The map is already on
 *    screen with its procedural materials before the first byte of a JPEG is requested;
 *    a texture that never arrives leaves that surface exactly as it was.
 *  • **Nothing is geometry.** A skin only ever writes `material.map` and
 *    `material.color`. No mesh, UV, collider or nav node is touched, so
 *    navbake/collision/geom output is byte-identical with or without it.
 *  • **Nothing runs headless.** Every entry point returns immediately unless there is a
 *    `document` and `assets.ready` is true. The sim imports this file transitively via
 *    `level.js` and must never notice it exists.
 *
 * ── UV density ────────────────────────────────────────────────────────────────────
 * There is nothing to do here. `props.js` projects world-space UVs at a constant
 * `UV = 0.5` repeats/metre for every static surface and bakes the same density into prop
 * templates, and `assets.tiled()` clones carry a per-mesh repeat for the big ground
 * zones. Because a skin only replaces the *image* behind an existing sampler — copying
 * `repeat`, `offset` and `wrap*` off the texture it displaces — texel density stays
 * whatever the geometry asked for. A 1024² source at 2 m per repeat is ~512 px/m.
 *
 * ── Seams ─────────────────────────────────────────────────────────────────────────
 * The generated sources are not tiling textures. Most carry a faint border vignette and
 * several are framed compositions (a hole punched through a wall, a road with its centre
 * line down the middle). Shipping those at 0.5 repeats/m would stamp a visible grid over
 * every wall in the map. Two loader-side fixes, declared per entry:
 *   • `crop` — take a sub-rectangle, which is how the vignettes and the framed
 *     compositions are dealt with. It is a crop, not a resize: detail is preserved.
 *   • `blend` — an offset-and-cross-fade wrap pass (see `makeSeamless`). Only for
 *     *organic* sources (sand, plaster, gravel, cracked mud) where smearing the seam is
 *     invisible. Structured sources — brick courses, plank runs, corrugation ribs — are
 *     left alone, because a cross-fade there would visibly bend the pattern; those tile
 *     acceptably on their own periodicity once cropped.
 *
 * ── Tiles vs the wall's own panels ────────────────────────────────────────────────
 * A seamless tile is not enough. Walls here are assemblies of rectangular panels carrying
 * world-space UVs, so adjacent panels land on different parts of the tile; any large-scale
 * brightness variation in the source therefore paints that panel grid onto the wall as a
 * checkerboard. `level` (see `applyLevel`) divides the source by its own 8x8 illumination
 * field, which removes that and leaves every course line and grain of aggregate intact.
 * `gain` (see `applyGain`) then buys back the brightness a structured — and therefore
 * darker — source costs, which `tint` alone cannot do because `tint` only multiplies down.
 */

/** `public/` is served at the site root, matching `botModel.js`'s `/textures/character/`. */
const BASE = '/textures/';

/** Loaded-and-processed albedo, keyed by `file|crop|blend|level|gain|size`. Shared across maps. */
const _texCache = new Map();
/** Per-repeat clones of a skin texture, keyed by `cacheKey|rx|ry|ox|oy`. */
const _repeatCache = new Map();
/** Equirect sky textures, keyed by file. */
const _skyCache = new Map();

/** Bumped by every `applyMapSkin` call; a stale in-flight load compares and bails. */
let _generation = 0;
let _activeSkin = null;

/** Set once from the renderer; 8 is three's own conservative default. */
let _maxAniso = 8;

// ─────────────────────────────────────────────────────────────────────── registry

/**
 * A skin entry is `{ file, crop, blend, level, gain, rep, tint, size }`.
 *
 * `crop`/`blend`/`level`/`gain` are image-processing steps baked into the one cached
 * upload (in that order); `rep`/`tint` are per-material and free.
 *
 * `tint` is the reason the maps still read the way they were balanced. The procedural
 * library carries its value structure in the albedo itself (`concrete` is a mid grey,
 * `concreteDark` is genuinely darker); the generated JPEGs are studio-lit swatches and
 * are almost all far brighter than the surface they replace. Multiplying by `tint`
 * restores the original value relationship — dark road beds stay darker than the walls,
 * shaded trim stays trim — so cover reads at a glance exactly as it did before.
 */
const DESERT = {
  // Walls. `concrete` and `plaster` are ~280 of the ~430 authored wall calls between
  // them, so these two textures ARE what The Crossing looks like — which is exactly why
  // the two files they used to point at were the wrong ones.
  //
  // `desert/adobe_wall.jpg` and `desert/sand_plaster.jpg` are near-empty studio swatches:
  // measured as stddev of the source's own luminance (border vignette excluded, so this
  // is content, not framing) they carry 6.0 and 2.2 levels of structure against 42.5 for
  // mudbrick, 25.5 for roof_gravel and 41.2 for cobble_dusty. Photographs of nothing. On
  // screen that showed up as the majority of the map's surface losing detail relative to
  // the PROCEDURAL material it replaced — Laplacian RMS on a wall at ~5 m fell 2.13 -> 1.19
  // with the skin on, i.e. the skin was a downgrade precisely where it mattered most.
  //
  // Both entries now point at sources with real structure, and at two DIFFERENT kinds of
  // it, because these two surfaces are interleaved all over the town and a single source
  // for both would read as one endless wall:
  //   • `concrete` — the structural walls — is mudbrick at a coarser scale than `brick`
  //     (`rep` 0.72 = ~31 cm courses vs ~22 cm), so the two share one GPU upload (same
  //     file, same crop, therefore same cache key) and still read as different masonry.
  //   • `plaster` — the rendered walls — is roof_gravel, whose interior is a uniform
  //     pitted aggregate field: the closest thing in the set to real mud render, organic
  //     enough for `blend`, and directionless so it never stripes a long wall.
  // Both keep their procedural normal/roughness maps; only albedo and tint change.
  concrete: { file: 'desert/mudbrick.jpg', crop: 0.03, rep: 0.72, tint: 0xeee4d2 },
  // 0.14, not the usual hairline inset: roof_gravel is framed by a band of coarse loose
  // gravel that is a different surface from the render inside it, and anything less left
  // that band tiling as a grid line every 2 m.
  //
  // `rep` 3.4 is the whole character of this entry. The source is shot close, so at the
  // world's 2 m per repeat its pits are 8-10 cm craters and the wall reads as pumice;
  // compressed to ~0.6 m per repeat they are the 2-3 cm pocking of a weathered mud
  // render, which is the surface this is standing in for. It does not go further: at
  // `rep` 4.5 the tile period gets short enough that the repeat itself becomes visible
  // as a faint lattice on a long wall (screenshotted at 34 m, both values).
  plaster: { file: 'desert/roof_gravel.jpg', crop: 0.14, blend: true, rep: 3.4, tint: 0xece3d0 },
  brick: { file: 'desert/mudbrick.jpg', crop: 0.03, tint: 0xd2c9bc },
  // Shells, plinths, parapets and trim — the darker structural family.
  concreteDark: { file: 'desert/concrete_desert.jpg', crop: { x: 0.24, y: 0.24, w: 0.52, h: 0.52 }, blend: true, tint: 0xa9a49a },
  // Ground.
  dirt: { file: 'desert/desert_ground.jpg', crop: 0.05, blend: true, tint: 0xbdb098 },
  tile: { file: 'desert/cobble_dusty.jpg', crop: 0.02, rep: 0.7, tint: 0xb6ada0 },
  // Road beds. The source frames a yellow centre line down the middle of the image, so
  // the crop takes the cracked-mud quadrant to the left of it and nothing else — and
  // `rep` pulls the crack scale down from "flagstones the size of a car" to sun-baked
  // road surface.
  asphalt: { file: 'desert/desert_road.jpg', crop: { x: 0.02, y: 0.03, w: 0.40, h: 0.40 }, blend: true, rep: 2.6, tint: 0x8f8b84 },
  // Corrugated sheet is the signature of this kind of town — shanty roofing, shutters,
  // container flanks — and it is what `metal` mostly is here.
  metal: { file: 'desert/corrugated_rust.jpg', crop: 0.03, tint: 0xa6a29a },
  metalRed: { file: 'desert/corrugated_rust.jpg', crop: 0.03, tint: 0x9c6a5c },
  metalGreen: { file: 'desert/corrugated_rust.jpg', crop: 0.03, tint: 0x6f8060 },
  // The source is a wide shot of five broad boards; at 1:1 a door became one plank.
  // `rep` puts a believable board width back, and the tint lifts it out of the near-black
  // the packed rmWood roughness/varnish map drags the photograph down to.
  wood: { file: 'desert/wood_weathered.jpg', crop: 0.03, rep: 1.8, tint: 0xffdcb2 },
};

const URBAN = {
  // Meridian's wall families, and the same lesson the desert set had to learn — arrived
  // at independently here because the urban sources fail in exactly the same way.
  //
  // `urban/plaster_city.jpg` is a framed composition: a blank rendered panel with all of
  // its interest in the broken plaster ring around the edge. The entry that used to be
  // here cropped the middle 48% — i.e. precisely the blank part — and measured, that crop
  // is mean 211.7 / sd 7.1 / Laplacian 8.2. A photograph of nothing, from the same
  // near-white low-structure family as the `desert/adobe_wall.jpg` the desert set
  // rejected. On screen it was worse than the case that got rejected: on a wall at 2.6-4.5 m
  // that raycasts 81/81 samples as `plaster`, Laplacian RMS went 6.41 (procedural) -> 1.99
  // (skin), a 0.31x collapse, with the mean drifting 10 levels dark and `blend`'s
  // cross-fade striping the source's panel structure at close range on top of it. This is
  // the map's largest wall family; it was the majority of what Meridian looked like.
  //
  // `urban/stone_block.jpg` is the one full-bleed, structured, neutral-grey wall source in
  // the set: mean 146.3, sd 27.3 (18.3% relative contrast, against plaster_city's 8.6%),
  // a running-bond course pattern with real aggregate mottling inside every block. It is
  // darker than the procedural plaster it replaces, which is what `gain` is for, and its
  // own illumination is uneven, which is what `level` is for — see both functions. No
  // `blend`: the courses are structured, and a cross-fade would bend them.
  //
  // Measured the same way after the change, same camera, same rect: 6.41 -> 13.71
  // (2.14x), mean 86.3 -> 88.9 (+2.6), and the wall now carries course lines and grain at
  // every range instead of nothing at any.
  concrete: { file: 'urban/concrete_panel.jpg', crop: 0.05, rep: 1.4, level: 0.85, tint: 0xc4c4c0 },
  plaster: { file: 'urban/stone_block.jpg', crop: 0.02, rep: 1.35, level: 1, gain: 1.25, tint: 0xf2ece0 },
  brick: { file: 'urban/brick_red.jpg', crop: 0.03, tint: 0xc2b9b0 },
  // Shares plaster's file, crop, level AND gain — therefore its cache key and its single
  // GPU upload — and separates from it the way `desert`'s two mudbrick entries separate
  // from each other: a coarser course (`rep` 0.7 = ~41 cm blocks against plaster's ~21 cm)
  // at roughly half the value. Trim reads as trim; nothing reads as one endless wall.
  concreteDark: { file: 'urban/stone_block.jpg', crop: 0.02, rep: 0.7, level: 1, gain: 1.25, tint: 0x908e8a },
  dirt: { file: 'urban/sidewalk_pavers.jpg', crop: 0.02, tint: 0xc0c0be },
  tile: { file: 'urban/tile_market.jpg', crop: 0.02, rep: 0.8, tint: 0x9d9890 },
  asphalt: { file: 'urban/asphalt_city.jpg', crop: { x: 0.02, y: 0.06, w: 0.30, h: 0.30 }, blend: true, tint: 0xd0d0d0 },
  metal: { file: 'urban/metal_deck.jpg', crop: 0.03, tint: 0xb8bac0 },
  metalRed: { file: 'urban/metal_shutter.jpg', crop: 0.03, tint: 0xb06052 },
  metalGreen: { file: 'urban/metal_shutter.jpg', crop: 0.03, tint: 0x8fb098 },
  wood: { file: 'urban/wood_market.jpg', crop: 0.03, rep: 1.6, tint: 0xe4ddd2 },
};

/**
 * The Square's district embedded in an extraction shell: the desert set, with the two
 * industrial sectors (rail yard, east docks) in mind. Those sectors are almost entirely
 * `metal` and `concreteDark`, so swapping just those two entries to the urban/industrial
 * sources leans them the right way without touching the town.
 */
const DESERT_INDUSTRIAL = {
  ...DESERT,
  metal: { file: 'urban/metal_deck.jpg', crop: 0.03, tint: 0xb0b2b6 },
  metalRed: { file: 'desert/corrugated_rust.jpg', crop: 0.03, tint: 0x9c6a5c },
  metalGreen: { file: 'desert/corrugated_rust.jpg', crop: 0.03, tint: 0x6f8060 },
};

/**
 * `sky` is an equirectangular 2048x1024 panorama, mapped onto the engine's existing sky
 * dome (see `applySky`). `skyGain` is a linear multiplier applied after the sRGB decode:
 * the scene target is HDR and the composite tone-maps with ACES at 0.86 exposure, so a
 * straight 0..1 decode lands noticeably flat. `skyYaw` rotates the panorama in degrees
 * about +Y so its bright lobe lands on the azimuth the key light actually comes from.
 *
 * ── The sky has to agree with the lighting rig ────────────────────────────────────
 * `ATMOSPHERE.sunDir` is (0.63, 0.60, 0.34): azimuth 28.4°, elevation 40.0°. That is a
 * late-morning sun and the whole scene is lit like one — short crisp shadows, wall tops
 * fully lit, a bright fill on every upward face.
 *
 * `desert_dusk.jpg` is a true sunset panorama. Measured on the image itself, its bright
 * lobe sits at azimuth 357° and elevation 5°, its zenith is at luminance 51/255, and its
 * cos-weighted brightness varies 1.93x around the compass. Hanging that over this rig put
 * the sun 31° off in azimuth and 35° off in ELEVATION — no rotation can fix the second
 * one — and left half the compass rendering as near-black navy above a fully sunlit town.
 *
 * `desert_noon.jpg` was already in the asset set and unused. Same measurement: zenith
 * 129/255 (2.5x brighter overhead), azimuth variation 1.59x, and a high broad glow rather
 * than a disc sitting on the horizon — a sky that belongs over a 40° sun. Its own bright
 * lobe sits at azimuth 9.8°, so `skyYaw: 20` walks it round to 29.8° — 1.4° off the rig,
 * measured in the running game off the dome's own texture — and the brightest part of the
 * sky is now behind the sun instead of a quarter-turn away from it.
 *
 * Re-elevating the rig to the dusk panorama was the other way to make the two agree, and
 * it is rejected on purpose: `ATMOSPHERE.sunDir` is global, feeds the shadow camera and
 * every surface shader, and a 5° sun in a close-quarters map means map-long shadows and
 * a town lit from one side only. Changing the picture is presentation; changing the rig
 * is a gameplay-visibility change.
 */
export const MAP_SKINS = {
  'the-square': {
    materials: DESERT,
    sky: 'sky/desert_noon.jpg',
    // 1.35, not the dusk panorama's 2.2: this source is 2.5x brighter overhead to start
    // with, and the gain is what keeps the dome inside the same ACES exposure it was
    // balanced at rather than blowing the horizon to white.
    skyGain: 1.35,
    skyYaw: 20,
    // Haze retuned with the sky. The stock value is a cool blue-grey for the procedural
    // dome and the previous entry was golden-hour amber; under a high desert sun the air
    // is neither — it is pale, warm and sand-loaded, with the sun-facing side brighter.
    atmosphere: { fog: 0xc8c3b2, fogSun: 0xf2ecd6, fogDensity: 0.0050 },
  },
  'square-extraction': {
    materials: DESERT_INDUSTRIAL,
    sky: 'sky/desert_noon.jpg',
    skyGain: 1.3,
    skyYaw: 20,
    // The raid map is four times the area, so the same haze at the same density would
    // bury the rail yard; it is thinned rather than recoloured.
    atmosphere: { fog: 0xc8c3b2, fogSun: 0xf2ecd6, fogDensity: 0.0032 },
  },
  meridian: {
    materials: URBAN,
    sky: 'sky/city_overcast.jpg',
    skyGain: 1.9,
    atmosphere: { fog: 0xb5bcc4, fogSun: 0xd6dbe0, fogDensity: 0.0050 },
  },
};

/** The stock `ATMOSPHERE` values, captured before the first skin edits them. */
const _atmoDefault = {
  fog: ATMOSPHERE.fog.getHex(),
  fogSun: ATMOSPHERE.fogSun.getHex(),
  fogDensity: ATMOSPHERE.fogDensity,
};

/**
 * Retune aerial perspective to the sky the map is actually standing under.
 *
 * `ATMOSPHERE.fog` and `ATMOSPHERE.fogSun` are live `THREE.Color` instances handed
 * straight into every surface material's uniforms by `macroHook`, so mutating them in
 * place repaints the sun-tinted haze on every material in the scene with no recompile
 * and no material walk. `scene.fog.color` is a separate copy and has to be set too, and
 * the sky dome reads `uHaze` from the same shared instance.
 *
 * Presentation only, browser only, and always restorable — `null` puts the stock
 * daylight values back.
 */
function applyAtmosphere(game, a) {
  const v = a || _atmoDefault;
  ATMOSPHERE.fog.setHex(v.fog);
  ATMOSPHERE.fogSun.setHex(v.fogSun);
  ATMOSPHERE.fogDensity = v.fogDensity;
  const fog = game?.engine?.scene?.fog;
  if (fog) {
    fog.color.setHex(v.fog);
    if ('density' in fog) fog.density = v.fogDensity;
  }
}

/**
 * Decal atlas sources. `fx/decals.js` blits `assets.tex(name).image` into a 3x2 atlas at
 * `DecalSystem.init()`, so these are installed into the texture library BEFORE the atlas
 * is built and are picked up with no change to the decal system at all.
 *
 * The sources are dark marks on a white studio background with no alpha channel, so
 * `alphaFromLuminance` derives the cut from the image itself. `bullet_holes` is a single
 * spalled crater, `crack_web` a radial fracture star (which is what glass actually does),
 * `scorch_mark` a soot burst — the explosion decal.
 */
const DECAL_SKINS = [
  // `scale` shrinks the mark inside its 128 px cell, and it is not cosmetic: the decal
  // system's world size is fixed per surface, so a source that fills its frame becomes a
  // 30 cm crater for a 5.56 round. The photograph is a studio close-up; it has to be
  // stepped back down to the size the round actually makes.
  //
  // A low `gamma` on the crater is deliberate too. The spall interior is a LIGHT grey in
  // the source, and a steep curve would cut it out and leave a transparent ring with the
  // wall showing through the middle of the hole. At 0.85 the interior keeps partial alpha
  // and reads as freshly exposed material, which is what spall is.
  { name: 'bulletHole', file: 'decals/bullet_holes.jpg', gamma: 1.05, floor: 0.19, scale: 0.60, core: 0.075 },
  { name: 'bulletHoleGlass', file: 'decals/crack_web.jpg', gamma: 1.9, floor: 0.10, scale: 0.82 },
  { name: 'scorch', file: 'decals/scorch_mark.jpg', gamma: 1.2, floor: 0.05, scale: 0.94 },
];

// ───────────────────────────────────────────────────────────────────── environment

/** True only in a real browser with a built material library. */
function usable() {
  // Escape hatch. `__NO_MAP_SKIN__` forces the procedural library, which is both the
  // A/B control for judging a skin by screenshot and a one-line answer to "is this
  // rendering problem the textures?".
  if (typeof globalThis !== 'undefined' && globalThis.__NO_MAP_SKIN__) return false;
  return typeof document !== 'undefined'
    && typeof document.createElement === 'function'
    && assets.ready === true
    && assets.headless !== true;
}

/** Ask the renderer for its real anisotropy cap once; 1024² at 0.5 rep/m needs it. */
export function noteRenderer(renderer) {
  const cap = renderer?.capabilities?.getMaxAnisotropy?.();
  if (typeof cap === 'number' && cap > 0) _maxAniso = Math.min(16, cap);
}

// ────────────────────────────────────────────────────────────────── image pipeline

/**
 * Decode OFF the main thread wherever the browser allows it.
 *
 * `new Image()` decodes on the main thread no matter what `decoding = 'async'` claims once
 * the bitmap is actually touched (drawImage/texImage2D), so skinning a map used to land a
 * burst of full-size JPEG decodes inside world construction — measured as a visible stall
 * on join, and on a memory-tight machine a tab crash. `createImageBitmap` hands the decode
 * to the browser's worker pool and returns something the canvas and GL can consume
 * directly. Falls back to `Image` where it is unavailable (older Safari), because a slower
 * decode is still infinitely better than an unskinned map.
 */
function loadImage(url) {
  if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
    return fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`[mapSkin] ${res.status} for ${url}`);
        return res.blob();
      })
      .then((blob) => createImageBitmap(blob))
      .catch(() => loadImageElement(url));
  }
  return loadImageElement(url);
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`[mapSkin] failed to load ${url}`));
    img.src = url;
  });
}

/** `crop` as a number is a symmetric inset fraction; as an object it is an explicit rect. */
function cropRect(crop) {
  if (!crop) return { x: 0, y: 0, w: 1, h: 1 };
  if (typeof crop === 'number') return { x: crop, y: crop, w: 1 - crop * 2, h: 1 - crop * 2 };
  return crop;
}

/**
 * Offset-and-cross-fade a square canvas into something that wraps.
 *
 * Roll the image by half its width and height so the four former edges meet in the
 * middle, then paint the *original* back over the centre cross through a linear alpha
 * ramp. The old border discontinuity is now buried under a soft gradient and the new
 * border is the image's own interior, which matches itself by construction.
 *
 * This smears whatever crosses the seam, which is exactly why it is opt-in: it is
 * invisible on sand and plaster and unacceptable on brick courses.
 */
function makeSeamless(cv, feather = 0.16) {
  const n = cv.width;
  const out = document.createElement('canvas');
  out.width = out.height = n;
  const ctx = out.getContext('2d');
  const h = n >> 1;

  // Rolled copy: the four quadrants swapped diagonally.
  ctx.drawImage(cv, h, h, n - h, n - h, 0, 0, n - h, n - h);
  ctx.drawImage(cv, 0, h, h, n - h, n - h, 0, h, n - h);
  ctx.drawImage(cv, h, 0, n - h, h, 0, n - h, n - h, h);
  ctx.drawImage(cv, 0, 0, h, h, n - h, n - h, h, h);

  // The original, faded in across the centre cross to bury the rolled seam.
  const band = Math.max(8, Math.round(n * feather));
  const patch = document.createElement('canvas');
  patch.width = patch.height = n;
  const pctx = patch.getContext('2d');
  pctx.drawImage(cv, 0, 0);
  pctx.globalCompositeOperation = 'destination-in';

  const gx = pctx.createLinearGradient(h - band, 0, h + band, 0);
  gx.addColorStop(0, 'rgba(0,0,0,0)');
  gx.addColorStop(0.5, 'rgba(0,0,0,1)');
  gx.addColorStop(1, 'rgba(0,0,0,0)');
  pctx.fillStyle = gx;
  pctx.fillRect(0, 0, n, n);
  ctx.drawImage(patch, 0, 0);

  const patch2 = document.createElement('canvas');
  patch2.width = patch2.height = n;
  const p2 = patch2.getContext('2d');
  p2.drawImage(cv, 0, 0);
  p2.globalCompositeOperation = 'destination-in';
  const gy = p2.createLinearGradient(0, h - band, 0, h + band);
  gy.addColorStop(0, 'rgba(0,0,0,0)');
  gy.addColorStop(0.5, 'rgba(0,0,0,1)');
  gy.addColorStop(1, 'rgba(0,0,0,0)');
  p2.fillStyle = gy;
  p2.fillRect(0, 0, n, n);
  ctx.drawImage(patch2, 0, 0);

  return out;
}

/** The identity of a processed image: same key, same pixels, same GPU upload. */
function keyOf(entry) {
  return `${entry.file}|${JSON.stringify(entry.crop ?? 0)}|${entry.blend ? 1 : 0}|${entry.level || 0}|${entry.gain || 1}|${entry.size || 512}`;
}

/**
 * Scale the cropped image's encoded values by `gain`, in place.
 *
 * `tint` can only ever darken — it is a multiply against a colour channel that caps at
 * 1.0 — so a source that is DARKER than the procedural material it replaces has no way to
 * get back to the value the map was balanced at. That is not a hypothetical: the sources
 * with real surface structure are, as a family, the darker ones (the near-white swatches
 * are near-white precisely because they are photographs of nothing), so without this the
 * choice is "keep the detail and lose 25 levels of brightness" or "keep the brightness
 * and ship a flat slab".
 *
 * Applied on the 2D canvas, so it is baked into the single cached upload rather than
 * costing anything per material or per frame, and it is keyed into `keyOf` so a gained
 * and an ungained use of the same file stay separate images.
 *
 * Deliberately a gamma-space (encoded) scale, not a linear-light one: the calibration it
 * exists to serve is "what mean does this wall read at on screen", which is measured on
 * encoded pixels. Highlights clip, so it is only usable on sources with headroom — 1.25
 * on `stone_block` clips 1.3% of subpixels, 1.25 on `concrete_panel` would clip 63% and
 * flatten it into paper.
 */
/**
 * Divide out the source's own low-frequency brightness, keeping its micro detail.
 *
 * Every wall in these maps is built from rectangular panels, and `props.js` gives each
 * one world-space UVs — so neighbouring panels sample *different* parts of the tile. A
 * source that is uniformly detailed but unevenly LIT (one half of the photograph brighter
 * than the other) therefore paints the wall's own panel blocking as a light/dark
 * checkerboard, which is the single most obvious "this is a texture" tell in the game and
 * is exactly why the author's note on `desert/roof_gravel` prizes a field that is
 * "directionless so it never stripes a long wall".
 *
 * The fix is a flat-field correction, the same one a microscope or an astrophotograph
 * gets: build an 8x8 box average of the image, bilinearly expand it back to full size —
 * that is the illumination gradient and nothing else, since 8x8 cannot represent a block
 * course or a speck of aggregate — and divide the image by it, renormalised to the
 * image's own mean. Macro variation collapses; every crack, course line and grain of
 * aggregate is untouched, because none of it survives an 8x8 downsample to be divided by.
 *
 * `level` is the strength, 0..1, because full correction also flattens genuine large
 * features (a wall that really is grimier at the bottom), and some of that is worth
 * keeping.
 */
function applyLevel(cv, level) {
  const n = cv.width;
  const N = 8;
  const small = document.createElement('canvas');
  small.width = small.height = N;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(cv, 0, 0, N, N);

  // Bilinear expansion back to full size: the illumination field, and only that.
  const big = document.createElement('canvas');
  big.width = big.height = n;
  const bctx = big.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, n, n);

  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, n, n);
  const lf = bctx.getImageData(0, 0, n, n).data;
  const d = img.data;

  let mean = 0;
  for (let i = 0; i < lf.length; i += 4) mean += lf[i] * 0.2126 + lf[i + 1] * 0.7152 + lf[i + 2] * 0.0722;
  mean /= lf.length / 4;

  for (let i = 0; i < d.length; i += 4) {
    const l = lf[i] * 0.2126 + lf[i + 1] * 0.7152 + lf[i + 2] * 0.0722;
    // Guard a near-black low-frequency patch from exploding the ratio.
    const f = 1 + level * (mean / Math.max(8, l) - 1);
    d[i] = Math.min(255, d[i] * f);
    d[i + 1] = Math.min(255, d[i + 1] * f);
    d[i + 2] = Math.min(255, d[i + 2] * f);
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function applyGain(cv, gain) {
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const d = img.data;
  // 0..255*gain saturating, precomputed so the inner loop is a table lookup.
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.min(255, Math.round(i * gain));
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/** Fetch, crop, optionally de-seam, and wrap as an sRGB repeating texture. */
async function loadSkinTexture(entry) {
  /**
   * 512, not the source's 1024.
   *
   * The world tiles at 0.5 repeats/metre, so a 1024² source is 512 px/m — two to five
   * times the density anything in this game is ever viewed at, and 5.6 MB of VRAM per
   * texture once mips are counted. Halving it costs nothing visible even with the camera
   * pressed against a brick wall (verified by paired screenshots at both sizes) and takes
   * the skinned map from ~46 MB of albedo down to ~13 MB, which is the difference between
   * "fine on a desktop GPU" and "fine on the integrated part the perf budget targets".
   * The JPEGs stay 1024 on disk; the extra detail is thrown away at decode, so raising
   * this later is a one-line change.
   */
  const size = entry.size || 512;
  const key = keyOf(entry);
  let p = _texCache.get(key);
  if (p) return p;

  p = (async () => {
    const img = await loadImage(BASE + entry.file);
    const r = cropRect(entry.crop);
    let cv = document.createElement('canvas');
    cv.width = cv.height = size;
    cv.getContext('2d').drawImage(
      img,
      r.x * img.width, r.y * img.height, r.w * img.width, r.h * img.height,
      0, 0, size, size,
    );
    if (entry.level) applyLevel(cv, entry.level);
    if (entry.gain && entry.gain !== 1) applyGain(cv, entry.gain);
    if (entry.blend) cv = makeSeamless(cv);

    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = _maxAniso;
    t.needsUpdate = true;
    return t;
  })();
  // A 404 or a decode error must not poison the cache for a later retry.
  p.catch(() => _texCache.delete(key));
  _texCache.set(key, p);
  return p;
}

/**
 * One skin texture per distinct `(repeat, offset)` in use.
 *
 * This is the whole reason a 27 MB texture set does not become 27 MB per wall:
 * `assets.tiled()` hands every large ground zone its own material with its own cloned
 * sampler, but `Texture.clone()` shares the underlying image and GPU upload, so the N
 * clones here cost N tiny descriptors and exactly one texture in VRAM.
 */
const _unitRep = new THREE.Vector2(1, 1);
const _zero = new THREE.Vector2(0, 0);
const _scratchRep = new THREE.Vector2();

function repeatVariant(base, cacheKey, rep, off) {
  const k = `${cacheKey}|${rep.x}|${rep.y}|${off.x}|${off.y}`;
  let t = _repeatCache.get(k);
  if (t) return t;
  if (rep.x === 1 && rep.y === 1 && off.x === 0 && off.y === 0) {
    _repeatCache.set(k, base);
    return base;
  }
  t = base.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.copy(rep);
  t.offset.copy(off);
  t.needsUpdate = true;
  _repeatCache.set(k, t);
  return t;
}

// ──────────────────────────────────────────────────────────────────── application

/**
 * Every live material that draws surface `name`.
 *
 * Two sources, because neither alone is complete: `assets.materials` holds the library
 * plus every `tiled()` clone (and is what any material created *after* this point will
 * be cloned from), while the scene holds `props.js`'s private `vertexColors` clones,
 * which live in a module-local map this file cannot see. Walking the built world catches
 * anything that is actually on screen no matter who made it.
 */
function collectMaterials(root) {
  const bySurface = new Map();
  const seen = new Set();
  const add = (m) => {
    if (!m || seen.has(m)) return;
    seen.add(m);
    const s = m.userData?.surface;
    if (!s) return;
    let list = bySurface.get(s);
    if (!list) { list = []; bySurface.set(s, list); }
    list.push(m);
  };
  for (const m of assets.materials.values()) add(m);
  root?.traverse?.((o) => {
    const m = o.material;
    if (Array.isArray(m)) m.forEach(add); else add(m);
  });
  return bySurface;
}

/**
 * Pre-skin appearance of every material this module has touched.
 *
 * Deliberately NOT `material.userData`: `THREE.Material.copy()` deep-copies userData
 * through `JSON.parse(JSON.stringify(...))`, so a clone taken after a skin was applied
 * (`assets.tiled()`, `props.js`'s `vertexColorMat()`) would inherit a *JSON corpse* of
 * this record — the live `THREE.Texture` flattened to a plain object whose `repeat` is
 * the array `[1,1]`. `stash()` would then decline to overwrite it (it looks present),
 * and `applyEntryTo` would feed that array to `Texture.repeat.copy()`, leaving
 * `repeat.x/y === undefined` and the surface rendering black. A WeakMap keyed on the
 * material is invisible to the clone path and keyed to identity, which is what this
 * record actually means: it belongs to *that* material, never to a copy of it.
 */
const _skinOrig = new WeakMap();

/** Remember what a material looked like before any skin touched it. */
function stash(m) {
  let orig = _skinOrig.get(m);
  if (!orig) {
    orig = { map: m.map, color: m.color ? m.color.getHex() : 0xffffff };
    _skinOrig.set(m, orig);
  }
  return orig;
}

function applyEntryTo(mats, tex, cacheKey, entry) {
  for (const m of mats) {
    const orig = stash(m);
    // Density comes from whatever sampler this material already had — a `tiled()` clone
    // carries the ground zone's per-mesh repeat, the shared library material carries 1:1
    // world-projected UVs. Either way the skin inherits it and texel density is unchanged.
    const src = orig.map || m.map;
    const base = src ? src.repeat : _unitRep;
    const off = src ? src.offset : _zero;
    // `rep` is a per-entry texel-density trim, and it is the one number that decides
    // whether a source reads as the material it is meant to be. The world tiles at a
    // uniform 0.5 repeats/m, which assumes every texture depicts the same ~2 m of wall;
    // these photographs do not. A road shot framing four big slabs of cracked mud is
    // several metres of ground in one image, and at 1:1 it turns a lane into flagstones
    // the size of a car. Multiplying the inherited repeat scales the IMAGE only —
    // geometry, UVs and every other surface are untouched.
    const rep = entry.rep && entry.rep !== 1
      ? _scratchRep.set(base.x * entry.rep, base.y * entry.rep)
      : base;
    m.map = repeatVariant(tex, cacheKey, rep, off);
    if (m.color) m.color.setHex(entry.tint ?? 0xffffff);
    m.needsUpdate = true;
  }
}

/** Put every skinned material back on its procedural albedo. */
export function clearMapSkin(game, root) {
  _generation++;
  _activeSkin = null;
  if (!usable()) return;
  applyAtmosphere(game, null);
  for (const mats of collectMaterials(root).values()) {
    for (const m of mats) {
      const orig = _skinOrig.get(m);
      if (!orig) continue;
      m.map = orig.map;
      if (m.color) m.color.setHex(orig.color);
      m.needsUpdate = true;
    }
  }
}

/**
 * Skin a freshly built map. Fire-and-forget: returns a promise for tests, and nothing in
 * the game awaits it.
 *
 * @param {object} game  needs `game.engine` (for the sky dome + anisotropy cap) — may be absent
 * @param {THREE.Object3D} root  the built world group, walked for vertex-colour clones
 * @param {string} mapId
 */
export function applyMapSkin(game, root, mapId) {
  if (!usable()) return Promise.resolve(false);
  const skin = MAP_SKINS[mapId];
  if (!skin) return Promise.resolve(false);

  noteRenderer(game?.engine?.renderer);
  const gen = ++_generation;
  _activeSkin = mapId;

  // Atmosphere is free and instantaneous — no fetch — so it lands on the first frame
  // rather than whenever the network gets around to it.
  applyAtmosphere(game, skin.atmosphere);

  const bySurface = collectMaterials(root);
  const jobs = [];

  // Undo the previous skin wherever this one has nothing to say. Materials are shared
  // library objects that outlive a map, so without this a surface the desert set covers
  // and the urban set does not would arrive on Meridian still wearing adobe.
  for (const [name, mats] of bySurface) {
    if (skin.materials[name]) continue;
    for (const m of mats) {
      const orig = _skinOrig.get(m);
      if (!orig) continue;
      m.map = orig.map;
      if (m.color) m.color.setHex(orig.color);
      m.needsUpdate = true;
    }
  }

  for (const [name, entry] of Object.entries(skin.materials)) {
    const mats = bySurface.get(name);
    if (!mats || !mats.length) continue;
    const cacheKey = keyOf(entry);
    jobs.push(
      loadSkinTexture(entry)
        .then((tex) => {
          // A map swap while this was in flight: the materials are already someone
          // else's and writing now would paint the desert onto Meridian.
          if (gen !== _generation) return;
          applyEntryTo(mats, tex, cacheKey, entry);
        })
        // The whole point of the fallback: log and leave the procedural material alone.
        //
        // "Alone" has to mean the PROCEDURAL one, not "whatever is on it right now".
        // These materials are shared library objects that outlive a map, so after a map
        // switch the thing already on them is the previous map's skin — a failed fetch
        // here used to leave Meridian's biggest wall family wearing The Crossing's adobe
        // (verified by aborting the request: `plaster` came back holding the desert
        // canvas at tint 0xece3d0). Rolling back to `_skinOrig` makes the failure path
        // land on the floor this module promises rather than on the last map's ceiling.
        .catch((e) => {
          console.warn(`[mapSkin] ${name}: ${e.message}`);
          if (gen !== _generation) return;
          for (const m of mats) {
            const orig = _skinOrig.get(m);
            if (!orig) continue;
            m.map = orig.map;
            if (m.color) m.color.setHex(orig.color);
            m.needsUpdate = true;
          }
        }),
    );
  }

  if (skin.sky && game?.engine) jobs.push(applySky(game, skin.sky, skin.skyGain ?? 1.4, skin.skyYaw ?? 0, gen));

  return Promise.all(jobs).then(() => gen === _generation);
}

// ─────────────────────────────────────────────────────────────────────────── sky

/**
 * Repoint the engine's sky dome at an equirectangular photograph.
 *
 * The dome itself — its 250 m radius, its `renderOrder = 1000` "draw last, depth-tested,
 * never depth-writes" trick, its per-frame recentring on the camera — is engine geometry
 * and is left exactly as it is. Only the material is replaced, and only once the image
 * has decoded, so a failed fetch leaves the procedural sky shader running.
 *
 * The scene target is linear HDR (the composite pass owns ACES and the sRGB transfer),
 * so this decodes sRGB by hand and scales by `gain`; and it keeps the horizon haze mix
 * from the procedural sky, which is what stops distant geometry ending in a hard line
 * against the panorama instead of dissolving into it.
 */
/**
 * Make an equirectangular panorama wrap at its own left/right edges.
 *
 * The generated skies are photographs, not stitched panoramas: `desert_dusk.jpg`'s first
 * and last columns are unrelated pieces of cloud, so the dome carries a hard step in the
 * horizon silhouette at the wrap no matter how cleanly it is sampled — sampling only ever
 * fixed the mip collapse, not the content mismatch underneath it.
 *
 * `makeSeamless`'s roll-and-patch is deliberately NOT used here. On a wall texture it is
 * free, because every tile is interchangeable; on a sky it is not, because the sky has
 * one sun. Rolling by half a turn and painting the original back over the middle stamps
 * the source's centre columns onto the wrap azimuth, which put a second dusk sun in the
 * panorama — measured, not theorised (the azimuth sweep moved the bright lobe from 270
 * to 090).
 *
 * What is done instead is local and content-preserving: cross-fade each edge toward a
 * horizontally mirrored copy of the image over a narrow band, at a weight that reaches
 * exactly 0.5 in the last column and decays to 0 by `band`. A mirrored draw puts source
 * column w-1 at destination 0 and source column 0 at destination w-1, so both ends of the
 * wrap converge on the same 50/50 mix of the two mismatched columns and meet without a
 * step. Everything outside the band — 94% of the panorama, sun included — is untouched
 * source pixels at their original azimuth, so no shader-side rotation is needed and the
 * map's lighting rig still agrees with its sky.
 *
 * Latitude is left alone: `wrapT` is ClampToEdge and the poles are not sampled across.
 */
function wrapEquirect(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const band = Math.max(8, Math.round(w * 0.03));
  const patch = document.createElement('canvas');
  patch.width = w;
  patch.height = h;
  const p = patch.getContext('2d');
  // Mirrored copy: destination x reads source column w-1-x.
  p.translate(w, 0);
  p.scale(-1, 1);
  p.drawImage(img, 0, 0);
  p.setTransform(1, 0, 0, 1, 0, 0);

  // Keep it only in the two edge bands, topping out at half weight in the outermost column.
  p.globalCompositeOperation = 'destination-in';
  const g = p.createLinearGradient(0, 0, w, 0);
  const t = band / w;
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(t, 'rgba(0,0,0,0)');
  g.addColorStop(1 - t, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.5)');
  p.fillStyle = g;
  p.fillRect(0, 0, w, h);
  ctx.drawImage(patch, 0, 0);

  return cv;
}

async function applySky(game, file, gain, yaw, gen) {
  let p = _skyCache.get(file);
  if (!p) {
    p = (async () => {
      const img = await loadImage(BASE + file);
      const t = new THREE.Texture(wrapEquirect(img));
      t.colorSpace = THREE.SRGBColorSpace;
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = _maxAniso;
      t.needsUpdate = true;
      return t;
    })();
    p.catch(() => _skyCache.delete(file));
    _skyCache.set(file, p);
  }

  let tex;
  try {
    tex = await p;
  } catch (e) {
    console.warn(`[mapSkin] sky: ${e.message}`);
    return;
  }
  if (gen !== _generation) return;
  installSky(game, tex, gain, yaw);

  // A context-loss restore rebuilds the dome from scratch in `engine._buildSky()`, which
  // hands it the procedural material again. Put the photo back when that happens.
  if (!game.__skinSkyHook && game.bus?.on) {
    game.__skinSkyHook = true;
    game.bus.on('contextRestored', () => {
      const active = MAP_SKINS[_activeSkin];
      if (active?.sky) applySky(game, active.sky, active.skyGain ?? 1.4, active.skyYaw ?? 0, _generation);
    });
  }
}

function installSky(game, tex, gain, yaw) {
  const dome = game.engine?.sky;
  if (!dome) return;
  const prev = dome.material;
  if (prev?.userData?.skinSky) prev.dispose();

  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    fog: false,
    uniforms: {
      uSky: { value: tex },
      uGain: { value: gain },
      // Degrees -> turns. Positive yaw moves the panorama's content to a HIGHER
      // azimuth: the shader subtracts it from the sampled u, so the direction the sun
      // is in reads the column that used to sit `yaw` degrees clockwise of it.
      uYaw: { value: (yaw || 0) / 360 },
      uHaze: { value: ATMOSPHERE.fog },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D uSky;
      uniform float uGain;
      uniform float uYaw;
      uniform vec3 uHaze;
      varying vec3 vDir;

      void main() {
        vec3 d = normalize(vDir);
        // Equirect: longitude around Y, latitude from +Y. flipY is on for an <img>
        // texture, so image row 0 (the zenith) is at v = 1.
        vec2 uv = vec2(
          fract(atan(d.z, d.x) * 0.15915494 + 0.5 - uYaw),
          1.0 - acos(clamp(d.y, -1.0, 1.0)) * 0.31830989
        );

        // u jumps by a full turn across the +/-pi wrap, so the two pixels straddling it
        // report a screen-space derivative of ~1.0 instead of ~0.0005. An implicit-LOD
        // fetch reads that as "this quad covers the whole image", collapses to the top
        // mip and paints a bright vertical line from horizon to zenith. Take the
        // gradient from a second parameterisation whose own discontinuity is half a turn
        // away and keep whichever u-derivative is smaller: on the seam that is the
        // shifted one, everywhere else the two agree exactly.
        vec2 uvB = vec2(fract(uv.x + 0.5), uv.y);
        vec2 ddx = dFdx(uv), ddy = dFdy(uv);
        vec2 bx = dFdx(uvB), by = dFdy(uvB);
        if (abs(bx.x) < abs(ddx.x)) ddx.x = bx.x;
        if (abs(by.x) < abs(ddy.x)) ddy.x = by.x;
        vec3 col = texture2DGradEXT(uSky, uv, ddx, ddy).rgb;
        // sRGB -> linear by hand: a raw ShaderMaterial gets no decode injected for it.
        col = col * (col * (col * 0.305306011 + 0.682171111) + 0.012522878);
        col *= uGain;

        // Same horizon haze band the procedural dome carries, in the same fog colour,
        // so aerial perspective still resolves into the sky rather than stopping at it.
        col = mix(col, uHaze, smoothstep(0.085, -0.02, d.y) * 0.75);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  mat.userData.skinSky = true;
  dome.material = mat;
}

// ────────────────────────────────────────────────────────────────────────── decals

/**
 * Install the photographic decal sources into the texture library.
 *
 * Must be awaited (or at least started) BEFORE `DecalSystem.init()`, which blits
 * `assets.tex(name).image` into its atlas once and never looks again. Anything that has
 * not arrived by then simply stays procedural — the decal system needs no knowledge of
 * this at all.
 */
export async function loadDecalSkins() {
  if (!usable()) return false;
  let any = false;
  await Promise.all(DECAL_SKINS.map(async (d) => {
    try {
      const img = await loadImage(BASE + d.file);
      const cv = alphaFromLuminance(img, d);
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      const old = assets.textures.get(d.name);
      assets.textures.set(d.name, t);
      // Keep the procedural original reachable; nothing else references it by then.
      if (old) t.userData.replaced = old;
      any = true;
    } catch (e) {
      console.warn(`[mapSkin] decal ${d.name}: ${e.message}`);
    }
  }));
  return any;
}

/**
 * Turn a dark-mark-on-white-background JPEG into a straight alpha decal.
 *
 * The sources have no alpha channel, so the mark has to be cut out of the background:
 * alpha is `1 - luminance` raised to `gamma` (which pushes the near-white surround to
 * zero without eating the mark's soft edges), and the RGB is kept — a spall crater is
 * grey and brown, not black, and flattening it to a silhouette loses the thing.
 *
 * `floor` clips the residual haze the JPEG leaves across the background; without it the
 * whole 128 px atlas cell tints the wall behind it.
 */
function alphaFromLuminance(img, { gamma = 1.5, floor = 0.06, scale = 1, core = 0 } = {}) {
  const n = 128;   // the decal atlas cell size; anything larger is thrown away
  const cv = document.createElement('canvas');
  cv.width = cv.height = n;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  // Fill with the source's own background white first, so the region outside a scaled
  // mark reduces to alpha 0 by the same rule as the background inside it.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, n, n);
  const d0 = Math.round(n * scale);
  ctx.drawImage(img, (n - d0) / 2, (n - d0) / 2, d0, d0);

  // The dark entry wound, painted UNDER nothing and over everything: the source's crater
  // interior is a light spall face, so cutting the background out of it leaves a ring
  // with the wall showing through the middle of the hole.
  if (core > 0) {
    const gcore = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n * core * 1.8);
    gcore.addColorStop(0, 'rgba(9,9,11,1)');
    gcore.addColorStop(0.45, 'rgba(14,13,14,0.92)');
    gcore.addColorStop(1, 'rgba(30,28,28,0)');
    ctx.fillStyle = gcore;
    ctx.beginPath();
    ctx.arc(n / 2, n / 2, n * core * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  const id = ctx.getImageData(0, 0, n, n);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255;
    let a = Math.pow(Math.max(0, 1 - lum), gamma);
    a = a <= floor ? 0 : (a - floor) / (1 - floor);
    // Radial falloff to zero at the cell edge. The sources carry a faint JPEG vignette,
    // and without this the darkened border survives the threshold as a visible square
    // halo around every mark — and the atlas's no-mip-bleed contract depends on the
    // tile genuinely reaching alpha 0 at its border.
    const px = i >> 2;
    const dx = ((px % n) + 0.5) / n - 0.5;
    const dy = ((px / n | 0) + 0.5) / n - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) * 2;   // 0 at centre, 1 at the inscribed edge
    if (r > 0.80) a *= Math.max(0, (0.98 - r) / 0.18);
    d[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  // Force the border to zero alpha: the atlas packs six cells into one texture and
  // mip bleed between them is only invisible because every tile fades out at its edge.
  for (let x = 0; x < n; x++) {
    d[(x) * 4 + 3] = 0;
    d[((n - 1) * n + x) * 4 + 3] = 0;
    d[(x * n) * 4 + 3] = 0;
    d[(x * n + n - 1) * 4 + 3] = 0;
  }
  ctx.putImageData(id, 0, 0);
  return cv;
}

/** Test/diagnostic surface — what actually landed, readable from `page.evaluate`. */
export function skinReport(root) {
  const out = { mapId: _activeSkin, surfaces: {} };
  if (!usable()) return out;
  for (const [name, mats] of collectMaterials(root)) {
    const skinned = mats.filter((m) => {
      const orig = _skinOrig.get(m);
      return orig && m.map !== orig.map;
    });
    out.surfaces[name] = { total: mats.length, skinned: skinned.length };
  }
  return out;
}
