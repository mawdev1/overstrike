/**
 * OVERSTRIKE — recorded sample bank.
 *
 * `synth.js` renders the whole sound bank procedurally, offline, before any user gesture,
 * and that stays the floor the game can never fall below. THIS module is the layer on top:
 * real recordings from `public/audio/**`, fetched and decoded lazily once a live
 * `AudioContext` exists, dropped into the SAME `AudioEngine.buffers` map under the SAME
 * sound names.
 *
 * That one decision buys everything the brief asks for:
 *
 *  - **Graceful degradation is structural, not a branch.** A sound name resolves to
 *    whatever is in `buffers` at the instant it is played. Before the fetch lands, that is
 *    the synth buffer; after, the recording; if the fetch 404s, decodes badly or the player
 *    is offline, the synth buffer is simply never replaced and nobody — including the code
 *    calling `play()` — ever knows. There is no "samples failed" code path to get wrong.
 *  - **Zero sim impact.** Nothing here is imported by anything the headless sim touches;
 *    `AudioEngine` only calls into it from `_createContext()`, which requires `window`.
 *  - **No new call sites.** Weapons, ballistics and the player keep calling
 *    `present.play('rifle')`.
 *
 * Names that exist ONLY as samples (the announcer, the ambience beds, the bomb kit) have no
 * synth twin on purpose: `play()` already returns null for a name it does not have, so the
 * game is merely quieter offline rather than broken.
 *
 * ## Post-processing
 *
 * The recordings are not usable raw:
 *
 *  - They are `.mp3`, so every one of them starts with encoder padding — a few ms of
 *    digital silence in front of the transient. On a gunshot that is latency you can feel.
 *    `shape()` finds the real onset and cuts to it.
 *  - They are generously long. `ar_fire.mp3` is 1.2 s; the synth rifle it replaces is
 *    0.54 s. A 700 rpm rifle starts a shot every ~86 ms, so a 1.2 s buffer means ~14
 *    simultaneous voices from ONE shooter against a 28-voice budget — the tail of shot 1
 *    holding a slot against shot 14. `max` caps each class at roughly the synth's length,
 *    with a fade so the cut is not a click.
 *  - Footstep files are several footfalls in one take. `slice: true` splits them on onsets
 *    into a variant array, which is exactly the shape the engine's per-play random variant
 *    picker already wants, so repeats stop sounding identical.
 *
 * All of it runs once, at decode time, off the audio thread and off the frame path.
 */

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

/**
 * `name` is the ENGINE sound name (`synth.js` names where one already exists).
 *
 *   url    — relative to `public/`
 *   gain   — level trim, applied to the PCM once at decode
 *   max    — hard length cap in seconds (fade-out applied at the cut)
 *   slice  — split on onsets into variants (footsteps)
 *   loop   — an ambience bed: played seamlessly, so never trimmed or capped
 *   raw    — leave the waveform alone (level trim only); for anything musical
 *   tier   — 'core' loads first (combat), 'extra' after (voice, beds, stings)
 *
 * @type {Record<string, {url:string, gain?:number, max?:number, slice?:boolean,
 *   loop?:boolean, tier?:string}>}
 */
export const SAMPLE_MANIFEST = {
  // ── weapons ──────────────────────────────────────────────────────────────────
  rifle: { url: 'audio/sfx/ar_fire.mp3', max: 0.62, gain: 0.9 },
  smg: { url: 'audio/sfx/smg_fire.mp3', max: 0.46, gain: 0.9 },
  lmg: { url: 'audio/sfx/lmg_fire.mp3', max: 0.72, gain: 0.92 },
  sniper: { url: 'audio/sfx/sniper_fire.mp3', max: 1.05, gain: 0.95 },
  dmr: { url: 'audio/sfx/dmr_fire.mp3', max: 0.9, gain: 0.92 },
  shotgun: { url: 'audio/sfx/shotgun_fire.mp3', max: 0.88, gain: 0.95 },
  pistol: { url: 'audio/sfx/pistol_fire.mp3', max: 0.5, gain: 0.88 },
  /** Not a sound anything asks for by name — swapped in by distance, see `audio.js`. */
  gunshotDistant: { url: 'audio/sfx/gunshot_distant.mp3', max: 1.5, gain: 0.85 },

  // ── handling ─────────────────────────────────────────────────────────────────
  boltForward: { url: 'audio/sfx/bolt_cycle.mp3', max: 0.6, gain: 0.8 },
  reloadRifle: { url: 'audio/sfx/reload_rifle.mp3', gain: 0.85 },
  reloadPistol: { url: 'audio/sfx/reload_pistol.mp3', gain: 0.85 },

  // ── ballistics ───────────────────────────────────────────────────────────────
  fleshHit: { url: 'audio/sfx/hit_body.mp3', max: 0.5, gain: 0.9 },
  headshot: { url: 'audio/sfx/hit_headshot.mp3', max: 0.62, gain: 0.95 },
  impactMetal: { url: 'audio/sfx/ricochet.mp3', max: 0.55, gain: 0.8 },
  whizby: { url: 'audio/sfx/bullet_whiz.mp3', max: 0.55, gain: 0.85 },

  // ── movement ─────────────────────────────────────────────────────────────────
  footstepConcrete: { url: 'audio/sfx/footsteps_concrete.mp3', slice: true, gain: 0.7 },
  footstepDirt: { url: 'audio/sfx/footsteps_dirt.mp3', slice: true, gain: 0.7 },

  // ── equipment ────────────────────────────────────────────────────────────────
  pinPull: { url: 'audio/sfx/grenade_throw.mp3', max: 0.7, gain: 0.85 },
  grenadeBounce: { url: 'audio/sfx/grenade_bounce.mp3', max: 0.55, gain: 0.8 },
  flashRing: { url: 'audio/sfx/flashbang_ring.mp3', gain: 0.9, tier: 'extra' },
  smokeHiss: { url: 'audio/sfx/smoke_hiss.mp3', gain: 0.75, tier: 'extra' },

  // ── explosions (LAYERS over the tuned synth blast, never a replacement) ───────
  explosionCore: { url: 'audio/sfx/explosion_core.mp3', gain: 0.9, tier: 'extra' },
  explosionTail: { url: 'audio/sfx/explosion_tail.mp3', gain: 0.8, tier: 'extra' },
  explosionDistant: { url: 'audio/sfx/explosion_distant.mp3', gain: 0.85, tier: 'extra' },

  // ── bomb ─────────────────────────────────────────────────────────────────────
  bombPlant: { url: 'audio/sfx/bomb_plant.mp3', gain: 0.9, tier: 'extra' },
  bombDefuse: { url: 'audio/sfx/bomb_defuse.mp3', gain: 0.9, tier: 'extra' },
  bombBeep: { url: 'audio/sfx/bomb_beep_loop.mp3', gain: 0.7, loop: true, tier: 'extra' },

  // ── UI ───────────────────────────────────────────────────────────────────────
  uiClick: { url: 'audio/sfx/ui_click.mp3', max: 0.3, gain: 0.7 },
  uiHover: { url: 'audio/ui/ui_hover.mp3', max: 0.28, gain: 0.5 },
  uiBack: { url: 'audio/ui/ui_back.mp3', max: 0.5, gain: 0.7 },
  uiConfirm: { url: 'audio/sfx/ui_confirm.mp3', max: 0.8, gain: 0.7 },
  uiEquip: { url: 'audio/ui/ui_equip.mp3', gain: 0.7 },
  uiError: { url: 'audio/ui/ui_error.mp3', gain: 0.7 },
  uiLevelup: { url: 'audio/ui/ui_levelup.mp3', gain: 0.8, tier: 'extra' },
  uiUnlock: { url: 'audio/ui/ui_unlock.mp3', gain: 0.8, tier: 'extra' },
  countdownGo: { url: 'audio/ui/ui_countdown_go.mp3', gain: 0.85, tier: 'extra' },
  /*
   * `ui_match_found`, `ui_deploy` and `ui_countdown_tick` are absent on purpose: all three
   * belong to moments the SHELL owns (matchmaking, the deploy button, the lobby countdown),
   * and the shell plays them from its own context. Loading them here would be dead weight in
   * a bank that only exists once a match does.
   */
  streakReady: { url: 'audio/ui/killstreak_ready.mp3', gain: 0.85, tier: 'extra' },
  killConfirm: { url: 'audio/ui/kill_confirm.mp3', max: 0.5, gain: 0.8 },

  // ── ambience beds ────────────────────────────────────────────────────────────
  ambienceDesert: { url: 'audio/sfx/ambience_desert.mp3', loop: true, gain: 1, tier: 'extra' },
  ambienceCity: { url: 'audio/sfx/ambience_city.mp3', loop: true, gain: 1, tier: 'extra' },
  ambienceMarketHall: { url: 'audio/sfx/ambience_market_hall.mp3', loop: true, gain: 1, tier: 'extra' },
  ambienceRailYard: { url: 'audio/sfx/ambience_rail_yard.mp3', loop: true, gain: 1, tier: 'extra' },

  /*
   * Music, but only the ROUND stings. `menu_theme`, `menu_tension`, `victory_theme` and
   * `defeat_theme` belong to the shell (`ui/shell/audio.js`), which is the thing on screen
   * whenever they play and which stops its own music on the way into a match. Loading them
   * here as well would be 1.1 MB fetched twice and, on a menu, two decoded copies of the
   * same loop running slightly out of phase with each other.
   */
  stingRoundWin: { url: 'audio/music/round_win_sting.mp3', raw: true, gain: 1, tier: 'extra' },
  stingRoundLoss: { url: 'audio/music/round_loss_sting.mp3', raw: true, gain: 1, tier: 'extra' },
};

/** Announcer lines. Same loader, separate table so the queue can own them. */
export const VO_MANIFEST = {
  // `welcome` and `match_found` are the shell's (see `ui/shell/audio.js`) — both are spoken
  // before a match, and therefore before this bank exists.
  voDeploying: 'deploying',
  voRoundStart: 'round_start',
  voMissionLive: 'mission_live',
  voCountdownThree: 'countdown_three',
  voCountdownTwo: 'countdown_two',
  voCountdownOne: 'countdown_one',
  voBombPlanted: 'bomb_planted',
  voBombDefused: 'bomb_defused',
  voTargetDestroyed: 'target_destroyed',
  voBombCarrierDown: 'bomb_carrier_down',
  voAttackersWin: 'attackers_win',
  voDefendersWin: 'defenders_win',
  voVictory: 'victory',
  voDefeat: 'defeat',
  voHalftime: 'halftime',
  voSwitchingSides: 'switching_sides',
  voMatchPoint: 'match_point',
  voOvertime: 'overtime_seconds',
  voThirtySeconds: 'thirty_seconds',
  voLastAlive: 'last_alive',
  voUavOnline: 'uav_online',
  voEnemyUav: 'enemy_uav',
  voDoubleKill: 'double_kill',
  voKillingSpree: 'killing_spree',
  voUnstoppable: 'unstoppable',
};

for (const [name, file] of Object.entries(VO_MANIFEST)) {
  SAMPLE_MANIFEST[name] = { url: `audio/vo/${file}.mp3`, gain: 1, tier: 'vo', vo: true };
}

/** Every announcer sound name — the engine's queue keys off this. */
export const VO_NAMES = new Set(Object.keys(VO_MANIFEST));

/* ------------------------------------------------------------------ *
 * Post-processing
 * ------------------------------------------------------------------ */

/** Anything below this is silence for onset purposes. */
const ONSET_FLOOR = 0.004;
/** Never cut more than this off the front, however quiet the intro is. */
const MAX_LEAD_TRIM = 0.3;
const FADE_OUT = 0.02;

function peakOf(buf) {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = d[i] < 0 ? -d[i] : d[i];
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** First frame at or above `floor` on any channel, searching forward from `from`. */
function firstAbove(buf, floor, from = 0) {
  const n = buf.length;
  for (let i = from; i < n; i++) {
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const v = buf.getChannelData(c)[i];
      if (v > floor || v < -floor) return i;
    }
  }
  return -1;
}

/** Last frame at or above `floor`. */
function lastAbove(buf, floor) {
  for (let i = buf.length - 1; i >= 0; i--) {
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const v = buf.getChannelData(c)[i];
      if (v > floor || v < -floor) return i;
    }
  }
  return -1;
}

/**
 * Copy `[start, end)` out of `src` into a fresh buffer, scaled by `gain` and faded out.
 * `ctx` is only used as an AudioBuffer factory — this never touches the audio thread.
 */
function cut(ctx, src, start, end, gain) {
  const len = Math.max(1, end - start);
  const out = ctx.createBuffer(src.numberOfChannels, len, src.sampleRate);
  const fade = Math.min(len, Math.round(FADE_OUT * src.sampleRate));
  const g = gain == null ? 1 : gain;
  for (let c = 0; c < src.numberOfChannels; c++) {
    const s = src.getChannelData(c);
    const d = out.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = s[start + i] * g;
    for (let i = 0; i < fade; i++) d[len - fade + i] *= 1 - i / fade;
  }
  return out;
}

/**
 * Trim mp3 encoder padding off the front, trailing silence off the back, cap the length,
 * and bake in the level trim. Returns the original buffer untouched if there is nothing
 * worth doing — a copy is only made when it changes something.
 */
export function shape(ctx, buf, spec) {
  const sr = buf.sampleRate;
  let start = firstAbove(buf, ONSET_FLOOR);
  if (start < 0) start = 0;
  const leadCap = Math.round(MAX_LEAD_TRIM * sr);
  if (start > leadCap) start = leadCap;

  let end = lastAbove(buf, ONSET_FLOOR);
  end = end < 0 ? buf.length : Math.min(buf.length, end + Math.round(0.01 * sr) + 1);
  if (spec.max) end = Math.min(end, start + Math.round(spec.max * sr));
  if (end <= start) { start = 0; end = buf.length; }

  const gain = spec.gain == null ? 1 : spec.gain;
  if (start === 0 && end === buf.length && gain === 1) return buf;
  return cut(ctx, buf, start, end, gain);
}

/**
 * Split a multi-hit take (footsteps) into one buffer per hit.
 *
 * A 20 ms RMS envelope, then a Schmitt trigger: arm below 12% of peak, fire above 30%.
 * Two thresholds rather than one because a single one re-triggers on the decay ripple of
 * the same footfall and yields eleven "steps" from a four-step take.
 *
 * Returns null unless it finds a plausible number of hits, in which case the caller falls
 * back to the whole shaped buffer — a wrong split is worse than no split.
 */
export function sliceOnsets(ctx, buf, spec) {
  const sr = buf.sampleRate;
  const win = Math.max(1, Math.round(0.02 * sr));
  const bins = Math.floor(buf.length / win);
  if (bins < 8) return null;

  const env = new Float32Array(bins);
  const ch = buf.getChannelData(0);
  let peak = 0;
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    const off = b * win;
    for (let i = 0; i < win; i++) { const v = ch[off + i]; sum += v * v; }
    const rms = Math.sqrt(sum / win);
    env[b] = rms;
    if (rms > peak) peak = rms;
  }
  if (peak <= 0) return null;

  const hi = peak * 0.3;
  const lo = peak * 0.12;
  const onsets = [];
  let armed = true;
  // 160 ms: fast enough for a sprint cadence, slow enough that the ripple on the decay of
  // one footfall cannot register as the next one.
  const minGapBins = Math.round(0.16 / 0.02);
  for (let b = 0; b < bins; b++) {
    if (armed && env[b] >= hi) {
      if (!onsets.length || b - onsets[onsets.length - 1] >= minGapBins) onsets.push(b);
      armed = false;
    } else if (!armed && env[b] <= lo) {
      armed = true;
    }
  }
  if (onsets.length < 2 || onsets.length > 12) return null;

  const gain = spec.gain == null ? 1 : spec.gain;
  const out = [];
  for (let i = 0; i < onsets.length; i++) {
    // Back up one bin: the trigger fires after the attack has already started.
    const start = Math.max(0, (onsets[i] - 1) * win);
    const nextOnset = i + 1 < onsets.length ? (onsets[i + 1] - 1) * win : buf.length;
    const end = Math.min(nextOnset, start + Math.round((spec.max || 0.5) * sr));
    // A sliver is a mis-detection, not a footstep. Drop it rather than shipping a click.
    if (end - start < Math.round(0.12 * sr)) continue;
    out.push(cut(ctx, buf, start, end, gain));
  }
  return out.length >= 2 ? out : null;
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

function baseUrl() {
  try {
    const b = import.meta.env?.BASE_URL;
    if (typeof b === 'string' && b) return b.endsWith('/') ? b : `${b}/`;
  } catch { /* not a Vite build */ }
  return '/';
}

/** `decodeAudioData` is promise-based everywhere modern and callback-based on old Safari. */
function decode(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (b) => { if (!settled) { settled = true; resolve(b); } };
    const bad = (e) => { if (!settled) { settled = true; reject(e || new Error('decode failed')); } };
    let ret;
    try {
      ret = ctx.decodeAudioData(arrayBuffer, ok, bad);
    } catch (err) { bad(err); return; }
    if (ret && typeof ret.then === 'function') ret.then(ok, bad);
  });
}

/**
 * Fetch, decode and shape every entry in `manifest`.
 *
 * Never rejects and never throws: a failed entry is counted and skipped, because the synth
 * buffer it would have replaced is still sitting in the engine's map doing its job.
 *
 * @param {BaseAudioContext} ctx
 * @param {{onSound:(name:string, buffers:AudioBuffer[], spec:object)=>void,
 *          manifest?:object, concurrency?:number, tiers?:string[]}} opts
 * @returns {Promise<{loaded:number, failed:number, bytes:number, ms:number,
 *                    seconds:number, failures:string[]}>}
 */
export async function loadSampleBank(ctx, opts) {
  const manifest = opts.manifest || SAMPLE_MANIFEST;
  const onSound = opts.onSound;
  // 2, not 6. Each worker's decode+shape is main-thread work; six in parallel produced a
  // burst long enough to starve the match handshake (see AudioEngine._deferSampleLoad).
  // The bank has no deadline, so a slower, gentler fill is strictly the right trade.
  const concurrency = opts.concurrency || 2;
  const tiers = opts.tiers || null;
  const base = baseUrl();
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  const entries = Object.entries(manifest)
    .filter(([, spec]) => !tiers || tiers.includes(spec.tier || 'core'));

  const stats = { loaded: 0, failed: 0, bytes: 0, ms: 0, seconds: 0, failures: [] };
  const t0 = now();
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= entries.length) return;
      const [name, spec] = entries[i];
      try {
        const res = await fetch(base + spec.url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.arrayBuffer();
        stats.bytes += raw.byteLength;
        const decoded = await decode(ctx, raw);

        let buffers;
        if (spec.loop || spec.raw) {
          // A bed is played whole and seamless: trimming its head or tail would put a
          // discontinuity at the loop point, which is the one place it is audible. A
          // musical sting is left alone for the same reason — its attack is written in.
          buffers = [spec.gain != null && spec.gain !== 1
            ? cut(ctx, decoded, 0, decoded.length, spec.gain) : decoded];
        } else if (spec.slice) {
          buffers = sliceOnsets(ctx, decoded, spec) || [shape(ctx, decoded, spec)];
        } else {
          buffers = [shape(ctx, decoded, spec)];
        }

        // A buffer that decoded to silence is not a usable sound. But before giving up on
        // the file, try the UNSHAPED decode: production reported a dozen weapon samples
        // failing as 'decoded silent' while the same files served byte-identical and played
        // fine elsewhere, which points at the trim rather than the audio. Falling back to
        // the raw buffer costs a slightly longer sample; discarding it costs the sound
        // entirely. Only if the raw decode is silent too is the file genuinely unusable,
        // and then the synth stays — which is still a working game.
        if (!buffers.length || peakOf(buffers[0]) < 1e-4) {
          if (peakOf(decoded) >= 1e-4) buffers = [decoded];
          else throw new Error('decoded silent');
        }

        for (const b of buffers) stats.seconds += b.duration;
        stats.loaded++;
        onSound(name, buffers, spec);
      } catch (err) {
        stats.failed++;
        if (stats.failures.length < 12) stats.failures.push(`${name}: ${err?.message || err}`);
      }
    }
  };

  const n = Math.min(concurrency, entries.length);
  await Promise.all(Array.from({ length: n }, worker));
  stats.ms = now() - t0;
  return stats;
}
