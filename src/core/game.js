import * as THREE from 'three';
import { Engine } from './engine.js';
import { Input } from './input.js';
import { EventBus } from './events.js';
import { Settings } from './settings.js';
import { createRNG } from './rng.js';
import { assets } from './assets.js';
import { LivePresenter } from './presenter.js';
import { clamp, FIXED_DT } from './mathUtils.js';

import { World } from '../world/world.js';
import { NavGrid } from '../world/navGrid.js';
import { Player } from '../player/player.js';
import { BotManager } from '../ai/botManager.js';
import { WeaponSystem } from '../weapons/weaponSystem.js';
import { ProjectileSystem } from '../weapons/projectiles.js';
import { FX } from '../fx/fx.js';
import { AudioEngine } from '../audio/audio.js';
import { HUD } from '../ui/hud.js';
import { Menu } from '../ui/menu.js';
import { Match } from '../game/match.js';
import { WEAPON_LIST } from '../weapons/weaponDefs.js';
import { BotModel } from '../ai/botModel.js';

const MAX_SUBSTEPS = 6;

/**
 * Hand the main thread back so the browser can lay out, paint and service input.
 *
 * `scheduler.yield()` is the right primitive — it returns at user-visible priority, so
 * boot resumes ahead of unrelated background tasks while still giving the compositor a
 * frame — and `setTimeout(0)` is the fallback everywhere it is missing.
 */
function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
      scheduler.yield().then(resolve, () => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** Resolve only once the browser has actually put a frame on the screen. */
function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

export class Game {
  /**
   * Deliberately cheap: no renderer, no GL context, no shader compilation. Everything
   * that costs milliseconds happens in `init()`, where it can report progress and yield
   * — including `new Engine()`, which used to run here and blocked the first paint of
   * the loading screen behind ~80 ms of PMREM baking and composer setup.
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.settings = new Settings();
    this.bus = new EventBus();
    this.rng = createRNG(0xC0FFEE);
    /**
     * Presentation-only draws (audio pitch variance, particle spread) — never read by
     * anything that affects an outcome. Kept off `rng` because a shared stream makes a
     * gameplay draw's position depend on how many presentation draws happened to
     * precede it, which varies with whether audio/fx even exist (headless vs browser).
     */
    this.fxRng = createRNG(0xFEEDFACE);
    /** Seed of the current match. Replaced by startMatch(); see `mixSeed`. */
    this.matchSeed = 0xC0FFEE;
    this.assets = assets;
    /** Presentation port — see core/presenter.js. Swapped to NullPresenter headless. */
    this.present = new LivePresenter(this);

    /** Simulation clock. Integer; `time` is derived from it — see the getter. */
    this.tick = 0;
    this.frame = 0;
    this.paused = false;
    this.state = 'boot';
    this.debug = false;

    this._accum = 0;
    this._last = 0;
    this._running = false;
    this._raf = 0;
    this._nextRender = 0;
    this._systems = null;
    this._loop = this._loop.bind(this);

    /** Per-phase boot timings in ms. Read by the perf harnesses via `__GAME__`. */
    this.bootProfile = { phases: [], totalMs: 0 };
  }

  /**
   * Seconds of simulation since the match began.
   *
   * DERIVED from the integer tick, never accumulated. `time += dt` at 120 Hz drifts by a
   * different amount depending on how many additions got you there, so a state saved at
   * tick T and replayed forward would not land on the same clock it had the first time —
   * and every deadline in the game (coyote time, fire cooldowns, slide and mantle
   * cooldowns, bot reaction and memory windows) is a comparison against this value. One
   * float epsilon on the coyote-time test at player.js is the difference between a jump
   * being allowed and denied, which is a whole jump arc of divergence.
   *
   * Deliberately getter-only. Every module in the game is an ES module and therefore
   * strict, so a stray `game.time = …` throws rather than silently desynchronising the
   * clock from the tick; from sloppy-mode callers (a devtools console, a test harness's
   * `page.evaluate`) it is a no-op instead. Neither can move the clock.
   */
  get time() { return this.tick * FIXED_DT; }

  /**
   * Build every system, reporting honest progress and yielding between phases so the
   * loading screen animates instead of freezing.
   *
   * `onProgress(label, fraction)` — `fraction` is 0..1 and advances *within* the long
   * phases too, not just between them.
   */
  async init(onProgress = () => {}) {
    const prof = this.bootProfile;
    const tBoot = performance.now();
    const TOTAL = 10;
    let done = 0;
    const report = (label, frac) => {
      try { onProgress(label, (done + frac) / TOTAL); } catch { /* never let the UI break boot */ }
    };
    const step = async (label, fn) => {
      report(label, 0);
      // A real painted frame before the first heavy phase; a cheap event-loop yield
      // after that. Waiting for rAF on every phase would add a frame of latency each.
      await (done === 0 ? nextPaint() : yieldToBrowser());
      const t = performance.now();
      // `tick` lets a long phase drive the bar and hand back the thread as it goes.
      await fn(async (frac) => { report(label, frac); await yieldToBrowser(); });
      prof.phases.push([label, +(performance.now() - t).toFixed(1)]);
      done++;
    };

    await step('starting renderer', () => {
      this.engine = new Engine(this, this.canvas);
      this.renderer = this.engine.renderer;
      this.scene = this.engine.scene;
      this.camera = this.engine.camera;
      this.input = new Input(this, this.canvas);
    });
    await step('generating materials', (tick) => assets.init(tick));
    await step('building world', async () => {
      this.world = new World(this);
      await this.world.init();
      this.engine.fitShadowCamera(this.world.bounds);
    });
    await step('baking navigation', async () => {
      this.nav = new NavGrid(this);
      await this.nav.init();
    });
    await step('loading arsenal', async () => {
      this.weapons = new WeaponSystem(this);
      await this.weapons.init();
      this.projectiles = new ProjectileSystem(this);
      await this.projectiles.init();
    });
    await step('spawning effects', async () => {
      this.fx = new FX(this);
      await this.fx.init();
      // Ballistics already plays a surface-appropriate sound for every impact it
      // spawns (see spawnImpact), so FX must stay silent or every hit double-fires.
      this.fx.playImpactAudio = false;
    });
    await step('synthesising audio', async () => {
      this.audio = new AudioEngine(this);
      await this.audio.init();
    });
    await step('deploying operator', async () => {
      this.player = new Player(this);
      await this.player.init();
      this.bots = new BotManager(this);
      await this.bots.init();
    });
    await step('assembling hud', async () => {
      this.hud = new HUD(this);
      await this.hud.init();
      this.match = new Match(this);
      await this.match.init();
      this.menu = new Menu(this);
      await this.menu.init();
    });
    await step('compiling shaders', () => this._prewarmShaders());

    this._systems = null;
    prof.totalMs = +(performance.now() - tBoot).toFixed(1);
    this.state = 'menu';
    this.bus.emit('ready', {});
    this.start();
  }

  /**
   * Link every shader program the game can need, at boot, where a stall is invisible.
   *
   * Without this, a program is linked the first frame its material becomes visible: the
   * first time you round a corner onto `metalGreen`, the first time a bot in the other
   * team's colourway walks into view, the first shot of a weapon you have not equipped.
   * Each is a hard stall inside a gameplay frame. `compileAsync` uses
   * `KHR_parallel_shader_compile` where the driver has it, so the links overlap instead
   * of serialising on the main thread.
   *
   * Two things make this harder than one `compileAsync` call, and both are handled here:
   * `compileAsync` only walks objects that are *visible*, and every pool in the game
   * parks its objects hidden; and it compiles the colour variants only, so the
   * shadow-depth programs need one real render to exist.
   */
  async _prewarmShaders() {
    const engine = this.engine;
    const before = this.renderer.info.programs?.length ?? 0;
    /** Everything we force-show, so it can be put back exactly as it was. */
    const hidden = [];
    const show = (root) => root.traverse((o) => { if (o.visible === false) { hidden.push(o); o.visible = true; } });
    /** Throwaway rigs; disposing both takes the shared rig back to zero live users. */
    const rigs = [];

    try {
      // Bot rigs are built lazily on first spawn, one InstancedMesh set per team, and
      // the two teams' geometries differ — so both colourways must exist to be compiled.
      for (const team of [0, 1]) {
        try { rigs.push(new BotModel(this, team)); } catch (e) { console.warn('[game] rig prewarm', e); }
      }
      // Viewmodels are built on first equip and cached forever after. Build all of them.
      const vm = this.weapons?.viewmodel;
      if (vm) {
        for (const def of WEAPON_LIST) {
          try { vm.setWeapon(def); } catch (e) { console.warn('[game] viewmodel prewarm', def.id, e); }
        }
        for (const entry of vm.cache.values()) entry.group.visible = true;
      }

      show(engine.scene);
      show(engine.viewScene);

      await this.renderer.compileAsync(engine.scene, engine.camera);
      await this.renderer.compileAsync(engine.viewScene, engine.viewCamera);

      // Shadow-depth variants are separate programs that `compileAsync` does not touch.
      // One throwaway frame with everything visible creates them; the boot overlay is
      // still opaque over the canvas, so nothing of it reaches the player.
      const wasEnabled = this.renderer.shadowMap.enabled;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.needsUpdate = true;
      engine.render(1 / 120);
      this.renderer.shadowMap.enabled = wasEnabled;
      this.renderer.shadowMap.needsUpdate = true;
    } catch (err) {
      // A prewarm failure costs frame-one hitches, never the boot.
      console.warn('[game] shader prewarm failed:', err);
    } finally {
      for (const o of hidden) o.visible = false;
      const vm = this.weapons?.viewmodel;
      if (vm) {
        for (const entry of vm.cache.values()) entry.group.visible = false;
        // Back to "nothing equipped", exactly as before the sweep. Without this,
        // `setWeapon` would early-out on the last gun we prewarmed and the player would
        // spawn holding an invisible weapon.
        vm.current = null;
        vm.def = null;
      }
      // Releasing both rigs drops the shared pool back to zero users, which tears the
      // InstancedMeshes back out of the scene. The linked programs survive in the
      // renderer's cache because the rig *material* is never disposed.
      for (const r of rigs) { try { r.dispose(); } catch { /* already gone */ } }
    }

    this.bootProfile.programs = { before, after: this.renderer.info.programs?.length ?? 0 };
  }

  /**
   * Systems that receive lifecycle calls, in deterministic order.
   *
   * Cached: this is read once per frame by `_update` and the old array-literal +
   * `.filter(Boolean)` allocated two arrays every frame for a list that only changes
   * during `init()` (§11 — no per-frame allocation).
   */
  get systems() {
    return this._systems || (this._systems = [
      this.world, this.nav, this.match, this.player, this.bots,
      this.weapons, this.projectiles, this.fx, this.audio, this.hud, this.menu,
    ].filter(Boolean));
  }

  startMatch(opts = {}) {
    this.tick = 0;
    // Kept, not just consumed: per-actor streams are derived from it (see `mixSeed`), and
    // a networked match has to be able to hand the same seed to every peer.
    this.matchSeed = (opts.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0)) >>> 0;
    this.rng.reseed(this.matchSeed);

    // Options are written into settings BEFORE systems reset, because subsystems build
    // themselves from settings during reset(). Passing `botCount` only in `opts` meant
    // the roster was built from the stale setting while Match recorded the requested
    // number — the referee and the roster disagreed for the whole match.
    if (opts.botCount !== undefined) this.settings.set('botCount', opts.botCount);
    if (opts.difficulty !== undefined) this.settings.set('difficulty', opts.difficulty);
    if (opts.mode !== undefined) this.settings.set('mode', String(opts.mode));

    for (const s of this.systems) s.reset?.(opts);
    this.match.begin(opts);
    this.state = 'playing';
    this.paused = false;
    this.engine.setFade(0);
    this.input.requestLock();
    this.audio.resume();
    this.bus.emit('matchStart', { mode: opts.mode ?? this.match.mode, scores: this.match.scores });
  }

  endMatch(result) {
    this.state = 'gameover';
    this.input.exitLock();
    this.bus.emit('matchEnd', result);
  }

  setPaused(p) {
    if (this.state !== 'playing' && this.state !== 'paused') return;
    this.paused = p;
    this.state = p ? 'paused' : 'playing';
    if (p) {
      this.input.exitLock();
    } else {
      // Unpausing without the pointer lock is not a resume, it is a player standing
      // still in a live match with a system cursor over the window. If the browser
      // refuses the lock (Escape is not a gesture; re-locks are throttled right after
      // a user-initiated exit), fall straight back into the pause menu.
      this.input.requestLock().then((ok) => {
        if (!ok && this.state === 'playing') this.setPaused(true);
      });
    }
    this.bus.emit(p ? 'pause' : 'unpause', {});
  }

  returnToMenu() {
    this.state = 'menu';
    this.paused = false;
    this.input.exitLock();
    this.bus.emit('toMenu', {});
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._nextRender = 0;
    this._raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
  }

  _loop(now) {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._loop);

    // Frame cap. The setting has existed (and been exposed in the menu) since the
    // beginning and was read nowhere, so every display ran uncapped.
    //
    // It matters more than a power-saving toggle: the simulation is a fixed 120 Hz step
    // with no interpolation between steps, so on a 144 Hz display roughly one frame in
    // six advances no simulation at all and the mismatch beats at ~24 Hz. Capping to
    // 120 makes every displayed frame a distinct simulation state.
    //
    // The deadline is advanced by a whole period rather than compared against the last
    // render, because `now - last < period` on a display whose refresh does not divide
    // the cap drops every other frame instead of the right fraction of them — a 120 cap
    // on a 144 Hz panel would yield 72 fps.
    const cap = this.settings.get('maxFps');
    if (cap > 0) {
      if (now < this._nextRender) return;
      this._nextRender = Math.max(now, this._nextRender + 1000 / cap);
    }

    let dtFrame = (now - this._last) / 1000;
    this._last = now;
    // A tab that was backgrounded can hand us a huge delta; never simulate it.
    dtFrame = clamp(dtFrame, 0, 0.1);
    this.frame++;

    const simulating = this.state === 'playing' && !this.paused;

    if (simulating) {
      this._accum += dtFrame;
      let steps = 0;
      while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
        this._accum -= FIXED_DT;
        steps++;
        this._fixedUpdate(FIXED_DT);
      }
      // If we blew the substep budget, drop the backlog rather than spiralling.
      if (steps === MAX_SUBSTEPS) this._accum = 0;
    } else {
      this._accum = 0;
    }

    try {
      this._update(dtFrame);
    } finally {
      // Rendering and input draining live in `finally` deliberately. If a system
      // throws, the game must degrade to "one subsystem is broken", never to a black
      // screen with latched input — the latter looks like a total crash and hides the
      // actual fault. EventBus.emit isolates listeners for the same reason.
      this.engine.update(dtFrame);
      this.engine.render(dtFrame);
      this.input.endFrame();
    }
  }

  /**
   * Run one system call, isolating a throw so it cannot take the frame down with it.
   * The first failure per system+phase is logged with its stack; after that the system
   * is silenced to avoid flooding the console at 120 Hz.
   *
   * Takes the receiver and method name rather than a closure: at 120 Hz with six
   * substeps this was allocating five arrow functions per fixed step and one per system
   * per frame, for no reason (§11 — no per-frame allocation).
   */
  _safe(system, phase, obj, method, arg) {
    try {
      obj[method](arg);
    } catch (err) {
      const key = `${system}.${phase}`;
      this._faults ||= new Map();
      const n = (this._faults.get(key) || 0) + 1;
      this._faults.set(key, n);
      if (n === 1) {
        console.error(`[game] ${key} threw — isolating this system for the rest of the session:`, err);
        this.bus.emit('systemFault', { system, phase, error: err });
      }
    }
  }

  _fixedUpdate(dt) {
    // Simulation time advances HERE, not in the frame loop. Bots schedule their
    // thinking, reaction delays and target memory off `game.time`; if it only ticked
    // when the renderer happened to drive the step, anything else driving the
    // simulation (headless tests, a replay, a catch-up) would silently freeze the AI.
    this.tick++;

    // Order matters: the nav danger field decays first so the AI paths over this
    // tick's cost surface, then input-driven actors, then AI, then projectiles, then
    // rules. Each is isolated so a fault in the AI cannot stop the match clock.
    this._safe('nav', 'fixed', this.nav, 'fixedUpdate', dt);
    this._safe('player', 'fixed', this.player, 'fixedUpdate', dt);
    this._safe('bots', 'fixed', this.bots, 'fixedUpdate', dt);
    this._safe('weapons', 'fixed', this.weapons, 'fixedUpdate', dt);
    this._safe('projectiles', 'fixed', this.projectiles, 'fixedUpdate', dt);
    this._safe('match', 'fixed', this.match, 'fixedUpdate', dt);

    this._enforceWorldBounds();
  }

  /**
   * Safety net: anything that leaves the world is killed rather than left to fall
   * forever. Without this a player who clips through the floor free-falls at terminal
   * velocity with full health — never dying, so never respawning, so the match can
   * never resolve for them. Also catches a position that has gone non-finite.
   */
  _enforceWorldBounds() {
    const b = this.world?.bounds;
    if (!b) return;
    const floor = b.min.y - 5;
    for (const e of this.entities) {
      if (!e.alive) continue;
      const p = e.position;
      const broken = !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z);
      if (!broken && p.y > floor) continue;
      e.die?.({ attacker: null, weaponId: 'world', hitPart: 'torso', point: p, normal: null });
      // A non-finite entity cannot be respawned from where it is; park it at the
      // world centre so the spawner has something sane to move away from.
      if (broken) {
        p.set((b.min.x + b.max.x) * 0.5, b.min.y, (b.min.z + b.max.z) * 0.5);
        e.velocity?.set(0, 0, 0);
      }
    }
  }

  _update(dt) {
    const list = this.systems;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s.update) continue;
      this._safe(s.constructor?.name || 'system', 'update', s, 'update', dt);
    }
  }

  /** Every live entity (player first). Allocation-free — returns a reused array. */
  get entities() {
    const out = this._entArr || (this._entArr = []);
    out.length = 0;
    if (this.player) out.push(this.player);
    if (this.bots) for (const b of this.bots.bots) out.push(b);
    return out;
  }

  dispose() {
    this.stop();
    for (const s of this.systems) s.dispose?.();
    // Both exist only once `init()` has run its first step; disposing a Game that
    // failed to boot must not throw on top of whatever killed it.
    this.input?.dispose();
    this.engine?.dispose();
    this._systems = null;
  }
}
