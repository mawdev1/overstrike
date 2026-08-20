import {
  BINDING_ACTIONS,
  BINDINGS_BY_ID,
  SETTINGS_BY_KEY,
  SETTINGS_CATEGORIES,
  SETTINGS_SCOPES,
  bindingCodeLabel,
  formatSettingValue,
} from './inventory.js';
import { createSettingsController, sanitizeSessionDiagnostics } from './controller.js';

// These values are fully validated/persisted/roamed, but the current local-practice engine has
// no truthful consumer for them yet. Keep the controls usable for account portability while
// labelling that boundary instead of pretending the legacy runtime applies them live.
const LOCAL_RUNTIME_PENDING = new Set([
  'cameraShake', 'viewBob', 'weaponSway', 'brightness', 'flashIntensity',
  'screenEffectIntensity', 'filmGrain', 'motionBlur', 'uiVolume', 'announcerVolume', 'subtitles',
  'closedCaptions', 'subtitleSize', 'captionBackground', 'captionDirection',
  'crosshairOpacity', 'crosshairSize', 'crosshairThickness', 'crosshairGap',
  'crosshairOutline', 'hudTextSize', 'minimapRotation', 'showKillfeed',
  'showObjectiveMarkers', 'damageVignette', 'colorVisionPreset',
  'networkDiagnosticsOverlay',
]);

// These bindings are part of the roaming control document, but their gameplay/chat/spectator
// adapters arrive in later phases. Persist them without claiming that today's runtime consumes
// them live.
const LOCAL_RUNTIME_PENDING_ACTIONS = new Set([
  'tacticalEquipment', 'textChat', 'teamChat', 'tacticalPing',
  'muteCurrentTarget', 'spectatePrevious', 'spectateNext',
]);

const STYLES = `
.os-settings{color:var(--os-fg,#f3f7f6);background:var(--os-panel,#111b1b);font:500 1rem/1.45 system-ui,sans-serif;max-width:76rem;margin:auto;padding:clamp(1rem,3vw,2rem)}
.os-settings *{box-sizing:border-box}.os-settings button,.os-settings input,.os-settings select{font:inherit}
.os-settings button,.os-settings input,.os-settings select{min-height:44px}.os-settings button{border:1px solid #58716c;border-radius:.35rem;background:#172724;color:inherit;padding:.55rem .8rem;cursor:pointer}
.os-settings button:hover,.os-settings button:focus-visible{border-color:#8ef7c4}.os-settings button[aria-pressed=true],.os-settings .os-primary{background:#8ef7c4;color:#082019;border-color:#8ef7c4}
.os-settings :focus-visible{outline:3px solid #ffd166;outline-offset:2px}.os-settings__header{display:flex;align-items:end;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.os-settings h1,.os-settings h2,.os-settings h3{line-height:1.12;margin:.25rem 0 .75rem}.os-settings__lede{color:#bed0cb;max-width:55ch}
.os-settings__search{display:grid;gap:.3rem;min-width:min(100%,19rem)}.os-settings__search input,.os-setting select,.os-setting input[type=number],.os-setting input[type=text]{background:#081312;border:1px solid #58716c;border-radius:.3rem;color:inherit;padding:.55rem}
.os-settings__status{border-left:.3rem solid #ffd166;background:#263023;padding:.75rem 1rem;margin:1rem 0}.os-settings__status[data-kind=conflict]{border-color:#ff8177}.os-settings__status[data-kind=synced]{border-color:#8ef7c4}
.os-settings__tabs{display:flex;gap:.45rem;overflow:auto;padding:.75rem .15rem;margin:1rem 0}.os-settings__layout{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem}
.os-settings__toolbar{display:flex;align-items:center;justify-content:space-between;gap:.75rem;flex-wrap:wrap}.os-settings__list{display:grid;gap:.7rem}
.os-setting{background:#152220;border:1px solid #304642;border-radius:.45rem;padding:1rem;display:grid;grid-template-columns:minmax(12rem,1fr) minmax(15rem,1fr);align-items:center;gap:1rem}
.os-setting__name{font-weight:750}.os-setting__meta{display:flex;gap:.45rem;align-items:center;flex-wrap:wrap;color:#bed0cb;font-size:.88rem}.os-scope{border:1px solid #58716c;border-radius:99px;padding:.1rem .5rem}
.os-setting__control{display:flex;align-items:center;justify-content:flex-end;gap:.55rem;flex-wrap:wrap}.os-setting__control input[type=range]{min-width:10rem;flex:1}.os-setting__value{min-width:4.5rem;text-align:right;font-variant-numeric:tabular-nums}
.os-setting__reset{min-width:44px}.os-binding__slots{display:flex;justify-content:flex-end;gap:.45rem;flex-wrap:wrap}.os-binding__slot{min-width:8.5rem}.os-binding__slot[data-unbound=true]{border-style:dashed;color:#bed0cb}
.os-settings__empty,.os-diagnostics{border:1px dashed #58716c;border-radius:.45rem;padding:1.2rem;color:#bed0cb}.os-capture{position:sticky;bottom:1rem;z-index:2;border:2px solid #8ef7c4;background:#081312;padding:1rem;display:flex;justify-content:space-between;align-items:center;gap:1rem}
.os-dialog-backdrop{position:fixed;inset:0;z-index:20;background:#000b;display:grid;place-items:center;padding:1rem}.os-dialog{width:min(32rem,100%);background:#111b1b;border:2px solid #8ef7c4;border-radius:.5rem;padding:1.25rem;box-shadow:0 1rem 4rem #000}
.os-dialog__actions{display:flex;justify-content:flex-end;gap:.5rem;flex-wrap:wrap;margin-top:1rem}.os-settings__danger{border-color:#ff8177!important}.os-settings__sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@media(max-width:700px){.os-setting{grid-template-columns:1fr}.os-setting__control,.os-binding__slots{justify-content:flex-start}.os-settings__tabs{scroll-snap-type:x mandatory}.os-settings__tabs button{scroll-snap-align:start;white-space:nowrap}}
@media(prefers-reduced-motion:reduce){.os-settings *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function optionLabel(value) {
  return formatSettingValue({ type: 'enum' }, value);
}

function scopeBadge(scope) {
  const label = SETTINGS_SCOPES[scope]?.label || scope;
  return `<span class="os-scope" title="Storage scope: ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function settingControl(definition, value, enabled, id) {
  const disabled = !enabled || definition.readOnly ? ' disabled' : '';
  const accessibleName = `${definition.label}. Current value ${formatSettingValue(definition, value)}`;
  if (definition.type === 'boolean') {
    return `<label><input data-setting="${definition.key}" data-focus-key="setting-${definition.key}" type="checkbox" aria-label="${escapeHtml(accessibleName)}"${value ? ' checked' : ''}${disabled}> <span>${value ? 'On' : 'Off'}</span></label>`;
  }
  if (definition.type === 'enum') {
    return `<select id="${id}" data-setting="${definition.key}" data-focus-key="setting-${definition.key}" aria-label="${escapeHtml(accessibleName)}"${disabled}>${definition.options.map((option) => `<option value="${escapeHtml(option)}"${option === value ? ' selected' : ''}>${escapeHtml(optionLabel(option))}</option>`).join('')}</select>`;
  }
  if (definition.type === 'color') {
    return `<input id="${id}" data-setting="${definition.key}" data-focus-key="setting-${definition.key}" type="color" value="${escapeHtml(value)}" aria-label="${escapeHtml(accessibleName)}"${disabled}><input data-setting="${definition.key}" type="text" size="8" maxlength="7" value="${escapeHtml(value)}" aria-label="${escapeHtml(`${definition.label} hexadecimal value. Current value ${value}`)}"${disabled}>`;
  }
  return `<input id="${id}" data-setting="${definition.key}" data-focus-key="setting-${definition.key}" type="range" min="${definition.min}" max="${definition.max}" step="${definition.step}" value="${value}" aria-label="${escapeHtml(accessibleName)}" aria-valuemin="${definition.min}" aria-valuemax="${definition.max}" aria-valuenow="${value}" aria-valuetext="${escapeHtml(formatSettingValue(definition, value))}"${disabled}><input data-setting="${definition.key}" type="number" min="${definition.min}" max="${definition.max}" step="${definition.step}" value="${value}" aria-label="${escapeHtml(`${definition.label}. Current value ${formatSettingValue(definition, value)}. Minimum ${definition.min}, maximum ${definition.max}`)}"${disabled}><output class="os-setting__value" for="${id}">${escapeHtml(formatSettingValue(definition, value))}</output>`;
}

function renderSetting(definition, snapshot) {
  const value = snapshot.byScope[definition.scope][definition.key];
  const enabled = !definition.enabledWhen
    || snapshot.values[definition.enabledWhen.key] === definition.enabledWhen.equals;
  const id = `os-setting-${definition.key}`;
  const runtimeNote = LOCAL_RUNTIME_PENDING.has(definition.key)
    ? '<span role="status">Saved now; local-practice preview pending.</span>'
    : '';
  return `
    <div class="os-setting" data-setting-row="${definition.key}">
      <div>
        <div class="os-setting__name" id="${id}-label">${escapeHtml(definition.label)}</div>
        <div class="os-setting__meta">${scopeBadge(definition.scope)}<span>${escapeHtml(definition.key)}</span>${definition.readOnly ? '<span>Fixed</span>' : ''}${runtimeNote}${!enabled && definition.enabledWhen ? `<span role="status">Unavailable while ${escapeHtml(SETTINGS_BY_KEY[definition.enabledWhen.key]?.label || definition.enabledWhen.key)} is off.</span>` : ''}</div>
      </div>
      <div class="os-setting__control" aria-labelledby="${id}-label">
        ${settingControl(definition, value, enabled, id)}
        <button class="os-setting__reset" data-reset-key="${definition.key}" data-focus-key="reset-${definition.key}" aria-label="Reset ${escapeHtml(definition.label)}" title="Reset control"${definition.readOnly ? ' disabled' : ''}>↺</button>
      </div>
    </div>`;
}

function renderBinding(action, snapshot) {
  const value = snapshot.bindings[action.id];
  const fixed = Boolean(action.fixed);
  const runtimeNote = LOCAL_RUNTIME_PENDING_ACTIONS.has(action.id)
    ? '<span role="status">Saved now; live adapter pending.</span>'
    : '';
  return `
    <div class="os-setting" data-binding-row="${action.id}">
      <div>
        <div class="os-setting__name" id="os-binding-${action.id}">${escapeHtml(action.label)}${action.required ? '<span class="os-settings__sr">, required action</span>' : ''}</div>
        <div class="os-setting__meta">${scopeBadge('ROAM')}${fixed ? '<span>Fixed</span>' : ''}${runtimeNote}</div>
      </div>
      <div class="os-binding__slots" aria-labelledby="os-binding-${action.id}">
        ${['primary', 'secondary'].map((slot) => `
          <button class="os-binding__slot" data-capture-action="${action.id}" data-capture-slot="${slot}" data-focus-key="binding-${action.id}-${slot}" data-unbound="${!value[slot]}"${fixed ? ' disabled' : ''}>
            <span class="os-settings__sr">${slot} binding: </span>${escapeHtml(bindingCodeLabel(value[slot]))}
          </button>
          <button data-clear-action="${action.id}" data-clear-slot="${slot}" data-focus-key="clear-${action.id}-${slot}" aria-label="Clear ${escapeHtml(action.label)} ${slot} binding"${fixed || !value[slot] ? ' disabled' : ''}>×</button>
        `).join('')}
        <button data-reset-binding="${action.id}" aria-label="Reset ${escapeHtml(action.label)} bindings"${fixed ? ' disabled' : ''}>↺</button>
      </div>
    </div>`;
}

function statusMarkup(snapshot) {
  const { status, lastError } = snapshot.sync;
  if (!snapshot.storageAvailable) {
    return '<div class="os-settings__status" role="status">Device storage is unavailable. Changes last only for this tab.</div>';
  }
  if (status === 'offline-unsynced') {
    return '<div class="os-settings__status" role="status"><strong>Offline — changes not synced.</strong> Your account settings remain saved on this device and will need syncing when you reconnect.</div>';
  }
  if (status === 'unsynced') {
    return `<div class="os-settings__status" role="status"><strong>Account changes not synced.</strong> ${escapeHtml(lastError || '')} <button data-sync>Try again</button></div>`;
  }
  if (status === 'syncing') return '<div class="os-settings__status" role="status">Syncing account settings…</div>';
  if (status === 'conflict') return '<div class="os-settings__status" data-kind="conflict" role="alert"><strong>Settings changed elsewhere.</strong> Choose which account settings to keep. <button data-sync-choice="keep-local">Keep mine</button> <button data-sync-choice="use-server">Use server version</button></div>';
  return '<div class="os-settings__status" data-kind="synced" role="status">Account settings synced.</div>';
}

function diagnosticsMarkup(snapshot) {
  const diagnostics = snapshot.byScope.SESSION.diagnostics;
  if (!diagnostics) {
    return `<div class="os-diagnostics" data-diagnostics-unavailable>
      <h3>Connection measurements unavailable</h3>${scopeBadge('SESSION')}
      <p>Latency, packet loss, jitter, server region, and tick rate will appear only after measured P2 diagnostics are supplied. No estimated values are shown.</p>
      <button disabled title="Measured diagnostics are unavailable">Copy diagnostics</button>
    </div>`;
  }
  const allowed = [
    ['region', 'Region', ''],
    ['rttMs', 'RTT', ' ms'],
    ['jitterMs', 'Jitter', ' ms'],
    ['lossPct', 'Packet loss', '%'],
    ['correctionRatePerSec', 'Correction rate', '/s'],
    ['correctionMagnitudeM', 'Correction magnitude (p95)', ' m'],
    ['snapshotAgeMs', 'Snapshot age', ' ms'],
    ['receiveRateHz', 'Snapshot receive rate', ' Hz'],
    ['baselineState', 'Baseline state', ''],
    ['windowMs', 'Measurement window', ' ms'],
    ['sampledAt', 'Sampled at (monotonic)', ' ms'],
    ['serverBuild', 'Server build', ''],
    ['protocolVersion', 'Protocol version', ''],
    ['keyframes', 'Keyframes', ''],
    ['discarded', 'Discarded snapshots', ''],
  ];
  const rows = allowed.filter(([key]) => diagnostics[key] !== undefined && diagnostics[key] !== null);
  if (!rows.length) return '<div class="os-diagnostics" data-diagnostics-unavailable>Measured diagnostics have not arrived yet. No estimated values are shown.</div>';
  return `<div class="os-diagnostics"><h3>Measured connection</h3>${scopeBadge('SESSION')}<dl>${rows.map(([key, label, unit]) => `<dt>${label}</dt><dd>${escapeHtml(diagnostics[key])}${unit}</dd>`).join('')}</dl><button data-copy-diagnostics>Copy measured diagnostics</button></div>`;
}

function dialogMarkup(snapshot, pendingReset) {
  if (snapshot.bindingConflict) {
    const conflict = snapshot.bindingConflict;
    const target = BINDINGS_BY_ID[conflict.actionId];
    const other = BINDINGS_BY_ID[conflict.otherActionId];
    const otherSlot = conflict.otherSlot === 'primary' ? 'secondary' : 'primary';
    const requiredWarning = other.required && !snapshot.bindings[other.id][otherSlot]
      ? `<p role="alert"><strong>Warning:</strong> Unbinding ${escapeHtml(other.label)}${conflict.previousCode ? '' : ' — including by swapping from an empty slot'} leaves a required action with no usable input.</p>`
      : '';
    return `<div class="os-dialog-backdrop"><div class="os-dialog" role="alertdialog" aria-modal="true" aria-labelledby="os-conflict-title" data-dialog>
      <h2 id="os-conflict-title">Binding already in use</h2>
      <p><strong>${escapeHtml(bindingCodeLabel(conflict.code))}</strong> is assigned to ${escapeHtml(other.label)}. Resolve the conflict for ${escapeHtml(target.label)}.</p>
      ${requiredWarning}
      <div class="os-dialog__actions">
        <button data-binding-choice="CANCEL">Cancel</button>
        <button data-binding-choice="UNBIND_OTHER">Unbind other</button>
        <button class="os-primary" data-binding-choice="SWAP">Swap</button>
      </div>
    </div></div>`;
  }
  if (snapshot.requiredUnbind) {
    const action = BINDINGS_BY_ID[snapshot.requiredUnbind.actionId];
    return `<div class="os-dialog-backdrop"><div class="os-dialog" role="alertdialog" aria-modal="true" aria-labelledby="os-required-title" data-dialog>
      <h2 id="os-required-title">Leave required action unbound?</h2>
      <p>${escapeHtml(action.label)} is required for play. You can continue, but should bind it again before starting a match.</p>
      <div class="os-dialog__actions"><button data-cancel-required>Cancel</button><button class="os-settings__danger" data-confirm-required>Unbind anyway</button></div>
    </div></div>`;
  }
  if (pendingReset) {
    const count = pendingReset.preview.changes.length;
    const labels = pendingReset.preview.scopes.map((scope) => SETTINGS_SCOPES[scope]?.label || scope).join(', ');
    return `<div class="os-dialog-backdrop"><div class="os-dialog" role="alertdialog" aria-modal="true" aria-labelledby="os-reset-title" data-dialog>
      <h2 id="os-reset-title">Reset settings?</h2>
      <p>${count ? `${count} control${count === 1 ? '' : 's'} will reset. Affected storage: ${escapeHtml(labels)}.` : 'These controls already use their defaults.'}</p>
      <div class="os-dialog__actions"><button data-reset-cancel>Cancel</button>${count ? '<button class="os-settings__danger" data-reset-confirm>Reset</button>' : ''}</div>
    </div></div>`;
  }
  return '';
}

export function createSettingsScreen(input = {}) {
  const options = input && typeof input.getSnapshot === 'function' ? { controller: input } : input;
  const documentRef = options.document || globalThis.document;
  if (!documentRef?.createElement) throw new Error('createSettingsScreen requires a DOM document.');
  const controller = options.controller || createSettingsController(options.controllerOptions);
  const ownsController = !options.controller;
  const headingLevel = [1, 2, 3].includes(options.headingLevel) ? options.headingLevel : 1;
  const root = documentRef.createElement('section');
  root.className = 'os-settings';
  root.dataset.settingsScreen = '';
  root.setAttribute('aria-labelledby', 'os-settings-title');
  let current = controller.getSnapshot();
  let pendingReset = null;
  let unsubscribe = null;
  let destroyed = false;
  let hadDialog = false;
  let dialogOpenerKey = null;

  function rememberFocus() {
    const active = documentRef.activeElement;
    if (!root.contains(active)) return null;
    return {
      key: active.dataset?.focusKey || active.id || null,
      selectionStart: active.selectionStart,
      selectionEnd: active.selectionEnd,
    };
  }

  function restoreFocus(saved) {
    if (root.querySelector('[data-dialog]')) {
      root.querySelector('[data-dialog] button')?.focus();
      return;
    }
    if (!saved?.key) return;
    const candidate = root.querySelector(`[data-focus-key="${CSS.escape(saved.key)}"],#${CSS.escape(saved.key)}`);
    candidate?.focus({ preventScroll: true });
    if (candidate?.setSelectionRange && Number.isInteger(saved.selectionStart)) {
      candidate.setSelectionRange(saved.selectionStart, saved.selectionEnd);
    }
  }

  function render() {
    const focused = rememberFocus();
    const category = SETTINGS_CATEGORIES.find((item) => item.id === current.category) || SETTINGS_CATEGORIES[0];
    const list = [
      ...current.visibleSettings.map((definition) => renderSetting(definition, current)),
      ...current.visibleBindings.map((action) => renderBinding(action, current)),
    ].join('');
    root.innerHTML = `
      <style>${STYLES}</style>
      <div class="os-settings__header">
        <div><h${headingLevel} id="os-settings-title" tabindex="-1">Settings</h${headingLevel}><p class="os-settings__lede">Tune controls and presentation without mixing account, device, session, or practice-only choices.</p></div>
        <label class="os-settings__search">Search settings and bindings<input data-settings-search data-focus-key="settings-search" type="search" value="${escapeHtml(current.search)}" autocomplete="off"></label>
      </div>
      ${statusMarkup(current)}
      ${current.notice ? `<p role="status">${escapeHtml(current.notice)}</p>` : ''}
      <nav class="os-settings__tabs" aria-label="Settings categories">${SETTINGS_CATEGORIES.map((item) => `<button data-category="${item.id}" data-focus-key="category-${item.id}" aria-pressed="${!current.search && item.id === current.category}">${escapeHtml(item.label)}</button>`).join('')}</nav>
      <div class="os-settings__layout">
        <div class="os-settings__toolbar">
          <div><h2>${current.search ? 'Search results' : escapeHtml(category.label)}</h2><p>${current.search ? `Matches for “${escapeHtml(current.search)}”` : escapeHtml(category.description)}</p></div>
          <div><button data-reset-category data-focus-key="reset-category">Reset category</button> <button data-reset-all data-focus-key="reset-all">Reset all</button></div>
        </div>
        ${current.category === 'accessibility' && !current.search ? '<p><button data-reduced-motion-preset>Apply reduced-motion preset</button></p>' : ''}
        <div class="os-settings__list">${list || '<p class="os-settings__empty">No settings or bindings match this search.</p>'}</div>
        ${current.category === 'network' && !current.search ? diagnosticsMarkup(current) : ''}
      </div>
      ${current.capture ? `<div class="os-capture" role="status"><span>Press a key, mouse button, or wheel direction for <strong>${escapeHtml(BINDINGS_BY_ID[current.capture.actionId].label)}</strong>.${current.capture.error ? ` ${escapeHtml(current.capture.error)}` : ''}</span><button data-capture-cancel>Cancel</button></div>` : ''}
      ${dialogMarkup(current, pendingReset)}
    `;
    restoreFocus(focused);
  }

  function requestReset(request) {
    dialogOpenerKey = documentRef.activeElement?.dataset?.focusKey || null;
    pendingReset = { request, preview: controller.previewReset(request) };
    hadDialog = true;
    render();
  }

  root.addEventListener('input', (event) => {
    if (event.target.matches('[data-settings-search]')) controller.setSearch(event.target.value);
  });
  root.addEventListener('change', (event) => {
    const key = event.target.dataset.setting;
    if (!key) return;
    const definition = SETTINGS_BY_KEY[key];
    let value = event.target.value;
    if (definition.type === 'boolean') value = event.target.checked;
    if (definition.type === 'number') value = Number(value);
    const result = controller.set(key, value);
    if (!result.ok) render();
  });
  root.addEventListener('click', async (event) => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.category) controller.setCategory(target.dataset.category);
    else if (target.dataset.resetKey) requestReset({ key: target.dataset.resetKey });
    else if (target.hasAttribute('data-reset-category')) requestReset({ category: current.category });
    else if (target.hasAttribute('data-reset-all')) requestReset({});
    else if (target.dataset.captureAction) controller.beginCapture(target.dataset.captureAction, target.dataset.captureSlot);
    else if (target.dataset.clearAction) controller.clearBinding(target.dataset.clearAction, target.dataset.clearSlot);
    else if (target.dataset.resetBinding) controller.resetBinding(target.dataset.resetBinding);
    else if (target.dataset.bindingChoice) controller.resolveBindingConflict(target.dataset.bindingChoice);
    else if (target.hasAttribute('data-capture-cancel')) controller.cancelCapture();
    else if (target.hasAttribute('data-confirm-required')) {
      const request = current.requiredUnbind;
      controller.clearBinding(request.actionId, request.slot, { confirmRequired: true });
    } else if (target.hasAttribute('data-cancel-required')) controller.cancelRequiredUnbind();
    else if (target.hasAttribute('data-reset-confirm')) {
      controller.reset(pendingReset.request);
      pendingReset = null;
      hadDialog = false;
      render();
      if (dialogOpenerKey) root.querySelector(`[data-focus-key="${CSS.escape(dialogOpenerKey)}"]`)?.focus();
    } else if (target.hasAttribute('data-reset-cancel')) {
      pendingReset = null;
      hadDialog = false;
      render();
      if (dialogOpenerKey) root.querySelector(`[data-focus-key="${CSS.escape(dialogOpenerKey)}"]`)?.focus();
    } else if (target.hasAttribute('data-reduced-motion-preset')) controller.applyReducedMotionPreset();
    else if (target.hasAttribute('data-sync')) await controller.sync();
    else if (target.dataset.syncChoice) controller.resolveSyncConflict(target.dataset.syncChoice);
    else if (target.hasAttribute('data-copy-diagnostics')) {
      const diagnostics = sanitizeSessionDiagnostics(current.byScope.SESSION.diagnostics);
      const text = JSON.stringify(diagnostics, null, 2);
      try { await globalThis.navigator?.clipboard?.writeText(text); } catch {}
    }
  });

  root.addEventListener('keydown', (event) => {
    const dialog = root.querySelector('[data-dialog]');
    if (!dialog) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (current.bindingConflict) controller.resolveBindingConflict('CANCEL');
      else if (current.requiredUnbind) controller.cancelRequiredUnbind();
      else if (pendingReset) {
        pendingReset = null;
        hadDialog = false;
        render();
        if (dialogOpenerKey) root.querySelector(`[data-focus-key="${CSS.escape(dialogOpenerKey)}"]`)?.focus();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[href]')];
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && documentRef.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && documentRef.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  function captureKeyboard(event) {
    if (!current.capture) return;
    event.preventDefault();
    event.stopPropagation();
    controller.handleCaptureInput(event);
  }
  function captureMouse(event) {
    if (!current.capture) return;
    if (event.target?.closest?.('[data-capture-cancel]')) return;
    event.preventDefault();
    event.stopPropagation();
    controller.handleCaptureInput(event);
  }
  function captureWheel(event) {
    if (!current.capture) return;
    event.preventDefault();
    event.stopPropagation();
    controller.handleCaptureInput(event);
  }
  const windowRef = documentRef.defaultView;
  windowRef?.addEventListener('keydown', captureKeyboard, true);
  windowRef?.addEventListener('mousedown', captureMouse, true);
  windowRef?.addEventListener('wheel', captureWheel, { capture: true, passive: false });

  unsubscribe = controller.subscribe((snapshot) => {
    const nextHasDialog = Boolean(snapshot.bindingConflict || snapshot.requiredUnbind || pendingReset);
    if (!hadDialog && nextHasDialog) {
      dialogOpenerKey = documentRef.activeElement?.dataset?.focusKey || dialogOpenerKey;
    }
    const shouldRestore = hadDialog && !nextHasDialog;
    current = snapshot;
    render();
    if (shouldRestore && dialogOpenerKey) {
      root.querySelector(`[data-focus-key="${CSS.escape(dialogOpenerKey)}"]`)?.focus();
      dialogOpenerKey = null;
    }
    hadDialog = nextHasDialog;
  });

  const screen = {
    element: root,
    el: root,
    controller,
    mount(container) {
      container.replaceChildren(root);
      root.querySelector('h1,h2,h3')?.focus?.({ preventScroll: true });
      return screen;
    },
    focus() {
      const heading = root.querySelector('h1,h2,h3');
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
    },
    render,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe?.();
      windowRef?.removeEventListener('keydown', captureKeyboard, true);
      windowRef?.removeEventListener('mousedown', captureMouse, true);
      windowRef?.removeEventListener('wheel', captureWheel, true);
      if (ownsController) controller.destroy();
      root.remove();
    },
  };
  return screen;
}
