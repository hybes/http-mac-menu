// Building a value is a short path: where it comes from, which part you want,
// how it should read, how often it updates and when to tell you. Each step
// shows its current answer on one line and opens only when you want to change
// it. The stage above the steps is the menu bar or widget as it will look,
// formatted by the same Rust code that runs the scheduled refreshes.
(() => {
  const { h, icon, button, iconButton, busy, insertAtCaret } =
    window.httpWidgets.dom;
  const { createSurface, notificationPanel, choiceGroup } =
    window.httpWidgets.parts;
  const ui = window.httpWidgetsUi;
  const { errorText, isFiniteNumberText, isValidJavaScriptRegex, plural } = ui;

  const FIELDS = [
    'label',
    'url',
    'headers',
    'json',
    'http_template',
    'empty_text',
    'multiplier',
    'provider',
    'coin',
    'holdings',
    'currency',
    'template',
    'length',
    'prefix',
    'suffix',
    'timer',
  ];

  const STEPS = {
    http: ['source', 'value', 'display', 'refresh', 'alerts'],
    crypto: ['source', 'display', 'refresh', 'alerts'],
  };

  // Which step holds the control behind each validation error.
  const STEP_FOR_ERROR = {
    url: 'source',
    headers: 'source',
    coin: 'source',
    holdings: 'source',
    currency: 'source',
    timer: 'refresh',
    rule: 'display',
    alert: 'alerts',
  };

  // Edits to these never change what the preview reads.
  const QUIET_KEYS = new Set(['label', 'timer', 'alerts']);

  const REFRESH_CHOICES = [
    [5, '5 sec'],
    [15, '15 sec'],
    [30, '30 sec'],
    [60, '1 min'],
    [300, '5 min'],
    [900, '15 min'],
    [3600, '1 hour'],
  ];

  const COOLDOWN_CHOICES = [
    [0, 'every time'],
    [60, 'at most every minute'],
    [300, 'at most every 5 minutes'],
    [900, 'at most every 15 minutes'],
    [1800, 'at most every 30 minutes'],
    [3600, 'at most every hour'],
    [21600, 'at most every 6 hours'],
    [86400, 'at most once a day'],
  ];

  const ALERT_OPTION_LABELS = {
    above: 'goes above',
    below: 'goes below',
    pct_up: 'gains at least (% in 24h)',
    pct_down: 'drops at least (% in 24h)',
    contains: 'contains',
    regex: 'matches regex',
  };

  const COMMON_CURRENCIES = ['gbp', 'usd', 'eur', 'jpy'];
  const QUICK_COINS = ['btc', 'eth', 'sol'];

  const PROVIDER_CHOICES = [
    {
      value: 'auto',
      label: 'Automatic',
      detail:
        'Jupiter for SOL and Solana mints, CoinGecko for everything else.',
    },
    {
      value: 'jupiter',
      label: 'Jupiter',
      detail: 'Live Solana prices, converted to your currency.',
    },
    {
      value: 'dexscreener',
      label: 'DEX Screener',
      detail: 'The most liquid Solana pool. US dollars only.',
    },
    {
      value: 'coingecko',
      label: 'CoinGecko',
      detail: 'The widest coin and currency coverage, at a slower pace.',
    },
  ];

  const CRYPTO_VARIABLES = [
    '{symbol}',
    '{price}',
    '{balance}',
    '{change24h}',
    '{gain24h}',
    '{source}',
  ];

  const blankDraft = () => ({
    type: 'http',
    ...Object.fromEntries(FIELDS.map((key) => [key, ''])),
    provider: 'auto',
    alerts: [],
    display_rules: [],
  });

  const draftFrom = (values = {}) => {
    const draft = blankDraft();
    draft.type = values.type === 'crypto' ? 'crypto' : 'http';
    for (const key of FIELDS) {
      if (values[key] !== undefined && values[key] !== null) {
        draft[key] = String(values[key]);
      }
    }
    draft.provider = ui.cryptoProvider(draft);
    draft.alerts = Array.isArray(values.alerts)
      ? values.alerts.map((rule) => ({
          id: String(rule.id ?? ''),
          kind: String(rule.kind ?? 'above'),
          value: String(rule.value ?? ''),
          cooldown_secs: Number(rule.cooldown_secs ?? 300),
        }))
      : [];
    draft.display_rules = Array.isArray(values.display_rules)
      ? values.display_rules.map((rule) => ({
          path: String(rule.path ?? ''),
          kind: String(rule.kind ?? 'empty'),
          value: String(rule.value ?? ''),
          template: String(rule.template ?? ''),
        }))
      : [];
    return draft;
  };

  const urlProblem = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return 'Enter an HTTP or HTTPS address.';
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'Use an HTTP or HTTPS address.';
      }
    } catch {
      return 'Enter a complete address, including https://.';
    }
    return '';
  };

  const newAlertId = () =>
    `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const labelled = (text, control, ...rest) =>
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field-label', htmlFor: control.id, text }),
      control,
      ...rest
    );

  const builder = ({ root, route, app }) => {
    const { store } = app;

    let requestId = route.id;
    let isNew = route.id === 'new';
    let slotName = 'Value';
    let draft = blankDraft();
    let savedSnapshot = JSON.stringify(draft);
    let openStep = null;
    let disposed = false;
    let saving = false;
    let dirtyNotified = false;
    let notes = [];

    // The preview: the last response for HTTP, and what the formatter made.
    let response = null;
    let responseSource = '';
    let fields = [];
    let preview = { state: 'idle', text: null, message: '' };
    let previewTimer = null;
    // Network fetches and re-reads of the cached response are numbered
    // separately, so a late answer to either can be recognised and dropped.
    let fetchToken = 0;
    let formatToken = 0;
    let inFlight = null;
    let formatAgain = false;

    // Choices that are a mode of the form rather than a stored value.
    let displayCustom = false;
    let cryptoCustom = false;
    let timerCustom = false;
    let fieldFilter = '';
    let activeTemplate = null;

    const errors = new Map();
    const inputs = new Map();
    const errorNodes = new Map();
    const stepNodes = new Map();
    let syncers = [];
    let renderFieldPicker = () => {};
    let revealChosenField = () => {};
    let renderRules = () => {};
    let renderAlerts = () => {};

    const collect = () => JSON.parse(JSON.stringify(draft));
    const isDirty = () => JSON.stringify(draft) !== savedSnapshot;
    const displayName = () => draft.label.trim() || slotName;

    // ------------------------------------------------------------------
    // Chrome
    // ------------------------------------------------------------------

    const leave = () =>
      app.go(isNew ? app.routes.add() : app.routes.value(requestId));

    const saveButton = button('Save', { class: 'btn btn-primary' });
    const bar = app.setBar({
      back: { label: 'Cancel', action: leave },
      title: isNew ? 'New value' : 'Edit value',
      actions: [saveButton],
    });

    const nameInput = h('input', {
      class: 'input name-input',
      id: 'valueName',
      type: 'text',
      'aria-label': 'Name',
      'aria-describedby': 'valueNameHint',
    });
    nameInput.addEventListener('input', () => {
      draft.label = nameInput.value;
      edited('label');
    });
    const nameBlock = h(
      'div',
      { class: 'builder-name' },
      nameInput,
      h('p', {
        class: 'hint',
        id: 'valueNameHint',
        text:
          store.info.platform === 'macos'
            ? 'A name for the menu and this app. The menu bar shows only the value.'
            : store.info.mobile
              ? 'A name for your widgets and this app.'
              : 'A name for the tray menu and this app.',
      })
    );

    const surface = createSurface(store.info.platform);
    const fetchAgain = iconButton('refresh', 'Fetch again', {
      class: 'btn icon-button surface-tool',
    });
    surface.tools.append(fetchAgain);
    const stageStatus = h('p', {
      class: 'stage-status',
      role: 'status',
      'aria-live': 'polite',
    });
    const stage = h(
      'section',
      { class: 'stage', 'aria-label': 'Preview' },
      surface.element,
      stageStatus
    );

    const saveError = h('p', {
      class: 'notice notice-error',
      role: 'alert',
      hidden: true,
    });
    const stepsList = h('ol', { class: 'steps' });

    const removeButton = button('Remove this value', {
      class: 'btn btn-danger',
      hidden: true,
    });
    const footer = h(
      'div',
      { class: 'builder-footer' },
      removeButton,
      h('p', {
        class: 'footnote desktop-only',
        text: 'Esc closes · ⌘↩ saves',
      })
    );

    const page = h(
      'div',
      { class: 'builder', hidden: true },
      nameBlock,
      stage,
      saveError,
      stepsList,
      footer
    );

    const loadMessage = h('p', {
      class: 'status',
      role: 'status',
      'aria-live': 'polite',
      text: 'Loading…',
    });
    const retryButton = button('Retry', {
      class: 'btn btn-primary',
      hidden: true,
    });
    const loadState = h(
      'section',
      { class: 'load-state' },
      loadMessage,
      h(
        'div',
        { class: 'action-row' },
        button('Back', { on: { click: leave } }),
        retryButton
      )
    );
    root.append(loadState, page);

    // ------------------------------------------------------------------
    // Fields, errors and edits
    // ------------------------------------------------------------------

    const field = (key, props = {}, tag = 'input') => {
      const control = h(tag, {
        class: 'input',
        id: `field-${key}`,
        type: tag === 'input' ? 'text' : undefined,
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: false,
        ...props,
      });
      control.value = draft[key] ?? '';
      control.addEventListener('input', () => {
        draft[key] = control.value;
        edited(key);
      });
      inputs.set(key, control);
      return control;
    };

    // The message under a field. Created after the field it belongs to.
    const errorFor = (key) => {
      const node = h('span', {
        class: 'field-error',
        id: `error-${key}`,
        role: 'alert',
        hidden: true,
      });
      errorNodes.set(key, node);
      const control = inputs.get(key);
      if (control) {
        const described = control.getAttribute('aria-describedby') || '';
        control.setAttribute(
          'aria-describedby',
          `${node.id} ${described}`.trim()
        );
      }
      return node;
    };

    const paintError = (key) => {
      const message = errors.get(key) || '';
      const node = errorNodes.get(key);
      const control = inputs.get(key);
      if (node) {
        node.textContent = message;
        node.hidden = !message;
      }
      if (control) {
        if (message) control.setAttribute('aria-invalid', 'true');
        else control.removeAttribute('aria-invalid');
      }
    };

    const setError = (key, message) => {
      if (message) errors.set(key, message);
      else errors.delete(key);
      paintError(key);
      return !message;
    };

    // Change a field from code without treating it as an edit of its own.
    const assignValue = (key, value) => {
      draft[key] = value;
      const control = inputs.get(key);
      if (control && control.value !== value) control.value = value;
    };

    const setValue = (key, value) => {
      assignValue(key, value);
      edited(key);
    };

    const sync = () => {
      for (const run of syncers) run();
      renderStage();
      renderStepStates();
      const dirty = isDirty();
      bar.setMeta(dirty ? 'Unsaved changes' : '');
      if (dirty !== dirtyNotified) {
        dirtyNotified = dirty;
        window.api.setDirty(dirty).catch(() => {});
      }
    };

    const edited = (key) => {
      if (errors.has(key)) setError(key, '');
      saveError.hidden = true;
      if (key === 'coin' || key === 'currency' || key === 'provider') {
        validateCurrency();
        if (draft.timer.trim()) validateTimer();
      }
      if (
        draft.type === 'http' &&
        response !== null &&
        responseSource !== httpSource()
      ) {
        forgetResponse();
      }
      sync();
      if (!QUIET_KEYS.has(key)) schedulePreview();
    };

    // ------------------------------------------------------------------
    // Preview
    // ------------------------------------------------------------------

    const httpSource = () => JSON.stringify([draft.url, draft.headers]);

    const canFetch = () =>
      draft.type === 'crypto'
        ? Boolean(draft.coin.trim())
        : !urlProblem(draft.url);

    const setPreview = (next) => {
      preview = { text: null, message: '', ...next };
      sync();
    };

    const forgetResponse = () => {
      response = null;
      responseSource = '';
      fields = [];
      formatToken++;
      renderFieldPicker();
    };

    const rememberResponse = (text) => {
      response = text;
      responseSource = httpSource();
      try {
        fields = ui.responseFields(JSON.parse(text));
      } catch {
        fields = [];
      }
      renderFieldPicker();
    };

    const applyResult = (result) => {
      setPreview(
        result.ok
          ? { state: 'ok', text: String(result.value ?? '') }
          : {
              state: 'error',
              message: errorText(
                result.error,
                'The preview could not be made.'
              ),
            }
      );
    };

    // Goes to the network. Everything else re-reads the response it brought.
    const fetchPreview = async () => {
      window.clearTimeout(previewTimer);
      formatToken++;
      const token = ++fetchToken;
      inFlight = null;
      if (!canFetch()) {
        setPreview({ state: 'idle' });
        return false;
      }
      const http = draft.type === 'http';
      inFlight = { source: http ? httpSource() : null };
      formatAgain = false;
      setPreview({ state: 'loading', text: preview.text });

      let result;
      try {
        result = await window.api.testConfig(collect());
      } catch (error) {
        if (disposed || token !== fetchToken) return false;
        inFlight = null;
        setPreview({
          state: 'error',
          message: errorText(error, 'The request could not be made.'),
        });
        return false;
      }
      if (disposed || token !== fetchToken) return false;
      inFlight = null;
      if (http) {
        if (typeof result.response === 'string') {
          rememberResponse(result.response);
        } else {
          forgetResponse();
        }
      }
      applyResult(result);
      // Something other than the address changed while this was away.
      if (formatAgain) schedulePreview();
      return http ? response !== null : Boolean(result.ok);
    };

    const schedulePreview = () => {
      window.clearTimeout(previewTimer);
      if (!canFetch()) {
        fetchToken++;
        formatToken++;
        inFlight = null;
        setPreview({ state: 'idle' });
        return;
      }
      if (draft.type === 'crypto') {
        // There is no response to re-read for a coin, so a pause in typing
        // asks the price source again.
        const token = ++fetchToken;
        inFlight = null;
        setPreview({ state: 'loading', text: preview.text });
        previewTimer = window.setTimeout(() => {
          if (token === fetchToken) fetchPreview();
        }, 900);
        return;
      }
      if (inFlight) {
        if (inFlight.source === httpSource()) {
          formatAgain = true;
          return;
        }
        // The address changed under the fetch; its answer no longer applies.
        fetchToken++;
        inFlight = null;
      }
      if (response === null) {
        setPreview({ state: 'ready' });
        return;
      }
      const token = ++formatToken;
      previewTimer = window.setTimeout(async () => {
        try {
          const result = await window.api.testConfig(collect(), response);
          if (!disposed && token === formatToken) applyResult(result);
        } catch (error) {
          if (!disposed && token === formatToken) {
            setPreview({
              state: 'error',
              message: errorText(error, 'The preview could not be made.'),
            });
          }
        }
      }, 200);
    };

    const STAGE_MESSAGES = {
      idle: () =>
        draft.type === 'crypto'
          ? 'Choose a coin and it appears here.'
          : 'Add an address and it appears here.',
      ready: () => 'Fetch the response to see how it reads.',
      loading: () => 'Fetching…',
      ok: () =>
        draft.type === 'crypto'
          ? 'Live from the price source.'
          : 'Made from the last response. Fetch again for fresh data.',
      error: () => preview.message,
    };

    const renderStage = () => {
      const saved = store.requests.find((request) => request.id === requestId);
      const mine = {
        id: requestId,
        name: displayName(),
        value:
          preview.state === 'error'
            ? null
            : (preview.text ?? saved?.value ?? null),
        error: preview.state === 'error',
        pending: preview.state !== 'ok',
      };
      const items = store.requests
        .filter((request) => request.ready || request.id === requestId)
        .map((request) =>
          request.id === requestId
            ? mine
            : {
                id: request.id,
                name: request.name,
                value: request.value,
                error: request.error,
              }
        );
      if (!saved) items.push(mine);
      surface.update({ items, currentId: requestId, message: 'preview' });
      stage.dataset.state = preview.state;
      stageStatus.textContent = STAGE_MESSAGES[preview.state]();
      fetchAgain.disabled = preview.state === 'loading' || !canFetch();
      fetchAgain.setAttribute('aria-busy', String(preview.state === 'loading'));
    };

    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------

    const validateUrl = () =>
      setError('url', draft.type === 'http' ? urlProblem(draft.url) : '');

    const validateHeaders = () => {
      if (draft.type !== 'http') return setError('headers', '');
      const lines = draft.headers.split(/\r?\n/);
      const invalid = lines.findIndex(
        (line) => line.trim() && !/^[^:\s][^:]*:.*$/.test(line)
      );
      return setError(
        'headers',
        invalid === -1 ? '' : `Header line ${invalid + 1} needs Name: value.`
      );
    };

    const validateCoin = () =>
      setError(
        'coin',
        draft.type === 'crypto' && !draft.coin.trim()
          ? 'Enter a ticker, coin ID or Solana mint.'
          : ''
      );

    const validateHoldings = () => {
      const value = draft.holdings.trim();
      return setError(
        'holdings',
        draft.type === 'crypto' && value && !isFiniteNumberText(value)
          ? 'Enter holdings as a number, without separators.'
          : ''
      );
    };

    const validateCurrency = () => {
      if (draft.type !== 'crypto') return setError('currency', '');
      const provider = ui.cryptoProvider(draft);
      const currency = draft.currency.trim().toLowerCase() || 'gbp';
      let message = '';
      if (provider === 'dexscreener' && currency !== 'usd') {
        message = 'DEX Screener quotes USD only.';
      } else if (
        provider === 'jupiter' &&
        !ui.canJupiterConvertCurrency(currency)
      ) {
        message = 'Use a three-letter currency code such as GBP or EUR.';
      }
      return setError('currency', message);
    };

    const validateTimer = () => {
      const value = draft.timer.trim();
      if (!value) return setError('timer', '');
      if (!/^\d+$/.test(value)) {
        return setError('timer', 'Enter a whole number of seconds.');
      }
      const minimum = ui.timerMinimum(draft);
      if (Number(value) < minimum) {
        return setError('timer', `Use at least ${minimum} seconds here.`);
      }
      return setError('timer', '');
    };

    const ruleProblem = (rule) => {
      if (!rule.path.trim()) return ['path', 'Choose a field to check.'];
      if (
        ui.NUMERIC_CONDITION_KINDS.includes(rule.kind) &&
        !isFiniteNumberText(rule.value)
      ) {
        return ['value', 'Enter a number to compare with.'];
      }
      if (!rule.template.trim()) return ['template', 'Enter the text to show.'];
      return null;
    };

    const alertProblem = (rule) => {
      const numeric = ui.NUMERIC_ALERT_KINDS.includes(rule.kind);
      if (!String(rule.value).trim()) {
        return numeric ? 'Enter a number.' : 'Enter the text to look for.';
      }
      if (numeric && !isFiniteNumberText(rule.value)) {
        return 'Enter a number, without separators.';
      }
      if (rule.kind === 'regex' && !isValidJavaScriptRegex(rule.value)) {
        return 'Enter a valid regular expression.';
      }
      return '';
    };

    const validateAll = () => {
      validateUrl();
      validateHeaders();
      validateCoin();
      validateHoldings();
      validateCurrency();
      validateTimer();
      for (const key of [...errors.keys()]) {
        if (key.startsWith('rule:') || key.startsWith('alert:')) {
          errors.delete(key);
        }
      }
      if (draft.type === 'http') {
        draft.display_rules.forEach((rule, index) => {
          const problem = ruleProblem(rule);
          if (problem) errors.set(`rule:${index}`, problem);
        });
      }
      draft.alerts.forEach((rule, index) => {
        const problem = alertProblem(rule);
        if (problem) errors.set(`alert:${index}`, problem);
      });
      renderRules();
      renderAlerts();
      renderStepStates();
      if (!errors.size) return true;

      const order = STEPS[draft.type];
      const firstStep = order.find((step) =>
        [...errors.keys()].some(
          (key) => STEP_FOR_ERROR[key.split(':')[0]] === step
        )
      );
      if (firstStep) {
        showStep(firstStep);
        const invalid = stepNodes
          .get(firstStep)
          ?.body.querySelector('[aria-invalid="true"]');
        const disclosure = invalid?.closest('details');
        if (disclosure) disclosure.open = true;
        invalid?.focus();
      }
      return false;
    };

    // ------------------------------------------------------------------
    // Steps
    // ------------------------------------------------------------------

    const stepTitle = (step) =>
      ({
        source: draft.type === 'crypto' ? 'Coin' : 'Source',
        value: 'Value',
        display: 'Display',
        refresh: 'Refresh',
        alerts: 'Alerts',
      })[step];

    const chosenField = () => {
      const path = draft.json.trim();
      return path ? fields.find((item) => item.path === path) : null;
    };

    const stepSummary = (step) => {
      if (step === 'source') {
        return draft.type === 'crypto'
          ? draft.coin.trim()
            ? `${ui.describeSource(draft)} · ${ui.describeProvider(draft)}`
            : 'Choose a coin'
          : ui.describeSource(draft);
      }
      if (step === 'value') {
        const chosen = chosenField();
        return chosen
          ? `${chosen.path} · ${chosen.summary}`
          : ui.describeField(draft);
      }
      if (step === 'display') return ui.describeDisplay(draft);
      if (step === 'refresh') {
        return ui.describeInterval(ui.effectiveTimer(draft));
      }
      return ui.describeAlerts(draft);
    };

    const renderStepStates = () => {
      const sourced = canFetch();
      for (const [step, nodes] of stepNodes) {
        const failing = [...errors.keys()].some(
          (key) => STEP_FOR_ERROR[key.split(':')[0]] === step
        );
        const done =
          step === 'source'
            ? sourced
            : step === 'value'
              ? sourced && (response !== null || !isNew || draft.json.trim())
              : sourced;
        nodes.element.dataset.state = failing
          ? 'error'
          : done
            ? 'done'
            : 'todo';
        nodes.summary.textContent = stepSummary(step);
      }
    };

    const applyOpenStep = () => {
      for (const [step, nodes] of stepNodes) {
        const open = step === openStep;
        nodes.body.hidden = !open;
        nodes.header.setAttribute('aria-expanded', String(open));
        nodes.element.classList.toggle('is-open', open);
      }
    };

    const showStep = (step, { reveal = true } = {}) => {
      if (!stepNodes.has(step)) return;
      openStep = step;
      applyOpenStep();
      if (step === 'value' && response === null && canFetch()) fetchPreview();
      if (step === 'value') revealChosenField();
      if (reveal) {
        stepNodes
          .get(step)
          .element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    };

    const toggleStep = (step) => {
      if (openStep === step) {
        openStep = null;
        applyOpenStep();
      } else {
        showStep(step);
      }
    };

    const createStep = (step, index) => {
      const bodyId = `step-${step}`;
      const summary = h('span', { class: 'step-summary' });
      const header = h(
        'button',
        {
          type: 'button',
          class: 'step-header',
          'aria-controls': bodyId,
          on: { click: () => toggleStep(step) },
        },
        h(
          'span',
          { class: 'step-heading' },
          h('span', { class: 'step-title', text: stepTitle(step) }),
          summary
        ),
        icon('down', 'icon step-chevron')
      );
      const body = h(
        'div',
        { class: 'step-body', id: bodyId },
        STEP_BODIES[step]()
      );
      const element = h(
        'li',
        { class: 'step', dataset: { step } },
        h('span', {
          class: 'step-marker',
          'aria-hidden': 'true',
          text: String(index + 1),
        }),
        h('div', { class: 'step-main' }, header, body)
      );
      stepNodes.set(step, { element, header, body, summary });
      return element;
    };

    const renderSteps = () => {
      inputs.clear();
      errorNodes.clear();
      stepNodes.clear();
      syncers = [];
      renderFieldPicker = () => {};
      revealChosenField = () => {};
      renderRules = () => {};
      renderAlerts = () => {};
      const order = STEPS[draft.type];
      stepsList.replaceChildren(...order.map(createStep));
      if (!order.includes(openStep)) openStep = null;
      applyOpenStep();
      window.notificationControls.mount(stepsList);
      sync();
    };

    const setType = (type) => {
      if (draft.type === type) return;
      draft.type = type;
      for (const key of [...errors.keys()]) errors.delete(key);
      forgetResponse();
      if (type === 'crypto' && !draft.timer.trim()) timerCustom = false;
      openStep = 'source';
      renderSteps();
      schedulePreview();
    };

    const typeSwitch = () =>
      choiceGroup({
        label: 'Kind of source',
        variant: 'segmented',
        value: draft.type,
        options: [
          ['http', 'An API'],
          ['crypto', 'A crypto price'],
        ],
        onChange: setType,
      }).element;

    // --- Source: an API ------------------------------------------------

    const runFetch = async (control) => {
      if (![validateUrl(), validateHeaders()].every(Boolean)) {
        stepNodes
          .get('source')
          ?.body.querySelector('[aria-invalid="true"]')
          ?.focus();
        return;
      }
      const loaded = await busy(control, fetchPreview);
      if (loaded && !draft.json.trim() && fields.length && isNew) {
        showStep('value');
      }
    };

    const httpSourceBody = () => {
      const url = field(
        'url',
        {
          rows: 2,
          placeholder: 'https://api.example.com/v1/status',
          'aria-describedby': 'error-url sourceNotes',
        },
        'textarea'
      );
      const fetchButton = button('Fetch response', {
        class: 'btn btn-primary',
      });
      fetchButton.addEventListener('click', () => runFetch(fetchButton));
      url.addEventListener('keydown', (event) => {
        if (
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey
        ) {
          event.preventDefault();
          runFetch(fetchButton);
        }
      });
      const fetchStatus = h('span', { class: 'status', role: 'status' });
      syncers.push(() => {
        fetchStatus.dataset.state =
          preview.state === 'error' && response === null ? 'error' : 'neutral';
        fetchStatus.textContent =
          preview.state === 'loading'
            ? 'Fetching…'
            : response !== null
              ? `Response received, ${plural(fields.length, 'field')}.`
              : preview.state === 'error'
                ? preview.message
                : '';
      });

      const headers = field(
        'headers',
        {
          rows: 2,
          placeholder: 'X-API-Key: abc123',
          'aria-describedby': 'error-headers headersHint',
        },
        'textarea'
      );
      const curlInput = h('textarea', {
        class: 'input',
        id: 'curlInput',
        rows: 3,
        placeholder: "curl 'https://api.example.com' -H 'X-API-Key: abc123'",
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: false,
      });
      const curlStatus = h('span', {
        class: 'status',
        role: 'status',
        'aria-live': 'polite',
      });
      const curlButton = button('Use this command', {
        on: {
          click: () =>
            busy(curlButton, async () => {
              try {
                const result = await window.api.importCurl(curlInput.value);
                if (result.url) setValue('url', result.url);
                // Never keep a previous endpoint's secret headers.
                setValue('headers', result.headers || '');
                curlStatus.dataset.state = 'neutral';
                curlStatus.textContent =
                  (result.warnings || []).join(' · ') ||
                  'Address and headers filled in.';
                validateUrl();
                validateHeaders();
              } catch (error) {
                curlStatus.dataset.state = 'error';
                curlStatus.textContent = errorText(
                  error,
                  'That cURL command could not be read.'
                );
              }
            }),
        },
      });

      const advanced = h(
        'details',
        { class: 'more' },
        h('summary', { text: 'Headers and cURL' }),
        h(
          'div',
          { class: 'more-body' },
          labelled(
            'Headers',
            headers,
            h('span', {
              class: 'hint',
              id: 'headersHint',
              text: 'One Name: value per line, for keys and tokens.',
            }),
            errorFor('headers')
          ),
          labelled(
            'Replace both from a cURL command',
            curlInput,
            h('div', { class: 'action-row' }, curlButton, curlStatus)
          )
        )
      );
      if (draft.headers.trim()) advanced.open = true;

      return [
        typeSwitch(),
        labelled(
          'Address',
          url,
          errorFor('url'),
          h('span', {
            class: 'hint',
            id: 'sourceNotes',
            text: notes.join(' · '),
            hidden: !notes.length,
          })
        ),
        h('div', { class: 'action-row' }, fetchButton, fetchStatus),
        advanced,
      ];
    };

    // --- Source: a coin ------------------------------------------------

    const cryptoSourceBody = () => {
      const coin = field('coin', {
        placeholder: 'sol',
        'aria-describedby': 'error-coin coinHint',
      });
      const coinChips = h(
        'div',
        { class: 'choice-chips', role: 'group', 'aria-label': 'Common coins' },
        QUICK_COINS.map((ticker) =>
          h('button', {
            type: 'button',
            class: 'choice-chip',
            text: ticker.toUpperCase(),
            dataset: { coin: ticker },
            on: { click: () => setValue('coin', ticker) },
          })
        )
      );

      // The box is only for codes the chips do not cover, so it stays empty
      // while one of them is chosen.
      const currency = h('input', {
        class: 'input',
        id: 'field-currency',
        type: 'text',
        placeholder: 'Another code',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: false,
        'aria-label': 'Another currency code',
      });
      currency.addEventListener('input', () => {
        draft.currency = currency.value;
        edited('currency');
      });
      inputs.set('currency', currency);
      const currencyChips = h(
        'div',
        { class: 'choice-chips', role: 'group', 'aria-label': 'Currency' },
        COMMON_CURRENCIES.map((code) =>
          h('button', {
            type: 'button',
            class: 'choice-chip',
            text: code.toUpperCase(),
            dataset: { currency: code },
            on: {
              click: () => {
                draft.currency = code;
                edited('currency');
              },
            },
          })
        ),
        currency
      );

      const holdings = field('holdings', {
        inputMode: 'decimal',
        placeholder: 'None',
        'aria-describedby': 'error-holdings holdingsHint',
      });

      const providerSummary = h('summary');
      const provider = choiceGroup({
        label: 'Price source',
        variant: 'list',
        value: ui.cryptoProvider(draft),
        options: PROVIDER_CHOICES,
        onChange: (value) => {
          draft.provider = value;
          if (
            value === 'dexscreener' &&
            draft.currency.trim().toLowerCase() !== 'usd'
          ) {
            draft.currency = 'usd';
          }
          if (
            draft.timer.trim() &&
            Number(draft.timer) < ui.timerMinimum(draft)
          ) {
            assignValue('timer', String(ui.timerDefault(draft)));
          }
          edited('provider');
        },
      });

      syncers.push(() => {
        const activeCoin = draft.coin.trim().toLowerCase();
        for (const chip of coinChips.querySelectorAll('[data-coin]')) {
          chip.setAttribute(
            'aria-pressed',
            String(chip.dataset.coin === activeCoin)
          );
        }
        const activeCurrency = draft.currency.trim().toLowerCase() || 'gbp';
        const typed = COMMON_CURRENCIES.includes(activeCurrency)
          ? ''
          : draft.currency;
        if (document.activeElement !== currency && currency.value !== typed) {
          currency.value = typed;
        }
        for (const chip of currencyChips.querySelectorAll('[data-currency]')) {
          chip.setAttribute(
            'aria-pressed',
            String(chip.dataset.currency === activeCurrency)
          );
        }
        providerSummary.textContent = `Price source: ${ui.describeProvider(draft)}`;
      });

      return [
        typeSwitch(),
        labelled(
          'Coin',
          coin,
          coinChips,
          h('span', {
            class: 'hint',
            id: 'coinHint',
            text: 'A ticker, a CoinGecko ID or a Solana mint address.',
          }),
          errorFor('coin')
        ),
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field-label', text: 'Priced in' }),
          currencyChips,
          errorFor('currency')
        ),
        labelled(
          'How many you hold',
          holdings,
          h('span', {
            class: 'hint',
            id: 'holdingsHint',
            text: 'Optional. With an amount, the value shown is what your holding is worth.',
          }),
          errorFor('holdings')
        ),
        h(
          'details',
          { class: 'more' },
          providerSummary,
          h('div', { class: 'more-body' }, provider.element)
        ),
      ];
    };

    // --- Value: the part of the response -------------------------------

    const valueBody = () => {
      const picker = h('div', { class: 'field-picker' });
      const path = field('json', {
        placeholder: 'data.price',
        list: 'responsePaths',
        'aria-describedby': 'jsonHint',
      });
      const paths = h('datalist', { id: 'responsePaths' });

      const fieldRow = (item, { flat = false } = {}) =>
        h(
          'button',
          {
            type: 'button',
            class: 'field-row',
            dataset: { path: item.path, kind: item.kind },
            on: { click: () => setValue('json', item.path) },
          },
          h('span', {
            class: 'field-key',
            text: flat ? item.path : item.key,
          }),
          h('span', { class: 'field-sample', text: item.summary })
        );

      const tree = (list) => {
        const top = h('ul', { class: 'field-tree' });
        const stack = [top];
        let lastItem = null;
        for (const item of list) {
          while (stack.length > item.depth + 1) stack.pop();
          if (stack.length < item.depth + 1 && lastItem) {
            const branch = h('ul', { class: 'field-branch' });
            lastItem.append(branch);
            stack.push(branch);
          }
          lastItem = h('li', null, fieldRow(item));
          stack[stack.length - 1].append(lastItem);
        }
        return top;
      };

      const markChosen = () => {
        const chosen = draft.json.trim();
        for (const row of picker.querySelectorAll('.field-row')) {
          row.setAttribute(
            'aria-pressed',
            String((row.dataset.path ?? '') === chosen)
          );
        }
      };

      const emptyMessage = h('p', { class: 'field-picker-empty' });
      const emptyFetch = button('Fetch response', { class: 'btn btn-primary' });
      emptyFetch.addEventListener('click', () => runFetch(emptyFetch));
      const pickerEmpty = h(
        'div',
        { class: 'field-picker-wait' },
        emptyMessage,
        emptyFetch
      );
      const pickerList = h('div', { class: 'field-picker-list' });
      picker.append(pickerEmpty, pickerList);
      syncers.push(() => {
        emptyMessage.dataset.state =
          preview.state === 'error' ? 'error' : 'neutral';
        emptyMessage.textContent =
          preview.state === 'loading'
            ? 'Fetching the response…'
            : preview.state === 'error'
              ? preview.message
              : canFetch()
                ? 'Fetch the response and its fields appear here to choose from.'
                : 'Add an address in the step above first.';
        emptyFetch.hidden = preview.state === 'loading' || !canFetch();
      });

      renderFieldPicker = () => {
        paths.replaceChildren(
          ...fields.map((item) =>
            h('option', { value: item.path, text: item.summary })
          )
        );
        pickerEmpty.hidden = response !== null;
        pickerList.hidden = response === null;
        if (response === null) {
          pickerList.replaceChildren();
          return;
        }

        const whole = h(
          'button',
          {
            type: 'button',
            class: 'field-row field-row-whole',
            dataset: { path: '' },
            on: { click: () => setValue('json', '') },
          },
          h('span', { class: 'field-key', text: 'The whole response' }),
          h('span', {
            class: 'field-sample',
            text: fields.length ? '' : ui.truncate(response, 80),
          })
        );

        const query = fieldFilter.trim().toLowerCase();
        const matches = query
          ? fields.filter(
              (item) =>
                item.path.toLowerCase().includes(query) ||
                item.summary.toLowerCase().includes(query)
            )
          : fields;
        const listing = query
          ? h(
              'ul',
              { class: 'field-tree' },
              matches.map((item) =>
                h('li', null, fieldRow(item, { flat: true }))
              )
            )
          : tree(matches);

        const filter = h('input', {
          class: 'input field-filter',
          type: 'search',
          placeholder: 'Filter fields',
          'aria-label': 'Filter fields',
          autocapitalize: 'off',
          autocorrect: 'off',
          spellcheck: false,
          value: fieldFilter,
        });
        filter.addEventListener('input', () => {
          fieldFilter = filter.value;
          const caret = filter.selectionStart;
          renderFieldPicker();
          const next = pickerList.querySelector('.field-filter');
          next?.focus();
          next?.setSelectionRange(caret, caret);
        });

        pickerList.replaceChildren(
          ...[
            fields.length > 8 ? filter : null,
            h(
              'div',
              { class: 'field-scroll' },
              whole,
              listing,
              query && !matches.length
                ? h('p', {
                    class: 'field-picker-empty',
                    text: 'No field matches that.',
                  })
                : null
            ),
            fields.length === 250
              ? h('p', {
                  class: 'hint',
                  text: 'Showing the first 250 fields. Type a path for anything beyond them.',
                })
              : null,
          ].filter(Boolean)
        );
        markChosen();
        if (openStep === 'value' && !query) revealChosenField();
      };
      syncers.push(markChosen);
      // Bring the chosen field into view inside the tree, leaving the page
      // where it is.
      revealChosenField = () => {
        const scroller = pickerList.querySelector('.field-scroll');
        const chosen = pickerList.querySelector(
          '.field-row[aria-pressed="true"]'
        );
        if (!scroller || !chosen) return;
        const offset =
          chosen.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top;
        scroller.scrollTop += offset - scroller.clientHeight / 2;
      };
      renderFieldPicker();

      const multiplier = field('multiplier', {
        inputMode: 'decimal',
        placeholder: '1',
      });
      const length = field('length', {
        inputMode: 'numeric',
        placeholder: 'As sent',
      });
      const adjust = h(
        'details',
        { class: 'more' },
        h('summary', { text: 'Adjust the number' }),
        h(
          'div',
          { class: 'more-body field-pair' },
          labelled('Multiply by', multiplier),
          labelled('Decimal places', length),
          h('span', {
            class: 'hint field-pair-note',
            text: 'For text values, decimal places is the most characters to keep.',
          })
        )
      );
      if (draft.multiplier.trim() || draft.length.trim()) adjust.open = true;

      return [
        picker,
        labelled(
          'Path',
          path,
          paths,
          h('span', {
            class: 'hint',
            id: 'jsonHint',
            text: 'Filled in when you choose a field. You can also type one, such as items[0].value.',
          })
        ),
        adjust,
      ];
    };

    // --- Display --------------------------------------------------------

    const affixRow = () => {
      const prefix = field('prefix', {
        placeholder: 'Before',
        'aria-label': 'Text before the value',
        autocapitalize: undefined,
      });
      const suffix = field('suffix', {
        placeholder: 'After',
        'aria-label': 'Text after the value',
        autocapitalize: undefined,
      });
      // Between the two boxes sits the text they wrap, as it reads now.
      const sample = h('span', {
        class: 'affix-value',
        'aria-hidden': 'true',
        text: 'value',
      });
      syncers.push(() => {
        const text = preview.state === 'ok' ? (preview.text ?? '') : '';
        const wrapped =
          text.length > draft.prefix.length + draft.suffix.length &&
          text.startsWith(draft.prefix) &&
          text.endsWith(draft.suffix);
        sample.textContent = wrapped
          ? ui.truncate(
              text.slice(
                draft.prefix.length,
                text.length - draft.suffix.length
              ),
              18
            )
          : 'value';
      });
      return h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: 'Before and after' }),
        h('div', { class: 'affix-row' }, prefix, sample, suffix),
        h('span', {
          class: 'hint',
          text: 'For units and symbols, such as £ or °C. Spaces are kept.',
        })
      );
    };

    const trackTemplate = (input) => {
      input.addEventListener('focus', () => {
        activeTemplate = input;
      });
      return input;
    };

    const httpDisplayBody = () => {
      const template = trackTemplate(
        field('http_template', {
          placeholder: 'Next update {value|relative}',
          'aria-label': 'Display text',
          'aria-describedby': 'templateHint',
        })
      );
      const insert = (token) =>
        insertAtCaret(
          activeTemplate?.isConnected ? activeTemplate : template,
          token
        );
      const fieldSelect = h('select', {
        class: 'input token-select',
        'aria-label': 'Insert another field',
      });
      fieldSelect.addEventListener('change', () => {
        if (fieldSelect.value) insert(`{${fieldSelect.value}}`);
        fieldSelect.value = '';
      });
      const tokens = h(
        'div',
        {
          class: 'choice-chips token-chips',
          role: 'group',
          'aria-label': 'Insert',
        },
        [
          ['{value}', 'The value'],
          ['{value|datetime}', 'as date and time'],
          ['{value|relative}', 'as time until or since'],
        ].map(([token, text]) =>
          h('button', {
            type: 'button',
            class: 'choice-chip',
            text,
            on: { click: () => insert(token) },
          })
        ),
        fieldSelect
      );
      const custom = h(
        'div',
        { class: 'field display-custom' },
        template,
        tokens,
        h('span', {
          class: 'hint',
          id: 'templateHint',
          text: 'Mix your own words with fields in braces. Dates are shown in local time.',
        })
      );

      const modes = choiceGroup({
        label: 'Show it as',
        value: displayCustom ? 'custom' : ui.displayMode(draft.http_template),
        options: [
          ['plain', 'As it comes'],
          {
            value: 'datetime',
            label: 'Date and time',
            detail: '05 Oct 2026, 14:30',
          },
          { value: 'date', label: 'Date', detail: '05 Oct 2026' },
          { value: 'time', label: 'Time', detail: '14:30' },
          {
            value: 'relative',
            label: 'Time until or since',
            detail: 'in 2h 30m',
          },
          ['custom', 'My own text'],
        ],
        onChange: (mode) => {
          displayCustom = mode === 'custom';
          if (mode === 'custom') {
            if (!draft.http_template.trim())
              setValue('http_template', '{value}');
            else sync();
            template.focus();
          } else {
            setValue(
              'http_template',
              mode === 'plain' ? '' : `{value|${mode}}`
            );
          }
        },
      });

      const fallback = field('empty_text', {
        placeholder: 'Show an error instead',
        autocapitalize: undefined,
        'aria-describedby': 'fallbackHint',
      });

      const ruleList = h('ol', { class: 'rule-list' });
      renderRules = () => {
        ruleList.replaceChildren(
          ...draft.display_rules.map((rule, index) => {
            const problem = errors.get(`rule:${index}`);
            const errorId = `error-rule-${index}`;
            const control = (key, props, tag = 'input') => {
              const input = h(tag, {
                class: 'input',
                autocapitalize: 'off',
                autocorrect: 'off',
                spellcheck: false,
                'aria-describedby': errorId,
                ...props,
              });
              input.value = rule[key] ?? '';
              if (problem?.[0] === key)
                input.setAttribute('aria-invalid', 'true');
              input.addEventListener('input', () => {
                rule[key] = input.value;
                if (errors.delete(`rule:${index}`)) {
                  input.removeAttribute('aria-invalid');
                  error.hidden = true;
                }
                comparison.hidden = ui.VALUELESS_CONDITION_KINDS.includes(
                  rule.kind
                );
                comparison.inputMode = ui.NUMERIC_CONDITION_KINDS.includes(
                  rule.kind
                )
                  ? 'decimal'
                  : 'text';
                edited(`rule:${index}`);
              });
              return input;
            };
            const error = h('span', {
              class: 'field-error',
              id: errorId,
              role: 'alert',
              text: problem?.[1] || '',
              hidden: !problem,
            });
            const comparison = control('value', {
              placeholder: 'this',
              'aria-label': `Condition ${index + 1} compares with`,
            });
            comparison.hidden = ui.VALUELESS_CONDITION_KINDS.includes(
              rule.kind
            );
            const kind = control(
              'kind',
              { 'aria-label': `Condition ${index + 1} test` },
              'select'
            );
            kind.replaceChildren(
              ...ui.CONDITION_KINDS.map(([value, text]) =>
                h('option', { value, text })
              )
            );
            kind.value = rule.kind;

            return h(
              'li',
              { class: 'rule' },
              h(
                'div',
                { class: 'rule-line' },
                h('span', { class: 'rule-word', text: 'If' }),
                control('path', {
                  placeholder: 'data.status',
                  list: 'responsePaths',
                  'aria-label': `Condition ${index + 1} field`,
                }),
                kind,
                comparison
              ),
              h(
                'div',
                { class: 'rule-line' },
                h('span', { class: 'rule-word', text: 'show' }),
                trackTemplate(
                  control('template', {
                    placeholder: 'Your text, or {data.field}',
                    'aria-label': `Condition ${index + 1} shows`,
                  })
                ),
                iconButton('up', `Move condition ${index + 1} up`, {
                  class: 'btn icon-button rule-tool',
                  disabled: index === 0,
                  on: {
                    click: () => {
                      [
                        draft.display_rules[index - 1],
                        draft.display_rules[index],
                      ] = [rule, draft.display_rules[index - 1]];
                      errors.delete(`rule:${index}`);
                      errors.delete(`rule:${index - 1}`);
                      renderRules();
                      ruleList.children[index - 1]
                        ?.querySelector('input')
                        ?.focus();
                      edited('rules');
                    },
                  },
                }),
                iconButton('remove', `Remove condition ${index + 1}`, {
                  class: 'btn icon-button rule-tool',
                  on: {
                    click: () => {
                      draft.display_rules.splice(index, 1);
                      for (const key of [...errors.keys()]) {
                        if (key.startsWith('rule:')) errors.delete(key);
                      }
                      renderRules();
                      addRule.focus();
                      edited('rules');
                    },
                  },
                })
              ),
              error
            );
          })
        );
      };

      const addRule = button('Add a condition', {
        on: {
          click: () => {
            draft.display_rules.push({
              path: draft.json,
              kind: 'empty',
              value: '',
              template: '',
            });
            renderRules();
            ruleList.lastElementChild?.querySelector('input')?.focus();
            edited('rules');
          },
        },
      });
      renderRules();

      const exceptions = h(
        'details',
        { class: 'more' },
        h('summary'),
        h(
          'div',
          { class: 'more-body' },
          labelled(
            'If the value is null or missing, show',
            fallback,
            h('span', {
              class: 'hint',
              id: 'fallbackHint',
              text: 'Zero, false and empty text still count as values.',
            })
          ),
          h(
            'div',
            { class: 'field' },
            h('span', {
              class: 'field-label',
              text: 'Say something else when',
            }),
            ruleList,
            h('div', { class: 'action-row' }, addRule),
            h('span', {
              class: 'hint',
              text: 'The first condition that matches sets the text. Conditions read the response as sent, and text comparisons are case-sensitive.',
            })
          )
        )
      );
      if (draft.empty_text || draft.display_rules.length)
        exceptions.open = true;

      syncers.push(() => {
        custom.hidden = !displayCustom;
        const count = draft.display_rules.length + (draft.empty_text ? 1 : 0);
        exceptions.firstElementChild.textContent = count
          ? `Missing values and conditions (${count})`
          : 'Missing values and conditions';
        const leaves = fields.filter(
          (item) => item.kind !== 'object' && item.kind !== 'array'
        );
        fieldSelect.hidden = !leaves.length;
        const signature = leaves.map((item) => item.path).join('\n');
        if (signature !== fieldSelect.dataset.signature) {
          fieldSelect.dataset.signature = signature;
          fieldSelect.replaceChildren(
            h('option', { value: '', text: 'Another field…' }),
            ...leaves.map((item) =>
              h('option', { value: item.path, text: item.path })
            )
          );
        }
      });

      return [
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field-label', text: 'Show it as' }),
          modes.element
        ),
        custom,
        affixRow(),
        exceptions,
      ];
    };

    const cryptoDisplayBody = () => {
      const template = field('template', {
        placeholder: '{symbol} {price} {change24h}',
        'aria-label': 'Display text',
      });
      const standardLabel = () =>
        draft.holdings.trim()
          ? 'Symbol, holding value and 24h change'
          : 'Symbol, price and 24h change';
      // What the engine shows when the layout is left alone.
      const standardTemplate = () =>
        draft.holdings.trim()
          ? '{symbol} {balance} {change24h}'
          : '{symbol} {price} {change24h}';
      const layoutOf = () => {
        if (cryptoCustom) return 'custom';
        const text = draft.template.trim();
        if (!text || text === standardTemplate()) return 'standard';
        if (text === '{price}') return 'price';
        if (text === '{symbol} {balance} {gain24h}') return 'gain';
        return 'custom';
      };
      cryptoCustom = layoutOf() === 'custom';

      const layouts = choiceGroup({
        label: 'Layout',
        variant: 'list',
        value: layoutOf(),
        options: [
          {
            value: 'standard',
            label: standardLabel(),
            detail: standardTemplate(),
          },
          { value: 'price', label: 'Price only', detail: '{price}' },
          {
            value: 'gain',
            label: 'Symbol, holding value and 24h gain',
            detail: '{symbol} {balance} {gain24h}',
          },
          { value: 'custom', label: 'My own layout' },
        ],
        onChange: (layout) => {
          cryptoCustom = layout === 'custom';
          if (layout === 'custom') {
            if (!draft.template.trim()) {
              setValue('template', standardTemplate());
            } else sync();
            template.focus();
          } else {
            setValue(
              'template',
              {
                standard: '',
                price: '{price}',
                gain: '{symbol} {balance} {gain24h}',
              }[layout]
            );
          }
        },
      });

      const variables = h(
        'div',
        {
          class: 'choice-chips token-chips',
          role: 'group',
          'aria-label': 'Insert a variable',
        },
        CRYPTO_VARIABLES.map((token) =>
          h('button', {
            type: 'button',
            class: 'choice-chip choice-chip-code',
            text: token,
            on: { click: () => insertAtCaret(template, token) },
          })
        )
      );
      const custom = h(
        'div',
        { class: 'field display-custom' },
        template,
        variables,
        h(
          'details',
          { class: 'more more-inline' },
          h('summary', { text: 'Every variable' }),
          h('p', {
            class: 'hint',
            text: '{name} {holdings}, then {change1m} {change5m} {change15m} {change30m} {change1h} {change7d} {change30d} with a matching {gain…} for each. Longer periods depend on the price source.',
          })
        )
      );

      const decimals = field('length', {
        inputMode: 'numeric',
        placeholder: 'Automatic',
      });

      syncers.push(() => {
        custom.hidden = !cryptoCustom;
        layouts.relabel('standard', standardLabel(), standardTemplate());
        layouts.setHidden(
          (layout) =>
            layout === 'gain' && !draft.holdings.trim() && layoutOf() !== 'gain'
        );
      });

      return [
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field-label', text: 'Layout' }),
          layouts.element
        ),
        custom,
        h('div', { class: 'field-pair' }, labelled('Decimal places', decimals)),
        affixRow(),
      ];
    };

    // --- Refresh --------------------------------------------------------

    const refreshBody = () => {
      const presetFor = () => {
        const seconds = ui.effectiveTimer(draft);
        return !timerCustom &&
          REFRESH_CHOICES.some(([value]) => value === seconds)
          ? seconds
          : 'custom';
      };
      if (presetFor() === 'custom') timerCustom = true;

      const timer = field('timer', {
        inputMode: 'numeric',
        'aria-label': 'Seconds between updates',
        'aria-describedby': 'error-timer refreshNote',
      });
      const custom = h(
        'div',
        { class: 'field refresh-custom' },
        h(
          'div',
          { class: 'unit-input' },
          timer,
          h('span', { class: 'unit', text: 'seconds' })
        ),
        errorFor('timer')
      );

      const choices = choiceGroup({
        label: 'How often',
        value: presetFor(),
        options: [...REFRESH_CHOICES, ['custom', 'Something else']],
        onChange: (choice) => {
          timerCustom = choice === 'custom';
          if (timerCustom) {
            if (!draft.timer.trim()) {
              setValue('timer', String(ui.effectiveTimer(draft)));
            } else sync();
            timer.focus();
          } else {
            setValue('timer', String(choice));
          }
        },
      });

      const note = h('p', { class: 'hint', id: 'refreshNote' });
      syncers.push(() => {
        const minimum = ui.timerMinimum(draft);
        choices.setHidden(
          (value) => typeof value === 'number' && value < minimum
        );
        choices.select(presetFor());
        custom.hidden = !timerCustom;
        timer.placeholder = String(ui.timerDefault(draft));

        const seconds = ui.effectiveTimer(draft);
        const parts = [
          `About ${new Intl.NumberFormat().format(ui.fetchesPerDay(seconds))} fetches a day while the app is running.`,
        ];
        if (minimum > 5) {
          parts.push(
            `${ui.PROVIDER_NAMES[ui.refreshPolicyProvider(draft)]} allows one every ${minimum} seconds at most.`
          );
        }
        if (store.info.platform === 'ios') {
          parts.push(
            'With the app closed, iOS chooses when to refresh, usually no more than every 15 minutes.'
          );
        }
        note.textContent = parts.join(' ');
      });

      return [
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'field-label', text: 'Update every' }),
          choices.element
        ),
        custom,
        note,
      ];
    };

    // --- Alerts ---------------------------------------------------------

    const alertsBody = () => {
      const list = h('ol', { class: 'rule-list' });
      const empty = h('p', {
        class: 'hint',
        text: 'Get a notification when the value crosses a line you set. Alerts are checked on this device each time the value updates.',
      });
      const panel = notificationPanel({
        title: 'Notifications',
        inline: true,
      });

      const addAlert = button('Add an alert', {
        on: {
          click: () => {
            draft.alerts.push({
              id: newAlertId(),
              kind: 'above',
              value: '',
              cooldown_secs: 300,
            });
            renderAlerts();
            list.lastElementChild?.querySelector('input')?.focus();
            edited('alerts');
          },
        },
      });

      renderAlerts = () => {
        const subject = draft.type === 'crypto' ? 'the price' : 'it';
        empty.hidden = draft.alerts.length > 0;
        panel.hidden = draft.alerts.length === 0;
        list.replaceChildren(
          ...draft.alerts.map((rule, index) => {
            const problem = errors.get(`alert:${index}`);
            const errorId = `error-alert-${index}`;
            const error = h('span', {
              class: 'field-error',
              id: errorId,
              role: 'alert',
              text: problem || '',
              hidden: !problem,
            });
            const clear = () => {
              if (errors.delete(`alert:${index}`)) {
                amount.removeAttribute('aria-invalid');
                error.hidden = true;
              }
            };

            const amount = h('input', {
              class: 'input',
              type: 'text',
              autocapitalize: 'off',
              autocorrect: 'off',
              spellcheck: false,
              'aria-label': `Alert ${index + 1} amount`,
              'aria-describedby': errorId,
            });
            amount.value = rule.value;
            if (problem) amount.setAttribute('aria-invalid', 'true');
            const tune = () => {
              const numeric = ui.NUMERIC_ALERT_KINDS.includes(rule.kind);
              amount.inputMode = numeric ? 'decimal' : 'text';
              amount.placeholder = numeric
                ? ui.PERCENT_ALERT_KINDS.includes(rule.kind)
                  ? 'Percent'
                  : 'Number'
                : rule.kind === 'regex'
                  ? 'Pattern'
                  : 'Text';
            };
            tune();
            amount.addEventListener('input', () => {
              rule.value = amount.value;
              clear();
              edited('alerts');
            });

            const kind = h(
              'select',
              { class: 'input', 'aria-label': `Alert ${index + 1} test` },
              ui.ALERT_KINDS.map(([value]) =>
                h('option', { value, text: ALERT_OPTION_LABELS[value] })
              )
            );
            kind.value = rule.kind;
            kind.addEventListener('change', () => {
              rule.kind = kind.value;
              tune();
              clear();
              edited('alerts');
            });

            const cooldownChoices = COOLDOWN_CHOICES.some(
              ([seconds]) => seconds === rule.cooldown_secs
            )
              ? COOLDOWN_CHOICES
              : [
                  ...COOLDOWN_CHOICES,
                  [rule.cooldown_secs, ui.describeCooldown(rule.cooldown_secs)],
                ];
            const cooldown = h(
              'select',
              { class: 'input', 'aria-label': `Alert ${index + 1} frequency` },
              cooldownChoices.map(([seconds, text]) =>
                h('option', { value: String(seconds), text })
              )
            );
            cooldown.value = String(rule.cooldown_secs);
            cooldown.addEventListener('change', () => {
              rule.cooldown_secs = Number(cooldown.value);
              edited('alerts');
            });

            return h(
              'li',
              { class: 'rule' },
              h(
                'div',
                { class: 'rule-line' },
                h('span', { class: 'rule-word', text: `When ${subject}` }),
                kind,
                amount
              ),
              h(
                'div',
                { class: 'rule-line' },
                h('span', { class: 'rule-word', text: 'notify me' }),
                cooldown,
                iconButton('remove', `Remove alert ${index + 1}`, {
                  class: 'btn icon-button rule-tool',
                  on: {
                    click: () => {
                      draft.alerts.splice(index, 1);
                      for (const key of [...errors.keys()]) {
                        if (key.startsWith('alert:')) errors.delete(key);
                      }
                      renderAlerts();
                      addAlert.focus();
                      edited('alerts');
                    },
                  },
                })
              ),
              error
            );
          })
        );
      };
      renderAlerts();

      const note = h('p', { class: 'hint' });
      syncers.push(() => {
        const percent = draft.alerts.some((rule) =>
          ui.PERCENT_ALERT_KINDS.includes(rule.kind)
        );
        const parts = [];
        if (draft.type === 'crypto' && draft.alerts.length) {
          parts.push(
            'Price alerts compare the price of one coin, whatever you hold.'
          );
        }
        if (percent) {
          parts.push(
            draft.type === 'crypto'
              ? 'Percentages use the price source’s 24-hour change.'
              : 'Percentages compare with the oldest reading from the last 24 hours.'
          );
        }
        note.textContent = parts.join(' ');
        note.hidden = !parts.length;
      });

      return [
        empty,
        list,
        h('div', { class: 'action-row' }, addAlert),
        note,
        panel,
      ];
    };

    const STEP_BODIES = {
      source: () =>
        draft.type === 'crypto' ? cryptoSourceBody() : httpSourceBody(),
      value: valueBody,
      display: () =>
        draft.type === 'crypto' ? cryptoDisplayBody() : httpDisplayBody(),
      refresh: refreshBody,
      alerts: alertsBody,
    };

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    const setBusy = (working) => {
      saving = working;
      page.inert = working;
      saveButton.disabled = working;
      if (working) saveButton.setAttribute('aria-busy', 'true');
      else saveButton.removeAttribute('aria-busy');
    };

    const save = async () => {
      if (saving || page.hidden) return;
      // A failed check opens the step that holds it and focuses the field.
      if (!validateAll()) return;
      const submitted = collect();
      const snapshot = JSON.stringify(draft);
      setBusy(true);
      try {
        const result = await window.api.saveConfig(requestId, submitted);
        if (result && result.ok === false) {
          saveError.textContent = errorText(
            result.error,
            'The value could not be saved.'
          );
          saveError.hidden = false;
          return;
        }
        savedSnapshot = snapshot;
        dirtyNotified = false;
        await window.api.setDirty(false).catch(() => {});
        await app.poll();
        app.toast(
          isNew ? `${submitted.label.trim() || slotName} added.` : 'Saved.',
          'success'
        );
        const savedId = result?.id || (isNew ? null : requestId);
        app.go(savedId ? app.routes.value(savedId) : app.routes.home(), {
          force: true,
          replace: true,
        });
      } catch (error) {
        console.error('Error saving value:', error);
        saveError.textContent = `Could not save: ${errorText(
          error,
          'the value could not be saved.'
        )}`;
        saveError.hidden = false;
      } finally {
        setBusy(false);
      }
    };
    saveButton.addEventListener('click', save);

    removeButton.addEventListener('click', () =>
      busy(removeButton, async () => {
        const name = displayName();
        try {
          if (!(await window.api.confirmRemove(name))) return;
          app.assertSuccessful(
            await window.api.removeConfig(requestId),
            'The value could not be removed.'
          );
          savedSnapshot = JSON.stringify(draft);
          await app.poll();
          app.toast(`Removed ${name}.`, 'success');
          app.go(app.routes.home(), { force: true, replace: true });
        } catch (error) {
          app.toast(
            `Could not remove: ${errorText(error, 'the value could not be removed.')}`,
            'error'
          );
        }
      })
    );

    fetchAgain.addEventListener('click', () => fetchPreview());

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      loadState.hidden = false;
      page.hidden = true;
      loadMessage.textContent = 'Loading…';
      loadMessage.dataset.state = 'neutral';
      retryButton.hidden = true;
      try {
        const config = await window.api.loadConfig(requestId);
        if (disposed) return;
        if (!isNew && config.isNew) {
          app.toast('That value is no longer here.', 'error');
          app.go(app.routes.home(), { force: true, replace: true });
          return;
        }
        requestId = config.id;
        isNew = Boolean(config.isNew);
        slotName = `Value ${config.position}`;

        const seed = isNew ? app.takeSeed() : null;
        draft = draftFrom({
          ...(config.values || {}),
          ...(seed?.values || {}),
        });
        // A calmer starting pace than the engine's five seconds for an
        // address nobody has chosen an interval for yet.
        if (isNew && draft.type === 'http' && !draft.timer.trim()) {
          draft.timer = '60';
        }
        notes = seed?.notes || [];
        savedSnapshot = JSON.stringify(draft);
        dirtyNotified = false;

        displayCustom = ui.displayMode(draft.http_template) === 'custom';
        timerCustom = false;
        nameInput.value = draft.label;
        nameInput.placeholder = slotName;
        removeButton.hidden = isNew;
        bar.setTitle(isNew ? 'New value' : 'Edit value');

        openStep =
          route.step && STEPS[draft.type].includes(route.step)
            ? route.step
            : isNew && !seed
              ? 'source'
              : null;
        loadState.hidden = true;
        page.hidden = false;
        renderSteps();

        if (canFetch()) {
          fetchPreview().then((loaded) => {
            if (
              loaded &&
              isNew &&
              draft.type === 'http' &&
              !draft.json.trim() &&
              fields.length &&
              openStep === null
            ) {
              showStep('value', { reveal: false });
            }
          });
        }
        if (openStep) {
          stepNodes.get(openStep)?.element.scrollIntoView({ block: 'nearest' });
        }
      } catch (error) {
        if (disposed) return;
        console.error('Error loading value:', error);
        loadMessage.textContent = `Could not load this value: ${errorText(
          error,
          'it could not be read.'
        )}`;
        loadMessage.dataset.state = 'error';
        retryButton.hidden = false;
        retryButton.focus({ preventScroll: true });
      } finally {
        loading = false;
      }
    };
    retryButton.addEventListener('click', load);
    load();

    // A window that was hidden and shown again must agree with the native
    // side about unsaved edits before it can be closed a second time.
    const reportDirty = () => {
      dirtyNotified = isDirty();
      window.api.setDirty(dirtyNotified).catch(() => {});
    };
    window.addEventListener('focus', reportDirty);

    return {
      update: () => {
        if (!page.hidden) renderStage();
      },
      onSubmit: save,
      // Escape empties the field filter before it is allowed to close anything.
      onEscape: () => {
        const filter = document.activeElement;
        if (filter?.classList.contains('field-filter') && filter.value) {
          filter.value = '';
          filter.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      },
      canLeave: async () => {
        if (!isDirty() || saving) return !saving;
        const discard = await window.api.confirmDiscard();
        if (discard) savedSnapshot = JSON.stringify(draft);
        return discard;
      },
      unmount: () => {
        disposed = true;
        window.clearTimeout(previewTimer);
        window.removeEventListener('focus', reportDirty);
        window.api.setDirty(false).catch(() => {});
      },
    };
  };

  window.httpWidgets.views = window.httpWidgets.views || {};
  window.httpWidgets.views.builder = builder;
})();
