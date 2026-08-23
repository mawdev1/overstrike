import { actionButton, definitionList, element, field, safeError, shellLink } from './dom.js';
import { capabilityLabel } from './capabilities.js';
import { HERO_ART, loadingArt } from './keyart.js';
import { createSettingsScreen, SETTINGS_BY_KEY } from './settings/index.js';

/**
 * A decorative key-art panel: an `<img>` under a CSS scrim, `aria-hidden` and `alt=""` so it
 * is never the only carrier of anything. The image is a child rather than a CSS
 * `background-image` so the browser can prioritise/lazy it and so a failed load collapses to
 * the panel's own background instead of leaving a black rectangle. `data-art` is what the
 * acceptance harness asserts against — it names the file that was actually chosen.
 */
function keyArtPanel(src, { className = '', children = [] } = {}) {
  if (!src) return element('div', { className: `os-keyart-panel ${className}`.trim() }, children);
  const image = element('img', { className: 'os-keyart__image', src, alt: '', decoding: 'async' });
  image.addEventListener('error', () => {
    // A missing or blocked image must degrade to the panel's flat treatment, not a hole.
    image.remove();
    panel.dataset.artFailed = 'true';
  });
  const panel = element('div', {
    className: `os-keyart-panel ${className}`.trim(),
    dataset: { art: src },
  }, [
    element('div', { className: 'os-keyart', 'aria-hidden': 'true' }, image),
    element('div', { className: 'os-keyart-panel__body' }, children),
  ]);
  return panel;
}

const FORM_EMPTY_ROUTES = new Set([
  'auth.signIn',
  'auth.create',
  'auth.recover',
  'onboarding.eligibility',
  'onboarding.consent',
  'onboarding.displayName',
  'onboarding.verify',
  'onboarding.essentialSettings',
]);

const COPY = Object.freeze({
  welcome: { empty: 'Compatibility information is unavailable.' },
  'play.rooms': { empty: 'No rooms are available.' },
  'play.roomDetail': { empty: 'This room is no longer available.' },
  'room.home': { empty: 'No roster entries are available.' },
  'room.roster': { empty: 'No roster entries are available.' },
  'room.chat': { empty: 'No messages have been sent.' },
  'career.overview': { empty: 'No completed matches are available.' },
  'career.modes': { empty: 'No mode statistics are available.' },
  'career.weapons': { empty: 'No weapon statistics are available.' },
  'career.matches': { empty: 'No match history is available.' },
  'career.matchDetail': { empty: 'This match is not available.' },
  inventory: { empty: 'You do not own any items yet. Items you extract from a raid appear here.' },
  'inventory.item': { empty: 'This item is not available.' },
  loadouts: { empty: 'No loadout data is available.' },
  sessions: { empty: 'Only the current session is active.' },
  results: { empty: 'The result is still being prepared.' },
});

function actionsRow(children) {
  return element('div', { className: 'os-actions' }, children);
}

function submitButton(label) {
  return element('button', { type: 'submit', className: 'os-button os-button--primary' }, label);
}

function statusBadge(value) {
  return element('span', { className: 'os-status-chip' }, value || 'Not available');
}

function dateText(value) {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? String(value) : parsed.toLocaleString();
}

function renderGlobalVariant(route, view, actions) {
  if (view.variant === 'loading') {
    return element('section', { className: 'os-state', role: 'status', 'aria-live': 'polite' }, [
      element('p', {}, view.message || 'Loading…'),
    ]);
  }
  if (view.variant === 'error') {
    const error = safeError(view.error);
    return element('section', { className: 'os-state os-state--error', role: 'alert', tabIndex: -1, 'data-error-summary': 'true' }, [
      element('h2', {}, 'Something went wrong'),
      element('p', {}, error.message),
      error.code ? element('p', { className: 'os-error-code' }, `Code: ${error.code}`) : null,
      actionsRow([actionButton('Retry', actions.refresh, { className: 'os-button os-button--primary' })]),
    ]);
  }
  if (view.variant === 'offline') {
    if (view.data && Object.keys(view.data).length) return null;
    return element('section', { className: 'os-state os-state--offline', role: 'status' }, [
      element('h2', {}, 'Offline or stale'),
      element('p', {}, view.message || 'Current service data is unavailable. Any displayed data is read-only.'),
      view.staleAt ? element('p', {}, `Last confirmed: ${dateText(view.staleAt)}`) : null,
      actionsRow([actionButton('Try again', actions.refresh, { className: 'os-button os-button--primary' })]),
    ]);
  }
  if (view.variant === 'terminal') {
    const error = safeError(view.error);
    return element('section', { className: 'os-state os-state--terminal', role: 'alert', tabIndex: -1, 'data-error-summary': 'true' }, [
      element('h2', {}, 'Action required'),
      element('p', {}, error.message),
      error.code ? element('p', { className: 'os-error-code' }, `Code: ${error.code}`) : null,
      actionsRow([
        shellLink('Return to welcome', '/welcome', { className: 'os-button os-button--quiet' }),
        shellLink('Account recovery', '/auth/recover', { className: 'os-button os-button--quiet' }),
      ]),
    ]);
  }
  if (view.variant === 'unavailable') {
    return element('section', { className: 'os-state os-state--unavailable', role: 'status' }, [
      element('h2', {}, 'Unavailable'),
      element('p', {}, view.data?.message || view.message || 'This feature is unavailable right now.'),
      actionsRow([shellLink('Return to welcome', '/welcome', { className: 'os-button os-button--quiet' })]),
    ]);
  }
  if (view.variant === 'empty' && !FORM_EMPTY_ROUTES.has(route.id)) {
    return element('section', { className: 'os-state' }, [
      element('p', {}, COPY[route.id]?.empty || 'No data is available.'),
      actionsRow([actionButton('Refresh', actions.refresh, { className: 'os-button os-button--quiet' })]),
    ]);
  }
  return null;
}

function renderWelcome({ capabilities, actions }) {
  const items = [
    ['desktop', capabilities?.observed?.desktop],
    ['webgl2', capabilities?.observed?.webgl2],
    ['pointer-lock', capabilities?.observed?.pointerLock],
    ['websocket-binary', capabilities?.observed?.websocketBinary],
  ];
  const list = element('ul', { className: 'os-check-list' });
  for (const [key, value] of items) {
    list.append(element('li', {}, [
      element('span', {}, capabilityLabel(key)),
      statusBadge(value === null || value === undefined ? 'Not measured' : value ? 'Available' : 'Unavailable'),
    ]));
  }
  return element('section', {}, [
    keyArtPanel(HERO_ART, {
      className: 'os-keyart-panel--hero',
      children: [
        element('p', { className: 'os-keyart-panel__kicker' }, 'Browser-native tactical FPS'),
        element('p', { className: 'os-lede' }, 'Sign in to browse rooms, manage your account, and prepare for a match.'),
      ],
    }),
    element('h2', {}, 'Compatibility'),
    list,
    capabilities?.supported
      ? element('p', { className: 'os-positive' }, 'This browser passed the preliminary API check. The renderer and available hardware signals are verified only when match loading begins.')
      : element('p', { className: 'os-warning' }, 'Account recovery and legal pages remain available, but match entry is blocked on this device.'),
    actionsRow([
      shellLink('Sign in', '/auth/sign-in', { className: 'os-button os-button--primary' }),
      shellLink('Create account', '/onboarding/eligibility', { className: 'os-button os-button--quiet' }),
      actionButton('Local practice', () => actions.enterGame({ localPractice: true }), {
        className: 'os-button os-button--quiet',
        disabled: !capabilities?.supported,
      }),
    ]),
  ]);
}

function renderSignIn({ actions, view }) {
  const identifier = field({ label: 'Email', name: 'identifier', type: 'email', autocomplete: 'username', required: true });
  const password = field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const reveal = element('label', { className: 'os-checkbox' }, [
    element('input', { type: 'checkbox', on: { change: (event) => { password.input.type = event.currentTarget.checked ? 'text' : 'password'; } } }),
    element('span', {}, 'Show password'),
  ]);
  const form = element('form', { className: 'os-form' }, [identifier.wrapper, password.wrapper, reveal, submitButton('Sign in')]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    actions.submit('signIn', { email: identifier.input.value, password: password.input.value }, {
      secretInputs: [password.input],
      onSuccess: (result) => {
        actions.acceptSession(result);
        actions.resumeAfterAuth(result);
      },
    });
  });
  return element('section', {}, [
    view.data?.notice ? element('p', { className: 'os-state os-state--terminal', role: 'status' }, view.data.notice) : null,
    form,
    actionsRow([
      shellLink('Recover account', '/auth/recover'),
      shellLink('Create account', '/onboarding/eligibility'),
    ]),
  ]);
}

function renderCreateAccount({ actions }) {
  const email = field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true });
  const password = field({ label: 'Password', name: 'new-password', type: 'password', autocomplete: 'new-password', required: true });
  const confirmation = field({ label: 'Confirm password', name: 'confirm-password', type: 'password', autocomplete: 'new-password', required: true });
  const reveal = element('label', { className: 'os-checkbox' }, [
    element('input', { type: 'checkbox', on: { change: (event) => {
      const type = event.currentTarget.checked ? 'text' : 'password';
      password.input.type = type;
      confirmation.input.type = type;
    } } }),
    element('span', {}, 'Show passwords'),
  ]);
  const mismatch = element('p', { className: 'os-field-status', role: 'alert' });
  email.input.value = actions.getDraft().email || '';
  const form = element('form', { className: 'os-form' }, [email.wrapper, password.wrapper, confirmation.wrapper, reveal, mismatch, submitButton('Continue')]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (password.input.value !== confirmation.input.value) {
      mismatch.textContent = 'Passwords do not match.';
      password.input.value = '';
      confirmation.input.value = '';
      password.input.focus();
      return;
    }
    actions.updateDraft({ email: email.input.value, password: password.input.value });
    password.input.value = '';
    confirmation.input.value = '';
    actions.navigate('/onboarding/display-name');
  });
  return element('section', {}, [
    element('p', {}, 'Credentials remain in memory only while this setup flow is open.'),
    form,
  ]);
}

function renderRecovery({ actions, view }) {
  if (view.variant === 'terminal') return renderGlobalVariant({ id: 'auth.recover' }, view, actions);
  const identifier = field({ label: 'Email', name: 'recovery-identifier', type: 'email', autocomplete: 'email', required: true });
  const startStatus = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite' });
  const startForm = element('form', { className: 'os-form' }, [identifier.wrapper, startStatus, submitButton('Start recovery')]);
  startForm.addEventListener('submit', (event) => {
    event.preventDefault();
    actions.submit('startRecovery', { email: identifier.input.value }, {
      onSuccess: () => {
        startStatus.textContent = 'If the account can be recovered, instructions have been sent.';
        actions.announce(startStatus.textContent);
      },
    });
  });
  const token = field({ label: 'Recovery token', name: 'recovery-token', autocomplete: 'one-time-code', required: true });
  const password = field({ label: 'New password', name: 'recovery-password', type: 'password', autocomplete: 'new-password', required: true });
  const confirmation = field({ label: 'Confirm new password', name: 'recovery-password-confirmation', type: 'password', autocomplete: 'new-password', required: true });
  const mismatch = element('p', { className: 'os-field-status', role: 'alert' });
  const completeForm = element('form', { className: 'os-form' }, [token.wrapper, password.wrapper, confirmation.wrapper, mismatch, submitButton('Set new password')]);
  completeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (password.input.value !== confirmation.input.value) {
      mismatch.textContent = 'Passwords do not match.';
      password.input.value = '';
      confirmation.input.value = '';
      password.input.focus();
      return;
    }
    actions.submit('completeRecovery', { token: token.input.value, newPassword: password.input.value }, {
      secretInputs: [token.input, password.input, confirmation.input],
      onSuccess: () => actions.setView({ variant: 'terminal', error: { code: 'RECOVERY_COMPLETED', message: 'Password updated and prior sessions revoked. Sign in again to continue.' } }),
    });
  });
  return element('section', {}, [
    element('p', {}, 'Recovery responses do not reveal whether an account exists.'),
    element('h2', {}, 'Request recovery'),
    startForm,
    element('h2', {}, 'Complete recovery'),
    completeForm,
  ]);
}

function renderEligibility({ actions }) {
  const birthdate = field({ label: 'Date of birth', name: 'birthdate', type: 'date', autocomplete: 'bday', required: true });
  const jurisdiction = field({ label: 'Country or region code', name: 'jurisdiction', autocomplete: 'country', required: true });
  jurisdiction.input.value = actions.getDraft().jurisdiction || '';
  const form = element('form', { className: 'os-form' }, [birthdate.wrapper, jurisdiction.wrapper, submitButton('Check eligibility')]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = { dateOfBirth: birthdate.input.value, jurisdiction: jurisdiction.input.value };
    actions.submit('checkEligibility', payload, {
      secretInputs: [birthdate.input],
      onSuccess: (result) => {
        if (!result?.eligible) {
          actions.setView({ variant: 'terminal', error: { code: result?.code || 'INELIGIBLE', message: result?.message || 'This account cannot be created under the current policy.' } });
          return;
        }
        actions.updateDraft({ eligibilityReceipt: result.receipt, jurisdiction: jurisdiction.input.value });
        actions.navigate('/onboarding/consent');
      },
    });
  });
  return element('section', {}, [
    element('p', {}, 'Your birthdate is sent for the eligibility check and is not retained by this shell.'),
    form,
  ]);
}

function renderConsent({ actions, view }) {
  const data = view.data || {};
  // `currentPolicyVersion` (the version in force), NOT `policyVersion` (the version the player
  // decided under, which is null until they decide). Reading the decided field meant both
  // buttons were disabled for every first-time player — the one state this screen exists for —
  // so onboarding stopped at step 2 of 7 with nothing clickable and no error. http-api.md
  // 1.11.0 added the key; the fallback keeps a player who has already decided able to change
  // their mind against an older server.
  const policyVersion = Number.isInteger(data.currentPolicyVersion)
    ? data.currentPolicyVersion
    : data.policyVersion;
  const canSubmit = Number.isInteger(policyVersion) && Boolean(actions.getClientSessionId());
  return element('section', {}, [
    element('p', {}, data.summary || 'Choose whether optional personal telemetry may be collected. Declining does not block account creation.'),
    Number.isInteger(policyVersion) ? element('p', {}, `Policy version: ${policyVersion}`) : null,
    actionsRow([
      actionButton('Allow optional telemetry', () => actions.submit('setConsent', { telemetryPersonal: true, policyVersion, clientSessionId: actions.getClientSessionId() }, {
        onSuccess: (result) => {
          actions.updateDraft({ consentReceipt: result?.receipt, consentAllowed: true });
          actions.navigate('/auth/create-account');
        },
      }), { className: 'os-button os-button--primary', disabled: !canSubmit }),
      actionButton('Decline optional telemetry', () => actions.submit('setConsent', { telemetryPersonal: false, policyVersion, clientSessionId: actions.getClientSessionId() }, {
        onSuccess: (result) => {
          actions.updateDraft({ consentReceipt: result?.receipt, consentAllowed: false });
          actions.navigate('/auth/create-account');
        },
      }), { className: 'os-button os-button--quiet', disabled: !canSubmit }),
    ]),
  ]);
}

function renderDisplayName({ actions }) {
  const candidate = field({ label: 'Display name', name: 'display-name', autocomplete: 'nickname', required: true, hint: 'Availability is checked after you pause typing.' });
  const availability = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite' });
  candidate.input.setAttribute('aria-describedby', `${candidate.input.id}-hint ${candidate.input.id}-availability`);
  availability.id = `${candidate.input.id}-availability`;
  let timer = null;
  let sequence = 0;
  candidate.input.value = actions.getDraft().displayName || '';
  candidate.input.addEventListener('input', () => {
    clearTimeout(timer);
    availability.textContent = '';
    const value = candidate.input.value;
    actions.updateDraft({ displayName: value });
    if (!value) return;
    const requestSequence = ++sequence;
    timer = setTimeout(async () => {
      availability.textContent = 'Checking availability…';
      try {
        const result = await actions.request('checkDisplayName', { displayName: value });
        if (requestSequence !== sequence) return;
        availability.textContent = result?.available
          ? 'Available.'
          : result?.policy?.rule
            ? `Not available. Policy rule: ${result.policy.rule}.`
            : 'Not available.';
        candidate.input.dataset.available = result?.available ? 'true' : 'false';
      } catch (error) {
        if (requestSequence === sequence) availability.textContent = safeError(error).message;
      }
    }, 400);
  });
  const form = element('form', { className: 'os-form' }, [candidate.wrapper, availability, submitButton('Create account')]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = actions.createSignupPayload(candidate.input.value);
    if (!payload) {
      availability.textContent = 'Restart setup so the required receipts and credentials can be confirmed.';
      return;
    }
    actions.submit('signUp', payload, {
      onSuccess: (result) => {
        actions.acceptSession(result);
        actions.clearDraft();
        actions.navigate(actions.nextSetupPath(result) || '/onboarding/verify');
      },
    });
  });
  return element('section', {}, [form]);
}

function renderVerify({ actions, view }) {
  const token = field({ label: 'Verification code', name: 'verification-code', autocomplete: 'one-time-code', required: true });
  const form = element('form', { className: 'os-form' }, [token.wrapper, submitButton('Verify')]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    actions.submit('completeVerification', { token: token.input.value }, {
      secretInputs: [token.input],
      onSuccess: (result) => actions.navigate(actions.nextSetupPath(result) || '/onboarding/terms'),
    });
  });
  return element('section', {}, [
    view.data?.destinationHint ? element('p', {}, `Code destination: ${view.data.destinationHint}`) : element('p', {}, 'Enter the code from your verification message.'),
    form,
    actionButton('Resend code', () => actions.submit('resendVerification', {}, {
      onSuccess: (result) => actions.announce(result?.message || 'The service confirmed the resend request.'),
    }), { className: 'os-button os-button--quiet' }),
  ]);
}

function renderTerms({ actions, view }) {
  const data = view.data || {};
  return element('section', {}, [
    data.version ? element('p', {}, `Current version: ${data.version}`) : null,
    data.summary ? element('p', {}, data.summary) : element('p', {}, 'Review and accept the current service terms to continue.'),
    data.url ? element('a', { href: data.url, target: '_blank', rel: 'noreferrer' }, 'Open full terms') : null,
    actionsRow([
      actionButton('Accept terms', () => actions.submit('acceptTerms', { version: data.version }, {
        onSuccess: (result) => actions.navigate(actions.nextSetupPath(result) || '/onboarding/essential-settings'),
      }), { className: 'os-button os-button--primary', disabled: !data.version }),
    ]),
  ]);
}

const ESSENTIAL_SETTING_KEYS = Object.freeze([
  'sensitivity',
  'adsSensitivity',
  'fov',
  'masterVolume',
  'subtitles',
  'reduceMotion',
]);

/**
 * Where a player goes when they are done with a flow and have nowhere specific to be.
 *
 * `/play/rooms` was hardcoded at the end of onboarding, so completing signup with
 * `shell.serverbrowser.enabled` off dropped the player onto the browser's own "Unavailable"
 * card — a dead end whose only control was "Return to welcome". Three other call sites already
 * made this decision correctly; these did not, which is the usual shape of a rule expressed by
 * repetition instead of by a function.
 *
 * The flag's contracted off-behaviour is "Browser hidden; direct room links still resolve"
 * (feature-flags.md §3.2). Hidden means not landed on, not shown disabled.
 */
export function homePath(isFeatureEnabled) {
  return isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? '/welcome' : '/play/rooms';
}

function renderEssentialSettings({ settings, actions, isFeatureEnabled }) {
  if (!settings?.getSnapshot || !settings?.set) return null;
  const form = element('form', { className: 'os-form' });
  const controls = new Map();
  const updateControls = (snapshot) => {
    for (const key of ESSENTIAL_SETTING_KEYS) {
      const input = controls.get(key);
      if (!input) continue;
      const value = snapshot?.values?.[key];
      if (input.type === 'checkbox') input.checked = Boolean(value);
      else if (value !== undefined) input.value = String(value);
    }
  };
  for (const key of ESSENTIAL_SETTING_KEYS) {
    const definition = SETTINGS_BY_KEY[key];
    if (!definition) continue;
    let input;
    let wrapper;
    if (definition.type === 'boolean') {
      input = element('input', { id: `shell-essential-${key}`, name: key, type: 'checkbox' });
      wrapper = element('label', { className: 'os-checkbox', htmlFor: input.id }, [input, element('span', {}, definition.label)]);
    } else {
      const built = field({ label: definition.label, name: `essential-${key}`, type: 'number', min: definition.min, max: definition.max });
      input = built.input;
      input.step = definition.step;
      wrapper = built.wrapper;
    }
    controls.set(key, input);
    input.addEventListener('change', () => {
      const value = definition.type === 'boolean' ? input.checked : Number(input.value);
      const result = settings.set(key, value);
      if (result?.ok === false) {
        actions.announce(`${definition.label} was not saved.`);
      }
    });
    form.append(wrapper);
  }
  updateControls(settings.getSnapshot());
  const unsubscribe = settings.subscribe?.(updateControls);
  actions.registerCleanup(unsubscribe);
  form.append(actionsRow([
    actionButton('Use recommended', () => {
      for (const key of ESSENTIAL_SETTING_KEYS) {
        const definition = SETTINGS_BY_KEY[key];
        if (definition) settings.set(key, definition.defaultValue);
      }
      actions.announce('Recommended essential settings applied.');
    }, { className: 'os-button os-button--quiet' }),
    element('button', { type: 'submit', className: 'os-button os-button--primary' }, 'Continue'),
  ]));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await settings.sync?.(); } catch { /* The controller preserves explicit unsynced state. */ }
    actions.navigate(homePath(isFeatureEnabled));
  });
  return element('section', {}, [
    element('p', {}, 'Set the controls needed before your first match. Every choice can be changed later.'),
    form,
  ]);
}

function renderProfileSettings({ view, actions, session }) {
  const profile = view.data?.accountId ? view.data : session?.profile || session || {};
  const displayName = field({ label: 'Display name', name: 'profile-display-name', autocomplete: 'nickname', required: true });
  displayName.input.value = profile.displayName || '';
  const availability = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite' });
  let timer = null;
  let sequence = 0;
  displayName.input.addEventListener('input', () => {
    clearTimeout(timer);
    const raw = displayName.input.value;
    if (!raw || raw === profile.displayName) {
      availability.textContent = '';
      return;
    }
    const requestSequence = ++sequence;
    timer = setTimeout(async () => {
      availability.textContent = 'Checking availability…';
      try {
        const result = await actions.request('checkDisplayName', { displayName: raw });
        if (sequence !== requestSequence) return;
        availability.textContent = result?.available
          ? 'Available.'
          : result?.policy?.rule
            ? `Not available. Policy rule: ${result.policy.rule}.`
            : 'Not available.';
      } catch (error) {
        if (sequence === requestSequence) availability.textContent = safeError(error).message;
      }
    }, 400);
  });
  const form = element('form', { className: 'os-form' }, [displayName.wrapper, availability, submitButton('Save display name')]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    actions.submit('updateProfile', { displayName: displayName.input.value }, {
      onSuccess: (result) => {
        actions.acceptProfile(result);
        actions.announce('Display name saved.');
      },
    });
  });
  return element('section', {}, [
    profile.flags?.nameChangeAvailableAt
      ? element('p', {}, `Next name change available: ${dateText(profile.flags.nameChangeAvailableAt)}`)
      : null,
    form,
    actionsRow([
      shellLink('Privacy choices', '/settings/privacy'),
      shellLink('Sessions and devices', '/sessions'),
    ]),
  ]);
}

function renderPrivacySettings({ view, actions, session }) {
  const profile = view.data?.accountId ? view.data : session?.profile || session || {};
  const privacy = profile.privacy;
  if (!privacy) return element('p', {}, 'Current privacy choices are unavailable.');
  const presence = element('select', { id: 'shell-privacy-presence', name: 'presenceVisibility' }, [
    element('option', { value: 'everyone' }, 'Everyone'),
    element('option', { value: 'friends' }, 'Friends'),
    element('option', { value: 'nobody' }, 'Nobody'),
  ]);
  const stats = element('select', { id: 'shell-privacy-stats', name: 'statsVisibility' }, [
    element('option', { value: 'everyone' }, 'Everyone'),
    element('option', { value: 'nobody' }, 'Nobody'),
  ]);
  presence.value = privacy.presenceVisibility;
  stats.value = privacy.statsVisibility;
  const form = element('form', { className: 'os-form' }, [
    element('div', { className: 'os-field' }, [element('label', { htmlFor: presence.id }, 'Who can see your presence'), presence]),
    element('div', { className: 'os-field' }, [element('label', { htmlFor: stats.id }, 'Who can see your career statistics'), stats]),
    submitButton('Save privacy choices'),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    actions.submit('updateProfile', {
      privacy: { presenceVisibility: presence.value, statsVisibility: stats.value },
    }, {
      onSuccess: (result) => {
        actions.acceptProfile(result);
        actions.announce('Privacy choices saved.');
      },
    });
  });
  return element('section', {}, [form, actionsRow([shellLink('Back to account', '/settings/profile')])]);
}

function renderSettingsHook({ route, view, actions, settings, session, isFeatureEnabled, essential = false, loadout = false }) {
  const host = element('section', { className: 'os-settings-hook', 'data-settings-hook': essential ? 'essential' : loadout ? 'loadout' : route.params.category });
  if (!essential && !loadout && route.params.category === 'profile') {
    host.append(renderProfileSettings({ route, view, actions, session }));
    return host;
  }
  if (!essential && !loadout && route.params.category === 'privacy') {
    host.append(renderPrivacySettings({ route, view, actions, session }));
    return host;
  }
  const renderer = essential ? settings?.renderEssential : loadout ? settings?.renderLoadout : settings?.renderCategory;
  if (typeof renderer === 'function') {
    const cleanup = renderer({
      container: host,
      category: route.params.category,
      roomId: route.params.roomId,
      state: view,
      onComplete: (result) => actions.navigate(actions.nextSetupPath(result) || homePath(isFeatureEnabled)),
      onError: (error) => actions.setView({ variant: 'error', error }),
    });
    actions.registerCleanup(cleanup);
    return host;
  }
  if (loadout || route.params.category === 'loadout') {
    host.append(element('p', {}, 'The inventory loadout component is not connected to this shell mount.'));
    return host;
  }
  if (essential) {
    const compact = renderEssentialSettings({ settings, actions });
    if (compact) {
      host.append(compact);
      return host;
    }
  }
  if (settings?.getSnapshot && settings?.setCategory) {
    const category = essential ? 'accessibility' : route.params.category;
    if (category) settings.setCategory(category);
    const screen = createSettingsScreen({ controller: settings, document: host.ownerDocument, headingLevel: 2 });
    host.append(screen.element);
    actions.registerCleanup(() => screen.destroy());
    return host;
  }
  host.append(element('p', {}, 'The settings component is not connected to this shell mount.'));
  return host;
}

function roomId(room) {
  return room?.id || room?.roomId || null;
}

function roomPing(room) {
  if (Number.isFinite(room?.estimatedRttMs)) return room.estimatedRttMs;
  if (Number.isFinite(room?.measuredPingMs)) return room.measuredPingMs;
  return null;
}

function roomCounts(room) {
  if (Number.isFinite(room?.playerCount) && Number.isFinite(room?.capacity)) {
    return { players: room.playerCount, capacity: room.capacity, label: `${room.playerCount} / ${room.capacity}` };
  }
  const parsed = /^(\d+)\s*\/\s*(\d+)$/.exec(String(room?.occupancy || ''));
  return parsed
    ? { players: Number(parsed[1]), capacity: Number(parsed[2]), label: room.occupancy }
    : { players: null, capacity: null, label: room?.occupancy || null };
}

function roomMap(room) {
  return room?.mapId || room?.map || null;
}

function mapLabel(value) {
  if (value === 'the-square') return 'The Square';
  if (value === 'meridian') return 'Meridian';
  return value;
}

function modeLabel(value) {
  if (value === 'tdm') return 'Team deathmatch';
  if (value === 'bomb') return 'Bomb';
  return value;
}

function roomEligibility(room) {
  if (room?.joinable === true) return 'Eligible to join';
  if (room?.joinBlockedReason) return `Cannot join: ${String(room.joinBlockedReason).replaceAll('-', ' ')}`;
  return room?.joinable === false ? 'Not joinable' : 'Eligibility unavailable';
}

function roomCard(room) {
  const id = roomId(room);
  const ping = roomPing(room);
  const counts = roomCounts(room);
  const card = element('article', { className: 'os-card os-room-card', dataset: { joinable: String(room?.joinable === true) } }, [
    element('h2', {}, room?.name || id || 'Unnamed room'),
    definitionList([
      ['Map', mapLabel(roomMap(room))],
      ['Mode', modeLabel(room?.mode)],
      ['Players', counts.label],
      ['Region', room?.region],
      ['Measured latency', ping === null ? 'Unknown' : `${ping} ms`],
      ['Status', room?.status],
      ['Join eligibility', roomEligibility(room)],
    ]),
  ]);
  if (id) card.append(shellLink('View room', `/play/rooms/${encodeURIComponent(id)}`, { className: 'os-button os-button--quiet' }));
  return card;
}

function selectControl(label, id, options) {
  const select = element('select', { id });
  for (const option of options) {
    const node = element('option', { value: option.value }, option.label);
    // A region with no capacity is shown and NOT selectable: hiding it would make a region the
    // player saw yesterday silently vanish, which reads as a bug rather than as "full".
    if (option.disabled) node.disabled = true;
    select.append(node);
  }
  return element('div', { className: 'os-field' }, [element('label', { htmlFor: id }, label), select]);
}

function defaultRoomOrder(left, right) {
  if (Boolean(left.joinable) !== Boolean(right.joinable)) return left.joinable ? -1 : 1;
  const pingDelta = (roomPing(left) ?? Number.POSITIVE_INFINITY) - (roomPing(right) ?? Number.POSITIVE_INFINITY);
  if (pingDelta) return pingDelta;
  const playerDelta = (roomCounts(right).players ?? -1) - (roomCounts(left).players ?? -1);
  if (playerDelta) return playerDelta;
  return String(left.name || roomId(left) || '').localeCompare(String(right.name || roomId(right) || ''));
}

function renderRooms({ view, actions, isFeatureEnabled }) {
  const rooms = view.data?.rooms || view.data?.items || [];
  const online = Array.isArray(view.data?.online) ? view.data.online : [];
  const lastUpdatedAt = view.data?.lastUpdatedAt || view.data?.fetchedAt || null;
  const emptyRoomNotice = !rooms.length ? element('section', { className: 'os-state', role: 'status' }, [
    element('h2', {}, 'No active rooms'),
    element('p', {}, 'The platform is reachable, but no rooms are active right now. You can create the first available room.'),
  ]) : null;

  const modes = [...new Set(rooms.map((room) => room.mode).filter(Boolean))].sort();
  const regions = [...new Set(rooms.map((room) => room.region).filter(Boolean))].sort();
  const search = field({ label: 'Search rooms', name: 'room-search', type: 'search', autocomplete: 'off' });
  const modeControl = selectControl('Mode', 'shell-room-mode', [
    { value: '', label: 'All modes' }, ...modes.map((mode) => ({ value: mode, label: mode === 'tdm' ? 'Team deathmatch' : mode === 'bomb' ? 'Bomb' : mode })),
  ]);
  const regionControl = selectControl('Region', 'shell-room-region', [
    { value: '', label: 'All regions' }, ...regions.map((region) => ({ value: region, label: region })),
  ]);
  const sortControl = selectControl('Sort', 'shell-room-sort', [
    { value: 'recommended', label: 'Joinable, latency, occupancy' },
    { value: 'latency', label: 'Measured latency' },
    { value: 'occupancy', label: 'Most players' },
    { value: 'name', label: 'Room name' },
  ]);
  const mode = modeControl.querySelector('select');
  const region = regionControl.querySelector('select');
  const sort = sortControl.querySelector('select');
  const joinable = element('input', { id: 'shell-room-joinable', type: 'checkbox' });
  const hasSpace = element('input', { id: 'shell-room-space', type: 'checkbox' });
  const joinableLabel = element('label', { className: 'os-checkbox', htmlFor: joinable.id }, [joinable, element('span', {}, 'Joinable only')]);
  const hasSpaceLabel = element('label', { className: 'os-checkbox', htmlFor: hasSpace.id }, [hasSpace, element('span', {}, 'Has space')]);
  const grid = element('section', { className: 'os-card-grid', 'aria-label': 'Available rooms' });
  const cards = rooms.map((room) => ({ room, card: roomCard(room) }));
  const resultStatus = element('p', { className: 'os-results-status', role: 'status', 'aria-live': 'polite' });

  const apply = () => {
    const query = search.input.value.trim().toLocaleLowerCase();
    const visible = cards.filter(({ room }) => {
      const counts = roomCounts(room);
      const haystack = [room.name, roomId(room), roomMap(room), room.mode, room.region, room.status]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      return (!query || haystack.includes(query))
        && (!mode.value || room.mode === mode.value)
        && (!region.value || room.region === region.value)
        && (!joinable.checked || room.joinable === true)
        && (!hasSpace.checked || (counts.players !== null && counts.capacity !== null && counts.players < counts.capacity));
    });
    visible.sort(({ room: left }, { room: right }) => {
      if (sort.value === 'latency') {
        const delta = (roomPing(left) ?? Number.POSITIVE_INFINITY) - (roomPing(right) ?? Number.POSITIVE_INFINITY);
        return delta || defaultRoomOrder(left, right);
      }
      if (sort.value === 'occupancy') {
        const delta = (roomCounts(right).players ?? -1) - (roomCounts(left).players ?? -1);
        return delta || defaultRoomOrder(left, right);
      }
      if (sort.value === 'name') {
        return String(left.name || roomId(left) || '').localeCompare(String(right.name || roomId(right) || ''));
      }
      return defaultRoomOrder(left, right);
    });
    grid.replaceChildren(...visible.map(({ card }) => card));
    resultStatus.textContent = visible.length
      ? `${visible.length} room${visible.length === 1 ? '' : 's'} shown.`
      : 'No rooms match these filters. Reset filters to see all active rooms.';
  };
  for (const control of [search.input, mode, region, sort, joinable, hasSpace]) {
    control.addEventListener(control === search.input ? 'input' : 'change', apply);
  }
  const reset = actionButton('Reset filters', () => {
    search.input.value = '';
    mode.value = '';
    region.value = '';
    sort.value = 'recommended';
    joinable.checked = false;
    hasSpace.checked = false;
    apply();
    search.input.focus();
  }, { className: 'os-button os-button--quiet' });
  apply();

  const create = element('details', { className: 'os-room-create' }, [
    element('summary', {}, 'Create a room'),
  ]);
  const createName = field({ label: 'Room name', name: 'room-create-name', required: true });
  createName.input.maxLength = 48;
  /**
   * Region is a SELECT, not a text box.
   *
   * It shipped as free text. The accepted values are `yyz`/`ord`/`iad` — Fly datacenter codes —
   * so a player typed "Canada", got `VALIDATION_FAILED`, typed "US", got it again, and nothing
   * in the UI or the error named a value that would have worked. Map and Mode two lines below
   * were already selects; Region was the one closed set left open, and it was the one nobody
   * could guess.
   *
   * The options come from `GET /v1/config/regions` (§11.6), not a list hardcoded here. A copy
   * in the client is a copy that drifts from the server's allowlist, and it could not carry
   * `available` at all — which is the part that stops the form offering a region that room
   * creation will then refuse for want of capacity.
   */
  const regionList = view.data?.regions || [];
  const regionOptions = regionList.map((region) => ({
    value: region.id,
    label: region.available ? region.label : `${region.label} — no capacity`,
    disabled: !region.available,
  }));
  const createRegionWrap = selectControl('Region', 'shell-room-create-region', regionOptions);
  const createRegionSelect = createRegionWrap.querySelector('select');
  // Preselect the first region that can actually host, so the default submission succeeds.
  const firstAvailable = regionList.find((region) => region.available);
  if (firstAvailable) createRegionSelect.value = firstAvailable.id;
  // An empty or unreachable list must explain itself. A bare empty dropdown reads as "this
  // deployment has no regions", which is a different and more alarming claim than the truth.
  const regionNotice = view.data?.regionsUnavailable
    ? 'Region list unavailable — try again shortly.'
    : regionList.length && !firstAvailable
      ? 'No region currently has match capacity.'
      : null;
  const modeOptions = [
    isFeatureEnabled?.('mode.tdm.enabled') !== false ? { value: 'tdm', label: 'Team deathmatch' } : null,
    isFeatureEnabled?.('mode.bomb.enabled') !== false ? { value: 'bomb', label: 'Bomb' } : null,
  ].filter(Boolean);
  const mapOptions = [
    isFeatureEnabled?.('map.the_square.enabled') !== false ? { value: 'the-square', label: 'The Square' } : null,
    isFeatureEnabled?.('map.meridian.enabled') !== false ? { value: 'meridian', label: 'Meridian' } : null,
  ].filter(Boolean);
  const createMapWrap = selectControl('Map', 'shell-room-create-map', mapOptions);
  const createModeWrap = selectControl('Mode', 'shell-room-create-mode', modeOptions);
  const createCapacity = field({ label: 'Capacity', name: 'room-create-capacity', type: 'number', required: true });
  createCapacity.input.min = '2'; createCapacity.input.max = '12'; createCapacity.input.value = '12';
  const createPassword = field({ label: 'Password (optional)', name: 'room-create-password', type: 'password', autocomplete: 'new-password' });

  /**
   * Solo — the only way to play this build without recruiting a second human.
   *
   * A room defaults to `minPlayers: 2`, so a lone player readies up, presses Launch and is told
   * the match needs two. That is correct for a real match and useless for testing a deployment,
   * and the form gave no way to change it even though `roomSettings` has accepted
   * `minPlayers`/`requiredReady` since P2 — the settings simply never reached it from here.
   *
   * The match itself is NOT empty: the game server fills every match with bots (`--bots`,
   * default 8), which is who a solo player is actually fighting. So this is a real networked
   * match through the real allocator against real opponents, not a stripped-down mode — the
   * only thing it changes is the roster size the lobby will launch with.
   *
   * `requiredReady` is set alongside for clarity only; the launch gate already clamps it to the
   * roster size, so `minPlayers` is the value that was doing the blocking.
   */
  const soloInput = element('input', { type: 'checkbox', id: 'shell-room-create-solo' });
  const soloLabel = element('label', { className: 'os-checkbox', htmlFor: 'shell-room-create-solo' }, [
    soloInput, element('span', {}, 'Solo — start with one player (bots fill the match)'),
  ]);
  const createStatus = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite' });
  const createSubmit = submitButton('Create and join');
  createSubmit.disabled = !modeOptions.length || !mapOptions.length || !firstAvailable;
  const createForm = element('form', { className: 'os-form' }, [
    createName.wrapper, createRegionWrap, createMapWrap, createModeWrap,
    createCapacity.wrapper, createPassword.wrapper, soloLabel,
    !modeOptions.length || !mapOptions.length
      ? element('p', { className: 'os-notice', role: 'status' }, 'Room creation is unavailable because no approved mode and map combination is enabled.') : null,
    regionNotice ? element('p', { className: 'os-notice', role: 'status' }, regionNotice) : null,
    createStatus, createSubmit,
  ]);
  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    actions.submit('createRoom', {
      name: createName.input.value.trim(), region: createRegionSelect.value,
      mapId: createMapWrap.querySelector('select').value, mode: createModeWrap.querySelector('select').value,
      capacity: Number(createCapacity.input.value), password: createPassword.input.value || undefined,
      ...(soloInput.checked ? { settings: { minPlayers: 1, requiredReady: 1 } } : {}),
    }, {
      secretInputs: [createPassword.input],
      onSuccess: (result) => actions.navigate(`/room/${encodeURIComponent(result.room.roomId)}`),
      onError: (error) => { createStatus.textContent = safeError(error).message; createStatus.focus(); },
    });
  });
  create.append(createForm);

  /**
   * Local practice, reachable again once you have an account.
   *
   * The button exists on `renderWelcome` — and `/welcome` redirects a signed-in player straight
   * to this page, so the moment someone finished onboarding the feature became unreachable. It
   * was not removed or gated; it was simply on the one screen a player with an account never
   * sees. A capability that ships and cannot be opened is indistinguishable from one that does
   * not ship.
   *
   * It runs the simulation in this tab against bots, with no room, no allocator and no game
   * server, so it is also the thing that still works when the region has no capacity — which is
   * exactly when a player most wants something to do.
   */
  const practice = element('section', { className: 'os-practice' }, [
    element('h2', {}, 'Practice offline'),
    element('p', { className: 'os-hint' },
      'Play the map against bots in this browser. No room, no other players, and it works even when no region has capacity.'),
    actionsRow([
      actionButton('Local practice', () => actions.enterGame({ localPractice: true }), {
        className: 'os-button os-button--quiet',
      }),
    ]),
  ]);

  const presence = element('section', { className: 'os-presence-list', 'aria-labelledby': 'os-online-heading' }, [
    element('h2', { id: 'os-online-heading' }, 'Online players'),
    view.data?.presenceUnavailable
      ? element('p', { className: 'os-hint' }, 'Presence is temporarily unavailable. Room browsing still works.')
      : online.length
        ? element('ul', {}, online.map((player) => element('li', {}, [
          element('strong', {}, player.displayName),
          element('span', {}, ` — ${String(player.state).replaceAll('-', ' ')}`),
          player.joinable && player.roomId
            ? shellLink('View room', `/play/rooms/${encodeURIComponent(player.roomId)}`, { className: 'os-button os-button--quiet' })
            : null,
        ])))
        : element('p', {}, 'No privacy-visible players are online.'),
  ]);

  return element('section', {}, [
    create,
    practice,
    presence,
    emptyRoomNotice,
    element('div', { className: 'os-filter-bar' }, [search.wrapper, modeControl, regionControl, sortControl, joinableLabel, hasSpaceLabel]),
    actionsRow([
      actionButton('Refresh rooms', actions.refresh, { className: 'os-button os-button--primary' }),
      reset,
      view.data?.nextCursor
        ? actionButton('Load more rooms', () => actions.loadMore('rooms', view.data.nextCursor), { className: 'os-button os-button--quiet' })
        : null,
    ]),
    lastUpdatedAt ? element('p', { className: 'os-hint' }, `Last confirmed: ${dateText(lastUpdatedAt)}`) : null,
    view.data?.paginationError
      ? element('p', { className: 'os-state os-state--error', role: 'alert' }, `More rooms could not be loaded: ${safeError(view.data.paginationError).message}`)
      : null,
    resultStatus,
    grid,
  ]);
}

function renderRoomDetail({ view, actions, isFeatureEnabled }) {
  const room = view.data?.room || view.data || {};
  const id = roomId(room);
  const ping = roomPing(room);
  const counts = roomCounts(room);
  const feedback = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite', tabIndex: -1 });
  const password = room.hasPassword
    ? field({ label: 'Room password', name: 'room-password', type: 'password', autocomplete: 'off', required: true })
    : null;
  let joinAbort = null;
  const stageCopy = Object.freeze({
    'requesting-slot': 'Requesting slot…',
    'reservation-expired': 'The first slot reservation expired. Retrying once…',
    'retrying-slot': 'Requesting a fresh slot…',
    'joining-room-channel': 'Joining room channel…',
    'synchronizing-roster': 'Synchronizing roster…',
    ready: 'Room ready.',
  });
  const cancelJoin = actionButton('Cancel join', () => {
    cancelJoin.disabled = true;
    feedback.textContent = 'Cancelling join…';
    joinAbort?.abort();
  }, { className: 'os-button os-button--quiet', dataset: { operation: 'cancel-join' }, disabled: true });
  cancelJoin.hidden = true;
  const showStage = (stage) => {
    feedback.textContent = stageCopy[stage] || 'Joining room…';
    const cancellable = !['ready'].includes(stage);
    cancelJoin.hidden = !cancellable;
    cancelJoin.disabled = !cancellable;
  };
  return element('section', {}, [
    definitionList([
      ['Room', room.name || id],
      ['Mode', modeLabel(room.mode)],
      ['Map', mapLabel(roomMap(room))],
      ['Players', counts.label],
      ['Region', room.region],
      ['Measured latency', ping === null ? 'Unknown' : `${ping} ms`],
      ['Status', room.status],
      ['Rules version', room.rulesetVersion],
      ['Join eligibility', roomEligibility(room)],
    ]),
    password?.wrapper,
    feedback,
    actionsRow([
      actionButton('Join room', () => {
        joinAbort = new AbortController();
        return actions.submit('joinRoom', {
          roomId: id, password: password?.input.value || null,
          signal: joinAbort.signal, onStage: showStage,
        }, {
        secretInputs: password ? [password.input] : [],
        onSuccess: (result) => {
          joinAbort = null;
          showStage('ready');
          const confirmedId = result?.room?.id || result?.room?.roomId || result?.roomId || id;
          if (confirmedId) actions.navigate(`/room/${encodeURIComponent(confirmedId)}`);
        },
        onError: (error) => {
          joinAbort = null;
          cancelJoin.hidden = true;
          cancelJoin.disabled = true;
          if (password) password.input.value = '';
          feedback.textContent = error?.code === 'CLIENT_ABORTED'
            ? 'Join cancelled. No room state was assumed.'
            : error?.code === 'SLOT_RESERVATION_EXPIRED'
              ? 'The fresh slot reservation also expired. Room occupancy may have changed; refresh before trying again.'
              : safeError(error).message;
          (password?.input || feedback).focus();
        },
        });
      }, { className: 'os-button os-button--primary', dataset: { operation: 'join' }, disabled: !id || room.joinable === false }),
      cancelJoin,
      shellLink(homePath(isFeatureEnabled) === '/welcome' ? 'Back to welcome' : 'Back to rooms',
        homePath(isFeatureEnabled), { className: 'os-button os-button--quiet' }),
    ]),
  ]);
}

const TEAM_LABELS = Object.freeze({ alpha: 'Alpha', bravo: 'Bravo', unassigned: 'Unassigned', A: 'Alpha', B: 'Bravo' });
const READY_CLEAR_LABELS = Object.freeze({
  'roster-change': 'Readiness was cleared because the roster changed.',
  'team-change': 'Readiness was cleared because a team changed.',
  'loadout-change': 'Readiness was cleared because the loadout changed.',
  'room-change': 'Readiness was cleared because the room settings changed.',
});

function normalizedTeam(team) {
  if (team === 'A') return 'alpha';
  if (team === 'B') return 'bravo';
  return ['alpha', 'bravo'].includes(team) ? team : 'unassigned';
}

function memberId(member) {
  return member?.accountId || member?.id || null;
}

function pendingIntent(view, kind) {
  const pending = view.data?.pendingIntent || view.data?.pending;
  if (typeof pending === 'string') return pending === kind;
  if (pending?.type === kind || pending?.kind === kind) return true;
  const types = {
    team: 'team.request', ready: 'ready.set', loadout: 'loadout.set',
    chat: 'chat.send', ping: 'ping.send',
  };
  return Object.values(pending || {}).some((intent) => intent?.t === types[kind]);
}

function memberRow(member) {
  const ping = Number.isFinite(member.estimatedRttMs) ? `${member.estimatedRttMs} ms` : 'Latency unknown';
  const cleared = member.clearedReason ? READY_CLEAR_LABELS[member.clearedReason] || `Readiness cleared: ${member.clearedReason}` : null;
  return element('li', { className: 'os-roster-member', dataset: { accountId: memberId(member) || '' } }, [
    element('div', { className: 'os-roster-member__identity' }, [
      element('strong', {}, member.displayName || 'Unnamed player'),
      member.isLocal ? statusBadge('You') : null,
      member.isOwner ? statusBadge('Host') : null,
    ]),
    element('span', {}, member.connection || 'Connection unknown'),
    element('span', {}, ping),
    element('span', { className: member.ready ? 'os-ready os-ready--yes' : 'os-ready os-ready--no' }, member.ready ? '✓ READY' : '○ NOT READY'),
    cleared ? element('span', { className: 'os-ready-reason' }, cleared) : null,
  ]);
}

function rosterBoard(members = []) {
  const board = element('div', { className: 'os-team-grid' });
  for (const team of ['alpha', 'bravo', 'unassigned']) {
    const teamMembers = members.filter((member) => normalizedTeam(member.team) === team);
    const list = element('ul', { className: 'os-roster', 'aria-label': `${TEAM_LABELS[team]} roster` });
    if (teamMembers.length) teamMembers.forEach((member) => list.append(memberRow(member)));
    else list.append(element('li', { className: 'os-roster-empty' }, 'No players'));
    board.append(element('section', { className: `os-team os-team--${team}` }, [
      element('h2', {}, `${TEAM_LABELS[team]} — ${teamMembers.length}`),
      list,
    ]));
  }
  return board;
}

function roomNavigation(roomIdValue) {
  const encoded = encodeURIComponent(roomIdValue || '');
  return element('nav', { className: 'os-subnav', 'aria-label': 'Room' }, [
    shellLink('Lobby', `/room/${encoded}`),
    shellLink('Roster', `/room/${encoded}/roster`),
    shellLink('Loadout', `/room/${encoded}/loadout`),
    shellLink('Chat', `/room/${encoded}/chat`),
  ]);
}

function roomSummary(room) {
  const ping = roomPing(room);
  const counts = roomCounts(room);
  return definitionList([
    ['Room', room?.name || roomId(room)],
    ['Map', mapLabel(roomMap(room))],
    ['Mode', modeLabel(room?.mode)],
    ['Region', room?.region],
    ['Measured latency', ping === null ? 'Unknown' : `${ping} ms`],
    ['Status', room?.status],
    ['Capacity', counts.label],
    ['Rules version', room?.rulesetVersion],
  ]);
}

function lobbyNotices(view, actions, isFeatureEnabled) {
  const notices = element('div', { className: 'os-lobby-notices' });
  const controllerStatus = view.data?.status;
  const connection = view.data?.lobbyConnection || view.data?.connection
    || (controllerStatus && !['synchronized', 'countdown', 'allocating', 'handoff-ready'].includes(controllerStatus)
      ? { state: controllerStatus, ...(view.data?.reconnect || {}) } : null);
  if (connection && !['live', 'connected', 'synchronized'].includes(connection.state || connection)) {
    const state = connection.state || connection;
    const attempt = Number.isInteger(connection.attempt) && Number.isInteger(connection.maxAttempts)
      ? ` ${connection.attempt}/${connection.maxAttempts}` : '';
    notices.append(element('section', { className: 'os-state os-state--offline', role: 'status' }, [
      element('strong', {}, `Lobby connection: ${state}${attempt}`),
      connection.message ? element('p', {}, connection.message) : null,
      connection.graceEndsAt ? element('p', {}, `Seat held until: ${dateText(connection.graceEndsAt)}`) : null,
      connection.canCancel ? actionButton('Cancel reconnect', () => actions.submit('cancelLobbyReconnect', {}, {
        onError: (error) => actions.announce(safeError(error).message),
      }), { className: 'os-button os-button--quiet', dataset: { operation: 'cancel-reconnect' } }) : null,
      ['closed', 'failed'].includes(state) ? actionsRow([
        shellLink(isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? 'Return to welcome' : 'Return to rooms', homePath(isFeatureEnabled), { className: 'os-button os-button--quiet' }),
        shellLink('Exit to welcome', '/welcome', { className: 'os-button os-button--quiet' }),
      ]) : null,
    ]));
  }
  const clearedReason = view.data?.readyClearedReason;
  if (clearedReason) notices.append(element('p', { className: 'os-notice', role: 'status' }, READY_CLEAR_LABELS[clearedReason] || `Readiness cleared: ${clearedReason}`));
  if (view.data?.countdownAbortedReason) {
    notices.append(element('p', { className: 'os-notice', role: 'status' }, `Countdown stopped: ${String(view.data.countdownAbortedReason).replaceAll('-', ' ')}.`));
  }
  if (view.data?.intentError) {
    notices.append(element('p', { className: 'os-state os-state--error', role: 'alert', tabIndex: -1, 'data-error-summary': 'true' }, safeError(view.data.intentError).message));
  }
  if (view.data?.failure && !view.data?.intentError) {
    notices.append(element('p', { className: 'os-state os-state--error', role: 'alert', tabIndex: -1, 'data-error-summary': 'true' }, safeError(view.data.failure).message));
  }
  if (view.data?.notice) notices.append(element('p', { className: 'os-notice', role: 'status' }, view.data.notice));
  if (view.data?.allocation?.state) {
    notices.append(element('p', { className: 'os-notice', role: 'status' }, view.data.allocation.message || `Match allocation: ${view.data.allocation.state}.`));
  }
  return notices;
}

function countdownPanel(view) {
  const countdown = view.data?.countdown;
  if (!countdown) return null;
  const remainingMs = Number.isFinite(countdown.remainingMs)
    ? countdown.remainingMs
    : Number.isFinite(view.data?.countdownRemainingMs) ? view.data.countdownRemainingMs : null;
  return element('section', { className: 'os-countdown', role: 'timer', 'aria-label': 'Match countdown' }, [
    element('h2', {}, 'Match countdown'),
    remainingMs === null
      ? element('p', {}, countdown.endsAt ? `Authoritative end: ${dateText(countdown.endsAt)}` : 'Waiting for the next server tick.')
      : element('p', { className: 'os-countdown__value' }, `${Math.max(0, Math.ceil(remainingMs / 1000))} seconds`),
    element('p', {}, `${countdown.currentReady ?? '—'} of ${countdown.requiredReady ?? '—'} required players ready.`),
  ]);
}

function lobbyControls({ route, view, actions, isFeatureEnabled }) {
  const members = view.data?.members || view.data?.roster || [];
  const local = members.find((member) => member.isLocal) || view.data?.you || {};
  const currentReady = view.data?.selfReady ?? local.ready === true;
  const frozen = Boolean(view.data?.countdown) || view.data?.room?.status === 'countdown';
  const connected = !view.data?.status || ['synchronized', 'countdown'].includes(view.data.status);
  const teamPending = pendingIntent(view, 'team');
  const readyPending = pendingIntent(view, 'ready');
  const optimisticTeam = view.data?.optimistic?.team || view.data?.pendingIntent?.team || null;
  const optimisticReady = view.data?.optimistic?.ready;
  const feedback = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite', tabIndex: -1 });
  const submitIntent = (operation, payload, pendingMessage, successMessage) => {
    feedback.textContent = pendingMessage;
    return actions.submit(operation, payload, {
      onSuccess: (result) => {
        feedback.textContent = successMessage;
        if (result) actions.refresh();
      },
      onError: (error) => {
        feedback.textContent = `${safeError(error).message} The authoritative roster has not changed.`;
        feedback.focus();
      },
    });
  };
  const roomIdValue = route.params.roomId;
  return element('section', { className: 'os-lobby-controls' }, [
    feedback,
    teamPending ? element('p', { className: 'os-notice', role: 'status' }, `Team change pending${optimisticTeam ? `: ${optimisticTeam === 'auto' ? 'automatic assignment' : TEAM_LABELS[normalizedTeam(optimisticTeam)]}` : ''}. The roster remains authoritative.`) : null,
    readyPending ? element('p', { className: 'os-notice', role: 'status' }, `${optimisticReady === false ? 'Not-ready' : 'Ready'} request pending. The roster label remains authoritative until the server answers.`) : null,
    actionsRow([
      actionButton('Join Alpha', () => submitIntent('setTeam', { roomId: roomIdValue, team: 'alpha' }, 'Requesting Alpha…', 'Team response received.'), {
        className: 'os-button os-button--quiet', dataset: { operation: 'team-alpha' }, disabled: !connected || frozen || teamPending,
      }),
      actionButton('Join Bravo', () => submitIntent('setTeam', { roomId: roomIdValue, team: 'bravo' }, 'Requesting Bravo…', 'Team response received.'), {
        className: 'os-button os-button--quiet', dataset: { operation: 'team-bravo' }, disabled: !connected || frozen || teamPending,
      }),
      actionButton('Unassigned', () => submitIntent('setTeam', { roomId: roomIdValue, team: 'auto' }, 'Requesting automatic assignment…', 'Team response received.'), {
        className: 'os-button os-button--quiet', dataset: { operation: 'team-auto' }, disabled: !connected || frozen || teamPending,
      }),
    ]),
    actionsRow([
      actionButton(currentReady ? '✓ READY — select to cancel' : '○ GREEN UP', () => submitIntent('setReady', {
        roomId: roomIdValue, ready: !currentReady,
      }, currentReady ? 'Cancelling ready state…' : 'Requesting ready state…', 'Ready response received.'), {
        className: currentReady ? 'os-button os-button--quiet' : 'os-button os-button--primary',
        dataset: { operation: 'ready' }, disabled: !connected || readyPending || Boolean(view.data?.readyUnavailableReason),
        'aria-pressed': currentReady ? 'true' : 'false',
      }),
      local.isOwner ? actionButton('Launch when ready', () => submitIntent('launchRoom', { roomId: roomIdValue }, 'Requesting launch…', 'Launch request accepted.'), {
        className: 'os-button os-button--primary', dataset: { operation: 'launch' }, disabled: !connected || frozen,
      }) : null,
      actionButton('Leave room', (event) => actions.openModal({
        title: 'Leave this room?',
        message: 'Your place in the room is released only after the service confirms the request.',
        confirmLabel: 'Leave room',
        opener: event.currentTarget,
        onConfirm: () => actions.submit('leaveRoom', { roomId: roomIdValue }, {
          onSuccess: () => {
            actions.recordLobbyAbandoned(view.data?.countdown ? 'countdown' : 'in-lobby');
            actions.navigate(homePath(isFeatureEnabled));
          },
          onError: (error) => {
            feedback.textContent = safeError(error).message;
            feedback.focus();
          },
        }),
      }), { className: 'os-button os-button--danger', dataset: { operation: 'leave' }, disabled: !connected }),
      local.isOwner && members.length <= 1 ? actionButton('Delete room', (event) => actions.openModal({
        title: 'Delete this room?',
        message: 'This closes the room permanently. There is no undo.',
        confirmLabel: 'Delete room',
        opener: event.currentTarget,
        onConfirm: () => actions.submit('deleteRoom', { roomId: roomIdValue }, {
          onSuccess: () => actions.navigate(homePath(isFeatureEnabled)),
          onError: (error) => {
            feedback.textContent = safeError(error).message;
            feedback.focus();
          },
        }),
      }), { className: 'os-button os-button--danger', dataset: { operation: 'delete-room' }, disabled: !connected }) : null,
    ]),
    view.data?.readyUnavailableReason ? element('p', { className: 'os-warning' }, view.data.readyUnavailableReason) : null,
  ]);
}

function renderLobby({ route, view, actions, isFeatureEnabled }) {
  const room = view.data?.room || {};
  const members = view.data?.members || view.data?.roster || [];
  return element('section', {}, [
    roomNavigation(route.params.roomId),
    lobbyNotices(view, actions, isFeatureEnabled),
    roomSummary(room),
    countdownPanel(view),
    rosterBoard(members),
    lobbyControls({ route, view, actions, isFeatureEnabled }),
  ]);
}

function renderRoster({ route, view, actions, isFeatureEnabled }) {
  const members = view.data?.members || view.data?.roster || [];
  return element('section', {}, [
    roomNavigation(route.params.roomId),
    lobbyNotices(view, actions, isFeatureEnabled),
    rosterBoard(members),
    lobbyControls({ route, view, actions, isFeatureEnabled }),
  ]);
}

function renderChat({ route, view, actions, isFeatureEnabled }) {
  const expectedRoomId = route.params.roomId;
  const connected = !view.data?.status || ['synchronized', 'countdown'].includes(view.data.status);
  const historyRoomId = view.data?.historyRoomId || view.data?.roomId || expectedRoomId;
  const messages = historyRoomId === expectedRoomId
    ? view.data?.messages || view.data?.chatHistory || []
    : [];
  const list = element('ol', { className: 'os-chat-log', 'aria-label': 'Room messages' });
  for (const message of messages) {
    const accountId = message.accountId || message.authorId;
    const report = accountId && isFeatureEnabled?.('reports.enabled') !== false
      ? element('details', { className: 'os-chat-report' }, [
        element('summary', {}, `Report ${message.displayName || message.author || 'player'}`),
      ]) : null;
    if (report) {
      const category = element('select', { 'aria-label': 'Report category' }, [
        element('option', { value: 'cheating' }, 'Cheating'),
        element('option', { value: 'harassment' }, 'Harassment'),
        element('option', { value: 'offensive-name' }, 'Offensive name'),
        element('option', { value: 'griefing' }, 'Griefing'),
        element('option', { value: 'other' }, 'Other'),
      ]);
      const description = element('textarea', { 'aria-label': 'Optional report details', maxLength: 500, rows: 3 });
      const reportStatus = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite' });
      const submitReport = actionButton('Submit report', (event) => actions.openModal({
        title: 'Submit this report?',
        message: 'The platform will review the report under the selected category.',
        confirmLabel: 'Submit report',
        opener: event.currentTarget,
        onConfirm: () => actions.submit('reportPlayer', {
          subjectAccountId: accountId,
          category: category.value,
          ...(message.id ? { chatMessageId: message.id } : {}),
          description: description.value || undefined,
        }, {
          onSuccess: (result) => {
            reportStatus.textContent = result?.reportId ? `Report submitted: ${result.reportId}.` : 'Report submitted.';
            description.value = '';
            report.open = false;
          },
          onError: (error) => { reportStatus.textContent = safeError(error).message; },
        }),
      }), { className: 'os-button os-button--quiet', dataset: { operation: 'report' } });
      report.append(category, description, submitReport, reportStatus);
    }
    list.append(element('li', { dataset: { messageId: message.id || '' } }, [
      element('strong', {}, message.displayName || message.author || 'Unknown player'),
      element('p', {}, message.removed ? 'Message removed by moderation.' : message.text || ''),
      message.filtered ? statusBadge('Filtered') : null,
      message.ts || message.sentAt ? element('time', { dateTime: message.ts || message.sentAt }, dateText(message.ts || message.sentAt)) : null,
      accountId ? actionButton(`Mute ${message.displayName || message.author || 'player'}`, () => actions.submit('mutePlayer', {
        accountId, roomId: expectedRoomId, muted: true,
      }, { onError: (error) => actions.announce(safeError(error).message) }), {
        className: 'os-button os-button--quiet', dataset: { operation: 'mute' },
      }) : null,
      report,
    ]));
  }
  if (!messages.length) list.append(element('li', {}, historyRoomId === expectedRoomId ? 'No messages have been sent in this room.' : 'Synchronizing this room’s history. Messages from another room are never displayed.'));
  const mutedAccountIds = Array.isArray(view.data?.mutedAccountIds) ? view.data.mutedAccountIds : [];
  const members = view.data?.members || view.data?.roster || [];
  const muted = mutedAccountIds.length ? element('section', { className: 'os-muted-players' }, [
    element('h2', {}, 'Muted players'),
    ...mutedAccountIds.map((accountId) => {
      const player = members.find((member) => memberId(member) === accountId);
      return element('div', { className: 'os-actions' }, [
        element('span', {}, player?.displayName || 'Muted player'),
        actionButton(`Unmute ${player?.displayName || 'player'}`, () => actions.submit('mutePlayer', {
          accountId, roomId: expectedRoomId, muted: false,
        }, { onError: (error) => actions.announce(safeError(error).message) }), {
          className: 'os-button os-button--quiet', dataset: { operation: 'unmute' },
        }),
      ]);
    }),
  ]) : null;
  let composer;
  if (isFeatureEnabled?.('chat.text.enabled') !== false) {
    const body = field({ label: 'Message', name: 'chat-message', autocomplete: 'off', required: true });
    body.input.maxLength = 200;
    const sendStatus = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite' });
    const remaining = element('span', { className: 'os-hint' }, '200 characters remaining');
    body.input.addEventListener('input', () => { remaining.textContent = `${200 - body.input.value.length} characters remaining`; });
    const send = submitButton('Send');
    send.disabled = !connected;
    composer = element('form', { className: 'os-form os-form--inline' }, [body.wrapper, remaining, sendStatus, send]);
    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      actions.submit('sendChat', { roomId: route.params.roomId, text: body.input.value }, {
        secretInputs: [body.input],
        onSuccess: () => { sendStatus.textContent = 'Message accepted.'; },
        onError: (error) => { sendStatus.textContent = safeError(error).message; },
      });
    });
  } else {
    composer = element('p', { className: 'os-notice', role: 'status' }, 'Text chat is unavailable. Existing room history remains visible.');
  }

  const pingOptions = Array.isArray(view.data?.pingOptions) ? view.data.pingOptions : [];
  let pingControls;
  if (isFeatureEnabled?.('chat.pings.enabled') === false) {
    pingControls = element('p', { className: 'os-notice', role: 'status' }, 'Tactical pings are unavailable.');
  } else if (pingOptions.length) {
    const select = element('select', { 'aria-label': 'Tactical ping' }, pingOptions.map((option) => element('option', { value: option.kind }, option.label || option.kind)));
    pingControls = element('div', { className: 'os-actions' }, [
      select,
      actionButton('Send tactical ping', () => actions.submit('sendPing', {
        roomId: expectedRoomId, kind: select.value,
      }, { onError: (error) => actions.announce(safeError(error).message) }), {
        className: 'os-button os-button--quiet', dataset: { operation: 'ping' }, disabled: !connected,
      }),
    ]);
  } else {
    pingControls = element('p', { className: 'os-hint' }, 'Tactical ping choices will appear when the room supplies its canned callouts.');
  }
  return element('section', {}, [
    roomNavigation(route.params.roomId),
    lobbyNotices(view, actions, isFeatureEnabled),
    view.data?.chatRateLimit ? element('p', { className: 'os-warning', role: 'status' }, view.data.chatRateLimit.message || 'Chat is rate limited. Try again when the server allows it.') : null,
    list,
    muted,
    pendingIntent(view, 'chat') ? element('p', { className: 'os-notice', role: 'status' }, 'A message is awaiting authoritative confirmation.') : null,
    composer,
    element('section', { className: 'os-ping-controls' }, [element('h2', {}, 'Tactical pings'), pingControls]),
  ]);
}

function loadoutOption(option) {
  if (typeof option === 'number') return { value: option, label: `Slot ${option}` };
  return { value: option?.index ?? option?.id, label: option?.label || option?.name || `Slot ${option?.index ?? option?.id}` };
}

function renderRoomLoadout(context) {
  const { route, view, actions } = context;
  const members = view.data?.members || view.data?.roster || [];
  const local = members.find((member) => member.isLocal) || view.data?.you || {};
  const current = view.data?.loadout || local.loadout || {};
  const optimistic = view.data?.optimistic?.loadout || null;
  const connected = !view.data?.status || view.data.status === 'synchronized';
  const options = view.data?.loadoutOptions || {};
  const primaryOptions = Array.isArray(options.primary) ? options.primary.map(loadoutOption).filter((option) => option.value !== undefined) : [];
  const secondaryOptions = Array.isArray(options.secondary) ? options.secondary.map(loadoutOption).filter((option) => option.value !== undefined) : [];
  const feedback = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite', tabIndex: -1 });
  const body = [
    roomNavigation(route.params.roomId),
    lobbyNotices(view, actions, context.isFeatureEnabled),
    definitionList([
      ['Current primary slot', current.primaryIdx],
      ['Current secondary slot', current.secondaryIdx],
    ]),
  ];
  if (!primaryOptions.length || !secondaryOptions.length) {
    body.push(element('p', { className: 'os-notice', role: 'status' }, 'Authoritative loadout choices are unavailable. The current loadout is unchanged.'));
    return element('section', {}, body);
  }
  const primary = element('select', { id: 'shell-loadout-primary', name: 'loadout-primary' }, primaryOptions.map((option) => element('option', { value: option.value }, option.label)));
  const secondary = element('select', { id: 'shell-loadout-secondary', name: 'loadout-secondary' }, secondaryOptions.map((option) => element('option', { value: option.value }, option.label)));
  primary.disabled = !connected;
  secondary.disabled = !connected;
  primary.value = String(optimistic?.primaryIdx ?? current.primaryIdx ?? primaryOptions[0].value);
  secondary.value = String(optimistic?.secondaryIdx ?? current.secondaryIdx ?? secondaryOptions[0].value);
  const form = element('form', { className: 'os-form' }, [
    element('div', { className: 'os-field' }, [element('label', { htmlFor: primary.id }, 'Primary'), primary]),
    element('div', { className: 'os-field' }, [element('label', { htmlFor: secondary.id }, 'Secondary'), secondary]),
    optimistic ? element('p', { className: 'os-notice', role: 'status' }, 'Loadout request pending. The current slots above remain authoritative until the roster confirms it.') : null,
    feedback,
    Object.assign(submitButton('Request loadout change'), { disabled: !connected || pendingIntent(view, 'loadout') }),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    feedback.textContent = 'Loadout change pending. The current loadout remains authoritative.';
    actions.submit('setLoadout', {
      roomId: route.params.roomId,
      primaryIdx: Number(primary.value),
      secondaryIdx: Number(secondary.value),
    }, {
      onSuccess: (result) => {
        feedback.textContent = 'Loadout response received.';
        if (result) actions.refresh();
      },
      onError: (error) => {
        feedback.textContent = `${safeError(error).message} The previous loadout remains selected.`;
        feedback.focus();
      },
    });
  });
  body.push(form);
  return element('section', {}, body);
}

function statCards(entries) {
  const wrapper = element('section', { className: 'os-card-grid' });
  for (const [label, value] of entries) {
    wrapper.append(element('article', { className: 'os-card' }, [element('h2', {}, label), element('p', { className: 'os-stat' }, value ?? 'Not available')]));
  }
  return wrapper;
}

function renderCareerOverview({ view }) {
  const data = view.data || {};
  const modes = Object.entries(data.modes || {}).map(([id, stats]) => ({
    id,
    name: id === 'tdm' ? 'Team deathmatch' : id === 'bomb' ? 'Bomb' : id,
    ...stats.totals,
    winRate: stats.totals?.matches ? stats.totals.wins / stats.totals.matches : null,
  }));
  return element('section', {}, [
    modes.length
      ? renderNamedStats(modes, [['Matches', 'matches'], ['Wins', 'wins'], ['Win rate', 'winRate']])
      : statCards([['Matches played', data.matchesPlayed], ['Wins', data.wins], ['Win rate', data.winRate]]),
    data.lastUpdatedAt ? element('p', {}, `Last confirmed: ${dateText(data.lastUpdatedAt)}`) : null,
  ]);
}

function renderNamedStats(items, valueFields) {
  const list = element('div', { className: 'os-card-grid' });
  for (const item of items || []) {
    const values = valueFields.map(([label, key]) => [label, item[key]]);
    list.append(element('article', { className: 'os-card' }, [element('h2', {}, item.name || 'Unnamed'), definitionList(values)]));
  }
  return list;
}

function renderMatches({ view }) {
  const list = element('ol', { className: 'os-list' });
  for (const match of view.data?.matches || view.data?.items || []) {
    list.append(element('li', {}, [
      element('div', {}, [element('strong', {}, match.mode || 'Match'), element('span', {}, match.result || match.outcome || match.status || 'Status unavailable')]),
      match.endedAt ? element('time', { dateTime: match.endedAt }, dateText(match.endedAt)) : null,
      match.id ? shellLink('View details', `/career/matches/${encodeURIComponent(match.id)}`) : null,
    ]));
  }
  return element('section', {}, [list]);
}

function renderTeamScores(scores) {
  if (!scores || typeof scores !== 'object') return null;
  return statCards([
    ['Alpha score', scores.alpha],
    ['Bravo score', scores.bravo],
  ]);
}

function renderPlayerStats(players) {
  if (!Array.isArray(players) || !players.length) return null;
  const table = element('table', { className: 'os-table' });
  table.append(element('caption', {}, 'Authoritative player statistics'));
  table.append(element('thead', {}, element('tr', {}, [
    element('th', { scope: 'col' }, 'Player'),
    element('th', { scope: 'col' }, 'Team'),
    element('th', { scope: 'col' }, 'Kills'),
    element('th', { scope: 'col' }, 'Deaths'),
    element('th', { scope: 'col' }, 'Assists'),
    element('th', { scope: 'col' }, 'Score'),
  ])));
  const body = element('tbody');
  for (const player of players) {
    body.append(element('tr', {}, [
      element('th', { scope: 'row' }, player.displayName || 'Unnamed player'),
      element('td', {}, player.team ?? 'Not available'),
      element('td', {}, player.kills ?? 'Not available'),
      element('td', {}, player.deaths ?? 'Not available'),
      element('td', {}, player.assists ?? 'Not available'),
      element('td', {}, player.score ?? 'Not available'),
    ]));
  }
  table.append(body);
  return element('div', { className: 'os-table-scroll', tabIndex: 0 }, table);
}

function renderRounds(rounds) {
  if (!Array.isArray(rounds) || !rounds.length) return null;
  const list = element('ol', { className: 'os-list' });
  for (const round of rounds) {
    list.append(element('li', {}, [
      element('strong', {}, `Round ${Number.isInteger(round.index) ? round.index + 1 : '—'}`),
      element('span', {}, `Winner: ${round.winner ?? 'Not available'}`),
      element('span', {}, `Reason: ${round.reason ?? 'Not available'}`),
    ]));
  }
  return element('section', {}, [element('h2', {}, 'Round history'), list]);
}

function renderMatchDetail({ view }) {
  const match = view.data?.match || view.data || {};
  return element('section', {}, [
    definitionList([
      ['Match', match.id],
      ['Mode', match.mode],
      ['Map', match.mapId],
      ['Region', match.region],
      ['Status', match.status],
      ['Outcome', match.outcomeReason ?? match.outcome],
      ['Winner', match.winnerTeam],
      ['Termination', match.terminationReason],
      ['Ended', dateText(match.endedAt)],
    ]),
    renderTeamScores(match.teamScores),
    renderPlayerStats(match.players),
    renderRounds(match.rounds),
    shellLink('Back to match history', '/career/matches', { className: 'os-button os-button--quiet' }),
  ]);
}

/**
 * items-inventory.md §2's closed slot vocabulary, mirrored from the FROZEN contract (the typed
 * client validates it independently; this copy only orders and labels the same eight keys).
 */
const EQUIP_SLOT_LABELS = Object.freeze({
  primary: 'Primary weapon',
  secondary: 'Secondary weapon',
  melee: 'Melee',
  helmet: 'Helmet',
  vest: 'Vest',
  backpack: 'Backpack',
  rig: 'Rig',
  consumable: 'Quick item',
});
const EQUIP_SLOT_ORDER = Object.freeze(Object.keys(EQUIP_SLOT_LABELS));

/**
 * items-inventory.md §8's closed error enumeration, translated into instructions a player can
 * act on. Unknown codes fall back to the server message rather than a guess.
 */
const LOADOUT_ERROR_COPY = Object.freeze({
  LOADOUT_INVALID_SLOT: 'An item is placed in a slot its type cannot occupy. Check each slot and save again.',
  LOADOUT_ITEM_NOT_OWNED: 'An item in this loadout is no longer in your permanent inventory — it may have been lost, consumed, or taken into a raid. Replace it and save again.',
  LOADOUT_DUPLICATE_INSTANCE: 'The same physical item is equipped in two slots. One item can fill only one slot.',
  ITEM_LOCKED: 'An item in this loadout is reserved by an active deployment and cannot change until that deployment resolves.',
  ITEM_ALREADY_DEPLOYED: 'An item in this loadout is already deployed in another match.',
});

const LOCKED_CHIP = 'Locked — reserved for deployment';

function itemName(item) {
  const definition = item?.definition || {};
  if (definition.name) return definition.name;
  const id = definition.itemId || item?.itemId;
  return id ? String(id).replaceAll('_', ' ') : 'Unknown item';
}

function itemRarityLabel(item) {
  const tier = item?.definition?.rarityTier;
  return tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : 'Unknown';
}

function itemSlotLabel(item) {
  const slot = item?.definition?.slot;
  return slot ? EQUIP_SLOT_LABELS[slot] || slot : 'Not equippable — carried as raid loot only';
}

function itemQuantityLabel(item) {
  if (item?.definition?.stackable !== true) return '1 (serialized item)';
  return Number.isFinite(item?.definition?.maxStack)
    ? `${item.quantity} of ${item.definition.maxStack}`
    : String(item.quantity);
}

// P4-04 placeholder made visible instead of invented: the schema reserves durability now, but
// no P3 code path writes it, so a null value is labeled as "not tracked yet" rather than 0%.
function itemDurabilityLabel(item) {
  const max = item?.definition?.durabilityMax;
  if (max === null || max === undefined) return 'No durability model';
  return Number.isFinite(item?.durability)
    ? `${item.durability} of ${max}`
    : `Not tracked yet — wear and repair arrive in a later phase (max ${max})`;
}

function itemLocationLabel(item) {
  if (item?.location === 'permanent') return 'Permanent — kept between raids';
  if (item?.location === 'run') return 'In an active raid — returns on extraction, lost otherwise';
  return 'Not in your possession';
}

function renderInventory({ view, actions }) {
  const items = Array.isArray(view.data?.items) ? view.data.items : [];
  const grid = element('section', { className: 'os-card-grid', 'aria-label': 'Permanent inventory' });
  for (const item of items) {
    grid.append(element('article', {
      className: 'os-card os-inventory-card',
      dataset: { instanceId: item.instanceId || '', locked: String(item.locked === true) },
    }, [
      element('h2', {}, itemName(item)),
      item.locked ? statusBadge(LOCKED_CHIP) : null,
      definitionList([
        ['Rarity', itemRarityLabel(item)],
        ['Slot', itemSlotLabel(item)],
        ['Quantity', itemQuantityLabel(item)],
        ['Durability', itemDurabilityLabel(item)],
        ['Location', itemLocationLabel(item)],
      ]),
      item.instanceId
        ? shellLink('Inspect', `/inventory/${encodeURIComponent(item.instanceId)}`, {
          className: 'os-button os-button--quiet',
          'aria-label': `Inspect ${itemName(item)}`,
        })
        : null,
    ]));
  }
  return element('section', {}, [
    element('p', { className: 'os-lede' }, 'Everything you own between raids. Equip items into a loadout to take them into a deployment.'),
    // "Capacity" made understandable by being honest: permanent inventory has no capacity
    // limit in this phase (settlement.md §8 names one as a possible later amendment), so the
    // count is shown and no invented meter is.
    element('p', { className: 'os-hint' }, `${items.length} item${items.length === 1 ? '' : 's'} shown. Permanent inventory has no capacity limit in this phase.`),
    element('p', { className: 'os-notice', role: 'note' }, 'Items you are carrying in an active raid are not listed here. They return to this inventory when you extract, and are lost if you do not.'),
    actionsRow([
      shellLink('Prepare a loadout', '/loadouts', { className: 'os-button os-button--primary' }),
      actionButton('Refresh inventory', actions.refresh, { className: 'os-button os-button--quiet' }),
      view.data?.nextCursor
        ? actionButton('Load more items', () => actions.loadMore('items', view.data.nextCursor), { className: 'os-button os-button--quiet' })
        : null,
    ]),
    view.data?.paginationError
      ? element('p', { className: 'os-state os-state--error', role: 'alert' }, `More items could not be loaded: ${safeError(view.data.paginationError).message}`)
      : null,
    grid,
  ]);
}

function renderInventoryItem({ view }) {
  const item = view.data?.instanceId ? view.data : view.data?.item || {};
  if (!item.instanceId) {
    return element('section', { className: 'os-state', role: 'status' }, [
      element('p', {}, 'This item is not available.'),
      actionsRow([shellLink('Back to inventory', '/inventory', { className: 'os-button os-button--quiet' })]),
    ]);
  }
  return element('section', { className: 'os-inventory-detail' }, [
    element('h2', {}, itemName(item)),
    item.locked ? statusBadge(LOCKED_CHIP) : null,
    definitionList([
      ['Item type', item.itemId],
      ['Instance', item.instanceId],
      ['Class', item.definition?.class],
      ['Rarity', itemRarityLabel(item)],
      ['Slot', itemSlotLabel(item)],
      ['Quantity', itemQuantityLabel(item)],
      ['Durability', itemDurabilityLabel(item)],
      ['Location', itemLocationLabel(item)],
      ['Status', item.status],
    ]),
    item.locked
      ? element('p', { className: 'os-notice', role: 'status' }, `This item is reserved by deployment ${item.lockedByDeploymentId}. Until that deployment resolves, it cannot be modified or equipped into another deployment.`)
      : null,
    item.location === 'run'
      ? element('p', { className: 'os-notice', role: 'status' }, 'This item is inside an active raid. It returns to your permanent inventory if you extract, and is lost if you die or abort. It cannot be equipped into a loadout while the raid is live.')
      : null,
    item.definition?.slot === null || item.definition?.slot === undefined
      ? element('p', { className: 'os-hint' }, 'This item has no equipment slot, so it can never appear in a loadout. You will find and carry items like this as loot inside a raid.')
      : null,
    actionsRow([
      shellLink('Back to inventory', '/inventory', { className: 'os-button os-button--quiet' }),
      shellLink('Prepare a loadout', '/loadouts', { className: 'os-button os-button--quiet' }),
    ]),
  ]);
}

function renderLoadouts({ view, actions }) {
  const data = view.data || {};
  const loadouts = Array.isArray(data.loadouts) ? data.loadouts : [];
  const items = Array.isArray(data.items) ? data.items : [];
  const byInstanceId = new Map(items.map((item) => [item.instanceId, item]));
  // §3.1 rule 1: only owned, permanent, active, UNLOCKED instances are equippable; rule 2's
  // slot match is enforced by construction — each select only ever offers its own slot's items.
  const equippable = (slot) => items.filter((item) => item.definition?.slot === slot
    && item.location === 'permanent' && item.status === 'active' && item.locked !== true);

  const feedback = element('p', { className: 'os-field-status', role: 'status', 'aria-live': 'polite', tabIndex: -1 });
  const surfaceError = (error) => {
    const safe = safeError(error);
    feedback.textContent = (safe.code && LOADOUT_ERROR_COPY[safe.code]) || safe.message;
    feedback.focus();
  };

  const nameField = field({ label: 'Loadout name', name: 'loadout-name', required: true });
  const editorHeading = element('h2', {}, 'Create a loadout');
  const slotSelects = new Map();
  const slotRows = [];
  for (const slot of EQUIP_SLOT_ORDER) {
    const options = equippable(slot);
    const select = element('select', { id: `shell-loadout-slot-${slot}`, name: `loadout-slot-${slot}` }, [
      element('option', { value: '' }, 'Empty'),
      ...options.map((item) => element('option', { value: item.instanceId }, itemName(item))),
    ]);
    slotSelects.set(slot, select);
    slotRows.push(element('div', { className: 'os-field' }, [
      element('label', { htmlFor: select.id }, EQUIP_SLOT_LABELS[slot]),
      select,
      options.length ? null : element('p', { className: 'os-hint' }, 'No eligible item. Only unlocked items in your permanent inventory can be equipped.'),
    ]));
  }

  let editingLoadoutId = null;
  const cancelEdit = actionButton('Cancel edit', () => setEditing(null), {
    className: 'os-button os-button--quiet', dataset: { operation: 'cancel-edit-loadout' },
  });
  cancelEdit.hidden = true;

  function setEditing(loadout) {
    editingLoadoutId = loadout?.loadoutId || null;
    editorHeading.textContent = loadout ? `Edit ${loadout.name}` : 'Create a loadout';
    nameField.input.value = loadout?.name || '';
    feedback.textContent = '';
    for (const [slot, select] of slotSelects) {
      const wanted = loadout?.slots?.[slot] || '';
      select.value = wanted;
      // A saved reference that is no longer eligible (locked by a deployment, lost, or in a
      // raid) is not among the options; the browser silently keeps the old selection, so the
      // miss is made explicit instead.
      if (wanted && select.value !== wanted) {
        select.value = '';
        const referenced = byInstanceId.get(wanted);
        feedback.textContent = referenced?.locked
          ? `The saved ${EQUIP_SLOT_LABELS[slot].toLowerCase()} is reserved by an active deployment. Choose a replacement or wait for that deployment to resolve.`
          : `The saved ${EQUIP_SLOT_LABELS[slot].toLowerCase()} is no longer equippable — it may have been lost or taken into a raid. Choose a replacement before saving.`;
      }
    }
    cancelEdit.hidden = !loadout;
    if (loadout) nameField.input.focus();
  }

  const form = element('form', { className: 'os-form' }, [
    nameField.wrapper,
    ...slotRows,
    actionsRow([submitButton('Save loadout'), cancelEdit]),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const slots = {};
    const used = new Map();
    for (const [slot, select] of slotSelects) {
      if (!select.value) continue;
      // §3.1 rule 3, checked before the request so the failure names both slots. Slot-filtered
      // selects make this unreachable today (one definition, one slot), but the guard keeps the
      // rule enforced here rather than remembered.
      if (used.has(select.value)) {
        feedback.textContent = `${LOADOUT_ERROR_COPY.LOADOUT_DUPLICATE_INSTANCE} (${EQUIP_SLOT_LABELS[used.get(select.value)]} and ${EQUIP_SLOT_LABELS[slot]}.)`;
        feedback.focus();
        return;
      }
      used.set(select.value, slot);
      slots[slot] = select.value;
    }
    const name = nameField.input.value.trim();
    actions.submit(editingLoadoutId ? 'updateLoadout' : 'createLoadout', {
      ...(editingLoadoutId ? { loadoutId: editingLoadoutId } : {}),
      name,
      slots,
    }, {
      onSuccess: (result) => {
        actions.announce(`Loadout ${result?.name || name} saved.`);
        actions.refresh();
      },
      onError: surfaceError,
    });
  });

  const list = element('section', { className: 'os-card-grid', 'aria-label': 'Saved loadouts' });
  for (const loadout of loadouts) {
    const slotFacts = EQUIP_SLOT_ORDER
      .filter((slot) => loadout.slots?.[slot])
      .map((slot) => {
        const item = byInstanceId.get(loadout.slots[slot]);
        if (!item) return [EQUIP_SLOT_LABELS[slot], 'Item unavailable — replace before deploying'];
        return [EQUIP_SLOT_LABELS[slot], item.locked
          ? `${itemName(item)} (reserved by an active deployment)`
          : itemName(item)];
      });
    list.append(element('article', { className: 'os-card os-loadout-card', dataset: { loadoutId: loadout.loadoutId || '' } }, [
      element('h2', {}, loadout.name),
      loadout.isDefault ? statusBadge('Default') : null,
      slotFacts.length ? definitionList(slotFacts) : element('p', {}, 'No items equipped.'),
      actionsRow([
        data.inventoryUnavailable ? null : actionButton(`Edit ${loadout.name}`, () => setEditing(loadout), {
          className: 'os-button os-button--quiet', dataset: { operation: 'edit-loadout' },
        }),
        loadout.isDefault ? null : actionButton(`Make ${loadout.name} default`, () => actions.submit('setDefaultLoadout', { loadoutId: loadout.loadoutId }, {
          onSuccess: () => {
            actions.announce(`${loadout.name} is now the default loadout.`);
            actions.refresh();
          },
          onError: surfaceError,
        }), { className: 'os-button os-button--quiet', dataset: { operation: 'default-loadout' } }),
        actionButton(`Delete ${loadout.name}`, (event) => actions.openModal({
          title: `Delete ${loadout.name}?`,
          message: 'Deleting a loadout does not delete or unlock any item in it.',
          confirmLabel: 'Delete loadout',
          opener: event.currentTarget,
          onConfirm: () => actions.submit('deleteLoadout', { loadoutId: loadout.loadoutId }, {
            onSuccess: () => {
              actions.announce(`${loadout.name} deleted.`);
              actions.refresh();
            },
            onError: surfaceError,
          }),
        }), { className: 'os-button os-button--danger', dataset: { operation: 'delete-loadout' } }),
      ]),
    ]));
  }

  return element('section', {}, [
    element('p', { className: 'os-lede' }, 'Prepare named loadouts from your permanent inventory. Deploying locks every equipped item to that deployment.'),
    // "Protect" made understandable by being honest: the contracts define exactly two run
    // exits (extract or lost) and no protected-item flag, so the screen says that plainly
    // instead of hinting at a mechanic that does not exist.
    element('p', { className: 'os-warning', role: 'note' }, 'No item is protected. Everything you equip deploys with you, and is lost if you die or abort instead of extracting. Item protection does not exist in this phase.'),
    feedback,
    loadouts.length
      ? list
      : element('p', { role: 'status' }, 'You have no saved loadouts yet. Create one below to prepare for deployment.'),
    data.inventoryUnavailable
      ? element('section', { className: 'os-state os-state--offline', role: 'status' }, [
        element('p', {}, 'Your inventory could not be loaded, so equipping is unavailable. Saved loadouts are shown read-only.'),
        actionsRow([actionButton('Try again', actions.refresh, { className: 'os-button os-button--primary' })]),
      ])
      : element('section', { className: 'os-loadout-editor' }, [editorHeading, form]),
    actionsRow([shellLink('View inventory', '/inventory', { className: 'os-button os-button--quiet' })]),
  ]);
}

function renderSessions({ view, actions }) {
  const list = element('ul', { className: 'os-list' });
  for (const session of view.data?.sessions || view.data?.items || []) {
    const controls = [];
    if (!session.current && session.id) {
      controls.push(actionButton('Revoke', (event) => actions.openModal({
        title: 'Revoke this session?',
        message: 'The session remains active until the service confirms revocation.',
        confirmLabel: 'Revoke session',
        opener: event.currentTarget,
        onConfirm: () => actions.submit('revokeSession', { sessionId: session.id }, { onSuccess: actions.refresh }),
      }), { className: 'os-button os-button--danger' }));
    }
    list.append(element('li', {}, [
      element('div', {}, [element('strong', {}, session.device || 'Unknown device'), statusBadge(session.current ? 'Current' : 'Active')]),
      session.lastSeenAt ? element('span', {}, `Last seen: ${dateText(session.lastSeenAt)}`) : null,
      ...controls,
    ]));
  }
  return element('section', {}, [
    list,
    actionButton('Sign out this device', (event) => actions.openModal({
      title: 'Sign out this device?',
      message: 'This device is signed out only after the service confirms the request.',
      confirmLabel: 'Sign out',
      opener: event.currentTarget,
      onConfirm: () => actions.submit('signOut', {}, {
        onSuccess: () => {
          actions.clearSession();
          actions.navigate('/auth/sign-in');
        },
      }),
    }), { className: 'os-button os-button--quiet' }),
    actionButton('Sign out all sessions', (event) => actions.openModal({
      title: 'Sign out everywhere?',
      message: 'Every session, including this one, will be revoked after confirmation.',
      confirmLabel: 'Sign out everywhere',
      opener: event.currentTarget,
      onConfirm: () => actions.submit('signOutAll', {}, {
        onSuccess: () => {
          actions.clearSession();
          actions.navigate('/auth/sign-in');
        },
      }),
    }), { className: 'os-button os-button--danger' }),
  ]);
}

function renderMatchLoading({ view, actions, capabilities, isFeatureEnabled }) {
  const data = view.data || {};
  // The HANDOFF names the map, not the rotation. Reading the rotation head here is exactly the
  // bug that showed players the wrong map's loading screen while the server had allocated
  // another one; `loadingArt` takes the handoff first for that reason.
  const mapId = data.handoff?.mapId || data.mapId || null;
  return element('section', {}, [
    keyArtPanel(loadingArt(data.handoff, data), {
      className: 'os-keyart-panel--loading',
      children: [
        element('p', { className: 'os-keyart-panel__kicker' }, mapId ? `Map · ${mapId}` : 'Map · pending allocation'),
        element('p', { role: 'status' }, data.stage || 'Waiting for an authoritative match handoff.'),
      ],
    }),
    capabilities?.supported
      ? null
      : element('p', { className: 'os-warning' }, 'Match entry is blocked because this device did not pass the capability check.'),
    actionsRow([
      actionButton('Enter match', () => actions.enterGame(data.handoff), {
        className: 'os-button os-button--primary',
        disabled: !capabilities?.supported || !data.handoff,
      }),
      data.retryAllowed ? actionButton('Retry handoff', () => actions.submit('getActiveMatch', {}, { onSuccess: actions.useResponse }), { className: 'os-button os-button--quiet' }) : null,
      shellLink(data.roomId ? 'Return to lobby' : isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? 'Return to welcome' : 'Return to rooms',
        data.roomId ? `/room/${encodeURIComponent(data.roomId)}` : homePath(isFeatureEnabled),
        { className: 'os-button os-button--quiet' }),
    ]),
  ]);
}

function renderReconnect({ view, actions, isFeatureEnabled }) {
  const data = view.data || {};
  return element('section', {}, [
    element('p', { role: 'status' }, data.message || 'The match connection was interrupted.'),
    data.graceEndsAt ? element('p', {}, `Reconnect deadline: ${dateText(data.graceEndsAt)}`) : null,
    actionsRow([
      actionButton('Reconnect', () => actions.submit('reconnectMatch', { matchId: data.matchId }, {
        onSuccess: (result) => actions.enterGame(result?.handoff),
      }), { className: 'os-button os-button--primary', disabled: data.retryAllowed === false }),
      data.returnAllowed ? shellLink(
        isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? 'Return to welcome' : 'Return to rooms',
        homePath(isFeatureEnabled),
        { className: 'os-button os-button--quiet' },
      ) : null,
    ]),
  ]);
}

/**
 * settlement.md §5.3's per-participant statuses, presented so each is visibly a different
 * fact. `settlementStatus` is the platform's own vocabulary (§3): `ended` (received, not yet
 * settled — the §5 rule 5 retry-safe window), `settled`, `exception-open`, and
 * `exception-resolved` (whose `outcome: null` branch is a §6.1 void). `outcome` is §4's
 * closed enum. Nothing here invents a fifth status or a third item disposition.
 */
const SETTLEMENT_STATUS_PRESENTATION = Object.freeze({
  extracted: {
    kind: 'extracted',
    label: 'Extracted',
    detail: 'Every item carried out has been returned to the permanent inventory.',
  },
  died: {
    kind: 'lost',
    label: 'Lost — killed in the raid',
    detail: 'Every item carried was lost.',
  },
  aborted: {
    kind: 'lost',
    label: 'Lost — run aborted',
    detail: 'Every item carried was lost. An abort settles exactly like a death — quitting or disconnecting past grace never protects a run.',
  },
  'server-failure': {
    kind: 'server-failure',
    label: 'Server fault — settled from last known state',
    detail: 'The raid server reported its own fault. Settlement ruled this run from the last trustworthy state it recorded, not from a guess.',
  },
});

function settlementPresentation(participant) {
  const status = participant?.settlementStatus;
  if (status === 'ended' || status === undefined || status === null) {
    return {
      kind: 'retry-safe',
      label: 'Result received — settling',
      detail: 'The run result has been accepted and settlement is in progress. It is safe to leave this screen: settlement applies exactly once, and a retry can never settle the same items twice.',
    };
  }
  if (status === 'exception-open') {
    return {
      kind: 'pending-review',
      label: 'Held for review',
      detail: 'This outcome could not be settled automatically and is queued for a reviewer. Items are neither returned nor lost until the review resolves — no action is needed, and nothing is settled twice.',
    };
  }
  if (status === 'exception-resolved' && (participant.outcome === null || participant.outcome === undefined)) {
    return {
      kind: 'reviewed-void',
      label: 'Reviewed — no settlement applied',
      detail: 'A reviewer closed this run without applying an item outcome. No items were moved or lost by this run.',
    };
  }
  const base = SETTLEMENT_STATUS_PRESENTATION[participant.outcome] || {
    kind: 'unknown',
    label: 'Outcome unavailable',
    detail: 'The platform reported a settlement state this client does not recognise. The recorded outcome is authoritative.',
  };
  if (status === 'exception-resolved') {
    return { ...base, label: `${base.label} (after review)`, detail: `${base.detail} A reviewer confirmed this outcome.` };
  }
  return base;
}

function settlementParticipantCard(participant, isLocal = participant?.isLocal === true) {
  const presentation = settlementPresentation(participant);
  const facts = [
    ['Result', presentation.label],
    participant.outcome === 'extracted' && participant.exitId ? ['Exit used', participant.exitId] : null,
    participant.outcome === 'died' && participant.deathCause ? ['Cause', participant.deathCause] : null,
    presentation.kind === 'pending-review' && participant.exceptionId ? ['Review reference', participant.exceptionId] : null,
    presentation.kind === 'pending-review' && participant.trigger ? ['Held because', String(participant.trigger).replaceAll('-', ' ')] : null,
  ].filter(Boolean);
  return element('article', {
    className: 'os-card os-settlement-card',
    dataset: { settlement: presentation.kind, accountId: participant.accountId || '' },
  }, [
    element('h2', {}, [
      element('span', {}, participant.displayName || participant.accountId || 'Participant'),
      isLocal ? statusBadge('You') : null,
    ]),
    statusBadge(presentation.label),
    definitionList(facts),
    element('p', { className: 'os-hint' }, presentation.detail),
  ]);
}

function renderExtractionResults({ view, actions, isFeatureEnabled, session }, result) {
  const settlement = result.settlement || {};
  const participants = Array.isArray(settlement.participants) ? settlement.participants : [];
  // The wire shape (match-result.md §4.4) identifies participants by accountId only — there is
  // no isLocal on it. The signed-in account is what makes one of them "you"; the isLocal flag
  // remains honoured for the fixture-driven variants that predate the wire shape.
  const localAccountId = session?.profile?.accountId ?? session?.accountId ?? null;
  const isLocalParticipant = (participant) => participant.isLocal === true
    || (Boolean(localAccountId) && participant.accountId === localAccountId);
  const local = participants.find(isLocalParticipant) || null;
  const localPresentation = local ? settlementPresentation(local) : null;
  const anyUnsettled = participants.some((participant) => {
    const kind = settlementPresentation(participant).kind;
    return kind === 'retry-safe' || kind === 'pending-review';
  });
  if (anyUnsettled && typeof actions?.registerCleanup === 'function' && typeof actions?.refresh === 'function') {
    const retryAfterMs = Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : 5000;
    const timer = setTimeout(() => actions.refresh(), retryAfterMs);
    actions.registerCleanup(() => clearTimeout(timer));
  }
  return element('section', { className: 'os-settlement' }, [
    localPresentation
      ? element('p', {
        className: localPresentation.kind === 'extracted' ? 'os-positive' : localPresentation.kind === 'lost' ? 'os-warning' : 'os-lede',
        role: 'status',
        dataset: { localSettlement: localPresentation.kind },
      }, `${localPresentation.label}. ${localPresentation.detail}`)
      : null,
    // "Protected" stated honestly rather than implied: the contracts define exactly two run
    // dispositions (extract-convert, lose-everything) and no protected-item flag
    // (settlement.md §4; items-inventory.md has no protection field), so this screen says
    // which items were protected — none — instead of leaving the question open.
    element('p', { className: 'os-notice', role: 'note' }, 'Protected items: none. Item protection does not exist in this phase — extraction keeps everything, any other outcome loses everything.'),
    settlement.runLevelException
      ? element('p', { className: 'os-state os-state--error', role: 'alert' },
        `A run-level exception is open for this raid (reference ${settlement.runLevelException.exceptionId}). A participant was missing from the submitted result; a reviewer will resolve it. Individual outcomes below are unaffected.`)
      : null,
    definitionList([
      ['Run', result.matchId],
      ['Mode', 'Extraction'],
      ['Map', result.mapId],
      ['Run status', result.status],
    ]),
    participants.length
      ? element('section', { className: 'os-card-grid', 'aria-label': 'Squad settlement' },
        participants.map((participant) => settlementParticipantCard(participant, isLocalParticipant(participant))))
      : element('p', { role: 'status' }, 'No participant settlement has been reported for this run yet.'),
    actionsRow([
      shellLink('View inventory', '/inventory', { className: 'os-button os-button--primary' }),
      anyUnsettled ? actionButton('Refresh settlement', () => actions.refresh(), { className: 'os-button os-button--quiet' }) : null,
      result.roomId
        ? shellLink('Return to lobby', `/room/${encodeURIComponent(result.roomId)}`, { className: 'os-button os-button--quiet' })
        : shellLink(
          isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? 'Return to welcome' : 'Browse rooms',
          homePath(isFeatureEnabled),
          { className: 'os-button os-button--quiet' },
        ),
    ]),
  ]);
}

function renderResults(context) {
  const { view, actions, isFeatureEnabled } = context;
  const result = view.data?.result || view.data || {};
  if (result.mode === 'extraction' && result.status !== 'pending') {
    return renderExtractionResults(context, result);
  }
  if (result.status === 'pending') {
    const retryAfterMs = Number.isFinite(result.retryAfterMs) ? result.retryAfterMs : 3000;
    if (typeof actions?.registerCleanup === 'function' && typeof actions?.refresh === 'function') {
      const timer = setTimeout(() => actions.refresh(), retryAfterMs);
      actions.registerCleanup(() => clearTimeout(timer));
    }
    return element('section', { className: 'os-state', role: 'status' }, [
      element('p', {}, result.mode === 'extraction'
        ? 'This run is still finalising. Results will appear automatically once they are ready.'
        : 'This match is still finalising. Results will appear automatically once they are ready.'),
      // settlement.md §5 rule 5: the raid server durably queues and retries the result, and
      // idempotency guarantees a retry never settles items twice — so waiting here is
      // optional, not required, and the screen says so.
      result.mode === 'extraction'
        ? element('p', { className: 'os-hint' }, 'It is safe to leave this screen. Your run result is queued and retried by the server, and settlement applies exactly once — a retry can never settle your items twice.')
        : null,
      definitionList([
        ['Status', result.status],
        ['Mode', result.mode],
        ['Map', result.mapId],
        ['Match', result.matchId],
      ]),
      actionsRow([
        actionButton('Retry', () => actions.refresh(), { className: 'os-button os-button--primary' }),
        result.roomId
          ? shellLink('Return to lobby', `/room/${encodeURIComponent(result.roomId)}`, { className: 'os-button os-button--quiet' })
          : shellLink(
            isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? 'Return to welcome' : 'Browse rooms',
            homePath(isFeatureEnabled),
            { className: 'os-button os-button--quiet' },
          ),
      ]),
    ]);
  }
  return element('section', {}, [
    definitionList([
      ['Status', result.status],
      ['Mode', result.mode],
      ['Map', result.mapId],
      ['Outcome', result.outcomeReason ?? result.outcome],
      ['Winner', result.winnerTeam],
      ['Termination', result.terminationReason],
      ['Match', result.matchId],
    ]),
    renderTeamScores(result.teamScores),
    renderPlayerStats(result.players),
    renderRounds(result.rounds),
    actionsRow([
      result.roomId
        ? shellLink('Return to lobby', `/room/${encodeURIComponent(result.roomId)}`, { className: 'os-button os-button--primary' })
        : shellLink(
          isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? 'Return to welcome' : 'Browse rooms',
          homePath(isFeatureEnabled),
          { className: 'os-button os-button--primary' },
        ),
      result.matchId ? shellLink('View match detail', `/career/matches/${encodeURIComponent(result.matchId)}`, { className: 'os-button os-button--quiet' }) : null,
    ]),
  ]);
}

function renderSystem({ route, view, actions }) {
  const condition = view.data?.condition || route.params.condition;
  const known = {
    maintenance: 'The platform is temporarily unavailable for maintenance.',
    'update-required': 'A client update is required before online play can continue.',
    'not-found': 'The requested page does not exist.',
    unavailable: 'The requested service is unavailable.',
  };
  return element('section', { className: 'os-state', role: 'status' }, [
    element('p', {}, view.data?.message || known[condition] || 'The platform reported a system condition.'),
    actionsRow([
      actionButton('Retry', actions.refresh, { className: 'os-button os-button--primary' }),
      shellLink('Return to welcome', '/welcome', { className: 'os-button os-button--quiet' }),
    ]),
  ]);
}

export function renderShellScreen(context) {
  const { route, view, actions } = context;
  const variant = renderGlobalVariant(route, view, actions);
  if (variant) return variant;

  let content;
  switch (route.id) {
    case 'welcome': content = renderWelcome(context); break;
    case 'auth.signIn': content = renderSignIn(context); break;
    case 'auth.create': content = renderCreateAccount(context); break;
    case 'auth.recover': content = renderRecovery(context); break;
    case 'onboarding.eligibility': content = renderEligibility(context); break;
    case 'onboarding.consent': content = renderConsent(context); break;
    case 'onboarding.displayName': content = renderDisplayName(context); break;
    case 'onboarding.verify': content = renderVerify(context); break;
    case 'onboarding.terms': content = renderTerms(context); break;
    case 'onboarding.essentialSettings': content = renderSettingsHook({ ...context, essential: true }); break;
    case 'play.rooms': content = renderRooms(context); break;
    case 'play.roomDetail': content = renderRoomDetail(context); break;
    case 'room.home': content = renderLobby(context); break;
    case 'room.roster': content = renderRoster(context); break;
    case 'room.loadout': content = renderRoomLoadout(context); break;
    case 'room.chat': content = renderChat(context); break;
    case 'career.overview': content = renderCareerOverview(context); break;
    case 'career.modes': content = renderNamedStats(view.data?.modes || view.data?.items, [['Matches', 'matches'], ['Wins', 'wins']]); break;
    case 'career.weapons': content = renderNamedStats(view.data?.weapons || view.data?.items, [['Eliminations', 'eliminations'], ['Accuracy', 'accuracy']]); break;
    case 'career.matches': {
      content = renderMatches(context);
      if (view.data?.nextCursor) {
        content.append(actionButton('Load more matches', () => actions.loadMore('matches', view.data.nextCursor), { className: 'os-button os-button--quiet' }));
      }
      break;
    }
    case 'career.matchDetail': content = renderMatchDetail(context); break;
    case 'inventory': content = renderInventory(context); break;
    case 'inventory.item': content = renderInventoryItem(context); break;
    case 'loadouts': content = renderLoadouts(context); break;
    case 'settings.category': content = renderSettingsHook(context); break;
    case 'sessions': content = renderSessions(context); break;
    case 'match.loading': content = renderMatchLoading(context); break;
    case 'match.reconnect': content = renderReconnect(context); break;
    case 'results': content = renderResults(context); break;
    case 'system': content = renderSystem(context); break;
    default: content = renderSystem(context);
  }
  if (view.variant === 'offline') {
    content.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const banner = element('section', { className: 'os-state os-state--offline', role: 'status' }, [
      element('h2', {}, 'Showing stale data'),
      element('p', {}, 'Mutating actions are disabled until current service data is confirmed.'),
      view.staleAt ? element('p', {}, `Last confirmed: ${dateText(view.staleAt)}`) : null,
      actionButton('Try again', actions.refresh, { className: 'os-button os-button--primary' }),
    ]);
    return element('div', { className: 'os-stale-content' }, [banner, content]);
  }
  return content;
}
