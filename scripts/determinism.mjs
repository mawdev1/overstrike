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
  // The production shell no longer constructs the game at boot — a signed-out visitor
  // lands on the welcome screen and `__GAME__` only exists after entering the runtime.
  // Enter local practice the same way `mapperf.mjs` does; the harness then stop()s the
  // loop and drives `_fixedUpdate` itself, so which match it entered is irrelevant.
  await page.waitForFunction(() => window.__OVERSTRIKE_SHELL__?.enterGame, null, { timeout: 90000 });
  await page.evaluate(() => window.__OVERSTRIKE_SHELL__.enterGame({
    localPractice: true, matchId: 'determinism-local', mode: 'tdm', seed: 1,
  }));
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
    // Since the mouse-rebind work, `input.fire` resolves through the ACTION set (the
    // real mousedown handler does `actions.add(actionFor(mouseCode(b)))`); writing the
    // raw `buttons[]` array no longer reaches the sim.
    inp.actions.add('fire');             // hold fire
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
    // `firePressed` is the EDGE (`pressed.add('fire')`, set by the real mousedown handler
    // and cleared by `Input.endFrame()`), not the held state (`actions`) — the
    // feature is "press fire after this to cut the wait short", not "hold it". Fire
    // one press at tick 200 (past the 1.5s/180-tick eligible window) and leave it —
    // this harness never calls `endFrame()`, so it stays "pressed" from then on, which
    // is a superset of the real one-frame edge and is fine for proving it's SEEN at all.
    let ticksToRespawn = -1;
    let sawFirePressedTrue = false;
    for (let i = 0; i < 600; i++) {   // 5s ceiling — well past the 4s no-skip timer
      g.frame++;   // this test is about tick ORDERING, not frame-freezing — see above
      if (i === 200) inp.pressed.add('fire');
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
    // Force a real fractional mid-tick position. Set, don't add: entering the shell's
    // practice runtime leaves a residual `_accum` from the live loop `stop()` cut short,
    // and adding to it can land past one full tick, where the clamp reads 1.
    g._accum = (1 / 120) * 0.5;
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
    inp.actions.add('aim');    // `input.aim` reads the action set, not raw `buttons[]`
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
    inp.actions.delete('aim');

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
    inp.actions.add('fire');
    // Exercise the entity first: fields are only present once something has assigned
    // them, so auditing a freshly constructed player would miss anything lazily added.
    for (let i = 0; i < 300; i++) { g.frame++; g._fixedUpdate(DT); }
    inp.actions.delete('fire');

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

  // ── PROJECTILE_SNAPSHOT / SMOKE_SNAPSHOT cover every live field ──────────────────
  //
  // Same reasoning as the Player/WeaponInstance/Loadout audit above, and the missing half
  // of it: `ProjectileSystem.saveState`/`restoreState` back `net/prediction.js`'s
  // `_correct()` rewind of grenades/rockets in flight, but nothing ran `audit()` against a
  // live pool entry or smoke-cloud record, so a field added to the object literals in
  // `ProjectileSystem.init()` (or grown onto a cloud by `_popSmoke`) could fall out of the
  // manifest with the whole suite staying green — exactly the failure class this codebase
  // has hit before with Player/WeaponInstance/Loadout.
  console.log('\nPROJECTILE_SNAPSHOT / SMOKE_SNAPSHOT cover every live field');
  const projManifest = await page.evaluate(async () => {
    const { PROJECTILE_SNAPSHOT, SMOKE_SNAPSHOT } = await import('/src/weapons/projectiles.js');
    const { FRAG, SMOKE } = await import('/src/weapons/weaponDefs.js');
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 41 });
    g.match.phase = 'live'; g.match.countdown = 0;
    const DT = 1 / 120;
    const p = g.player;

    // A live, in-flight frag: audited BEFORE it detonates, so the pool slot carries a
    // real fuse/age/bounces/velocity rather than the all-zero shape `init()` allocates.
    const origin = p.position.clone(); origin.y += 1.5;
    const dir = new (p.position.constructor)(0, 0, -1);
    g.projectiles.throwGrenade(p, origin, dir, 1, FRAG, 0);
    for (let i = 0; i < 5; i++) g.projectiles.fixedUpdate(DT);
    const live = g.projectiles.pool.find((x) => x.active);

    // A live smoke cloud: only allocated by `_popSmoke` on detonation, so throw a smoke
    // grenade cooked almost all the way down and step until it pops.
    const smokeFuse = SMOKE.projectile.fuse ?? 3;
    g.projectiles.throwGrenade(p, origin, dir, 1, SMOKE, Math.max(0, smokeFuse - 0.05));
    let cloud = null;
    for (let i = 0; i < 30 && !cloud; i++) {
      g.projectiles.fixedUpdate(DT);
      cloud = g.projectiles.smokeClouds.find((c) => c.active);
    }

    const projAudit = live ? PROJECTILE_SNAPSHOT.audit(live) : null;
    const smokeAudit = cloud ? SMOKE_SNAPSHOT.audit(cloud) : null;

    // Negative control, same shape as the Player one above: an audit that cannot fail is
    // worth nothing.
    let projCaught = false, smokeCaught = false;
    if (live) {
      live._plantedUndeclaredField = 1;
      projCaught = PROJECTILE_SNAPSHOT.audit(live).missing.includes('_plantedUndeclaredField');
      delete live._plantedUndeclaredField;
    }
    if (cloud) {
      cloud._plantedUndeclaredField = 1;
      smokeCaught = SMOKE_SNAPSHOT.audit(cloud).missing.includes('_plantedUndeclaredField');
      delete cloud._plantedUndeclaredField;
    }

    g.projectiles.reset();

    return {
      hadLive: !!live, hadCloud: !!cloud,
      projAudit, smokeAudit, projCaught, smokeCaught,
      projFields: PROJECTILE_SNAPSHOT.captured.length,
      smokeFields: SMOKE_SNAPSHOT.captured.length,
    };
  });
  if (projManifest.hadLive) ok('an in-flight frag was captured for the audit');
  else bad('an in-flight frag was captured for the audit', 'throwGrenade + a few fixedUpdate steps left no active pool slot — the audit below proves nothing');
  if (projManifest.hadCloud) ok('a live smoke cloud was captured for the audit');
  else bad('a live smoke cloud was captured for the audit', 'the smoke grenade never popped within the step budget — the audit below proves nothing');
  if (projManifest.projCaught) ok('the audit catches a planted undeclared field on a pool entry (the guard is live)');
  else bad('the audit catches a planted undeclared field on a pool entry', 'audit() reported nothing — the manifest check below proves nothing');
  if (projManifest.smokeCaught) ok('the audit catches a planted undeclared field on a smoke cloud (the guard is live)');
  else bad('the audit catches a planted undeclared field on a smoke cloud', 'audit() reported nothing — the manifest check below proves nothing');
  if (projManifest.projAudit) auditOk('PROJECTILE_SNAPSHOT covers every live field on a pool entry', projManifest.projAudit, ` (${projManifest.projFields} captured)`);
  if (projManifest.smokeAudit) auditOk('SMOKE_SNAPSHOT covers every live field on a smoke cloud', projManifest.smokeAudit, ` (${projManifest.smokeFields} captured)`);

  // ── save / restore actually rewinds the simulation ───────────────────────────────
  //
  // The manifest being complete is necessary but not sufficient — it also has to restore
  // faithfully enough that re-running the same ticks lands in the same place. This is the
  // shape the bit-equality harness will take in Phase 6, at one tick.
  // ── restore actually returns the entity to its captured state ───────────────────
  //
  // The strongest completeness check, and deliberately NOT a behavioural one. The replay
  // test below can only catch a dropped field if that field's stale value happens to
  // change behaviour inside the replay window — a reviewer demonstrated that by deleting
  // `_fireReadyAt` from the manifest and watching the whole suite still pass. Which
  // fields a script covers is an accident of the script.
  //
  // This asks the question directly instead: dump every own field, run, restore, dump
  // again. Anything that did not come back is a field the manifest failed to restore,
  // whatever the reason — dropped, mistyped, or captured but not written back.
  //
  // Crucially the exclusion list belongs to the TEST, not to the manifest. If it read the
  // manifest's own `ignore` list, moving a field there would silence this check, which is
  // exactly the escape hatch that made the earlier guard weak. Duplicating it here means
  // dropping a field takes two deliberate edits in two files, and the second one is this
  // conspicuous list.
  console.log('\nrestore returns the entity to exactly its captured state');
  const roundTrip = await page.evaluate(async () => {
    const g = window.__GAME__;
    const { PLAYER_SNAPSHOT } = await import('/src/player/player.js');
    const { WEAPON_SNAPSHOT, saveLoadout, restoreLoadout } = await import('/src/weapons/weaponSystem.js');
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 91 });
    g.match.phase = 'live'; g.match.countdown = 0;
    const p = g.player;
    const DT = 1 / 120;
    const inp = g.input;
    inp.enabled = true;

    // Legitimately not restored, each for a stated reason. Anything not on this list is
    // expected to come back exactly.
    const PLAYER_EXEMPT = new Set([
      'game', 'camera',        // system / presentation references
      'weapon',                // reference; the loadout index decides it
      'hitboxes',              // recomputed from height + lean every live tick
      '_cmdScratch',           // reused scratch buffer for the local command
      '_lookFrame',            // gate against game.frame, meaningless in a replay
      'id', 'isPlayer', 'name', 'radius', 'maxHealth',   // identity and constants
    ]);
    const WEAPON_EXEMPT = new Set(['system', 'game', 'owner', 'def', 'viewmodel', 'interval']);
    // The loadout carries the grenade counters, which gun is equipped, and every
    // holstered instance. Its manifest had no completeness test at all: `audit` reads the
    // manifest's own `ignore`, and `diffLoadout` only compares fields the manifest already
    // carries, so a dropped field there was structurally unseeable by the whole suite.
    const LOADOUT_EXEMPT = new Set(['weapons', 'melee', 'switchPending']);

    // A comparable digest of every own enumerable field, built without consulting the
    // manifest at all.
    const dump = (o, exempt) => {
      const out = {};
      for (const k of Object.keys(o)) {
        if (exempt.has(k)) continue;
        const v = o[k];
        if (v === null || v === undefined) { out[k] = String(v); continue; }
        if (typeof v === 'object') {
          if ('x' in v && 'y' in v && 'z' in v) { out[k] = `${v.x},${v.y},${v.z}`; continue; }
          // Whole structure, recursively. An earlier version kept only scalar sub-keys,
          // so an object-valued key nested inside `stats` or `_held` was invisible to
          // both the dump and the scribble and would "restore" without ever being
          // carried. These records are flat today; this makes them stay honest if not.
          out[k] = JSON.stringify(v);
          continue;
        }
        out[k] = v;
      }
      return out;
    };

    inp.actions.add('forward');
    for (let i = 0; i < 90; i++) { g.frame++; g._fixedUpdate(DT); }
    inp.actions.clear();

    const lo = g.weapons.getLoadout(p);
    const dumpAll = () => ({
      p: dump(p, PLAYER_EXEMPT),
      w: dump(p.weapon, WEAPON_EXEMPT),
      lo: dump(lo, LOADOUT_EXEMPT),
      // Each instance in the loadout, including the holstered ones and melee, which are
      // mutated by switching even though fixedUpdate only ticks the equipped weapon.
      guns: lo.weapons.map((w) => dump(w, WEAPON_EXEMPT)).concat([dump(lo.melee, WEAPON_EXEMPT)]),
    });
    const before = dumpAll();
    const pSnap = PLAYER_SNAPSHOT.save(p);
    const wSnap = WEAPON_SNAPSHOT.save(p.weapon);
    const loSnap = saveLoadout(lo);

    /**
     * Scribble over every own field, then restore.
     *
     * Deliberately not "run the sim and see what comes back". Fields that happen to
     * CONVERGE to their captured value — sprintRamp decaying to 0, crouchFrac returning
     * to standing, a timer expiring — are invisible to a before/after comparison, so a
     * gameplay-driven version of this test silently covered only the fields whose values
     * happened to still differ at the end. Corrupting everything removes the dependence
     * on gameplay entirely: after a restore, every captured field must be back, and any
     * field the manifest does not carry is still wearing its scribble.
     */
    // Recursive, so a nested record's own sub-objects are corrupted too.
    const scribbleInto = (v) => {
      for (const kk of Object.keys(v)) {
        const vv = v[kk];
        if (typeof vv === 'number') v[kk] = vv + 12345.678;
        else if (typeof vv === 'boolean') v[kk] = !vv;
        else if (typeof vv === 'string') v[kk] = `${vv}~scribbled`;
        else if (vv && typeof vv === 'object') scribbleInto(vv);
      }
    };
    const scribble = (o, exempt) => {
      for (const k of Object.keys(o)) {
        if (exempt.has(k)) continue;
        const v = o[k];
        if (typeof v === 'number') o[k] = v + 12345.678;
        else if (typeof v === 'boolean') o[k] = !v;
        else if (typeof v === 'string') o[k] = `${v}~scribbled`;
        else if (v && typeof v === 'object') {
          if ('x' in v && 'y' in v && 'z' in v) { v.x += 999; v.y += 999; v.z += 999; continue; }
          scribbleInto(v);
        }
      }
    };
    scribble(p, PLAYER_EXEMPT);
    scribble(lo, LOADOUT_EXEMPT);
    for (const w of lo.weapons) scribble(w, WEAPON_EXEMPT);
    scribble(lo.melee, WEAPON_EXEMPT);
    const scribbled = dumpAll();

    PLAYER_SNAPSHOT.restore(p, pSnap);
    restoreLoadout(lo, loSnap);
    WEAPON_SNAPSHOT.restore(p.weapon, wSnap);
    const after = dumpAll();

    const compare = (a, b) => {
      const bad = [];
      for (const k of Object.keys(a)) if (!Object.is(a[k], b[k])) bad.push(k);
      for (const k of Object.keys(b)) if (!(k in a)) bad.push(`${k} (appeared)`);
      return bad;
    };
    // Every field must actually have been scribbled, or a green result could just mean
    // the corruption never landed.
    const gunsBad = [];
    for (let i = 0; i < before.guns.length; i++) {
      for (const f of compare(before.guns[i], after.guns[i])) gunsBad.push(`weapons[${i}].${f}`);
    }
    let gunFields = 0, gunScribbled = 0;
    for (let i = 0; i < before.guns.length; i++) {
      gunFields += Object.keys(before.guns[i]).length;
      gunScribbled += compare(before.guns[i], scribbled.guns[i]).length;
    }
    return {
      playerBad: compare(before.p, after.p),
      weaponBad: compare(before.w, after.w),
      loadoutBad: compare(before.lo, after.lo).concat(gunsBad),
      playerFields: Object.keys(before.p).length,
      weaponFields: Object.keys(before.w).length,
      loadoutFields: Object.keys(before.lo).length + gunFields,
      scribbledCount: compare(before.p, scribbled.p).length,
      weaponScribbled: compare(before.w, scribbled.w).length,
      loadoutScribbled: compare(before.lo, scribbled.lo).length + gunScribbled,
    };
  });
  if (roundTrip.scribbledCount === roundTrip.playerFields) {
    ok(`all ${roundTrip.playerFields} player fields were corrupted before the restore (the check can bite)`);
  } else {
    bad('every player field was corrupted before the restore',
      `only ${roundTrip.scribbledCount} of ${roundTrip.playerFields} changed — the rest were not scribbled, so restoring them proves nothing`);
  }
  if (roundTrip.playerBad.length === 0) {
    ok(`every one of the player's ${roundTrip.playerFields} own fields comes back exactly`);
  } else {
    bad('every own player field comes back after restore',
      `not restored: ${roundTrip.playerBad.join(', ')}`);
  }
  if (roundTrip.weaponBad.length === 0) {
    ok(`every one of the weapon's ${roundTrip.weaponFields} own fields comes back exactly`);
  } else {
    bad('every own weapon field comes back after restore',
      `not restored: ${roundTrip.weaponBad.join(', ')}`);
  }
  // The weapon and loadout need their own corruption assertions: a field that is null or
  // NaN at scribble time cannot be corrupted, and would then "restore" for free.
  if (roundTrip.weaponScribbled === roundTrip.weaponFields
    && roundTrip.loadoutScribbled === roundTrip.loadoutFields) {
    ok(`all ${roundTrip.weaponFields} weapon and ${roundTrip.loadoutFields} loadout fields were corrupted first`);
  } else {
    bad('every weapon and loadout field was corrupted before the restore',
      `weapon ${roundTrip.weaponScribbled}/${roundTrip.weaponFields}, loadout ${roundTrip.loadoutScribbled}/${roundTrip.loadoutFields}`);
  }
  if (roundTrip.loadoutBad.length === 0) {
    ok(`the loadout and all ${roundTrip.loadoutFields} fields of its weapons come back exactly`);
  } else {
    bad('the loadout comes back after restore', `not restored: ${roundTrip.loadoutBad.join(', ')}`);
  }

  console.log('\nsave / restore replays bit-identically, every tick');
  const rewind = await page.evaluate(async () => {
    const g = window.__GAME__;
    const { PLAYER_SNAPSHOT } = await import('/src/player/player.js');
    const { saveLoadout, restoreLoadout, diffLoadout } = await import('/src/weapons/weaponSystem.js');
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 77 });
    g.match.phase = 'live'; g.match.countdown = 0;
    const p = g.player;
    const DT = 1 / 120;
    const inp = g.input;
    inp.enabled = true;

    // Park the player in the most open spot on the map. An earlier version of this test
    // just held `forward` from spawn, which walked him into a wall — he was then
    // bit-identically motionless for the whole run, so no movement field ever diverged
    // and removing one from the manifest changed nothing. A rewind test only covers the
    // fields its script actually moves.
    // Pick the spawn with the most room in EVERY direction — the widest minimum, not the
    // longest single sightline. A corridor scores well on "longest" and is useless here:
    // the script strafes and walks backwards, so it needs open floor all round.
    let best = null;
    const V = p.position.constructor;
    const eye = new V(), dir = new V();
    for (const sp of g.world.spawnPoints) {
      let worst = Infinity;
      for (let i = 0; i < 16; i++) {
        const yaw = (i / 16) * Math.PI * 2;
        eye.set(sp.position.x, sp.position.y + 1.0, sp.position.z);
        dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        const hit = g.world.raycast(eye, dir, 60);
        worst = Math.min(worst, hit ? hit.distance : 60);
      }
      if (!best || worst > best.open) best = { pos: sp.position.clone(), yaw: 0, open: worst };
    }

    const reseat = () => {
      p.position.copy(best.pos);
      p.velocity.set(0, 0, 0);
      p.setAngles(best.yaw, -0.02);
    };
    reseat();
    for (let i = 0; i < 60; i++) { g.frame++; g._fixedUpdate(DT); }

    const lo = g.weapons.getLoadout(p);
    const startFrame = g.frame;
    const pSnap = PLAYER_SNAPSHOT.save(p);
    const loSnap = saveLoadout(lo);
    const rngState = g.rng.getState();
    const startTick = g.tick;

    // A manifest exists now (PROJECTILE_SNAPSHOT/SMOKE_SNAPSHOT, see the audit block above,
    // and `net/prediction.js` `_correct()` actually rewinds/replays through it — see the
    // "client reconciliation replays a grenade in flight without double-firing its
    // detonation" block below). THIS harness, though, restores Player/Loadout only and
    // resets projectiles to empty via `g.projectiles.reset()`, which is a FAITHFUL restore
    // only because nothing is in flight at capture time. Assert that rather than assume it,
    // so this stays honest if the warm-up ever changes.
    const activeAtCapture = g.projectiles.pool.filter((x) => x.active).length
      + g.projectiles.smokeClouds.filter((c) => c.active).length;

    /**
     * A script that actually moves the whole entity: walk, strafe, jump (so the landing
     * springs and `_airPeakY` fire), crouch and slide, sprint, fire, melee, throw a
     * grenade, switch weapon mid-flight and reload.
     */
    const TICKS = 300;
    const script = (t) => {
      const a = inp.actions;
      a.clear();
      if (t < 40 || (t > 90 && t < 140)) a.add('forward');
      if (t >= 40 && t < 60) a.add('left');
      if (t >= 60 && t < 90) a.add('back');
      if (t > 140 && t < 190) { a.add('forward'); a.add('sprint'); }
      if (t > 200 && t < 240) a.add('right');
      if ((t > 15 && t < 45) || (t > 250 && t < 270)) a.add('fire');
      // Edges live in `input.pressed`, which `wasPressed()` reads; there is no
      // `actionsPressed`, so an earlier version of this script silently never jumped.
      inp.pressed.clear();
      if (t === 30 || t === 120 || t === 210) inp.pressed.add('jump');
      if (t === 95 || t === 195 || t === 175) inp.pressed.add('crouch');
      if (t === 80) inp.pressed.add('melee');
      if (t === 110) g.weapons.throwGrenade?.(p);
      if (t === 150) g.weapons.switchTo(p, 1);                  // holster -> raise
      if (t === 230) g.weapons.switchTo(p, 0);
      if (t === 280) p.weapon?.reload?.();
    };

    /**
     * Run the script, capturing the FULL state after every single tick.
     *
     * End-state comparison is far too weak: anything that converges before the last tick
     * — bloom decaying to its floor, a spring settling, a timer expiring — is invisible,
     * so a field can diverge for 200 ticks and still compare equal at the end. Comparing
     * per tick is what "bit-equality" in the plan actually means, and it reports the tick
     * where the two runs first parted company.
     */
    const trace = () => {
      const out = [];
      for (let t = 0; t < TICKS; t++) {
        script(t);
        g.frame++;
        g._fixedUpdate(DT);
        out.push({ p: PLAYER_SNAPSHOT.save(p, {}), lo: saveLoadout(lo, {}) });
      }
      inp.actions.clear();
      return out;
    };

    const first = trace();

    PLAYER_SNAPSHOT.restore(p, pSnap);
    restoreLoadout(lo, loSnap);
    g.projectiles.reset();
    g.rng.setState(rngState);
    g.tick = startTick;
    g.frame = startFrame;
    const second = trace();

    // First tick at which the two runs disagree, and on what.
    let firstBad = -1, badFields = [];
    for (let t = 0; t < TICKS; t++) {
      const d = PLAYER_SNAPSHOT.diff(first[t].p, second[t].p)
        .concat(diffLoadout(first[t].lo, second[t].lo));
      if (d.length) { firstBad = t; badFields = d; break; }
    }

    // Coverage: how many DISTINCT fields the script moved at any point during the run,
    // not merely how many differ at the end. This is the number that says whether the
    // test can catch a removed field at all.
    const touched = new Set();
    // Path length, not net displacement: the script deliberately walks out and back, so
    // it can travel a long way and finish near where it started.
    let pathMetres = 0;
    for (let t = 1; t < TICKS; t++) {
      for (const f of PLAYER_SNAPSHOT.diff(first[t - 1].p, first[t].p)) touched.add(f);
      for (const f of diffLoadout(first[t - 1].lo, first[t].lo)) touched.add(`lo.${f}`);
      pathMetres += Math.hypot(
        first[t].p.position.x - first[t - 1].p.position.x,
        first[t].p.position.y - first[t - 1].p.position.y,
        first[t].p.position.z - first[t - 1].p.position.z,
      );
    }

    return {
      firstBad,
      badFields: badFields.slice(0, 14),
      touchedCount: touched.size,
      capturedCount: PLAYER_SNAPSHOT.captured.length,
      grenadesSpent: loSnap.equipment.lethalCount - first[TICKS - 1].lo.equipment.lethalCount,
      activeAtCapture,
      pathMetres,
    };
  });
  // The coverage figure is the honest measure of this test's power: it can only catch a
  // field being dropped from the manifest if the script moves that field.
  if (rewind.touchedCount >= 40) ok(`the script exercises ${rewind.touchedCount} distinct player/loadout fields`);
  else bad('the script exercises enough state to be meaningful',
    `only ${rewind.touchedCount} fields ever changed during the run (of ${rewind.capturedCount} captured) — a field the script never moves cannot be caught if it is dropped from the manifest`);
  // ~230 of the 300 ticks hold a movement key, so a free-running player covers roughly
  // 10 m. Well under that means he is jammed against geometry and the movement fields
  // never vary, which is the failure mode that made an earlier version of this test
  // vacuous.
  if (rewind.pathMetres > 8) ok(`the player actually moves (${rewind.pathMetres.toFixed(1)} m travelled)`);
  else bad('the player actually moves', `only ${rewind.pathMetres.toFixed(2)} m travelled — jammed against geometry, so movement state never varies`);
  if (rewind.grenadesSpent > 0) ok(`a grenade is spent (${rewind.grenadesSpent}), so the loadout counter is exercised`);
  else bad('a grenade is spent', 'lethalCount never moved');
  if (rewind.activeAtCapture === 0) ok('nothing is in flight at capture, so resetting projectiles on restore is faithful');
  else bad('nothing is in flight at capture',
    `${rewind.activeAtCapture} projectile(s) live when the snapshot was taken — resetting them on restore is no longer a faithful rewind for THIS harness, which only restores Player/Loadout`);
  if (rewind.firstBad === -1) ok('every tick of the replay is identical, field for field');
  else bad('every tick of the replay is identical', `first divergence at tick ${rewind.firstBad}: ${rewind.badFields.join(', ')}`);

  // ── client reconciliation replays a grenade in flight without double-firing it ───
  //
  // The actual thing `net/prediction.js` `_correct()` was changed for, driven exactly the
  // way a real client drives it: through `Prediction.predict()`/`Prediction.reconcile()`,
  // not by calling ProjectileSystem directly. A frag is thrown, ticked partway to
  // detonation, and a server correction arrives whose acked command lands BEFORE the
  // detonation tick but whose unacked queue extends past it — the exact situation the
  // module header on `saveState`/`restoreState` and the `game._replaying` guard in
  // `_detonate` describe. If the rewind failed to restore the in-flight grenade, the
  // replay would re-throw it from scratch and it would not detonate on schedule. If the
  // `game._replaying` guard were missing or misplaced, the replay would re-run
  // `_popExplosive` on the same detonation a second time and a bystander would take blast
  // damage twice for one grenade.
  console.log('\nclient reconciliation replays a grenade in flight without double-firing it');
  const grenadeCorrection = await page.evaluate(async () => {
    const { Prediction } = await import('/src/net/prediction.js');
    const { PLAYER_SNAPSHOT } = await import('/src/player/player.js');
    const { FRAG } = await import('/src/weapons/weaponDefs.js');
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 1, difficulty: 'regular', seed: 51 });
    g.match.phase = 'live'; g.match.countdown = 0;
    const DT = 1 / 120;
    const p = g.player;
    const bystander = g.bots.bots[0];
    p.position.set(0, 1, 0);
    p.velocity.set(0, 0, 0);
    // Blast damage is gated behind spawn protection and friendly fire (see
    // `damageScale`/`isProtected` in ballistics.js/match.js) — neither of which this test
    // is about. Clear both so the explosion actually lands.
    g.match.clearProtection(bystander);
    bystander.team = p.team === 0 ? 1 : 0;

    // A fake NetClient: `Prediction` only ever reads `net.unacked`, an array of commands
    // with `.seq`, which this test fills in by hand.
    const net = { unacked: [] };
    const pred = new Prediction(g, p, net);

    const cmd = (seq) => ({
      seq, wishForward: 0, wishRight: 0, crouchHeld: false, toggleAdsMode: false,
      aimButtonHeld: false, fireHeld: false, sprintKeyHeld: false, breathHold: false,
      leanKeyHeld: false, leanRightKeyHeld: false, deltaYaw: 0, deltaPitch: 0,
      crouchPressed: false, jump: false, reload: false, melee: false, grenade: false,
      interact: false, interactHeld: false, inspect: false, killstreak: false,
      lastWeapon: false, slot: -1, sprintDown: false, sprintUp: false, wheel: 0,
      firePressed: false, aimButtonPressed: false,
    });

    // seq 0: baseline tick, nothing thrown yet.
    pred.predict(cmd(0));

    // Throw the frag directly through ProjectileSystem (not through the command — this
    // test is about the projectile rewind, not the throw-input path) and park it near, but
    // not on top of, the bystander with zero velocity, so the ONLY thing left to happen is
    // its fuse running out exactly where it stands. Offset rather than co-located: at
    // point-blank the 130-damage frag (radius 6.5) one-shots a 100 HP bot, and a target
    // already dead when the "replay" detonation fires is skipped by `applyExplosionDamage`
    // regardless of whether the `game._replaying` guard works — which would make the
    // double-damage assertion below pass even with the guard removed. ~5 m out puts the
    // falloff-scaled hit around 18-20 HP, leaving the bystander alive with headroom to
    // show a SECOND hit if the guard fails to stop one.
    const origin = bystander.position.clone(); origin.x += 5.0; origin.y += 1.0;
    const dir = new (p.position.constructor)(0, 0, -1);
    g.projectiles.throwGrenade(p, origin, dir, 1, FRAG, 0);
    const live = g.projectiles.pool.find((x) => x.active);
    live.pos.copy(origin);
    live.vel.set(0, 0, 0);
    live.mesh.position.copy(live.pos);
    live.fuse = 3.5 / 120;            // detonates on the 4th fixed tick from here

    // seq 1..3: fuse ticks down but the grenade is still live. seq 3's captured history is
    // what the correction below acks — the grenade mid-flight, one tick from going off.
    pred.predict(cmd(1));
    pred.predict(cmd(2));
    pred.predict(cmd(3));
    const ackedMine = pred.history.get(3);
    const healthBeforeDetonation = bystander.health;

    // seq 4: for real, the first time, the grenade detonates and the bystander takes
    // blast damage. This is the run whose effects a replay must NOT repeat.
    pred.predict(cmd(4));
    const healthAfterFirstDetonation = bystander.health;
    const tookDamageFirstRun = healthAfterFirstDetonation < healthBeforeDetonation;
    const projectileGone = !g.projectiles.pool.some((x) => x.active);

    // A server snapshot acking seq 3 (before the detonation) but disagreeing on position
    // by enough to force a correction — `reconcile()` -> `_correct()` will rewind the
    // player AND the projectile pool to their seq-3 state (grenade still live, one tick
    // from its fuse) and replay commands 4.. through `game._fixedUpdate`, re-arming the
    // exact tick that detonated it the first time.
    net.unacked = [cmd(4)];
    const wire = {
      id: p.id,
      x: ackedMine.player.position.x + 0.5, y: ackedMine.player.position.y, z: ackedMine.player.position.z,
      vx: ackedMine.player.velocity.x, vy: ackedMine.player.velocity.y, vz: ackedMine.player.velocity.z,
      health: ackedMine.player.health, armor: ackedMine.player.armor,
      height: ackedMine.player.height, lean: ackedMine.player.lean,
      flags: 1, team: p.team,
    };
    let replayingDuringDetonation = null;
    const origDetonate = g.projectiles._detonate.bind(g.projectiles);
    g.projectiles._detonate = (proj) => { replayingDuringDetonation = g._replaying; origDetonate(proj); };

    const corrected = pred.reconcile({ entities: [wire], lastCommandSeq: 3, tick: g.tick });
    const healthAfterCorrection = bystander.health;
    g.projectiles._detonate = origDetonate;

    return {
      corrected,
      tookDamageFirstRun,
      projectileGone,
      replayingDuringDetonation,
      doubleDamaged: healthAfterCorrection < healthAfterFirstDetonation,
      healthBeforeDetonation, healthAfterFirstDetonation, healthAfterCorrection,
      replayedOutsideGuard: g._replaying,
    };
  });
  if (grenadeCorrection.tookDamageFirstRun) ok('the grenade detonates on schedule and damages the bystander (test precondition)');
  else bad('the grenade detonates on schedule and damages the bystander (test precondition)',
    'health never dropped on the first, unreplayed run — the scenario below proves nothing');
  if (grenadeCorrection.corrected) ok('reconcile() actually triggered a correction (test precondition)');
  else bad('reconcile() actually triggered a correction (test precondition)', '_correct() never ran — the rewind/replay below never happened');
  if (grenadeCorrection.replayingDuringDetonation === true) {
    ok('_detonate re-ran during the replay with game._replaying set (the guard was reached, not skipped)');
  } else {
    bad('_detonate re-ran during the replay with game._replaying set',
      `game._replaying was ${grenadeCorrection.replayingDuringDetonation} when _detonate ran during replay — either the rewind did not put the grenade back in flight to re-detonate, or the flag was not set the second time`);
  }
  if (!grenadeCorrection.doubleDamaged) {
    ok(`the game._replaying guard prevented double damage (bystander health stayed at ${grenadeCorrection.healthAfterCorrection} through the correction)`);
  } else {
    bad('the game._replaying guard prevented double damage',
      `bystander health dropped again on correction: ${grenadeCorrection.healthAfterFirstDetonation} -> ${grenadeCorrection.healthAfterCorrection} — the same detonation applied blast damage twice`);
  }
  if (grenadeCorrection.projectileGone) ok('the projectile pool slot was freed by the first detonation');
  else bad('the projectile pool slot was freed by the first detonation', 'a slot was still active after the fuse should have expired');
  if (!grenadeCorrection.replayedOutsideGuard) ok('game._replaying is false again once the correction finishes');
  else bad('game._replaying is false again once the correction finishes', 'the flag leaked true past _correct()\'s finally block');

  // ── the browser and the server build the same map ────────────────────────────────
  //
  // The check Phase 4 actually needs, and the only one that can make it: everything else
  // compares two builds inside ONE process, where module-level state, the THREE instance
  // and the JIT are all shared. A server whose colliders differ from its clients' by a
  // millimetre produces shots that hit on one machine and miss on the other, with nothing
  // in any log.
  //
  // This side digests the real browser build; scripts/headless.mjs writes the Node
  // colliders-only digest to the same file, and whichever runs second compares.
  console.log('\nbrowser and headless builds agree on the map');
  const browserDigest = await page.evaluate(() => {
    const g = window.__GAME__;
    const parts = [];
    for (const b of g.world.boxes) {
      parts.push(`${b.min.x},${b.min.y},${b.min.z},${b.max.x},${b.max.y},${b.max.z},${b.surface}`);
    }
    parts.push('|');
    for (const sp of g.world.spawnPoints) {
      parts.push(`${sp.position.x},${sp.position.y},${sp.position.z},${sp.yaw},${sp.team ?? '-'}`);
    }
    return { digest: parts.join(';'), boxes: g.world.boxes.length, spawns: g.world.spawnPoints.length };
  });
  {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const file = pathMod.join(os.tmpdir(), 'overstrike-collider-digest.json');
    let peer = null;
    try { peer = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first to run */ }
    fs.writeFileSync(file, JSON.stringify({ from: 'browser', ...browserDigest }));

    if (!peer || peer.from === 'browser') {
      // Not a failure: run `npm run headless` and this suite in either order and the
      // second one compares. Say so rather than passing silently.
      console.log(`  --   no headless digest to compare against yet (${browserDigest.boxes} boxes here);`);
      console.log('       run `npm run headless` then re-run this suite to close the loop');
    } else if (peer.digest === browserDigest.digest) {
      ok(`browser and headless builds are byte-identical (${browserDigest.boxes} boxes, ${browserDigest.spawns} spawns)`);
    } else {
      const a = browserDigest.digest.split(';'), c = peer.digest.split(';');
      let at = 'length only';
      for (let i = 0; i < Math.max(a.length, c.length); i++) {
        if (a[i] !== c[i]) { at = `entry ${i}:\n         browser:  ${a[i]}\n         headless: ${c[i]}`; break; }
      }
      bad('browser and headless builds are byte-identical',
        `${a.length} vs ${c.length} entries — a shot would hit on one machine and miss on the other.\n       ${at}`);
    }
  }

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
    //
    // ALL of it, not just punch. Punch was the only term zeroed, and the omission was
    // live: the worst disagreement this block ever reported landed on tick 0 or 1, and
    // it was shake left over from the 8-bot replay above (shakeAmp 0.90 on a failing
    // run, 0.25 on a passing one). That made the tolerance a measure of how close the
    // last grenade of the previous block went off, so any change to bot behaviour could
    // fail a test about the player's eye. Zeroing is the right answer rather than a
    // looser bound: a genuine eye term leaking onto the camera still shows, because the
    // probe runs 1500 more ticks after this.
    g.player.camera.punch = 0; g.player.camera.punchVel = 0;
    g.player.camera.shakeAmp = 0; g.player.camera.shakeTime = 0;
    g.player.camera.bobAmp = 0;
    g.player.camera.lagYaw = 0; g.player.camera.lagPitch = 0;
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
