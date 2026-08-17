/**
 * THROWAWAY REVIEW PROBE — CLAIM 6 (voice stealing).
 * Drives the real AudioEngine.play()/_reserveVoice() through mock Web Audio.
 */
import { makeEngine, DUR } from './review_voiceharness.mjs';

const FRAME = 1 / 120;

function banner(t) { console.log('\n=== ' + t + ' ' + '='.repeat(Math.max(0, 66 - t.length))); }

/* ---------------------------------------------------------------- *
 * T1 — does a heavy firefight starve critical sounds?
 * ---------------------------------------------------------------- */
async function t1() {
  banner('T1  firefight saturation -> are critical sounds refused?');
  const { eng, ctx, game } = await makeEngine();
  const NBOTS = 12;
  const RPM = 700;                       // shots/min per bot
  const shotEvery = 60 / RPM;
  const SIM = 6.0;

  const nextShot = new Array(NBOTS).fill(0).map((_, i) => i * shotEvery / NBOTS);
  let granted = 0, refused = 0;
  const crit = {};
  const bump = (n, ok) => { crit[n] = crit[n] || { ok: 0, no: 0 }; crit[n][ok ? 'ok' : 'no']++; };

  let nextHit = 0.4, nextFoot = 0.05, nextWhiz = 0.2, nextKill = 1.0, nextImpact = 0.0;
  let liveMax = 0, youngRefusals = 0;

  for (let step = 0; ctx.currentTime < SIM; step++) {
    ctx.advance(FRAME);
    game.frame = step;
    ctx.flushEnded();          // main thread dispatches ended promptly
    const now = ctx.currentTime;

    // bot rifles, spread around the map (positional)
    for (let b = 0; b < NBOTS; b++) {
      while (nextShot[b] <= now) {
        nextShot[b] += shotEvery;
        const pos = { x: 5 + b * 3, y: 1.6, z: 10 + (b % 4) * 4 };
        const v = eng.play('rifle', { position: pos, volume: 1 });
        if (v) granted++; else refused++;
      }
    }
    // impacts from those rounds (cooldown 0.03 gates them anyway)
    while (nextImpact <= now) {
      nextImpact += 0.03;
      eng.play('impactConcrete', { position: { x: 2, y: 1, z: 4 } });
    }
    while (nextWhiz <= now) { nextWhiz += 0.05; eng.play('whizby', { position: { x: 0.5, y: 1.6, z: 0.5 } }); }
    while (nextFoot <= now) { nextFoot += 0.28; eng.play('footstepConcrete', { position: { x: 0, y: 0, z: 0 } }); }

    // ---- the critical player-feedback sounds ----
    while (nextHit <= now) {
      nextHit += 0.09;                       // player landing hits at ~11/s (SMG on target)
      bump('hitmarker', !!eng.hitmarker(false));
    }
    while (nextKill <= now) {
      nextKill += 1.3;
      bump('killConfirm', !!eng.playUI('killConfirm', { volume: 0.9 }));
      bump('death', !!eng.play('death', { position: { x: 8, y: 0, z: 12 } }));
    }
    // count live + whether the "no victim" branch is what refuses
    let live = 0, young = 0;
    for (const v of eng.voices) { if (v.stopping || v.done) continue; live++; if (now - v.startedAt < 0.15) young++; }
    if (live > liveMax) liveMax = live;
    if (live >= 28 && young === live) youngRefusals++;
  }

  console.log(`rifle plays: granted=${granted} refused=${refused}`);
  console.log(`peak live voices: ${liveMax}`);
  console.log(`frames where ALL 28 live voices were < MIN_STEAL_AGE (total refusal): ${youngRefusals}`);
  for (const [k, v] of Object.entries(crit)) {
    console.log(`  ${k.padEnd(14)} played=${v.ok} DROPPED=${v.no}`);
  }
  return crit;
}

/* ---------------------------------------------------------------- *
 * T2 — force the "everything is young" state deliberately.
 * ---------------------------------------------------------------- */
async function t2() {
  banner('T2  28 voices started in one frame -> next 150 ms of plays');
  const { eng, ctx, game } = await makeEngine();
  ctx.advance(0.001);
  // 28 rifle voices in a single frame (shotgun blast + a wall of bots)
  let n = 0;
  for (let i = 0; i < 40; i++) if (eng.play('rifle', { position: { x: i, y: 1, z: 1 } })) n++;
  console.log(`voices started in one frame: ${n} (MAX_VOICES=28)`);

  const results = [];
  for (const dt of [0.005, 0.05, 0.10, 0.149, 0.16]) {
    const { eng: e2, ctx: c2 } = await makeEngine();
    c2.advance(0.001);
    for (let i = 0; i < 40; i++) e2.play('rifle', { position: { x: i, y: 1, z: 1 } });
    c2.advance(dt);
    c2.flushEnded();
    const hm = e2.hitmarker(false);
    const kc = e2.playUI('killConfirm', {});
    const ex = e2.play('explosion', { position: { x: 1, y: 1, z: 1 }, priority: 100 });
    const de = e2.play('death', { position: { x: 1, y: 1, z: 1 } });
    results.push({ tPlusMs: Math.round(dt * 1000), hitmarker: !!hm, killConfirm: !!kc, explosion: !!ex, death: !!de });
  }
  console.table(results);
  return results;
}

/* ---------------------------------------------------------------- *
 * T3 — deadlock check: does it ever recover?
 * ---------------------------------------------------------------- */
async function t3() {
  banner('T3  deadlock probe — sustained 500 plays/s for 10 s');
  const { eng, ctx, game } = await makeEngine();
  let granted = 0, refused = 0, longestRefusalRun = 0, run = 0;
  let acc = 0;
  for (let step = 0; ctx.currentTime < 10; step++) {
    ctx.advance(FRAME); ctx.flushEnded();
    acc += FRAME * 500;
    while (acc >= 1) {
      acc -= 1;
      const v = eng.play('rifle', { position: { x: Math.random() * 40, y: 1, z: 1 } });
      if (v) { granted++; if (run > longestRefusalRun) longestRefusalRun = run; run = 0; }
      else { refused++; run++; }
    }
  }
  console.log(`granted=${granted} refused=${refused} (${(100 * refused / (granted + refused)).toFixed(1)}% refused)`);
  console.log(`longest consecutive refusal run: ${longestRefusalRun}`);
  console.log(`live voices at end: ${eng.voices.filter((v) => !v.done && !v.stopping).length}`);
  console.log(`=> pool recovers: ${granted > 0 ? 'YES (no permanent deadlock)' : 'NO — DEADLOCK'}`);
}

/* ---------------------------------------------------------------- *
 * T4 — VOICE_LIMIT explosion=6.
 * ---------------------------------------------------------------- */
async function t4() {
  banner('T4  VOICE_LIMIT explosion=6 with real 1.77 s buffers');
  const { eng, ctx } = await makeEngine();
  ctx.advance(0.001);
  const log = [];
  // 8 explosions spread over 2 s (grenade fight / airstrike run)
  for (let i = 0; i < 8; i++) {
    const v = eng.play('explosion', { position: { x: 3 * i, y: 1, z: 5 }, priority: 100 });
    log.push({ i, t: ctx.currentTime.toFixed(3), played: !!v });
    for (let f = 0; f < 30; f++) { ctx.advance(FRAME); ctx.flushEnded(); }   // 0.25 s apart
  }
  console.table(log);

  banner('T4b  flashbang/smoke rate-0.35 explosion vs later real explosions');
  const { eng: e2, ctx: c2 } = await makeEngine();
  c2.advance(0.001);
  const out = [];
  for (let i = 0; i < 6; i++) {
    e2.play('explosion', { position: { x: 1, y: 1, z: 1 }, volume: 0.35, rate: 0.4 });
    for (let f = 0; f < 6; f++) { c2.advance(FRAME); c2.flushEnded(); }
  }
  // 6 x smoke pops at rate 0.4 => each ~4.4 s long. Now a real grenade goes off.
  for (let s = 0; s < 12; s++) {
    const v = e2.play('explosion', { position: { x: 2, y: 1, z: 2 }, priority: 100, volume: 1 });
    out.push({ tSec: +c2.currentTime.toFixed(2), realExplosionPlayed: !!v });
    for (let f = 0; f < 60; f++) { c2.advance(FRAME); c2.flushEnded(); }
  }
  console.table(out);
}

/* ---------------------------------------------------------------- *
 * T5 — delayed voices (whizby / magIn) stolen before they sound.
 * ---------------------------------------------------------------- */
async function t5() {
  banner('T5  delay: startedAt vs `when` — can a voice be killed before it sounds?');
  const { eng, ctx } = await makeEngine();
  ctx.advance(0.001);
  const v = eng.play('magIn', { position: { x: 0, y: 0, z: 0 }, delay: 1.16 });   // reloadTime 2.1 * 0.55
  console.log('scheduled magIn: startedAt=%s  src.start(when)=%s  defendUntil=%s  endsAt=%s',
    v.startedAt.toFixed(3), v.src._startAt.toFixed(3), v.defendUntil.toFixed(3), v.endsAt.toFixed(3));
  console.log('age used by MIN_STEAL_AGE is (now - startedAt), NOT (now - when).');

  // Fill the pool and let 150 ms pass, then hammer it.
  for (let i = 0; i < 40; i++) eng.play('rifle', { position: { x: i, y: 1, z: 1 } });
  for (let f = 0; f < 30; f++) { ctx.advance(FRAME); ctx.flushEnded(); }   // t = 0.25
  console.log('t=%s  magIn stopping=%s done=%s', ctx.currentTime.toFixed(3), v.stopping, v.done);
  if (v.src) {
    console.log('magIn src: startAt=%s stopAt=%s  -> plays? %s',
      v.src._startAt.toFixed(3), v.src._stopAt == null ? 'n/a' : v.src._stopAt.toFixed(3),
      v.src._stopAt != null && v.src._stopAt <= v.src._startAt ? 'NO — silently dropped' : 'yes');
  } else {
    console.log('magIn voice already released; it was stolen before its scheduled start.');
  }

  // Direct check with a forced steal
  const { eng: e2, ctx: c2 } = await makeEngine();
  c2.advance(0.001);
  const w = e2.play('whizby', { position: { x: 0, y: 1, z: 0 }, delay: 0.6 });
  c2.advance(0.2); c2.flushEnded();
  e2._stopVoice(w, 0.012);
  console.log('forced steal at t=0.2 of a whizby scheduled for t=0.6:');
  console.log('  src.start=%s  src.stop=%s  -> %s',
    w.src._startAt.toFixed(3), w.src._stopAt.toFixed(3),
    w.src._stopAt <= w.src._startAt ? 'STOP <= START: source never produces sound' : 'audible');
}

/* ---------------------------------------------------------------- *
 * T6 — HRTF budget leak / accounting.
 * ---------------------------------------------------------------- */
async function t6() {
  banner('T6  _hrtfVoices accounting');
  const { eng, ctx } = await makeEngine();
  ctx.advance(0.001);
  for (let i = 0; i < 12; i++) eng.play('rifle', { position: { x: 1, y: 1, z: 1 } });
  console.log(`after 12 near plays: _hrtfVoices=${eng._hrtfVoices} (HRTF_MAX_VOICES=8), HRTF panners built=${ctx.hrtfCreated}, equalpower=${ctx.equalCreated}`);
  for (let f = 0; f < 200; f++) { ctx.advance(FRAME); ctx.flushEnded(); }
  console.log(`after all ended: _hrtfVoices=${eng._hrtfVoices}  voices=${eng.voices.length}  pool=${eng._pool.length}`);

  // suspend mid-flight
  const { eng: e2, ctx: c2 } = await makeEngine();
  c2.advance(0.001);
  for (let i = 0; i < 8; i++) e2.play('rifle', { position: { x: 1, y: 1, z: 1 } });
  e2.stopAll();
  c2.suspend();
  for (let f = 0; f < 600; f++) { c2.advance(FRAME); c2.flushEnded(); e2.update(FRAME); }
  console.log(`suspended for 5 s after stopAll(): _hrtfVoices=${e2._hrtfVoices} live=${e2.voices.length}`);
  c2.resume();
  for (let f = 0; f < 60; f++) { c2.advance(FRAME); c2.flushEnded(); e2.update(FRAME); }
  console.log(`after resume: _hrtfVoices=${e2._hrtfVoices} live=${e2.voices.length}`);

  // context recreated while voices live (resume() after a close)
  const { eng: e3, ctx: c3 } = await makeEngine();
  c3.advance(0.001);
  for (let i = 0; i < 8; i++) e3.play('rifle', { position: { x: 1, y: 1, z: 1 } });
  console.log(`before ctx swap: _hrtfVoices=${e3._hrtfVoices} voices=${e3.voices.length}`);
  e3.ctx = null;                       // simulate the old ctx vanishing without ended firing
  e3._hrtfVoices = 0;                  // what _createContext() does
  for (const s of c3.pending.slice()) { if (s.onended) s.onended(); }
  console.log(`after old sources' ended fires post-swap: _hrtfVoices=${e3._hrtfVoices} (clamped at 0? ${e3._hrtfVoices >= 0})`);
}

/* ---------------------------------------------------------------- *
 * T7 — stale voice accounting: does a finished voice hold a slot?
 * ---------------------------------------------------------------- */
async function t7() {
  banner('T7  starved `ended` dispatch -> do finished voices hold slots?');
  const { eng, ctx } = await makeEngine();
  ctx.advance(0.001);
  for (let i = 0; i < 28; i++) eng.play('uiHover', {});   // 18 ms buffers
  ctx.advance(0.25);                                       // all long finished
  // main thread was busy: no flushEnded()
  let live = 0;
  eng._now = ctx.currentTime;
  eng._pruneVoices();
  for (const v of eng.voices) if (!v.done && !v.stopping) live++;
  console.log(`18 ms voices, 250 ms later, ended never dispatched: live=${live} (prune floor = endsAt+0.25)`);
  const got = eng.hitmarker(false);
  console.log(`hitmarker while those 28 corpses hold slots: ${got ? 'played' : 'DROPPED'}`);
  ctx.advance(0.2); eng._now = ctx.currentTime; eng._pruneVoices();
  console.log(`after another 200 ms of prune: live=${eng.voices.filter((v) => !v.done && !v.stopping).length}`);
}

await t1();
await t2();
await t3();
await t4();
await t5();
await t6();
await t7();
