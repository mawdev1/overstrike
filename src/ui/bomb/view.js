import { projectBombPresentation } from './model.js';

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const attr = escapeHtml;

function teamMarkup(team) {
  const alive = team.alive === null ? '—' : team.alive;
  return `<section class="bomb-team bomb-team--${team.id}" aria-label="${team.label}, ${team.roleLabel}, ${alive} alive">
    <span class="bomb-token bomb-token--${team.shape}" aria-hidden="true">${team.glyph}</span>
    <span class="bomb-team__name">${team.label}</span>
    <strong class="bomb-team__score" aria-label="${team.score === null ? 'score unavailable' : `${team.score} rounds`}">${team.score ?? '—'}</strong>
    <span class="bomb-team__role">${team.roleLabel}</span>
    <span class="bomb-team__alive"><span aria-hidden="true">●</span> ${alive} ALIVE</span>
  </section>`;
}

function sitesMarkup(sites) {
  if (!sites.length) return '<p class="bomb-hud__secondary">SITE DATA UNAVAILABLE</p>';
  return `<ul class="bomb-sites" aria-label="Bomb sites">${sites.map((site) => `<li class="bomb-site${site.active ? ' bomb-site--active' : ''}${site.occluded ? ' bomb-site--occluded' : ''}${site.offscreen ? ' bomb-site--offscreen' : ''}" data-site="${site.site}" data-direction="${attr(site.direction || '')}" data-site-x="${site.center.x}" data-site-y="${site.center.y}" data-site-z="${site.center.z}">
    <span class="bomb-token bomb-token--${site.shape}" aria-hidden="true">${site.glyph}</span>
    <strong>${site.label}</strong>
    <span>${escapeHtml(site.callout)}${site.distanceM === null ? '' : ` · ${Math.round(site.distanceM)} M`}${site.offscreen && site.direction ? ` · ${site.direction.toUpperCase()}` : ''}</span>
  </li>`).join('')}</ul>`;
}

function worldMarkersMarkup(sites) {
  const projected = sites.filter((site) => site.screenX !== null && site.screenY !== null);
  if (!projected.length) return '';
  return `<ul class="bomb-world-markers" aria-hidden="true">${projected.map((site) => `<li class="bomb-world-marker${site.active ? ' bomb-world-marker--active' : ''}${site.occluded ? ' bomb-world-marker--occluded' : ''}${site.offscreen ? ' bomb-world-marker--offscreen' : ''}" data-site="${site.site}" data-direction="${attr(site.direction || '')}" style="--bomb-marker-x:${site.screenX.toFixed(2)}%;--bomb-marker-y:${site.screenY.toFixed(2)}%">
    <span class="bomb-token bomb-token--${site.shape}" aria-hidden="true">${site.glyph}</span>
    <strong>${site.label}</strong>
    <span>${escapeHtml(site.callout)}${site.distanceM === null ? '' : ` · ${Math.round(site.distanceM)} M`}</span>
    ${site.offscreen && site.direction ? `<span class="bomb-world-marker__edge">EDGE ${site.direction.toUpperCase()}</span>` : ''}
  </li>`).join('')}</ul>`;
}

function interactionMarkup(interaction) {
  if (!interaction.visible && !interaction.status) return '';
  const progress = interaction.visible ? `<div class="bomb-interaction__progress">
    <progress max="1" value="${interaction.progress}" aria-label="${attr(interaction.actionLabel)} progress" aria-valuetext="${interaction.percent} percent, ${attr(interaction.stateWord)}"></progress>
    <span>${interaction.percent}% · ${escapeHtml(interaction.stateWord)}</span>
  </div>` : '';
  const action = interaction.visible ? `<p class="bomb-interaction__action"><strong>${escapeHtml(interaction.actionLabel)}</strong> <kbd>${escapeHtml(interaction.binding)}</kbd></p>` : '';
  const status = interaction.status ? `<p class="bomb-interaction__status" role="status">${escapeHtml(interaction.status)}</p>` : '';
  return `<section class="bomb-interaction" aria-label="Objective interaction">${action}${progress}${status}</section>`;
}

function spectatorMarkup(spectator) {
  if (!spectator.active) return '';
  const cycle = spectator.canCycle
    ? `<span><kbd>${escapeHtml(spectator.previousBinding)}</kbd> PREVIOUS · <kbd>${escapeHtml(spectator.nextBinding)}</kbd> NEXT</span>`
    : '<span>CYCLING UNAVAILABLE</span>';
  return `<section class="bomb-spectator" aria-label="Spectator status">
    <strong>SPECTATING</strong>
    <span>${escapeHtml(spectator.targetLabel)}</span>
    ${cycle}
    <span>${escapeHtml(spectator.chatLabel)}</span>
  </section>`;
}

function outcomeMarkup(outcome) {
  if (!outcome) return '';
  return `<section class="bomb-outcome" role="status" aria-live="assertive" aria-atomic="true">
    <strong>${escapeHtml(outcome.result)}</strong><span>${escapeHtml(outcome.reason)}</span>
  </section>`;
}

function connectionMarkup(connection) {
  const stats = connection.stats;
  const measured = stats ? [
    stats.rttMs === null ? null : `${Math.round(stats.rttMs)} MS RTT`,
    stats.lossPct === null ? null : `${stats.lossPct.toFixed(1)}% LOSS`,
    stats.snapshotAgeMs === null ? null : `${Math.round(stats.snapshotAgeMs)} MS SNAPSHOT AGE`,
  ].filter(Boolean).join(' · ') : '';
  return `<div class="bomb-connection" data-state="${attr(connection.state)}">
    <span class="bomb-connection__state">${escapeHtml(connection.label)}</span>
    ${measured ? `<span class="bomb-hud__secondary">${escapeHtml(measured)}</span>` : ''}
  </div>`;
}

function overlayMarkup(overlay) {
  if (!overlay) return '';
  let detail = '';
  if (overlay.kind === 'reconnecting' || overlay.kind === 'grace-expired') {
    const attempts = overlay.attempt === null || overlay.maxAttempts === null
      ? 'ATTEMPT PENDING'
      : `ATTEMPT ${overlay.attempt}/${overlay.maxAttempts}`;
    detail = `<p>${escapeHtml(attempts)}${overlay.graceLabel ? ` · ${escapeHtml(overlay.graceLabel)} REMAINING` : ''}</p>`;
  }
  const cancel = overlay.canCancel
    ? '<button type="button" data-bomb-action="cancel-connection">CANCEL</button>'
    : '';
  return `<section class="bomb-veil" role="alertdialog" aria-modal="true" aria-labelledby="bomb-veil-title" tabindex="-1">
    <h2 id="bomb-veil-title">${escapeHtml(overlay.title)}</h2>${detail}${cancel}
  </section>`;
}

/** Render escaped, semantic Bomb HUD markup from an already projected model. */
export function renderBombHudHtml(model) {
  if (!model || model.version !== 1) throw new TypeError('A Bomb presentation v1 model is required.');
  const clockLabel = model.clock.status === 'syncing'
    ? `${model.clock.text}, syncing`
    : model.clock.status === 'estimating' ? `${model.clock.text} remaining, estimating`
    : model.clock.status === 'unavailable' ? 'Match time unavailable' : `${model.clock.text} remaining`;
  const clockStatus = model.clock.status === 'estimating'
    ? '<span class="bomb-clock__status">ESTIMATING</span>'
    : model.clock.status === 'syncing' ? '<span class="bomb-clock__status">SYNCING</span>' : '';
  const carrier = model.bomb.carrierRelationship === 'self'
    ? '<span class="bomb-carrier">◆ YOU HAVE THE BOMB</span>'
    : model.bomb.carrierRelationship === 'teammate'
      ? '<span class="bomb-carrier">◆ TEAMMATE HAS THE BOMB</span>'
      : model.bomb.carrierRelationship === 'enemy'
        ? '<span class="bomb-carrier">◆ ENEMY BOMB CARRIER VISIBLE</span>'
        : model.bomb.carrierVisible
          ? '<span class="bomb-carrier">◆ BOMB CARRIER VISIBLE</span>' : '';
  const marker = model.bomb.markerVisible
    ? `<span class="bomb-marker" data-bomb-x="${model.bomb.markerPosition.x}" data-bomb-y="${model.bomb.markerPosition.y}" data-bomb-z="${model.bomb.markerPosition.z}">◆ ${model.bomb.label}</span>`
    : '';
  const caption = model.caption
    ? `<p class="bomb-caption" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(model.caption.text)}</p>`
    : '';
  const violation = model.ruleViolation
    ? `<p class="bomb-contract-error" role="alert">${escapeHtml(model.ruleViolation)}</p>`
    : '';
  const summary = [
    model.roundLabel,
    model.phaseLabel,
    clockLabel,
    ...model.teams.map((team) => `${team.label} ${team.score === null ? 'score unavailable' : team.score}, ${team.alive ?? 'unknown'} alive, ${team.roleLabel}`),
    model.bomb.label,
    model.spectator.active ? model.spectator.targetLabel : null,
    model.connection.label,
  ].filter(Boolean).join('. ');

  return `<section class="bomb-hud" data-phase="${attr(model.phase)}" data-clock-state="${attr(model.clock.status)}" data-reduce-motion="${model.preferences.reduceMotion}" data-color-vision="${attr(model.preferences.colorVisionPreset)}" style="--bomb-hud-scale:${model.preferences.hudScaleFactor}" aria-label="Bomb match status">
    <p class="bomb-hud__sr-summary">${escapeHtml(summary)}</p>
    ${violation}
    <header class="bomb-round" aria-label="Round status">
      ${teamMarkup(model.teams[0])}
      <div class="bomb-round__center">
        <span>${escapeHtml(model.roundLabel)}</span>
        <strong>${escapeHtml(model.phaseLabel)}</strong>
        <time aria-label="${attr(clockLabel)}">${escapeHtml(model.clock.text)}</time>${clockStatus}
      </div>
      ${teamMarkup(model.teams[1])}
    </header>
    <section class="bomb-objectives" aria-label="Bomb objectives">
      ${sitesMarkup(model.sites)}
      <div class="bomb-state"><span class="bomb-case bomb-case--${attr(model.bomb.icon)}" aria-hidden="true">◆</span><strong>${escapeHtml(model.bomb.label)}</strong>${carrier}${marker}</div>
    </section>
    ${worldMarkersMarkup(model.sites)}
    ${interactionMarkup(model.interaction)}
    ${spectatorMarkup(model.spectator)}
    ${outcomeMarkup(model.outcome)}
    ${caption}
    ${connectionMarkup(model.connection)}
    ${overlayMarkup(model.connection.overlay)}
  </section>`;
}

/** Convenience boundary for future HUD integration; no live facade is imported here. */
export function renderBombHudFromFacadeSample(input) {
  return renderBombHudHtml(projectBombPresentation(input));
}

/**
 * Replace one dedicated mount point. Callers own event listeners and must focus the returned
 * alertdialog after a reconnect veil appears; this package deliberately does not reach into
 * the dirty global HUD or pointer-lock lifecycle.
 */
export function updateBombHudMount(root, model) {
  if (!root || typeof root !== 'object' || !('innerHTML' in root)) {
    throw new TypeError('A Bomb HUD mount element is required.');
  }
  root.innerHTML = renderBombHudHtml(model);
  return typeof root.querySelector === 'function' ? root.querySelector('[role="alertdialog"]') : null;
}
