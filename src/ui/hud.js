import * as THREE from 'three';
import { WEAPONS, getWeapon } from '../weapons/weaponDefs.js';
import { progression, XP_VALUES } from '../game/progression.js';
import { Killfeed, weaponGlyph } from './killfeed.js';
import { Minimap } from './minimap.js';
import { Scoreboard, modeLabel, formatClock } from './scoreboard.js';
import { createLocalBombHud } from './bomb/index.js';
import { createRaidHud } from './raid/index.js';
import { getShellAudio } from './shell/audio.js';

/**
 * HUD — DOM overlay mounted under `#hud`, per ARCHITECTURE §10.
 *
 * Performance contract (§11): the per-frame path does zero DOM *reads*, writes
 * only when a cached value actually changed, animates exclusively through
 * `transform`/`opacity`, and pools every repeated node (damage numbers, damage
 * arcs, XP popups, killfeed rows).
 *
 * Data contract — every readout is wired to a verified API, no probing:
 *   ammo/weapon/spread  `game.weapons.current(entity)` -> WeaponInstance
 *                       (`getCurrentSpread()` returns the cone half-angle in DEGREES)
 *   health/armour       the §4 entity contract on `game.player`
 *   score/timer/mode    `game.match` — setScore/setTimer are pushed by Match._pushHud,
 *                       and `scores`/`timeRemaining`/`modeName`/`mode.hudLabels` back it up
 *   streaks             `game.match.killstreaks.getAvailableDefs(entity)`
 *   UAV                 `game.match.uavActive(team)`
 *   phase               `game.match.phase` ('countdown' freezes the fight)
 *   death screen        `hud.deathScreen()` from Match._queueRespawn, plus
 *                       `match.playerRespawnIn` / `match.playerCanRespawnNow`
 *   secondary/grenades  `game.weapons.getLoadout(entity)` + `game.player.grenades`
 *   grenade danger      the `grenadeWarning` / `grenadeWarningEnd` events
 *   flash-blind         the `flashbang` event (nothing else renders it)
 *   XP popups           `XP_VALUES` from progression.js — the same table
 *                       `progression.recordMatch()` actually banks
 *
 * Public API (§10): setAmmo, setHealth, setWeapon, hitmarker, killfeed,
 * damageIndicator, notice, setCrosshairSpread, setScore, setTimer, minimap,
 * lowHealthVignette. Plus setEquipment/deathScreen, which other systems call.
 */

const DEG = Math.PI / 180;
const ARC_POOL = 8;
const DNUM_POOL = 20;
const XP_POOL = 8;
const GREN_POOL = 4;

const ARC_LIFE = 1.2;
const HM_LIFE = 0.18;
const HM_KILL_LIFE = 0.34;
/** A warning re-arms every WARN_INTERVAL (1/15 s) while the grenade is live. */
const GREN_WARN_LIFE = 0.28;

/** Mirrors Match.LONGSHOT_DISTANCE — kept local so the HUD stays import-light. */
const LONGSHOT_M = 45;
const CAPTION_LABELS = Object.freeze({
  matchStart: 'Match started', matchEnd: 'Match ended', streakReady: 'Killstreak ready',
  killConfirm: 'Kill confirmed', explosion: 'Explosion', rifle: 'Rifle fire', smg: 'SMG fire',
  lmg: 'LMG fire', sniper: 'Sniper fire', dmr: 'Marksman fire',
  shotgun: 'Shotgun fire', pistol: 'Pistol fire',
  grenadeBounce: 'Grenade bouncing', footstepConcrete: 'Footsteps', footstepDirt: 'Footsteps',
  hurt: 'Player hurt', death: 'Player eliminated', lowAmmo: 'Low ammunition',
});

/** Human-readable label for a KeyboardEvent.code. Shared with the menu. */
export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();
  const MAP = {
    Space: 'SPACE', Escape: 'ESC', Enter: 'ENTER', Tab: 'TAB', Backspace: 'BKSP',
    ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT',
    ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
    AltLeft: 'L ALT', AltRight: 'R ALT',
    CapsLock: 'CAPS', BracketLeft: '[', BracketRight: ']',
    Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\',
    Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=',
    PageUp: 'PG UP', PageDown: 'PG DN', Home: 'HOME', End: 'END',
    Insert: 'INS', Delete: 'DEL',
  };
  return MAP[code] || code.toUpperCase();
}

/**
 * A duplex mil-dot reticle, in scope space (100 = aperture radius).
 *
 * Duplex is not decoration: the four heavy outer posts drag the eye to the middle of a
 * magnified image with no other landmarks in it, and then get out of the way, which is
 * why every hunting and military optic since the 1960s uses the shape.
 *
 * WEIGHTS. These are the only numbers in the file that have to be right in PIXELS, and
 * they were originally set by eye in SVG units, which is not the same thing. One unit is
 * `apertureR * innerHeight / 200` on screen — 3.5 px on a 900-line window at the REAVER's
 * aperture. The old 3.1-unit posts therefore rasterised 11 px wide and the old 1.16-unit
 * "hairlines" 4 px, so the cross covered ~30 cm at 100 m and the horizontal bar read as a
 * censor strip laid across the target rather than as glass. A real duplex post is a bit
 * over 1 % of the field diameter and the fine cross is a genuine hairline, which is what
 * these are now: posts 2.2 u (~8 px) and hairlines 0.7 u (~2.5 px, sub-pixel-antialiased,
 * hence the halo pass in CSS).
 */
function reticleMildot() {
  let s = '';
  // Heavy outer posts, stopping at 42 % of the radius.
  s += '<rect x="-1.1" y="-100" width="2.2" height="58"/>';
  s += '<rect x="-1.1" y="42" width="2.2" height="58"/>';
  s += '<rect x="-100" y="-1.1" width="58" height="2.2"/>';
  s += '<rect x="42" y="-1.1" width="58" height="2.2"/>';
  // Hairline cross, with a 2.6-unit gap so the aiming point is never covered.
  s += '<rect x="-0.35" y="-42" width="0.7" height="39.4"/>';
  s += '<rect x="-0.35" y="2.6" width="0.7" height="39.4"/>';
  s += '<rect x="-42" y="-0.35" width="39.4" height="0.7"/>';
  s += '<rect x="2.6" y="-0.35" width="39.4" height="0.7"/>';
  // Windage marks, one mil apart, alternating long/short.
  for (let i = 1; i <= 3; i++) {
    const x = i * 9;
    const h = i === 2 ? 5.0 : 3.0;
    s += `<rect x="${(x - 0.35).toFixed(2)}" y="${(-h / 2).toFixed(2)}" width="0.7" height="${h}"/>`;
    s += `<rect x="${(-x - 0.35).toFixed(2)}" y="${(-h / 2).toFixed(2)}" width="0.7" height="${h}"/>`;
  }
  // Holdover ladder: wider as it drops, the way a real bullet-drop scale is drawn.
  for (let i = 1; i <= 3; i++) {
    const y = i * 9;
    const w = 3.6 + i * 1.8;
    s += `<rect x="${(-w / 2).toFixed(2)}" y="${(y - 0.35).toFixed(2)}" width="${w}" height="0.7"/>`;
  }
  s += '<circle cx="0" cy="0" r="0.55"/>';
  return s;
}

/**
 * The MERIDIAN's ranging reticle — a fine open chevron over a drop ladder.
 *
 * A 3.5x semi-auto is aimed differently from a 6x bolt gun: fast follow-up shots at
 * torsos, not one held breath at a head. So no mil-dot field — a chevron whose apex is
 * the aiming point (nothing covers the target above it) and a single BDC ladder under
 * it for the second shot. The same unit weights as the mil-dot apply: posts 2.2 u,
 * hairlines 0.7 u, because those are what rasterise correctly (see the note above).
 */
function reticleRanging() {
  let s = '';
  // Horizontal posts only — the vertical field stays open above the chevron.
  s += '<rect x="-100" y="-1.1" width="62" height="2.2"/>';
  s += '<rect x="38" y="-1.1" width="62" height="2.2"/>';
  s += '<rect x="-1.1" y="46" width="2.2" height="54"/>';
  // Hairline stadia running in from the posts.
  s += '<rect x="-38" y="-0.35" width="34" height="0.7"/>';
  s += '<rect x="4" y="-0.35" width="34" height="0.7"/>';
  // Open chevron, apex exactly on the aiming point (0,0), legs 7 units at 45 degrees.
  s += '<rect x="0" y="0" width="9.9" height="0.9" transform="rotate(45)"/>';
  s += '<rect x="-9.9" y="0" width="9.9" height="0.9" transform="rotate(-45)"/>';
  // BDC drop ladder: fine centre line with widening rungs.
  s += '<rect x="-0.35" y="7" width="0.7" height="39"/>';
  for (let i = 1; i <= 3; i++) {
    const y = 7 + i * 10;
    const w = 4.5 + i * 2.2;
    s += `<rect x="${(-w / 2).toFixed(2)}" y="${(y - 0.35).toFixed(2)}" width="${w}" height="0.7"/>`;
  }
  return s;
}

export class HUD {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('hud');

    /**
     * Match checks this before pushing killfeed rows of its own. We subscribe to
     * `kill` directly, so it must stay true or every line would render twice.
     */
    this.killfeedFromBus = true;

    // Progression stingers are coalesced across a single `award()` burst — see
    // `_queueProgressionStinger`.
    this._pendingStinger = null;
    this._stingerQueued = false;
    this._disposed = false;

    // ---- cached last-written values (never write the DOM twice) ----
    this._c = {
      mag: -1, reserve: -1, weapon: '', mode: '', ammoState: '', reloadP: -1, magFrac: -1,
      hp: -1, hpMax: -1, armor: -1, hpState: '', hpSegs: new Array(10).fill(-1),
      armorSegs: new Array(6).fill(-1),
      scoreA: -1, scoreB: -1, timer: -1, urgent: false, modeTxt: '',
      tagA: '', tagB: '', metric: '', phase: '',
      spread: -1, xhStyle: '', xhColor: '', xhHidden: null,
      scopeAmt: -1, scopeSize: -1, scopeBreath: -1, scopeHold: null, scopeRet: '',
      vignette: -1, crit: false, flash: -1, blind: -1,
      perf: '', live: null, secondary: '', nades: -1, hmKind: '',
      deathKiller: '', deathCount: -1, deathReady: null, deathHp: -1, deathHow: '',
      streaks: '', uav: null,
    };

    // ---- runtime state ----
    this._hm = { t: 1e9, life: HM_LIFE, kind: '' };
    this._flash = 0;
    this._blind = 0;
    this._blindDecay = 1;
    this._vig = 0;
    this._vigExternal = false;
    this._spreadExternal = false;
    this._scoreExternal = false;
    this._timerExternal = false;
    this._timerSec = 0;
    this._noticeT = 0;
    this._noticeDur = 0;
    this._streakT = 0;
    this._lastHp = -1;
    this._regenT = 0;
    this._xpOffset = 0;
    this._perfAcc = 0;
    this._death = { on: false, t: 0, delay: 4, info: null };
    this._xhHitT = 0;
    this._noticeClear = 0;
    this._showDnums = true;
    this._flashIntensity = 1;
    this._screenEffectIntensity = 1;
    this._damageVignetteScale = 1;
    this._captionT = 0;
    this._networkOverlay = 'off';
    this._magSize = 30;
    this._equip = null;         // { lethal, tactical } pushed by WeaponSystem
    this._unsubs = [];

    // Viewport metrics are cached on resize — never read from the DOM in a
    // frame where we also write, or the browser is forced into a sync layout.
    this._vw = window.innerWidth;
    this._vh = window.innerHeight;
    this._gapPx = 6;

    this._buildDom();

    this.killfeedUI = new Killfeed(game, this.root);
    this.minimap = new Minimap(game, this.root);
    // Paint order: minimap/killfeed, then the crosshair stack, then the modal
    // scoreboard, then the death overlay on top of everything.
    this.root?.appendChild(this._center);
    this.scoreboard = new Scoreboard(game, this.root);
    this.root?.appendChild(this.el.death);
    this.bombHud = createLocalBombHud({ game, root: this.root });
    this.raidHud = createRaidHud({ game, root: this.root });

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    this._bindEvents();
  }

  async init() {
    this.minimap.init();
    this._applyAllSettings();
    this._onResize();
    this._c.live = null;
    return this;
  }

  _onResize() {
    this._vw = window.innerWidth;
    this._vh = window.innerHeight;
    const fs = parseFloat(getComputedStyle(this.root).fontSize);
    this._gapPx = (isFinite(fs) ? fs : 16) * 0.3;
    this._c.spread = -1;   // force a rewrite at the new scale
    // The scope aperture is a fraction of the viewport HEIGHT; a resize while scoped
    // has to re-derive it or the SVG reticle stops matching the shader's mask.
    this._c.scopeSize = -1;
  }

  /* ======================================================================
     DOM
     ====================================================================== */

  _buildDom() {
    const root = this.root;
    if (!root) {
      // Headless / test contexts: build detached so nothing throws.
      this.root = document.createElement('div');
      this.root.id = 'hud';
    }
    const r = this.root;
    r.removeAttribute('aria-hidden');
    r.className = 'enter';
    r.innerHTML = '';

    const mk = (cls, html, tag = 'div') => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (html) e.innerHTML = html;
      return e;
    };

    // ---- full-screen effect layers (bottom of the stack) ----
    const vignette = mk('hud-vignette');
    const flash = mk('hud-flash');
    const blind = mk('hud-blind');
    r.appendChild(vignette);
    r.appendChild(flash);
    r.appendChild(blind);

    // ---- top bar: scores + clock ----
    const top = mk('hud-top', `
      <div class="score-team a">
        <span class="tag">ALPHA</span>
        <span class="val num">0</span>
        <span class="rule"></span>
      </div>
      <div class="score-mid">
        <span class="mode">SKIRMISH</span>
        <span class="clock num">0:00</span>
        <span class="metric">KILLS</span>
      </div>
      <div class="score-team b">
        <span class="tag">BRAVO</span>
        <span class="val num">0</span>
        <span class="rule"></span>
      </div>`);
    r.appendChild(top);

    // ---- perf readout ----
    const perf = mk('hud-perf', `
      <span><b class="p-fps">0</b> FPS</span>
      <span class="p-ms">0.0 ms</span>
      <span class="p-dc">0 dc</span>
      <span class="p-tri">0 tri</span>
      <span class="p-net"></span>`);
    r.appendChild(perf);

    const captions = mk('hud-captions', '', 'div');
    captions.setAttribute('role', 'status');
    captions.setAttribute('aria-live', 'polite');
    r.appendChild(captions);

    // ---- ammo ----
    const ammo = mk('hud-ammo brk', `
      <div class="ammo-weapon"><span class="wn">—</span><span class="ammo-mode">—</span></div>
      <div class="ammo-counts">
        <span class="ammo-mag num">0</span>
        <span class="ammo-stack">
          <span class="ammo-sep">MAG</span>
          <span class="ammo-res num">0</span>
        </span>
      </div>
      <div class="ammo-track"><i class="mag"></i><i class="load"></i></div>
      <div class="ammo-prompt"></div>
      <div class="ammo-kit">
        <span class="kit-slot sec"><span class="gl"></span><span class="nm">—</span></span>
        <span class="kit-slot nade">${weaponGlyph('frag')}<b class="num">0</b></span>
      </div>`);
    r.appendChild(ammo);

    // ---- health ----
    let segs = '';
    for (let i = 0; i < 10; i++) segs += '<i class="hp-seg"></i>';
    let asegs = '';
    for (let i = 0; i < 6; i++) asegs += '<i></i>';
    const health = mk('hud-health', `
      <div class="hp-head">
        <span class="hp-title">VITALS</span>
        <span class="hp-value num">100</span>
      </div>
      <div class="hp-bar">${segs}<span class="hp-regen"></span></div>
      <div class="hp-armor">${asegs}</div>`);
    r.appendChild(health);

    // ---- killstreak tray + UAV chip ----
    const streaks = mk('hud-streaks', '<div class="st-head">KILLSTREAKS<b class="st-key"></b></div><div class="st-list"></div>');
    r.appendChild(streaks);

    const uav = mk('hud-uav', '<i></i><span>UAV ONLINE</span>');
    r.appendChild(uav);

    // ---- centre stack (crosshair, hitmarker, arcs, popups, notices) ----
    const center = mk('hud-center');
    center.style.cssText = 'position:absolute;inset:0;';
    this._center = center;

    // ---- telescopic sight reticle ----
    // Drawn in the HUD, not in the composite shader, on purpose: the composer runs at
    // `renderScale`, and at 0.6 a shader-drawn hairline is resampled into a grey smudge.
    // Here it rasterises at native device resolution however the world is rendered.
    //
    // The viewBox is the SCOPE's own space — 100 units is the aperture radius — so the
    // reticle is sized once from `scope.apertureR` and thereafter never scales with the
    // view, the FOV or the magnification. Screen centre is 0,0, which is exactly where
    // the bullet goes (see `_pollScope`).
    const scope = mk('scope', `
      <svg viewBox="-120 -120 240 240" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <g id="os-ret-mildot">${reticleMildot()}</g>
          <g id="os-ret-ranging">${reticleRanging()}</g>
        </defs>
        <use href="#os-ret-mildot" class="ret-halo"></use>
        <use href="#os-ret-mildot" class="ret-ink"></use>
        <g class="scope-breath">
          <rect class="trk" x="-23" y="103.4" width="46" height="1.9" rx="0.95"></rect>
          <rect class="fil" x="-23" y="103.4" width="46" height="1.9" rx="0.95"></rect>
        </g>
      </svg>`);
    center.appendChild(scope);

    const xh = mk('xh', `
      <i class="xh-t"></i><i class="xh-b"></i><i class="xh-l"></i><i class="xh-r"></i>
      <i class="xh-dot"></i>`);
    center.appendChild(xh);

    const hitmark = mk('hitmark', '<i class="a"></i><i class="b"></i><i class="c"></i><i class="d"></i><i class="ring"></i>');
    center.appendChild(hitmark);

    const arcs = mk('dmg-arcs');
    this._arcs = [];
    for (let i = 0; i < ARC_POOL; i++) {
      const a = mk('dmg-arc', '<i></i>');
      arcs.appendChild(a);
      this._arcs.push({ el: a, active: false, t: 0, ang: 0 });
    }
    center.appendChild(arcs);

    // Grenade danger markers — same polar rig as the damage arcs, different read.
    const grens = mk('gren-warns');
    this._grens = [];
    for (let i = 0; i < GREN_POOL; i++) {
      const gEl = mk('gren-warn', '<i></i><b></b>');
      grens.appendChild(gEl);
      this._grens.push({ el: gEl, num: gEl.querySelector('b'), id: 0, active: false, t: 0, ang: 0, fuse: -1 });
    }
    center.appendChild(grens);

    const xpFeed = mk('xp-feed');
    this._xp = [];
    for (let i = 0; i < XP_POOL; i++) {
      const p = mk('xp-pop', '<b>+0</b> <span class="lb"></span>');
      xpFeed.appendChild(p);
      this._xp.push({ el: p, num: p.querySelector('b'), lbl: p.querySelector('.lb'), active: false, t: 0, life: 1.3, y0: 0, cls: '' });
    }
    center.appendChild(xpFeed);

    const streak = mk('streak', '<span>STREAK</span><b class="num">0</b>');
    center.appendChild(streak);

    const notice = mk('notice', `
      <div class="notice-main"></div>
      <div class="notice-rule"></div>
      <div class="notice-sub"></div>`);
    center.appendChild(notice);

    const dnums = mk('dmg-numbers');
    this._dnums = [];
    for (let i = 0; i < DNUM_POOL; i++) {
      const d = mk('dnum');
      dnums.appendChild(d);
      this._dnums.push({ el: d, active: false, t: 0, life: 0.85, x: 0, y: 0, cls: '', txt: '' });
    }
    center.appendChild(dnums);

    // ---- death screen ----
    const death = mk('death', `
      <div class="death-scan"></div>
      <div class="death-inner">
        <div class="death-title" data-txt="ELIMINATED">ELIMINATED</div>
        <div class="death-card">
          <div class="death-card-head">
            <span class="lead">KILLED BY</span>
            <span class="death-how"></span>
          </div>
          <div class="death-killer">
            <span class="gl"></span>
            <span class="who">—</span>
          </div>
          <div class="death-hpbar"><span class="trk"><i></i></span><span class="hp num"></span></div>
        </div>
        <div class="death-respawn">
          <div class="death-ring">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle class="trk" cx="50" cy="50" r="44"></circle>
              <circle class="arc" cx="50" cy="50" r="44"></circle>
            </svg>
            <div class="death-count num">4</div>
          </div>
          <div class="death-prompt">REDEPLOYING</div>
        </div>
      </div>`);
    r.appendChild(death);

    // ---- ref table (queried exactly once) ----
    this.el = {
      root: r, vignette, flash, blind, top, perf, captions, ammo, health, xh, hitmark, arcs,
      notice, streak, death, center, streaks, uav, scope,
      scopeBreath: scope.querySelector('.scope-breath'),
      scopeBreathFill: scope.querySelector('.scope-breath .fil'),
      scopeUses: scope.querySelectorAll('use'),
      scoreA: top.querySelector('.score-team.a .val'),
      scoreB: top.querySelector('.score-team.b .val'),
      tagA: top.querySelector('.score-team.a .tag'),
      tagB: top.querySelector('.score-team.b .tag'),
      clock: top.querySelector('.clock'),
      modeTxt: top.querySelector('.mode'),
      metric: top.querySelector('.metric'),
      scoreMid: top.querySelector('.score-mid'),
      pFps: perf.querySelector('.p-fps'),
      pMs: perf.querySelector('.p-ms'),
      pDc: perf.querySelector('.p-dc'),
      pTri: perf.querySelector('.p-tri'),
      pNet: perf.querySelector('.p-net'),
      ammoMag: ammo.querySelector('.ammo-mag'),
      ammoRes: ammo.querySelector('.ammo-res'),
      ammoName: ammo.querySelector('.wn'),
      ammoMode: ammo.querySelector('.ammo-mode'),
      ammoPrompt: ammo.querySelector('.ammo-prompt'),
      ammoTrack: ammo.querySelector('.ammo-track'),
      ammoMagBar: ammo.querySelector('.ammo-track .mag'),
      ammoLoadBar: ammo.querySelector('.ammo-track .load'),
      kitSec: ammo.querySelector('.kit-slot.sec'),
      kitSecGl: ammo.querySelector('.kit-slot.sec .gl'),
      kitSecNm: ammo.querySelector('.kit-slot.sec .nm'),
      kitNade: ammo.querySelector('.kit-slot.nade'),
      kitNadeN: ammo.querySelector('.kit-slot.nade b'),
      hpValue: health.querySelector('.hp-value'),
      hpSegs: Array.from(health.querySelectorAll('.hp-seg')),
      hpArmorSegs: Array.from(health.querySelectorAll('.hp-armor i')),
      stList: streaks.querySelector('.st-list'),
      stKey: streaks.querySelector('.st-key'),
      noticeMain: notice.querySelector('.notice-main'),
      noticeSub: notice.querySelector('.notice-sub'),
      streakN: streak.querySelector('b'),
      deathTitle: death.querySelector('.death-title'),
      deathWho: death.querySelector('.who'),
      deathGl: death.querySelector('.gl'),
      deathHow: death.querySelector('.death-how'),
      deathHp: death.querySelector('.hp'),
      deathHpBar: death.querySelector('.death-hpbar i'),
      deathHpWrap: death.querySelector('.death-hpbar'),
      deathCount: death.querySelector('.death-count'),
      deathArc: death.querySelector('.death-ring .arc'),
      deathPrompt: death.querySelector('.death-prompt'),
    };

    // Pooled streak chips — three is the killstreak INVENTORY_CAP.
    this._streakChips = [];
    for (let i = 0; i < 3; i++) {
      const c = mk('st-chip', '<b class="n"></b><span class="c"></span>');
      this.el.stList.appendChild(c);
      this._streakChips.push({ el: c, name: c.querySelector('.n'), cost: c.querySelector('.c') });
    }

    // The countdown ring is stroke-dashoffset driven; cache its circumference.
    this._ringLen = 2 * Math.PI * 44;
    if (this.el.deathArc) {
      this.el.deathArc.style.strokeDasharray = String(this._ringLen);
      this.el.deathArc.style.strokeDashoffset = '0';
    }
  }

  /* ======================================================================
     EVENTS
     ====================================================================== */

  _bindEvents() {
    const bus = this.game?.bus;
    if (!bus) return;
    const on = (n, f) => { const u = bus.on(n, f); if (u) this._unsubs.push(u); };

    on('hit', (p) => {
      if (!p) return;
      const me = this.game?.player;
      if (p.shooter && me && p.shooter !== me) return;
      // An absorbed round hit a spawn-protected enemy and did nothing. It still gets a
      // marker — the aim WAS good — but never the normal one, or it reads as damage dealt.
      this.hitmarker(!!p.headshot && !p.absorbed);
    });

    on('damage', (p) => {
      if (!p) return;
      // Damage numbers are for damage WE dealt. Damage taken arrives as
      // `playerDamaged` — Player.applyDamage always raises it, with a real
      // world-space direction, so there is nothing to reconstruct here.
      if (p.attacker === this.game?.player && p.target !== p.attacker) this._pushDamageNumber(p);
    });

    on('playerDamaged', (p) => {
      this.damageIndicator(p?.dirWorld);
      this._flash = Math.min(1, this._flash + 0.35 + Math.min(0.5, (p?.amount || 10) / 90));
    });

    // Nothing else in the build renders a flashbang: FX has no `flashbang()` and the
    // call site opt-chains straight past it. The 2D layer is where a blind belongs.
    on('flashbang', (p) => {
      const amount = clamp01(p?.amount ?? 0);
      if (amount <= 0.02) return;
      const dur = Math.max(0.3, Number(p?.duration) || 1.2);
      this._blind = Math.max(this._blind, amount);
      this._blindDecay = 1 / dur;
    });

    // Live grenades inside their warning radius. The payload object is REUSED by
    // ProjectileSystem, so every field must be copied out on this tick.
    on('grenadeWarning', (p) => {
      if (!p) return;
      this._pushGrenadeWarning(p.id | 0, p.position, p.fuse, !!p.friendly);
    });
    on('grenadeWarningEnd', (p) => this._clearGrenadeWarning(p?.id | 0));

    on('kill', (p) => {
      if (!p) return;
      const me = this.game?.player;
      this.killfeed(p);
      if (p.attacker === me && p.victim !== me) {
        this.hitmarker(!!p.headshot, true);
        // XP figures come straight from the progression table so the HUD can
        // never drift from what the after-action screen actually banks.
        this._pushXp(XP_VALUES.kill, 'KILL', 'kill');
        if (p.headshot) this._pushXp(XP_VALUES.headshot, 'HEADSHOT', 'hs');
        if ((p.distance || 0) > LONGSHOT_M) this._pushXp(XP_VALUES.longshot, 'LONGSHOT', 'ls');
        const st = me?.stats?.streak | 0;
        if (st >= 2) this._showStreak(st);
      }
      if (p.victim === me) {
        // Match calls deathScreen() too (with the authoritative respawn delay); this
        // path carries the weapon/headshot/distance detail that its call omits, and
        // deathScreen() merges rather than restarts once the overlay is already up.
        this.deathScreen({
          killer: p.attacker && p.attacker !== me ? p.attacker : null,
          killerName: p.attacker?.name,
          killerHealth: p.attacker?.health,
          weaponId: p.weaponId,
          headshot: !!p.headshot,
          distance: p.distance || 0,
        });
      }
    });

    on('spawn', (p) => {
      if (p?.entity && p.entity === this.game?.player) this.deathScreen(null);
    });

    on('notice', (p) => this.notice(p?.text, p?.sub, p?.duration));
    on('audioCaption', (p) => this._showAudioCaption(p));
    on('tacticalPing', (p) => {
      const label = p?.kind === 'danger' ? 'DANGER' : p?.kind === 'objective' ? 'OBJECTIVE' : 'LOCATION';
      this.notice(`TEAM PING · ${label}`, p?.senderId ? `PLAYER ${p.senderId}` : '', 1.8);
    });

    on('killstreak', (p) => {
      if (p?.entity && p.entity === this.game?.player) {
        this._showStreak(p.count | 0);
        this._pushXp(XP_VALUES.streak, 'KILLSTREAK', 'ks');
      }
    });

    on('killstreakActivated', (p) => {
      if (!p) return;
      if (p.entity === this.game?.player) this._pushXp(0, `${p.name} DEPLOYED`, 'ks');
      this._c.streaks = '';   // force the tray to repaint on the next frame
      this._c.uav = null;     // and the UAV chip to re-evaluate
    });

    on('matchStart', () => { this.reset(); this._setLive(true); });
    on('matchEnd', () => { this._setLive(false); this.scoreboard.setVisible(false); });
    on('toMenu', () => { this.reset(); this._setLive(false); });

    on('reloadStart', (p) => {
      if (p?.shooter && p.shooter !== this.game?.player) return;
      this._reloading = true;
    });
    on('reloadEnd', (p) => {
      if (p?.shooter && p.shooter !== this.game?.player) return;
      this._reloading = false;
    });

    const settings = this.game?.settings;
    if (settings?.onChange) {
      const u = settings.onChange((k, v) => this._applySetting(k, v));
      if (u) this._unsubs.push(u);
    }

    // Rank-ups are rare and worth the whole screen. Chain rather than clobber:
    // progression exposes a single hook and the menu may want it too.
    const prevLevelUp = progression.onLevelUp;
    this._prevLevelUp = prevLevelUp;
    progression.onLevelUp = (level, prev, self) => {
      try { prevLevelUp?.(level, prev, self); } catch { /* not ours to police */ }
      this.notice(`RANK ${level}`, progression.getRankName(level), 3.2);
      this._queueProgressionStinger('levelUp');
    };
    const prevUnlock = progression.onUnlock;
    this._prevUnlock = prevUnlock;
    progression.onUnlock = (id, level) => {
      try { prevUnlock?.(id, level); } catch { /* not ours to police */ }
      this._queueProgressionStinger('unlock');
    };
  }

  /**
   * One stinger per progression event, however many callbacks it fires.
   *
   * `progression.award()` calls `onLevelUp` once and then `onUnlock` ONCE PER UNLOCKED ID,
   * synchronously, in a single tick — a rank that hands over two weapons is an ordinary
   * event. Playing each callback would put three buffer sources on the UI bus in the same
   * millisecond, two of them the identical file: that is not three sounds, it is one sound
   * with a flam and partial phase cancellation, the same defect the `error` cue is throttled
   * for. So the callbacks only mark intent, and one cue is voiced after the burst has
   * finished. `unlock` wins over `levelUp` when both land, which is the rule the after-action
   * report in menu.js already states: a new weapon is bigger news than the rank that gave it
   * to you.
   *
   * A microtask is the right deferral: `award()`'s loop is synchronous, so the queue drains
   * once it returns, and unlike a timer it cannot be throttled in a background tab or land
   * after the player has already left the screen.
   *
   * The stingers themselves belong to the shell's UI player, not the match mix: they are
   * interface feedback, they follow the interface volume, and routing them there means one
   * AudioContext serves both sides of the boundary. `?.` throughout — in a headless run
   * nothing ever created a controller and this is a no-op.
   */
  _queueProgressionStinger(cue) {
    if (cue === 'unlock') this._pendingStinger = 'unlock';
    else if (!this._pendingStinger) this._pendingStinger = 'levelUp';
    if (this._stingerQueued) return;
    this._stingerQueued = true;
    queueMicrotask(() => {
      this._stingerQueued = false;
      const pending = this._pendingStinger;
      this._pendingStinger = null;
      if (!pending || this._disposed) return;
      getShellAudio()?.play?.(pending);
    });
  }

  /* ======================================================================
     SETTINGS
     ====================================================================== */

  _applyAllSettings() {
    for (const k of ['hudScale', 'hudTextSize', 'crosshairStyle', 'crosshairColor',
      'crosshairOpacity', 'crosshairSize', 'crosshairThickness', 'crosshairGap',
      'crosshairOutline', 'showMinimap', 'minimapRotation', 'showFps', 'showDamageNumbers',
      'showKillfeed', 'showObjectiveMarkers', 'damageVignette', 'flashIntensity',
      'screenEffectIntensity', 'captionBackground', 'subtitleSize', 'networkDiagnosticsOverlay',
      'binds']) {
      this._applySetting(k, this.game?.settings?.get?.(k));
    }
  }

  _applySetting(k, v) {
    if (k === '*') { this._applyAllSettings(); return; }
    switch (k) {
      case 'hudScale':
        document.documentElement.style.setProperty('--hud-scale', String(v ?? 1));
        // The em-derived crosshair gap changed; re-measure on the next frame.
        requestAnimationFrame(() => this._onResize());
        break;
      case 'hudTextSize':
        this.el.root.dataset.hudTextSize = String(v || 'default');
        break;
      case 'crosshairStyle': {
        const style = String(v ?? 'dynamic');
        if (this._c.xhStyle !== style) {
          this._c.xhStyle = style;
          this.el.xh.dataset.style = style;
          // A static reticle keeps a fixed gap; the dot style has no ticks.
          if (style !== 'dynamic') this._writeSpread(this._gapPx);
        }
        break;
      }
      case 'crosshairColor': {
        const col = String(v ?? '#8ef7c4');
        if (this._c.xhColor !== col) {
          this._c.xhColor = col;
          this.el.xh.style.setProperty('--xh-color', col);
        }
        break;
      }
      case 'crosshairOpacity':
        this.el.xh.style.setProperty('--xh-opacity', String(v ?? 1));
        break;
      case 'crosshairSize':
        this.el.xh.style.setProperty('--xh-size', String(v ?? 1));
        break;
      case 'crosshairThickness':
        this.el.xh.style.setProperty('--xh-thickness', String(v ?? 2));
        break;
      case 'crosshairGap':
        this.el.xh.style.setProperty('--xh-gap', `${Number(v) || 0}px`);
        this._gapPx = Number(v) || 0;
        this._c.spread = -1;
        break;
      case 'crosshairOutline':
        this.el.xh.dataset.outline = v === false ? 'off' : 'on';
        break;
      case 'showMinimap':
        this.minimap.setVisible(v !== false);
        break;
      case 'minimapRotation':
        this.minimap.setOrientation(v);
        break;
      case 'showFps':
        this.el.perf.classList.toggle('fps-on', v !== false);
        this.el.perf.classList.toggle('on', v !== false || this._networkOverlay !== 'off');
        break;
      case 'showDamageNumbers':
        this._showDnums = v !== false;
        if (!this._showDnums) for (const d of this._dnums) this._freeDnum(d);
        break;
      case 'showKillfeed':
        this.killfeedUI.el.hidden = v === false;
        break;
      case 'showObjectiveMarkers':
        this.el.root.dataset.objectiveMarkers = v === 'minimal' ? 'minimal' : 'full';
        break;
      case 'damageVignette':
        this._damageVignetteScale = v === 'off' ? 0 : v === 'low' ? 0.4 : 1;
        this._c.vignette = -1;
        break;
      case 'flashIntensity':
        this._flashIntensity = Math.max(0, Math.min(1, Number(v) || 0));
        break;
      case 'screenEffectIntensity':
        this._screenEffectIntensity = Math.max(0, Math.min(1, Number(v) || 0));
        this._c.vignette = -1;
        break;
      case 'captionBackground':
        this.el.captions.style.setProperty('--caption-bg', String(v ?? 0.75));
        break;
      case 'subtitleSize':
        this.el.captions.dataset.size = String(v || 'default');
        break;
      case 'networkDiagnosticsOverlay':
        this._networkOverlay = ['compact', 'full'].includes(v) ? v : 'off';
        this.el.perf.dataset.network = this._networkOverlay;
        this.el.perf.classList.toggle('on', this._networkOverlay !== 'off'
          || this.game?.settings?.get?.('showFps') !== false);
        this._c.perf = '';
        break;
      case 'binds':
        // Binding labels are read lazily. Invalidate prompt caches so a visible reload or
        // killstreak prompt changes on the next HUD poll rather than after unrelated ammo state.
        this._c.ammoState = '';
        this._c.streaks = '';
        break;
      default:
        break;
    }
  }

  /* ======================================================================
     §10 PUBLIC API
     ====================================================================== */

  /** `setAmmo(mag, reserve)` or `setAmmo({ mag, reserve })`. */
  setAmmo(mag, reserve) {
    if (mag && typeof mag === 'object') {
      reserve = mag.reserve ?? mag.res ?? 0;
      mag = mag.mag ?? mag.ammo ?? 0;
    }
    this._writeAmmo(mag | 0, reserve | 0, this._magSize || Math.max(1, mag | 0));
  }

  /** `setHealth(hp, max, armor)` or `setHealth({ health, maxHealth, armor })`. */
  setHealth(hp, max, armor) {
    if (hp && typeof hp === 'object') {
      max = hp.maxHealth ?? hp.max ?? 100;
      armor = hp.armor ?? 0;
      hp = hp.health ?? hp.hp ?? 0;
    }
    this._writeHealth(hp ?? 0, max ?? 100, armor ?? 0);
  }

  /** `setWeapon(nameOrDef, fireMode)` — WeaponSystem pushes the def on every swap. */
  setWeapon(weapon, fireMode) {
    let name = weapon;
    let mode = fireMode;
    let def = null;
    if (weapon && typeof weapon === 'object') {
      def = weapon.def ?? weapon;
      name = def.name ?? def.id ?? '—';
      mode = mode ?? def.fireMode;
      this._magSize = def.magSize ?? this._magSize;
    }
    this._writeWeapon(String(name ?? '—'), mode, def);
  }

  /** WeaponSystem.throwGrenade() reports the remaining equipment here. */
  setEquipment(lethal, tactical) {
    this._equip = { lethal: lethal | 0, tactical: tactical | 0 };
  }

  /** Pop the hitmarker. `kill` upgrades it to the kill variant. */
  hitmarker(headshot = false, kill = false) {
    const kind = kill ? 'kill' : headshot ? 'head' : 'hit';
    // A kill marker outranks an in-flight body marker.
    if (this._hm.t < this._hm.life && this._hm.kind === 'kill' && kind !== 'kill') return;
    if (this._c.hmKind !== kind) {
      this._c.hmKind = kind;
      this.el.hitmark.dataset.kind = kind;
    }
    this._hm.kind = kind;
    this._hm.t = 0;
    this._hm.life = kill ? HM_KILL_LIFE : HM_LIFE;
    this._xhHitT = kill ? 0.28 : 0.14;
  }

  /** Push a killfeed entry (raw `kill` payload or a flattened entry). */
  killfeed(entry) {
    if (!entry) return;
    if (entry.weaponClass === undefined && entry.weaponId) {
      entry = Object.assign({}, entry, { weaponClass: classOf(entry.weaponId) });
    }
    this.killfeedUI.add(entry);
  }

  /** Directional damage arc. `dirWorld` points from the player to the attacker. */
  damageIndicator(dirWorld) {
    if (!dirWorld || typeof dirWorld.x !== 'number') return;
    const dx = dirWorld.x;
    const dz = dirWorld.z;
    // Fall damage and world hazards arrive as (0,-1,0): no horizontal bearing to show.
    if (dx * dx + dz * dz < 1e-6) return;

    const me = this.game.player;
    const yaw = me?.yaw || 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // forward, per §1
    const deg = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz) / DEG;

    // Merge into a live arc pointing in roughly the same direction so a burst
    // reads as one attacker rather than a ring of noise.
    for (const a of this._arcs) {
      if (a.active && Math.abs(angDiff(a.ang, deg)) < 18) {
        a.t = 0;
        a.ang = deg;
        return;
      }
    }
    let slot = null;
    let oldest = null;
    for (const a of this._arcs) {
      if (!a.active) { slot = a; break; }
      if (!oldest || a.t > oldest.t) oldest = a;
    }
    slot = slot || oldest;
    if (!slot) return;
    slot.active = true;
    slot.t = 0;
    slot.ang = deg;
    slot.el.style.setProperty('--a', deg.toFixed(1) + 'deg');
  }

  /** Big centre-screen text. */
  notice(text, sub = '', dur = 2.4) {
    if (!text) return;
    const n = this.el.notice;
    this.el.noticeMain.textContent = String(text).toUpperCase();
    this.el.noticeSub.textContent = sub ? String(sub).toUpperCase() : '';
    this.el.noticeSub.style.display = sub ? '' : 'none';
    n.classList.remove('fade', 'anim');
    n.classList.add('on');
    // Rare event: one forced reflow to restart the entrance keyframes.
    void n.offsetWidth;
    n.classList.add('anim');
    this._noticeT = 0;
    this._noticeDur = Math.max(0.5, dur || 2.4);
  }

  /**
   * Crosshair gap in pixels — the cone half-angle already projected to screen
   * space. WeaponSystem.update() pushes this every frame it changes, using the
   * same tan(deg)/tan(fov/2) projection we use when we have to poll it.
   */
  setCrosshairSpread(px) {
    this._spreadExternal = true;
    const style = this._c.xhStyle;
    if (style === 'static' || style === 'dot') { this._writeSpread(this._gapPx); return; }
    this._writeSpread(this._gapPx + Math.max(0, px));
  }

  setScore(a, b) {
    this._scoreExternal = true;
    this._writeScore(a | 0, b | 0);
  }

  setTimer(seconds) {
    this._timerExternal = true;
    this._timerSec = seconds || 0;
    this._writeTimer(this._timerSec);
  }

  /** 0..1 low-health vignette strength. */
  lowHealthVignette(t) {
    this._vigExternal = true;
    this._writeVignette(clamp01(t));
  }

  /**
   * Death overlay. Match calls this with the authoritative killer row when it
   * queues the respawn, and again with `null` the moment the player is back.
   * @param {null|{killer?:object, killerName?:string, killerHealth?:number,
   *               respawnIn?:number, weaponId?:string, headshot?:boolean,
   *               distance?:number}} info
   */
  deathScreen(info) {
    if (!info) { this._hideDeath(); return; }
    const d = this._death;
    const first = !d.on;
    d.on = true;
    if (first) { d.t = 0; d.info = null; }

    // Two callers describe one death: Match._queueRespawn knows the authoritative
    // respawn delay, the `kill` event knows the weapon, headshot and range. Merge
    // them so whichever lands second cannot erase the other's half.
    d.info = Object.assign(d.info || {}, info);
    const merged = d.info;
    if (info.respawnIn != null) d.delay = Number(info.respawnIn) || 4;
    else if (first) d.delay = Number(this.game?.match?.respawnDelay) || 4;

    const atk = merged.killer || null;
    const suicide = !atk && !merged.killerName;
    const who = String(merged.killerName || atk?.name || 'THE SECTOR').toUpperCase();
    const wid = merged.weaponId ?? null;
    const key = who + '|' + (wid || '');
    if (key !== this._c.deathKiller) {
      this._c.deathKiller = key;
      this.el.deathWho.textContent = who;
      this.el.deathGl.innerHTML = weaponGlyph(classOf(wid), wid);
    }

    // The "how" line: headshot flag, weapon name and range, all from real payloads.
    const def = wid ? getWeapon(wid) : null;
    const dist = Number(merged.distance) || 0;
    let how = '';
    if (merged.headshot) how = 'HEADSHOT';
    if (def && def.id === wid) how = how ? `${how} · ${def.shortName || def.name}` : String(def.shortName || def.name);
    if (dist > 0) how = how ? `${how} · ${dist.toFixed(0)} M` : `${dist.toFixed(0)} M`;
    if (suicide) how = 'NO ATTACKER';
    if (how !== this._c.deathHow) { this._c.deathHow = how; this.el.deathHow.textContent = how; }
    this.el.death.classList.toggle('headshot', !!merged.headshot);
    this.el.death.classList.toggle('longshot', dist > LONGSHOT_M);

    const hp = Number(merged.killerHealth ?? atk?.health);
    const maxHp = Number(atk?.maxHealth) || 100;
    const known = isFinite(hp) && !!atk;
    const shownHp = known ? Math.round(hp) : -1;
    if (this._c.deathHp !== shownHp) {
      this._c.deathHp = shownHp;
      this.el.deathHpWrap.style.display = known ? '' : 'none';
      if (known) {
        this.el.deathHp.textContent = `${Math.max(0, shownHp)} HP LEFT`;
        this.el.deathHpBar.style.transform = `scaleX(${clamp01(hp / maxHp).toFixed(3)})`;
      }
    }

    this._c.deathCount = -1;
    this._c.deathReady = null;
    if (first) {
      this.el.death.classList.remove('on');
      void this.el.death.offsetWidth;    // rare event — restart the entrance
      this.el.death.classList.add('on');
    }
  }

  /* ======================================================================
     LIFECYCLE
     ====================================================================== */

  reset() {
    this._hm.t = 1e9;
    this._flash = 0;
    this._blind = 0;
    this._vig = 0;
    this._xpOffset = 0;
    this._reloading = false;
    this._equip = null;
    for (const a of this._arcs) { a.active = false; a.el.style.opacity = '0'; }
    for (const g of this._grens) { g.active = false; g.el.className = 'gren-warn'; }
    for (const d of this._dnums) this._freeDnum(d);
    for (const x of this._xp) this._freeXp(x);
    this.killfeedUI.reset();
    this.minimap.reset();
    this.scoreboard.reset();
    this.bombHud.reset();
    this.raidHud.reset();
    this.scoreboard.setVisible(false);
    this._hideDeath();
    this.el.notice.classList.remove('on', 'anim', 'fade');
    this.el.streak.classList.remove('on');
    this.el.hitmark.style.opacity = '0';
    this.el.uav.classList.remove('on');
    this._writeVignette(0);
    this.el.flash.style.opacity = '0';
    this.el.blind.style.opacity = '0';
    this._c.flash = 0;
    this._c.blind = 0;
    this._c.vignette = 0;
    this._c.hpSegs.fill(-1);
    this._c.armorSegs.fill(-1);
    this._c.mag = this._c.reserve = this._c.hp = -1;
    this._c.scoreA = this._c.scoreB = this._c.timer = -1;
    this._c.streaks = '';
    this._c.secondary = '';
    this._c.nades = -1;
    this._c.reloadP = -1;
    this._c.magFrac = -1;
    this._c.uav = null;
    this._c.phase = '';
    this._c.scopeAmt = 0;
    this._c.scopeSize = -1;
    this._c.scopeBreath = -1;
    this._c.scopeHold = null;
    this.el.scope.style.opacity = '0';
    this.el.scope.style.visibility = 'hidden';
    this._c.deathKiller = '';
    this._c.deathHow = '';
    this._spreadExternal = false;
    this._scoreExternal = false;
    this._timerExternal = false;
    this._vigExternal = false;
  }

  update(dt) {
    const g = this.game;
    if (!g) return;

    const live = g.state === 'playing' || g.state === 'paused';
    this._setLive(live);

    if (this._regenT > 0) this._regenT = Math.max(0, this._regenT - dt);

    if (live) {
      this._pollHealth();
      this._pollWeapon();
      if (!this._spreadExternal) this._pollSpread();
      this._pollMatch();
      this._pollKit();
      this._pollStreaks();
      this._pollScope();
    } else if (this._c.scopeAmt !== 0) {
      this._pollScope();
    }

    this._tickHitmarker(dt);
    this._tickArcs(dt);
    this._tickGrenades(dt);
    this._tickDamageNumbers(dt);
    this._tickXp(dt);
    this._tickNotice(dt);
    this._tickStreak(dt);
    this._tickFlash(dt);
    this._tickBlind(dt);
    this._tickDeath(dt);
    this._tickCrosshairHit(dt);
    if (this._captionT > 0) {
      this._captionT = Math.max(0, this._captionT - dt);
      if (this._captionT === 0) this.el.captions.textContent = '';
    }

    this.killfeedUI.update(dt);

    if (live) {
      const wantSb = !!g.input?.isDown?.('scoreboard') && !g.paused;
      this.scoreboard.setTime(this._timerSec);
      this.scoreboard.setVisible(wantSb);
      this.scoreboard.update(dt);
      this.minimap.draw(dt);
      this.bombHud.update(dt);
      this.raidHud.update(dt);
    } else if (this.scoreboard.visible) {
      this.scoreboard.setVisible(false);
      this.bombHud.update(dt);
      this.raidHud.update(dt);
    } else {
      this.bombHud.update(dt);
      this.raidHud.update(dt);
    }

    this._tickPerf(dt);
  }

  dispose() {
    // A stinger queued in the tick the HUD was torn down has nothing left to announce.
    this._disposed = true;
    this._pendingStinger = null;
    window.removeEventListener('resize', this._onResize);
    for (const u of this._unsubs) { try { u(); } catch { /* ignore */ } }
    this._unsubs.length = 0;
    progression.onLevelUp = this._prevLevelUp ?? null;
    progression.onUnlock = this._prevUnlock ?? null;
    this.killfeedUI.dispose();
    this.minimap.dispose();
    this.scoreboard.dispose();
    this.bombHud.destroy();
    this.raidHud.destroy();
    if (this.root) this.root.innerHTML = '';
  }

  /* ======================================================================
     POLLING — all of it reads the real systems
     ====================================================================== */

  /**
   * The live WeaponInstance for the local player (§7). `WeaponSystem.current()` is
   * the authority — `entity.weapon` is its §4 mirror and lags by exactly one
   * `switchTo()` commit, which is the frame the swap animation plays on.
   */
  get _weapon() {
    const g = this.game;
    const p = g.player;
    return p ? (g.weapons?.current(p) || null) : null;
  }

  _pollHealth() {
    const p = this.game?.player;
    if (!p) return;
    this._writeHealth(p.health ?? 0, p.maxHealth ?? 100, p.armor ?? 0);
    if (!this._vigExternal) {
      const t = p.alive === false ? 0 : clamp01(1 - (p.health ?? 100) / Math.max(1, (p.maxHealth ?? 100) * 0.45));
      this._writeVignette(t);
    }
  }

  _pollWeapon() {
    const w = this._weapon;
    if (!w) {
      this._writeWeapon('—', null, null);
      this._writeAmmo(0, 0, 1);
      this._writeReload(-1);
      return;
    }
    const def = w.def || {};
    this._magSize = def.magSize ?? 30;
    this._writeWeapon(def.name ?? def.id ?? '—', def.fireMode, def);
    this._writeAmmo(w.ammo | 0, w.reserve | 0, this._magSize, w.state);
    // `isReloading` / `stateProgress` are real WeaponInstance getters.
    this._writeReload(w.isReloading ? clamp01(w.stateProgress) : -1);
    this._updateAdsFade(w);
  }

  _pollSpread() {
    const w = this._weapon;
    const style = this._c.xhStyle;
    if (style === 'static' || style === 'dot') { this._writeSpread(this._gapPx); return; }
    if (!w) { this._writeSpread(this._gapPx); return; }
    // WeaponInstance.getCurrentSpread() returns the cone HALF-ANGLE in DEGREES.
    const deg = Number(w.getCurrentSpread?.()) || 0;
    // Project it: focal length in pixels times tan(angle) is the honest gap.
    const fov = this.game?.camera?.fov || 85;
    const focal = (this._vh * 0.5) / Math.tan(fov * 0.5 * DEG);
    const px = Math.tan(Math.max(0, deg) * DEG) * focal;
    this._writeSpread(this._gapPx + Math.min(px, this._vh * 0.34));
  }

  _updateAdsFade(w) {
    const def = w?.def;
    const ads = w?.adsAmount ?? 0;
    // Optics with real magnification hide the reticle; a red dot keeps it.
    const optic = !!def && (def.class === 'sniper' || (def.adsFov ?? 60) <= 42);
    // A scoped weapon must never show both crosshairs at once, and the scope's own
    // reticle starts fading in at adsAmount 0.52 — before the 0.55 rule below fires.
    const scoping = !!def?.scoped && ads > 0.5;
    const hide = (optic && ads > 0.55) || scoping;
    if (this._c.xhHidden !== hide) {
      this._c.xhHidden = hide;
      this.el.xh.classList.toggle('ads', hide);
    }
  }

  /**
   * The telescopic sight overlay.
   *
   * The aperture is expressed in screen HALF-HEIGHTS by `ScopeFX`, and three keeps
   * vertical FOV fixed, so `apertureR * innerHeight` is the aperture diameter in CSS
   * pixels at any aspect ratio — the same circle the composite shader masks. Nothing
   * here reads layout, and every write is guarded by a cached value, so a scoped frame
   * costs at most three style writes and normally zero.
   */
  _pollScope() {
    const el = this.el.scope;
    if (!el) return;
    const s = this.game.engine?.scope;
    const amt = s && s.active ? s.amount : 0;

    if (amt <= 0.002) {
      if (this._c.scopeAmt !== 0) {
        this._c.scopeAmt = 0;
        this._c.scopeHold = null;
        el.style.opacity = '0';
        el.style.visibility = 'hidden';
      }
      return;
    }

    // Per-weapon reticle. `scopeReticle` is authored on the optic in weaponDefs; the
    // href swap is cached like every other write here, so it costs nothing per frame
    // and exactly two attribute writes on a weapon change.
    const ret = this.game.player?.weapon?.def?.viewmodel?.optic?.scopeReticle || 'mildot';
    if (ret !== this._c.scopeRet) {
      this._c.scopeRet = ret;
      const href = ret === 'ranging' ? '#os-ret-ranging' : '#os-ret-mildot';
      for (const u of this.el.scopeUses) u.setAttribute('href', href);
    }

    const size = Math.round(s.apertureR * this._vh * 1.2);
    if (size !== this._c.scopeSize) {
      this._c.scopeSize = size;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
    }

    // The reticle waits for the gun to get out of the way (viewmodel.js hides it at
    // 0.5) — a hairline cross floating over a rifle that is still coming up reads as a
    // bug. From there it comes in fast.
    const q = Math.round(Math.min(1, Math.max(0, (amt - 0.48) / 0.34)) * 200) / 200;
    if (q !== this._c.scopeAmt) {
      const wasOff = this._c.scopeAmt <= 0;
      this._c.scopeAmt = q;
      el.style.opacity = String(q);
      if (wasOff) el.style.visibility = 'visible';
      // Settles from slightly oversize as the sight comes up — the eye reading a scope
      // that is not yet at the right eye relief. Transform only: no layout, no paint.
      el.style.transform = `translate(-50%,-50%) scale(${(1 + (1 - q) * 0.16).toFixed(3)})`;
    }

    // Breath meter, on the scope body just under the glass. Breath is aim state (see
    // player.js) — it moves scope sway, which moves player.yaw/pitch — not a camera field.
    const p = this.game.player;
    const b = p ? clamp01(p.breath) : 1;
    const hold = !!p?.breathHolding;
    // Quantised to whole scope units: an SVG attribute write repaints the whole
    // 800-pixel overlay, and a meter that is 46 units wide cannot show more than 46
    // states anyway.
    const w = Math.round(b * 46);
    if (w !== this._c.scopeBreath) {
      this._c.scopeBreath = w;
      this.el.scopeBreathFill.setAttribute('width', String(w));
    }
    const show = hold || b < 0.995;
    if (show !== this._c.scopeHold) {
      this._c.scopeHold = show;
      this.el.scopeBreath.setAttribute('class', show ? 'scope-breath on' : 'scope-breath');
    }
  }

  _pollMatch() {
    const m = this.game.match;
    if (!m) return;

    // `phase` is 'idle' | 'countdown' | 'live' | 'ended'. The countdown is a real
    // freeze — Match.canFire() refuses fire — so the HUD says so instead of
    // pretending the fight has started.
    const phase = m.phase;
    if (phase !== this._c.phase) {
      this._c.phase = phase;
      this.el.root.dataset.phase = phase;
      this.el.ammoPrompt.classList.toggle('standby', phase === 'countdown');
    }

    // A UAV is a genuine tactical state change; `uavActive` is one map lookup.
    const uav = !!m.uavActive(this.game.player?.team ?? 0);
    if (uav !== this._c.uav) {
      this._c.uav = uav;
      this.el.uav.classList.toggle('on', uav);
    }

    if (!this._scoreExternal) {
      const sc = m.scores;
      this._writeScore(sc[0] | 0, sc[1] | 0);
    }
    if (!this._timerExternal && typeof m.timeRemaining === 'number') {
      this._timerSec = m.timeRemaining;
      this._writeTimer(this._timerSec);
    }
    // `modeName` is the mode's display name; `hudLabels` names the two columns
    // and the metric they count. Both come from the mode rule object.
    const txt = String(m.modeName || modeLabel(m.mode));
    if (txt !== this._c.modeTxt) { this._c.modeTxt = txt; this.el.modeTxt.textContent = txt; }

    const lab = m.mode?.hudLabels;
    const names = m.teamNames;
    const a = String(lab?.left ?? names?.[0] ?? 'ALPHA').toUpperCase();
    const b = String(lab?.right ?? names?.[1] ?? 'BRAVO').toUpperCase();
    if (a !== this._c.tagA) { this._c.tagA = a; this.el.tagA.textContent = a; }
    if (b !== this._c.tagB) { this._c.tagB = b; this.el.tagB.textContent = b; }
    const metric = String(lab?.metric ?? 'KILLS').toUpperCase();
    const met = `${metric} · FIRST TO ${m.killLimit | 0}`;
    if (met !== this._c.metric) { this._c.metric = met; this.el.metric.textContent = met; }
  }

  _pollKit() {
    const g = this.game;
    const p = g.player;
    if (!p) return;

    // The loadout record is `{ weapons: WeaponInstance[], index, lastIndex, equipment }`.
    const lo = g.weapons?.getLoadout(p);
    let secDef = null;
    if (lo && lo.weapons.length > 1) {
      for (let i = 0; i < lo.weapons.length; i++) {
        if (i === lo.index) continue;
        secDef = lo.weapons[i].def;
        if (secDef) break;
      }
    }
    const secName = secDef ? String(secDef.shortName || secDef.name || secDef.id) : '';
    if (secName !== this._c.secondary) {
      this._c.secondary = secName;
      if (secName) {
        this.el.kitSec.style.display = '';
        this.el.kitSecNm.textContent = secName.toUpperCase();
        this.el.kitSecGl.innerHTML = weaponGlyph(secDef.class, secDef.id);
      } else {
        this.el.kitSec.style.display = 'none';
      }
    }

    // Grenades: Player owns `grenades` and spends it in its own throw path, so it
    // is the count the button actually consumes. `setEquipment()` (pushed by
    // WeaponSystem.throwGrenade) covers any entity that routes through the system.
    const nades = (typeof p.grenades === 'number'
      ? p.grenades
      : this._equip ? this._equip.lethal : lo ? lo.equipment.lethalCount : 0) | 0;
    if (nades !== this._c.nades) {
      this._c.nades = nades;
      this.el.kitNadeN.textContent = String(nades);
      this.el.kitNade.classList.toggle('out', nades <= 0);
    }
  }

  /**
   * Earned, unspent killstreaks. `getAvailableDefs(entity, out)` fills and returns a
   * REUSED array of STREAK defs (`{ id, name, cost, duration, description }`) —
   * read it, never retain it. `activate()` spends the OLDEST first, which is why the
   * first chip is the one the button is about to deploy.
   */
  _pollStreaks() {
    const g = this.game;
    const ks = g.match?.killstreaks;
    const p = g.player;
    if (!ks || !p) return;
    const defs = ks.getAvailableDefs(p);
    let sig = '';
    for (let i = 0; i < defs.length; i++) sig += defs[i].id + ',';
    if (sig === this._c.streaks) return;
    this._c.streaks = sig;

    const chips = this._streakChips;
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i];
      const d = defs[i];
      if (!d) { c.el.classList.remove('on', 'next'); continue; }
      c.name.textContent = d.name;
      c.cost.textContent = String(d.cost);
      c.el.classList.add('on');
      c.el.classList.toggle('next', i === 0);
    }
    const any = defs.length > 0;
    this.el.streaks.classList.toggle('on', any);
    if (any) this.el.stKey.textContent = this._bindLabel('killstreak');
  }

  /* ======================================================================
     WRITERS (all early-out on unchanged values)
     ====================================================================== */

  _setLive(live) {
    if (this._c.live === live) return;
    this._c.live = live;
    this.el.root.classList.toggle('live', live);
    // `enter` holds the offset/opacity pre-state for the slide-in.
    if (live) requestAnimationFrame(() => this.el.root.classList.remove('enter'));
    else this.el.root.classList.add('enter');
  }

  _writeAmmo(mag, reserve, magSize, state) {
    const c = this._c;
    if (mag !== c.mag) { c.mag = mag; this.el.ammoMag.textContent = String(mag); }
    if (reserve !== c.reserve) { c.reserve = reserve; this.el.ammoRes.textContent = String(reserve); }

    const size = Math.max(1, magSize || 1);

    // Magazine fill — one scaleX, so it reads for a 5-round bolt gun and a 100-round
    // belt alike without pooling a pip per round.
    const frac = Math.round(clamp01(mag / size) * 100) / 100;
    if (frac !== c.magFrac) {
      c.magFrac = frac;
      this.el.ammoMagBar.style.transform = `scaleX(${frac.toFixed(2)})`;
    }

    const reloading = state === 'reloading' || this._reloading;
    const st = reloading ? 'reloading' : mag <= 0 ? 'empty' : mag / size < 0.25 ? 'low' : '';
    if (st !== c.ammoState) {
      c.ammoState = st;
      this.el.ammo.className = 'hud-ammo brk' + (st ? ' ' + st : '');
      if (st === 'reloading') this.el.ammoPrompt.textContent = 'RELOADING';
      else if (st === 'empty') {
        this.el.ammoPrompt.innerHTML = reserve > 0
          ? `PRESS <b>${this._bindLabel('reload')}</b> TO RELOAD`
          : 'OUT OF AMMUNITION';
      } else this.el.ammoPrompt.textContent = '';
    }
  }

  /** `p` is 0..1 while reloading, or -1 when idle. */
  _writeReload(p) {
    const q = p < 0 ? -1 : Math.round(clamp01(p) * 40) / 40;
    if (q === this._c.reloadP) return;
    this._c.reloadP = q;
    if (q < 0) {
      this.el.ammoTrack.classList.remove('loading');
    } else {
      this.el.ammoTrack.classList.add('loading');
      this.el.ammoLoadBar.style.transform = `scaleX(${q.toFixed(3)})`;
    }
  }

  _writeWeapon(name, mode, def) {
    const c = this._c;
    const n = String(name || '—').toUpperCase();
    if (n !== c.weapon) { c.weapon = n; this.el.ammoName.textContent = n; }
    let m = '';
    if (mode === 'auto') m = 'AUTO';
    else if (mode === 'semi') m = 'SEMI';
    else if (mode === 'burst') m = `${(def?.burstCount | 0) || 3}-BURST`;
    else if (mode) m = String(mode).toUpperCase();
    if (m !== c.mode) {
      c.mode = m;
      this.el.ammoMode.textContent = m || '—';
      this.el.ammoMode.style.display = m ? '' : 'none';
    }
  }

  _writeHealth(hp, max, armor) {
    const c = this._c;
    hp = Math.max(0, Math.round(hp));
    max = Math.max(1, Math.round(max));
    armor = Math.max(0, Math.round(armor || 0));

    if (hp !== c.hp) {
      // Rising health that is not a respawn snap means regeneration.
      if (this._lastHp >= 0 && hp > this._lastHp && hp < max) this._regenT = 0.55;
      this._lastHp = hp;
      c.hp = hp;
      this.el.hpValue.textContent = String(hp);
    }
    if (max !== c.hpMax) c.hpMax = max;

    const frac = hp / max;
    const segs = this.el.hpSegs;
    const n = segs.length;
    for (let i = 0; i < n; i++) {
      const f = clamp01(frac * n - i);
      const q = Math.round(f * 25) / 25;   // quantise so tiny drifts do not write
      if (this._c.hpSegs[i] !== q) {
        this._c.hpSegs[i] = q;
        segs[i].style.setProperty('--f', String(q));
      }
    }

    if (armor !== c.armor) {
      c.armor = armor;
      if (armor > 0) {
        const asegs = this.el.hpArmorSegs;
        const af = clamp01(armor / 100);
        for (let i = 0; i < asegs.length; i++) {
          const f = clamp01(af * asegs.length - i);
          const q = Math.round(f * 25) / 25;
          if (this._c.armorSegs[i] !== q) { this._c.armorSegs[i] = q; asegs[i].style.setProperty('--f', String(q)); }
        }
      }
    }

    const st = frac <= 0.28 ? 'crit' : frac <= 0.6 ? 'hurt' : '';
    const regen = this._regenT > 0;
    const key = st + (regen ? '+r' : '') + (armor > 0 ? '+a' : '');
    if (key !== c.hpState) {
      c.hpState = key;
      this.el.health.className = 'hud-health'
        + (st ? ' ' + st : '')
        + (regen ? ' regen' : '')
        + (armor > 0 ? ' armored' : '');
    }
  }

  _writeSpread(px) {
    const v = Math.round(Math.max(0, px) * 2) / 2;
    if (v === this._c.spread) return;
    this._c.spread = v;
    this.el.xh.style.setProperty('--sp', v + 'px');
  }

  _writeScore(a, b) {
    const c = this._c;
    if (a !== c.scoreA) { c.scoreA = a; this.el.scoreA.textContent = String(a); }
    if (b !== c.scoreB) { c.scoreB = b; this.el.scoreB.textContent = String(b); }
  }

  _writeTimer(sec) {
    const whole = Math.max(0, Math.ceil(sec || 0));
    if (whole !== this._c.timer) {
      this._c.timer = whole;
      this.el.clock.textContent = formatClock(whole);
    }
    const urgent = whole <= 30 && whole > 0;
    if (urgent !== this._c.urgent) {
      this._c.urgent = urgent;
      this.el.scoreMid.classList.toggle('urgent', urgent);
    }
  }

  _writeVignette(t) {
    const v = Math.round(clamp01(t) * this._damageVignetteScale
      * this._screenEffectIntensity * 50) / 50;
    if (v !== this._c.vignette) {
      this._c.vignette = v;
      this.el.vignette.style.opacity = String(v);
    }
    const crit = v > 0.66;
    if (crit !== this._c.crit) {
      this._c.crit = crit;
      this.el.vignette.classList.toggle('crit', crit);
    }
  }

  /* ======================================================================
     PER-FRAME TICKS
     ====================================================================== */

  _tickHitmarker(dt) {
    const hm = this._hm;
    if (hm.t > hm.life) return;
    hm.t += dt;
    const p = clamp01(hm.t / hm.life);
    if (p >= 1) {
      this.el.hitmark.style.opacity = '0';
      hm.t = hm.life + 1;
      return;
    }
    const pop = 1 - Math.pow(1 - p, 3);
    const scale = 1.55 - 0.55 * pop;
    this.el.hitmark.style.opacity = String(1 - p * p);
    this.el.hitmark.style.transform = `scale(${scale.toFixed(3)}) rotate(${(p * 6).toFixed(2)}deg)`;
  }

  _tickCrosshairHit(dt) {
    if (this._xhHitT <= 0) return;
    this._xhHitT -= dt;
    if (this._xhHitT <= 0) this.el.xh.classList.remove('hit');
    else if (!this.el.xh.classList.contains('hit')) this.el.xh.classList.add('hit');
  }

  _tickArcs(dt) {
    for (const a of this._arcs) {
      if (!a.active) continue;
      a.t += dt;
      if (a.t >= ARC_LIFE) {
        a.active = false;
        a.el.style.opacity = '0';
        continue;
      }
      const k = 1 - a.t / ARC_LIFE;
      a.el.style.opacity = (k * k).toFixed(3);
    }
  }

  /* ------------------------------------------------------- grenade warnings */

  /**
   * A live grenade inside its warn radius. `position` belongs to a pooled event
   * object, so everything is read out here and nothing is retained.
   */
  _pushGrenadeWarning(id, position, fuse, friendly) {
    const me = this.game.player;
    if (!me || !position) return;
    const deg = this._bearingTo(position.x, position.z);
    if (deg === null) return;

    let slot = null;
    let oldest = null;
    for (const g of this._grens) {
      if (g.active && g.id === id) { slot = g; break; }
      if (!g.active && !slot) slot = g;
      if (g.active && (!oldest || g.t > oldest.t)) oldest = g;
    }
    slot = slot || oldest;
    if (!slot) return;

    if (!slot.active || slot.id !== id) {
      slot.el.className = 'gren-warn on' + (friendly ? ' friendly' : '');
      slot.fuse = -1;
    }
    slot.id = id;
    slot.active = true;
    slot.t = 0;
    if (deg !== slot.ang) { slot.ang = deg; slot.el.style.setProperty('--a', deg.toFixed(1) + 'deg'); }
    const f = Math.max(0, Math.ceil(Number(fuse) * 10) / 10);
    if (f !== slot.fuse) { slot.fuse = f; slot.num.textContent = f.toFixed(1); }
  }

  _clearGrenadeWarning(id) {
    for (const g of this._grens) {
      if (g.active && g.id === id) { g.active = false; g.el.className = 'gren-warn'; return; }
    }
  }

  _tickGrenades(dt) {
    for (const g of this._grens) {
      if (!g.active) continue;
      g.t += dt;
      // ProjectileSystem re-emits every 1/15 s while the grenade is live; a gap
      // longer than that means it detonated or rolled out of the warn radius.
      if (g.t >= GREN_WARN_LIFE) { g.active = false; g.el.className = 'gren-warn'; }
    }
  }

  /** Screen-relative bearing in degrees to a world point, or null if we are on it. */
  _bearingTo(x, z) {
    const me = this.game.player;
    if (!me) return null;
    const dx = x - me.position.x;
    const dz = z - me.position.z;
    if (dx * dx + dz * dz < 1e-6) return null;
    const yaw = me.yaw || 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // forward, per §1
    return Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz) / DEG;
  }

  /* --------------------------------------------------------- flash-blind -- */

  _tickBlind(dt) {
    if (this._blind <= 0.002) {
      if (this._c.blind !== 0) { this._c.blind = 0; this.el.blind.style.opacity = '0'; }
      return;
    }
    this._blind = Math.max(0, this._blind - dt * this._blindDecay);
    // Ease out hard so the recovery reads as sight returning, not a linear wipe.
    const v = Math.round(Math.pow(this._blind, 0.65) * this._flashIntensity
      * this._screenEffectIntensity * 50) / 50;
    if (v !== this._c.blind) { this._c.blind = v; this.el.blind.style.opacity = String(v); }
  }

  _pushDamageNumber(p) {
    if (!this._showDnums) return;
    const cam = this.game?.camera;
    const pt = p?.point;
    if (!cam || !pt) return;

    _v.set(pt.x, pt.y, pt.z).project(cam);
    if (_v.z > 1 || _v.z < -1) return;
    const x = (_v.x * 0.5 + 0.5) * this._vw;
    const y = (-_v.y * 0.5 + 0.5) * this._vh;

    let slot = null, oldest = null;
    for (const d of this._dnums) {
      if (!d.active) { slot = d; break; }
      if (!oldest || d.t > oldest.t) oldest = d;
    }
    slot = slot || oldest;
    if (!slot) return;

    const amount = Math.max(1, Math.round(p.amount || 0));
    const killed = p.target && p.target.alive === false;
    const cls = 'dnum on' + (p.headshot || p.hitPart === 'head' ? ' hs' : '') + (killed ? ' kill' : '');
    const txt = String(amount);
    if (slot.txt !== txt) { slot.txt = txt; slot.el.textContent = txt; }
    if (slot.cls !== cls) { slot.cls = cls; slot.el.className = cls; }
    slot.active = true;
    slot.t = 0;
    slot.life = 0.9;
    slot.x = x + (Math.random() - 0.5) * 26;
    slot.y = y - 6;
  }

  _tickDamageNumbers(dt) {
    for (const d of this._dnums) {
      if (!d.active) continue;
      d.t += dt;
      if (d.t >= d.life) { this._freeDnum(d); continue; }
      const p = d.t / d.life;
      const rise = 46 * (1 - Math.pow(1 - p, 2));
      const s = 1 + 0.22 * (1 - Math.pow(1 - Math.min(1, p * 5), 2));
      d.el.style.transform = `translate3d(${(d.x).toFixed(1)}px, ${(d.y - rise).toFixed(1)}px, 0) translate(-50%,-50%) scale(${s.toFixed(3)})`;
      d.el.style.opacity = p > 0.55 ? ((1 - p) / 0.45).toFixed(3) : '1';
    }
  }

  _freeDnum(d) {
    if (!d.active && d.cls === '') return;
    d.active = false;
    if (d.cls !== '') { d.cls = ''; d.el.className = 'dnum'; }
  }

  _pushXp(amount, label, cls) {
    let slot = null, oldest = null;
    for (const x of this._xp) {
      if (!x.active) { slot = x; break; }
      if (!oldest || x.t > oldest.t) oldest = x;
    }
    slot = slot || oldest;
    if (!slot) return;
    const full = 'xp-pop on' + (cls ? ' ' + cls : '') + (amount > 0 ? '' : ' bare');
    if (slot.cls !== full) { slot.cls = full; slot.el.className = full; }
    slot.num.textContent = amount > 0 ? '+' + amount : '';
    slot.lbl.textContent = label;
    slot.active = true;
    slot.t = 0;
    slot.life = 1.5;
    slot.y0 = -this._xpOffset;
    this._xpOffset += 22;
  }

  _tickXp(dt) {
    if (this._xpOffset > 0) this._xpOffset = Math.max(0, this._xpOffset - 46 * dt);
    for (const x of this._xp) {
      if (!x.active) continue;
      x.t += dt;
      if (x.t >= x.life) { this._freeXp(x); continue; }
      const p = x.t / x.life;
      const y = x.y0 - 30 * (1 - Math.pow(1 - p, 2));
      const s = 1 + 0.18 * (1 - Math.pow(1 - Math.min(1, p * 6), 2));
      x.el.style.transform = `translate3d(0px, ${y.toFixed(1)}px, 0) translateX(-50%) scale(${s.toFixed(3)})`;
      x.el.style.opacity = p > 0.6 ? ((1 - p) / 0.4).toFixed(3) : '1';
    }
  }

  _freeXp(x) {
    if (!x.active && x.cls === '') return;
    x.active = false;
    if (x.cls !== '') { x.cls = ''; x.el.className = 'xp-pop'; }
  }

  _tickNotice(dt) {
    if (this._noticeDur > 0) {
      this._noticeT += dt;
      if (this._noticeT >= this._noticeDur) {
        this._noticeDur = 0;
        this.el.notice.classList.add('fade');
        this._noticeClear = 0.42;
      }
      return;
    }
    if (this._noticeClear > 0) {
      this._noticeClear -= dt;
      if (this._noticeClear <= 0) this.el.notice.classList.remove('on', 'anim', 'fade');
    }
  }

  _showStreak(count) {
    if (count < 2) return;
    this.el.streakN.textContent = String(count);
    const s = this.el.streak;
    s.classList.remove('on');
    void s.offsetWidth;      // rare event — one reflow to restart the pop
    s.classList.add('on');
    this._streakT = 2.6;
  }

  _tickStreak(dt) {
    if (this._streakT <= 0) return;
    this._streakT -= dt;
    if (this._streakT <= 0) this.el.streak.classList.remove('on');
  }

  _tickFlash(dt) {
    if (this._flash <= 0.001) {
      if (this._c.flash !== 0) { this._c.flash = 0; this.el.flash.style.opacity = '0'; }
      return;
    }
    this._flash = Math.max(0, this._flash - dt * 2.6);
    const v = Math.round(this._flash * this._screenEffectIntensity * 40) / 40;
    if (v !== this._c.flash) { this._c.flash = v; this.el.flash.style.opacity = String(v * 0.85); }
  }

  /* ------------------------------------------------------------- death UI */

  _hideDeath() {
    if (!this._death.on) return;
    this._death.on = false;
    this._death.info = null;
    this.el.death.classList.remove('on', 'ready', 'headshot', 'longshot');
  }

  _tickDeath(dt) {
    const d = this._death;
    if (!d.on) return;
    // The player system may respawn us without a `spawn` event — believe `alive`.
    if (this.game?.player?.alive) { this._hideDeath(); return; }
    d.t += dt;

    // Match owns the real clock; fall back to our own if it is not running.
    const m = this.game?.match;
    const left = typeof m?.playerRespawnIn === 'number' && m.playerRespawnIn > 0
      ? m.playerRespawnIn
      : Math.max(0, d.delay - d.t);
    const whole = Math.ceil(left);
    if (whole !== this._c.deathCount) {
      this._c.deathCount = whole;
      this.el.deathCount.textContent = whole > 0 ? String(whole) : '0';
      const frac = clamp01(1 - left / Math.max(0.001, d.delay));
      this.el.deathArc.style.strokeDashoffset = String(this._ringLen * (1 - frac));
    }

    // `playerCanRespawnNow` opens 1.5 s in — long before the timer expires —
    // and that is when the fire button actually cuts the wait short.
    const ready = m ? !!m.playerCanRespawnNow : left <= 0;
    if (ready !== this._c.deathReady) {
      this._c.deathReady = ready;
      this.el.death.classList.toggle('ready', ready);
      this.el.deathPrompt.classList.toggle('ready', ready);
      this.el.deathPrompt.innerHTML = ready
        ? 'PRESS <b>FIRE</b> TO REDEPLOY'
        : 'REDEPLOYING';
    }
  }

  /* -------------------------------------------------------------- perf UI */

  _tickPerf(dt) {
    if (!this.el.perf.classList.contains('on')) return;
    this._perfAcc += dt;
    if (this._perfAcc < 0.25) return;
    this._perfAcc = 0;
    const s = this.game?.engine?.stats;
    if (!s) return;
    const net = this.game?.netFacade?.netStats;
    const netText = this._networkOverlay === 'off' || !net ? ''
      : this._networkOverlay === 'compact'
        ? `${Math.round(net.rttMs ?? 0)} ms · ${Number(net.lossPct ?? 0).toFixed(1)}% loss`
        : `${net.region || '—'} · ${Math.round(net.rttMs ?? 0)} ms · ${Number(net.jitterMs ?? 0).toFixed(1)} ms jitter · ${Number(net.lossPct ?? 0).toFixed(1)}% loss · ${Number(net.receiveRateHz ?? 0).toFixed(1)} Hz`;
    const sig = `${s.fps}|${(s.wallMs || s.frameMs).toFixed(1)}|${(s.bufferMPix || 0).toFixed(1)}|${s.drawCalls}|${s.triangles}|${netText}`;
    if (sig === this._c.perf) return;
    this._c.perf = sig;
    this.el.pFps.textContent = String(s.fps | 0);
    this.el.pFps.className = 'p-fps' + (s.fps < 45 ? ' worse' : s.fps < 75 ? ' bad' : '');
    // Show the WALL time and the buffer size, not just CPU-inside-render. A fill-bound
    // frame reads ~1.5 ms of CPU while taking 50 ms of wall — reporting only the former is
    // how a 6x-over-budget frame looks healthy in a screenshot.
    const wall = Number.isFinite(s.wallMs) && s.wallMs > 0 ? s.wallMs : s.frameMs;
    const mpix = Number.isFinite(s.bufferMPix) && s.bufferMPix > 0 ? ` ${s.bufferMPix.toFixed(1)}MP` : '';
    this.el.pMs.textContent = `${wall.toFixed(1)} ms${mpix}`;
    this.el.pDc.textContent = `${s.drawCalls | 0} dc`;
    this.el.pTri.textContent = `${formatK(s.triangles | 0)} tri`;
    this.el.pNet.textContent = netText;
  }

  _showAudioCaption(payload) {
    const channel = payload?.channel;
    const settings = this.game?.settings;
    if (channel === 'announcer' ? settings?.get?.('subtitles') !== true
      : settings?.get?.('closedCaptions') !== true) return;
    const label = CAPTION_LABELS[payload?.name];
    if (!label) return;
    let direction = '';
    if (settings?.get?.('captionDirection') === true && payload?.position) {
      const bearing = this._bearingTo(payload.position.x, payload.position.z);
      if (bearing != null) direction = bearing < -25 ? ' [LEFT]' : bearing > 25 ? ' [RIGHT]' : ' [AHEAD]';
    }
    this.el.captions.textContent = `${label}${direction}`;
    this._captionT = channel === 'announcer' ? 2.6 : 1.5;
  }

  /* -------------------------------------------------------------- helpers */

  _bindLabel(action) {
    const binds = this.game?.settings?.get?.('binds');
    if (binds) for (const code in binds) if (binds[code] === action) return keyLabel(code);
    return '?';
  }
}

/* ---------------------------------------------------------------- utils -- */

const _v = new THREE.Vector3();

/**
 * Weapon class for a weapon id, straight out of the §7 def table. Unknown ids
 * (streak hardware: `airstrike`, `sentry`, `chopper`) must return null — `getWeapon()`
 * substitutes the default rifle for anything it does not know, which would put an
 * assault-rifle glyph on an airstrike kill.
 */
export function classOf(weaponId) {
  return weaponId ? (WEAPONS[weaponId]?.class ?? null) : null;
}

function clamp01(v) { v = Number(v) || 0; return v < 0 ? 0 : v > 1 ? 1 : v; }

function angDiff(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function formatK(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1000000).toFixed(2) + 'M';
}
