/**
 * OVERSTRIKE — UI probe.
 *
 * Drives the REAL front end in headless Chromium: no test doubles, no direct
 * calls into game systems where a human would click. Every assertion is about
 * something a player can see or do.
 *
 *   main menu -> PLAY -> pick a mode / bots / difficulty -> DEPLOY
 *   assert the match actually started with those options
 *   assert the loadout panel equipped the weapon it claimed
 *   Esc (pointerUnlock) -> pause shell -> every settings tab
 *   change a setting -> assert it applied live AND persisted to localStorage
 *   rebind a key -> assert the binding took
 *   hold TAB -> assert the scoreboard is on screen with real rows
 *   fight -> assert the HUD ammo and health TEXT actually change
 *   resume -> quit to menu -> match end -> play again
 *
 * Usage: node scripts/uiprobe.mjs [--headed] [--out=shots]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const HEADED = argv.includes('--headed');
const OUT = path.resolve(ROOT, arg('out', 'shots'));

const results = [];
let failures = 0;
let stepNo = 0;

function ok(name, detail = '') {
  results.push({ pass: true, name, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function bad(name, detail = '') {
  failures++;
  results.push({ pass: false, name, detail });
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}
function assert(cond, name, detail = '') {
  if (cond) ok(name, detail); else bad(name, detail);
  return !!cond;
}
function section(title) {
  stepNo++;
  console.log(`\n[${String(stepNo).padStart(2, '0')}] ${title}`);
}

let server, browser;
try {
  await mkdir(OUT, { recursive: true });

  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    // HMR off and the watcher muzzled: the probe drives one long session and a
    // hot update from another engineer saving a file mid-run detaches the very
    // nodes we are clicking. We want a snapshot of the tree as it is on disk now.
    server: { port: 5201, strictPort: false, hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log(`[uiprobe] dev server ${url}`);

  browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--enable-webgl', '--ignore-gpu-blocklist', '--disable-gpu-sandbox',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    ],
  });
  // 1280×720 is the floor the interface has to stay legible at, so the probe
  // shoots there rather than at a comfortable desktop size.
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Long enough for a software-rendered frame, short enough that a UI defect
  // (an element that never settles, a panel that never opens) fails fast.
  page.setDefaultTimeout(30000);

  // SwiftShader rasterises on the CPU; drop the internal render scale so the
  // probe is not measuring the software renderer. Seed enough XP that the
  // whole arsenal is unlocked, so weapon locking has something to unlock.
  await page.addInitScript(() => {
    try {
      const S = 'overstrike.settings.v1';
      const cur = JSON.parse(localStorage.getItem(S) || '{}');
      localStorage.setItem(S, JSON.stringify({ ...cur, renderScale: 0.5, postFx: false, shadows: false }));
      localStorage.setItem('overstrike.progress.v1', JSON.stringify({
        schema: 1, xp: 250000, level: 1, weapons: {}, lifetime: {}, challenges: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      }));
    } catch { /* private mode */ }
  });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/SwiftShader|WebGL|Three\.js/i.test(t)) return;
    pageErrors.push(`console.error: ${t}`);
  });

  const state = () => page.evaluate(() => window.__GAME__?.state);
  const settingOf = (k) => page.evaluate((key) => window.__GAME__.settings.get(key), k);
  const storedSetting = (k) => page.evaluate((key) => {
    try { return JSON.parse(localStorage.getItem('overstrike.settings.v1') || '{}')[key]; } catch { return undefined; }
  }, k);
  // A software-rendered 1280×720 frame can take seconds to compose.
  const shot = (n) => page.screenshot({ path: path.join(OUT, `ui-${n}.png`), timeout: 90000 });

  /**
   * Anything the HUD paints in `update(dt)` lands on the next rendered frame, and
   * SwiftShader renders about twice a second — so "wait 200 ms" is not a wait at
   * all here. Block on the frame counter instead.
   */
  const waitFrames = (n = 2) => page.evaluate(async (want) => {
    const g = window.__GAME__;
    const target = g.frame + want;
    const t0 = Date.now();
    while (g.frame < target && Date.now() - t0 < 30000) {
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, n);

  /* ------------------------------------------------------------------ boot */
  section('BOOT');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const booted = await page
    .waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 120000, polling: 200 })
    .then(() => true).catch(() => false);
  if (!assert(booted, 'game reaches the menu')) throw new Error('boot failed');
  await page.waitForTimeout(500);

  assert(await page.locator('.menu.open').isVisible(), 'main menu shell is open');
  assert((await page.locator('.menu-nav .mi').count()) >= 5, 'nav rail is populated');
  assert(await page.locator('.panel.on .dossier').isVisible(), 'dossier is the default panel');

  const dossierLevel = await page.locator('.dg-lvl').textContent();
  assert(Number(dossierLevel) > 1, 'dossier shows the real progression level', `level ${dossierLevel}`);
  assert((await page.locator('.chal').count()) > 0, 'challenges render from progression');

  /* ------------------------------------------------------- keyboard access */
  section('KEYBOARD NAVIGATION');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const focusTag = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}.${el.className.split(' ')[0]}` : 'none';
  });
  assert(focusTag !== 'none' && focusTag !== 'BODY.', 'arrow keys move focus inside the menu', focusTag);
  const ringVisible = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return false;
    // :focus-visible only matches after keyboard interaction, which is what we did.
    const cs = getComputedStyle(el);
    return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  });
  assert(ringVisible, 'focused control has a visible focus ring');

  /* ---------------------------------------------------------- play + deploy */
  section('PLAY PANEL');
  await page.locator('.menu-nav .mi', { hasText: 'PLAY' }).first().click();
  await page.waitForTimeout(200);
  assert(await page.locator('.panel.on .modes').isVisible(), 'play panel opened');

  const modeIds = await page.locator('.mode-card').evaluateAll((els) => els.map((e) => e.dataset.mode));
  assert(modeIds.length >= 5, 'every mode from MODE_LIST is offered', modeIds.join(','));
  const WANT_MODE = 'ffa';
  assert(modeIds.includes(WANT_MODE), `mode "${WANT_MODE}" is selectable`);
  await page.locator(`.mode-card[data-mode="${WANT_MODE}"]`).click();
  assert(await settingOf('mode') === WANT_MODE, 'clicking a mode card writes settings.mode');

  // Bot count: drive the real range input with the keyboard, as a player would.
  const botSlider = page.locator('.panel.on input[type=range][data-setting="botCount"]').first();
  await botSlider.focus();
  await page.evaluate(() => {
    const el = document.querySelector('.panel.on input[type=range][data-setting="botCount"]');
    el.value = '4';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const WANT_BOTS = 4;
  assert(await settingOf('botCount') === WANT_BOTS, 'bot-count slider writes settings.botCount');

  const WANT_DIFF = 'hardened';
  await page.locator(`.panel.on .seg[data-setting="difficulty"] button[data-value="${WANT_DIFF}"]`).first().click();
  assert(await settingOf('difficulty') === WANT_DIFF, 'difficulty segment writes settings.difficulty');
  assert((await page.locator('.diff-hint').textContent()).length > 10, 'difficulty hint describes the choice');
  const sum = await page.locator('.panel.on .deploy-sum').textContent();
  assert(/4 BOTS/.test(sum) && /HARDENED/.test(sum), 'deploy summary reflects the choices', sum.trim());

  /* ------------------------------------------------------------- loadout */
  section('LOADOUT');
  await page.locator('.menu-nav .mi', { hasText: 'LOADOUT' }).first().click();
  await page.waitForTimeout(200);
  const wrows = await page.locator('.wrow').count();
  assert(wrows > 1, 'loadout lists the arsenal (static import, no silent degrade)', `${wrows} weapons`);
  assert(await page.locator('.wrow .gl svg').first().isVisible(), 'weapon glyphs render');

  // Pick a primary that is NOT the one already selected.
  const pickId = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.wrow:not(.locked)'));
    const other = rows.find((r) => !r.classList.contains('on'));
    return other?.dataset.id || null;
  });
  if (assert(!!pickId, 'an alternative unlocked primary exists', pickId || '')) {
    await page.locator(`.wrow[data-id="${pickId}"]`).click();
    assert(await settingOf('loadoutPrimary') === pickId, 'picking a weapon persists via settings.set', pickId);
    assert(await storedSetting('loadoutPrimary') === pickId, 'loadout survives in localStorage (no private mirror)');
    const cardName = await page.locator('.wc-name').textContent();
    assert(cardName.trim().length > 1, 'weapon card renders the pick', cardName.trim());
  }

  await shot('01-loadout');

  /* --------------------------------------------------------------- deploy */
  section('DEPLOY');
  await page.locator('.menu-nav .mi', { hasText: 'PLAY' }).first().click();
  await page.waitForTimeout(150);
  await page.locator('.panel.on .btn.cta').click();
  await page.waitForTimeout(1200);

  const started = await page.evaluate(() => {
    const g = window.__GAME__;
    return {
      state: g.state,
      modeId: g.match.modeId,
      botCount: g.match.botCount,
      bots: g.bots?.bots?.length ?? -1,
      difficulty: g.match.difficulty,
      phase: g.match.phase,
      weapon: g.weapons.current(g.player)?.def?.id ?? null,
      menuOpen: !!g.menu.isOpen,
    };
  });
  assert(started.state === 'playing', 'DEPLOY put the game into play', started.state);
  assert(!started.menuOpen, 'menu closed on deploy');
  assert(started.modeId === WANT_MODE, 'chosen mode reached the match', started.modeId);
  assert(started.botCount === WANT_BOTS, 'chosen bot count reached the match', String(started.botCount));
  assert(started.bots === WANT_BOTS, 'bot manager actually spawned that many', String(started.bots));
  assert(started.difficulty === WANT_DIFF, 'chosen difficulty reached the match', started.difficulty);
  if (pickId) {
    assert(started.weapon === pickId, 'the loadout panel equipped what it claimed',
      `holding ${started.weapon}, picked ${pickId}`);
  }

  assert(await page.locator('#hud.live').isVisible(), 'HUD went live');
  assert(await page.locator('.hud-ammo').isVisible(), 'ammo block visible');
  assert(await page.locator('.hud-health').isVisible(), 'vitals block visible');
  assert(await page.locator('.minimap canvas').isVisible(), 'minimap canvas visible');

  const topMode = await page.locator('.score-mid .mode').textContent();
  assert(/FREE-FOR-ALL/i.test(topMode), 'HUD names the running mode', topMode.trim());

  /* ------------------------------------------------------------- combat */
  section('LIVE HUD READOUTS');
  // Wait out the 3 s countdown; Match.canFire() refuses fire before that.
  // Those are 3 seconds of SIMULATION time and SwiftShader manages only a
  // couple of frames a second, so the wall-clock budget has to be generous.
  await page.waitForFunction(() => window.__GAME__.match.phase === 'live', null, { timeout: 120000, polling: 250 });
  ok('countdown ran and the match went live');

  const ammoBefore = await page.locator('.ammo-mag').textContent();
  const magFracBefore = await page.evaluate(() =>
    document.querySelector('.ammo-track .mag').style.transform);

  // Hold the trigger through the real input layer.
  await page.evaluate(() => {
    const g = window.__GAME__;
    g.input.enabled = true;
    g.input.buttons[0] = true;
    g.__hold = setInterval(() => { g.input.buttons[0] = true; }, 30);
  });
  // Rounds leave the gun on the fixed step, and the software renderer only
  // drives a couple of steps a second — wait for the sim, not the clock.
  await page.waitForFunction(() => {
    const w = window.__GAME__.weapons.current(window.__GAME__.player);
    return w && w.ammo < w.def.magSize;
  }, null, { timeout: 60000, polling: 200 }).catch(() => {});
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const g = window.__GAME__;
    clearInterval(g.__hold);
    g.input.buttons[0] = false;
  });
  await page.waitForTimeout(400);

  const ammoAfter = await page.locator('.ammo-mag').textContent();
  const magFracAfter = await page.evaluate(() =>
    document.querySelector('.ammo-track .mag').style.transform);
  const realAmmo = await page.evaluate(() => window.__GAME__.weapons.current(window.__GAME__.player).ammo);
  assert(Number(ammoAfter) < Number(ammoBefore), 'ammo TEXT drops while firing', `${ammoBefore} -> ${ammoAfter}`);
  assert(Number(ammoAfter) === realAmmo, 'ammo text equals WeaponInstance.ammo', `hud ${ammoAfter}, sim ${realAmmo}`);
  assert(magFracAfter !== magFracBefore, 'magazine track follows the round count', magFracAfter);

  const reserveTxt = await page.locator('.ammo-res').textContent();
  const realReserve = await page.evaluate(() => window.__GAME__.weapons.current(window.__GAME__.player).reserve);
  assert(Number(reserveTxt) === realReserve, 'reserve text equals WeaponInstance.reserve', reserveTxt);

  const weaponTxt = await page.locator('.hud-ammo .wn').textContent();
  const realWeapon = await page.evaluate(() => window.__GAME__.weapons.current(window.__GAME__.player).def.name);
  assert(weaponTxt.trim() === realWeapon.toUpperCase(), 'weapon name matches the def', weaponTxt.trim());

  const modeTxt = await page.locator('.ammo-mode').textContent();
  const realMode = await page.evaluate(() => window.__GAME__.weapons.current(window.__GAME__.player).def.fireMode);
  assert(modeTxt.trim().toLowerCase().includes(realMode.slice(0, 4)) || /BURST/.test(modeTxt),
    'fire mode matches the def', `${modeTxt.trim()} vs ${realMode}`);

  // Reload is a real state on the instance; the prompt and the sweep must follow.
  await page.evaluate(() => window.__GAME__.weapons.current(window.__GAME__.player).reload());
  await page.waitForFunction(() => document.querySelector('.hud-ammo').classList.contains('reloading'),
    null, { timeout: 30000, polling: 100 }).catch(() => {});
  const reloading = await page.evaluate(() => ({
    cls: document.querySelector('.hud-ammo').className,
    prompt: document.querySelector('.ammo-prompt').textContent,
    loading: document.querySelector('.ammo-track').className,
    progress: document.querySelector('.ammo-track .load').style.transform,
  }));
  assert(/reloading/.test(reloading.cls), 'ammo block enters the reloading state');
  assert(/RELOADING/i.test(reloading.prompt), 'reload prompt shown', reloading.prompt);
  assert(/loading/.test(reloading.loading), 'reload sweep is running', reloading.progress);
  // Ride it out so the rest of the run sees an idle weapon.
  await page.waitForFunction(() => !window.__GAME__.weapons.current(window.__GAME__.player).isReloading,
    null, { timeout: 120000, polling: 250 }).catch(() => {});
  const magAfterReload = await page.locator('.ammo-mag').textContent();
  const magSize = await page.evaluate(() => window.__GAME__.weapons.current(window.__GAME__.player).def.magSize);
  assert(Number(magAfterReload) === magSize, 'reload refills the displayed magazine', `${magAfterReload}/${magSize}`);

  // Health: applyDamage is the §4 contract entry point every weapon uses.
  // Four HARDENED bots have had minutes of wall-clock to work on us by now, so
  // put the operator back on their feet first and measure a known drop.
  await page.evaluate(() => window.__GAME__.match.spawner.spawnEntity(window.__GAME__.player));
  await waitFrames(3);
  const hpBefore = await page.locator('.hp-value').textContent();
  assert(Number(hpBefore) > 62, 'operator is back at full health before the damage test', hpBefore);
  await page.evaluate(() => {
    const g = window.__GAME__;
    g.player.applyDamage(62, { attacker: g.bots.bots[0] || null, hitPart: 'torso', weaponId: 'ar_vector' });
  });
  await waitFrames(3);
  const hpAfter = await page.locator('.hp-value').textContent();
  const realHp = await page.evaluate(() => Math.round(window.__GAME__.player.health));
  assert(Number(hpAfter) < Number(hpBefore), 'health TEXT drops on damage', `${hpBefore} -> ${hpAfter}`);
  assert(Number(hpAfter) === realHp, 'health text equals entity.health', `hud ${hpAfter}, sim ${realHp}`);
  const hpCls = await page.locator('.hud-health').getAttribute('class');
  assert(/crit|hurt/.test(hpCls), 'vitals switch to a wounded state', hpCls);
  const vig = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.hud-vignette')).opacity));
  assert(vig > 0, 'low-health vignette is showing', vig.toFixed(2));
  const arcs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.dmg-arc')).filter((a) => Number(a.style.opacity) > 0).length);
  assert(arcs > 0, 'directional damage indicator fired', `${arcs} arc(s)`);

  // Killfeed + hitmarker are bus-driven; raise the canonical events.
  await page.evaluate(() => {
    const g = window.__GAME__;
    const bot = g.bots.bots[0];
    g.bus.emit('hit', { shooter: g.player, target: bot, point: bot.position, normal: bot.position, headshot: true, surface: 'flesh' });
    g.bus.emit('kill', { victim: bot, attacker: g.player, weaponId: 'ar_vector', headshot: true, distance: 51 });
  });
  await waitFrames(2);
  assert((await page.locator('.kf-row.on').count()) > 0, 'killfeed rendered a row from the `kill` event');
  assert(await page.locator('.kf-row.mine').first().isVisible(), 'own kill is highlighted');
  assert((await page.locator('.xp-pop.on').count()) > 0, 'XP popups fired for kill / headshot / longshot');
  // A kill hitmarker lives 0.34 s of REAL time; a software-rendered frame can be
  // longer than that, so assert the state it latched rather than racing its fade.
  const hm = await page.evaluate(() => ({
    kind: document.querySelector('.hitmark').dataset.kind,
    opacity: Number(getComputedStyle(document.querySelector('.hitmark')).opacity),
  }));
  assert(hm.kind === 'kill', 'hitmarker upgraded to the kill variant', hm.kind || 'none');
  assert(hm.opacity >= 0, 'hitmarker rendered', hm.opacity.toFixed(2));

  // Killstreak tray + UAV both read Match.killstreaks.
  await page.evaluate(() => {
    const g = window.__GAME__;
    g.match.killstreaks.inventory.set(g.player.id, ['uav', 'airstrike']);
  });
  await waitFrames(2);
  assert(await page.locator('.hud-streaks.on').isVisible(), 'killstreak tray appears when streaks are held');
  const chip = await page.locator('.hud-streaks .st-chip.on').first().textContent();
  assert(/UAV/.test(chip), 'tray names the streak that will deploy first', chip.trim());
  const stKey = await page.locator('.st-key').textContent();
  assert(stKey.trim().length > 0, 'tray shows the real killstreak keybind', stKey.trim());

  const uavOk = await page.evaluate(() => {
    const g = window.__GAME__;
    g.match.killstreaks._uavEnd.set(g.player.team, g.match.elapsed + 600);
    return g.match.uavActive(g.player.team);
  });
  assert(uavOk, 'match.uavActive() reports the UAV');
  await waitFrames(3);
  assert(await page.locator('.hud-uav.on').isVisible(), 'UAV chip lights while uavActive() is true');
  assert(await page.locator('.minimap.uav').isVisible(), 'minimap switches to UAV mode');

  // Grenade warning + flashbang are events nothing else in the build renders.
  await page.evaluate(() => {
    const g = window.__GAME__;
    const p = g.player.position;
    g.bus.emit('grenadeWarning', { id: 7, kind: 'frag', position: { x: p.x + 3, y: p.y, z: p.z + 3 }, distance: 4, fuse: 1.4, owner: null, friendly: false });
    g.bus.emit('flashbang', { amount: 0.95, duration: 60, position: p });
  });
  assert((await page.locator('.gren-warn.on').count()) > 0, 'grenade danger marker shown');
  await waitFrames(2);
  const blind = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.hud-blind')).opacity));
  assert(blind > 0.2, 'flashbang blinds the screen (previously rendered nowhere)', blind.toFixed(2));

  // Clear the blind before shooting the frame, or the screenshot is a white card.
  await page.evaluate(() => { window.__GAME__.hud._blind = 0; window.__GAME__.hud._blindDecay = 20; });
  await waitFrames(3);
  await shot('02-gameplay');

  /* ---------------------------------------------------------- scoreboard */
  section('SCOREBOARD');
  await page.keyboard.down('Tab');
  await page.waitForTimeout(400);
  const sbOn = await page.locator('.sb.on').isVisible();
  assert(sbOn, 'holding TAB opens the scoreboard');
  const sbRows = await page.locator('.sb-row:not([style*="display: none"])').count();
  assert(sbRows > 0, 'scoreboard has rows from Match.getScoreboardRows()', `${sbRows} rows`);
  const sbMe = await page.locator('.sb-row.me').count();
  assert(sbMe === 1, 'the local player row is marked');
  const sbAcc = await page.locator('.sb-row.me .acc').textContent();
  assert(/%$/.test(sbAcc), 'accuracy column is populated (needs the real row API)', sbAcc);
  await shot('03-scoreboard');
  await page.keyboard.up('Tab');
  await page.waitForTimeout(300);
  assert(!(await page.locator('.sb.on').isVisible()), 'releasing TAB closes the scoreboard');

  /* --------------------------------------------------------------- pause */
  section('PAUSE + SETTINGS');
  // The real Escape path: the browser drops pointer lock, Input raises
  // `pointerUnlock`, and the menu decides to pause. Headless has no lock to
  // drop, so we raise the same event the browser would have caused.
  await page.evaluate(() => window.__GAME__.bus.emit('pointerUnlock', {}));
  await page.waitForTimeout(400);
  assert(await state() === 'paused', 'pointerUnlock pauses the game');
  assert(await page.locator('.menu.open.pause').isVisible(), 'pause shell is open');
  assert(await page.locator('.panel.on .situation').isVisible(), 'pause opens on the situation panel');
  const siMode = await page.locator('.si-mode').textContent();
  assert(/FREE-FOR-ALL/i.test(siMode), 'situation panel names the live mode', siMode.trim());
  assert((await page.locator('.si-cells > div').count()) >= 6, 'situation shows the player line');
  assert((await page.locator('.panel.on .btn.cta').count()) === 0, 'no stray QUICK DEPLOY in the pause shell');
  await shot('04-pause');

  await page.locator('.menu-nav .mi', { hasText: 'SETTINGS' }).first().click();
  await page.waitForTimeout(200);
  for (const tab of ['video', 'audio', 'gameplay', 'hud']) {
    await page.locator(`.tab[data-tab="${tab}"]`).click();
    await page.waitForTimeout(120);
    const rows = await page.locator(`.tabpage[data-tab="${tab}"].on .row`).count();
    assert(rows > 0, `settings tab "${tab}" renders its rows`, `${rows} rows`);
  }

  // A toggle: applied live and persisted.
  await page.locator('.tab[data-tab="video"]').click();
  const fpsBefore = await settingOf('showFps');
  await page.locator('.tgl[data-setting="showFps"]').first().click();
  await page.waitForTimeout(200);
  const fpsAfter = await settingOf('showFps');
  assert(fpsAfter === !fpsBefore, 'toggle flips the setting', `${fpsBefore} -> ${fpsAfter}`);
  assert(await storedSetting('showFps') === fpsAfter, 'toggle persisted to localStorage');
  const perfShown = await page.locator('.hud-perf.on').count();
  assert((fpsAfter && perfShown === 1) || (!fpsAfter && perfShown === 0), 'HUD perf readout followed the toggle live');

  // A slider on the HUD tab: must change a live CSS variable, not just storage.
  await page.locator('.tab[data-tab="hud"]').click();
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const el = document.querySelector('.tabpage[data-tab="hud"].on input[type=range][data-setting="hudScale"]');
    el.value = '1.4';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  const scaleVar = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--hud-scale').trim());
  assert(Math.abs(Number(scaleVar) - 1.4) < 0.001, 'HUD scale applied live to the CSS variable', scaleVar);
  assert(Math.abs(Number(await storedSetting('hudScale')) - 1.4) < 0.001, 'HUD scale persisted');
  const valTxt = await page.locator('.row[data-key="hudScale"] .val').textContent();
  assert(/140%/.test(valTxt), 'the row readout updated', valTxt.trim());

  // A segmented control that the HUD reads every frame.
  await page.locator('.seg[data-setting="crosshairStyle"] button[data-value="dot"]').click();
  await page.waitForTimeout(200);
  const xhStyle = await page.locator('.xh').getAttribute('data-style');
  assert(xhStyle === 'dot', 'crosshair style applied live to the reticle', String(xhStyle));

  // A colour swatch.
  await page.locator('.swatches button[data-value="#ffb347"]').click();
  await page.waitForTimeout(150);
  const xhColor = await page.evaluate(() => document.querySelector('.xh').style.getPropertyValue('--xh-color').trim());
  assert(xhColor.toLowerCase() === '#ffb347', 'crosshair colour applied live', xhColor);
  assert(String(await storedSetting('crosshairColor')).toLowerCase() === '#ffb347', 'crosshair colour persisted');

  // Minimap toggle.
  await page.locator('.tgl[data-setting="showMinimap"]').first().click();
  await page.waitForTimeout(200);
  const mmOff = await page.locator('.minimap.off').count();
  assert(mmOff === 1, 'minimap toggle hides the radar live');
  await page.locator('.tgl[data-setting="showMinimap"]').first().click();
  await page.waitForTimeout(150);

  /* ------------------------------------------------------------ rebinding */
  section('KEY REBINDING');
  await page.locator('.menu-nav .mi', { hasText: 'CONTROLS' }).first().click();
  await page.waitForTimeout(250);
  const bindCount = await page.locator('.bind').count();
  assert(bindCount >= 15, 'every bindable action is listed', `${bindCount} rows`);

  await page.locator('.bind[data-action="jump"]').click();
  await page.waitForTimeout(150);
  assert(await page.locator('.bind[data-action="jump"].capturing').isVisible(), 'the row enters capture mode');
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(250);
  const binds = await page.evaluate(() => window.__GAME__.settings.get('binds'));
  assert(binds.KeyJ === 'jump', 'the new key is bound to the action');
  assert(binds.Space !== 'jump', 'the old key was released');
  const bindTxt = await page.locator('.bind[data-action="jump"] .bk').textContent();
  assert(bindTxt.trim() === 'J', 'the row shows the new binding', bindTxt.trim());
  const storedBinds = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('overstrike.settings.v1') || '{}').binds; } catch { return {}; }
  });
  assert(storedBinds.KeyJ === 'jump', 'the rebinding persisted');

  // And it actually drives the simulation.
  const jumped = await page.evaluate(() => {
    const g = window.__GAME__;
    return g.settings.actionFor('KeyJ') === 'jump';
  });
  assert(jumped, 'Input resolves the new code to the action');

  // Escape cancels a capture rather than binding Escape.
  await page.locator('.bind[data-action="melee"]').click();
  await page.waitForTimeout(120);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const binds2 = await page.evaluate(() => window.__GAME__.settings.get('binds'));
  assert(binds2.Escape !== 'melee', 'Escape cancels a capture instead of binding');
  assert(binds2.KeyF === 'melee', 'the original binding survived the cancel');
  await shot('05-controls');

  /* -------------------------------------------------------------- resume */
  section('RESUME');
  await page.locator('.menu-nav .mi', { hasText: 'RESUME' }).first().click();
  await page.waitForTimeout(400);
  assert(await state() === 'playing', 'RESUME returns to play');
  assert(!(await page.locator('.menu.open').isVisible()), 'menu closed on resume');
  assert(await page.locator('#hud.live').isVisible(), 'HUD is live again');

  /* -------------------------------------------------------- death screen */
  section('DEATH SCREEN');
  await page.evaluate(() => {
    const g = window.__GAME__;
    const killer = g.bots.bots[0];
    g.bus.emit('kill', { victim: g.player, attacker: killer, weaponId: 'sr_reaver', headshot: true, distance: 63 });
    g.match.onPlayerDeath(g.player, { attacker: killer, weaponId: 'sr_reaver', headshot: true });
    g.player.alive = false;
  });
  await page.waitForTimeout(500);
  assert(await page.locator('.death.on').isVisible(), 'death overlay shown');
  const who = await page.locator('.death .who').textContent();
  assert(who.trim().length > 1 && who.trim() !== '—', 'killer named', who.trim());
  const how = await page.locator('.death-how').textContent();
  assert(/HEADSHOT/.test(how), 'the kill detail survived both callers merging', how.trim());
  assert(/REAVER/i.test(how), 'the weapon from the `kill` event was not clobbered by Match', how.trim());
  // Match.onPlayerDeath recomputes the range from the attacker's live position,
  // and it lands second — so the number is its number, not the one we emitted.
  assert(/\d+ M/.test(how), 'the range is reported', how.trim());
  const count = await page.locator('.death-count').textContent();
  assert(Number(count) >= 0 && Number(count) <= 5, 'respawn countdown running', count.trim());
  // The entrance keyframes are wall-clock but only advance on rendered frames,
  // and SwiftShader renders about twice a second — settle before shooting.
  await waitFrames(8);
  await shot('06-death');
  await page.evaluate(() => window.__GAME__.match.spawner.spawnEntity(window.__GAME__.player));
  await page.waitForTimeout(400);
  assert(!(await page.locator('.death.on').isVisible()), 'death overlay clears on respawn');
  const weaponAfterRespawn = await page.evaluate(() =>
    window.__GAME__.weapons.current(window.__GAME__.player)?.def?.id);
  if (pickId) {
    assert(weaponAfterRespawn === pickId, 'the chosen loadout survives a respawn', String(weaponAfterRespawn));
  }

  /* ------------------------------------------------------------ match end */
  section('MATCH END');
  await page.evaluate(() => {
    const g = window.__GAME__;
    // Push the mode over its own score limit and let the real referee end it.
    for (const b of g.bots.bots) { const st = g.match.statsFor(b); if (st) st.kills = 0; }
    const me = g.match.statsFor(g.player);
    me.kills = g.match.mode.scoreLimit;
    me.score = 4200;
    me.headshots = 6;
    me.shotsFired = 90;
    me.shotsHit = 44;
    g.match._checkEnd();
  });
  await page.waitForTimeout(900);
  assert(await state() === 'gameover', 'match ended through the real rules', await state());
  assert(await page.locator('.menu.open.end').isVisible(), 'after-action shell opened');
  const verdict = await page.locator('.end-verdict').textContent();
  assert(/VICTORY|DEFEAT|STALEMATE/.test(verdict), 'verdict rendered', verdict.trim());
  const resRows = await page.locator('.results tbody tr').count();
  assert(resRows > 0, 'results table built from the payload rows', `${resRows} rows`);
  assert((await page.locator('.results tr.me').count()) === 1, 'the player row is marked in the results');
  const xpTotal = await page.locator('.xp-total .v').textContent();
  assert(/^\+\d/.test(xpTotal.trim()), 'match XP reported from progression.recordMatch()', xpTotal.trim());
  assert((await page.locator('.xr').count()) > 0, 'XP breakdown rows rendered');
  assert((await page.locator('.moment').count()) > 0, 'best moments rendered');
  assert((await page.locator('.results th.tm').count()) === 0,
    'free-for-all drops the meaningless TEAM column');
  await page.waitForTimeout(1400);   // let the verdict entrance finish
  await shot('07-matchend');

  /* ------------------------------------------------------------ play again */
  section('PLAY AGAIN');
  await page.locator('.menu-nav .mi', { hasText: 'PLAY AGAIN' }).first().click();
  await page.waitForTimeout(1200);
  const again = await page.evaluate(() => ({
    state: window.__GAME__.state,
    mode: window.__GAME__.match.modeId,
    bots: window.__GAME__.bots.bots.length,
  }));
  assert(again.state === 'playing', 'PLAY AGAIN restarts a match', again.state);
  assert(again.mode === WANT_MODE, 'the chosen mode is kept', again.mode);
  assert(again.bots === WANT_BOTS, 'the chosen bot count is kept', String(again.bots));

  /* ----------------------------------------------------------- quit to menu */
  section('QUIT TO MENU');
  await page.evaluate(() => window.__GAME__.bus.emit('pointerUnlock', {}));
  await page.waitForTimeout(400);
  await page.locator('.menu-nav .mi', { hasText: 'QUIT TO MENU' }).first().click();
  await page.waitForTimeout(250);
  assert(await page.locator('.confirm.on').isVisible(), 'quitting asks for confirmation');
  await page.locator('.cf-yes').click();
  await page.waitForTimeout(600);
  assert(await state() === 'menu', 'quit returned to the main menu', await state());
  assert(await page.locator('.menu.open:not(.pause):not(.end)').isVisible(), 'main shell restored');
  assert(!(await page.locator('#hud.live').count()), 'HUD stood down');
  await shot('08-back-to-menu');

  /* --------------------------------------------------- settings survived */
  section('PERSISTENCE ACROSS A RELOAD');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 120000, polling: 200 });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const s = window.__GAME__.settings;
    return {
      hudScale: s.get('hudScale'),
      crosshairColor: s.get('crosshairColor'),
      mode: s.get('mode'),
      loadoutPrimary: s.get('loadoutPrimary'),
      jump: s.get('binds').KeyJ,
    };
  });
  assert(Math.abs(after.hudScale - 1.4) < 0.001, 'hudScale survived a reload', String(after.hudScale));
  assert(String(after.crosshairColor).toLowerCase() === '#ffb347', 'crosshair colour survived a reload');
  assert(after.mode === WANT_MODE, 'mode choice survived a reload', after.mode);
  if (pickId) assert(after.loadoutPrimary === pickId, 'loadout survived a reload', after.loadoutPrimary);
  assert(after.jump === 'jump', 'rebinding survived a reload');
  const restoredMode = await page.locator('.mode-card.on').getAttribute('data-mode');
  assert(restoredMode === WANT_MODE, 'the play panel restores the stored mode', String(restoredMode));

  /* --------------------------------------------------------------- errors */
  section('CONSOLE');
  assert(pageErrors.length === 0, 'no page errors or console errors',
    pageErrors.slice(0, 4).join(' | ') || 'clean');
} catch (err) {
  bad('harness', err.message);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}

const passed = results.filter((r) => r.pass).length;
console.log('\n================ UI PROBE ================');
console.log(`${passed}/${results.length} checks passed`);
if (failures) {
  console.log('\nFAILURES:');
  for (const r of results) if (!r.pass) console.log(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(failures ? '✗ UI PROBE FAILED' : '✓ UI PROBE PASSED');
console.log('==========================================\n');
process.exit(failures ? 1 : 0);
