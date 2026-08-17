import * as THREE from 'three';
import { Engine } from './engine.js';
import { Input } from './input.js';
import { EventBus } from './events.js';
import { Settings } from './settings.js';
import { createRNG } from './rng.js';
import { assets } from './assets.js';
import { clamp } from './mathUtils.js';

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

const FIXED_DT = 1 / 120;
const MAX_SUBSTEPS = 6;

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.settings = new Settings();
    this.bus = new EventBus();
    this.rng = createRNG(0xC0FFEE);
    this.assets = assets;

    this.time = 0;
    this.frame = 0;
    this.paused = false;
    this.state = 'boot';
    this.debug = false;

    this._accum = 0;
    this._last = 0;
    this._running = false;
    this._raf = 0;
    this._loop = this._loop.bind(this);

    this.engine = new Engine(this, canvas);
    this.renderer = this.engine.renderer;
    this.scene = this.engine.scene;
    this.camera = this.engine.camera;
    this.input = new Input(this, canvas);
  }

  async init(onProgress = () => {}) {
    const step = async (label, fn) => {
      onProgress(label);
      // Yield so the boot screen can repaint between heavy steps.
      await new Promise((r) => setTimeout(r, 0));
      await fn();
    };

    await step('generating materials', () => assets.init());
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

    this.state = 'menu';
    this.bus.emit('ready', {});
    this.start();
  }

  /** Systems that receive lifecycle calls, in deterministic order. */
  get systems() {
    return [
      this.world, this.nav, this.match, this.player, this.bots,
      this.weapons, this.projectiles, this.fx, this.audio, this.hud, this.menu,
    ].filter(Boolean);
  }

  startMatch(opts = {}) {
    this.time = 0;
    this.rng.reseed(opts.seed ?? (Math.floor(Math.random() * 0xffffffff) >>> 0));

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
    if (p) this.input.exitLock();
    else this.input.requestLock();
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
    this._raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
  }

  _loop(now) {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._loop);

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
   */
  _safe(system, phase, fn) {
    try {
      fn();
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
    this.time += dt;

    // Order matters: input-driven actors, then AI, then projectiles, then rules.
    // Each is isolated so a fault in the AI cannot stop the match clock.
    this._safe('player', 'fixed', () => this.player.fixedUpdate(dt));
    this._safe('bots', 'fixed', () => this.bots.fixedUpdate(dt));
    this._safe('weapons', 'fixed', () => this.weapons.fixedUpdate(dt));
    this._safe('projectiles', 'fixed', () => this.projectiles.fixedUpdate(dt));
    this._safe('match', 'fixed', () => this.match.fixedUpdate(dt));

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
    for (const s of this.systems) {
      if (!s.update) continue;
      this._safe(s.constructor?.name || 'system', 'update', () => s.update(dt));
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
    this.input.dispose();
    this.engine.dispose();
  }
}
