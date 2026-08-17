/**
 * Scoreboard — held-Tab overlay.
 *
 * Rows come from `Match.getScoreboardRows()` (§ the real API): pooled row objects
 * already sorted by score, carrying assists, K/D, accuracy, best streak and alive
 * state — everything the entity contract alone cannot tell us. They are pooled, so
 * we read them and never retain them.
 *
 * Built once from a fixed node pool, then refreshed only while on screen (and only
 * at 5 Hz, since nothing here changes faster). While hidden it is `display:none`
 * and `update()` returns on the first line.
 */

const REFRESH_HZ = 5;
const POOL_PER_COL = 16;

const MODE_LABEL = {
  tdm: 'TEAM DEATHMATCH',
  teamdeathmatch: 'TEAM DEATHMATCH',
  ffa: 'FREE-FOR-ALL',
  freeforall: 'FREE-FOR-ALL',
  gungame: 'GUN GAME',
  gg: 'GUN GAME',
  dom: 'DOMINATION',
  domination: 'DOMINATION',
  kc: 'KILL CONFIRMED',
  killconfirmed: 'KILL CONFIRMED',
};

/** Stable, deterministic "ping" flavour per player id — never jitters. */
function fakePing(id) {
  let h = (id | 0) * 2654435761;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return 14 + (Math.abs(h) % 78);
}

/**
 * Display label for a mode. `match.mode` is a rule object that stringifies to its id
 * (modes.js installs a `toString`), so this takes ids, objects and display names alike.
 */
export function modeLabel(mode) {
  if (!mode) return 'SKIRMISH';
  if (typeof mode === 'object' && mode.name) return String(mode.name).toUpperCase();
  const key = String(mode).toLowerCase().replace(/[^a-z]/g, '');
  return MODE_LABEL[key] || String(mode).toUpperCase().replace(/[_-]+/g, ' ');
}

export function formatClock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.ceil(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export class Scoreboard {
  constructor(game, root) {
    this.game = game;
    this.visible = false;
    this._acc = 0;
    this._modeTxt = '';
    this._clockTxt = '';
    this._extTime = 0;

    const el = document.createElement('div');
    el.className = 'sb';
    el.innerHTML = `
      <div class="sb-head">
        <div class="sb-title">
          <span class="sb-mode">SKIRMISH</span>
          <span class="sb-obj"></span>
        </div>
        <div class="sb-meta">
          <span class="sb-alive">—</span>
          <span class="sb-timebox">TIME <b class="sb-clock">0:00</b></span>
        </div>
      </div>
      <div class="sb-cols"></div>
      <div class="sb-foot">
        <span>HOLD <i class="kbd">TAB</i></span>
        <span class="sb-legend">K KILLS · D DEATHS · A ASSISTS · ACC ACCURACY · STK BEST STREAK</span>
      </div>`;
    root?.appendChild(el);

    this.el = el;
    this.modeEl = el.querySelector('.sb-mode');
    this.objEl = el.querySelector('.sb-obj');
    this.clockEl = el.querySelector('.sb-clock');
    this.aliveEl = el.querySelector('.sb-alive');
    this.colsEl = el.querySelector('.sb-cols');

    this.columns = [this._makeColumn(0, 'ALPHA'), this._makeColumn(1, 'BRAVO')];
    for (const c of this.columns) this.colsEl.appendChild(c.el);

    /** Reused row buckets — refresh() must not allocate. */
    this._buckets = [[], []];
    this._all = [];
  }

  _makeColumn(team, name) {
    const el = document.createElement('div');
    el.className = 'sb-col ' + (team === 0 ? 'a' : 'b');

    const head = document.createElement('div');
    head.className = 'sb-team';
    head.innerHTML = `<span class="nm">${name}</span><span class="pts num">0</span>`;
    el.appendChild(head);

    const hdr = document.createElement('div');
    hdr.className = 'sb-hdr';
    hdr.innerHTML =
      '<span>OPERATOR</span><span>K</span><span>D</span><span>A</span>' +
      '<span>K/D</span><span>ACC</span><span>SCORE</span><span>STK</span><span>MS</span>';
    el.appendChild(hdr);

    const rows = [];
    for (let i = 0; i < POOL_PER_COL; i++) {
      const r = document.createElement('div');
      r.className = 'sb-row';
      r.style.display = 'none';
      r.innerHTML =
        '<span class="nm"></span><span class="k num"></span><span class="d num"></span>' +
        '<span class="a num"></span><span class="kd num"></span><span class="acc num"></span>' +
        '<span class="sc num"></span><span class="stk num"></span><span class="png num"></span>';
      el.appendChild(r);
      rows.push({
        el: r,
        nm: r.querySelector('.nm'),
        k: r.querySelector('.k'),
        d: r.querySelector('.d'),
        a: r.querySelector('.a'),
        kd: r.querySelector('.kd'),
        acc: r.querySelector('.acc'),
        sc: r.querySelector('.sc'),
        stk: r.querySelector('.stk'),
        png: r.querySelector('.png'),
        shown: false,
        cache: '',
      });
    }

    return { el, head, pts: head.querySelector('.pts'), label: head.querySelector('.nm'), rows, team, name };
  }

  /* ------------------------------------------------------------ visibility */

  setVisible(v) {
    v = !!v;
    if (v === this.visible) return;
    this.visible = v;
    this.el.classList.toggle('on', v);
    if (v) { this._acc = 999; this.refresh(); }
  }

  toggle() { this.setVisible(!this.visible); }

  /* ---------------------------------------------------------------- update */

  update(dt) {
    if (!this.visible) return;
    this._acc += dt;
    if (this._acc < 1 / REFRESH_HZ) return;
    this._acc = 0;
    this.refresh();
  }

  refresh() {
    const g = this.game;
    const match = g?.match;
    if (!match) return;
    const me = g.player;

    // ---- header ----
    const modeTxt = String(match.modeName || modeLabel(match.mode));
    if (modeTxt !== this._modeTxt) {
      this._modeTxt = modeTxt;
      this.modeEl.textContent = modeTxt;
      this.objEl.textContent = String(match.mode?.hudLabels?.objective || '');
    }

    const secs = typeof match.timeRemaining === 'number' ? match.timeRemaining : this._extTime;
    const clockTxt = formatClock(secs);
    if (clockTxt !== this._clockTxt) { this._clockTxt = clockTxt; this.clockEl.textContent = clockTxt; }

    // ---- rows straight from the referee ----
    const rows = match.getScoreboardRows();
    const teamBased = !!match.mode?.teamBased;

    const a = this._buckets[0];
    const b = this._buckets[1];
    a.length = 0;
    b.length = 0;

    let alive = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.alive) alive++;
      if (teamBased) (r.team === 1 ? b : a).push(r);
      else a.push(r);
    }

    if (teamBased) {
      this.columns[0].label.textContent = teamName(match, 0, 'ALPHA');
      this.columns[1].label.textContent = teamName(match, 1, 'BRAVO');
      this._setText(this.columns[0].pts, String(match.scores[0] | 0));
      this._setText(this.columns[1].pts, String(match.scores[1] | 0));
    } else {
      // Free-for-all: rows are already ranked; deal the top half / bottom half into
      // the two columns so the layout stays symmetrical and the leaders read first.
      const all = this._all;
      all.length = 0;
      for (let i = 0; i < a.length; i++) all.push(a[i]);
      a.length = 0;
      const half = Math.ceil(all.length / 2);
      for (let i = 0; i < all.length; i++) (i < half ? a : b).push(all[i]);
      this.columns[0].label.textContent = 'LEADERS';
      this.columns[1].label.textContent = 'FIELD';
      this._setText(this.columns[0].pts, String(all[0]?.kills | 0));
      this._setText(this.columns[1].pts, String(all.length));
    }

    this._setText(this.aliveEl, `${alive} ALIVE / ${rows.length}`);

    this._fill(this.columns[0], a, me);
    this._fill(this.columns[1], b, me);
  }

  _setText(el, txt) { if (el && el.textContent !== txt) el.textContent = txt; }

  _fill(col, arr, me) {
    const rows = col.rows;
    const n = Math.min(arr.length, rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i >= n) {
        if (r.shown) { r.shown = false; r.el.style.display = 'none'; r.cache = ''; }
        continue;
      }
      const s = arr[i];
      const isMe = !!me && s.isPlayer;
      const ping = fakePing(s.id);
      const acc = Math.round(s.accuracy * 100);

      // Single cheap signature guards the whole row against redundant writes.
      const sig = `${s.name}|${s.kills}|${s.deaths}|${s.assists}|${s.score}|${s.bestStreak}|${acc}|${s.alive ? 1 : 0}`;
      if (r.cache === sig) {
        if (!r.shown) { r.shown = true; r.el.style.display = ''; }
        continue;
      }
      r.cache = sig;

      r.nm.textContent = String(s.name || 'OPERATOR').toUpperCase();
      r.nm.className = 'nm' + (s.alive ? '' : ' dead');
      r.k.textContent = String(s.kills);
      r.d.textContent = String(s.deaths);
      r.a.textContent = String(s.assists);
      r.kd.textContent = s.kd.toFixed(2);
      r.acc.textContent = `${acc}%`;
      r.sc.textContent = String(s.score);
      r.stk.textContent = s.bestStreak > 0 ? String(s.bestStreak) : '—';
      r.stk.className = 'stk num' + (s.bestStreak >= 3 ? ' hot' : '');
      r.png.textContent = String(ping);
      r.png.className = 'png num ' + (ping < 40 ? 'good' : ping < 70 ? 'mid' : 'bad');
      r.el.className = 'sb-row' + (isMe ? ' me' : '') + (s.alive ? '' : ' out');
      if (!r.shown) { r.shown = true; r.el.style.display = ''; }
    }
  }

  /** HUD pushes the authoritative clock here so both readouts always agree. */
  setTime(seconds) { this._extTime = seconds; }

  reset() {
    this._modeTxt = '';
    this._clockTxt = '';
    for (const col of this.columns) {
      for (const r of col.rows) { r.cache = ''; r.shown = false; r.el.style.display = 'none'; }
    }
  }

  dispose() { this.el.remove(); }
}

function teamName(match, i, fallback) {
  const n = match?.teamNames?.[i];
  return String(n || fallback).toUpperCase();
}
