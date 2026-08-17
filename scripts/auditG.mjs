/**
 * AUDIT G — targeted probes for specific suspected defects.
 *
 *  1. one melee keypress is handled by TWO systems (player._melee and
 *     weaponSystem.meleeAttack) — does it apply damage twice?
 *  2. same question for the grenade key.
 *  3. does player._melee() consult the shared damage gate (spawn protection,
 *     pre-round freeze) the way ballistics does?
 *  4. startMatch({ botCount }) — is the option honoured?
 *  5. FFA scoreboard actually renders rows.
 *  6. cross-match retention of entity references by killstreak hardware / spawner.
 *  7. progression's per-weapon table growth.
 *  8. minimap contacts while the radar is not being drawn.
 */
import { boot } from './auditlib.mjs';

const h = await boot({ port: 5321, viewport: { width: 800, height: 600 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], data: {} };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };
  /**
   * Press an action for exactly one rendered frame, the way the real loop does it:
   * frame++, then the substeps, then input.endFrame().
   * The frame counter matters — Player._pumpLook latches its edges once per `game.frame`.
   */
  const press = (action, steps = 1) => {
    g.input.pressed.add(action);
    g.input.actions.add(action);
    g.frame++;
    for (let i = 0; i < steps; i++) g._fixedUpdate(1 / 120);
    g.input.endFrame();
    g.input.actions.delete(action);
  };
  /** Put a live enemy right in front of the player, facing them. */
  const stageMeleeTarget = () => {
    const p = g.player;
    p.alive = true; p.health = p.maxHealth;
    const foe = g.bots.bots.find((b) => g.match.areEnemies(p, b)) || g.bots.bots[0];
    foe.alive = true; foe.health = 500; foe.maxHealth = 500; foe.armor = 0;
    p.yaw = 0; p.pitch = 0;                       // facing -Z
    foe.position.set(p.position.x, p.position.y, p.position.z - 1.3);
    foe.velocity.set(0, 0, 0);
    g.match.clearProtection(foe);
    g.match.clearProtection(p);
    p._meleeReadyAt = -999;
    g.weapons._meleeTimer = 0;
    g.weapons._meleeEntity = null;
    g.weapons._meleePending = null;
    return foe;
  };

  // ══════════════════════════════════════ 1. double melee
  g.settings.set('botCount', 6);
  g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 21 });
  sim(600);
  {
    const foe = stageMeleeTarget();
    const events = [];
    const off = g.bus.on('damage', (p) => {
      if (p.target === foe) events.push({ amount: +p.amount.toFixed(1), weaponId: p.weaponId, attacker: p.attacker === g.player ? 'player' : String(p.attacker?.name) });
    });
    const hp0 = foe.health;
    press('melee');
    sim(120);                                    // let the windup-scheduled hit land
    off();
    R.data.doubleMelee = {
      damageEvents: events,
      hpLost: +(hp0 - foe.health).toFixed(1),
      meleeDamageTune: 135,
    };
    ok('melee:appliedOnce', events.length <= 1,
      `one melee press produced ${events.length} damage events (${events.map((e) => `${e.amount}/${e.weaponId}`).join(' + ')}) for ${R.data.doubleMelee.hpLost} total HP`);
  }

  // ══════════════════════════════════════ 2. double grenade
  {
    const p = g.player;
    p.alive = true; p.health = p.maxHealth;
    p._grenadeReadyAt = -999;
    const lo = g.weapons.getLoadout(p);
    const before = { playerGrenades: p.grenades, lethalCount: lo?.equipment.lethalCount };
    let thrownEvents = 0;
    const off = g.bus.on('grenadeThrow', () => thrownEvents++);
    const liveBefore = g.projectiles.activeCount ?? g.projectiles._live?.length ?? null;
    press('grenade');
    const liveAfter = g.projectiles.activeCount ?? g.projectiles._live?.length ?? null;
    off();
    R.data.doubleGrenade = {
      before,
      after: { playerGrenades: p.grenades, lethalCount: lo?.equipment.lethalCount },
      grenadeThrowEvents: thrownEvents,
      projectilesLiveBefore: liveBefore, projectilesLiveAfter: liveAfter,
    };
    const spent = (before.playerGrenades - p.grenades) + (before.lethalCount - (lo?.equipment.lethalCount ?? 0));
    R.data.doubleGrenade.totalCountersDecremented = spent;
    ok('grenade:thrownOnce', spent <= 1,
      `one grenade press decremented ${spent} counters (player.grenades ${before.playerGrenades}->${p.grenades}, loadout.lethalCount ${before.lethalCount}->${lo?.equipment.lethalCount}); live projectiles ${liveBefore}->${liveAfter}`);
    sim(600);
  }

  // ══════════════════════════════════════ 3. melee vs the shared damage gate
  {
    // (a) during the pre-round countdown, when match.canFire() is false for everyone
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 22 });
    sim(30);                                     // still in countdown
    const phase = g.match.phase;
    const foe = stageMeleeTarget();
    const hp0 = foe.health;
    press('melee');
    sim(120);
    const frozenDamage = +(hp0 - foe.health).toFixed(1);

    // (b) against a spawn-protected enemy
    sim(600);                                    // go live
    const foe2 = stageMeleeTarget();
    g.bus.emit('spawn', { entity: foe2 });       // grants spawn protection
    const protectedNow = g.match.isProtected(foe2);
    const hp1 = foe2.health;
    g.player._meleeReadyAt = -999;
    g.weapons._meleeTimer = 0;
    press('melee');
    sim(120);
    const protectedDamage = +(hp1 - foe2.health).toFixed(1);

    R.data.meleeGate = { phase, frozenDamage, protectedNow, protectedDamage };
    ok('melee:respectsPreRoundFreeze', frozenDamage === 0,
      `melee during phase='${phase}' dealt ${frozenDamage} damage (ballistics would deal 0)`);
    ok('melee:respectsSpawnProtection', protectedDamage === 0,
      `melee on a spawn-protected enemy (isProtected=${protectedNow}) dealt ${protectedDamage} damage`);
  }

  // ══════════════════════════════════════ 4. startMatch({ botCount })
  {
    g.settings.set('botCount', 7);
    g.startMatch({ mode: 'tdm', botCount: 16, difficulty: 'regular', seed: 23 });
    const roster16 = g.bots.bots.length;
    g.startMatch({ mode: 'tdm', botCount: 2, difficulty: 'regular', seed: 24 });
    const roster2 = g.bots.bots.length;
    R.data.botCountOption = {
      settingsBotCount: g.settings.get('botCount'),
      requested16: roster16, requested2: roster2,
      matchBotCount: g.match.botCount,
      botManagerHasSetCount: typeof g.bots.setCount,
    };
    ok('startMatch:botCountHonoured', roster16 === 16 && roster2 === 2,
      `settings.botCount=7; startMatch({botCount:16}) -> ${roster16} bots, startMatch({botCount:2}) -> ${roster2} bots; match.botCount=${g.match.botCount}; typeof bots.setCount=${typeof g.bots.setCount}`);
  }

  // ══════════════════════════════════════ 5. FFA scoreboard renders
  {
    g.settings.set('botCount', 7);
    g.startMatch({ mode: 'ffa', botCount: 7, difficulty: 'regular', seed: 25 });
    sim(600 + 120 * 10);
    const sb = g.hud.scoreboard;
    sb.setVisible(true);
    sb.refresh();
    const shown = sb.columns.map((c) => c.rows.filter((r) => r.shown).length);
    R.data.ffaScoreboard = {
      teams: g.entities.map((e) => e.team),
      rows: g.match.getScoreboardRows().length,
      shownPerColumn: shown,
      domRows: document.querySelectorAll('.sb .sb-col .row, .sb .row').length,
    };
    sb.setVisible(false);
    ok('ffaScoreboard:rendersEveryone', shown[0] + shown[1] === g.match.getScoreboardRows().length,
      `${g.match.getScoreboardRows().length} rows in the book, ${shown[0]}+${shown[1]} rendered`);
  }

  // ══════════════════════════════════════ 6. cross-match entity retention
  {
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 26 });
    sim(600);
    // Force the player onto a killstreak and deploy it.
    const ks = g.match.killstreaks;
    for (let i = 0; i < 12; i++) {
      const foe = g.bots.bots.find((b) => b.alive && g.match.areEnemies(g.player, b));
      if (foe) foe.die({ attacker: g.player, weaponId: 'ar_vector' });
      sim(60);
    }
    g.match.useKillstreak(g.player);
    sim(120 * 5);
    const deployed = {
      sentries: ks._sentries?.filter((s) => s.active).length ?? null,
      choppers: ks._choppers?.filter((c) => c.active).length ?? null,
      strikes: ks._strikes?.filter((s) => s.active).length ?? null,
    };
    const oldPlayer = g.player;
    const oldBots = new Set(g.bots.bots);
    g.returnToMenu();
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 27 });
    sim(120);
    const holdsOld = [];
    const check = (label, ref) => {
      if (!ref) return;
      if (ref === oldPlayer || oldBots.has(ref)) holdsOld.push(`${label} -> ${ref.name ?? 'player'}`);
    };
    for (const [i, s] of (ks._sentries ?? []).entries()) { check(`sentry[${i}].ownerEntity`, s.ownerEntity); check(`sentry[${i}].target`, s.target); }
    for (const [i, c] of (ks._choppers ?? []).entries()) { check(`chopper[${i}].ownerEntity`, c.ownerEntity); check(`chopper[${i}].target`, c.target); }
    for (const [i, s] of (ks._strikes ?? []).entries()) check(`strike[${i}].attacker`, s.attacker);
    const sp = g.match.spawner;
    for (const [i, e] of (sp?._enemies ?? []).entries()) check(`spawner._enemies[${i}]`, e);
    for (const [i, e] of (sp?._friends ?? []).entries()) check(`spawner._friends[${i}]`, e);
    R.data.crossMatchRetention = { deployed, holdsOld, botsAreSameObjects: g.bots.bots.some((b) => oldBots.has(b)) };
    ok('reset:noStaleEntityRefs', holdsOld.length === 0,
      holdsOld.length ? `after a restart these still point at the previous match's entities: ${holdsOld.join(', ')}` : 'no stale entity references');
  }

  // ══════════════════ 6b. roster SHRINK — disposed bots must not stay referenced
  {
    g.settings.set('botCount', 16);
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 61 });
    sim(600 + 120 * 10);
    const bigRoster = new Set(g.bots.bots);
    const bigCount = g.bots.bots.length;
    g.returnToMenu();
    g.settings.set('botCount', 4);
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 62 });
    sim(240);
    const stillAlive = new Set(g.bots.bots);
    const disposed = [...bigRoster].filter((b) => !stillAlive.has(b));
    const held = [];
    const sp = g.match.spawner;
    const ks = g.match.killstreaks;
    const scan = (label, arr) => {
      for (const [i, e] of (arr ?? []).entries()) if (disposed.includes(e)) held.push(`${label}[${i}]=${e.name}`);
    };
    scan('spawner._enemies', sp?._enemies);
    scan('spawner._friends', sp?._friends);
    for (const [i, s] of (ks?._sentries ?? []).entries()) {
      if (disposed.includes(s.ownerEntity)) held.push(`sentry[${i}].ownerEntity`);
      if (disposed.includes(s.target)) held.push(`sentry[${i}].target`);
    }
    // Anything in the match book that is no longer on the roster?
    const bookStale = [...g.match._book.values()].filter((s) => disposed.includes(s.entity)).length;
    R.data.rosterShrink = {
      bigCount, smallCount: g.bots.bots.length, disposedCount: disposed.length,
      heldByOtherSystems: held, staleBookRows: bookStale,
      disposedStillInScene: disposed.filter((b) => b.model?.group?.parent).length,
    };
    ok('rosterShrink:disposedBotsReleased', held.length === 0 && bookStale === 0,
      `shrinking ${bigCount} -> ${g.bots.bots.length} bots disposed ${disposed.length}; still referenced by: ${held.join(', ') || 'nothing'}; stale book rows: ${bookStale}`);
  }

  // ══════════════════════════════════════ 7. progression weapon-row growth
  {
    const prog = (await import('/src/game/progression.js')).progression;
    const rows0 = Object.keys(prog.data.weapons ?? {}).length;
    for (let i = 0; i < 250; i++) {
      prog.recordMatch({
        kills: 1, deaths: 0, assists: 0, headshots: 0, longshots: 0, shotsFired: 1, shotsHit: 1,
        score: 1, longestShot: 1, bestStreak: 1, streaksEarned: 0, captures: 0, defends: 0,
        confirms: 0, denies: 0, durationSec: 1, result: 'win',
        weapons: { [`bogus_weapon_${i}`]: { kills: 1, headshots: 0, shotsFired: 1, shotsHit: 1 } },
      });
    }
    const rows1 = Object.keys(prog.data.weapons ?? {}).length;
    let bytes = 0;
    try { bytes = (localStorage.getItem('overstrike.progress.v1') || '').length; } catch { /* ignore */ }
    R.data.progressionRows = { before: rows0, after: rows1, storedBytes: bytes };
    ok('progression:weaponTableBounded', rows1 - rows0 < 250,
      `250 matches reporting unknown weapon ids grew the saved weapon table from ${rows0} to ${rows1} rows (${bytes} bytes in localStorage)`);
  }

  // ══════════════════════════════════════ 8. minimap contacts while hidden
  {
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 28 });
    sim(600);
    const mm = g.hud.minimap;
    mm.reset();
    mm._visible = false;                      // radar hidden (settings.showMinimap = false)
    const before = mm.contacts.size;
    for (let i = 0; i < 120 * 40; i++) {
      g._fixedUpdate(1 / 120);
      if (i % 400 === 0) g._update(1 / 60);
    }
    const after = mm.contacts.size;
    // Aging only happens inside draw(); with the radar hidden nothing ages out.
    R.data.minimapContacts = { before, after, visible: mm._visible, entities: g.entities.length };
    ok('minimap:contactsAgeOutWhenHidden', after <= g.entities.length + 8,
      `${after} contacts held after 40 s with the radar hidden (bounded by ${g.entities.length} entities + 8 explosion slots)`);
  }

  return R;
});

console.log('\n=========== AUDIT G — TARGETED ===========');
let fails = 0;
for (const c of out.checks) { if (!c.pass) fails++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`); }
console.log(`\n  ${out.checks.length - fails}/${out.checks.length} passed`);
console.log('\ndata:', JSON.stringify(out.data, null, 1));
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 12));
if (h.consoleErrors.length) console.log('\nconsole errors:', [...new Set(h.consoleErrors)].slice(0, 12));

await h.close();
