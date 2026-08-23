/**
 * OVERSTRIKE — shell (out-of-match) audio.
 *
 * The match runtime has its own engine (`src/audio/audio.js`, stream A's territory) built on
 * three.js panners and a procedurally rendered sound bank. None of that can serve the shell:
 * the shell is a plain DOM app that must boot with no WebGL, no three.js and no AudioContext
 * at all — `uishell` asserts that the game/three module graph is never even requested from a
 * menu route. So the menus get their own small player, and it obeys four rules:
 *
 *  1. NOTHING happens before a trusted user gesture. `AudioContext` construction, sample
 *     fetches and decodes are all deferred to `arm()`, which only ever runs from a real
 *     `pointerdown`/`keydown` whose `isTrusted` is true. A programmatic `shell.navigate()` —
 *     which is how the acceptance harness drives every screen — therefore cannot make a
 *     sound, and a shell that is never touched issues zero audio requests.
 *  2. NOTHING throws. Every await is caught. A 404, a decode failure, a blocked context or a
 *     browser with no WebAudio at all degrades to a short synthesised blip (see FALLBACK), and
 *     if even that fails the call is a silent no-op. Audio can never take a menu down.
 *  3. Volumes come from the settings authority the player already has: `masterVolume`,
 *     `uiVolume` and `musicVolume` (settings/inventory.js, DEVICE scope). They are read at the
 *     moment of playback rather than subscribed to, because the mount contract only promises
 *     `settings.get` — the acceptance harness supplies a settings object with no `subscribe`.
 *     Zero volume is a real mute: no source node is even created.
 *
 *     A one-shot cue re-reads the settings on its way out, so that rule holds for free. A
 *     LOOPING BED does not: it is started once and then runs for minutes, and the screen-diff
 *     that started it (`reactAudioToScreen`) short-circuits on "the wanted track is already
 *     playing", so nothing re-entered this module while the bed ran. Dragging the music or
 *     master slider therefore changed the setting and changed nothing else — a player who
 *     muted everything kept hearing the menu theme. Range inputs cannot be caught by the
 *     click-cue path either (they are not `a/button/summary/[role=button]`), and keyboard
 *     adjustment dispatches no click at all, so there was no gesture to hang a re-read on.
 *     `syncVolumes()` closes it: while armed, a cheap timer re-reads the three settings and
 *     pushes them onto the live gain nodes, so a bed follows the sliders continuously. It also
 *     enforces rule 3 for a bed *in flight* — reaching zero tears the voice down rather than
 *     leaving a silent-but-running source, and leaving zero starts it again, because
 *     `wantedTrack` remembers what the screen asked for even while the mute refuses it.
 *     `stopMusic()` (entering a match, an explicit stop) clears that intent, so nothing an
 *     unmute does can resurrect a track the shell no longer wants.
 *  4. Music never overlaps itself. One music voice exists; asking for the track that is
 *     already playing is a no-op, and any switch crossfades the outgoing voice out and stops
 *     it. `stopMusic()` is what entering a match calls.
 *
 * Boundary with the match engine: anything that happens INSIDE a match — kill confirms,
 * killstreak readiness, the round stings, the announcer — is registered in
 * `src/audio/samples.js` and played by the match mixer, which can duck it against gunfire and
 * place it in the world. This module owns the menus, and the two progression cues the HUD
 * borrows (`levelUp`, `unlock`) because those follow the interface volume, not the match mix.
 * A cue defined on both sides would simply play twice, so no cue is.
 *
 * `window.__SHELL_AUDIO__` exposes the wiring for instrumentation: which cue was requested,
 * whether it resolved to the decoded sample or the fallback tone, and which files decoded.
 * Proving a sound is *routed* is the only thing a headless browser can prove — it cannot
 * listen — so the harness reads this rather than pretending to hear something.
 */

const BASE = '/audio';

/**
 * `bus` picks the volume the cue is scaled by; `gain` is the per-cue trim that keeps a
 * hover tick from being as loud as a deploy stinger. `throttleMs` collapses repeats — hover
 * fires on every pointer entry and a menu row sweep would otherwise stack a dozen voices.
 */
export const SHELL_CUES = Object.freeze({
  hover: { src: `${BASE}/ui/ui_hover.mp3`, bus: 'ui', gain: 0.3, throttleMs: 45 },
  click: { src: `${BASE}/sfx/ui_click.mp3`, bus: 'ui', gain: 0.5, throttleMs: 40 },
  back: { src: `${BASE}/ui/ui_back.mp3`, bus: 'ui', gain: 0.45, throttleMs: 40 },
  equip: { src: `${BASE}/ui/ui_equip.mp3`, bus: 'ui', gain: 0.6 },
  /*
   * A single refusal reaches this cue twice by design: `submit()` voices the refusal at the
   * moment the request is rejected (so an inline `onError` that never flips the view still
   * makes a sound), and `reactAudioToScreen` voices the ready->error variant transition (so a
   * failure that arrives without a submit — a route load, a dropped connection — is not
   * silent). Neither call site can see the other's decision: `onError` is arbitrary async
   * caller code that may or may not end up flipping the variant. Two starts in the same
   * millisecond are not two sounds, they are one sound with a flam and partial phase
   * cancellation, so the throttle is what makes the pair a single refusal. It is wide enough
   * to span a submit's catch and the render it triggers, and short enough that a player who
   * retries and is refused again hears the second refusal.
   */
  error: { src: `${BASE}/ui/ui_error.mp3`, bus: 'ui', gain: 0.55, throttleMs: 300 },
  matchFound: { src: `${BASE}/ui/ui_match_found.mp3`, bus: 'ui', gain: 0.8 },
  deploy: { src: `${BASE}/ui/ui_deploy.mp3`, bus: 'ui', gain: 0.8 },
  countdownTick: { src: `${BASE}/ui/ui_countdown_tick.mp3`, bus: 'ui', gain: 0.7 },
  countdownGo: { src: `${BASE}/ui/ui_countdown_go.mp3`, bus: 'ui', gain: 0.85 },
  /*
   * The two progression stingers are throttled for the same reason `error` is, and against
   * the same failure: `progression.award()` fires `onUnlock` once per unlocked id in one
   * synchronous tick, so a rank that hands over two weapons asked for the identical file
   * twice in the same millisecond — one sound with a flam and partial phase cancellation,
   * not two. The HUD now coalesces a burst into a single cue before it gets here
   * (`_queueProgressionStinger`), and this is the floor under that for any other caller: a
   * rank-up is seconds apart from the next one at the very least, so nothing a player can
   * legitimately earn is swallowed by it.
   */
  levelUp: { src: `${BASE}/ui/ui_levelup.mp3`, bus: 'ui', gain: 0.8, throttleMs: 400 },
  unlock: { src: `${BASE}/ui/ui_unlock.mp3`, bus: 'ui', gain: 0.8, throttleMs: 400 },

  /*
   * Announcer lines, for the two shell moments that have one. They ride the `ui` bus and the
   * cue machinery above unchanged — the in-match announcer (`src/audio/audio.js`) has its own
   * queue and its own `announcerVolume`, but it does not exist until a match does, and these
   * two lines are both about getting there. There is deliberately no FALLBACK tone for a
   * spoken line: a bleep standing in for a voice is worse than the silence.
   */
  voWelcome: { src: `${BASE}/vo/welcome.mp3`, bus: 'ui', gain: 0.9 },
  voMatchFound: { src: `${BASE}/vo/match_found.mp3`, bus: 'ui', gain: 0.9 },
});

/**
 * `loop: false` tracks are stingers — they play once over whatever screen requested them and
 * then release the music voice. Looping beds hold it until something else claims it.
 */
export const SHELL_TRACKS = Object.freeze({
  menu: { src: `${BASE}/music/menu_theme.mp3`, gain: 0.9, loop: true },
  tension: { src: `${BASE}/music/menu_tension.mp3`, gain: 0.9, loop: true },
  victory: { src: `${BASE}/music/victory_theme.mp3`, gain: 1, loop: false },
  defeat: { src: `${BASE}/music/defeat_theme.mp3`, gain: 1, loop: false },
  // The ROUND stings are deliberately absent. They belong to the match mix, where the
  // engine already ducks, positions and prioritises against gunfire — `src/audio/samples.js`
  // registers them as `stingRoundWin`/`stingRoundLoss`. Two owners for one sting means two
  // copies of it playing, so this side does not define them at all.
});

/**
 * The degraded voice for each cue, used when its sample cannot be fetched or decoded. These
 * are deliberately distinguishable from one another — an offline player still gets a rising
 * pair for "unlocked" and a falling one for "refused", which is the information the sample
 * was carrying. `[startHz, endHz, seconds, type]`.
 */
const FALLBACK = Object.freeze({
  hover: [1180, 1180, 0.028, 'sine'],
  click: [880, 660, 0.05, 'square'],
  back: [520, 380, 0.07, 'sine'],
  equip: [700, 980, 0.09, 'triangle'],
  error: [340, 190, 0.16, 'sawtooth'],
  matchFound: [620, 1240, 0.22, 'triangle'],
  deploy: [420, 840, 0.28, 'triangle'],
  countdownTick: [900, 900, 0.06, 'square'],
  countdownGo: [700, 1400, 0.2, 'square'],
  levelUp: [520, 1560, 0.3, 'triangle'],
  unlock: [780, 1170, 0.22, 'sine'],
});

const MAX_EVENTS = 200;
const CROSSFADE = 0.45;
/**
 * How often a running music bed re-reads the volume settings. A slider drag should feel
 * immediate without polling a settings store on every frame; a quarter second reads as
 * "instant" for a fade and costs three `get` calls a second while the menus are up. The
 * settings screen also pokes `syncVolumes()` directly on `input`, so the timer is the floor
 * on responsiveness rather than the mechanism.
 */
const VOLUME_POLL_MS = 250;
/** A mute pulls the bed down fast — this is a mute, not a musical transition. */
const MUTE_FADE = 0.08;

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Settings store volumes as 0-100 integers; a missing/rejected read falls back to the default. */
function readVolume(settings, key, fallback) {
  let raw;
  try {
    raw = settings?.get?.(key);
  } catch {
    raw = undefined;
  }
  const value = Number(raw);
  return clamp01((Number.isFinite(value) ? value : fallback) / 100);
}

/**
 * The live controller, if one has been created. The in-match HUD reaches for this rather than
 * building a second AudioContext: a browser gives you a small number of them, and two players
 * would mean two independent volume settings for the same cue vocabulary. Returns null in the
 * headless simulation, where nobody ever calls `createShellAudio` — which is why every caller
 * is written `getShellAudio()?.play(...)`.
 */
let liveController = null;
export function getShellAudio() {
  return liveController;
}

export function createShellAudio({ settings = null, window: windowRef = globalThis.window, onArmed = null } = {}) {
  const doc = windowRef?.document || null;
  /** Instrumentation ring buffer. Written even when playback is refused, so the harness can
   *  prove the refusal happened for the reason it expects rather than by silence. */
  const events = [];
  const decoded = new Set();
  const failed = new Set();
  const buffers = new Map();
  const lastPlayedAt = new Map();

  let context = null;
  let masterGain = null;
  let uiGain = null;
  let musicGain = null;
  let armed = false;
  let welcomed = false;
  let destroyed = false;
  let musicTrack = null;
  let musicVoice = null;
  let musicToken = 0;
  /**
   * The track the shell most recently ASKED for, which is not the same as the one playing:
   * a request refused for a zero volume plays nothing but is still the screen's intent, and
   * an unmute must be able to honour it without waiting for a re-render that may never come.
   * Cleared by `stopMusic()` — that is the shell saying it wants no music at all.
   */
  let wantedTrack = null;
  let volumeTimer = null;
  let volumeUnsubscribe = null;

  const record = (cue, source, detail) => {
    events.push({ cue, source, detail: detail ?? null, at: Date.now() });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  };

  const disabled = () => destroyed || windowRef?.__OVERSTRIKE_SHELL_AUDIO_DISABLED__ === true;

  function ensureContext() {
    if (context) return context;
    const Ctor = windowRef?.AudioContext || windowRef?.webkitAudioContext;
    if (typeof Ctor !== 'function') return null;
    try {
      context = new Ctor();
      masterGain = context.createGain();
      uiGain = context.createGain();
      musicGain = context.createGain();
      uiGain.connect(masterGain);
      musicGain.connect(masterGain);
      masterGain.connect(context.destination);
    } catch {
      context = null;
    }
    return context;
  }

  function applyVolumes() {
    if (!context) return;
    const master = readVolume(settings, 'masterVolume', 80);
    masterGain.gain.value = master;
    uiGain.gain.value = readVolume(settings, 'uiVolume', 80);
    musicGain.gain.value = readVolume(settings, 'musicVolume', 45);
  }

  /**
   * Re-read the settings and make the currently audible world match them.
   *
   * `applyVolumes()` alone is enough for a gain change — the bed is already routed through
   * `musicGain`, so the drag is heard on the next audio quantum. The two ENDS of the range
   * need more than a gain: zero must be a real mute (rule 3) and coming back from zero must
   * restore what the screen wanted, and neither is expressible as a gain value on a voice
   * that may not exist. Both edges are handled here so every entry point — the timer, the
   * settings screen, an external `settings.subscribe` — gets identical behaviour.
   */
  function syncVolumes() {
    if (destroyed || !context) return false;
    applyVolumes();
    const muted = masterGain.gain.value <= 0 || musicGain.gain.value <= 0;
    if (muted) {
      if (musicVoice || musicTrack !== null) {
        const voice = musicVoice;
        musicVoice = null;
        musicTrack = null;
        // Invalidated so a decode still in flight for this track cannot start a voice behind
        // the mute — `music()`'s load continuation bails on a stale token.
        musicToken++;
        if (voice) stopVoice(voice, MUTE_FADE);
        record('music:mute', 'stopped');
      }
      return true;
    }
    // Unmuted with an intent outstanding and nothing playing or loading: honour it now.
    if (wantedTrack && musicTrack === null && !musicVoice) music(wantedTrack);
    return true;
  }

  /** Poll the settings while the shell is armed; a bed can outlive every other re-entry. */
  function startVolumeWatch() {
    if (volumeTimer !== null) return;
    if (typeof windowRef?.setInterval !== 'function') return;
    volumeTimer = windowRef.setInterval(() => { try { syncVolumes(); } catch { /* never fatal */ } }, VOLUME_POLL_MS);
    // If the settings authority happens to publish changes, take the instant path as well.
    // Purely additive: the mount contract only promises `get`, so this is best-effort.
    const subscribe = settings?.subscribe || settings?.onChange;
    if (typeof subscribe === 'function') {
      try {
        const off = subscribe.call(settings, () => { try { syncVolumes(); } catch { /* never fatal */ } });
        if (typeof off === 'function') volumeUnsubscribe = off;
      } catch { /* a settings store without a working subscribe is the documented case */ }
    }
  }

  /** True once a real gesture has been seen. WebAudio requires it, and it is also what keeps
   *  automated/programmatic navigation silent. */
  function arm() {
    if (armed || disabled()) return false;
    armed = true;
    const ctx = ensureContext();
    if (!ctx) {
      record('*arm', 'unavailable');
      return false;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    applyVolumes();
    startVolumeWatch();
    record('*arm', 'armed');
    // The one line that only makes sense once per session, at the first moment there is a
    // player on the other end of it. Fired from `arm()` rather than a route because arming IS
    // the first trusted gesture — before it there is provably nobody there. Restricted to the
    // landing screens: greeting someone who deep-linked into their session list is not a
    // welcome, it is a non-sequitur.
    const path = windowRef?.location?.pathname || '/welcome';
    if (!welcomed && (path === '/' || path.startsWith('/welcome') || path.startsWith('/auth/'))) {
      welcomed = true;
      play('voWelcome');
    }
    try { onArmed?.(); } catch { /* a subscriber must not un-arm the audio */ }
    return true;
  }

  const onGesture = (event) => {
    if (event?.isTrusted !== true) return;
    arm();
  };

  if (doc) {
    doc.addEventListener('pointerdown', onGesture, { capture: true });
    doc.addEventListener('keydown', onGesture, { capture: true });
  }

  async function loadBuffer(src) {
    if (buffers.has(src)) return buffers.get(src);
    const ctx = ensureContext();
    if (!ctx) return null;
    const task = (async () => {
      try {
        const response = await fetch(src, { cache: 'force-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(bytes);
        decoded.add(src);
        return buffer;
      } catch (error) {
        // Cached as a resolved null rather than a rejection: one 404 must not be retried on
        // every hover, and an unhandled rejection here would surface as a console error the
        // acceptance harness treats as a failure.
        failed.add(src);
        record(src, 'load-failed', String(error?.message || error));
        return null;
      }
    })();
    buffers.set(src, task);
    return task;
  }

  /** The degraded voice. Synthesised inline so it needs no assets and cannot itself fail. */
  function playFallback(cue, level) {
    const ctx = ensureContext();
    const shape = FALLBACK[cue];
    if (!ctx || !shape || level <= 0) return false;
    try {
      const [startHz, endHz, seconds, type] = shape;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(startHz, now);
      if (endHz !== startHz) osc.frequency.exponentialRampToValueAtTime(endHz, now + seconds);
      env.gain.setValueAtTime(0.0001, now);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0002, level * 0.5), now + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
      osc.connect(env);
      env.connect(uiGain);
      osc.start(now);
      osc.stop(now + seconds + 0.02);
      osc.onended = () => { try { env.disconnect(); } catch { /* already torn down */ } };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fire a UI cue. Returns false (silently) for every refusal path: not armed, unknown cue,
   * muted, throttled, no WebAudio. Never returns a rejected promise.
   */
  function play(cue, { force = false } = {}) {
    if (disabled()) return false;
    const definition = SHELL_CUES[cue];
    if (!definition) return false;
    if (!armed) {
      record(cue, 'not-armed');
      return false;
    }
    const now = Date.now();
    if (!force && definition.throttleMs) {
      const previous = lastPlayedAt.get(cue) || 0;
      if (now - previous < definition.throttleMs) {
        record(cue, 'throttled');
        return false;
      }
    }
    lastPlayedAt.set(cue, now);
    const ctx = ensureContext();
    if (!ctx) {
      record(cue, 'unavailable');
      return false;
    }
    applyVolumes();
    if (masterGain.gain.value <= 0 || uiGain.gain.value <= 0) {
      record(cue, 'muted');
      return false;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    const cached = buffers.get(definition.src);
    const start = (buffer) => {
      if (destroyed) return;
      if (!buffer) {
        record(cue, playFallback(cue, definition.gain) ? 'fallback' : 'silent', definition.src);
        return;
      }
      try {
        const source = ctx.createBufferSource();
        const trim = ctx.createGain();
        source.buffer = buffer;
        trim.gain.value = definition.gain;
        source.connect(trim);
        trim.connect(uiGain);
        source.start();
        source.onended = () => { try { trim.disconnect(); } catch { /* already torn down */ } };
        record(cue, 'sample', definition.src);
      } catch {
        record(cue, playFallback(cue, definition.gain) ? 'fallback' : 'silent', definition.src);
      }
    };

    // A decoded buffer plays synchronously; the first request for a cue necessarily awaits its
    // fetch, which is why hover/click are pre-warmed by `preload()` on arm.
    if (cached && typeof cached.then !== 'function') start(cached);
    else Promise.resolve(cached || loadBuffer(definition.src)).then(start).catch(() => {});
    return true;
  }

  function stopVoice(voice, fade = CROSSFADE) {
    if (!voice) return;
    const ctx = context;
    try {
      const now = ctx.currentTime;
      voice.trim.gain.cancelScheduledValues(now);
      voice.trim.gain.setValueAtTime(Math.max(0.0001, voice.trim.gain.value), now);
      voice.trim.gain.exponentialRampToValueAtTime(0.0001, now + fade);
      voice.source.stop(now + fade + 0.02);
      voice.source.onended = () => { try { voice.trim.disconnect(); } catch { /* torn down */ } };
    } catch {
      try { voice.source.stop(); } catch { /* already stopped */ }
    }
  }

  /**
   * Claim the single music voice for `track`. Requesting the track that is already playing is
   * a no-op — that is what stops a re-render of the same screen from stacking menu themes.
   */
  function music(track) {
    if (disabled()) return false;
    if (track === null) return stopMusic();
    const definition = SHELL_TRACKS[track];
    if (!definition) return false;
    // Recorded before any refusal: "the shell wants this track" is true whether or not it can
    // be voiced right now, and it is what an unmute replays. Only a LOOPING bed is latched.
    // A sting is a moment, not a state: latching `victory` would have the timer notice the
    // theme had ended and start it over, forever, and an unmute thirty seconds late would
    // replay a fanfare for a match the player has already left behind. One-shots are the
    // caller's to re-request (`oneShotMusicLatch` in the shell does exactly that).
    wantedTrack = definition.loop === true ? track : null;
    if (!armed) {
      record(`music:${track}`, 'not-armed');
      return false;
    }
    if (musicTrack === track) {
      record(`music:${track}`, 'already-playing');
      return true;
    }
    const ctx = ensureContext();
    if (!ctx) {
      record(`music:${track}`, 'unavailable');
      return false;
    }
    applyVolumes();
    if (masterGain.gain.value <= 0 || musicGain.gain.value <= 0) {
      // Remember the intent so unmuting mid-screen does not need a navigation to take effect,
      // but create nothing.
      musicTrack = null;
      record(`music:${track}`, 'muted');
      return false;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    musicTrack = track;
    const token = ++musicToken;
    const outgoing = musicVoice;
    musicVoice = null;
    stopVoice(outgoing);

    Promise.resolve(loadBuffer(definition.src)).then((buffer) => {
      // A slower fetch must not resurrect a track something else has already replaced.
      if (destroyed || token !== musicToken) return;
      if (!buffer) {
        // Music has no synthesised stand-in: a wrong-feeling loop under the menus is worse
        // than silence, and the shell was silent before these assets existed.
        musicTrack = null;
        record(`music:${track}`, 'silent', definition.src);
        return;
      }
      try {
        const source = ctx.createBufferSource();
        const trim = ctx.createGain();
        source.buffer = buffer;
        source.loop = definition.loop === true;
        if (source.loop) {
          source.loopStart = 0;
          source.loopEnd = buffer.duration;
        }
        const now = ctx.currentTime;
        trim.gain.setValueAtTime(0.0001, now);
        trim.gain.exponentialRampToValueAtTime(definition.gain, now + CROSSFADE);
        source.connect(trim);
        trim.connect(musicGain);
        source.start();
        musicVoice = { source, trim, track };
        if (!source.loop) {
          source.onended = () => {
            if (musicVoice?.source === source) {
              musicVoice = null;
              if (musicTrack === track) musicTrack = null;
            }
            try { trim.disconnect(); } catch { /* torn down */ }
          };
        }
        record(`music:${track}`, 'sample', definition.src);
      } catch {
        musicTrack = null;
        record(`music:${track}`, 'silent', definition.src);
      }
    }).catch(() => { musicTrack = null; });
    return true;
  }

  function stopMusic({ fade = CROSSFADE } = {}) {
    musicToken++;
    musicTrack = null;
    // An explicit stop is the shell withdrawing the request, not a mute deferring it, so the
    // intent goes with it: entering a match must not have the volume watcher restart the menu
    // theme the moment a slider moves.
    wantedTrack = null;
    const voice = musicVoice;
    musicVoice = null;
    if (voice) {
      stopVoice(voice, fade);
      record('music:stop', 'stopped');
    }
    return true;
  }

  /** Warm the cues a first interaction is about to need, so the first click is not silent. */
  function preload(cues = ['hover', 'click', 'back']) {
    if (disabled() || !armed) return;
    for (const cue of cues) {
      const definition = SHELL_CUES[cue] || SHELL_TRACKS[cue];
      if (definition) void loadBuffer(definition.src);
    }
  }

  const controller = Object.freeze({
    arm,
    play,
    music,
    stopMusic,
    preload,
    /**
     * Re-read the volume settings now. The settings screen calls this on `input` so a drag is
     * heard under the thumb; everything else can rely on the timer.
     */
    syncVolumes,
    isArmed: () => armed,
    getMusicTrack: () => musicTrack,
    getWantedTrack: () => wantedTrack,
    /** Instrumentation surface. Cheap enough to leave on: it is three arrays and a counter. */
    getState: () => ({
      armed,
      contextState: context?.state || null,
      musicTrack,
      wantedTrack,
      musicPlaying: Boolean(musicVoice),
      volumes: context
        ? { master: masterGain.gain.value, ui: uiGain.gain.value, music: musicGain.gain.value }
        : null,
      decoded: [...decoded],
      failed: [...failed],
      events: events.slice(-40),
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopMusic({ fade: 0.01 });
      if (volumeTimer !== null) {
        try { windowRef?.clearInterval?.(volumeTimer); } catch { /* already gone */ }
        volumeTimer = null;
      }
      try { volumeUnsubscribe?.(); } catch { /* best-effort */ }
      volumeUnsubscribe = null;
      if (doc) {
        doc.removeEventListener('pointerdown', onGesture, { capture: true });
        doc.removeEventListener('keydown', onGesture, { capture: true });
      }
      try { context?.close?.(); } catch { /* already closed */ }
      context = null;
      if (liveController === controller) liveController = null;
    },
  });

  liveController = controller;
  if (windowRef) {
    try {
      Object.defineProperty(windowRef, '__SHELL_AUDIO__', { configurable: true, value: controller });
    } catch { /* a frozen window is not worth failing a mount over */ }
  }
  return controller;
}
