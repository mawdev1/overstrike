import * as THREE from 'three';
import { homeSiteOfTeam, resolveManifestCallout, sitesFromManifest } from './bomb/local.js';

/**
 * Minimap — canvas radar.
 *
 * The static level is baked ONCE into an offscreen canvas from `world.boxes`
 * (top-down footprints, tinted by height so cover reads differently from full
 * walls). Every frame we only blit that bake through a rotate/translate and
 * stamp a handful of dynamic markers, so the per-frame cost is one drawImage
 * plus a few dozen path ops.
 *
 * Contact rules follow the CoD radar convention: friendlies are always shown,
 * hostiles appear only when they FIRE (a decaying red blip seeded from the
 * `shot` event) or while they are in direct line of sight — unless a UAV is up
 * for your team (`match.uavActive(team)`), which paints every living hostile.
 */

const BAKE_PX = 768;           // offscreen bake resolution (square)
/**
 * Metres from the centre to the edge. The level is 86 × 86 m, so 30 m shows
 * roughly a third of the sector across — near enough to read a room, far enough
 * to see the lane you are about to walk into.
 */
const VIEW_RADIUS = 30;
const BLIP_SHOT_LIFE = 3.0;    // seconds a gunshot contact lingers
const BLIP_LOS_LIFE = 0.9;     // seconds a line-of-sight contact lingers
const LOS_CHECKS_PER_FRAME = 3;
const UAV_SWEEP_PERIOD = 2.6;  // seconds per radar sweep while a UAV is up

export class Minimap {
  /**
   * @param {object} game
   * @param {HTMLElement} root HUD child to mount into
   */
  constructor(game, root) {
    this.game = game;

    this.el = document.createElement('div');
    this.el.className = 'minimap';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 256;
    this.el.appendChild(this.canvas);

    const frame = document.createElement('div');
    frame.className = 'mm-frame';
    this.el.appendChild(frame);

    const tag = document.createElement('div');
    tag.className = 'mm-tag';
    tag.textContent = 'radar';
    this.el.appendChild(tag);
    this.tagEl = tag;

    const callout = document.createElement('div');
    callout.className = 'mm-callout';
    callout.textContent = 'LOCATION UNKNOWN';
    this.el.appendChild(callout);
    this.calloutEl = callout;

    root?.appendChild(this.el);

    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.baked = null;
    this.bakeInfo = null;

    /** @type {Map<number, {x:number,z:number,t:number,life:number}>} enemy contacts by entity id */
    this.contacts = new Map();
    this._losCursor = 0;
    this._pulse = 0;
    this._cssSize = 0;
    this._visible = true;
    this._orientation = 'playerUp';
    this._uav = false;
    this._callout = '';
    /** Manifest bomb sites, cached by `_bake()` for the planted-state emphasis. */
    this._sites = null;

    /**
     * Everything below is derived from the backing-store size and therefore only
     * changes on a resize. Rebuilding a gradient means building and uploading a
     * colour-ramp LUT, and assigning `ctx.font` means parsing a CSS font
     * shorthand — neither belongs in a path that runs 120 times a second.
     */
    this._coneGrad = null;
    this._sweepGrad = null;
    this._font = '';
    this._ro = null;
    this._bakeBoxes = -1;
    /** Banked frame time for draws we deliberately skipped (see `draw`). */
    this._skipDt = 0;
    this._deadTick = 0;

    this._onShot = this._onShot.bind(this);
    this._unsub = game?.bus?.on?.('shot', this._onShot) || null;

    // Explosions light up the map too — they are loud, so they are a contact.
    this._unsubBoom = game?.bus?.on?.('explosion', (p) => {
      if (this._bombSpectator()) { this.contacts.clear(); return; }
      if (!p?.point) return;
      this._addContact(-1 - (this.contacts.size % 8), p.point.x, p.point.z, 1.4);
    }) || null;
  }

  /* ------------------------------------------------------------- lifecycle */

  init() {
    // One layout read, at load, outside any frame that also writes style.
    this._measureOnce();
    this._observeSize();
    this.prewarm();
  }

  /**
   * Rasterise the static level layer up front.
   *
   * Left to itself `draw()` bakes lazily, which puts a full pass over every world
   * collider on the FIRST gameplay frame of a match — the worst frame to spend
   * anything on. This is idempotent and safe to call from a boot step or from a
   * loading screen; the lazy path in `draw()` stays as a fallback.
   * @returns {boolean} true once a bake exists
   */
  prewarm() {
    if (this.baked) return true;
    return this._bake();
  }

  /** Alias, for callers that read better as `bake()`. */
  bake() { return this.prewarm(); }

  reset() {
    this.contacts.clear();
    this._losCursor = 0;
    this._pulse = 0;
    this._skipDt = 0;
    this._deadTick = 0;
    if (this._uav) { this._uav = false; this.el.classList.remove('uav'); }
    this._callout = '';
    this._updateLabels();
    // The level is static today (`World.reset()` is a documented no-op), but if a
    // future rebuild ever changes the collider set we must not keep a stale bake.
    // Either way the work happens HERE — inside startMatch, alongside every other
    // system's reset — and never on the first frame the player sees.
    const boxes = this.game?.world?.boxes?.length ?? -1;
    if (!this.baked || boxes !== this._bakeBoxes) {
      this.baked = null;
      this.bakeInfo = null;
      this._bake();
    }
  }

  dispose() {
    this._unsub?.();
    this._unsubBoom?.();
    this._ro?.disconnect();
    this._ro = null;
    this._unsubResize?.();
    this.el.remove();
    this.baked = null;
  }

  setVisible(v) {
    if (this._visible === v) return;
    this._visible = v;
    this.el.classList.toggle('off', !v);
  }

  setOrientation(value) {
    this._orientation = value === 'northUp' ? 'northUp' : 'playerUp';
    this.el.dataset.orientation = this._orientation;
  }

  /* ------------------------------------------------------------- contacts */

  _onShot(p) {
    const shooter = p?.shooter;
    const me = this.game?.player;
    if (!shooter || !me) return;
    if (this._bombSpectator()) { this.contacts.clear(); return; }
    if (shooter === me || p.isPlayer) return;
    if (shooter.team === me.team) return;       // friendly fire is not a contact
    const pos = p.origin ?? shooter.position;
    if (!pos) return;
    this._addContact(shooter.id ?? -1, pos.x, pos.z, BLIP_SHOT_LIFE);
  }

  _addContact(id, x, z, life) {
    const c = this.contacts.get(id);
    if (c) {
      c.x = x; c.z = z; c.t = 0;
      if (life > c.life) c.life = life;
    } else {
      this.contacts.set(id, { x, z, t: 0, life });
    }
  }

  _bombSpectator() {
    if (this.game?.match?.modeId !== 'bomb') return false;
    const player = this.game?.player;
    const referee = this.game?.match?.bombRules;
    if (typeof referee?.isAlive === 'function') {
      try { return referee.isAlive(player) !== true; } catch { return true; }
    }
    return player?.alive !== true;
  }

  /** Round-robin LOS sampling so hostiles you can actually see stay painted. */
  _sampleVisibility() {
    const g = this.game;
    const me = g?.player;
    const world = g?.world;
    if (!me || !me.alive || !world?.losClear) return;

    const list = g.entities;
    if (!list || list.length < 2) return;

    let eye = _eyeA;
    if (typeof me.getEyePosition === 'function') {
      try { eye = me.getEyePosition(_eyeA) || _eyeA; } catch { eye = _eyeA; }
    } else {
      _eyeA.set(me.position.x, me.position.y + (me.eyeHeight ?? 1.62), me.position.z);
    }

    for (let n = 0; n < LOS_CHECKS_PER_FRAME; n++) {
      this._losCursor = (this._losCursor + 1) % list.length;
      const e = list[this._losCursor];
      if (!e || e === me || !e.alive || e.team === me.team) continue;
      const dx = e.position.x - eye.x;
      const dz = e.position.z - eye.z;
      if (dx * dx + dz * dz > VIEW_RADIUS * VIEW_RADIUS) continue;
      _eyeB.set(e.position.x, e.position.y + (e.eyeHeight ?? 1.5) * 0.75, e.position.z);
      let vis = false;
      try { vis = !!world.losClear(eye, _eyeB); } catch { vis = false; }
      if (vis) this._addContact(e.id ?? this._losCursor, e.position.x, e.position.z, BLIP_LOS_LIFE);
    }
  }

  /* ------------------------------------------------------------------ bake */

  _bake() {
    const world = this.game?.world;
    const boxes = world?.boxes;
    if (!boxes || !boxes.length) return false;

    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity;
    const b = world.bounds;
    if (b?.min && b?.max) {
      minX = b.min.x; maxX = b.max.x; minZ = b.min.z; maxZ = b.max.z; minY = b.min.y;
    } else {
      for (let i = 0; i < boxes.length; i++) {
        const bx = boxes[i];
        if (!bx?.min || !bx?.max) continue;
        if (bx.min.x < minX) minX = bx.min.x;
        if (bx.min.z < minZ) minZ = bx.min.z;
        if (bx.min.y < minY) minY = bx.min.y;
        if (bx.max.x > maxX) maxX = bx.max.x;
        if (bx.max.z > maxZ) maxZ = bx.max.z;
      }
    }
    if (!isFinite(minX) || !isFinite(maxX) || maxX <= minX || maxZ <= minZ) return false;

    const pad = 4;
    minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;
    const span = Math.max(maxX - minX, maxZ - minZ);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const originX = cx - span / 2;
    const originZ = cz - span / 2;
    const ppm = BAKE_PX / span;                 // pixels per metre

    const cv = document.createElement('canvas');
    cv.width = BAKE_PX;
    cv.height = BAKE_PX;
    const c = cv.getContext('2d');
    c.clearRect(0, 0, BAKE_PX, BAKE_PX);

    const floorY = isFinite(minY) ? minY : 0;
    const toX = (x) => (x - originX) * ppm;
    const toZ = (z) => (z - originZ) * ppm;

    // Pass 1 — floors / ground plates as the darkest readable substrate.
    c.fillStyle = 'rgba(24, 42, 38, 0.85)';
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (!bx?.min || !bx?.max) continue;
      const top = bx.max.y - floorY;
      if (top > 0.35) continue;
      c.fillRect(toX(bx.min.x), toZ(bx.min.z), (bx.max.x - bx.min.x) * ppm, (bx.max.z - bx.min.z) * ppm);
    }

    // Pass 2 — cover (waist-high) then structure (full walls), brighter as they rise.
    for (let pass = 0; pass < 2; pass++) {
      c.fillStyle = pass === 0 ? 'rgba(92, 214, 160, 0.20)' : 'rgba(142, 247, 196, 0.34)';
      for (let i = 0; i < boxes.length; i++) {
        const bx = boxes[i];
        if (!bx?.min || !bx?.max) continue;
        const top = bx.max.y - floorY;
        if (top <= 0.35) continue;
        const isCover = top < 1.55;
        if ((pass === 0) !== isCover) continue;
        c.fillRect(toX(bx.min.x), toZ(bx.min.z), (bx.max.x - bx.min.x) * ppm, (bx.max.z - bx.min.z) * ppm);
      }
    }

    // Pass 3 — a crisp edge on tall geometry so corridors read at a glance.
    c.strokeStyle = 'rgba(180, 255, 220, 0.55)';
    c.lineWidth = Math.max(1, ppm * 0.09);
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (!bx?.min || !bx?.max) continue;
      if (bx.max.y - floorY < 1.55) continue;
      c.strokeRect(toX(bx.min.x), toZ(bx.min.z), (bx.max.x - bx.min.x) * ppm, (bx.max.z - bx.min.z) * ppm);
    }

    // Playable boundary.
    if (b?.min && b?.max) {
      c.strokeStyle = 'rgba(255, 122, 69, 0.35)';
      c.lineWidth = Math.max(1.5, ppm * 0.14);
      c.strokeRect(toX(b.min.x), toZ(b.min.z), (b.max.x - b.min.x) * ppm, (b.max.z - b.min.z) * ppm);
    }

    // Bomb sites come from the same manifest IDs/callouts used by the referee and HUD.
    // A triangle and double-outline square remain distinct without colour.
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.font = `700 ${Math.max(12, Math.round(ppm * 1.65))}px system-ui, sans-serif`;
    this._sites = sitesFromManifest(world.manifest);
    for (const site of this._sites) {
      const x = toX(site.center.x);
      const y = toZ(site.center.z);
      const size = Math.max(7, ppm * 0.8);
      c.beginPath();
      if (site.site === 'A') {
        c.moveTo(x, y - size);
        c.lineTo(x + size, y + size);
        c.lineTo(x - size, y + size);
        c.closePath();
      } else {
        c.rect(x - size, y - size, size * 2, size * 2);
      }
      c.fillStyle = site.site === 'A' ? '#86ddd3' : '#ffd07d';
      c.fill();
      c.lineWidth = Math.max(2, ppm * 0.18);
      c.strokeStyle = '#071012';
      c.stroke();
      if (site.site === 'B') {
        c.strokeRect(x - size * 0.62, y - size * 0.62, size * 1.24, size * 1.24);
      }
      c.fillStyle = '#f7fbf8';
      c.fillText(`${site.site} · ${site.callout}`, x, y + size + 3);
    }
    c.restore();

    this.baked = cv;
    this.bakeInfo = { originX, originZ, span, ppm };
    this._bakeBoxes = boxes.length;
    return true;
  }

  /* ------------------------------------------------------------------ draw */

  /**
   * Watch our OWN element for size changes.
   *
   * `draw()` must never measure: it runs immediately after the HUD has queued a
   * dozen style writes, so any layout read from there forces a synchronous layout
   * of the whole document. A ResizeObserver is delivered after layout has already
   * settled and hands us `contentRect` for free — zero reads, and it catches the
   * things a window `resize` listener misses, notably the `--hud-scale` setting
   * changing the minimap's size with the window untouched.
   */
  _observeSize() {
    if (this._ro) return;
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver((entries) => {
        const e = entries[entries.length - 1];
        const box = e.contentBoxSize?.[0];
        this._applySize(box ? box.inlineSize : e.contentRect.width);
      });
      this._ro.observe(this.el);
      return;
    }
    // No ResizeObserver (never true in a browser this game runs in, but the probes
    // and any future test harness deserve a working fallback): the engine emits
    // `resize` with the new CSS size, and a one-off measure is safe outside draw.
    this._unsubResize = this.game?.bus?.on?.('resize', () => this._measureOnce()) || null;
  }

  /** A single deliberate layout read, only ever from init / a resize event. */
  _measureOnce() {
    const rect = this.el.getBoundingClientRect();
    this._applySize(rect.width || 160);
  }

  /**
   * Adopt a new CSS size. Zero-width entries are ignored: `.minimap.off` is
   * `display:none`, and taking that as the real size would throw away the cached
   * backing store and the caches derived from it every time the radar is toggled.
   */
  _applySize(cssW) {
    const css = Math.max(64, Math.round(cssW || 0));
    if (!(cssW > 0) || css === this._cssSize) return;
    this._cssSize = css;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(css * dpr);
    if (this.canvas.width !== px) { this.canvas.width = px; this.canvas.height = px; }
    this._buildCaches();
  }

  /**
   * Rebuild everything that depends only on the backing-store size: the view-cone
   * ramp, the UAV sweep ramp and the compass font shorthand. Previously all three
   * were rebuilt every frame — a gradient LUT build plus a CSS font parse, forever.
   */
  _buildCaches() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    if (!ctx || !W) return;
    const R = W * 0.5;

    const cone = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.78);
    cone.addColorStop(0, 'rgba(142, 247, 196, 0.30)');
    cone.addColorStop(1, 'rgba(142, 247, 196, 0)');
    this._coneGrad = cone;

    const sweep = ctx.createLinearGradient(0, 0, R, 0);
    sweep.addColorStop(0, 'rgba(142, 247, 196, 0.00)');
    sweep.addColorStop(1, 'rgba(142, 247, 196, 0.22)');
    this._sweepGrad = sweep;

    this._font = `600 ${Math.round(W * 0.075)}px "Bahnschrift", "DIN Alternate", sans-serif`;
  }

  /** Called every frame by the HUD. `dt` is the real frame delta. */
  draw(dt) {
    if (!this._visible) return;
    const g = this.game;
    const me = g?.player;
    if (!me?.position) return;
    const callout = resolveManifestCallout(g?.world?.manifest, me.position) || 'LOCATION UNKNOWN';
    if (callout !== this._callout) {
      this._callout = callout;
      this._updateLabels();
    }
    const bombSpectator = this._bombSpectator();
    if (bombSpectator) {
      this.contacts.clear();
      if (this._uav) { this._uav = false; this.el.classList.remove('uav'); }
    }

    // Any open menu shell puts a ~96%-opaque scrim over this corner AND stops the
    // simulation, so a redraw here is invisible work on a frame the player is
    // already waiting on. Returning before the contact ageing below is deliberate:
    // paused time must not decay blips.
    if (g.paused || g.state !== 'playing') return;

    if (!this.baked && !this._bake()) return;

    // Size is cached and refreshed from a ResizeObserver — never measured here.
    // (`draw` runs straight after the HUD's style writes; one read would force a
    // synchronous layout of the entire document.)
    if (this._cssSize === 0) this._measureOnce();
    if (!this._coneGrad || !this._font) this._buildCaches();

    // While the operator is down, the ELIMINATED overlay blurs and dims this
    // corner and the radar is player-centric, so it is all but static. Quarter
    // rate is indistinguishable through that overlay; the skipped frame time is
    // banked so contacts still decay at exactly the right rate.
    this._skipDt += dt;
    if (!me.alive && (this._deadTick = (this._deadTick + 1) & 3) !== 0) return;
    dt = this._skipDt;
    this._skipDt = 0;

    this._pulse += dt;
    if (!bombSpectator) this._sampleVisibility();

    // UAV: `match.uavActive(team)` is the authority, and it is cheap (one map read).
    const uav = !bombSpectator && !!g.match?.uavActive?.(me.team);
    if (uav !== this._uav) {
      this._uav = uav;
      this.el.classList.toggle('uav', uav);
      this._updateLabels();
    }

    // Age contacts. Iterating keys rather than entries avoids the two-element
    // array Map entry destructuring allocates for every contact, every frame.
    for (const id of this.contacts.keys()) {
      const c = this.contacts.get(id);
      c.t += dt;
      if (c.t >= c.life) this.contacts.delete(id);
    }

    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = W * 0.5;
    const s = (W * 0.5) / VIEW_RADIUS;      // pixels per metre on screen
    const playerYaw = me.yaw || 0;
    const yaw = this._orientation === 'northUp' ? 0 : playerYaw;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);

    ctx.clearRect(0, 0, W, H);

    // --- rotated world layer ------------------------------------------------
    const bi = this.bakeInfo;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(yaw);
    ctx.scale(s, s);
    ctx.translate(-me.position.x, -me.position.z);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.baked, bi.originX, bi.originZ, bi.span, bi.span);
    ctx.restore();

    // --- view cone ----------------------------------------------------------
    // Half-angle of the actual horizontal frustum, so the wedge on the radar is
    // literally what the player can see. `camera.fov` is the vertical FOV.
    ctx.save();
    ctx.translate(cx, cy);
    const cam = g.camera;
    const vFov = (cam?.fov || 75) * Math.PI / 180;
    const aspect = cam?.aspect || 16 / 9;
    const half = Math.min(1.35, Math.atan(Math.tan(vFov * 0.5) * aspect));
    const coneR = R * 0.78;
    ctx.fillStyle = this._coneGrad;      // built once per size, not per frame
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, coneR, -Math.PI / 2 - half, -Math.PI / 2 + half);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // --- dynamic markers (screen space, upright) ---------------------------
    const px = me.position.x;
    const pz = me.position.z;
    const edge = R - W * 0.055;

    // Friendlies.
    const list = g.entities;
    if (!bombSpectator && list) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e === me || !e.alive) continue;
        if (e.team !== me.team) continue;
        const dx = e.position.x - px;
        const dz = e.position.z - pz;
        const sx = (dx * cosY - dz * sinY) * s;
        const sy = (dx * sinY + dz * cosY) * s;
        this._marker(ctx, cx, cy, sx, sy, edge, yaw - (e.yaw || 0), '#58c9ff', 1);
      }
    }

    // UAV sweep — a rotating wedge sold as the satellite pass that paints the map.
    if (this._uav) {
      const sweep = (this._pulse / UAV_SWEEP_PERIOD) % 1 * Math.PI * 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(sweep);
      ctx.fillStyle = this._sweepGrad;   // built once per size, not per frame
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, -0.55, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Hostile contacts. While a UAV is up every living hostile is a contact, drawn
    // at full strength; otherwise only decaying gunshot / line-of-sight blips show.
    if (!bombSpectator && this._uav && list) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e === me || !e.alive || e.team === me.team) continue;
        const dx = e.position.x - px;
        const dz = e.position.z - pz;
        const sx = (dx * cosY - dz * sinY) * s;
        const sy = (dx * sinY + dz * cosY) * s;
        this._marker(ctx, cx, cy, sx, sy, edge, yaw - (e.yaw || 0), '#ff4433', 1);
      }
    }
    for (const c of bombSpectator ? [] : this.contacts.values()) {
      const dx = c.x - px;
      const dz = c.z - pz;
      const sx = (dx * cosY - dz * sinY) * s;
      const sy = (dx * sinY + dz * cosY) * s;
      const a = 1 - c.t / c.life;
      this._blip(ctx, cx, cy, sx, sy, edge, W, a);
    }

    // Grenades / live projectiles. `ProjectileSystem.pool` is the real store; every
    // record carries `active` and a `pos` vector (NOT `position`).
    const projList = bombSpectator ? null : this.game.projectiles?.pool;
    if (projList) {
      const pulse = 0.55 + 0.45 * Math.sin(this._pulse * 9);
      for (let i = 0; i < projList.length; i++) {
        const p = projList[i];
        if (!p || !p.active) continue;
        const dx = p.pos.x - px;
        const dz = p.pos.z - pz;
        const sx = (dx * cosY - dz * sinY) * s;
        const sy = (dx * sinY + dz * cosY) * s;
        const d = Math.hypot(sx, sy);
        if (d > edge) continue;
        const hostile = !!p.owner && p.owner.team !== me.team;
        ctx.beginPath();
        ctx.arc(cx + sx, cy + sy, W * 0.014 + W * 0.012 * pulse, 0, Math.PI * 2);
        ctx.fillStyle = hostile
          ? `rgba(255, 47, 36, ${0.4 + 0.5 * pulse})`
          : `rgba(255, 179, 71, ${0.35 + 0.5 * pulse})`;
        ctx.fill();
      }
    }

    // --- bomb-site emphasis -------------------------------------------------
    // The baked layer already stamps both site glyphs; while the bomb is PLANTED
    // the armed site additionally pulses with a red core, and clamps to the ring
    // edge when out of view, so "where is it armed" is always one glance at the
    // radar. The pulse colour is OWNERSHIP (bomb-rules §13.10): your home site in
    // the friendly hue — the enemy's plant is at YOUR door — the enemy's home in
    // the hostile accent, matching the ground rings (src/fx/siteRings.js).
    if (g.match?.modeId === 'bomb' && this._sites?.length) {
      const bomb = g.match.bomb;
      const plantedSite = bomb?.state === 'planted' ? bomb.siteId : null;
      const team = me.team === 1 ? 1 : 0;
      const homeSite = g.match.homeSites?.[team]
        ?? homeSiteOfTeam(team, g.match.sideSwitched === true);
      if (plantedSite) {
        for (const site of this._sites) {
          if (site.site !== plantedSite) continue;
          const dx = site.center.x - px;
          const dz = site.center.z - pz;
          let sx = (dx * cosY - dz * sinY) * s;
          let sy = (dx * sinY + dz * cosY) * s;
          const d = Math.hypot(sx, sy);
          if (d > edge) { const k = edge / (d || 1); sx *= k; sy *= k; }
          const pulse = 0.5 + 0.5 * Math.sin(this._pulse * 7);
          const x = cx + sx;
          const y = cy + sy;
          ctx.beginPath();
          ctx.arc(x, y, W * (0.045 + 0.028 * pulse), 0, Math.PI * 2);
          ctx.strokeStyle = site.site === homeSite ? '#58c9ff' : '#ff4433';
          ctx.lineWidth = Math.max(1.5, W * 0.010);
          ctx.globalAlpha = 0.45 + 0.55 * pulse;
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, y, W * 0.020, 0, Math.PI * 2);
          ctx.fillStyle = '#ff4433';
          ctx.fill();
          ctx.strokeStyle = 'rgba(4, 6, 10, 0.85)';
          ctx.lineWidth = Math.max(1, W * 0.005);
          ctx.stroke();
        }
      }
    }

    // --- player -------------------------------------------------------------
    const pr = W * 0.036;
    ctx.save();
    ctx.translate(cx, cy);
    if (this._orientation === 'northUp') ctx.rotate(-playerYaw);
    ctx.beginPath();
    ctx.moveTo(0, -pr * 1.35);
    ctx.lineTo(pr * 0.92, pr * 0.95);
    ctx.lineTo(0, pr * 0.42);
    ctx.lineTo(-pr * 0.92, pr * 0.95);
    ctx.closePath();
    ctx.fillStyle = '#e9f1f7';
    ctx.fill();
    ctx.strokeStyle = 'rgba(4, 6, 10, 0.85)';
    ctx.lineWidth = Math.max(1, W * 0.006);
    ctx.stroke();
    ctx.restore();

    // --- north indicator ----------------------------------------------------
    const nx = cx + sinY * edge;
    const ny = cy - cosY * edge;
    ctx.beginPath();
    ctx.arc(nx, ny, W * 0.026, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(4, 8, 12, 0.8)';
    ctx.fill();
    ctx.fillStyle = '#8ef7c4';
    ctx.font = this._font;               // cached shorthand — no font parse per frame
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + W * 0.004);

    // --- range ring ---------------------------------------------------------
    // Half the view radius, so distance on the radar is readable rather than felt.
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(142, 247, 196, 0.10)';
    ctx.lineWidth = Math.max(1, W * 0.004);
    ctx.stroke();
  }

  _updateLabels() {
    this.tagEl.textContent = this._uav ? 'uav · sat link' : 'radar';
    this.calloutEl.textContent = this._callout || 'LOCATION UNKNOWN';
  }

  /** Chevron marker with edge clamping for off-map contacts. */
  _marker(ctx, cx, cy, sx, sy, edge, rot, color, alpha) {
    const d = Math.hypot(sx, sy);
    let clamped = false;
    if (d > edge) {
      const k = edge / (d || 1);
      sx *= k; sy *= k;
      clamped = true;
    }
    const W = this.canvas.width;
    const r = W * (clamped ? 0.022 : 0.028);
    ctx.save();
    ctx.translate(cx + sx, cy + sy);
    ctx.globalAlpha = alpha * (clamped ? 0.55 : 1);
    ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.1);
    ctx.lineTo(r, r * 0.85);
    ctx.lineTo(0, r * 0.28);
    ctx.lineTo(-r, r * 0.85);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(4, 6, 10, 0.8)';
    ctx.lineWidth = Math.max(1, W * 0.005);
    ctx.stroke();
    ctx.restore();
  }

  /** Fading hostile blip; clamps to the ring with an arrow when off-map. */
  _blip(ctx, cx, cy, sx, sy, edge, W, alpha) {
    const a = Math.max(0, Math.min(1, alpha));
    if (a <= 0) return;
    const d = Math.hypot(sx, sy);
    let clamped = false;
    if (d > edge) {
      const k = edge / (d || 1);
      sx *= k; sy *= k;
      clamped = true;
    }
    const x = cx + sx;
    const y = cy + sy;
    ctx.save();
    ctx.globalAlpha = a;
    if (clamped) {
      const ang = Math.atan2(sy, sx);
      const r = W * 0.026;
      ctx.translate(x, y);
      ctx.rotate(ang + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.85, r * 0.7);
      ctx.lineTo(-r * 0.85, r * 0.7);
      ctx.closePath();
      ctx.fillStyle = '#ff2f24';
      ctx.fill();
    } else {
      const r = W * 0.030;
      ctx.beginPath();
      ctx.arc(x, y, r * (1 + (1 - a) * 0.9), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 47, 36, ${0.16 * a})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#ff4433';
      ctx.fill();
      ctx.strokeStyle = 'rgba(4, 6, 10, 0.75)';
      ctx.lineWidth = Math.max(1, W * 0.005);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// Module-scope scratch — the contract forbids per-frame allocation.
const _eyeA = new THREE.Vector3();
const _eyeB = new THREE.Vector3();
