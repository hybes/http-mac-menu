const params = new URLSearchParams(window.location.search);
const requestedPresetId = params.get('preset');
const { errorText, isFiniteNumberText, isValidJavaScriptRegex } =
  window.httpWidgetsUi;

// 'new' until the request has been saved and given an id of its own.
let requestId = params.get('id') || 'new';
let isNewRequest = requestId === 'new';
let slotName = 'Request';

const form = document.getElementById('configForm');
const fields = Array.from(form.querySelectorAll('[data-key]'));
const typeInputs = Array.from(form.querySelectorAll('input[name="type"]'));
const typedSections = Array.from(form.querySelectorAll('[data-type]'));
// The crypto layout shows its own "Decimals" box; it mirrors the shared field.
const mirrors = Array.from(form.querySelectorAll('[data-mirror]'));

const heading = document.getElementById('heading');
const statusLine = document.getElementById('status');
const saveButton = document.getElementById('saveConfig');
const testButton = document.getElementById('testConfig');
const removeButton = document.getElementById('removeConfig');
const closeButton = document.getElementById('closeConfig');

const labelField = fields.find((el) => el.dataset.key === 'label');
const urlField = fields.find((el) => el.dataset.key === 'url');
const headersField = fields.find((el) => el.dataset.key === 'headers');
const providerField = fields.find((el) => el.dataset.key === 'provider');
const coinField = fields.find((el) => el.dataset.key === 'coin');
const holdingsField = fields.find((el) => el.dataset.key === 'holdings');
const currencyField = fields.find((el) => el.dataset.key === 'currency');
const templateField = fields.find((el) => el.dataset.key === 'template');
const timerField = fields.find((el) => el.dataset.key === 'timer');
const providerHint = document.getElementById('providerHint');
const cryptoTimerHint = document.getElementById('timerHintCrypto');

const presetChooser = document.getElementById('presetChooser');
const presetHeading = document.getElementById('presetHeading');
const presetCards = document.getElementById('presetCards');
const presetSelect = document.getElementById('presetSelect');
const presetHint = document.getElementById('presetHint');
const showPresetChooserButton = document.getElementById('showPresetChooser');
const hidePresetChooserButton = document.getElementById('hidePresetChooser');
const presetConfirm = document.getElementById('presetConfirm');
const presetConfirmMessage = document.getElementById('presetConfirmMessage');
const confirmPresetReplaceButton = document.getElementById(
  'confirmPresetReplace'
);
const cancelPresetReplaceButton = document.getElementById(
  'cancelPresetReplace'
);
const presetUndo = document.getElementById('presetUndo');
const presetUndoMessage = document.getElementById('presetUndoMessage');
const undoPresetReplaceButton = document.getElementById('undoPresetReplace');

const alertList = document.getElementById('alertList');
const alertHint = document.getElementById('alertHint');
const alertNotificationControls = document.getElementById(
  'alertNotificationControls'
);
const addAlertButton = document.getElementById('addAlert');
const curlImportButton = document.getElementById('importCurl');
const curlInput = document.getElementById('curlInput');
const curlWarnings = document.getElementById('curlWarnings');
const configLoadState = document.getElementById('configLoadState');
const configLoadMessage = document.getElementById('configLoadMessage');
const retryConfigLoadButton = document.getElementById('retryConfigLoad');
const cancelConfigLoadButton = document.getElementById('cancelConfigLoad');

const errorForField = new Map([
  [urlField, document.getElementById('urlError')],
  [headersField, document.getElementById('headersError')],
  [coinField, document.getElementById('coinError')],
  [holdingsField, document.getElementById('holdingsError')],
  [currencyField, document.getElementById('currencyError')],
  [timerField, document.getElementById('timerError')],
]);

// Matches the provider-aware limits in src-tauri/src/engine/constants.rs.
const DEFAULT_TIMER = {
  http: '5',
  jupiter: '5',
  dexscreener: '30',
  coingecko: '60',
};

const alertKinds = () => [
  [
    'above',
    currentType() === 'crypto' ? 'Price goes above' : 'Value goes above',
  ],
  [
    'below',
    currentType() === 'crypto' ? 'Price goes below' : 'Value goes below',
  ],
  ['pct_up', 'Gains ≥ % (up to 24h)'],
  ['pct_down', 'Drops ≥ % (up to 24h)'],
  ['contains', 'Text contains'],
  ['regex', 'Matches regex'],
];
const NUMERIC_ALERT_KINDS = new Set(['above', 'below', 'pct_up', 'pct_down']);
const COOLDOWN_OPTIONS = [
  [300, '5 min'],
  [900, '15 min'],
  [3600, '1 hr'],
  [86400, '24 hr'],
];

// Alert rules live here between loads and saves; rows read and write them.
let alerts = [];
let presets = [];
let pendingPreset = null;
let presetConfirmationTrigger = null;
let selectedPresetId = null;
let replacementUndoSnapshot = null;

const currentType = () =>
  (typeInputs.find((input) => input.checked) || {}).value || 'http';

const currentProvider = () => providerField?.value || 'auto';

const looksLikeSolanaMint = (value) =>
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());

const canJupiterConvertCurrency = (value) =>
  /^[a-z]{3}$/i.test(value.trim() || 'gbp');

const automaticUsesJupiter = () => {
  const coin = coinField?.value.trim().toLowerCase() || '';
  return (
    canJupiterConvertCurrency(currencyField?.value || '') &&
    (['sol', 'solana', 'wsol', 'jup', 'jupiter', 'usdc'].includes(coin) ||
      looksLikeSolanaMint(coin))
  );
};

// Mirrors engine::crypto_route::refresh_policy_provider. This is schedule
// policy, not a claim that a temporary provider fallback can never occur.
const refreshPolicyProvider = () => {
  const provider = currentProvider();
  if (provider !== 'auto') return provider;
  return automaticUsesJupiter() ? 'jupiter' : 'coingecko';
};

const timerMinimum = () =>
  currentType() === 'crypto' &&
  (refreshPolicyProvider() === 'coingecko' ||
    refreshPolicyProvider() === 'dexscreener')
    ? 30
    : 5;

const timerDefault = () =>
  currentType() === 'crypto'
    ? DEFAULT_TIMER[refreshPolicyProvider()] || DEFAULT_TIMER.coingecko
    : DEFAULT_TIMER.http;

const fieldByKey = (key) => fields.find((el) => el.dataset.key === key);

// Replaced below once the click-first controls have been initialised. Keeping
// a no-op here lets the first type paint happen before DOMContentLoaded.
let updateChoiceChipStates = () => {};

const updateProviderUi = () => {
  const provider = currentProvider();
  const refreshProvider = refreshPolicyProvider();
  const descriptions = {
    auto: 'Jupiter for SOL and Solana mints, with fiat conversion.',
    jupiter: 'Live Solana prices, converted to your chosen currency.',
    dexscreener: 'Highest-liquidity Solana pool price in USD.',
    coingecko: 'Broad coin and currency support with slower public limits.',
  };
  if (providerHint)
    providerHint.textContent = descriptions[provider] || descriptions.auto;
  if (timerField) timerField.placeholder = timerDefault();
  if (cryptoTimerHint) {
    cryptoTimerHint.textContent =
      refreshProvider === 'coingecko'
        ? provider === 'auto'
          ? 'Automatic uses CoinGecko here; minimum 30 seconds.'
          : 'CoinGecko minimum 30 seconds.'
        : refreshProvider === 'dexscreener'
          ? 'DEX Screener pool data is cached for about 30 seconds.'
          : 'Live Solana prices support 5 seconds; exchange rates are cached.';
  }
  for (const chip of document.querySelectorAll('[data-refresh-seconds]')) {
    chip.hidden =
      currentType() === 'crypto' &&
      (refreshProvider === 'coingecko' || refreshProvider === 'dexscreener') &&
      Number(chip.dataset.refreshSeconds) < 30;
  }
};

const setType = (type) => {
  for (const input of typeInputs) {
    input.checked = input.value === type;
    // WebKit does not reliably restyle the sibling after a scripted change.
    const segment = input.closest('.segment');
    if (segment) segment.classList.toggle('is-on', input.checked);
  }
  for (const section of typedSections) {
    section.hidden = section.dataset.type !== type;
  }
  updateProviderUi();
  updateChoiceChipStates();
};

// Hide the sections for the other type straight away, before settings load.
setType(currentType());

const collect = () => ({
  ...Object.fromEntries(fields.map((el) => [el.dataset.key, el.value])),
  type: currentType(),
  // A deep copy: the saved snapshot must not alias live alert rows.
  alerts: alerts.map((rule) => ({ ...rule })),
});

// ---------------------------------------------------------------------------
// Native window chrome
// ---------------------------------------------------------------------------

let fitQueued = false;
const fit = () => {
  if (fitQueued) return;
  fitQueued = true;
  setTimeout(async () => {
    fitQueued = false;
    try {
      await window.api.fitWindow(document.body.scrollHeight);
    } catch {
      /* the window is closing */
    }
  }, 0);
};

new ResizeObserver(fit).observe(document.body);

// ---------------------------------------------------------------------------
// Status and dirty state
// ---------------------------------------------------------------------------

let savedSnapshot = JSON.stringify(collect());
let testMessage = null; // { kind, text }
let actionInProgress = false;

const isDirty = () => JSON.stringify(collect()) !== savedSnapshot;

let dirtyNotified = false;
const syncDirtyFlag = () => {
  const dirty = isDirty();
  if (dirty === dirtyNotified) return;
  dirtyNotified = dirty;
  window.api.setDirty(dirty).catch(() => {});
};

const renderStatus = () => {
  const message =
    testMessage ||
    (isDirty() ? { kind: 'dirty', text: 'Unsaved changes' } : null);
  statusLine.textContent = message ? message.text : '';
  statusLine.className = message ? `status status-${message.kind}` : 'status';
  syncDirtyFlag();
  fit();
};

const setTestMessage = (kind, text) => {
  testMessage = kind ? { kind, text } : null;
  renderStatus();
};

const markSaved = (snapshot = JSON.stringify(collect())) => {
  savedSnapshot = snapshot;
  dirtyNotified = false;
  renderStatus();
  window.api.setDirty(false).catch(() => {});
};

const updateTitle = () => {
  const name = (labelField ? labelField.value.trim() : '') || slotName;
  document.title = `${name} – HTTP Widgets`;
};

const setBusy = (busy) => {
  actionInProgress = busy;
  form.inert = busy;
  form.setAttribute('aria-busy', String(busy));
  for (const control of form.querySelectorAll(
    'button, input, select, textarea'
  )) {
    if (busy) {
      control.dataset.disabledBeforeAction = String(control.disabled);
      control.disabled = true;
    } else if (control.dataset.disabledBeforeAction !== undefined) {
      control.disabled = control.dataset.disabledBeforeAction === 'true';
      delete control.dataset.disabledBeforeAction;
    }
  }
};

const showConfigLoadState = (
  message,
  { error = false, retry = false } = {}
) => {
  form.inert = true;
  form.setAttribute('aria-busy', 'true');
  configLoadMessage.textContent = message;
  configLoadMessage.className = error ? 'status status-error' : 'status';
  retryConfigLoadButton.hidden = !retry;
  configLoadState.hidden = false;
};

const finishConfigLoad = () => {
  configLoadState.hidden = true;
  form.inert = false;
  form.setAttribute('aria-busy', 'false');
};

const clearReplacementUndo = () => {
  replacementUndoSnapshot = null;
  presetUndo.hidden = true;
};

const manualEdit = () => {
  presetHint.hidden = true;
  clearReplacementUndo();
  setTestMessage(null);
};

// ---------------------------------------------------------------------------
// Local validation
// ---------------------------------------------------------------------------

const setFieldError = (field, message) => {
  const error = errorForField.get(field);
  if (!field || !error) return !message;
  if (message) {
    error.textContent = message;
    error.hidden = false;
    field.setAttribute('aria-invalid', 'true');
  } else {
    error.hidden = true;
    field.removeAttribute('aria-invalid');
  }
  fit();
  return !message;
};

const validateUrl = () => {
  if (currentType() !== 'http') return setFieldError(urlField, '');
  const value = urlField.value.trim();
  if (!value) return setFieldError(urlField, 'Enter an HTTP or HTTPS URL.');
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return setFieldError(urlField, 'Use an HTTP or HTTPS URL.');
    }
  } catch {
    return setFieldError(urlField, 'Enter a complete URL, including http://.');
  }
  return setFieldError(urlField, '');
};

const validateHeaders = () => {
  if (currentType() !== 'http') return setFieldError(headersField, '');
  const lines = headersField.value.split(/\r?\n/);
  const invalidIndex = lines.findIndex(
    (line) => line.trim() && !/^[^:\s][^:]*:.*$/.test(line)
  );
  return setFieldError(
    headersField,
    invalidIndex === -1
      ? ''
      : `Header line ${invalidIndex + 1} needs Name: value.`
  );
};

const validateCoin = () => {
  if (currentType() !== 'crypto') return setFieldError(coinField, '');
  return setFieldError(
    coinField,
    coinField.value.trim() ? '' : 'Enter a ticker, coin ID or Solana mint.'
  );
};

const validateHoldings = () => {
  if (currentType() !== 'crypto') return setFieldError(holdingsField, '');
  const value = holdingsField.value.trim();
  return setFieldError(
    holdingsField,
    !value || isFiniteNumberText(value)
      ? ''
      : 'Enter holdings as a number, without separators.'
  );
};

const validateCurrency = () => {
  if (currentType() !== 'crypto') return setFieldError(currencyField, '');
  const provider = currentProvider();
  const currency = currencyField.value.trim().toLowerCase() || 'gbp';
  let message = '';
  if (provider === 'dexscreener' && currency !== 'usd') {
    message = 'DEX Screener quotes USD only.';
  } else if (provider === 'jupiter' && !canJupiterConvertCurrency(currency)) {
    message = 'Use a three-letter currency code such as GBP or EUR.';
  }
  return setFieldError(currencyField, message);
};

const validateTimer = () => {
  const value = timerField.value.trim();
  if (!value) return setFieldError(timerField, '');
  if (!/^\d+$/.test(value)) {
    return setFieldError(timerField, 'Enter a whole number of seconds.');
  }
  const minimum = timerMinimum();
  if (Number(value) < minimum) {
    return setFieldError(timerField, `Use at least ${minimum} seconds.`);
  }
  return setFieldError(timerField, '');
};

const clearValidation = () => {
  for (const field of errorForField.keys()) setFieldError(field, '');
  for (const input of alertList.querySelectorAll('[aria-invalid="true"]')) {
    input.removeAttribute('aria-invalid');
  }
  for (const error of alertList.querySelectorAll('.alert-rule-error')) {
    error.hidden = true;
  }
};

const validateAlertRule = (index) => {
  const rule = alerts[index];
  const item = alertList.querySelector(`[data-alert-index="${index}"]`);
  const valueInput = item?.querySelector('.alert-value');
  const error = item?.querySelector('.alert-rule-error');
  if (!rule || !valueInput || !error) return true;

  let message = '';
  if (!String(rule.value).trim()) {
    message = NUMERIC_ALERT_KINDS.has(rule.kind)
      ? 'Enter a threshold.'
      : 'Enter text to match.';
  } else if (
    NUMERIC_ALERT_KINDS.has(rule.kind) &&
    !isFiniteNumberText(rule.value)
  ) {
    message = 'Enter a numeric threshold.';
  } else if (rule.kind === 'regex' && !isValidJavaScriptRegex(rule.value)) {
    message = 'Enter a valid regular expression.';
  }

  error.textContent = message;
  error.hidden = !message;
  if (message) valueInput.setAttribute('aria-invalid', 'true');
  else valueInput.removeAttribute('aria-invalid');
  return !message;
};

const validateAll = () => {
  const results = [
    validateUrl(),
    validateHeaders(),
    validateCoin(),
    validateHoldings(),
    validateCurrency(),
    validateTimer(),
  ];
  alerts.forEach((_, index) => results.push(validateAlertRule(index)));
  if (results.every(Boolean)) return true;

  const firstInvalid = form.querySelector('[aria-invalid="true"]');
  const disclosure = firstInvalid?.closest('details');
  if (disclosure) disclosure.open = true;
  firstInvalid?.focus();
  setTestMessage('error', 'Check the highlighted fields.');
  return false;
};

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const newAlertId = () =>
  `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const alertEdited = () => manualEdit();

const tuneValueInput = (valueInput, kind) => {
  if (NUMERIC_ALERT_KINDS.has(kind)) {
    valueInput.setAttribute('inputmode', 'decimal');
    valueInput.placeholder = 'Threshold';
  } else {
    valueInput.removeAttribute('inputmode');
    valueInput.placeholder = kind === 'regex' ? 'Pattern' : 'Text';
  }
};

const updateCooldownChips = (container, seconds) => {
  for (const chip of container.querySelectorAll('[data-cooldown-seconds]')) {
    chip.setAttribute(
      'aria-pressed',
      String(Number(chip.dataset.cooldownSeconds) === seconds)
    );
  }
};

const renderAlerts = () => {
  alertList.replaceChildren();
  alertHint.hidden = alerts.length > 0;
  alertNotificationControls.hidden = alerts.length === 0;

  alerts.forEach((rule, index) => {
    const item = document.createElement('div');
    item.className = 'alert-rule';
    item.dataset.alertIndex = String(index);

    const mainRow = document.createElement('div');
    mainRow.className = 'alert-rule-main';

    const kindSelect = document.createElement('select');
    kindSelect.className = 'input alert-kind';
    kindSelect.setAttribute('aria-label', `Alert ${index + 1} condition`);
    for (const [value, text] of alertKinds()) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      kindSelect.appendChild(option);
    }
    kindSelect.value = rule.kind;

    const valueInput = document.createElement('input');
    const valueErrorId = `alertValueError${index}`;
    valueInput.className = 'input alert-value';
    valueInput.setAttribute('aria-label', `Alert ${index + 1} threshold`);
    valueInput.setAttribute('aria-describedby', valueErrorId);
    valueInput.value = rule.value;
    tuneValueInput(valueInput, rule.kind);

    kindSelect.addEventListener('change', () => {
      rule.kind = kindSelect.value;
      tuneValueInput(valueInput, rule.kind);
      if (valueInput.getAttribute('aria-invalid') === 'true') {
        validateAlertRule(index);
      }
      alertEdited();
    });

    valueInput.addEventListener('input', () => {
      rule.value = valueInput.value;
      if (valueInput.getAttribute('aria-invalid') === 'true') {
        validateAlertRule(index);
      }
      alertEdited();
    });

    const removeAlertButton = document.createElement('button');
    removeAlertButton.type = 'button';
    removeAlertButton.className = 'btn alert-remove';
    removeAlertButton.textContent = 'Remove';
    removeAlertButton.setAttribute('aria-label', `Remove alert ${index + 1}`);
    removeAlertButton.addEventListener('click', () => {
      alerts.splice(index, 1);
      renderAlerts();
      fit();
      alertEdited();
    });

    mainRow.append(kindSelect, valueInput, removeAlertButton);

    const valueError = document.createElement('span');
    valueError.className = 'field-error alert-rule-error';
    valueError.id = valueErrorId;
    valueError.setAttribute('role', 'alert');
    valueError.hidden = true;

    const cooldownRow = document.createElement('div');
    cooldownRow.className = 'alert-cooldown';

    const cooldownInputId = `alertCooldown${index}`;
    const cooldownLabel = document.createElement('label');
    cooldownLabel.className = 'hint alert-cooldown-label';
    cooldownLabel.htmlFor = cooldownInputId;
    cooldownLabel.textContent = 'Cooldown';

    const cooldownInput = document.createElement('input');
    cooldownInput.className = 'input alert-cooldown-input';
    cooldownInput.id = cooldownInputId;
    cooldownInput.type = 'number';
    cooldownInput.min = '0';
    cooldownInput.step = '1';
    cooldownInput.setAttribute('aria-label', 'Cooldown in minutes');
    cooldownInput.value = String(Math.round(rule.cooldown_secs / 60));

    const cooldownChips = document.createElement('div');
    cooldownChips.className = 'choice-chips alert-cooldown-chips';
    cooldownChips.setAttribute('aria-label', 'Common alert cooldowns');
    for (const [seconds, label] of COOLDOWN_OPTIONS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'choice-chip';
      chip.dataset.cooldownSeconds = String(seconds);
      chip.textContent = label;
      chip.addEventListener('click', () => {
        rule.cooldown_secs = seconds;
        cooldownInput.value = String(seconds / 60);
        updateCooldownChips(cooldownChips, seconds);
        alertEdited();
      });
      cooldownChips.appendChild(chip);
    }
    updateCooldownChips(cooldownChips, Number(rule.cooldown_secs));

    cooldownInput.addEventListener('input', () => {
      const minutes = Number(cooldownInput.value);
      rule.cooldown_secs =
        Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 0;
      updateCooldownChips(cooldownChips, rule.cooldown_secs);
      alertEdited();
    });

    cooldownRow.append(cooldownLabel, cooldownInput, cooldownChips);
    item.append(mainRow, valueError, cooldownRow);
    alertList.appendChild(item);
  });
};

addAlertButton.addEventListener('click', () => {
  alerts.push({
    id: newAlertId(),
    kind: 'above',
    value: '',
    cooldown_secs: 300,
  });
  renderAlerts();
  fit();
  alertEdited();
  alertList.lastElementChild?.querySelector('.alert-value')?.focus();
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const slugifyPreset = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const normalisePreset = (preset, index) => ({
  ...preset,
  id: String(preset.id || slugifyPreset(preset.label) || `preset-${index + 1}`),
  kind: preset.kind === 'crypto' ? 'crypto' : 'http',
  values: preset.values || {},
});

const presetDescription = (preset) =>
  String(
    preset.description ||
      (preset.kind === 'crypto'
        ? 'Track a coin with a ready-made display.'
        : 'Start with a working HTTP request.')
  );

const updatePresetSelection = () => {
  for (const card of presetCards.querySelectorAll('[data-preset-id]')) {
    card.setAttribute(
      'aria-pressed',
      String(card.dataset.presetId === selectedPresetId)
    );
  }
};

const closePresetConfirmation = ({ restoreFocus = true } = {}) => {
  const trigger = presetConfirmationTrigger;
  pendingPreset = null;
  presetConfirmationTrigger = null;
  presetConfirm.hidden = true;
  if (restoreFocus && trigger?.isConnected && !trigger.closest('[hidden]')) {
    trigger.focus({ preventScroll: true });
  }
};

const openPresetChooser = ({ focus = true } = {}) => {
  presetChooser.hidden = false;
  presetHeading.textContent = isNewRequest
    ? 'Start with a preset'
    : 'Replace source';
  hidePresetChooserButton.hidden = isNewRequest;
  fit();
  if (focus) {
    setTimeout(() => presetCards.querySelector('.preset-card')?.focus(), 0);
  }
};

const hidePresetChooser = () => {
  closePresetConfirmation({ restoreFocus: false });
  if (!isNewRequest) presetChooser.hidden = true;
  showPresetChooserButton.focus();
  fit();
};

const snapshotToEditor = (snapshot) => {
  for (const el of fields) el.value = snapshot[el.dataset.key] ?? '';
  for (const el of mirrors) el.value = snapshot[el.dataset.mirror] ?? '';
  alerts = Array.isArray(snapshot.alerts)
    ? snapshot.alerts.map((rule) => ({ ...rule }))
    : [];
  setType(snapshot.type === 'crypto' ? 'crypto' : 'http');
  renderAlerts();
  clearValidation();
  updateChoiceChipStates();
  updateTitle();
};

const applyPreset = (
  preset,
  { preserveName = false, allowUndo = false } = {}
) => {
  if (allowUndo) replacementUndoSnapshot = collect();
  else clearReplacementUndo();

  const nameBefore = labelField ? labelField.value : '';
  const values = preset.values || {};

  // Replacing a source never carries credentials or alert state to another
  // endpoint. Existing display names survive; new presets may supply a name.
  for (const el of fields) el.value = '';
  if (preserveName && labelField) labelField.value = nameBefore;
  for (const el of mirrors) el.value = '';
  alerts = [];

  setType(preset.kind === 'crypto' ? 'crypto' : 'http');
  for (const el of fields) {
    if (preserveName && el === labelField) continue;
    if (values[el.dataset.key] !== undefined) {
      el.value = String(values[el.dataset.key]);
    }
  }
  for (const el of mirrors) {
    if (values[el.dataset.mirror] !== undefined) {
      el.value = String(values[el.dataset.mirror]);
    }
  }

  updateProviderUi();
  selectedPresetId = preset.id;
  closePresetConfirmation({ restoreFocus: false });
  renderAlerts();
  clearValidation();
  updateChoiceChipStates();
  updatePresetSelection();
  updateTitle();
  setTestMessage(null);

  presetHint.textContent = `${preset.label} loaded. Save to keep it.`;
  presetHint.hidden = false;

  if (allowUndo) {
    presetUndoMessage.textContent = `${preset.label} replaced the source.`;
    presetUndo.hidden = false;
    presetChooser.hidden = true;
    undoPresetReplaceButton.focus({ preventScroll: true });
  }
  fit();
};

const beginPresetConfirmation = (preset, trigger = null) => {
  pendingPreset = preset;
  presetConfirmationTrigger =
    trigger ||
    Array.from(presetCards.querySelectorAll('[data-preset-id]')).find(
      (card) => card.dataset.presetId === preset.id
    ) ||
    null;
  presetConfirmMessage.textContent = `${preset.label} replaces the source, display, and schedule. Headers and alerts are cleared. Your request name stays.`;
  presetConfirm.hidden = false;
  presetHint.hidden = true;
  fit();
  confirmPresetReplaceButton.focus();
};

const choosePreset = (preset, trigger = null) => {
  if (isNewRequest) {
    applyPreset(preset);
    return;
  }
  beginPresetConfirmation(preset, trigger);
};

const renderPresetCards = () => {
  presetCards.replaceChildren();
  if (!presets.length) {
    const empty = document.createElement('p');
    empty.className = 'preset-empty';
    empty.textContent = 'Presets are unavailable.';
    presetCards.appendChild(empty);
    return;
  }

  for (const preset of presets) {
    const item = document.createElement('div');
    item.className = 'preset-grid-item';
    item.setAttribute('role', 'listitem');

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'preset-card';
    card.dataset.presetId = preset.id;
    card.setAttribute('aria-pressed', 'false');

    const kind = document.createElement('span');
    kind.className = 'preset-card-kind';
    kind.textContent = preset.kind === 'crypto' ? 'Crypto' : 'HTTP';

    const label = document.createElement('strong');
    label.className = 'preset-card-title';
    label.textContent = preset.label;

    const description = document.createElement('span');
    description.className = 'preset-card-description';
    description.textContent = presetDescription(preset);

    card.append(kind, label, description);
    card.addEventListener('click', () => choosePreset(preset, card));
    item.appendChild(card);
    presetCards.appendChild(item);
  }
  updatePresetSelection();
};

const populatePresets = async () => {
  try {
    const response = await window.api.listPresets();
    presets = Array.isArray(response)
      ? response.map((preset, index) => normalisePreset(preset, index))
      : [];

    presetSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a preset';
    presetSelect.appendChild(placeholder);
    for (const preset of presets) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      presetSelect.appendChild(option);
    }
    renderPresetCards();
  } catch (error) {
    presets = [];
    renderPresetCards();
    console.error('Error loading presets:', error);
  }
};

const activateRequestedPreset = () => {
  if (!requestedPresetId) return;
  const preset = presets.find((item) => item.id === requestedPresetId);
  openPresetChooser({ focus: false });
  if (!preset) {
    presetHint.textContent = 'That preset is unavailable. Choose another.';
    presetHint.hidden = false;
    return;
  }
  choosePreset(preset);
};

presetSelect.addEventListener('change', () => {
  const preset = presets.find((item) => item.id === presetSelect.value);
  presetSelect.value = '';
  if (preset) choosePreset(preset);
});

showPresetChooserButton.addEventListener('click', () => openPresetChooser());
hidePresetChooserButton.addEventListener('click', hidePresetChooser);
cancelPresetReplaceButton.addEventListener('click', () =>
  closePresetConfirmation()
);

confirmPresetReplaceButton.addEventListener('click', () => {
  if (!pendingPreset) return;
  applyPreset(pendingPreset, { preserveName: true, allowUndo: true });
});

undoPresetReplaceButton.addEventListener('click', () => {
  if (!replacementUndoSnapshot) return;
  const snapshot = replacementUndoSnapshot;
  clearReplacementUndo();
  snapshotToEditor(snapshot);
  selectedPresetId = null;
  updatePresetSelection();
  presetHint.textContent = 'Source replacement undone.';
  presetHint.hidden = false;
  setTestMessage(null);
  fit();
});

// ---------------------------------------------------------------------------
// cURL import and click-first field helpers
// ---------------------------------------------------------------------------

curlImportButton.addEventListener('click', async () => {
  if (actionInProgress) return;
  try {
    const result = await window.api.importCurl(curlInput.value);
    if (result.url && urlField) urlField.value = result.url;
    // Never retain a previous endpoint's secret headers after an import.
    if (headersField) headersField.value = result.headers || '';
    curlWarnings.textContent = (result.warnings || []).join(' · ');
    curlWarnings.hidden = !curlWarnings.textContent;
    validateUrl();
    validateHeaders();
  } catch (error) {
    curlWarnings.textContent = errorText(error, 'Could not import that cURL.');
    curlWarnings.hidden = false;
  }
  fit();
  manualEdit();
});

const setFieldValue = (field, value) => {
  if (!field) return;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

updateChoiceChipStates = () => {
  for (const chip of document.querySelectorAll('[data-refresh-seconds]')) {
    chip.setAttribute(
      'aria-pressed',
      String(timerField?.value === chip.dataset.refreshSeconds)
    );
  }
  for (const chip of document.querySelectorAll('[data-currency]')) {
    chip.setAttribute(
      'aria-pressed',
      String(
        currencyField?.value.trim().toLowerCase() ===
          chip.dataset.currency.toLowerCase()
      )
    );
  }
};

for (const chip of document.querySelectorAll('[data-refresh-seconds]')) {
  chip.addEventListener('click', () =>
    setFieldValue(timerField, chip.dataset.refreshSeconds)
  );
}

for (const chip of document.querySelectorAll('[data-currency]')) {
  chip.addEventListener('click', () =>
    setFieldValue(currencyField, chip.dataset.currency)
  );
}

for (const chip of document.querySelectorAll('[data-template-variable]')) {
  chip.addEventListener('click', () => {
    if (!templateField) return;
    const token = chip.dataset.templateVariable;
    const start = templateField.selectionStart ?? templateField.value.length;
    const end = templateField.selectionEnd ?? start;
    templateField.setRangeText(token, start, end, 'end');
    templateField.dispatchEvent(new Event('input', { bubbles: true }));
    templateField.focus();
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const applySlot = (position) => {
  slotName = `Request ${position}`;
  heading.textContent = slotName;
  if (labelField) labelField.placeholder = slotName;
  for (const el of document.querySelectorAll('[data-slot-name]')) {
    el.textContent = slotName;
  }
};

const load = async () => {
  try {
    const config = await window.api.loadConfig(requestId);
    requestId = config.id;
    isNewRequest = Boolean(config.isNew);
    applySlot(config.position);
    removeButton.hidden = isNewRequest;
    showPresetChooserButton.hidden = isNewRequest;
    presetChooser.hidden = !isNewRequest;
    hidePresetChooserButton.hidden = isNewRequest;
    presetHeading.textContent = isNewRequest
      ? 'Start with a preset'
      : 'Replace source';

    const values = config.values || {};
    for (const el of fields) el.value = values[el.dataset.key] ?? '';
    for (const el of mirrors) el.value = values[el.dataset.mirror] ?? '';
    alerts = Array.isArray(values.alerts)
      ? values.alerts.map((rule) => ({
          id: String(rule.id ?? ''),
          kind: String(rule.kind ?? 'above'),
          value: String(rule.value ?? ''),
          cooldown_secs: Number(rule.cooldown_secs ?? 300),
        }))
      : [];
    setType(values.type === 'crypto' ? 'crypto' : 'http');
    renderAlerts();
    clearValidation();
    updateChoiceChipStates();
    updateTitle();
    markSaved();
    return { ok: true };
  } catch (error) {
    console.error('Error loading configuration:', error);
    const message = `Could not load settings: ${errorText(
      error,
      'The request could not be read.'
    )}`;
    setTestMessage('error', message);
    return { ok: false, message };
  }
};

let initialLoadInProgress = false;
const initialiseEditor = async () => {
  if (initialLoadInProgress) return;
  initialLoadInProgress = true;
  showConfigLoadState('Loading request…');

  const result = await load();
  if (!result.ok) {
    showConfigLoadState(result.message, { error: true, retry: true });
    initialLoadInProgress = false;
    retryConfigLoadButton.focus({ preventScroll: true });
    return;
  }

  await populatePresets();
  finishConfigLoad();
  activateRequestedPreset();
  updateChoiceChipStates();
  fit();
  initialLoadInProgress = false;
};

const save = async () => {
  if (actionInProgress || !validateAll()) return;
  const submitted = collect();
  const submittedSnapshot = JSON.stringify(submitted);
  setBusy(true);
  try {
    const response = await window.api.saveConfig(requestId, submitted);
    if (response && response.ok === false) {
      setTestMessage(
        'error',
        errorText(response.error, 'The settings could not be saved.')
      );
      return;
    }
    clearReplacementUndo();
    presetHint.hidden = true;
    markSaved(submittedSnapshot);
  } catch (error) {
    console.error('Error saving configuration:', error);
    setTestMessage(
      'error',
      `Could not save: ${errorText(error, 'The settings could not be saved.')}`
    );
  } finally {
    setBusy(false);
  }
};

const test = async () => {
  if (actionInProgress || !validateAll()) return;
  const submitted = collect();
  setBusy(true);
  setTestMessage('dirty', 'Testing…');
  try {
    const response = await window.api.testConfig(submitted);
    if (response.ok) {
      setTestMessage('ok', `Preview: ${response.value}`);
    } else {
      setTestMessage(
        'error',
        errorText(response.error, 'The request could not be tested.')
      );
    }
  } catch (error) {
    setTestMessage(
      'error',
      errorText(error, 'The request could not be tested.')
    );
  } finally {
    setBusy(false);
  }
};

const remove = async () => {
  if (actionInProgress) return;
  const name = (labelField ? labelField.value.trim() : '') || slotName;
  setBusy(true);
  try {
    // Native, not window.confirm: iOS answers that one yes without asking.
    if (!(await window.api.confirmRemove(name))) return;
    await window.api.removeConfig(requestId);
  } catch (error) {
    console.error('Error removing request:', error);
    setTestMessage(
      'error',
      `Could not remove: ${errorText(error, 'The request could not be removed.')}`
    );
  } finally {
    setBusy(false);
  }
};

// The main process reads this before closing or hiding the editor.
window.configIsDirty = isDirty;

const close = async () => {
  if (actionInProgress) return;
  try {
    await window.api.close();
  } catch (error) {
    const message = `Could not close settings: ${errorText(
      error,
      'Try again.'
    )}`;
    setTestMessage('error', message);
    if (!configLoadState.hidden) {
      configLoadMessage.textContent = message;
      configLoadMessage.className = 'status status-error';
    }
  }
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});
testButton.addEventListener('click', test);
removeButton.addEventListener('click', remove);
closeButton.addEventListener('click', close);
cancelConfigLoadButton.addEventListener('click', close);
retryConfigLoadButton.addEventListener('click', initialiseEditor);

for (const input of typeInputs) {
  input.addEventListener('change', () => {
    setType(currentType());
    renderAlerts();
    validateUrl();
    validateCoin();
    validateHoldings();
    validateCurrency();
    validateTimer();
    manualEdit();
  });
}

providerField?.addEventListener('change', () => {
  if (
    currentProvider() === 'dexscreener' &&
    currencyField?.value.trim().toLowerCase() !== 'usd'
  ) {
    setFieldValue(currencyField, 'usd');
  }
  if (timerField?.value.trim() && Number(timerField.value) < timerMinimum()) {
    setFieldValue(timerField, timerDefault());
  }
  updateProviderUi();
  validateCurrency();
  validateTimer();
  manualEdit();
});

for (const el of fields) {
  el.addEventListener('input', () => {
    if (el === coinField || el === currencyField) {
      updateProviderUi();
      validateCurrency();
      if (timerField?.value.trim()) validateTimer();
    }
    if (el.getAttribute('aria-invalid') === 'true') {
      if (el === urlField) validateUrl();
      else if (el === headersField) validateHeaders();
      else if (el === coinField) validateCoin();
      else if (el === holdingsField) validateHoldings();
      else if (el === timerField) validateTimer();
    }
    updateChoiceChipStates();
    manualEdit();
  });
}

if (labelField) labelField.addEventListener('input', updateTitle);

for (const mirror of mirrors) {
  const target = fieldByKey(mirror.dataset.mirror);
  mirror.addEventListener('input', () => {
    if (target) target.value = mirror.value;
    manualEdit();
  });
  if (target) {
    target.addEventListener('input', () => {
      mirror.value = target.value;
    });
  }
}

for (const details of document.querySelectorAll('details')) {
  details.addEventListener('toggle', fit);
}

window.addEventListener('notifications:updated', fit);

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!presetConfirm.hidden) {
      closePresetConfirmation();
      fit();
    } else if (!isNewRequest && !presetChooser.hidden) {
      hidePresetChooser();
    } else {
      close();
    }
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    save();
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  await initialiseEditor();
});

window.addEventListener('load', fit);

// The tray's left-click link is an app preference, not part of the request
// being edited: it saves itself on change and never marks the form dirty.
const trayLinkField = document.getElementById('trayLink');
const trayLinkError = document.getElementById('trayLinkError');
if (trayLinkField && trayLinkError) {
  window.api
    .getTrayLink()
    .then((link) => {
      trayLinkField.value = link ?? '';
    })
    .catch(() => {});

  trayLinkField.addEventListener('keydown', (event) => {
    // Enter must commit this field, not submit the request form around it.
    if (event.key === 'Enter') {
      event.preventDefault();
      trayLinkField.blur();
    }
  });

  trayLinkField.addEventListener('change', async () => {
    try {
      const saved = await window.api.setTrayLink(trayLinkField.value);
      trayLinkField.value = saved ?? '';
      trayLinkError.hidden = true;
      trayLinkField.removeAttribute('aria-invalid');
    } catch {
      trayLinkError.hidden = false;
      trayLinkField.setAttribute('aria-invalid', 'true');
    }
  });
}
