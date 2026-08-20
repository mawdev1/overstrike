import { actionButton, definitionList, element, field, safeError, shellLink } from './dom.js';
import { capabilityLabel } from './capabilities.js';
import { createSettingsScreen, SETTINGS_BY_KEY } from './settings/index.js';

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
    element('p', { className: 'os-lede' }, 'Sign in to browse rooms, manage your account, and prepare for a match.'),
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
  const canSubmit = Number.isInteger(data.policyVersion) && Boolean(actions.getClientSessionId());
  return element('section', {}, [
    element('p', {}, data.summary || 'Choose whether optional personal telemetry may be collected. Declining does not block account creation.'),
    data.policyVersion ? element('p', {}, `Policy version: ${data.policyVersion}`) : null,
    actionsRow([
      actionButton('Allow optional telemetry', () => actions.submit('setConsent', { telemetryPersonal: true, policyVersion: data.policyVersion, clientSessionId: actions.getClientSessionId() }, {
        onSuccess: (result) => {
          actions.updateDraft({ consentReceipt: result?.receipt, consentAllowed: true });
          actions.navigate('/auth/create-account');
        },
      }), { className: 'os-button os-button--primary', disabled: !canSubmit }),
      actionButton('Decline optional telemetry', () => actions.submit('setConsent', { telemetryPersonal: false, policyVersion: data.policyVersion, clientSessionId: actions.getClientSessionId() }, {
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

function renderEssentialSettings({ settings, actions }) {
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
    actions.navigate('/play/rooms');
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

function renderSettingsHook({ route, view, actions, settings, session, essential = false, loadout = false }) {
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
      onComplete: (result) => actions.navigate(actions.nextSetupPath(result) || '/play/rooms'),
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

function roomCard(room) {
  const id = room?.id;
  const card = element('article', { className: 'os-card' }, [
    element('h2', {}, room?.name || 'Unnamed room'),
    definitionList([
      ['Mode', room?.mode],
      ['Players', room?.occupancy],
      ['Region', room?.region],
      ['Measured latency', Number.isFinite(room?.measuredPingMs) ? `${room.measuredPingMs} ms` : null],
    ]),
  ]);
  if (id) card.append(shellLink('View room', `/play/rooms/${encodeURIComponent(id)}`, { className: 'os-button os-button--quiet' }));
  return card;
}

function renderRooms({ view }) {
  const rooms = view.data?.rooms || view.data?.items || [];
  if (!rooms.length) return element('p', {}, 'No rooms are available.');
  const ordered = [...rooms].sort((left, right) => {
    if (Boolean(left.joinable) !== Boolean(right.joinable)) return left.joinable ? -1 : 1;
    const leftPing = Number.isFinite(left.measuredPingMs) ? left.measuredPingMs : Number.POSITIVE_INFINITY;
    const rightPing = Number.isFinite(right.measuredPingMs) ? right.measuredPingMs : Number.POSITIVE_INFINITY;
    return leftPing - rightPing;
  });
  const search = field({ label: 'Filter rooms', name: 'room-search', type: 'search', autocomplete: 'off' });
  const joinable = element('input', { id: 'shell-room-joinable', type: 'checkbox' });
  const joinableLabel = element('label', { className: 'os-checkbox', htmlFor: joinable.id }, [joinable, element('span', {}, 'Joinable only')]);
  const grid = element('section', { className: 'os-card-grid', 'aria-label': 'Available rooms' });
  const cards = ordered.map((room) => ({ room, card: roomCard(room) }));
  cards.forEach(({ card }) => grid.append(card));
  const resultStatus = element('p', { role: 'status', 'aria-live': 'polite' });
  const apply = () => {
    const query = search.input.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const { room, card } of cards) {
      const haystack = [room.name, room.id, room.mode, room.region].filter(Boolean).join(' ').toLocaleLowerCase();
      const matches = (!query || haystack.includes(query)) && (!joinable.checked || room.joinable === true);
      card.hidden = !matches;
      if (matches) visible += 1;
    }
    resultStatus.textContent = `${visible} room${visible === 1 ? '' : 's'} shown.`;
  };
  search.input.addEventListener('input', apply);
  joinable.addEventListener('change', apply);
  const reset = actionButton('Reset filters', () => {
    search.input.value = '';
    joinable.checked = false;
    apply();
    search.input.focus();
  }, { className: 'os-button os-button--quiet' });
  apply();
  return element('section', {}, [element('div', { className: 'os-filter-bar' }, [search.wrapper, joinableLabel, reset]), resultStatus, grid]);
}

function renderRoomDetail({ view, actions }) {
  const room = view.data?.room || view.data || {};
  return element('section', {}, [
    definitionList([
      ['Room', room.name],
      ['Mode', room.mode],
      ['Map', room.map],
      ['Players', room.occupancy],
      ['Region', room.region],
    ]),
    actionsRow([
      actionButton('Join room', () => actions.submit('joinRoom', { roomId: room.id }, {
        onSuccess: (result) => {
          const confirmedId = result?.room?.id || result?.roomId;
          if (confirmedId) actions.navigate(`/room/${encodeURIComponent(confirmedId)}`);
        },
      }), { className: 'os-button os-button--primary', disabled: !room.id || room.joinable === false }),
      shellLink('Back to rooms', '/play/rooms', { className: 'os-button os-button--quiet' }),
    ]),
  ]);
}

function rosterList(members = []) {
  const list = element('ul', { className: 'os-roster' });
  for (const member of members) {
    list.append(element('li', {}, [
      element('strong', {}, member.displayName || 'Unnamed player'),
      element('span', {}, `Team: ${member.team || 'Unassigned'}`),
      statusBadge(member.ready ? 'Ready' : 'Not ready'),
    ]));
  }
  return list;
}

function roomNavigation(roomId) {
  const encoded = encodeURIComponent(roomId || '');
  return element('nav', { className: 'os-subnav', 'aria-label': 'Room' }, [
    shellLink('Lobby', `/room/${encoded}`),
    shellLink('Roster', `/room/${encoded}/roster`),
    shellLink('Loadout', `/room/${encoded}/loadout`),
    shellLink('Chat', `/room/${encoded}/chat`),
  ]);
}

function renderLobby({ route, view, actions }) {
  const room = view.data?.room || {};
  const members = view.data?.members || view.data?.roster || [];
  return element('section', {}, [
    roomNavigation(route.params.roomId),
    room.name ? element('p', { className: 'os-lede' }, room.name) : null,
    rosterList(members),
    actionsRow([
      actionButton(view.data?.selfReady ? 'Mark not ready' : 'Mark ready', () => actions.submit('setReady', { roomId: route.params.roomId, ready: !view.data?.selfReady }, {
        onSuccess: actions.refresh,
      }), { className: 'os-button os-button--primary' }),
      actionButton('Leave room', (event) => actions.openModal({
        title: 'Leave this room?',
        message: 'Your place in the room is released only after the service confirms the request.',
        confirmLabel: 'Leave room',
        opener: event.currentTarget,
        onConfirm: () => actions.submit('leaveRoom', { roomId: route.params.roomId }, {
          onSuccess: () => {
            actions.recordLobbyAbandoned(view.data?.countdown ? 'countdown' : 'in-lobby');
            actions.navigate('/play/rooms');
          },
        }),
      }), { className: 'os-button os-button--danger' }),
    ]),
  ]);
}

function renderRoster({ route, view, actions }) {
  const members = view.data?.members || view.data?.roster || [];
  return element('section', {}, [
    roomNavigation(route.params.roomId),
    rosterList(members),
    actionsRow([
      actionButton('Join team A', () => actions.submit('setTeam', { roomId: route.params.roomId, team: 'A' }, { onSuccess: actions.refresh }), { className: 'os-button os-button--quiet' }),
      actionButton('Join team B', () => actions.submit('setTeam', { roomId: route.params.roomId, team: 'B' }, { onSuccess: actions.refresh }), { className: 'os-button os-button--quiet' }),
    ]),
  ]);
}

function renderChat({ route, view, actions, isFeatureEnabled }) {
  const messages = view.data?.messages || [];
  const list = element('ol', { className: 'os-chat-log', 'aria-label': 'Room messages' });
  for (const message of messages) {
    list.append(element('li', {}, [
      element('strong', {}, message.author || 'Unknown player'),
      element('p', {}, message.text || ''),
      message.sentAt ? element('time', { dateTime: message.sentAt }, dateText(message.sentAt)) : null,
    ]));
  }
  let composer;
  if (isFeatureEnabled?.('chat.text.enabled') !== false) {
    const body = field({ label: 'Message', name: 'chat-message', autocomplete: 'off', required: true });
    composer = element('form', { className: 'os-form os-form--inline' }, [body.wrapper, submitButton('Send')]);
    composer.addEventListener('submit', (event) => {
      event.preventDefault();
      actions.submit('sendChat', { roomId: route.params.roomId, text: body.input.value }, {
        secretInputs: [body.input],
        onSuccess: actions.refresh,
      });
    });
  } else {
    composer = element('p', { className: 'os-notice', role: 'status' }, 'Text chat is unavailable. Existing room history remains visible.');
  }
  return element('section', {}, [roomNavigation(route.params.roomId), list, composer]);
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
  return element('section', {}, [
    element('p', { role: 'status' }, data.stage || 'Waiting for an authoritative match handoff.'),
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
        data.roomId ? `/room/${encodeURIComponent(data.roomId)}` : isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? '/welcome' : '/play/rooms',
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
        isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? '/welcome' : '/play/rooms',
        { className: 'os-button os-button--quiet' },
      ) : null,
    ]),
  ]);
}

function renderResults({ view, isFeatureEnabled }) {
  const result = view.data?.result || view.data || {};
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
          isFeatureEnabled?.('shell.serverbrowser.enabled') === false ? '/welcome' : '/play/rooms',
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
    case 'room.loadout': content = element('section', {}, [roomNavigation(route.params.roomId), renderSettingsHook({ ...context, loadout: true })]); break;
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
