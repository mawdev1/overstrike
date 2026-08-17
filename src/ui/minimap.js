import * as THREE from 'three';

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
    this._uav = false;

    this._onShot = this._onShot.bind(this);
    this._unsub = game?.bus?.on?.('shot', this._onShot) || null;

    // Explosions light up the map too — they are loud, so they are a contact.
    this._unsubBoom = game?.bus?.on?.('explosion', (p) => {
      if (!p?.point) return;
      this._addContact(-1 - (this.contacts.size % 8), p.point.x, p.point.z, 1.4);
    }) || null;
  }

  /* ------------------------------------------------------------- lifecycle */

  init() { this._syncSize(); }

  reset() {
    this.contacts.clear();
    this._losCursor = 0;
    this._pulse = 0;
    if (this._uav) { this._uav = false; this.el.classList.remove('uav'); this.tagEl.textContent = 'radar'; }
    // The level can be rebuilt between matches; drop the bake so it re-bakes.
    this.baked = null;
    this.bakeInfo = null;
  }

  dispose() {
    this._unsub?.();
    this._unsubBoom?.();
    this.el.remove();
    this.baked = null;
  }

  setVisible(v) {
    if (this._visible === v) return;
    this._visible = v;
    this.el.classList.toggle('off', !v);
  }

  /* ------------------------------------------------------------- contacts */

  _onShot(p) {
    const shooter = p?.shooter;
    const me = this.game?.player;
    if (!shooter || !me) return;
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

    this.baked = cv;
    this.bakeInfo = { originX, originZ, span, ppm };
    return true;
  }

  /* ------------------------------------------------------------------ draw */

  _syncSize() {
    const rect = this.el.getBoundingClientRect();
    const css = Math.max(64, Math.round(rect.width || 160));
    if (css === this._cssSize) return;
    this._cssSize = css;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(css * dpr);
    if (this.canvas.width !== px) { this.canvas.width = px; this.canvas.height = px; }
  }

  /** Called every frame by the HUD. `dt` is the real frame delta. */
  draw(dt) {
    if (!this._visible) return;
    const g = this.game;
    const me = g?.player;
    if (!me?.position) return;

    if (!this.baked && !this._bake()) return;

    // Cheap: getBoundingClientRect only when the layout could have changed.
    if ((g.frame & 63) === 0 || this._cssSize === 0) this._syncSize();

    this._pulse += dt;
    this._sampleVisibility();

    // UAV: `match.uavActive(team)` is the authority, and it is cheap (one map read).
    const uav = !!g.match?.uavActive?.(me.team);
    if (uav !== this._uav) {
      this._uav = uav;
      this.el.classList.toggle('uav', uav);
      this.tagEl.textContent = uav ? 'uav · sat link' : 'radar';
    }

    // Age contacts.
    for (const [id, c] of this.contacts) {
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
    const yaw = me.yaw || 0;
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
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, coneR);
    grad.addColorStop(0, 'rgba(142, 247, 196, 0.30)');
    grad.addColorStop(1, 'rgba(142, 247, 196, 0)');
    ctx.fillStyle = grad;
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
    if (list) {
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
      const sg = ctx.createLinearGradient(0, 0, R, 0);
      sg.addColorStop(0, 'rgba(142, 247, 196, 0.00)');
      sg.addColorStop(1, 'rgba(142, 247, 196, 0.22)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, -0.55, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Hostile contacts. While a UAV is up every living hostile is a contact, drawn
    // at full strength; otherwise only decaying gunshot / line-of-sight blips show.
    if (this._uav && list) {
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
    for (const c of this.contacts.values()) {
      const dx = c.x - px;
      const dz = c.z - pz;
      const sx = (dx * cosY - dz * sinY) * s;
      const sy = (dx * sinY + dz * cosY) * s;
      const a = 1 - c.t / c.life;
      this._blip(ctx, cx, cy, sx, sy, edge, W, a);
    }

    // Grenades / live projectiles. `ProjectileSystem.pool` is the real store; every
    // record carries `active` and a `pos` vector (NOT `position`).
    const projList = this.game.projectiles?.pool;
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

    // --- player -------------------------------------------------------------
    const pr = W * 0.036;
    ctx.save();
    ctx.translate(cx, cy);
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
    ctx.font = `600 ${Math.round(W * 0.075)}px "Bahnschrift", "DIN Alternate", sans-serif`;
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
