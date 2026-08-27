const card = document.getElementById('requestCard');
const emptyState = document.getElementById('emptyState');
const statusLine = document.getElementById('status');
const addButton = document.getElementById('addRequest');
const emptyAddButton = document.getElementById('emptyAddRequest');
const customRequestButton = document.getElementById('customRequest');
const refreshButton = document.getElementById('refreshAll');
const copyAllButton = document.getElementById('copyAllValues');
const copyAllLabel = document.getElementById('copyAllLabel');
const requestCount = document.getElementById('requestCount');
const pausedBanner = document.getElementById('pausedBanner');
const resumeButton = document.getElementById('resumeUpdates');
const backgroundRefreshBanner = document.getElementById(
  'backgroundRefreshBanner'
);
const backgroundRefreshMessage = document.getElementById(
  'backgroundRefreshMessage'
);
const openBackgroundRefreshSettings = document.getElementById(
  'openBackgroundRefreshSettings'
);
const notificationBanner = document.getElementById('notificationBanner');
const presetChoices = document.getElementById('presetChoices');
const presetStatus = document.getElementById('presetStatus');
const footnote = document.getElementById('footnote');
const activity = document.getElementById('activity');
const logView = document.getElementById('logView');

const POLL_MS = 2000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_SPARKLINE_POINTS = 256;
const { errorText: feedbackText } = window.httpWidgetsUi;

let currentState = { requests: [], paused: false, max: 0 };
let lastSignature = null;
let expandedRequestId = null;
let feedbackTimer = null;
let refreshAllBusy = false;
let copyAllBusy = false;
let copyAllCopied = false;
let pollGeneration = 0;

const pendingActions = new Set();
const copiedRequests = new Set();

const edit = (id, presetId = null) => {
  const preset = presetId ? `&preset=${encodeURIComponent(presetId)}` : '';
  window.location.href = `config.html?id=${encodeURIComponent(id)}${preset}`;
};

const makeElement = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const finitePoints = (points) => {
  if (!Array.isArray(points)) return [];
  const sorted = points
    .filter(
      (point) =>
        point &&
        Number.isFinite(point.timestamp) &&
        Number.isFinite(point.value)
    )
    .map((point) => ({
      timestamp: point.timestamp,
      value: point.value,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (sorted.length <= MAX_SPARKLINE_POINTS) return sorted;
  return Array.from({ length: MAX_SPARKLINE_POINTS }, (_, index) => {
    const sourceIndex = Math.round(
      (index * (sorted.length - 1)) / (MAX_SPARKLINE_POINTS - 1)
    );
    return sorted[sourceIndex];
  });
};

const spokenNumber = (value) =>
  new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(
    value
  );

const sparklineFor = (request, expanded = false) => {
  const points = finitePoints(request.points);
  if (points.length < 2) return null;

  const width = expanded ? 320 : 96;
  const height = expanded ? 116 : 30;
  const padding = expanded ? 6 : 2;

  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const valueRange = high - low;
  const firstTimestamp = points[0].timestamp;
  const timeRange = points[points.length - 1].timestamp - firstTimestamp;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;

  const coordinates = points.map((point, index) => {
    const xRatio =
      timeRange > 0
        ? (point.timestamp - firstTimestamp) / timeRange
        : index / (points.length - 1);
    const yRatio = valueRange > 0 ? (point.value - low) / valueRange : 0.5;
    return {
      x: padding + xRatio * innerWidth,
      y: padding + (1 - yRatio) * innerHeight,
    };
  });

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add(
    'sparkline',
    expanded ? 'request-graph' : 'request-sparkline'
  );
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('focusable', 'false');

  const first = points[0].value;
  const last = points[points.length - 1].value;
  const direction = last > first ? 'rising' : last < first ? 'falling' : 'flat';
  const label = `${request.name} trend, ${direction} from ${spokenNumber(first)} to ${spokenNumber(last)} across ${points.length} samples`;
  if (expanded) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = label;
    svg.append(title);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    coordinates
      .map(
        ({ x, y }, index) =>
          `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
      )
      .join(' ')
  );
  svg.append(path);
  return svg;
};

const metricNumber = (value, signDisplay = 'auto') =>
  Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, {
        maximumSignificantDigits: 6,
        signDisplay,
      }).format(value)
    : '—';

const metricsFor = (request) => {
  const points = finitePoints(request.points);
  if (points.length === 0) {
    return { points, minimum: '—', maximum: '—', change: '—', updated: null };
  }

  const values = points.map((point) => point.value);
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  let change = metricNumber(delta, 'exceptZero');
  if (points.length > 1 && first !== 0) {
    const percentage = new Intl.NumberFormat(undefined, {
      style: 'percent',
      maximumFractionDigits: 1,
      signDisplay: 'exceptZero',
    }).format(delta / Math.abs(first));
    change = `${change} (${percentage})`;
  }

  return {
    points,
    minimum: metricNumber(Math.min(...values)),
    maximum: metricNumber(Math.max(...values)),
    change: points.length > 1 ? change : '—',
    updated: points[points.length - 1].timestamp,
  };
};

const normalizedTimestamp = (timestamp) => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return Math.abs(timestamp) < 10_000_000_000 ? timestamp * 1000 : timestamp;
};

const updatedTime = (timestamp) => {
  const milliseconds = normalizedTimestamp(timestamp);
  if (milliseconds === null) return { label: 'Waiting for data', dateTime: '' };
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) {
    return { label: 'Waiting for data', dateTime: '' };
  }

  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - milliseconds) / 1000)
  );
  let label = 'Just now';
  if (elapsedSeconds >= 86_400) {
    label = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
    }).format(date);
  } else if (elapsedSeconds >= 3_600) {
    label = `${Math.floor(elapsedSeconds / 3_600)}h ago`;
  } else if (elapsedSeconds >= 60) {
    label = `${Math.floor(elapsedSeconds / 60)}m ago`;
  }

  return { label, dateTime: date.toISOString(), exact: date.toLocaleString() };
};

const metricItem = (label, value, className = '') => {
  const wrapper = makeElement('div', `request-metric ${className}`.trim());
  const term = makeElement('dt', 'request-metric-label', label);
  const description = makeElement('dd', 'request-metric-value');
  if (value instanceof Node) description.append(value);
  else description.textContent = value;
  wrapper.append(term, description);
  return wrapper;
};

const actionKey = (requestId, action) => `${requestId}:${action}`;

const requestActionButton = (request, action, label, disabled = false) => {
  const button = makeElement('button', 'btn request-action', label);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.requestId = request.id;
  button.disabled = disabled;
  button.setAttribute('aria-label', `${label} ${request.name}`);
  if (pendingActions.has(actionKey(request.id, action))) {
    button.disabled = true;
    button.dataset.state = 'loading';
    button.setAttribute('aria-busy', 'true');
    button.textContent =
      action === 'refresh'
        ? 'Refreshing…'
        : action === 'duplicate'
          ? 'Duplicating…'
          : label;
  } else if (action === 'copy' && copiedRequests.has(request.id)) {
    button.dataset.state = 'success';
    button.textContent = 'Copied';
    button.setAttribute('aria-label', `Copied ${request.name}`);
  }
  return button;
};

const requestSurfaceFor = (request, index, canDuplicate) => {
  const expanded = expandedRequestId === request.id;
  const detailsId = `request-details-${index + 1}`;
  const metrics = metricsFor(request);

  const surface = makeElement(
    'article',
    `request-surface${expanded ? ' is-expanded' : ''}`
  );
  surface.dataset.requestId = request.id;
  if (request.error) surface.dataset.state = 'error';
  else if (!request.ready) surface.dataset.state = 'setup';
  else surface.dataset.state = 'ready';

  const summary = makeElement('button', 'request-surface-summary');
  summary.type = 'button';
  summary.dataset.action = 'toggle';
  summary.dataset.requestId = request.id;
  summary.setAttribute('aria-expanded', String(expanded));
  summary.setAttribute('aria-controls', detailsId);

  const identity = makeElement('span', 'request-identity');
  const name = makeElement('span', 'request-name', request.name);
  const state = makeElement(
    'span',
    'request-state',
    !request.ready ? 'Setup needed' : request.error ? 'Needs attention' : 'Live'
  );
  identity.append(name, state);

  const liveValue = makeElement('span', 'request-live-value');
  const value = makeElement(
    'span',
    `request-value${request.error ? ' request-value-error' : ''}`,
    !request.ready ? 'Not set up' : (request.value ?? 'Waiting…')
  );
  liveValue.append(value);
  const compactGraph = sparklineFor(request);
  if (compactGraph) liveValue.append(compactGraph);
  liveValue.append(makeElement('span', 'request-chevron', '›'));

  summary.setAttribute(
    'aria-label',
    `${expanded ? 'Collapse' : 'Expand'} ${request.name}, ${value.textContent}`
  );
  summary.append(identity, liveValue);
  surface.append(summary);

  if (request.error) {
    const failurePrefix =
      request.failures > 1
        ? `Update failed ${request.failures} times:`
        : 'Update failed:';
    surface.append(
      makeElement('p', 'request-problem', `${failurePrefix} ${request.error}`)
    );
  }

  const details = makeElement('div', 'request-details');
  details.id = detailsId;
  details.hidden = !expanded;

  const graphFigure = makeElement('figure', 'request-graph-frame');
  graphFigure.append(
    makeElement('figcaption', 'request-graph-label', 'Recent trend')
  );
  const graph = sparklineFor(request, true);
  if (graph) {
    graphFigure.append(graph);
  } else {
    graphFigure.append(
      makeElement(
        'p',
        'request-graph-empty',
        request.ready
          ? 'The graph appears after two numeric readings.'
          : 'Finish setup to start collecting readings.'
      )
    );
  }

  const updatedTimestamp =
    request.updatedAt > 0 ? request.updatedAt : metrics.updated;
  const updated = updatedTime(updatedTimestamp);
  const updatedElement = makeElement('time', 'request-updated', updated.label);
  if (updatedTimestamp > 0) {
    updatedElement.dataset.timestamp = String(updatedTimestamp);
  }
  if (updated.dateTime) updatedElement.dateTime = updated.dateTime;
  if (updated.exact) updatedElement.title = updated.exact;

  const metricList = makeElement('dl', 'request-metrics');
  metricList.append(
    metricItem('Minimum', metrics.minimum),
    metricItem('Maximum', metrics.maximum),
    metricItem('Change', metrics.change, 'request-metric-change'),
    metricItem('Updated', updatedElement, 'request-metric-updated')
  );

  const actions = makeElement('div', 'request-actions');
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', `Actions for ${request.name}`);
  actions.append(
    requestActionButton(request, 'copy', 'Copy', !request.value),
    requestActionButton(request, 'refresh', 'Refresh', !request.ready),
    requestActionButton(request, 'duplicate', 'Duplicate', !canDuplicate),
    requestActionButton(request, 'edit', 'Edit')
  );

  details.append(graphFigure, metricList, actions);
  surface.append(details);
  return surface;
};

const setFeedback = (message = '', state = 'neutral', autoClear = false) => {
  window.clearTimeout(feedbackTimer);
  feedbackTimer = null;
  statusLine.textContent = message;
  if (message) statusLine.dataset.state = state;
  else delete statusLine.dataset.state;
  if (message && autoClear) {
    feedbackTimer = window.setTimeout(() => setFeedback(), 4000);
  }
};

const assertSuccessful = (response, fallback) => {
  if (response && response.ok === false) {
    throw new Error(response.error || fallback);
  }
  return response;
};

const focusedAction = () => {
  const control = document.activeElement?.closest?.(
    '[data-action][data-request-id]'
  );
  if (!control) return null;
  return {
    action: control.dataset.action,
    requestId: control.dataset.requestId,
  };
};

const restoreFocusedAction = (descriptor) => {
  if (!descriptor) return;
  const target = Array.from(
    card.querySelectorAll('[data-action][data-request-id]')
  ).find(
    (control) =>
      control.dataset.action === descriptor.action &&
      control.dataset.requestId === descriptor.requestId
  );
  target?.focus({ preventScroll: true });
};

const refreshRelativeTimes = () => {
  for (const element of card.querySelectorAll('time[data-timestamp]')) {
    const updated = updatedTime(Number(element.dataset.timestamp));
    element.textContent = updated.label;
    if (updated.dateTime) element.dateTime = updated.dateTime;
    if (updated.exact) element.title = updated.exact;
  }
};

const render = (state, force = false) => {
  const signature = JSON.stringify(state);
  if (!force && signature === lastSignature) {
    refreshRelativeTimes();
    return;
  }
  lastSignature = signature;

  const focus = focusedAction();
  const requests = Array.isArray(state.requests) ? state.requests : [];
  const maximum = Number.isFinite(state.max) ? state.max : requests.length;
  currentState = { ...state, requests, max: maximum };
  const atLimit = requests.length >= maximum;
  const copyable = requests.some((request) => Boolean(request.value));
  const refreshable = requests.some((request) => request.ready);

  if (
    expandedRequestId &&
    !requests.some((request) => request.id === expandedRequestId)
  ) {
    expandedRequestId = null;
  }

  addButton.disabled = atLimit;
  emptyAddButton.disabled = atLimit;
  customRequestButton.disabled = atLimit;
  copyAllButton.disabled = !copyable || copyAllBusy;
  copyAllButton.dataset.state = copyAllBusy
    ? 'loading'
    : copyAllCopied
      ? 'success'
      : 'default';
  copyAllButton.setAttribute('aria-busy', String(copyAllBusy));
  copyAllButton.setAttribute(
    'aria-label',
    copyAllCopied ? 'Copied all values' : 'Copy all values'
  );
  copyAllButton.title = copyAllCopied ? 'Copied all values' : 'Copy all values';
  copyAllLabel.textContent = copyAllCopied
    ? 'Copied all values'
    : 'Copy all values';

  refreshButton.disabled = !refreshable || refreshAllBusy;
  refreshButton.dataset.state = refreshAllBusy ? 'loading' : 'default';
  refreshButton.setAttribute('aria-busy', String(refreshAllBusy));
  pausedBanner.hidden = !state.paused;
  requestCount.textContent = `${requests.length} ${
    requests.length === 1 ? 'request' : 'requests'
  }`;
  card.setAttribute('aria-busy', 'false');

  if (requests.length === 0) {
    card.replaceChildren(emptyState);
  } else {
    card.replaceChildren(
      ...requests.map((request, index) =>
        requestSurfaceFor(request, index, !atLimit)
      )
    );
  }
  restoreFocusedAction(focus);
};

const rerender = () => render(currentState, true);

const updateExpandedSurfaces = () => {
  for (const surface of card.querySelectorAll('.request-surface')) {
    const expanded = surface.dataset.requestId === expandedRequestId;
    surface.classList.toggle('is-expanded', expanded);
    const summary = surface.querySelector('[data-action="toggle"]');
    const details = surface.querySelector('.request-details');
    summary?.setAttribute('aria-expanded', String(expanded));
    if (summary) {
      const request = currentState.requests.find(
        (item) => item.id === surface.dataset.requestId
      );
      if (request) {
        const value = !request.ready
          ? 'Not set up'
          : (request.value ?? 'Waiting…');
        summary.setAttribute(
          'aria-label',
          `${expanded ? 'Collapse' : 'Expand'} ${request.name}, ${value}`
        );
      }
    }
    if (details) details.hidden = !expanded;
  }
};

const poll = async () => {
  const generation = ++pollGeneration;
  try {
    const state = await window.api.listRequests();
    if (generation !== pollGeneration) return false;
    render(state);
    return true;
  } catch (error) {
    if (generation !== pollGeneration) return false;
    console.error('Error loading requests:', error);
    setFeedback(
      feedbackText(error, 'Could not read the request list. Try again.'),
      'error'
    );
    card.setAttribute('aria-busy', 'false');
    return false;
  }
};

const runRequestAction = async (request, action, operation) => {
  const key = actionKey(request.id, action);
  if (pendingActions.has(key)) return null;
  pendingActions.add(key);
  rerender();
  try {
    return assertSuccessful(
      await operation(),
      `Could not ${action} ${request.name}.`
    );
  } finally {
    pendingActions.delete(key);
    rerender();
  }
};

const copyRequest = async (request) => {
  try {
    await runRequestAction(request, 'copy', () =>
      window.api.copyRequestValue(request.id)
    );
    copiedRequests.add(request.id);
    rerender();
    setFeedback(`Copied ${request.name}.`, 'success', true);
    window.setTimeout(() => {
      copiedRequests.delete(request.id);
      rerender();
    }, 2500);
  } catch (error) {
    setFeedback(
      feedbackText(error, `Could not copy ${request.name}.`),
      'error'
    );
  }
};

const refreshRequest = async (request) => {
  setFeedback(`Refreshing ${request.name}…`, 'loading');
  try {
    await runRequestAction(request, 'refresh', () =>
      window.api.refreshRequestNow(request.id)
    );
    await poll();
    setFeedback(`Refreshed ${request.name}.`, 'success', true);
  } catch (error) {
    setFeedback(
      feedbackText(error, `Could not refresh ${request.name}. Try again.`),
      'error'
    );
  }
};

const duplicateRequest = async (request) => {
  setFeedback(`Duplicating ${request.name}…`, 'loading');
  try {
    await runRequestAction(request, 'duplicate', async () => {
      const loaded = await window.api.loadConfig(request.id);
      const values = JSON.parse(JSON.stringify(loaded.values || {}));
      const baseName =
        String(values.label || request.name).trim() || request.name;
      values.label = `${baseName} copy`;
      return window.api.saveConfig('new', values);
    });
    await poll();
    setFeedback(`Duplicated ${request.name}.`, 'success', true);
  } catch (error) {
    setFeedback(
      feedbackText(error, `Could not duplicate ${request.name}. Try again.`),
      'error'
    );
  }
};

card.addEventListener('click', (event) => {
  const control = event.target.closest('[data-action][data-request-id]');
  if (!control || control.disabled) return;
  event.stopPropagation();

  const request = currentState.requests.find(
    (item) => item.id === control.dataset.requestId
  );
  if (!request) return;

  switch (control.dataset.action) {
    case 'toggle':
      expandedRequestId = expandedRequestId === request.id ? null : request.id;
      updateExpandedSurfaces();
      break;
    case 'copy':
      copyRequest(request);
      break;
    case 'refresh':
      refreshRequest(request);
      break;
    case 'duplicate':
      duplicateRequest(request);
      break;
    case 'edit':
      edit(request.id);
      break;
  }
});

const refreshAll = async () => {
  if (refreshAllBusy) return;
  refreshAllBusy = true;
  rerender();
  setFeedback('Refreshing all requests…', 'loading');
  try {
    assertSuccessful(
      await window.api.refreshAll(),
      'Could not refresh requests.'
    );
    await poll();
    setFeedback('All requests refreshed.', 'success', true);
  } catch (error) {
    setFeedback(
      feedbackText(error, 'Could not refresh requests. Try again.'),
      'error'
    );
  } finally {
    refreshAllBusy = false;
    rerender();
  }
};

const copyAll = async () => {
  if (copyAllBusy) return;
  copyAllBusy = true;
  copyAllCopied = false;
  rerender();
  try {
    assertSuccessful(
      await window.api.copyAllValues(),
      'Could not copy values.'
    );
    copyAllCopied = true;
    rerender();
    setFeedback('Copied all values.', 'success', true);
    window.setTimeout(() => {
      copyAllCopied = false;
      rerender();
    }, 2500);
  } catch (error) {
    setFeedback(
      feedbackText(error, 'Could not copy values. Try again.'),
      'error'
    );
  } finally {
    copyAllBusy = false;
    rerender();
  }
};

const resumeUpdates = async () => {
  resumeButton.disabled = true;
  resumeButton.setAttribute('aria-busy', 'true');
  try {
    assertSuccessful(
      await window.api.setUpdatesPaused(false),
      'Could not resume updates.'
    );
    currentState = { ...currentState, paused: false };
    rerender();
    await poll();
    setFeedback('Updates resumed.', 'success', true);
  } catch (error) {
    setFeedback(
      feedbackText(error, 'Could not resume updates. Try again.'),
      'error'
    );
  } finally {
    resumeButton.disabled = false;
    resumeButton.removeAttribute('aria-busy');
  }
};

const renderPresets = (presets) => {
  const valid = Array.isArray(presets)
    ? presets.filter(
        (preset) => preset && typeof preset.id === 'string' && preset.id.trim()
      )
    : [];

  if (valid.length === 0) {
    presetChoices.replaceChildren();
    presetStatus.textContent = 'No presets are available right now.';
    presetStatus.dataset.state = 'empty';
    return;
  }

  const choices = valid.map((preset) => {
    const item = makeElement('div', 'preset-choice-item');
    item.setAttribute('role', 'listitem');
    const button = makeElement('button', 'preset-choice');
    button.type = 'button';
    button.dataset.presetId = preset.id;
    const name = makeElement('span', 'preset-choice-name', preset.label);
    const description = makeElement(
      'span',
      'preset-choice-description',
      preset.description ||
        (preset.kind === 'crypto'
          ? 'Track a crypto value'
          : 'Track an HTTP value')
    );
    button.append(
      name,
      description,
      makeElement('span', 'preset-choice-arrow', '›')
    );
    button.setAttribute(
      'aria-label',
      `${preset.label}. ${description.textContent}`
    );
    item.append(button);
    return item;
  });
  presetChoices.replaceChildren(...choices);
  presetStatus.textContent = '';
  delete presetStatus.dataset.state;
};

const loadPresets = async () => {
  try {
    renderPresets(await window.api.listPresets());
  } catch (error) {
    presetChoices.replaceChildren();
    presetStatus.textContent = feedbackText(
      error,
      'Could not load presets. You can still add a custom request.'
    );
    presetStatus.dataset.state = 'error';
  }
};

const syncBackgroundRefresh = (info = {}) => {
  const unavailable =
    info.platform === 'ios' && info.backgroundRefresh === 'denied';
  backgroundRefreshBanner.hidden = !unavailable;
  if (unavailable) {
    backgroundRefreshMessage.textContent =
      'Turn on Background App Refresh to let iOS fetch occasionally while the app is closed. Low Power Mode can also switch it off.';
  }
};

const loadAppInfo = async () => {
  try {
    const info = await window.api.appInfo();
    footnote.textContent = `HTTP Widgets ${info.version}`;
    syncBackgroundRefresh(info);
  } catch {
    /* Version and background availability are supplementary. */
  }
};

presetChoices.addEventListener('click', (event) => {
  const choice = event.target.closest('[data-preset-id]');
  if (!choice || choice.disabled) return;
  edit('new', choice.dataset.presetId);
});

const syncNotificationBanner = () => {
  const state = notificationBanner.dataset.notificationState;
  notificationBanner.hidden = ![
    'prompt',
    'denied',
    'unsupported',
    'error',
    'unknown',
  ].includes(state);
};

window.addEventListener('notifications:updated', syncNotificationBanner);

const loadLog = async () => {
  if (!activity.open) return;
  try {
    const body = await window.api.readLog();
    logView.textContent = body || 'Nothing logged yet.';
  } catch (error) {
    logView.textContent = feedbackText(
      error,
      'Could not read recent activity.'
    );
  }
};

activity.addEventListener('toggle', loadLog);
addButton.addEventListener('click', () => edit('new'));
emptyAddButton.addEventListener('click', () => edit('new'));
customRequestButton.addEventListener('click', () => edit('new'));
refreshButton.addEventListener('click', refreshAll);
copyAllButton.addEventListener('click', copyAll);
resumeButton.addEventListener('click', resumeUpdates);
openBackgroundRefreshSettings.addEventListener('click', async () => {
  try {
    await window.api.openNotificationSettings();
  } catch (error) {
    setFeedback(
      feedbackText(error, 'Could not open Settings on this device.'),
      'error'
    );
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([poll(), loadPresets(), loadAppInfo()]);
  window.setInterval(() => {
    if (document.visibilityState === 'visible') poll();
  }, POLL_MS);
  window.setInterval(loadLog, POLL_MS * 5);
});

// WebKit throttles JavaScript timers while iOS is inactive. Pull the latest
// Rust state immediately when the scene returns instead of making the user
// wait for an interval that may resume late or be coalesced by the system.
const pollWhenVisible = () => {
  if (document.visibilityState === 'visible') {
    poll();
    loadAppInfo();
  }
};
window.addEventListener('focus', pollWhenVisible);
window.addEventListener('pageshow', pollWhenVisible);
document.addEventListener('visibilitychange', pollWhenVisible);
