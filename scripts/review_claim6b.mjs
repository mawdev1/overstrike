/** THROWAWAY REVIEW PROBE — CLAIM 6, part 2: refusal reasons + realistic saturation. */
import { makeEngine, DUR } from './review_voiceharness.mjs';

const FRAME = 1 / 120;
const MIN_STEAL_AGE = 0.15;
const MAX_VOICES = 28;

/** Re-derive why a refusal happened, using the same rules the engine uses. */
function refusalReason(eng, name, priority, now) {
  const VOICE_LIMIT = { explosion: 6 };
  const limit = VOICE_LIMIT[name] || 0;
  let live = 0, victim = null, worst = Infinity, worstStart = Infinity, sameName = 0, oldestSameStart = Infinity, oldestSame = null;
  for (const v of eng.voices) {
    if (v.stopping || v.done) continue;
    live++;
    if (limit && v.name === name) { sameName++; if (v.startedAt < oldestSameStart) { oldestSameStart = v.startedAt; oldestSame = v; } }
    if (now - v.startedAt < MIN_STEAL_AGE) continue;
    const lapsed = now >= v.defendUntil;
    const eff = lapsed ? v.priority * 0.25 : v.priority;
    if (eff < worst || (eff === worst && v.startedAt < worstStart)) { worst = eff; worstStart = v.startedAt; victim = v; }
  }
  if (limit && sameName >= limit) return (!oldestSame || now - oldestSameStart < MIN_STEAL_AGE) ? 'sameNameYoung' : 'ok';
  if (live < MAX_VOICES) return 'ok';
  if (!victim) return 'ALL_YOUNG(no victim)';
  if (worst > priority) return 'outranked';
  return 'ok';
}

function banner(t) { console.log('\n=== ' + t + ' ' + '='.repeat(Math.max(0, 70 - t.length))); }

/* Heavy but plausible: 12 bots on SMGs (1200 rpm) + player shotgun + impacts. */
async function heavy(label, opts) {
  const { eng, ctx, game } = await makeEngine();
  const NBOTS = opts.bots, RPM = opts.rpm, SIM = 8;
  const shotEvery = 60 / RPM;
  const next = new Array(NBOTS).fill(0).map((_, i) => (i * shotEvery) / NBOTS);
  const stats = { granted: 0, refused: 0, reasons: {} };
  const crit = {};
  const note = (n, ok, reason) => {
    crit[n] = crit[n] || { ok: 0, no: 0, why: {} };
    if (ok) crit[n].ok++; else { crit[n].no++; crit[n].why[reason] = (crit[n].why[reason] || 0) + 1; }
  };
  let nextHit = 0.31, nextFoot = 0.05, nextWhiz = 0.2, nextKill = 1.0, nextImp = 0, nextPellet = 0.5, nextFlesh = 0.11;
  let allYoungFrames = 0, satFrames = 0, frames = 0;

  const gun = opts.gun;
  for (let step = 0; ctx.currentTime < SIM; step++) {
    ctx.advance(FRAME); game.frame = step; ctx.flushEnded();
    const now = ctx.currentTime;
    frames++;
    for (let b = 0; b < NBOTS; b++) {
      while (next[b] <= now) {
        next[b] += shotEvery;
        const r = refusalReason(eng, gun, 78, now);
        const v = eng.play(gun, { position: { x: 4 + b * 2.5, y: 1.6, z: 8 + (b % 5) * 3 } });
        if (v) stats.granted++; else { stats.refused++; stats.reasons[r] = (stats.reasons[r] || 0) + 1; }
      }
    }
    while (nextPellet <= now) {   // player shotgun: 8 pellets -> impacts, every 0.9 s
      nextPellet += 0.9;
      eng.play('shotgun', { position: { x: 0, y: 1.6, z: 0 }, self: true });
      for (let p = 0; p < 8; p++) eng.play('impactConcrete', { position: { x: 6 + p, y: 1, z: 9 } });
    }
    while (nextImp <= now) { nextImp += 0.03; eng.play('impactMetal', { position: { x: 3, y: 1, z: 4 } }); }
    while (nextFlesh <= now) { nextFlesh += 0.025; eng.play('fleshHit', { position: { x: 7, y: 1.4, z: 9 } }); }
    while (nextWhiz <= now) { nextWhiz += 0.045; eng.play('whizby', { position: { x: 0.4, y: 1.6, z: 0.4 } }); }
    while (nextFoot <= now) { nextFoot += 0.25; eng.play('footstepConcrete', { position: { x: 0, y: 0, z: 0 } }); }

    while (nextHit <= now) {
      nextHit += 0.09;
      note('hitmarker', !!eng.hitmarker(false), refusalReason(eng, 'hitmarker', 90, now));
    }
    while (nextKill <= now) {
      nextKill += 1.3;
      note('killConfirm', !!eng.playUI('killConfirm', {}), refusalReason(eng, 'killConfirm', 92, now));
      note('death', !!eng.play('death', { position: { x: 8, y: 0, z: 12 } }), refusalReason(eng, 'death', 70, now));
      note('headshot', !!eng.play('headshot', { position: { x: 8, y: 1.6, z: 12 } }), refusalReason(eng, 'headshot', 90, now));
    }
    if (opts.boom && Math.abs(now - 3.0) < FRAME) {
      note('explosion', !!eng.play('explosion', { position: { x: 6, y: 1, z: 8 }, priority: 100 }),
        refusalReason(eng, 'explosion', 100, now));
    }
    let live = 0, young = 0;
    for (const v of eng.voices) { if (v.stopping || v.done) continue; live++; if (now - v.startedAt < MIN_STEAL_AGE) young++; }
    if (live >= MAX_VOICES) satFrames++;
    if (live >= MAX_VOICES && young === live) allYoungFrames++;
  }

  banner(label);
  console.log(`${gun} granted=${stats.granted} refused=${stats.refused} reasons=${JSON.stringify(stats.reasons)}`);
  console.log(`frames at cap: ${satFrames}/${frames}   frames in TOTAL BLACKOUT (all live voices young): ${allYoungFrames}`);
  for (const [k, v] of Object.entries(crit)) {
    console.log(`  ${k.padEnd(13)} played=${String(v.ok).padStart(4)} DROPPED=${String(v.no).padStart(4)}  ${JSON.stringify(v.why)}`);
  }
}

/* T7 redo: stale (finished) voices holding slots when `ended` is starved. */
async function staleSlots() {
  banner('stale-voice accounting: finished voices still counted as live');
  const { eng, ctx } = await makeEngine();
  ctx.advance(0.001);
  const names = ['uiClick', 'uiHover', 'uiBack', 'dryfire', 'hitmarker', 'footstepConcrete', 'jump'];
  let started = 0;
  for (let i = 0; i < 28; i++) {
    const n = names[i % names.length];
    const v = eng.play(n, { position: { x: i, y: 1, z: 1 }, cooldown: 0 });
    if (v) started++;
  }
  console.log(`started ${started} short voices (18-117 ms buffers)`);
  ctx.advance(0.25);                 // everything has long finished sounding
  eng._now = ctx.currentTime;
  eng._pruneVoices();                // main thread never dispatched `ended`
  const live = eng.voices.filter((v) => !v.done && !v.stopping).length;
  console.log(`t=+250 ms, ended never dispatched: live=${live}`);
  console.log(`hitmarker now: ${eng.hitmarker(false) ? 'played' : 'DROPPED'}`);
  ctx.advance(0.2); eng._now = ctx.currentTime; eng._pruneVoices();
  console.log(`t=+450 ms after prune: live=${eng.voices.filter((v) => !v.done && !v.stopping).length}`);
}

/* Silent-but-slot-holding delayed voices (bot magIn, delay = reloadTime*0.55). */
async function delayedHold() {
  banner('delayed voices hold slots while making no sound');
  const { eng, ctx } = await makeEngine();
  ctx.advance(0.001);
  const held = [];
  for (let b = 0; b < 12; b++) {
    const v = eng.play('magIn', { position: { x: b, y: 1, z: 1 }, delay: 2.1 * 0.55 });
    held.push(v);
  }
  const v0 = held[0];
  console.log(`magIn  startedAt=${v0.startedAt.toFixed(3)}  sounds at=${v0.src._startAt.toFixed(3)}  defendUntil=${v0.defendUntil.toFixed(3)}`);
  console.log(`=> holds a slot at priority ${v0.priority} for ${(v0.defendUntil - v0.startedAt).toFixed(3)} s, silent for the first ${(v0.src._startAt - v0.startedAt).toFixed(3)} s`);
  let live = eng.voices.filter((x) => !x.done && !x.stopping).length;
  console.log(`12 bots reloading => ${live} of ${28} slots held by inaudible voices`);
  // now a firefight on top
  let refused = 0, granted = 0;
  for (let i = 0; i < 40; i++) { if (eng.play('rifle', { position: { x: i, y: 1, z: 1 } })) granted++; else refused++; }
  console.log(`rifle plays into the remaining slots: granted=${granted} refused=${refused}`);
}

await heavy('12 bots @1200rpm SMG + shotgun + impacts + whizby', { bots: 12, rpm: 1200, gun: 'smg', boom: true });
await heavy('16 bots @1200rpm SMG (max lobby)', { bots: 16, rpm: 1200, gun: 'smg', boom: true });
await heavy('12 bots @700rpm rifle', { bots: 12, rpm: 700, gun: 'rifle', boom: true });
await staleSlots();
await delayedHold();
