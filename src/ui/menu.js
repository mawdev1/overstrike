import { DEFAULTS } from '../core/settings.js';
import { MODE_LIST, bombAvailable } from '../game/modes.js';
import { PRIMARIES, SECONDARIES, WEAPON_LIST } from '../weapons/weaponDefs.js';
import { progression, LEVEL_MAX } from '../game/progression.js';
import { keyLabel } from './hud.js';
import { weaponGlyph } from './killfeed.js';
import { modeLabel, formatClock } from './scoreboard.js';

/**
 * Menu — the whole front end, mounted in `#ui`.
 *
 * Three "shells" share one DOM tree: MAIN (front end), PAUSE (mid-match) and
 * END (match results). Each shell swaps the nav rail and its default panel;
 * the panels themselves are built once and reused.
 *
 * Everything here reads a real API:
 *   mode       `game.match.modeList` (one-entry MODE_LIST) — TDM metadata straight off
 *              the rule object; the per-round kill limit comes from settings/Match
 *   weapons    `PRIMARIES` / `SECONDARIES` from weaponDefs.js — a STATIC import;
 *              the loadout panel is core UI and must never silently degrade
 *   unlocks    `progression.getLevel()` vs `def.unlockLevel`
 *   equipping  `game.weapons.giveLoadout(entity, ids)` — the real signature
 *   settings   `settings.get/set` only. `mode`, `loadoutPrimary` and
 *              `loadoutSecondary` are in DEFAULTS, so they persist by themselves
 *   results    the `matchEnd` payload built by Match._end(): rows, moments,
 *              progression, outcome, winnerName, teamNames, duration
 *
 * Pointer-lock contract: Escape is handled by the browser (it drops the lock),
 * we react to the resulting `pointerUnlock` bus event and open the pause shell.
 * While any shell is open `#ui` takes pointer events, so a click aimed at the
 * canvas can never re-acquire the lock behind an open panel.
 */

const DIFFICULTIES = [
  { id: 'recruit', name: 'RECRUIT', desc: 'Slow to react, poor aim. Learn the sector.' },
  { id: 'regular', name: 'REGULAR', desc: 'Competent. Uses cover, trades evenly.' },
  { id: 'hardened', name: 'HARDENED', desc: 'Fast acquisition, flanks, punishes mistakes.' },
  { id: 'veteran', name: 'VETERAN', desc: 'Near-instant reactions and brutal accuracy.' },
];

const BIND_ACTIONS = [
  ['forward', 'Move forward'], ['back', 'Move back'], ['left', 'Strafe left'], ['right', 'Strafe right'],
  ['jump', 'Jump'], ['sprint', 'Sprint'], ['crouch', 'Crouch / slide'], ['lean', 'Lean'],
  ['reload', 'Reload'], ['melee', 'Melee'], ['grenade', 'Throw grenade'], ['interact', 'Interact'],
  ['drop', 'Drop item'],
  ['weapon1', 'Primary weapon'], ['weapon2', 'Secondary weapon'], ['weapon3', 'Tertiary / special'],
  ['lastWeapon', 'Last weapon'], ['killstreak', 'Killstreak'], ['inspect', 'Inspect weapon'],
  ['scoreboard', 'Scoreboard (hold)'],
];

const CROSSHAIR_SWATCHES = ['#8ef7c4', '#ffffff', '#ffb347', '#ff4a35', '#58c9ff', '#c58cff', '#9dff3d'];

/** Short label for the XP breakdown rows produced by `progression.recordMatch()`. */
const XP_ROWS = [
  ['kills', 'ELIMINATIONS'], ['headshots', 'HEADSHOTS'], ['longshots', 'LONGSHOTS'],
  ['assists', 'ASSISTS'], ['confirms', 'TAGS CONFIRMED'], ['denies', 'TAGS DENIED'],
  ['captures', 'CAPTURES'], ['defends', 'DEFENCES'], ['streaks', 'KILLSTREAKS'],
  ['score', 'SCORE BONUS'], ['completion', 'MATCH COMPLETE'], ['win', 'VICTORY BONUS'],
];

/* ---------------------------------------------------------------- schema -- */
/** Every key in settings DEFAULTS is represented here except `binds`. */
const SCHEMA = {
  video: [
    { grp: 'Camera' },
    { k: 'fov', label: 'Field of view', hint: 'Vertical FOV in degrees', type: 'range', min: 60, max: 120, step: 1, fmt: (v) => `${v | 0}°` },
    { grp: 'Rendering' },
    { k: 'renderScale', label: 'Render scale', hint: 'Internal resolution multiplier', type: 'range', min: 0.5, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
    { k: 'shadows', label: 'Shadows', type: 'toggle' },
    { k: 'shadowQuality', label: 'Shadow quality', type: 'seg', options: [['off', 'OFF'], ['low', 'LOW'], ['high', 'HIGH']] },
    { k: 'maxFps', label: 'Frame cap', type: 'seg', options: [[0, 'OFF'], [60, '60'], [75, '75'], [120, '120'], [144, '144'], [240, '240']] },
    { grp: 'Post processing' },
    { k: 'postFx', label: 'Post FX', hint: 'Bloom, aberration and composite', type: 'toggle' },
    { k: 'filmGrain', label: 'Film grain', type: 'toggle' },
    { k: 'motionBlur', label: 'Motion blur', type: 'toggle' },
    { k: 'vignette', label: 'Vignette', type: 'toggle' },
    { grp: 'Diagnostics' },
    { k: 'showFps', label: 'Performance readout', hint: 'FPS, frame time, draw calls', type: 'toggle' },
  ],
  audio: [
    { grp: 'Mix' },
    { k: 'masterVolume', label: 'Master', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'sfxVolume', label: 'Effects', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'musicVolume', label: 'Music', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
  ],
  gameplay: [
    { grp: 'Aiming' },
    { k: 'sensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.1, max: 4, step: 0.01, fmt: (v) => Number(v).toFixed(2) },
    { k: 'adsSensitivity', label: 'ADS sensitivity', hint: 'Multiplier applied while aiming', type: 'range', min: 0.1, max: 2, step: 0.01, fmt: (v) => Number(v).toFixed(2) },
    { k: 'invertY', label: 'Invert vertical look', type: 'toggle' },
    { grp: 'Handling' },
    { k: 'toggleAds', label: 'Toggle to aim', hint: 'Off = hold right mouse', type: 'toggle' },
    { k: 'toggleCrouch', label: 'Toggle crouch', type: 'toggle' },
    { k: 'autoSprint', label: 'Auto sprint', type: 'toggle' },
    { grp: 'Match defaults' },
    { k: 'difficulty', label: 'Bot difficulty', type: 'seg', options: DIFFICULTIES.map((d) => [d.id, d.name]) },
    { k: 'botCount', label: 'Bot count', type: 'range', min: 0, max: 15, step: 1, fmt: (v) => String(v | 0) },
    { k: 'killLimit', label: 'Team kill limit', hint: 'First team to this many kills wins', type: 'range', min: 5, max: 200, step: 5, fmt: (v) => String(v | 0) },
  ],
  hud: [
    { grp: 'Reticle' },
    { k: 'crosshairStyle', label: 'Crosshair style', type: 'seg', options: [['dynamic', 'DYNAMIC'], ['static', 'STATIC'], ['dot', 'DOT']] },
    { k: 'crosshairColor', label: 'Crosshair colour', type: 'color' },
    { grp: 'Overlay' },
    { k: 'hudScale', label: 'HUD scale', type: 'range', min: 0.7, max: 1.6, step: 0.05, fmt: pct },
    { k: 'showMinimap', label: 'Minimap', type: 'toggle' },
    { k: 'showDamageNumbers', label: 'Damage numbers', type: 'toggle' },
  ],
};

function pct(v) { return `${Math.round(Number(v) * 100)}%`; }

/* --------------------------------------------------------------- helpers -- */
function h(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

export class Menu {
  constructor(game) {
    this.game = game;
    this.mount = document.getElementById('ui') || document.body;
    this.shell = null;              // null | 'main' | 'pause' | 'end'
    this.panel = 'home';
    this.settings = game?.settings;
    this._controls = new Map();     // setting key -> [refresh fns]
    this._unsubs = [];
    this._capturing = null;
    this._endData = null;
    this._suppressUnlock = false;

    /**
     * The selectable arsenal, split by the `slot` field the defs already carry.
     * A static import: `weaponDefs.js` is a leaf data module with no cycles, and a
     * dynamic import here both degraded the panel silently and produced a build
     * warning because six other modules import it statically anyway.
     */
    this._pools = {
      primary: PRIMARIES.length ? PRIMARIES : WEAPON_LIST,
      secondary: SECONDARIES.length ? SECONDARIES : WEAPON_LIST,
    };
    this._slot = 'primary';
    this._pick = { primary: null, secondary: null };

    /**
     * `open()` runs on the pause frame, mid-match, every single time Escape drops
     * pointer lock. Rebuilding the nav, the mode cards, the bind rows, the weapon
     * list and the dossier there costs ~1500 element creations and ~175 listener
     * registrations plus the style recalc and layout they force — a guaranteed
     * hitch, and almost all of it recreates markup that is already correct.
     *
     * So every builder is idempotent behind one of these. The rule is: a flag is
     * raised by whatever can actually change what the builder renders, and the
     * builder is the only thing that lowers it. A stale panel is a worse bug than
     * a hitch, so the invalidation side is deliberately generous.
     */
    this._dirty = {
      modes: true,      // the mode roster (static, but built lazily) + card state
      binds: true,      // settings.binds
      loadout: true,    // loadoutPrimary/Secondary, or the unlock level moving
    };
    this._navShell = null;   // the shell the nav rail was last built for
    this._hdrStamp = '';     // progression signature the header was painted from
    this._dosStamp = '';     // ... and the dossier
    this._unlockLvl = -1;    // rank the weapon list's lock state was built at

    this._build();
    this._bind();
  }

  async init() {
    this._readLoadout();
    this._buildLoadout();
    this._dirty.loadout = false;
    this._unlockLvl = progression.getLevel();
    this._refreshAll();
    if (this.game?.state === 'menu' || this.game?.state === 'boot') this.open('main');
    return this;
  }

  /**
   * Cheap signature for everything the dossier and the header render.
   * `updatedAt` is bumped by `Progression.save()`, which every award and every
   * recorded match goes through, so this moves whenever the numbers do.
   */
  _progSig() {
    const d = progression.data;
    return `${progression.getAuthority()}|${d.level}|${d.xp}|${d.updatedAt}`;
  }

  /* ======================================================================
     DOM
     ====================================================================== */

  _build() {
    const root = h('div', 'menu');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'OVERSTRIKE menu');

    root.appendChild(h('div', 'menu-bg'));

    // ---- header ----
    const head = h('div', 'menu-head', `
      <div class="brand">
        <div class="word">OVER<em>STRIKE</em></div>
        <div class="tag">tactical engagement simulator</div>
        <div class="rule"></div>
      </div>
      <div class="sys">
        <div class="sys-rank">RANK <b class="sys-lvl">1</b> <span class="sys-rankname">RECRUIT</span></div>
        <div class="sys-xp"><i></i></div>
        <div class="sys-line">SECTOR <b class="sys-map">UNASSIGNED</b></div>
        <div class="pause-note" style="display:none"><i></i>SIMULATION PAUSED</div>
      </div>`);
    root.appendChild(head);

    // ---- body ----
    const body = h('div', 'menu-body');
    const nav = h('div', 'menu-nav');
    nav.setAttribute('role', 'navigation');
    const stage = h('div', 'menu-stage');
    body.appendChild(nav);
    body.appendChild(stage);
    root.appendChild(body);

    // ---- panels ----
    this.panels = {
      home: this._panelHome(),
      status: this._panelStatus(),
      play: this._panelPlay(),
      loadout: this._panelLoadout(),
      settings: this._panelSettings(),
      controls: this._panelControls(),
      credits: this._panelCredits(),
      results: this._panelResults(),
    };
    for (const key in this.panels) stage.appendChild(this.panels[key]);

    // ---- footer ----
    const foot = h('div', 'menu-foot', `
      <div class="keys">
        <span><i class="kbd">↑</i><i class="kbd">↓</i> navigate</span>
        <span><i class="kbd">←</i><i class="kbd">→</i> adjust</span>
        <span><i class="kbd">↵</i> select</span>
        <span><i class="kbd">ESC</i> back</span>
      </div>
      <div class="right">ALL ASSETS GENERATED AT RUNTIME · ZERO NETWORK REQUESTS</div>`);
    root.appendChild(foot);

    // ---- confirm dialog ----
    const confirm = h('div', 'confirm', `
      <div class="confirm-box" role="alertdialog" aria-modal="true">
        <h3 class="cf-title">CONFIRM</h3>
        <p class="cf-body">Are you sure?</p>
        <div class="acts">
          <button class="btn ghost cf-no" data-nav type="button">CANCEL</button>
          <button class="btn warn cf-yes" data-nav type="button">CONFIRM</button>
        </div>
      </div>`);
    root.appendChild(confirm);

    // Screen-reader announcements for actions with no visual anchor.
    const live = h('div', 'sr-live');
    live.setAttribute('aria-live', 'polite');
    root.appendChild(live);

    this.mount.appendChild(root);

    this.el = {
      root, head, body, nav, stage, foot, confirm, live,
      sysMap: head.querySelector('.sys-map'),
      sysLvl: head.querySelector('.sys-lvl'),
      sysRank: head.querySelector('.sys-rankname'),
      sysXp: head.querySelector('.sys-xp i'),
      pauseNote: head.querySelector('.pause-note'),
      cfTitle: confirm.querySelector('.cf-title'),
      cfBody: confirm.querySelector('.cf-body'),
      cfYes: confirm.querySelector('.cf-yes'),
      cfNo: confirm.querySelector('.cf-no'),
    };

    this.el.cfNo.addEventListener('click', () => this._closeConfirm(false));
    this.el.cfYes.addEventListener('click', () => this._closeConfirm(true));
  }

  _panelShell(title, hint) {
    const p = h('div', 'panel');
    p.setAttribute('role', 'region');
    p.setAttribute('aria-label', title);
    p.appendChild(h('div', 'panel-head',
      `<div class="panel-title">${esc(title)}</div><div class="panel-hint">${esc(hint || '')}</div>`));
    const scroll = h('div', 'panel-scroll');
    p.appendChild(scroll);
    p._scroll = scroll;
    return p;
  }

  /* --------------------------------------------------- home / dossier ---- */

  /**
   * The front-end landing panel is the operator dossier: rank, XP, lifetime record
   * and challenge progress, all straight out of `progression`. Nothing here is
   * decorative filler — every number is one the after-action screen also banks.
   */
  _panelHome() {
    const p = this._panelShell('DOSSIER', 'operator record');
    const s = p._scroll;

    const rank = h('div', 'dossier');
    rank.innerHTML = `
      <div class="dg-rank">
        <div class="dg-badge"><span class="dg-lvl num">1</span><small>RANK</small></div>
        <div class="dg-meta">
          <div class="dg-title">RECRUIT</div>
          <div class="dg-bar"><i></i></div>
          <div class="dg-xp"><span class="dg-into num">0</span> / <span class="dg-need num">0</span> XP TO NEXT RANK</div>
          <div class="dg-next"></div>
        </div>
      </div>
      <div class="dg-stats"></div>`;
    s.appendChild(rank);

    s.appendChild(h('h4', 'sec-head', 'CHALLENGES'));
    const chal = h('div', 'challenges');
    s.appendChild(chal);

    this._dossier = {
      lvl: rank.querySelector('.dg-lvl'),
      title: rank.querySelector('.dg-title'),
      bar: rank.querySelector('.dg-bar i'),
      into: rank.querySelector('.dg-into'),
      need: rank.querySelector('.dg-need'),
      next: rank.querySelector('.dg-next'),
      stats: rank.querySelector('.dg-stats'),
      challenges: chal,
    };

    const foot = h('div', 'panel-foot');
    foot.appendChild(h('div', 'spacer'));
    const deploy = h('button', 'btn cta', 'QUICK DEPLOY');
    deploy.type = 'button';
    deploy.dataset.nav = '';
    deploy.addEventListener('click', () => this._deploy());
    foot.appendChild(deploy);
    p.appendChild(foot);
    return p;
  }

  _refreshDossier() {
    const d = this._dossier;
    if (!d) return;
    const sum = progression.getSummary();
    const st = progression.getStats();

    d.lvl.textContent = String(sum.level);
    d.title.textContent = sum.authority === 'server' ? 'SERVER CAREER' : sum.rank;
    d.bar.style.setProperty('--f', sum.ratio.toFixed(3));
    d.into.textContent = fmtInt(sum.intoLevel);
    d.need.textContent = sum.maxed ? '—' : fmtInt(sum.needed);
    if (sum.authority === 'server') {
      d.next.textContent = 'LOADOUT AND UNLOCKS ARE SERVER-AUTHORITATIVE';
    } else if (sum.maxed) {
      d.next.innerHTML = `<b>MAX RANK</b> — level ${LEVEL_MAX} reached.`;
    } else {
      const nxt = progression.getNextUnlock(WEAPON_LIST);
      d.next.innerHTML = nxt
        ? `NEXT UNLOCK <b>${esc(nxt.name)}</b> AT RANK ${nxt.unlockLevel}`
        : 'ALL WEAPONS UNLOCKED';
    }

    const rows = [
      ['MATCHES', fmtInt(st.matches)],
      ['W / L / D', `${st.wins} / ${st.losses} / ${st.draws}`],
      ['KILLS', fmtInt(st.kills)],
      ['K/D', st.kd.toFixed(2)],
      ['ACCURACY', `${Math.round(st.accuracy * 100)}%`],
      ['HEADSHOTS', fmtInt(st.headshots)],
      ['BEST STREAK', fmtInt(st.bestStreak)],
      ['LONGEST SHOT', `${st.longestShot.toFixed(0)} M`],
      ['TIME IN SECTOR', fmtDuration(st.playtime)],
    ];
    let html = '';
    for (const [k, v] of rows) html += `<div class="dg-stat"><span class="k">${k}</span><span class="v num">${esc(v)}</span></div>`;
    d.stats.innerHTML = html;

    let ch = '';
    for (const c of progression.getChallenges()) {
      ch += `<div class="chal${c.done ? ' done' : ''}">
        <div class="ch-top"><span class="ch-n">${esc(c.name)}</span><span class="ch-x num">+${fmtInt(c.xp)} XP</span></div>
        <div class="ch-d">${esc(c.desc)}</div>
        <div class="ch-bar"><i style="--f:${c.ratio.toFixed(3)}"></i></div>
        <div class="ch-v num">${fmtInt(c.value)} / ${fmtInt(c.goal)}</div>
      </div>`;
    }
    d.challenges.innerHTML = sum.authority === 'server'
      ? '<div class="mouse-note">Practice challenges are not used in authenticated matches.</div>'
      : ch || '<div class="mouse-note">No challenges registered.</div>';
  }

  /* ------------------------------------------------- pause status panel -- */

  /** The pause shell's default panel: what is actually happening right now. */
  _panelStatus() {
    const p = this._panelShell('SITUATION', 'live engagement');
    const s = p._scroll;
    const box = h('div', 'situation');
    box.innerHTML = `
      <div class="si-head">
        <div class="si-mode">—</div>
        <div class="si-obj">—</div>
      </div>
      <div class="si-score">
        <div class="si-team a"><span class="nm">ALPHA</span><span class="v num">0</span></div>
        <div class="si-clock"><span class="k">TIME LEFT</span><span class="v num">0:00</span></div>
        <div class="si-team b"><span class="nm">BRAVO</span><span class="v num">0</span></div>
      </div>
      <div class="si-you"></div>`;
    s.appendChild(box);
    s.appendChild(h('div', 'mouse-note',
      'Press <b>ESC</b> or <b>RESUME</b> to return to the fight. Changing your loadout now takes effect on your next respawn.'));

    this._statusEl = {
      mode: box.querySelector('.si-mode'),
      obj: box.querySelector('.si-obj'),
      a: box.querySelector('.si-team.a .v'),
      b: box.querySelector('.si-team.b .v'),
      an: box.querySelector('.si-team.a .nm'),
      bn: box.querySelector('.si-team.b .nm'),
      clock: box.querySelector('.si-clock .v'),
      you: box.querySelector('.si-you'),
    };
    return p;
  }

  _refreshStatus() {
    const el = this._statusEl;
    const m = this.game?.match;
    if (!el || !m) return;
    el.mode.textContent = String(m.modeName || modeLabel(m.mode));
    el.obj.textContent = `${String(m.mode?.hudLabels?.objective || m.mode?.description || '')} · FIRST TO ${m.killLimit | 0}`;
    const lab = m.mode?.hudLabels;
    el.an.textContent = String(lab?.left || m.teamNames[0] || 'ALPHA');
    el.bn.textContent = String(lab?.right || m.teamNames[1] || 'BRAVO');
    el.a.textContent = String(m.scores[0] | 0);
    el.b.textContent = String(m.scores[1] | 0);
    el.clock.textContent = formatClock(m.timeRemaining);

    const row = m.getPlayerStats();
    if (!row) { el.you.innerHTML = ''; return; }
    const kd = row.deaths > 0 ? (row.kills / row.deaths).toFixed(2) : row.kills.toFixed(2);
    const acc = row.shotsFired > 0 ? Math.round((row.shotsHit / row.shotsFired) * 100) : 0;
    el.you.innerHTML = `
      <div class="si-you-h">YOUR LINE</div>
      <div class="si-cells">
        <div><span class="k">KILLS</span><span class="v num">${row.kills}</span></div>
        <div><span class="k">DEATHS</span><span class="v num">${row.deaths}</span></div>
        <div><span class="k">ASSISTS</span><span class="v num">${row.assists}</span></div>
        <div><span class="k">K/D</span><span class="v num">${kd}</span></div>
        <div><span class="k">ACCURACY</span><span class="v num">${acc}%</span></div>
        <div><span class="k">STREAK</span><span class="v num">${row.streak}</span></div>
        <div><span class="k">SCORE</span><span class="v num">${fmtInt(row.score)}</span></div>
      </div>`;
  }

  /* ------------------------------------------------------------ play ---- */

  _panelPlay() {
    const p = this._panelShell('OPERATION', 'configure and deploy');
    const s = p._scroll;

    const modes = h('div', 'modes');
    s.appendChild(modes);
    this._modesEl = modes;

    // Bot count and difficulty live in settings, so this panel and the
    // Gameplay tab are two views of the same value and stay in lockstep.
    const grp = h('div', 'grp', '<h4>Opposition</h4>');
    grp.appendChild(this._schemaRow(
      { ...SCHEMA.gameplay.find((x) => x.k === 'botCount'), hint: 'Hostiles and allies filling the sector' }));
    grp.appendChild(this._schemaRow(
      { ...SCHEMA.gameplay.find((x) => x.k === 'difficulty'), hint: 'Reaction time, accuracy and aggression' }));
    grp.appendChild(this._schemaRow(
      { ...SCHEMA.gameplay.find((x) => x.k === 'killLimit'), hint: 'First team to this many eliminations wins the round' }));
    const dhint = h('div', 'diff-hint');
    grp.appendChild(dhint);
    this._diffHint = dhint;
    this._reg('difficulty', () => { this._paintDifficultyHint(); this._paintDeploySummary(); });
    s.appendChild(grp);

    const foot = h('div', 'panel-foot');
    const summary = h('div', 'deploy-sum');
    foot.appendChild(summary);
    this._deploySum = summary;
    foot.appendChild(h('div', 'spacer'));
    const deploy = h('button', 'btn cta', 'DEPLOY');
    deploy.type = 'button';
    deploy.dataset.nav = '';
    deploy.addEventListener('click', () => this._deploy());
    foot.appendChild(deploy);
    p.appendChild(foot);

    this._reg('botCount', () => this._paintDeploySummary());
    this._reg('killLimit', () => { this._buildModes(); this._paintDeploySummary(); });

    return p;
  }

  _paintDifficultyHint() {
    if (!this._diffHint) return;
    const id = this.settings?.get('difficulty') ?? DEFAULTS.difficulty;
    const d = DIFFICULTIES.find((x) => x.id === id);
    this._diffHint.textContent = d ? d.desc : '';
  }

  _paintDeploySummary() {
    if (!this._deploySum) return;
    const m = this._modes().find((x) => x.id === this._mode);
    const bots = (this.settings?.get('botCount') ?? DEFAULTS.botCount) | 0;
    const kills = (this.settings?.get('killLimit') ?? DEFAULTS.killLimit) | 0;
    const diff = String(this.settings?.get('difficulty') ?? DEFAULTS.difficulty).toUpperCase();
    const objective = m?.id === 'bomb' ? 'FIRST TO 7 ROUNDS' : `FIRST TO ${kills}`;
    this._deploySum.innerHTML = m
      ? `<b>${esc(m.name)}</b> · ${objective} · ${bots} BOT${bots === 1 ? '' : 'S'} · ${esc(diff)}`
      : '';
  }

  /** The real mode rule objects. Match publishes them; MODE_LIST is the same array. */
  _modes() {
    const modes = this.game?.match?.modeList ?? MODE_LIST;
    return modes.filter((mode) => mode.id !== 'bomb'
      || (this.game?.clientFeatureFlags?.['mode.bomb.enabled'] === true
        && this.game?.clientFeatureFlags?.['map.the_square.enabled'] === true
        && bombAvailable(this.game)));
  }

  get _mode() {
    const want = this.settings?.get('mode') ?? DEFAULTS.mode;
    const list = this._modes();
    return list.some((m) => m.id === want) ? want : (list[0]?.id ?? DEFAULTS.mode);
  }

  set _mode(id) { this.settings?.set('mode', id); }

  _buildModes() {
    const list = this._modes();
    const el = this._modesEl;
    el.innerHTML = '';
    const killLimit = (this.settings?.get('killLimit') ?? DEFAULTS.killLimit) | 0;
    for (const m of list) {
      const mins = Math.round((m.timeLimit || 600) / 60);
      const meta = m.id === 'bomb'
        ? ['TEAM', 'FIRST TO 7 ROUNDS', '12 ROUND MAX']
        : ['TEAM', `KILL LIMIT ${killLimit}`, `${mins} MIN`];
      const card = h('button', 'mode-card', `
        <span class="mabbr">${esc(abbrOf(m.name))}</span>
        <span class="mname">${esc(m.name)}</span>
        <span class="mdesc">${esc(m.description || '')}</span>
        <span class="mmeta">
          ${meta.map((item) => `<span>${esc(item)}</span>`).join('')}
        </span>`);
      card.type = 'button';
      card.dataset.nav = '';
      card.dataset.mode = m.id;
      card.setAttribute('aria-pressed', 'false');
      card.addEventListener('click', () => {
        this._mode = m.id;
        this._syncModeCards();
        this._paintDeploySummary();
        this._sfx('uiClick');
      });
      card.addEventListener('mouseenter', () => this._sfx('uiHover'));
      el.appendChild(card);
    }
    this._syncModeCards();
    this._paintDeploySummary();
    this._paintDifficultyHint();
  }

  _syncModeCards() {
    const cards = this._modesEl.children;
    const cur = String(this._mode);
    for (let i = 0; i < cards.length; i++) {
      const on = cards[i].dataset.mode === cur;
      cards[i].classList.toggle('on', on);
      cards[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  _deploy() {
    this._sfx('uiClick');
    this._saveLoadout();
    this.close();
    const opts = {
      mode: this._mode,
      killLimit: (this.settings?.get('killLimit') ?? DEFAULTS.killLimit) | 0,
      botCount: (this.settings?.get('botCount') ?? DEFAULTS.botCount) | 0,
      difficulty: this.settings?.get('difficulty') ?? DEFAULTS.difficulty,
    };
    try {
      this.game.startMatch(opts);
      // startMatch is synchronous and has already spawned the player with the
      // weapon system's DEFAULT_LOADOUT; put the chosen kit in their hands now.
      this._equipLoadout();
      // Join a dedicated server if this build was given one. Deliberately after the
      // match has started and NOT awaited: the game is already playable locally, and the
      // session takes over the step when it connects. If the server is unreachable the
      // player keeps playing single player rather than staring at a connect screen.
      this._joinServerIfConfigured();
    } catch (err) {
      console.error('[menu] startMatch failed', err);
      this.open('main');
    }
  }

  /**
   * Connect to a dedicated server, if one is configured.
   *
   * Fire-and-forget on purpose. A build with no server URL does nothing here, and a
   * build whose server is down degrades to single player with a notice rather than
   * blocking — the offline game must never depend on the netcode being reachable.
   */
  async _joinServerIfConfigured() {
    const g = this.game;
    if (g.net) return;
    let url = '';
    try {
      const { resolveServerUrl } = await import('../net/config.js');
      url = resolveServerUrl();
    } catch { return; }
    if (!url) return;

    try {
      const { MultiplayerSession } = await import('../net/session.js');
      const session = await MultiplayerSession.connect(g, url);
      g.net = session;
      g.hud?.notice?.('CONNECTED', url.replace(/^wss?:\/\//, ''), 2.5);
      console.log(`[net] joined ${url} as entity ${session.net.entityId}`);
    } catch (err) {
      console.warn('[net] could not join, staying offline:', err.message);
      g.hud?.notice?.('OFFLINE', 'server unreachable', 3);
    }
  }

  /* --------------------------------------------------------- loadout ---- */

  _panelLoadout() {
    const p = this._panelShell('LOADOUT', 'primary + secondary');
    const wrap = h('div', 'lo-wrap');

    const left = h('div', 'lo-left');
    const slots = h('div', 'lo-slots');
    this._slotBtns = {};
    for (const [key, label] of [['primary', 'PRIMARY'], ['secondary', 'SECONDARY']]) {
      const b = h('button', 'lo-slot', `<span class="sk">${label}</span><span class="sv">—</span>`);
      b.type = 'button';
      b.dataset.nav = '';
      b.addEventListener('click', () => { this._slot = key; this._syncLoadout(); this._sfx('uiClick'); });
      b.addEventListener('mouseenter', () => this._sfx('uiHover'));
      slots.appendChild(b);
      this._slotBtns[key] = b;
    }
    left.appendChild(slots);
    const list = h('div', 'wlist');
    left.appendChild(list);
    this._wlistEl = list;

    const card = h('div', 'wcard', `
      <div class="wc-art"></div>
      <div class="wc-id">
        <div class="wc-name">—</div>
        <div class="wc-sub">—</div>
      </div>
      <div class="wc-desc"></div>
      <div class="stats"></div>
      <div class="wc-facts"></div>
      <div class="wc-lock"></div>`);

    wrap.appendChild(left);
    wrap.appendChild(card);
    p._scroll.appendChild(wrap);

    this._cardEl = {
      root: card,
      art: card.querySelector('.wc-art'),
      name: card.querySelector('.wc-name'),
      sub: card.querySelector('.wc-sub'),
      desc: card.querySelector('.wc-desc'),
      stats: card.querySelector('.stats'),
      facts: card.querySelector('.wc-facts'),
      lock: card.querySelector('.wc-lock'),
    };

    const foot = h('div', 'panel-foot');
    const note = h('div', 'deploy-sum', '');
    foot.appendChild(note);
    this._loadoutNote = note;
    foot.appendChild(h('div', 'spacer'));
    const save = h('button', 'btn', 'EQUIP LOADOUT');
    save.type = 'button';
    save.dataset.nav = '';
    save.addEventListener('click', () => {
      this._saveLoadout();
      this._equipLoadout();
      this._sfx('uiEquip', 'uiClick');
      this._toast('LOADOUT EQUIPPED');
    });
    foot.appendChild(save);
    p.appendChild(foot);

    return p;
  }

  /** Read the persisted choice. `loadoutPrimary`/`loadoutSecondary` are in
   *  settings DEFAULTS, so Settings persists them for us — no private mirror. */
  _readLoadout() {
    const s = this.settings;
    for (const key of ['primary', 'secondary']) {
      const stored = s?.get(key === 'primary' ? 'loadoutPrimary' : 'loadoutSecondary');
      const pool = this._pools[key];
      // The shipped default for the sidearm names a weapon that is not in the
      // table; fall back to the first unlocked entry rather than showing nothing.
      const hit = pool.find((w) => w.id === stored && this._unlocked(w));
      this._pick[key] = (hit || pool.find((w) => this._unlocked(w)) || pool[0])?.id ?? null;
    }
  }

  _unlocked(def) { return progression.isUnlocked(def); }

  _buildLoadout() { this._syncLoadout(); }

  _syncLoadout() {
    const pool = this._pools[this._slot] || [];
    const list = this._wlistEl;
    list.innerHTML = '';

    for (const key of ['primary', 'secondary']) {
      const b = this._slotBtns[key];
      const def = this._pools[key].find((w) => w.id === this._pick[key]);
      b.classList.toggle('on', this._slot === key);
      b.setAttribute('aria-pressed', this._slot === key ? 'true' : 'false');
      b.querySelector('.sv').textContent = def ? String(def.name).toUpperCase() : 'NONE';
    }

    if (!pool.length) {
      list.appendChild(h('div', 'mouse-note', 'No weapons of this class in the arsenal.'));
      this._renderWeaponCard(null);
      return;
    }

    for (const w of pool) {
      const open = this._unlocked(w);
      const row = h('button', 'wrow' + (open ? '' : ' locked'), `
        <span class="gl">${weaponGlyph(w.class, w.id)}</span>
        <span class="wn">${esc(w.name || w.id)}</span>
        <span class="wc">${open ? esc(String(w.class || '').toUpperCase()) : `RANK ${w.unlockLevel | 0}`}</span>`);
      row.type = 'button';
      row.dataset.nav = '';
      row.dataset.id = w.id;
      row.classList.toggle('on', w.id === this._pick[this._slot]);
      if (!open) row.setAttribute('aria-disabled', 'true');
      row.addEventListener('click', () => {
        if (!open) {
          this._sfx('uiError', 'uiBack');
          this._toast(`${w.name} UNLOCKS AT RANK ${w.unlockLevel | 0}`);
          return;
        }
        this._pick[this._slot] = w.id;
        for (const c of list.children) c.classList.toggle('on', c.dataset.id === w.id);
        this._slotBtns[this._slot].querySelector('.sv').textContent = String(w.name).toUpperCase();
        this._renderWeaponCard(w);
        this._saveLoadout();
        this._sfx('uiEquip', 'uiClick');
      });
      row.addEventListener('mouseenter', () => { this._renderWeaponCard(w); this._sfx('uiHover'); });
      row.addEventListener('focus', () => this._renderWeaponCard(w));
      list.appendChild(row);
    }

    this._renderWeaponCard(pool.find((w) => w.id === this._pick[this._slot]) || pool[0]);
    this._paintLoadoutNote();
  }

  _paintLoadoutNote() {
    if (!this._loadoutNote) return;
    const pr = this._pools.primary.find((w) => w.id === this._pick.primary);
    const se = this._pools.secondary.find((w) => w.id === this._pick.secondary);
    this._loadoutNote.innerHTML = `<b>${esc(pr?.shortName || pr?.name || '—')}</b> + ${esc(se?.shortName || se?.name || '—')}`;
  }

  _renderWeaponCard(def) {
    const c = this._cardEl;
    if (!def) {
      c.name.textContent = '—';
      c.sub.textContent = '—';
      c.desc.textContent = '';
      c.art.innerHTML = '';
      c.stats.innerHTML = '';
      c.facts.innerHTML = '';
      c.lock.textContent = '';
      return;
    }
    const open = this._unlocked(def);
    c.root.classList.toggle('locked', !open);
    c.name.textContent = String(def.name || def.id).toUpperCase();
    c.sub.textContent = `${String(def.class || '').toUpperCase()} · ${String(def.fireMode || 'auto').toUpperCase()} · MAG ${def.magSize ?? '—'}`;
    c.desc.textContent = String(def.desc || '');
    c.art.innerHTML = weaponGlyph(def.class, def.id);
    c.lock.textContent = open ? '' : `LOCKED — UNLOCKS AT RANK ${def.unlockLevel | 0}`;

    const st = weaponStats(def);
    c.stats.innerHTML = '';
    for (const [name, v] of st) {
      const row = h('div', 'stat', `
        <span class="sn">${name}</span>
        <span class="sbar"><i></i></span>
        <span class="sv num">${Math.round(v * 100)}</span>`);
      row.querySelector('i').style.setProperty('--f', v.toFixed(3));
      c.stats.appendChild(row);
    }

    // Lifetime performance with this exact weapon, from the progression store.
    const row = progression.data.weapons[def.id];
    const acc = row && row.shotsFired > 0 ? Math.round((row.shotsHit / row.shotsFired) * 100) : null;
    c.facts.innerHTML = `
      <div><span class="k">RPM</span><span class="v num">${def.rpm ?? '—'}</span></div>
      <div><span class="k">DAMAGE</span><span class="v num">${def.damage ?? '—'}</span></div>
      <div><span class="k">RESERVE</span><span class="v num">${def.reserve ?? '—'}</span></div>
      <div><span class="k">YOUR KILLS</span><span class="v num">${row ? row.kills : 0}</span></div>
      <div><span class="k">YOUR ACC</span><span class="v num">${acc === null ? '—' : acc + '%'}</span></div>
      <div><span class="k">RANGE</span><span class="v num">${def.falloffEnd ?? def.range ?? '—'} M</span></div>`;
  }

  /** Persist the choice. Settings owns both keys, so this is all that is needed. */
  _saveLoadout() {
    const p = this._pick.primary;
    const s = this._pick.secondary;
    if (p) this.settings?.set('loadoutPrimary', p);
    if (s) this.settings?.set('loadoutSecondary', s);
    this._paintLoadoutNote();
  }

  /** The ids to hand the weapon system, primary first (slot 0 is equipped). */
  _loadoutIds() {
    const out = [];
    if (this._pick.primary) out.push(this._pick.primary);
    if (this._pick.secondary && this._pick.secondary !== this._pick.primary) out.push(this._pick.secondary);
    return out;
  }

  /**
   * Put the chosen kit in the player's hands. `WeaponSystem.giveLoadout(entity, ids)`
   * is the real API — it builds the instances and equips slot 0 instantly.
   * (`setPlayerLoadout`, which this used to probe for, has never existed.)
   * @returns {boolean} true if the loadout was (re)built
   */
  _equipLoadout() {
    const g = this.game;
    const p = g?.player;
    const ws = g?.weapons;
    if (!p || !ws) return false;
    const ids = this._loadoutIds();
    if (!ids.length) return false;

    // Skip when the player is already holding exactly this — giveLoadout() re-equips
    // slot 0 and fires the switch sound, and respawns call through here every time.
    const lo = ws.getLoadout(p);
    if (lo && lo.weapons.length === ids.length) {
      let same = true;
      for (let i = 0; i < ids.length; i++) if (lo.weapons[i].def.id !== ids[i]) { same = false; break; }
      if (same) return false;
    }
    ws.giveLoadout(p, ids);
    return true;
  }

  /* -------------------------------------------------------- settings ---- */

  _panelSettings() {
    const p = this._panelShell('SETTINGS', 'applied instantly');
    const tabs = h('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    const pages = h('div', 'tabpages');
    p._scroll.appendChild(tabs);
    p._scroll.appendChild(pages);

    this._tabBtns = [];
    const defs = [['video', 'VIDEO'], ['audio', 'AUDIO'], ['gameplay', 'GAMEPLAY'], ['hud', 'HUD']];
    for (const [id, label] of defs) {
      const b = h('button', 'tab', label);
      b.type = 'button';
      b.dataset.nav = '';
      b.dataset.tab = id;
      b.setAttribute('role', 'tab');
      b.id = `tab-${id}`;
      b.addEventListener('click', () => { this._setTab(id); this._sfx('uiClick'); });
      b.addEventListener('mouseenter', () => this._sfx('uiHover'));
      tabs.appendChild(b);
      this._tabBtns.push(b);

      const page = h('div', 'tabpage');
      page.dataset.tab = id;
      page.setAttribute('role', 'tabpanel');
      page.setAttribute('aria-labelledby', `tab-${id}`);
      this._buildSchema(page, SCHEMA[id]);
      pages.appendChild(page);
    }
    this._tabPages = Array.from(pages.children);

    const foot = h('div', 'panel-foot');
    const reset = h('button', 'btn warn', 'RESTORE DEFAULTS');
    reset.type = 'button';
    reset.dataset.nav = '';
    reset.addEventListener('click', () => {
      this._confirm('RESTORE DEFAULTS', 'Every video, audio, gameplay and HUD option returns to its shipped value. Key bindings are included.', () => {
        this.settings?.reset();
        this._refreshAll();
        this._buildBinds();
        this._toast('SETTINGS RESTORED');
      });
    });
    foot.appendChild(reset);
    foot.appendChild(h('div', 'spacer'));
    p.appendChild(foot);

    this._tab = 'video';
    return p;
  }

  _setTab(id) {
    this._tab = id;
    for (const b of this._tabBtns) {
      const on = b.dataset.tab === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const pg of this._tabPages) pg.classList.toggle('on', pg.dataset.tab === id);
  }

  _buildSchema(page, items) {
    if (!items) return;
    let grp = null;
    for (const it of items) {
      if (it.grp) {
        grp = h('div', 'grp', `<h4>${esc(it.grp)}</h4>`);
        page.appendChild(grp);
        continue;
      }
      if (!grp) { grp = h('div', 'grp'); page.appendChild(grp); }
      grp.appendChild(this._schemaRow(it));
    }
  }

  _schemaRow(it) {
    const get = () => this.settings?.get(it.k) ?? DEFAULTS[it.k];
    const set = (v) => this.settings?.set(it.k, v);
    let control;
    switch (it.type) {
      case 'range': control = this._range(it.min, it.max, it.step, get, set, it.fmt, it.k, it.label); break;
      case 'toggle': control = this._toggle(get, set, it.k, it.label); break;
      case 'seg': control = this._seg(it.options, get, set, it.k, it.label); break;
      case 'color': control = this._color(get, set, it.k); break;
      default: control = { node: h('div') };
    }
    return this._row(it.label, it.hint, control, it.k);
  }

  _row(label, hint, control, key) {
    const row = h('div', 'row');
    if (key) row.dataset.key = key;
    row.appendChild(h('div', 'lbl', `${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}`));
    row.appendChild(control.node);
    const val = h('div', 'val num', control.valueText ? esc(control.valueText()) : '');
    row.appendChild(val);
    if (control.onValue) control.onValue(val);
    return row;
  }

  /** Register a control so external settings changes keep the UI in sync. */
  _reg(key, refresh) {
    if (!key) return;
    let arr = this._controls.get(key);
    if (!arr) this._controls.set(key, (arr = []));
    arr.push(refresh);
  }

  _range(min, max, step, get, set, fmt, key, label) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.nav = '';
    if (label) input.setAttribute('aria-label', label);
    if (key) input.dataset.setting = key;
    let valEl = null;

    const paint = () => {
      const v = Number(get());
      input.value = String(v);
      const p = ((v - min) / (max - min)) * 100;
      input.style.setProperty('--p', `${clamp(p, 0, 100).toFixed(2)}%`);
      const txt = fmt ? fmt(v) : String(v);
      input.setAttribute('aria-valuetext', txt);
      if (valEl && valEl.textContent !== txt) valEl.textContent = txt;
    };
    input.addEventListener('input', () => {
      const v = Number(input.value);
      set(step >= 1 ? Math.round(v) : v);
      paint();
    });
    input.addEventListener('change', () => this._sfx('uiClick'));
    this._reg(key, paint);

    return {
      node: input,
      valueText: () => (fmt ? fmt(Number(get())) : String(get())),
      onValue: (el) => { valEl = el; paint(); },
    };
  }

  _toggle(get, set, key, label) {
    const b = h('button', 'tgl', '<i></i>');
    b.type = 'button';
    b.dataset.nav = '';
    if (label) b.setAttribute('aria-label', label);
    if (key) b.dataset.setting = key;
    const paint = () => {
      const on = !!get();
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    b.addEventListener('click', () => { set(!get()); paint(); this._sfx('uiClick'); });
    b.addEventListener('mouseenter', () => this._sfx('uiHover'));
    this._reg(key, paint);
    paint();
    return { node: b, valueText: null };
  }

  _seg(options, get, set, key, label) {
    const wrap = h('div', 'seg');
    wrap.setAttribute('role', 'radiogroup');
    if (label) wrap.setAttribute('aria-label', label);
    if (key) wrap.dataset.setting = key;
    const btns = [];
    for (const [value, lbl] of options) {
      const b = h('button', null, String(lbl));
      b.type = 'button';
      b.dataset.nav = '';
      b.dataset.value = String(value);
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => { set(value); paint(); this._sfx('uiClick'); });
      b.addEventListener('mouseenter', () => this._sfx('uiHover'));
      wrap.appendChild(b);
      btns.push([b, value]);
    }
    const paint = () => {
      const cur = get();
      for (const [b, v] of btns) {
        const on = String(v) === String(cur);
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    };
    this._reg(key, paint);
    paint();
    return { node: wrap, valueText: null };
  }

  _color(get, set, key) {
    const wrap = h('div', 'swatches');
    if (key) wrap.dataset.setting = key;
    const btns = [];
    for (const c of CROSSHAIR_SWATCHES) {
      const b = h('button', null, '');
      b.type = 'button';
      b.dataset.nav = '';
      b.dataset.value = c;
      b.style.setProperty('--c', c);
      b.setAttribute('aria-label', `Crosshair colour ${c}`);
      b.addEventListener('click', () => { set(c); paint(); this._sfx('uiClick'); });
      wrap.appendChild(b);
      btns.push([b, c]);
    }
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.dataset.nav = '';
    picker.setAttribute('aria-label', 'Custom crosshair colour');
    picker.addEventListener('input', () => { set(picker.value); paint(); });
    wrap.appendChild(picker);

    const paint = () => {
      const cur = String(get() || '#8ef7c4').toLowerCase();
      for (const [b, c] of btns) {
        const on = c.toLowerCase() === cur;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (/^#[0-9a-f]{6}$/i.test(cur)) picker.value = cur;
    };
    this._reg(key, paint);
    paint();
    return { node: wrap, valueText: () => String(get() || '') };
  }

  /* -------------------------------------------------------- controls ---- */

  _panelControls() {
    const p = this._panelShell('CONTROLS', 'click a row, then press a key');
    const s = p._scroll;

    s.appendChild(h('div', 'mouse-note',
      'Look is mouse-driven under pointer lock. <b>Left mouse</b> fires, <b>right mouse</b> aims, ' +
      '<b>mouse wheel</b> cycles weapons. Press <b>ESC</b> while rebinding to cancel.'));

    const mgrp = h('div', 'grp', '<h4>Mouse</h4>');
    mgrp.appendChild(this._schemaRow(SCHEMA.gameplay.find((x) => x.k === 'sensitivity')));
    mgrp.appendChild(this._schemaRow(SCHEMA.gameplay.find((x) => x.k === 'adsSensitivity')));
    mgrp.appendChild(this._schemaRow(SCHEMA.gameplay.find((x) => x.k === 'invertY')));
    s.appendChild(mgrp);

    const kgrp = h('div', 'grp', '<h4>Keyboard</h4>');
    const binds = h('div', 'binds');
    kgrp.appendChild(binds);
    s.appendChild(kgrp);
    this._bindsEl = binds;

    const foot = h('div', 'panel-foot');
    const reset = h('button', 'btn warn', 'RESET BINDINGS');
    reset.type = 'button';
    reset.dataset.nav = '';
    reset.addEventListener('click', () => {
      this._confirm('RESET BINDINGS', 'All key bindings return to the default layout. Mouse settings are untouched.', () => {
        this._resetBinds();
        this._toast('BINDINGS RESET');
      });
    });
    foot.appendChild(reset);
    foot.appendChild(h('div', 'spacer'));
    p.appendChild(foot);

    return p;
  }

  _buildBinds() {
    const el = this._bindsEl;
    if (!el) return;
    const binds = this.settings?.get('binds') || {};
    // Invert once: action -> [codes].
    const byAction = new Map();
    for (const code in binds) {
      const a = binds[code];
      if (!byAction.has(a)) byAction.set(a, []);
      byAction.get(a).push(code);
    }
    const known = new Set(BIND_ACTIONS.map((b) => b[0]));
    const rows = BIND_ACTIONS.slice();
    for (const a of byAction.keys()) if (!known.has(a)) rows.push([a, titleCase(a)]);

    el.innerHTML = '';
    for (const [action, label] of rows) {
      const codes = byAction.get(action) || [];
      const txt = codes.length ? codes.map(keyLabel).join(' / ') : 'UNBOUND';
      const row = h('button', 'bind' + (codes.length ? '' : ' unbound'),
        `<span class="ba">${esc(label)}</span><span class="bk">${esc(txt)}</span>`);
      row.type = 'button';
      row.dataset.nav = '';
      row.dataset.action = action;
      row.setAttribute('aria-label', `${label}, bound to ${txt}. Activate to rebind.`);
      row.addEventListener('click', () => this._captureBind(action, row));
      row.addEventListener('mouseenter', () => this._sfx('uiHover'));
      el.appendChild(row);
    }
  }

  _captureBind(action, row) {
    const input = this.game?.input;
    if (!input) return;
    this._cancelCapture();
    this._capturing = { action, row };
    row.classList.add('capturing');
    row.querySelector('.bk').textContent = 'PRESS ANY KEY';
    this._announce('Press a key to bind, or Escape to cancel.');
    this._sfx('uiClick');

    // Input._onKeyDown hands the raw code straight here and clears itself first.
    input.captureBind = (code) => {
      this._capturing = null;
      row.classList.remove('capturing');
      if (code && code !== 'Escape') {
        this.settings?.rebind(code, action);
        this._sfx('uiClick');
        this._announce(`${action} bound to ${keyLabel(code)}`);
      } else {
        this._sfx('uiBack');
      }
      this._buildBinds();
      // Focus the row we just rebound so keyboard users do not lose their place.
      const again = this._bindsEl?.querySelector(`[data-action="${action}"]`);
      again?.focus?.({ preventScroll: true });
    };
  }

  _cancelCapture() {
    if (!this._capturing) return;
    const { row } = this._capturing;
    this._capturing = null;
    row.classList.remove('capturing');
    if (this.game?.input) this.game.input.captureBind = null;
    this._buildBinds();
  }

  _resetBinds() {
    const binds = this.settings?.get('binds');
    if (!binds) return;
    for (const code of Object.keys(binds)) delete binds[code];
    for (const code of Object.keys(DEFAULTS.binds)) binds[code] = DEFAULTS.binds[code];
    this.settings?.save();
    this._buildBinds();
  }

  /* --------------------------------------------------------- credits ---- */

  _panelCredits() {
    const p = this._panelShell('CREDITS', 'built from nothing');
    p._scroll.innerHTML = `
      <div class="credits">
        <div class="credit"><h5>Engine</h5><p>three.js r185 · fixed 120 Hz simulation with an accumulator · single-pass composite for vignette, grain, aberration and damage response.</p></div>
        <div class="credit"><h5>World</h5><p>Procedural 86 × 86 m urban sector, spatial-hash broadphase, swept AABB move-and-slide with step-up, baked navigation grid.</p></div>
        <div class="credit"><h5>Ballistics</h5><p>Hitscan with range falloff, OBB hitboxes, single-surface penetration and pooled impact decals.</p></div>
        <div class="credit"><h5>Audio</h5><p>100% synthesised WebAudio. Every report, mechanism and impact is generated at runtime — <b>no sample files</b>.</p></div>
        <div class="credit"><h5>Interface</h5><p>Vanilla DOM overlay. Pooled nodes, cached writes, transform/opacity-only animation. Canvas radar with a one-time static bake.</p></div>
        <div class="credit"><h5>Colophon</h5><p>System typefaces only — the build runs fully offline and makes <b>zero network requests</b>.</p></div>
      </div>`;
    return p;
  }

  /* --------------------------------------------------------- results ---- */

  _panelResults() {
    const p = this._panelShell('AFTER ACTION', 'match summary');
    const hero = h('div', 'end-hero', `
      <div class="end-verdict">—</div>
      <div class="end-score"><span class="a num">0</span><span class="vs">VS</span><span class="b num">0</span></div>
      <div class="end-mode">—</div>`);
    p.insertBefore(hero, p._scroll);

    const s = p._scroll;
    const xp = h('div', 'end-xp');
    s.appendChild(xp);
    const moments = h('div', 'moments');
    s.appendChild(moments);
    const table = h('table', 'results');
    s.appendChild(table);

    this._endEl = {
      verdict: hero.querySelector('.end-verdict'),
      score: hero.querySelector('.end-score'),
      a: hero.querySelector('.end-score .a'),
      b: hero.querySelector('.end-score .b'),
      mode: hero.querySelector('.end-mode'),
      xp, moments, table,
    };
    return p;
  }

  /**
   * Build the after-action screen from the `matchEnd` payload Match._end() produced.
   * Every field here is one it actually sets — rows/moments/progression included —
   * so nothing has to be re-derived from the live entity list.
   */
  _buildResults(payload) {
    const g = this.game;
    const el = this._endEl;
    const res = payload || g?.match?.result || null;
    const me = g?.player;

    const scores = res?.scores || g?.match?.scores || [0, 0];
    const a = scores[0] | 0;
    const b = scores[1] | 0;

    const outcome = res?.outcome || 'draw';
    const verdict = outcome === 'win' ? 'VICTORY' : outcome === 'draw' ? 'STALEMATE' : 'DEFEAT';
    el.verdict.textContent = verdict;
    el.verdict.className = 'end-verdict ' + (outcome === 'draw' ? 'draw' : outcome === 'win' ? 'win' : 'lose');
    this.el.root.style.setProperty('--end-tint',
      outcome === 'draw' ? 'rgba(255,179,71,0.12)' : outcome === 'win' ? 'rgba(142,247,196,0.16)' : 'rgba(255,47,36,0.14)');

    const teamBased = !!g?.match?.mode?.teamBased;
    el.a.textContent = String(a);
    el.b.textContent = String(b);
    el.score.style.display = teamBased ? '' : 'none';
    el.mode.textContent = [
      String(res?.modeName || modeLabel(res?.mode ?? g?.match?.mode)),
      res?.winnerName ? `${res.winnerName} WINS` : '',
      res?.reason === 'time' ? 'TIME EXPIRED'
        : res?.reason === 'killLimit' ? `KILL LIMIT ${res?.killLimit ?? g?.match?.killLimit ?? ''}`
          : '',
      res?.duration ? formatClock(res.duration) : '',
    ].filter(Boolean).join('  ·  ');

    this._buildXpReport(res?.progression || g?.match?.lastProgression || null);

    // ---- best moments: Match._addMoment() weights and ranks them for us ----
    const moments = res?.moments || g?.match?.getBestMoments?.() || [];
    el.moments.innerHTML = '';
    for (const m of moments) {
      el.moments.appendChild(h('div', 'moment',
        `<div class="k">${esc(String(m.type || '').toUpperCase())}</div>
         <div class="v">${esc(String(m.label || '').toUpperCase())}</div>
         <div class="d">${esc(m.detail || `${(m.time || 0).toFixed(0)}s in`)}</div>`));
    }
    if (!moments.length) {
      el.moments.appendChild(h('div', 'moment',
        '<div class="k">QUIET SECTOR</div><div class="v">NO HIGHLIGHTS</div><div class="d">nothing worth writing home about</div>'));
    }

    // ---- results table, straight from the referee's rows ----
    const rows = res?.rows || g?.match?.getScoreboardRows?.() || [];
    const names = res?.teamNames || g?.match?.teamNames || ['ALPHA', 'BRAVO'];
    let html = '<thead><tr><th class="rk">#</th><th class="op">OPERATOR</th>'
      + (teamBased ? '<th class="tm">TEAM</th>' : '')
      + '<th>K</th><th>D</th><th>A</th><th>K/D</th><th>ACC</th><th>STK</th><th>SCORE</th></tr></thead><tbody>';
    rows.forEach((r, i) => {
      const mine = r.isPlayer && !!me;
      const cls = (teamBased ? `t${r.team === 1 ? 1 : 0}` : '') + (mine ? ' me' : '');
      html += `<tr class="${cls.trim()}"><td class="rk">${i + 1}</td>`
        + `<td class="op">${esc(String(r.name || '—').toUpperCase())}</td>`
        + (teamBased ? `<td class="tm">${esc(names[r.team === 1 ? 1 : 0] || '')}</td>` : '')
        + `<td>${r.kills}</td><td>${r.deaths}</td><td>${r.assists}</td>`
        + `<td>${r.kd.toFixed(2)}</td><td>${Math.round(r.accuracy * 100)}%</td>`
        + `<td>${r.bestStreak}</td><td>${fmtInt(r.score)}</td></tr>`;
    });
    html += '</tbody>';
    el.table.innerHTML = html;
  }

  /**
   * XP report from `progression.recordMatch()`:
   * `{ xp, breakdown, levelUp:{ gained, xp, level, prevLevel, leveledUp, unlocked }, medals }`
   */
  _buildXpReport(prog) {
    const el = this._endEl.xp;
    if (!prog) { el.innerHTML = ''; return; }
    const sum = progression.getSummary();
    const lvlUp = prog.levelUp?.leveledUp;

    // The two moments the after-action report exists for. `uiUnlock` wins when both land
    // on the same match — a new weapon is the bigger news than the rank that gave it to
    // you, and two stingers on top of each other is neither.
    const unlocked = prog.levelUp?.unlocked?.length ? true : false;
    if (unlocked) this._sfx('uiUnlock', 'streakReady');
    else if (lvlUp) this._sfx('uiLevelup', 'streakReady');

    let bars = '';
    let max = 1;
    for (const [k] of XP_ROWS) max = Math.max(max, prog.breakdown[k] | 0);
    for (const [k, label] of XP_ROWS) {
      const v = prog.breakdown[k] | 0;
      if (v <= 0) continue;
      bars += `<div class="xr"><span class="k">${label}</span>`
        + `<span class="b"><i style="--f:${(v / max).toFixed(3)}"></i></span>`
        + `<span class="v num">+${fmtInt(v)}</span></div>`;
    }

    let medals = '';
    for (const m of prog.medals || []) {
      medals += `<span class="medal">${esc(m.name)} <b class="num">+${fmtInt(m.xp)}</b></span>`;
    }

    el.innerHTML = `
      <div class="xp-head">
        <div class="xp-total"><span class="k">MATCH XP</span><span class="v num">+${fmtInt(prog.xp)}</span></div>
        <div class="xp-rank${lvlUp ? ' up' : ''}">
          <span class="k">${lvlUp ? `RANK UP · ${esc(sum.rank)}` : esc(sum.rank)}</span>
          <span class="v num">${sum.level}</span>
        </div>
      </div>
      <div class="xp-bar"><i style="--f:${sum.ratio.toFixed(3)}"></i></div>
      <div class="xp-sub">${sum.maxed ? 'MAXIMUM RANK' : `${fmtInt(sum.intoLevel)} / ${fmtInt(sum.needed)} XP TO RANK ${sum.level + 1}`}</div>
      ${medals ? `<div class="medals">${medals}</div>` : ''}
      <div class="xp-rows">${bars}</div>`;
  }

  /* ======================================================================
     SHELLS / NAVIGATION
     ====================================================================== */

  _navSpec() {
    switch (this.shell) {
      case 'pause':
        return [
          ['RESUME', 'primary', null, () => this.resume()],
          ['SITUATION', '', 'status', () => this.show('status')],
          ['LOADOUT', '', 'loadout', () => this.show('loadout')],
          ['SETTINGS', '', 'settings', () => this.show('settings')],
          ['CONTROLS', '', 'controls', () => this.show('controls')],
          ['QUIT TO MENU', 'danger', null, () => this._confirmQuit()],
        ];
      case 'end':
        return [
          ['PLAY AGAIN', 'primary', null, () => this._deploy()],
          ['AFTER ACTION', '', 'results', () => this.show('results')],
          ['MATCH SETUP', '', 'play', () => this.show('play')],
          ['LOADOUT', '', 'loadout', () => this.show('loadout')],
          ['SETTINGS', '', 'settings', () => this.show('settings')],
          ['MAIN MENU', 'danger', null, () => { this._sfx('uiBack'); this.game?.returnToMenu?.(); }],
        ];
      default:
        return [
          ['PLAY', 'primary', 'play', () => this.show('play')],
          ['DOSSIER', '', 'home', () => this.show('home')],
          ['LOADOUT', '', 'loadout', () => this.show('loadout')],
          ['SETTINGS', '', 'settings', () => this.show('settings')],
          ['CONTROLS', '', 'controls', () => this.show('controls')],
          ['CREDITS', '', 'credits', () => this.show('credits')],
        ];
    }
  }

  _buildNav() {
    const nav = this.el.nav;
    nav.innerHTML = '';
    const spec = this._navSpec();
    spec.forEach(([label, cls, panel, fn], i) => {
      const b = h('button', 'mi' + (cls ? ' ' + cls : ''),
        `<span class="idx">${String(i + 1).padStart(2, '0')}</span><span>${esc(label)}</span>`);
      b.type = 'button';
      b.dataset.nav = '';
      if (panel) b.dataset.panel = panel;
      b.addEventListener('click', () => fn());
      b.addEventListener('mouseenter', () => this._sfx('uiHover'));
      nav.appendChild(b);
    });
    this._navBtns = Array.from(nav.children);
  }

  open(shell) {
    const first = this.shell !== shell;
    this.shell = shell;
    this._buildNav();
    this._buildModes();
    this._buildBinds();
    this._readLoadout();
    this._syncLoadout();
    this._refreshDossier();
    this._refreshHeader();
    this._setTab(this._tab || 'video');
    if (shell === 'pause') this._refreshStatus();

    const root = this.el.root;
    root.classList.add('open');
    root.classList.toggle('pause', shell === 'pause');
    root.classList.toggle('end', shell === 'end');
    this.mount.classList.add('interactive');
    this.el.pauseNote.style.display = shell === 'pause' ? '' : 'none';
    this.el.sysMap.textContent = shell === 'main'
      ? 'UNASSIGNED'
      : String(this.game?.match?.modeName || modeLabel(this.game?.match?.mode) || 'ACTIVE');

    if (first) {
      this.show(this._homePanel, true);
      this._focusFirst();
    }
  }

  _refreshHeader() {
    const sum = progression.getSummary();
    this.el.sysLvl.textContent = String(sum.level);
    this.el.sysRank.textContent = sum.authority === 'server' ? 'SERVER' : sum.rank;
    this.el.sysXp.style.setProperty('--f', sum.ratio.toFixed(3));
  }

  close() {
    if (!this.shell) return;
    this._cancelCapture();
    this.shell = null;
    this.el.root.classList.remove('open', 'pause', 'end');
    this.mount.classList.remove('interactive');
    this._closeConfirm(false);
  }

  get isOpen() { return !!this.shell; }

  show(panel, silent) {
    if (!this.panels[panel]) panel = this._homePanel;
    this.panel = panel;
    if (panel === 'home') this._refreshDossier();
    if (panel === 'status') this._refreshStatus();
    if (panel === 'loadout') this._syncLoadout();
    for (const key in this.panels) this.panels[key].classList.toggle('on', key === panel);
    for (const b of this._navBtns || []) b.classList.toggle('sel', b.dataset.panel === panel);
    if (!silent) this._sfx('uiClick');
    this._focusFirst();
  }

  /** Default panel for the current shell — where Escape backs out to. */
  get _homePanel() {
    return this.shell === 'end' ? 'results' : this.shell === 'pause' ? 'status' : 'home';
  }

  resume() {
    this._sfx('uiClick');
    this.close();
    this._suppressUnlock = true;
    try { this.game?.setPaused?.(false); } finally {
      setTimeout(() => { this._suppressUnlock = false; }, 250);
    }
  }

  _confirmQuit() {
    this._confirm('ABANDON MATCH', 'The current engagement ends immediately and all progress in it is lost.', () => {
      this.game?.returnToMenu?.();
    });
  }

  /* ------------------------------------------------------------- confirm */

  _confirm(title, body, onYes) {
    this._confirmReturn = document.activeElement;
    this.el.cfTitle.textContent = title;
    this.el.cfBody.textContent = body;
    this._confirmCb = onYes;
    this.el.confirm.classList.add('on');
    this.el.cfNo.focus();
  }

  _closeConfirm(yes) {
    if (!this.el.confirm.classList.contains('on')) return;
    this.el.confirm.classList.remove('on');
    const cb = this._confirmCb;
    const back = this._confirmReturn;
    this._confirmCb = null;
    this._confirmReturn = null;
    if (yes) this._sfx('uiConfirm', 'uiClick');
    else this._sfx('uiBack');
    if (yes && cb) cb();
    if (back && this.el.root.contains(back) && back.isConnected) back.focus?.({ preventScroll: true });
    else this._focusFirst();
  }

  _toast(text) {
    // Reuse the HUD notice channel — it already owns big centre-screen text.
    this.game?.hud?.notice?.(text, '', 1.4);
    this._announce(text);
  }

  _announce(text) {
    if (this.el?.live) this.el.live.textContent = String(text);
  }

  /* ======================================================================
     INPUT
     ====================================================================== */

  _bind() {
    const bus = this.game?.bus;
    const on = (n, f) => { const u = bus?.on?.(n, f); if (u) this._unsubs.push(u); };

    on('pointerUnlock', () => {
      if (this._suppressUnlock) return;
      if (this.game?.state === 'playing' && !this.isOpen) {
        this.game.setPaused?.(true);
        this.open('pause');
      }
    });

    on('pointerLock', () => { if (this.shell === 'pause') this.close(); });

    on('pause', () => { if (!this.isOpen) this.open('pause'); });
    on('unpause', () => { if (this.shell === 'pause') this.close(); });

    on('matchEnd', (p) => {
      this._endData = p || null;
      this._buildResults(p);
      this._refreshHeader();
      this.open('end');
      this.show('results', true);
      this._focusFirst();
    });

    on('matchStart', () => this.close());
    on('toMenu', () => { this.open('main'); this.show('home', true); });
    on('ready', () => { if (this.game?.state === 'menu') this.open('main'); });

    /**
     * Player.respawn() asks the weapon system for a loadout with no ids, which means
     * `DEFAULT_LOADOUT` — so a respawn silently reverts the player's chosen kit. We
     * re-equip on every player spawn.
     */
    on('spawn', (p) => {
      if (!p || p.entity !== this.game?.player) return;
      this._equipLoadout();
    });

    // Settings written from anywhere (including another panel) repaint here.
    const u = this.settings?.onChange?.((k) => {
      if (k === '*') { this._refreshAll(); this._buildBinds(); this._syncModeCards(); return; }
      const arr = this._controls.get(k);
      if (arr) for (const fn of arr) { try { fn(); } catch { /* ignore */ } }
      if (k === 'mode') { this._syncModeCards(); this._paintDeploySummary(); }
    });
    if (u) this._unsubs.push(u);

    this._onKey = this._onKey.bind(this);
    window.addEventListener('keydown', this._onKey, true);

    // Swallow clicks that land on the backdrop so they never reach the canvas.
    this.el.root.addEventListener('mousedown', (e) => { if (this.isOpen) e.stopPropagation(); });
  }

  _onKey(e) {
    if (this._capturing) return;              // input.captureBind owns the key
    if (!this.isOpen) return;

    switch (e.code) {
      case 'Escape': {
        e.preventDefault();
        e.stopPropagation();
        if (this.el.confirm.classList.contains('on')) { this._closeConfirm(false); return; }
        if (this.panel !== this._homePanel) { this._sfx('uiBack'); this.show(this._homePanel, true); return; }
        if (this.shell === 'pause') this.resume();
        return;
      }
      case 'Enter':
      case 'NumpadEnter': {
        const el = document.activeElement;
        if (el && this.el.root.contains(el) && el.tagName !== 'INPUT') {
          e.preventDefault();
          el.click();
        }
        return;
      }
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        this._moveFocus(e.code === 'ArrowDown' ? 1 : -1);
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        const el = document.activeElement;
        if (el && el.tagName === 'INPUT' && el.type === 'range') return;   // native
        // Inside a segmented control the arrows step the value, as a radio group should.
        const seg = el?.parentElement?.classList?.contains('seg') ? el.parentElement : null;
        if (seg) {
          e.preventDefault();
          const btns = Array.from(seg.children);
          const i = btns.indexOf(el);
          const next = btns[clamp(i + (e.code === 'ArrowRight' ? 1 : -1), 0, btns.length - 1)];
          if (next && next !== el) { next.focus({ preventScroll: true }); next.click(); }
          return;
        }
        e.preventDefault();
        this._moveFocus(e.code === 'ArrowRight' ? 1 : -1);
        return;
      }
      case 'Tab':
        // Let the browser handle Tab, but keep it inside the overlay.
        e.stopPropagation();
        return;
      default:
        return;
    }
  }

  _focusables() {
    const inConfirm = this.el.confirm.classList.contains('on');
    const scope = inConfirm ? this.el.confirm : this.el.root;
    const all = scope.querySelectorAll('[data-nav]');
    const out = [];
    for (const el of all) {
      if (el.disabled) continue;
      if (!inConfirm && this.el.confirm.contains(el)) continue;
      // Cheap visibility test that avoids a layout read on hidden subtrees.
      const panel = el.closest('.panel');
      if (panel && !panel.classList.contains('on')) continue;
      const page = el.closest('.tabpage');
      if (page && !page.classList.contains('on')) continue;
      out.push(el);
    }
    return out;
  }

  _focusFirst() {
    const list = this._focusables();
    if (list.length) {
      list[0].focus?.({ preventScroll: true });
      this._paintSel(list, 0);
    }
  }

  _moveFocus(dir) {
    const list = this._focusables();
    if (!list.length) return;
    let i = list.indexOf(document.activeElement);
    if (i < 0) i = dir > 0 ? -1 : 0;
    i = (i + dir + list.length) % list.length;
    const el = list[i];
    el.focus?.({ preventScroll: true });
    el.scrollIntoView?.({ block: 'nearest' });
    this._paintSel(list, i);
    this._sfx('uiHover');
  }

  /** `.kb` is the keyboard cursor; `.sel` marks the nav item owning the panel. */
  _paintSel(list, idx) {
    for (let i = 0; i < list.length; i++) list[i].classList.toggle('kb', i === idx);
  }

  /* ======================================================================
     MISC
     ====================================================================== */

  _refreshAll() {
    for (const arr of this._controls.values()) {
      for (const fn of arr) { try { fn(); } catch { /* ignore */ } }
    }
  }

  /**
   * Play `name`, or `fallback` when the bank cannot voice it.
   *
   * Half of the menu's vocabulary — equip, error, confirm, unlock, levelup — exists only as a
   * downloaded sample (`SAMPLE_MANIFEST`); the procedural bank renders no spec for those
   * names, and `AudioEngine.play()` on a name with no buffer returns null. So offline, or
   * behind a 404, or after a decode failure, equipping a loadout and being refused a locked
   * weapon were SILENT — the synth is supposed to be the floor under the samples, not
   * something they replace. Every such call passes a name the synth bank guarantees
   * (ARCHITECTURE.md §9's REQUIRED_SOUNDS) as `fallback`; the sample is used when it is
   * genuinely there, and the blip carries the same meaning when it is not. Same shape as
   * `killstreaks._sfx`, which already had to solve this for `streakReady`.
   */
  _sfx(name, fallback) {
    try {
      const a = this.game?.audio;
      if (!a?.playUI) return;
      // `has` is the engine's own "can this be voiced at all" test — it is true for a synth
      // spec and for a decoded sample alike, which is exactly the question here.
      const playable = fallback && typeof a.has === 'function' && !a.has(name) ? fallback : name;
      a.playUI(playable);
    } catch { /* audio may not be up yet */ }
  }

  reset() {
    this._cancelCapture();
    this.close();
  }

  update() { /* the menu is event-driven — nothing to do per frame */ }

  dispose() {
    window.removeEventListener('keydown', this._onKey, true);
    for (const u of this._unsubs) { try { u(); } catch { /* ignore */ } }
    this._unsubs.length = 0;
    this.el.root.remove();
    this.mount.classList.remove('interactive');
  }
}

/* ---------------------------------------------------------------- utils -- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function titleCase(s) {
  return String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function abbrOf(name) {
  const words = String(name).toUpperCase().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3);
  return words.map((w) => w[0]).join('').slice(0, 4);
}

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v >= 10000 ? v.toLocaleString('en-US') : String(v);
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const hrs = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  return hrs > 0 ? `${hrs}H ${min}M` : `${min}M`;
}

/**
 * Five comparable bars derived from the raw weapon definition. These are
 * presentation values only — nothing here feeds back into the simulation.
 */
export function weaponStats(def) {
  const d = def || {};
  const rpm = Number(d.rpm) || 600;
  const pellets = Math.max(1, Number(d.pellets) || 1);
  const dmg = (Number(d.damage) || 20) * (pellets > 1 ? pellets * 0.55 : 1);
  const recoil = d.recoil || {};
  const up = Number(recoil.up) || 0.5;
  const side = Number(recoil.side) || 0.2;
  const spread = Number(d.spreadHip) || 2.5;
  const falloff = Number(d.falloffEnd ?? d.range) || 55;
  const moveMul = Number(d.moveSpeedMul) || 0.95;
  const ads = Number(d.adsTime) || 0.25;

  // Fire rate is logarithmic: the gap between 45 and 300 rpm matters far more
  // to the player than the gap between 800 and 1000.
  const rate = (Math.log(clamp(rpm, 40, 1100)) - Math.log(40)) / (Math.log(1100) - Math.log(40));
  // Control folds per-shot climb, lateral scatter and hip cone into one impulse.
  const impulse = up + side * 1.2 + spread * 0.06;

  return [
    ['DAMAGE', clamp(dmg / 95, 0.05, 1)],
    ['FIRE RATE', clamp(rate, 0.05, 1)],
    ['RANGE', clamp(falloff / 110, 0.05, 1)],
    ['MOBILITY', clamp(((moveMul - 0.68) / 0.37) * 0.55 + (1 - clamp(ads / 0.55, 0, 1)) * 0.45, 0.05, 1)],
    ['CONTROL', clamp(1 - clamp(impulse / 3.2, 0, 0.95), 0.05, 1)],
  ];
}
