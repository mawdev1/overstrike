/**
 * Simulation determinism harness.
 *
 * The authoritative-server work rests on one property: **the simulation must be a pure
 * function of (seed, tick sequence)** — never of the render clock. A browser at 144 fps,
 * a browser at 30 fps and a headless server that has no frames at all must all produce
 * bit-identical state from the same seed.
 *
 * This drives `game._fixedUpdate()` directly, which is what the server will do, and
 * varies only how `game.frame` advances underneath it, so anything in the simulation
 * that reads the render counter shows up as a divergence.
 *
 * Its blind spot is bot/world state: it injects no PLAYER input, so a frame-gated
 * player-input path wouldn't diverge here even if broken. The player-input command
 * pipeline (`Player._pumpLocalCommand`/`_refreshHeldState`) has its own coverage below
 * — "player input survives a frame-frozen server" — precisely because this suite found
 * that exact class of bug once already.
 *
 * Usage: node scripts/determinism.mjs [--ticks=2400] [--headed]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const TICKS = Number(arg('ticks', 2400));          // 20 s of simulation at 120 Hz
const HEADED = argv.includes('--headed');

let server, browser, failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

try {
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 5197, strictPort: false },
    logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];

  browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.on('pageerror', (e) => bad('page error', e.message));

  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__GAME__ && window.__BOOTPROF__?.menu > 0, null, { timeout: 180000 });

  /**
   * Run a match for `ticks` fixed steps, advancing `game.frame` once every
   * `ticksPerFrame` steps to imitate a given render rate, and digest the result.
   *
   * The game loop is bypassed entirely: `_fixedUpdate` is called directly, exactly as a
   * server would. `stop()` first, or rAF would keep stepping underneath us.
   */
  const run = async (ticksPerFrame, ticks, seed) => page.evaluate(
    ({ ticksPerFrame, ticks, seed }) => {
      const g = window.__GAME__;
      g.stop();
      g.startMatch({ mode: 'tdm', botCount: 8, difficulty: 'regular', seed });
      const DT = 1 / 120;
      for (let i = 0; i < ticks; i++) {
        if (ticksPerFrame > 0 && i % ticksPerFrame === 0) g.frame++;
        g._fixedUpdate(DT);
      }
      const r = (v) => Number(v).toFixed(4);
      const rows = [];
      for (const b of g.bots.bots) {
        rows.push([
          b.id, b.team, b.alive ? 1 : 0,
          r(b.position.x), r(b.position.y), r(b.position.z),
          r(b.velocity.x), r(b.velocity.z),
          r(b.yaw), r(b.pitch), r(b.health),
          b.state ?? '-', b.stats.kills, b.stats.deaths,
        ].join(','));
      }
      return { bots: rows.join('|'), scores: g.match.scores.join(':') };
    },
    { ticksPerFrame, ticks, seed },
  );

  console.log(`\nsimulation determinism (${TICKS} ticks, 8 bots, seed 12345)`);

  // 2 ticks/frame = a 60 fps client; 1 = 120 fps; 6 = a client stuck at 20 fps taking
  // the maximum substep burst; 0 = a headless server that never advances `frame`.
  const at60 = await run(2, TICKS, 12345);
  const at120 = await run(1, TICKS, 12345);
  const at20 = await run(6, TICKS, 12345);
  const headless = await run(0, TICKS, 12345);

  const cmp = (name, got) => {
    if (got.bots === at60.bots && got.scores === at60.scores) { ok(name); return; }
    const a = at60.bots.split('|'), b = got.bots.split('|');
    let detail = `scores ${at60.scores} vs ${got.scores}`;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { detail = `first divergent bot:\n         60fps: ${a[i]}\n         this:  ${b[i]}`; break; }
    }
    bad(name, detail);
  };

  cmp('120 fps matches 60 fps', at120);
  cmp('20 fps (6-substep bursts) matches 60 fps', at20);
  cmp('headless (frame never advances) matches 60 fps', headless);

  // A different seed must actually change the outcome, or the checks above are vacuous.
  const other = await run(2, TICKS, 99999);
  if (other.bots === at60.bots) bad('a different seed changes the outcome', 'seed 99999 produced identical state — the digest is not sensitive');
  else ok('a different seed changes the outcome');

  // And the same seed at the same rate must repeat.
  const repeat = await run(2, TICKS, 12345);
  cmp('the same seed replays identically', repeat);

  // ── the clock ──────────────────────────────────────────────────────────────────
  //
  // Every deadline in the game is a comparison against `game.time`. It must be a pure
  // function of the tick, not an accumulation, or a state replayed forward lands on a
  // slightly different clock than it had the first time and deadlines flip.
  console.log('\nsimulation clock');
  const clock = await page.evaluate(() => {
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 3 });
    const DT = 1 / 120;
    for (let i = 0; i < 5000; i++) g._fixedUpdate(DT);
    const straight = g.time;
    const tick = g.tick;

    // The same 5000 ticks, reached in bursts of varying size the way a stuttering client
    // takes them. An accumulated clock is sensitive to the grouping; a derived one is not.
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 3 });
    const BURSTS = [1, 6, 2, 6, 3, 1, 6, 4];
    let n = 0, bi = 0;
    while (n < 5000) {
      const burst = Math.min(BURSTS[bi++ % BURSTS.length], 5000 - n);
      for (let k = 0; k < burst; k++, n++) g._fixedUpdate(DT);
    }

    // Getter-only, so an assignment either throws (strict mode — all game source) or is
    // a silent no-op (sloppy mode — here). Either way the clock stays tied to the tick.
    const before = g.time;
    try { g.time = 123; } catch { /* strict-mode callers get the throw */ }
    const survivedWrite = g.time === before;
    return { straight, bursty: g.time, tick, exact: tick * DT, survivedWrite };
  });

  if (clock.straight === clock.bursty) ok('the clock is identical however the ticks were batched');
  else bad('the clock is identical however the ticks were batched', `${clock.straight} vs ${clock.bursty}`);
  if (clock.straight === clock.exact) ok('time is exactly tick × 1/120 (derived, not accumulated)');
  else bad('time is exactly tick × 1/120', `${clock.straight} vs ${clock.exact} — the clock is being accumulated`);
  if (clock.survivedWrite) ok('game.time cannot be assigned away from the tick');
  else bad('game.time cannot be assigned away from the tick', 'a plain assignment changed it — the clock is not derived');

  // ── player input survives a frame-frozen server ──────────────────────────────────
  //
  // Phase 2 found a real bug of exactly this shape: held-state (movement, fire) was
  // cached behind the same once-per-rendered-frame gate as edges and mouse look. On a
  // real client `game.frame` always advances, so it was invisible in play — but a
  // headless server (or this very harness, which drives `_fixedUpdate` without ever
  // touching `game.frame`) never advances it, so the gate opened once and never again,
  // freezing movement and fire input after the first tick. Prove player input still
  // works after many ticks with `game.frame` completely static.
  console.log('\nplayer input under a frozen game.frame (no render loop)');
  const frozen = await page.evaluate(() => {
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 9 });
    g.match.phase = 'live'; g.match.countdown = 0;
    const frameAtStart = g.frame;

    const inp = g.input;
    inp.enabled = true;
    inp.actions.add('forward');
    inp.buttons[0] = true;               // hold fire
    const DT = 1 / 120;
    const startPos = g.player.position.clone();
    let ammoAfter100 = null;
    for (let i = 0; i < 400; i++) {
      g._fixedUpdate(DT);                // game.frame is NEVER touched in this loop
      if (i === 99) ammoAfter100 = g.player.weapon?.ammo;
    }
    return {
      frameUnchanged: g.frame === frameAtStart,
      moved: g.player.position.distanceTo(startPos),
      ammoAfter100, ammoFinal: g.player.weapon?.ammo,
      weaponState: g.player.weapon?.state,
    };
  });

  if (!frozen.frameUnchanged) bad('game.frame really was frozen (test precondition)', 'harness bug, not a sim bug');
  else ok('game.frame stayed frozen for the whole run (test precondition holds)');
  if (frozen.moved > 0.5) ok(`player moved under held forward (${frozen.moved.toFixed(2)} m)`);
  else bad('player moved under held forward', `only ${frozen.moved.toFixed(3)} m in 400 frozen-frame ticks`);
  if (frozen.ammoAfter100 !== null && frozen.ammoAfter100 < 30) ok(`weapon fired under held trigger (ammo ${frozen.ammoAfter100}/30 at tick 100)`);
  else bad('weapon fired under held trigger', `ammo still ${frozen.ammoAfter100} at tick 100 — fire input froze`);

  // ── fire-to-skip-respawn reaches Match in the same tick it's pressed ─────────────
  //
  // A real regression, caught by review: `respawnSkip`/`airstrikeConfirm` were first
  // routed through `Player._edge`, which is cleared at the end of EVERY FIXED SUBSTEP —
  // before Match/Killstreaks (which run after Player in game._fixedUpdate's system
  // order) get a turn in that same substep. They silently never saw it true, so holding
  // fire stopped cutting the respawn wait short. Fixed by using a frame-scoped field
  // instead (`_firePressedThisFrame`) that matches `input.firePressed`'s original
  // lifetime. Prove the fix: kill the player, wait past the 1.5s skip-eligible window,
  // hold fire, and confirm respawn happens well before the full 4s timer.
  console.log('\nfire-to-skip-respawn reaches Match in the same tick');
  const skip = await page.evaluate(() => {
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 11 });
    g.match.phase = 'live'; g.match.countdown = 0;
    const DT = 1 / 120;

    g.player.applyDamage(9999, { attacker: null, hitPart: 'torso', weaponId: 'test' });
    if (g.player.alive) return { error: 'player did not die' };

    const inp = g.input;
    inp.enabled = true;
    // `firePressed` is the EDGE (`buttonsPressed[0]`, set by the real mousedown handler
    // and cleared by `Input.endFrame()`), not the held state (`buttons[0]`) — the
    // feature is "press fire after this to cut the wait short", not "hold it". Fire
    // one press at tick 200 (past the 1.5s/180-tick eligible window) and leave it —
    // this harness never calls `endFrame()`, so it stays "pressed" from then on, which
    // is a superset of the real one-frame edge and is fine for proving it's SEEN at all.
    let ticksToRespawn = -1;
    let sawFirePressedTrue = false;
    for (let i = 0; i < 600; i++) {   // 5s ceiling — well past the 4s no-skip timer
      g.frame++;   // this test is about tick ORDERING, not frame-freezing — see above
      if (i === 200) inp.buttonsPressed[0] = true;
      g._fixedUpdate(DT);
      if (g.player._firePressedThisFrame) sawFirePressedTrue = true;
      if (g.player.alive) { ticksToRespawn = i; break; }
    }
    return {
      ticksToRespawn, sawFirePressedTrue,
      gameState: g.state, gamePaused: g.paused,
      inputEnabled: g.input.enabled, inputFirePressedNow: g.input.firePressed,
    };
  });

  if (skip.error) bad('fire-to-skip-respawn reaches Match in the same tick', skip.error);
  else if (skip.ticksToRespawn < 0) bad('fire-to-skip-respawn reaches Match in the same tick', 'never respawned within 5s — the full 4s timer or longer ran, meaning fire was not seen at all');
  // 1.5s (180 ticks) is the earliest fire is even eligible to skip; 4.0s (480 ticks) is
  // the un-skipped timer. Landing meaningfully before 480 proves the skip fired.
  else if (skip.ticksToRespawn < 400) ok(`respawned at tick ${skip.ticksToRespawn} — held fire cut the wait short`);
  else bad('fire-to-skip-respawn reaches Match in the same tick', `respawned at tick ${skip.ticksToRespawn} — that's the un-skipped ~480-tick timer, fire was not seen`);

  // ── player aim recoil runs without a camera/presenter ────────────────────────────
  //
  // Phase 2b moved recoil integration off PlayerCamera onto Player, specifically so it
  // runs on a headless server that has no camera at all — it moves player.yaw/pitch,
  // which ballistics fires along, so it cannot be presentation-gated. Prove it directly:
  // call Player.addRecoil with the presenter swapped to NullPresenter (the shape a
  // headless server actually runs in) and confirm the aim moved anyway.
  console.log('\nplayer aim recoil runs without a camera/presenter');
  const headlessRecoil = await page.evaluate(async () => {
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 5 });
    const { NullPresenter } = await import('/src/core/presenter.js');
    const before = g.present;
    g.present = new NullPresenter();
    const p = g.player;
    p.setAngles(0, 0);
    let threw = null;
    try {
      p.addRecoil(2, 1, 0.1);   // pitch deg, yaw deg, punch metres
    } catch (e) { threw = String(e); }
    const movedPitch = p.pitch !== 0;
    const movedYaw = p.yaw !== 0;
    g.present = before;
    return { threw, movedPitch, movedYaw, yaw: p.yaw, pitch: p.pitch };
  });

  if (headlessRecoil.threw) bad('player aim recoil runs without a camera/presenter', headlessRecoil.threw);
  else if (headlessRecoil.movedPitch && headlessRecoil.movedYaw) ok(`addRecoil moved the aim under NullPresenter (yaw ${headlessRecoil.yaw.toFixed(4)}, pitch ${headlessRecoil.pitch.toFixed(4)})`);
  else bad('player aim recoil runs without a camera/presenter', 'aim did not move — recoil is still gated behind a live presenter somewhere');

  // ── accumAlpha never renders a stale tick ─────────────────────────────────────────
  //
  // A real bug found by review: while the sim is not advancing (paused), `_loop` zeroes
  // `_accum` every frame, so a naive `_accum / FIXED_DT` reads 0 forever — the camera
  // would render `lerp(prev, cur, 0)`, frozen on whatever recoil/sway looked like ONE
  // TICK before the pause, for as long as the pause lasts. `accumAlpha` must force 1
  // (render the latest tick, nothing to interpolate toward) whenever not simulating.
  console.log('\naccumAlpha never renders a stale tick while paused');
  const alphaCheck = await page.evaluate(() => {
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 13 });
    g.match.phase = 'live'; g.match.countdown = 0;
    g._accum = g._accum + (1 / 120) * 0.5;             // force a real fractional mid-tick position
    const playingAlpha = g.accumAlpha;                 // should reflect that fraction, not be pinned
    g.paused = true;
    const pausedAlpha = g.accumAlpha;
    g.paused = false;
    g.state = 'menu';
    const menuAlpha = g.accumAlpha;
    return { playingAlpha, pausedAlpha, menuAlpha };
  });
  if (Math.abs(alphaCheck.playingAlpha - 0.5) < 1e-6) ok(`accumAlpha reflects the real mid-tick fraction while simulating (${alphaCheck.playingAlpha.toFixed(3)})`);
  else bad('accumAlpha reflects the real mid-tick fraction while simulating', `expected ~0.5, got ${alphaCheck.playingAlpha} — a regression that pins accumAlpha to 1 unconditionally would slip past the paused-only checks below`);
  if (alphaCheck.pausedAlpha === 1) ok('accumAlpha is 1 while paused (renders the latest tick, not a stale blend)');
  else bad('accumAlpha is 1 while paused', `got ${alphaCheck.pausedAlpha} — a pause right after a shot would render one tick of stale recoil`);
  if (alphaCheck.menuAlpha === 1) ok('accumAlpha is 1 outside state==="playing"');
  else bad('accumAlpha is 1 outside state==="playing"', `got ${alphaCheck.menuAlpha}`);

  // ── adsAmount has exactly one owner ───────────────────────────────────────────────
  //
  // Player used to integrate its own copy and reconcile it against the weapon's every
  // tick through a self-correcting handshake, so the same quantity existed twice with a
  // mechanism to keep them agreeing. Snapshot/restore needs one field with one owner.
  console.log('\nadsAmount is owned by the weapon, not mirrored on the player');
  const adsCheck = await page.evaluate(() => {
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 21 });
    g.match.phase = 'live'; g.match.countdown = 0;
    const p = g.player;
    const DT = 1 / 120;
    const inp = g.input;
    inp.enabled = true;

    // Player must not carry its own storage for it any more.
    const ownFields = Object.keys(p);
    const hasOwn = ownFields.includes('adsAmount');
    const hasHandshake = ownFields.includes('_lastWeaponAds');

    // Hold the aim button and confirm the player's view of ADS tracks the weapon's.
    // Long enough to cover the initial weapon-switch, which gates ADS until it finishes;
    // this is asserting that aim-in completes, not how fast.
    inp.buttons[2] = true;
    let agreeing = true;
    for (let i = 0; i < 240; i++) {
      g.frame++;
      g._fixedUpdate(DT);
      if (Math.abs(p.adsAmount - p.weapon.adsAmount) > 1e-9) agreeing = false;
    }
    const aimedIn = p.adsAmount;

    // Dying must drop the aim: _readInput is the only other setAds caller and it does
    // not run while dead, so the gun would otherwise stay scoped through the death cam.
    p.die({ attacker: null });
    for (let i = 0; i < 120; i++) { g.frame++; g._fixedUpdate(DT); }
    const afterDeath = p.adsAmount;
    inp.buttons[2] = false;

    return { hasOwn, hasHandshake, agreeing, aimedIn, afterDeath };
  });
  if (!adsCheck.hasOwn) ok('player has no own adsAmount field (it is derived from the weapon)');
  else bad('player has no own adsAmount field', 'Player still stores its own copy — two integrators for one quantity');
  if (!adsCheck.hasHandshake) ok('the _lastWeaponAds handshake is gone');
  else bad('the _lastWeaponAds handshake is gone', 'Player still reconciles against the weapon every tick');
  if (adsCheck.agreeing) ok('player.adsAmount tracks weapon.adsAmount exactly, every tick');
  else bad('player.adsAmount tracks weapon.adsAmount', 'the two disagreed during aim-in — they are not one value');
  if (adsCheck.aimedIn > 0.9) ok(`holding aim still reaches full ADS (${adsCheck.aimedIn.toFixed(3)})`);
  else bad('holding aim reaches full ADS', `only got to ${adsCheck.aimedIn} after 2 s`);
  if (adsCheck.afterDeath === 0) ok('death drops the aim (setAds(false) on die)');
  else bad('death drops the aim', `adsAmount stayed at ${adsCheck.afterDeath} while dead — scoped through the death cam`);

  // ── the snapshot manifests cover every live field ────────────────────────────────
  //
  // This is the test the manifest exists for. Someone adding a field to Player or
  // WeaponInstance will not be thinking about reconciliation, and nothing about their
  // change will look wrong — the desync surfaces later as rare rubber-banding. Auditing a
  // LIVE instance (not the constructor) catches fields that other systems monkey-patch on
  // too, which reading the source would miss.
  console.log('\nsnapshot manifests cover every field on a live instance');
  const manifest = await page.evaluate(async () => {
    const g = window.__GAME__;
    const { PLAYER_SNAPSHOT } = await import('/src/player/player.js');
    const { WEAPON_SNAPSHOT, LOADOUT_SNAPSHOT } = await import('/src/weapons/weaponSystem.js');
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 2, difficulty: 'regular', seed: 31 });
    g.match.phase = 'live'; g.match.countdown = 0;
    const p = g.player;
    const DT = 1 / 120;
    const inp = g.input;
    inp.enabled = true;
    inp.actions.add('forward');
    inp.buttons[0] = true;
    // Exercise the entity first: fields are only present once something has assigned
    // them, so auditing a freshly constructed player would miss anything lazily added.
    for (let i = 0; i < 300; i++) { g.frame++; g._fixedUpdate(DT); }
    inp.buttons[0] = false;

    const playerAudit = PLAYER_SNAPSHOT.audit(p);
    const weaponAudit = WEAPON_SNAPSHOT.audit(p.weapon);
    const loadoutAudit = LOADOUT_SNAPSHOT.audit(g.weapons.getLoadout(p));

    // Negative control. An audit that cannot fail is worth nothing, and this one passing
    // is only meaningful if it would have caught the field somebody forgets. Plant one,
    // confirm it is reported, remove it.
    p._plantedUndeclaredField = 1;
    const caught = PLAYER_SNAPSHOT.audit(p).missing.includes('_plantedUndeclaredField');
    delete p._plantedUndeclaredField;

    return {
      playerAudit, weaponAudit, loadoutAudit, caught,
      playerFields: PLAYER_SNAPSHOT.captured.length,
      weaponFields: WEAPON_SNAPSHOT.captured.length,
    };
  });
  if (manifest.caught) ok('the audit catches a planted undeclared field (the guard is live)');
  else bad('the audit catches a planted undeclared field', 'audit() reported nothing for a field it should have flagged — the manifest checks below prove nothing');
  const auditOk = (label, a, extra = '') => {
    if (a.ok) { ok(`${label}${extra}`); return; }
    const parts = [];
    if (a.missing.length) parts.push(`undeclared on the instance: ${a.missing.join(', ')}`);
    // A name in the manifest that is not on the instance is the same class of bug: a
    // mistyped scalar saves and restores `undefined` while looking covered.
    if (a.stale.length) parts.push(`declared but absent: ${a.stale.join(', ')}`);
    bad(label, parts.join(' | '));
  };
  auditOk('Player manifest covers every live field', manifest.playerAudit, ` (${manifest.playerFields} captured)`);
  auditOk('WeaponInstance manifest covers every live field', manifest.weaponAudit, ` (${manifest.weaponFields} captured)`);
  auditOk('Loadout manifest covers every live field', manifest.loadoutAudit);

  // ── save / restore actually rewinds the simulation ───────────────────────────────
  //
  // The manifest being complete is necessary but not sufficient — it also has to restore
  // faithfully enough that re-running the same ticks lands in the same place. This is the
  // shape the bit-equality harness will take in Phase 6, at one tick.
  console.log('\nsave / restore rewinds the player, weapon and loadout exactly');
  const rewind = await page.evaluate(async () => {
    const g = window.__GAME__;
    const { PLAYER_SNAPSHOT } = await import('/src/player/player.js');
    const { WEAPON_SNAPSHOT, saveLoadout, restoreLoadout, diffLoadout } =
      await import('/src/weapons/weaponSystem.js');
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 77 });
    g.match.phase = 'live'; g.match.countdown = 0;
    const p = g.player;
    const DT = 1 / 120;
    const inp = g.input;
    inp.enabled = true;
    inp.actions.add('forward');
    for (let i = 0; i < 120; i++) { g.frame++; g._fixedUpdate(DT); }

    const lo = g.weapons.getLoadout(p);
    const startFrame = g.frame;

    // Capture, including the RNG position — a firing tick draws from it for spread and
    // recoil jitter, so replaying without rewinding the stream gives different bullets.
    const pSnap = PLAYER_SNAPSHOT.save(p);
    const loSnap = saveLoadout(lo);
    const rngState = g.rng.getState();
    const startTick = g.tick;

    /**
     * A deliberately BUSY script. An earlier version held forward and fire for 60 ticks,
     * and a reviewer showed it still passed with `_fireReadyAt` deleted from the manifest
     * — nothing in that script ever sprinted out or meleed, so the field never diverged.
     * A rewind test only covers the fields its script actually moves, so this one throws
     * a grenade, melees, sprints, switches weapon and reloads as well as moving and
     * firing.
     */
    const run = () => {
      inp.actions.clear();
      inp.actions.add('forward');
      for (let t = 0; t < 260; t++) {
        inp.buttons[0] = (t > 10 && t < 40);              // fire
        if (t === 45) inp.actions.add('sprint');          // sprint -> fire delay
        if (t === 70) inp.actions.delete('sprint');
        if (t === 80) inp.buttonsPressed[1] = true;       // melee (edge)
        if (t === 110) inp.pressed?.add?.('KeyG');        // grenade, if bound this way
        if (t === 120) g.weapons.throwGrenade?.(p);       // and directly, to be sure
        if (t === 150) g.weapons.switchTo(p, 1);          // holster -> raise, mid-flight
        if (t === 200) g.weapons.switchTo(p, 0);
        if (t === 230) p.weapon?.reload?.();
        g.frame++;
        g._fixedUpdate(DT);
      }
      inp.buttons[0] = false;
      inp.actions.clear();
      return { p: PLAYER_SNAPSHOT.save(p, {}), lo: saveLoadout(lo, {}) };
    };

    const first = run();

    // Rewind everything the replay depends on and run the identical script again.
    PLAYER_SNAPSHOT.restore(p, pSnap);
    restoreLoadout(lo, loSnap);
    // `entity.weapon` is a reference the loadout index decides; re-point it so a replay
    // that started mid-switch holds the same gun it did the first time.
    p.weapon = lo.index >= 0 ? lo.weapons[lo.index] : null;
    g.rng.setState(rngState);
    g.tick = startTick;
    g.frame = startFrame;
    const second = run();

    return {
      playerDiff: PLAYER_SNAPSHOT.diff(first.p, second.p),
      loadoutDiff: diffLoadout(first.lo, second.lo),
      // How much state the replayed stretch actually moved. Without this the whole test
      // could pass by replaying ticks in which nothing happened — two identical no-ops
      // match perfectly and prove nothing.
      playerAdvanced: PLAYER_SNAPSHOT.diff(pSnap, first.p).length,
      loadoutAdvanced: diffLoadout(loSnap, first.lo).length,
      // Evidence the busy script really reached the paths it is meant to cover.
      grenadesSpent: loSnap.equipment.lethalCount - first.lo.equipment.lethalCount,
      switched: loSnap.index !== first.lo.index || first.lo.weapons.length > 1,
    };
  });
  if (rewind.playerAdvanced >= 10 && rewind.loadoutAdvanced >= 5) {
    ok(`the replayed stretch does real work (${rewind.playerAdvanced} player / ${rewind.loadoutAdvanced} loadout fields changed)`);
  } else {
    bad('the replayed stretch does real work',
      `only ${rewind.playerAdvanced} player / ${rewind.loadoutAdvanced} loadout fields changed — a no-op replay matches trivially`);
  }
  if (rewind.grenadesSpent > 0) ok(`the script spends a grenade (${rewind.grenadesSpent}), so the loadout counter is exercised`);
  else bad('the script spends a grenade', 'lethalCount never moved — the grenade path this test exists to cover was not reached');
  if (rewind.playerDiff.length === 0) ok('player state after replay is identical, field for field');
  else bad('player state after replay is identical', `diverged: ${rewind.playerDiff.join(', ')}`);
  if (rewind.loadoutDiff.length === 0) ok('loadout, every weapon and the pending switch replay identically');
  else bad('loadout replays identically', `diverged: ${rewind.loadoutDiff.join(', ')}`);

  // ── the eye invariant ──────────────────────────────────────────────────────────
  //
  // Bullets leave from `getEyePosition()`, and the camera renders from that same point
  // plus decorative bob/shake/punch. The eye springs (crouch smoothing, stair step,
  // landing) are simulation and must therefore be INSIDE the eye — when they lived on
  // the camera, the bullet left from up to 0.24 m away from the point the player was
  // looking through, at every range, because the offset translates the whole ray.
  console.log('\neye / fire-origin agreement');
  const eye = await page.evaluate(() => {
    const g = window.__GAME__;
    g.stop();
    // Zero bots deliberately: this test only needs player state, and a live bot can
    // land a hit over 1500 ticks, triggering damageKick's punch spring — a real,
    // legitimate, but UNRELATED source of camera/eye disagreement (punch is deliberately
    // unfaded, since it displaces along the aim axis) that would make this test flaky
    // for a reason that has nothing to do with what it is checking.
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 7 });
    // Camera-only feel state (punch, bob, shake, lag) is NOT reset by respawn — only by
    // PlayerCamera.reset(), which runs once at boot — so it can carry over from an
    // earlier test block in this same page session (e.g. the frozen-frame test above,
    // which fires the weapon). Zero it explicitly rather than either
    // loosening the tolerance below or getting a false failure from a previous block.
    g.player.camera.punch = 0; g.player.camera.punchVel = 0;
    const THREE = g.player.position.constructor;
    const o = new THREE(); const e = new THREE();
    let worstOriginVsEye = 0, worstCamVsOrigin = 0, sawStep = 0, sawLand = 0, sawSlide = 0;
    for (let i = 0; i < 1500; i++) {
      // Every eye term has to actually move, or the two checks below prove nothing.
      // Walking onto stairs and sliding both need input plumbing that does not exist
      // until the command refactor, so those two are driven directly.
      if (i % 300 === 50) { g.player.position.y += 5; g.player.velocity.set(0, 0, 0); }
      if (i % 300 === 200) g.player.addEyeStep(0.25);
      g.player.slideAmount = (i % 300 >= 240 && i % 300 < 280) ? 1 : 0;
      g.frame++;
      g._fixedUpdate(1 / 120);
      // Punch is not what this test checks (see the note above the earlier explicit
      // zero) and, on the real map, the repeated position.y += 5 above can compound
      // with genuine terrain into a fall deep enough to trigger fall damage — a real
      // but unrelated source of punch. Zero every tick, not just once at the start.
      g.player.camera.punch = 0; g.player.camera.punchVel = 0;
      g.player.camera.update(1 / 120);          // compose the render camera
      g.weapons.getFireOrigin(g.player, o);
      g.player.getEyePosition(e);
      worstOriginVsEye = Math.max(worstOriginVsEye, o.distanceTo(e));
      g.camera.getWorldPosition(e);
      worstCamVsOrigin = Math.max(worstCamVsOrigin, o.distanceTo(e));
      sawStep = Math.max(sawStep, Math.abs(g.player.eyeStep));
      sawLand = Math.max(sawLand, Math.abs(g.player.eyeLand));
      sawSlide = Math.max(sawSlide, Math.abs(g.player.slideDip));
    }
    return { worstOriginVsEye, worstCamVsOrigin, sawStep, sawLand, sawSlide };
  });

  if (eye.worstOriginVsEye < 1e-9) ok('the fire origin IS the simulated eye');
  else bad('the fire origin IS the simulated eye', `diverged by ${eye.worstOriginVsEye}`);

  // Bob/shake/punch are the only permitted disagreement, and this probe never moves or
  // fires, so all three are ~0 here. The threshold is set well below the smallest eye
  // term (slideDip, 13 cm) so that a spring escaping back onto the camera fails loudly
  // rather than hiding under a slack bound.
  const CAM_TOL = 0.05;
  if (eye.worstCamVsOrigin < CAM_TOL) ok(`camera sits on the eye to within ${(eye.worstCamVsOrigin * 100).toFixed(2)} cm (decorative only)`);
  else bad('camera sits on the eye', `worst disagreement ${(eye.worstCamVsOrigin * 100).toFixed(2)} cm — an eye term is on the camera but not in the eye`);

  // EVERY eye term must have moved, or the checks above are vacuous for the ones that
  // did not. Deliberately AND, not OR: an OR here let the landing half be entirely dead.
  const moved = [['step', eye.sawStep], ['land', eye.sawLand], ['slide dip', eye.sawSlide]];
  const dead = moved.filter(([, v]) => v <= 1e-4).map(([n]) => n);
  if (!dead.length) ok(`every eye term exercised (${moved.map(([n, v]) => `${n} ${v.toFixed(3)} m`).join(', ')})`);
  else bad('every eye term exercised', `never moved: ${dead.join(', ')} — untested for those terms`);
} finally {
  await browser?.close();
  await server?.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nall determinism checks passed');
process.exit(failures ? 1 : 0);
