/**
 * Scoreboard — held-action overlay.
 *
 * Local-practice rows come from `Match.getScoreboardRows()`. Network composition may inject
 * the frozen facade as the optional third constructor argument; no network implementation is
 * imported here. A latency value is rendered only when it arrives with the facade's complete
 * measurement metadata. Missing data stays missing — this UI never synthesizes ping.
 */

const REFRESH_HZ = 5;
const POOL_PER_COL = 16;

const MODE_LABEL = {
  bomb: 'BOMB',
  tdm: 'TEAM DEATHMATCH',
  teamdeathmatch: 'TEAM DEATHMATCH',
};

const ROUND_REASON = Object.freeze({
  elimination: 'ELIM',
  defuse: 'DEFUSE',
  detonation: 'DETONATE',
  timer: 'TIME',
  forfeit: 'FORFEIT',
  abandon: 'ABANDON',
});

const CONNECTION_STATES = new Set([
  'idle', 'connecting', 'live', 'reconnecting', 'closed', 'version-mismatch', 'rejected',
]);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value);
const nonNegativeInt = (value) => integer(value) && value >= 0 ? value : null;
const displayInt = (value) => nonNegativeInt(value) === null ? '—' : String(value);

/** Display label for a mode. `match.mode` may be an id or a rule object. */
export function modeLabel(mode) {
  if (!mode) return 'TEAM DEATHMATCH';
  if (typeof mode === 'object' && mode.name) return String(mode.name).toUpperCase();
  const key = String(mode).toLowerCase().replace(/[^a-z]/g, '');
  return MODE_LABEL[key] || String(mode).toUpperCase().replace(/[_-]+/g, ' ');
}

export function formatClock(sec) {
  if (!finite(sec) || sec < 0) sec = 0;
  const s = Math.ceil(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export function isBombMatch(match) {
  const mode = match?.modeId ?? match?.mode?.id ?? match?.mode;
  return String(mode || '').toLowerCase() === 'bomb';
}

/** Human-readable KeyboardEvent.code without importing HUD and creating a cycle. */
export function keyCodeLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6).toUpperCase()}`;
  if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();
  const labels = {
    Space: 'SPACE', Escape: 'ESC', Enter: 'ENTER', Tab: 'TAB', Backspace: 'BKSP',
    ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT', ControlLeft: 'L CTRL',
    ControlRight: 'R CTRL', AltLeft: 'L ALT', AltRight: 'R ALT', CapsLock: 'CAPS',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`',
    Backslash: '\\', Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=',
    PageUp: 'PG UP', PageDown: 'PG DN', Home: 'HOME', End: 'END', Insert: 'INS', Delete: 'DEL',
    Mouse1: 'MOUSE 1', Mouse2: 'MOUSE 2', Mouse3: 'MOUSE 3', Mouse4: 'MOUSE 4', Mouse5: 'MOUSE 5',
  };
  return labels[code] || String(code).toUpperCase();
}

/** Resolve the live scoreboard action. There is deliberately no TAB fallback. */
export function scoreboardBindingLabel(settings) {
  const snapshot = settings?.getSnapshot?.();
  const actionSlots = snapshot?.bindings?.scoreboard ?? settings?.bindings?.scoreboard;
  if (actionSlots && typeof actionSlots === 'object') {
    const codes = [actionSlots.primary, actionSlots.secondary]
      .filter((code) => typeof code === 'string' && code);
    return codes.length ? codes.map(keyCodeLabel).join(' / ') : 'UNBOUND';
  }

  const binds = settings?.get?.('binds') ?? settings?.data?.binds;
  if (!binds || typeof binds !== 'object') return 'UNBOUND';
  const codes = Object.entries(binds)
    .filter(([, action]) => action === 'scoreboard')
    .map(([code]) => code);
  return codes.length ? codes.map(keyCodeLabel).join(' / ') : 'UNBOUND';
}

/**
 * Accept RTT only with the measurement/freshness fields frozen in net-facade §5.2.
 * `rttMs` by itself is indistinguishable from a cached, guessed, or synthetic number.
 */
export function measuredRttMs(netStats) {
  if (!netStats || typeof netStats !== 'object'
    || !finite(netStats.rttMs) || netStats.rttMs < 0
    || !finite(netStats.sampledAt) || netStats.sampledAt < 0
    || !finite(netStats.windowMs) || netStats.windowMs <= 0
    || !finite(netStats.snapshotAgeMs) || netStats.snapshotAgeMs < 0) return null;
  return Math.round(netStats.rttMs);
}

function bombRounds(match) {
  const rounds = match?.bombRules?.rounds ?? match?.roundHistory ?? match?.rounds;
  return Array.isArray(rounds) ? rounds : [];
}

/** Compact public history; invalid/unrecognized fields remain visibly unknown. */
export function scoreboardRoundHistory(match) {
  return bombRounds(match).slice(-12).map((round, index) => {
    const number = nonNegativeInt(round?.round) ?? index + 1;
    const winner = round?.winnerTeam === 0 ? 'A' : round?.winnerTeam === 1 ? 'B' : '—';
    const reason = ROUND_REASON[round?.reason] || '—';
    return `R${number} ${winner} ${reason}`;
  }).join(' · ');
}

function bombClock(match, externalTime) {
  if (finite(match?.phaseRemainingMs) && match.phaseRemainingMs >= 0) return match.phaseRemainingMs / 1000;
  if (typeof match?.mode?.hudTime === 'function') {
    const value = match.mode.hudTime(match);
    if (finite(value) && value >= 0) return value;
  }
  if (finite(match?.bombRules?.displayTime) && match.bombRules.displayTime >= 0) return match.bombRules.displayTime;
  return finite(externalTime) && externalTime >= 0 ? externalTime : null;
}

function teamScore(match, team, bomb = false) {
  if (bomb) {
    const roundWins = match?.bombRules?.roundWins?.[team];
    if (nonNegativeInt(roundWins) !== null) return roundWins;
  }
  const direct = match?.scores?.[team];
  if (nonNegativeInt(direct) !== null) return direct;
  const projected = match?.teams?.[team === 0 ? 'alpha' : 'bravo']?.score;
  return nonNegativeInt(projected);
}

function teamAlive(match, rows, team) {
  const projected = match?.aliveCounts?.[team === 0 ? 'alpha' : 'bravo'];
  if (nonNegativeInt(projected) !== null) return projected;
  if (rows.some((row) => (row?.team === team) && typeof row?.alive !== 'boolean')) return null;
  return rows.reduce((count, row) => count + (row?.team === team && row?.alive === true ? 1 : 0), 0);
}

function roundNumber(match) {
  const direct = nonNegativeInt(match?.roundNumber);
  if (direct !== null && direct > 0) return direct;
  const index = nonNegativeInt(match?.round?.index ?? match?.roundIndex);
  return index === null ? null : index + 1;
}

function bombObjective(match) {
  const number = roundNumber(match);
  const prefix = number === null ? 'ROUND —' : `ROUND ${number}`;
  const phase = match?.roundPhase ?? match?.phase;
  const bomb = match?.bomb ?? match?.bombRules?.bomb;
  if (phase === 'planted' || bomb?.state === 'planted') {
    const site = bomb?.siteId === 'A' || bomb?.siteId === 'B' ? ` · SITE ${bomb.siteId}` : '';
    return `${prefix} · BOMB PLANTED${site}`;
  }
  if (phase === 'freeze') return `${prefix} · PREPARE`;
  if (phase === 'roundEnd') return `${prefix} · ROUND COMPLETE`;
  if (phase === 'matchEnd' || match?.phase === 'ended') return 'MATCH COMPLETE';
  return `${prefix} · ${String(match?.mode?.hudLabels?.objective || 'PLANT THE BOMB — OR STOP IT')}`;
}

function teamRole(match, team) {
  // bomb-rules §13.1: symmetric demolition has no attackers or defenders — each team is
  // named by the site it DEFENDS. The referee (or a staged view) publishes `homeSites`.
  const home = match?.homeSites?.[team];
  if (home === 'A' || home === 'B') return `DEFENDS ${home}`;
  // Pre-2.0.0 staged views may still speak the old vocabulary.
  const projected = match?.teams?.[team === 0 ? 'alpha' : 'bravo']?.role;
  if (projected === 'attacker') return 'ATTACKERS';
  if (projected === 'defender') return 'DEFENDERS';
  if (match?.attackingTeam === 0 || match?.attackingTeam === 1) {
    return match.attackingTeam === team ? 'ATTACKERS' : 'DEFENDERS';
  }
  return 'ROLE UNKNOWN';
}

/** Pure header projection used by the DOM view and focused tests. */
export function projectScoreboardHeader(match, rows = [], externalTime = null) {
  const bomb = isBombMatch(match);
  const alpha = teamName(match, 0, 'ALPHA');
  const bravo = teamName(match, 1, 'BRAVO');
  const seconds = bomb
    ? bombClock(match, externalTime)
    : finite(match?.timeRemaining) && match.timeRemaining >= 0 ? match.timeRemaining
      : finite(externalTime) && externalTime >= 0 ? externalTime : null;
  const completeAliveProjection = rows.every((row) => typeof row?.alive === 'boolean');
  const alive = completeAliveProjection
    ? rows.reduce((count, row) => count + (row.alive === true ? 1 : 0), 0)
    : null;
  const alphaAlive = bomb ? teamAlive(match, rows, 0) : null;
  const bravoAlive = bomb ? teamAlive(match, rows, 1) : null;
  const killLimit = nonNegativeInt(match?.killLimit);
  return Object.freeze({
    bomb,
    mode: String(match?.modeName || modeLabel(match?.mode)),
    objective: bomb
      ? bombObjective(match)
      : [String(match?.mode?.hudLabels?.objective || ''), killLimit === null ? '' : `FIRST TO ${killLimit}`]
        .filter(Boolean).join(' · '),
    clock: seconds === null ? '—:—' : formatClock(seconds),
    alive: bomb
      ? `${alpha} ${alphaAlive ?? '—'} ALIVE · ${bravo} ${bravoAlive ?? '—'} ALIVE`
      : `${alive ?? '—'} ALIVE / ${rows.length}`,
    scores: Object.freeze([
      displayInt(teamScore(match, 0, bomb)),
      displayInt(teamScore(match, 1, bomb)),
    ]),
    teamLabels: Object.freeze(bomb
      ? [`${alpha} · ${teamRole(match, 0)}`, `${bravo} · ${teamRole(match, 1)}`]
      : [alpha, bravo]),
    history: bomb ? scoreboardRoundHistory(match) : '',
  });
}

function connectionState(row, netView) {
  const value = row?.connectionState ?? row?.connection?.state ?? (row?.isPlayer ? netView?.state : null);
  return CONNECTION_STATES.has(value) ? value : null;
}

/** Pure row projection. Raw numbers are never retained by the DOM pool. */
export function projectScoreboardRow(row, { bomb = false, netView = null } = {}) {
  const kills = nonNegativeInt(row?.kills);
  const deaths = nonNegativeInt(row?.deaths);
  const accuracy = finite(row?.accuracy) && row.accuracy >= 0 && row.accuracy <= 1
    ? `${Math.round(row.accuracy * 100)}%` : '—';
  const kd = finite(row?.kd) && row.kd >= 0
    ? row.kd
    : kills !== null && deaths !== null ? (deaths > 0 ? kills / deaths : kills) : null;
  const state = connectionState(row, netView);
  const netStats = row?.netStats ?? (row?.isPlayer ? netView?.netStats : null);
  const rttMs = measuredRttMs(netStats);
  let status = row?.alive === true ? 'ALIVE' : row?.alive === false ? 'OUT' : 'UNKNOWN';
  if (state === 'reconnecting') status = 'RECONNECTING';
  else if (state === 'connecting') status = 'CONNECTING';
  else if (state === 'closed' || state === 'version-mismatch' || state === 'rejected') status = 'DISCONNECTED';
  return Object.freeze({
    name: String(row?.name || 'OPERATOR').toUpperCase(),
    kills: displayInt(row?.kills),
    deaths: displayInt(row?.deaths),
    assists: displayInt(row?.assists),
    kd: kd === null ? '—' : kd.toFixed(2),
    accuracy,
    score: displayInt(row?.score),
    bestStreak: nonNegativeInt(row?.bestStreak) > 0 ? String(row.bestStreak) : '—',
    plants: displayInt(row?.plants),
    defuses: displayInt(row?.defuses),
    status,
    rttMs: rttMs === null ? '—' : String(rttMs),
    bomb,
  });
}

export class Scoreboard {
  constructor(game, root, { netView = null } = {}) {
    this.game = game;
    this.netView = netView;
    this.visible = false;
    this._acc = 0;
    this._modeTxt = '';
    this._objTxt = '';
    this._clockTxt = '';
    this._historyTxt = '';
    this._bindingTxt = '';
    this._bombLayout = null;
    this._extTime = null;

    const el = document.createElement('div');
    el.className = 'sb';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Match scoreboard');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="sb-head">
        <div class="sb-title">
          <span class="sb-mode">SKIRMISH</span>
          <span class="sb-obj"></span>
          <span class="sb-obj sb-history" aria-label="Round history"></span>
        </div>
        <div class="sb-meta">
          <span class="sb-alive">—</span>
          <span class="sb-timebox">TIME <b class="sb-clock">—:—</b></span>
        </div>
      </div>
      <div class="sb-cols"></div>
      <div class="sb-foot">
        <span>HOLD <i class="kbd sb-binding">UNBOUND</i></span>
        <span class="sb-legend">K KILLS · D DEATHS · A ASSISTS · ACC ACCURACY · STK BEST STREAK · MS MEASURED RTT</span>
      </div>`;
    root?.appendChild(el);

    this.el = el;
    this.modeEl = el.querySelector('.sb-mode');
    this.objEl = el.querySelector('.sb-obj:not(.sb-history)');
    this.historyEl = el.querySelector('.sb-history');
    this.clockEl = el.querySelector('.sb-clock');
    this.aliveEl = el.querySelector('.sb-alive');
    this.colsEl = el.querySelector('.sb-cols');
    this.bindingEl = el.querySelector('.sb-binding');
    this.legendEl = el.querySelector('.sb-legend');

    this.columns = [this._makeColumn(0, 'ALPHA'), this._makeColumn(1, 'BRAVO')];
    for (const column of this.columns) this.colsEl.appendChild(column.el);

    /** Reused row buckets — refresh() must not allocate these arrays. */
    this._buckets = [[], []];
  }

  _makeColumn(team, name) {
    const el = document.createElement('div');
    el.className = `sb-col ${team === 0 ? 'a' : 'b'}`;
    el.setAttribute('role', 'table');
    el.setAttribute('aria-label', `${name} team scoreboard`);

    const head = document.createElement('div');
    head.className = 'sb-team';
    head.innerHTML = `<span class="nm">${name}</span><span class="pts num">—</span>`;
    el.appendChild(head);

    const hdr = document.createElement('div');
    hdr.className = 'sb-hdr';
    hdr.setAttribute('role', 'row');
    hdr.innerHTML = '<span>OPERATOR</span><span>K</span><span>D</span><span>A</span>'
      + '<span>K/D</span><span>ACC</span><span>SCORE</span><span>STK</span><span>MS</span>';
    for (const cell of hdr.children) cell.setAttribute('role', 'columnheader');
    el.appendChild(hdr);

    const rows = [];
    for (let i = 0; i < POOL_PER_COL; i++) {
      const element = document.createElement('div');
      element.className = 'sb-row';
      element.setAttribute('role', 'row');
      element.style.display = 'none';
      element.innerHTML = '<span class="nm"></span><span class="k num"></span><span class="d num"></span>'
        + '<span class="a num"></span><span class="kd num"></span><span class="acc num"></span>'
        + '<span class="sc num"></span><span class="stk num"></span><span class="png num"></span>';
      for (const cell of element.children) cell.setAttribute('role', 'cell');
      el.appendChild(element);
      rows.push({
        el: element,
        nm: element.querySelector('.nm'), k: element.querySelector('.k'), d: element.querySelector('.d'),
        a: element.querySelector('.a'), kd: element.querySelector('.kd'), acc: element.querySelector('.acc'),
        sc: element.querySelector('.sc'), stk: element.querySelector('.stk'), png: element.querySelector('.png'),
        shown: false, cache: '',
      });
    }

    return {
      el, head, hdr, headerCells: [...hdr.querySelectorAll('span')],
      pts: head.querySelector('.pts'), label: head.querySelector('.nm'), rows, team, name,
    };
  }

  setVisible(value) {
    const visible = !!value;
    if (visible === this.visible) return;
    this.visible = visible;
    this.el.classList.toggle('on', visible);
    this.el.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (visible) { this._acc = 999; this.refresh(); }
  }

  toggle() { this.setVisible(!this.visible); }

  update(dt) {
    if (!this.visible) return;
    this._acc += dt;
    if (this._acc < 1 / REFRESH_HZ) return;
    this._acc = 0;
    this.refresh();
  }

  refresh() {
    const game = this.game;
    const match = game?.match;
    if (!match || typeof match.getScoreboardRows !== 'function') return;
    const rows = match.getScoreboardRows();
    const header = projectScoreboardHeader(match, rows, this._extTime);
    this._setLayout(header.bomb);

    this._writeCached(this.modeEl, '_modeTxt', header.mode);
    this._writeCached(this.objEl, '_objTxt', header.objective);
    this._writeCached(this.clockEl, '_clockTxt', header.clock);
    this._writeCached(this.historyEl, '_historyTxt', header.history);
    this.historyEl.title = header.history;
    this._setText(this.aliveEl, header.alive);
    this._setText(this.columns[0].label, header.teamLabels[0]);
    this._setText(this.columns[1].label, header.teamLabels[1]);
    this._setText(this.columns[0].pts, header.scores[0]);
    this._setText(this.columns[1].pts, header.scores[1]);

    const binding = scoreboardBindingLabel(game?.settings);
    this._writeCached(this.bindingEl, '_bindingTxt', binding);

    const alpha = this._buckets[0];
    const bravo = this._buckets[1];
    alpha.length = 0;
    bravo.length = 0;
    for (let i = 0; i < rows.length; i++) (rows[i]?.team === 1 ? bravo : alpha).push(rows[i]);

    this._fill(this.columns[0], alpha, game.player, header.bomb);
    this._fill(this.columns[1], bravo, game.player, header.bomb);
  }

  _setLayout(bomb) {
    if (this._bombLayout === bomb) return;
    this._bombLayout = bomb;
    this.el.dataset.mode = bomb ? 'bomb' : 'tdm';
    const labels = bomb
      ? ['OPERATOR', 'K', 'D', 'A', 'PLT', 'DEF', 'SCORE', 'STATE', 'MS']
      : ['OPERATOR', 'K', 'D', 'A', 'K/D', 'ACC', 'SCORE', 'STK', 'MS'];
    for (const column of this.columns) {
      for (let i = 0; i < labels.length; i++) this._setText(column.headerCells[i], labels[i]);
      for (const row of column.rows) row.cache = '';
    }
    this._setText(this.legendEl, bomb
      ? 'K KILLS · D DEATHS · A ASSISTS · PLT PLANTS · DEF DEFUSES · MS MEASURED RTT'
      : 'K KILLS · D DEATHS · A ASSISTS · ACC ACCURACY · STK BEST STREAK · MS MEASURED RTT');
  }

  _setText(element, text) { if (element && element.textContent !== text) element.textContent = text; }

  _writeCached(element, key, text) {
    if (this[key] === text) return;
    this[key] = text;
    this._setText(element, text);
  }

  _fill(column, source, me, bomb) {
    const rows = column.rows;
    const count = Math.min(source.length, rows.length);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i >= count) {
        if (row.shown) { row.shown = false; row.el.style.display = 'none'; row.cache = ''; }
        continue;
      }
      const sourceRow = source[i];
      const projected = projectScoreboardRow(sourceRow, { bomb, netView: this.netView });
      const isMe = !!me && sourceRow.isPlayer;
      const fifth = bomb ? projected.plants : projected.kd;
      const sixth = bomb ? projected.defuses : projected.accuracy;
      const eighth = bomb ? projected.status : projected.bestStreak;
      const signature = `${projected.name}|${projected.kills}|${projected.deaths}|${projected.assists}`
        + `|${fifth}|${sixth}|${projected.score}|${eighth}|${projected.rttMs}`
        + `|${sourceRow.alive === true ? 1 : sourceRow.alive === false ? 0 : 'u'}`;
      if (row.cache === signature) {
        if (!row.shown) { row.shown = true; row.el.style.display = ''; }
        continue;
      }
      row.cache = signature;

      row.nm.textContent = projected.name;
      row.nm.className = `nm${sourceRow.alive === false ? ' dead' : ''}`;
      row.k.textContent = projected.kills;
      row.d.textContent = projected.deaths;
      row.a.textContent = projected.assists;
      row.kd.textContent = fifth;
      row.acc.textContent = sixth;
      row.sc.textContent = projected.score;
      row.stk.textContent = eighth;
      row.stk.className = `stk num${!bomb && nonNegativeInt(sourceRow.bestStreak) >= 3 ? ' hot' : ''}`;
      row.png.textContent = projected.rttMs;
      row.png.className = `png num${projected.rttMs === '—' ? '' : ' measured'}`;
      row.el.className = `sb-row${isMe ? ' me' : ''}${sourceRow.alive === false ? ' out' : ''}`;
      if (!row.shown) { row.shown = true; row.el.style.display = ''; }
    }
  }

  /** HUD pushes its authoritative clock; Bomb still prefers its explicit phase clock. */
  setTime(seconds) { this._extTime = finite(seconds) && seconds >= 0 ? seconds : null; }

  reset() {
    this._modeTxt = '';
    this._objTxt = '';
    this._clockTxt = '';
    this._historyTxt = '';
    this._bindingTxt = '';
    this._bombLayout = null;
    this._extTime = null;
    for (const column of this.columns) {
      for (const row of column.rows) { row.cache = ''; row.shown = false; row.el.style.display = 'none'; }
    }
  }

  dispose() { this.el.remove(); }
}

function teamName(match, team, fallback) {
  const direct = match?.teamNames?.[team];
  const projected = match?.teams?.[team === 0 ? 'alpha' : 'bravo']?.name;
  return String(direct || projected || fallback).toUpperCase();
}
