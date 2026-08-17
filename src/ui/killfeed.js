import { WEAPONS } from '../weapons/weaponDefs.js';

/**
 * Killfeed — pooled rows, inline SVG weapon glyphs, team colouring.
 *
 * Rows are allocated once at construction and recycled forever; `add()` never
 * touches innerHTML on the hot path beyond the two name strings and a glyph
 * swap that is skipped when the class is unchanged from the pooled row's last
 * use. Lifetime is driven from `update(dt)` so nothing depends on timers.
 */

const VB = 'viewBox="0 0 64 26" xmlns="http://www.w3.org/2000/svg"';

/**
 * One compact silhouette per weapon class. Deliberately chunky — these render
 * at ~20px tall and must read instantly at a glance in the corner of the eye.
 */
export const WEAPON_GLYPHS = {
  ar: `<svg ${VB}><path d="M2 11h30v3h4l2-5h5v5h13v-3h6v9h-8l-1 3h-6l-2-3H26l-3 6h-6l2-6H8v3H2z"/><path d="M30 17h5l-2 6h-5z"/></svg>`,

  smg: `<svg ${VB}><path d="M6 10h24l2-4h6v4h16v8h-6l-1 3h-6l-1-3H26l-2 5h-6l2-5h-8v3H6z"/><path d="M28 18h5l-2 7h-5z"/></svg>`,

  sniper: `<svg ${VB}><path d="M2 12h26v-2h4l1-3h5v3h20v3h4v5h-6l-1 3h-6l-2-3H26l-3 6h-6l2-6H8v3H2z"/><rect x="30" y="3" width="16" height="3"/><path d="M32 18h5l-2 7h-5z"/></svg>`,

  shotgun: `<svg ${VB}><path d="M2 9h44v4h14v6H46v3h-8l-2 4h-6l2-4H12v3H2z"/><rect x="2" y="14" width="42" height="3"/><path d="M22 20h5l-3 6h-5z"/></svg>`,

  lmg: `<svg ${VB}><path d="M4 10h26v-3h5v3h17v3h8v6h-8l-1 3h-6l-2-3H30l-3 6h-6l2-6h-6v3H4z"/><path d="M8 14h16v9H8z"/><path d="M30 18h5l-2 7h-5z"/></svg>`,

  pistol: `<svg ${VB}><path d="M14 8h34v6h-6l-1 3h-8l-8 10h-8l6-10h-9z"/><path d="M18 14h8l-6 10h-8z"/></svg>`,

  launcher: `<svg ${VB}><path d="M10 8h38l8 5-8 5H10z"/><path d="M2 10h9v6H2z"/><path d="M24 18h6l-2 7h-6z"/><path d="M34 3h4v5h-4z"/></svg>`,

  melee: `<svg ${VB}><path d="M8 20 44 4l6 4-32 18z"/><path d="M6 22h10v4H4z"/><path d="M44 4l6 4 8-5-6-2z"/></svg>`,

  frag: `<svg ${VB}><path d="M32 6a9 9 0 1 1 0 18 9 9 0 0 1 0-18z"/><rect x="28" y="1" width="8" height="5"/><path d="M36 2h10v3H36z"/></svg>`,

  explosion: `<svg ${VB}><path d="M32 1l5 8 9-5-3 10 11 1-8 6 8 6-11 1 3 10-9-5-5 8-5-8-9 5 3-10-11-1 8-6-8-6 11-1-3-10 9 5z"/></svg>`,

  /* --- killstreak hardware. Match emits these ids as the weaponId. --- */
  airstrike: `<svg ${VB}><path d="M4 9l22-3 8-5h5l-3 5 22 2v4l-22 2 3 5h-5l-8-5-22-3z"/><path d="M20 16h3l-2 8h-3zM30 18h3l-2 8h-3zM40 16h3l-2 8h-3z"/></svg>`,

  sentry: `<svg ${VB}><path d="M18 4h16v9H18z"/><path d="M34 6h26v4H34z"/><path d="M24 13h4l6 12h-4zM28 13h4l-6 12h-4z"/><path d="M14 20h8v3h-8z"/></svg>`,

  chopper: `<svg ${VB}><path d="M6 3h52v3H6z"/><path d="M30 6h4v4h-4z"/><path d="M18 10h22l10 4-4 7H20l-6-5z"/><path d="M44 15h16v3H44z"/><path d="M18 21h24v2H18z"/><path d="M52 11h3v6h-3z"/></svg>`,

  default: `<svg ${VB}><path d="M4 11h32v3h6l2-4h6v4h10v6H48l-2 3h-6l-2-3H26l-3 6h-6l2-6H8v3H4z"/></svg>`,
};

export const HEADSHOT_GLYPH =
  `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 1a8 8 0 0 1 8 8v4l-2 2v4a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-3l-2-3V9a8 8 0 0 1 8-8z" opacity=".28"/><path d="M12 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zM12 0v3.2M12 20.8V24M0 12h3.2M20.8 12H24"/></svg>`;

/** Map an arbitrary weapon id / class onto a glyph key. */
export function glyphKeyFor(weaponClass, weaponId) {
  const c = String(weaponClass || '').toLowerCase();
  if (WEAPON_GLYPHS[c]) return c;
  const id = String(weaponId || '').toLowerCase();
  if (!id) return 'default';
  if (WEAPON_GLYPHS[id]) return id;              // airstrike / sentry / chopper / frag
  if (id.includes('melee') || id.includes('knife') || id.includes('blade')) return 'melee';
  if (id.includes('frag') || id.includes('grenade') || id.includes('nade')) return 'frag';
  if (id.includes('explos')) return 'explosion';
  // Ids are conventionally `<class>_<name>` — try the prefix, then a substring scan.
  const pre = id.split('_')[0];
  if (WEAPON_GLYPHS[pre]) return pre;
  for (const k of ['sniper', 'shotgun', 'launcher', 'pistol', 'smg', 'lmg', 'ar']) {
    if (id.includes(k)) return k;
  }
  return 'default';
}

/** Inline SVG markup for a weapon. Safe to assign to innerHTML — no user data. */
export function weaponGlyph(weaponClass, weaponId) {
  return WEAPON_GLYPHS[glyphKeyFor(weaponClass, weaponId)] || WEAPON_GLYPHS.default;
}

const MAX_ROWS = 5;
const POOL_SIZE = 7;
const LIFETIME = 6.0;
const FADE_AT = 5.65;

export class Killfeed {
  /**
   * @param {object} game
   * @param {HTMLElement} root element to mount into (a HUD child)
   */
  constructor(game, root) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.className = 'killfeed';
    root?.appendChild(this.el);

    /** @type {Array<{el:HTMLElement, killer:HTMLElement, victim:HTMLElement, icon:HTMLElement, hs:HTMLElement, glyph:string, busy:boolean, t:number, fading:boolean}>} */
    this.pool = [];
    /** Active rows, newest first. */
    this.active = [];

    for (let i = 0; i < POOL_SIZE; i++) this.pool.push(this._makeRow());
    this._pending = null;
  }

  _makeRow() {
    const el = document.createElement('div');
    el.className = 'kf-row';

    const killer = document.createElement('span');
    killer.className = 'kf-name';

    const hs = document.createElement('span');
    hs.className = 'kf-hs off';
    hs.innerHTML = HEADSHOT_GLYPH;

    const icon = document.createElement('span');
    icon.className = 'kf-icon';
    icon.innerHTML = WEAPON_GLYPHS.default;

    const victim = document.createElement('span');
    victim.className = 'kf-name';

    el.appendChild(killer);
    el.appendChild(hs);
    el.appendChild(icon);
    el.appendChild(victim);

    return { el, killer, victim, icon, hs, glyph: 'default', busy: false, t: 0, fading: false };
  }

  _free() {
    for (const r of this.pool) if (!r.busy) return r;
    // Every row is in flight — steal the oldest (should be impossible with
    // POOL_SIZE > MAX_ROWS, but never fail loudly on the HUD).
    const oldest = this.active[this.active.length - 1];
    if (oldest) this._retire(oldest);
    return this.pool.find((r) => !r.busy) || this.pool[0];
  }

  _retire(row) {
    row.busy = false;
    row.fading = false;
    row.t = 0;
    row.el.classList.remove('on', 'in', 'out', 'mine');
    if (row.el.parentNode === this.el) this.el.removeChild(row.el);
    const i = this.active.indexOf(row);
    if (i >= 0) this.active.splice(i, 1);
  }

  /**
   * Push a kill. Accepts either a raw `kill` bus payload
   * `{ victim, attacker, weaponId, headshot }` or a pre-flattened entry
   * `{ killer, victim, killerTeam, victimTeam, weaponId, weaponClass, headshot, mine }`.
   */
  add(entry) {
    if (!entry) return;

    const local = this.game?.player;
    const atk = entry.attacker ?? null;
    const vic = typeof entry.victim === 'object' ? entry.victim : null;

    const killerName = String(
      entry.killer ?? atk?.name ?? (atk === null && vic ? 'WORLD' : 'UNKNOWN'),
    ).toUpperCase();
    const victimName = String(
      entry.victimName ?? vic?.name ?? (typeof entry.victim === 'string' ? entry.victim : 'UNKNOWN'),
    ).toUpperCase();

    const killerTeam = entry.killerTeam ?? atk?.team ?? -1;
    const victimTeam = entry.victimTeam ?? vic?.team ?? -1;
    const mine = entry.mine ?? (!!local && (atk === local || vic === local));
    const isSelfKiller = !!local && atk === local;
    const isSelfVictim = !!local && vic === local;

    const gk = glyphKeyFor(entry.weaponClass ?? this._classOf(entry.weaponId), entry.weaponId);
    const headshot = !!entry.headshot;

    const row = this._free();
    row.busy = true;
    row.t = 0;
    row.fading = false;

    row.killer.textContent = killerName;
    row.victim.textContent = victimName;
    row.killer.className = 'kf-name ' + (isSelfKiller ? 'self' : killerTeam === 0 ? 't0' : killerTeam === 1 ? 't1' : '');
    row.victim.className = 'kf-name ' + (isSelfVictim ? 'self' : victimTeam === 0 ? 't0' : victimTeam === 1 ? 't1' : '');

    if (row.glyph !== gk) {
      row.icon.innerHTML = WEAPON_GLYPHS[gk] || WEAPON_GLYPHS.default;
      row.glyph = gk;
    }
    row.hs.className = headshot ? 'kf-hs' : 'kf-hs off';

    row.el.className = 'kf-row on' + (mine ? ' mine' : '');
    this.el.insertBefore(row.el, this.el.firstChild);
    this.active.unshift(row);

    // Enter transition needs one frame with the pre-state applied.
    requestAnimationFrame(() => { if (row.busy) row.el.classList.add('in'); });

    while (this.active.length > MAX_ROWS) this._retire(this.active[this.active.length - 1]);
  }

  /**
   * Weapon class for an id, straight out of the §7 def table. `WEAPONS` is a plain
   * data map — an unknown id (streak hardware, the world) must stay null so
   * `glyphKeyFor` can fall back on its id heuristics rather than being told "ar".
   */
  _classOf(weaponId) {
    if (!weaponId) return null;
    return WEAPONS[weaponId]?.class ?? null;
  }

  update(dt) {
    const n = this.active.length;
    if (n === 0) return;
    for (let i = n - 1; i >= 0; i--) {
      const row = this.active[i];
      row.t += dt;
      if (!row.fading && row.t >= FADE_AT) {
        row.fading = true;
        row.el.classList.remove('in');
        row.el.classList.add('out');
      }
      if (row.t >= LIFETIME) this._retire(row);
    }
  }

  clear() {
    for (let i = this.active.length - 1; i >= 0; i--) this._retire(this.active[i]);
  }

  reset() { this.clear(); }

  dispose() {
    this.clear();
    this.el.remove();
  }
}
