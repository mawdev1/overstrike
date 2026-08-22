import { projectRaidPresentation } from './model.js';

/**
 * Escaped, semantic raid HUD markup — the same render discipline as `src/ui/bomb/view.js`:
 * every dynamic value is HTML-escaped before interpolation, and the mount updater below only
 * ever receives markup produced by that escaping path, never caller-supplied HTML.
 */
const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const attr = escapeHtml;

function inventoryMarkup(inventory) {
  const rows = inventory.items.map((item) => `<li class="raid-inventory__item" data-rarity="${attr(item.rarityTier)}" data-source="${attr(item.source)}">
    <span class="raid-inventory__name">${escapeHtml(item.name)}</span>
    ${item.quantityLabel ? `<span class="raid-inventory__qty">${escapeHtml(item.quantityLabel)}</span>` : ''}
    <span class="raid-inventory__source">${item.source === 'loadout' ? 'BROUGHT IN' : 'LOOTED'}</span>
  </li>`).join('');
  return `<section class="raid-inventory" aria-label="Run inventory">
    <h3>CARRYING</h3>
    <ul>${rows || '<li class="raid-inventory__empty">Nothing carried yet.</li>'}</ul>
    <p class="raid-inventory__capacity">${escapeHtml(inventory.capacityLabel)}</p>
  </section>`;
}

function exitMarkup(exit) {
  const distance = exit.distanceM === null ? '' : ` · ${Math.round(exit.distanceM)} M`;
  const requirements = exit.requirements.length
    ? `<ul class="raid-exit__requirements">${exit.requirements.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
    : '';
  return `<li class="raid-exit" data-exit="${attr(exit.id)}" data-state="${attr(exit.state)}">
    <strong>${escapeHtml(exit.label)}</strong>
    <span class="raid-exit__state">${escapeHtml(exit.stateLabel)}${distance}</span>
    ${requirements}
  </li>`;
}

function channelMarkup(channel) {
  if (!channel.active) return '';
  return `<section class="raid-channel" aria-label="Extraction progress">
    <p class="raid-channel__action"><strong>EXTRACTING — ${escapeHtml(channel.exitLabel)}</strong> <kbd>${escapeHtml(channel.holdLabel)}</kbd></p>
    <div class="raid-channel__progress">
      <progress max="1" value="${channel.progress}" aria-label="Extraction progress" aria-valuetext="${channel.percent} percent"></progress>
      <span>${channel.percent}%</span>
    </div>
    <p class="raid-channel__reset">${escapeHtml(channel.resetNote)}</p>
  </section>`;
}

function nearbyMarkup(nearby) {
  if (!nearby.container && !nearby.items.length) return '';
  const container = nearby.container
    ? nearby.container.sealed
      ? `<p class="raid-loot__container" data-sealed="true"><strong>SEALED CACHE${nearby.container.tier === null ? '' : ` · TIER ${nearby.container.tier}`}</strong> <kbd>${escapeHtml(nearby.container.actionLabel)}</kbd></p>`
      : `<p class="raid-loot__container" data-sealed="false"><strong>${nearby.container.kind === 'dropped' ? 'DROPPED ITEMS' : 'OPEN CACHE'}</strong></p>`
    : '';
  const items = nearby.items.length
    ? `<ul class="raid-loot__items">${nearby.items.map((item) => `<li data-rarity="${attr(item.rarityTier)}">
        <span>${escapeHtml(item.name)}${item.quantityLabel ? ` ${escapeHtml(item.quantityLabel)}` : ''}</span>
        ${item.compareLabel ? `<span class="raid-loot__compare">${escapeHtml(item.compareLabel)}</span>` : ''}
        <kbd>${escapeHtml(nearby.pickupLabel)}</kbd>
      </li>`).join('')}</ul>`
    : '';
  return `<section class="raid-loot" aria-label="Nearby loot">${container}${items}</section>`;
}

/** Render escaped, semantic raid HUD markup from an already projected model. */
export function renderRaidHudHtml(model) {
  if (!model || model.version !== 1) throw new TypeError('A raid presentation v1 model is required.');
  const summary = [
    model.phaseLabel,
    model.clock.status === 'unavailable' ? 'Raid time unavailable' : `${model.clock.text} remaining`,
    model.participant.label,
    model.inventory.capacityLabel,
    ...model.exits.map((exit) => `${exit.label}: ${exit.stateLabel}`),
  ].join('. ');
  const caption = model.caption
    ? `<p class="raid-caption" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(model.caption.text)}</p>`
    : '';
  const status = model.status
    ? `<p class="raid-status" role="status">${escapeHtml(model.status)}</p>`
    : '';
  const violation = model.ruleViolation
    ? `<p class="raid-contract-error" role="alert">${escapeHtml(model.ruleViolation)}</p>`
    : '';
  return `<section class="raid-hud" data-phase="${attr(model.phase)}" data-participant="${attr(model.participant.phase)}" data-reduce-motion="${model.preferences.reduceMotion}" data-color-vision="${attr(model.preferences.colorVisionPreset)}" style="--raid-hud-scale:${model.preferences.hudScaleFactor}" aria-label="Extraction raid status">
    <p class="raid-hud__sr-summary">${escapeHtml(summary)}</p>
    ${violation}
    <header class="raid-topline" data-clock-state="${attr(model.clock.status)}">
      <strong>${escapeHtml(model.phaseLabel)}</strong>
      <time aria-label="Raid time remaining">${escapeHtml(model.clock.text)}</time>
      <span class="raid-topline__participant">${escapeHtml(model.participant.label)}</span>
    </header>
    ${inventoryMarkup(model.inventory)}
    <section class="raid-exits" aria-label="Extraction exits">
      <h3>EXITS</h3>
      <ul>${model.exits.map(exitMarkup).join('') || '<li class="raid-exit" data-state="unknown">NO EXIT DATA</li>'}</ul>
    </section>
    ${channelMarkup(model.channel)}
    ${nearbyMarkup(model.nearby)}
    <p class="raid-loss" role="note" data-loss-state="${attr(model.lossWarning.state)}">${escapeHtml(model.lossWarning.text)}</p>
    ${status}
    ${caption}
  </section>`;
}

/** Convenience boundary mirroring the Bomb package's facade-sample renderer. */
export function renderRaidHudFromSample(input) {
  return renderRaidHudHtml(projectRaidPresentation(input));
}

/** Replace one dedicated mount point; callers own listeners and lifecycle. */
export function updateRaidHudMount(root, model) {
  if (!root || typeof root !== 'object' || !('innerHTML' in root)) {
    throw new TypeError('A raid HUD mount element is required.');
  }
  root.innerHTML = renderRaidHudHtml(model);
  return root;
}
