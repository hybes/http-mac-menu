'use strict';

const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  nativeImage,
  ipcMain,
  shell,
  clipboard,
  net,
  powerMonitor,
  nativeTheme,
  screen,
  systemPreferences,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('electron-settings');
const axios = require('axios');
const Sentry = require('@sentry/electron/main');

const {
  FIELDS,
  MAX_REQUESTS,
  MAX_BACKOFF_MULTIPLIER,
  MAX_BACKOFF_SECONDS,
  MAX_ITEM_TITLE_CHARS,
  MAX_TITLE_CHARS,
  OFFLINE_RETRY_SECONDS,
  REQUEST_TIMEOUT_MS,
  SETTINGS_SCHEMA_VERSION,
  TITLE_SEPARATOR,
  PLACEHOLDER_TITLE,
  PENDING_TITLE,
} = require('./lib/constants');
const {
  DEFAULT_INDICATOR,
  INDICATOR_STYLES,
  MARKS,
  normalizeIndicator,
  toText,
} = require('./lib/indicators');
const { TrayImageRenderer } = require('./lib/tray-image');
const {
  formatGain,
  formatHttpValue,
  formatMoney,
  formatPercent,
  parseDecimals,
  parseHeaders,
  parseRefreshSeconds,
  renderTemplate,
  resolveJsonPath,
  sanitizeConfig,
  toNumber,
  truncate,
} = require('./lib/format');
const { PriceHistory } = require('./lib/price-history');
const {
  convertLegacyMillisecondTimers,
  displayName,
  isConfigured,
  makeRequest,
  migrateNumberedSettings,
  normalizeRequests,
} = require('./lib/requests');

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const CONFIG_VIEW = path.join(__dirname, 'views/config.html');
// Wi-Fi takes a moment to reassociate after the lid opens.
const WAKE_REFRESH_DELAY_MS = 3000;

// The settings window is sized to its content by the renderer; these only
// bound it. Height is a starting guess, replaced as soon as the page loads.
const WINDOW_WIDTH = 520;
const WINDOW_MIN_HEIGHT = 240;
const WINDOW_START_HEIGHT = 560;
// Leave room for the menu bar and a bit of breathing space.
const WINDOW_SCREEN_MARGIN = 80;

const windowBackground = () =>
  nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ececec';

if (process.env.NODE_ENV !== 'development') {
  Sentry.init({
    dsn: 'https://cafe8add82bc452cae5a17bcd0939493@error.brth.uk/4',
  });
}

const logFilePath = path.join(app.getPath('userData'), 'http-mac-menu.log');

// Sentinel id for the settings window when it is adding a request that does
// not exist yet; nothing is stored until it is saved.
const NEW_REQUEST_ID = 'new';

let tray = null;
let configWindow = null;
let requests = [];
let indicator = DEFAULT_INDICATOR;
let paused = false;
// Set while closing the settings window on purpose (after a save or a remove,
// or once the user has agreed to discard), so the guard below stands aside.
let discardConfirmed = false;
let quitting = false;
const trayRenderer = new TrayImageRenderer();
const refreshTimers = {};
const inFlight = new Set();
// request id -> { value, error, offline, updatedAt, failures }
const status = {};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const timestamp = () =>
  new Date().toISOString().replace('T', ' ').substring(0, 19);

const log = (line) => {
  try {
    fs.appendFileSync(logFilePath, `${timestamp()} - ${line}\n`);
    if (fs.statSync(logFilePath).size > MAX_LOG_BYTES) {
      fs.writeFileSync(logFilePath, '');
    }
  } catch (err) {
    console.error('Failed to write log file:', err);
  }
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const requestIds = () => requests.map((request) => request.id);

const findRequest = (id) => requests.find((request) => request.id === id);

const indexOfRequest = (id) =>
  requests.findIndex((request) => request.id === id);

const nameFor = (id) => {
  const index = indexOfRequest(id);
  return index === -1 ? 'Request' : displayName(requests[index], index);
};

const isCrypto = (request) => request.type === 'crypto';

const isReady = (id) => {
  const request = findRequest(id);
  return Boolean(request && isConfigured(request));
};

const saveSettings = () =>
  settings.set({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    indicator,
    requests,
  });

// Schema 2 replaced three fixed numbered slots with a list the user controls.
// Older files are read once, converted, and written back in the new shape.
const loadSettings = async () => {
  const stored = (await settings.get()) || {};
  const version = Number(stored.schemaVersion);

  indicator = normalizeIndicator(stored.indicator);

  if (version >= SETTINGS_SCHEMA_VERSION) {
    requests = normalizeRequests(stored.requests);
    return;
  }

  const legacy = version >= 1 ? stored : convertLegacyMillisecondTimers(stored);
  requests = migrateNumberedSettings(legacy);
  await saveSettings();
  log(
    `Migrated settings to schema ${SETTINGS_SCHEMA_VERSION} (${requests.length} request(s) kept)`
  );
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const describeError = (err) => {
  if (axios.isAxiosError(err)) {
    if (err.response) {
      return `HTTP ${err.response.status} ${err.response.statusText || ''}`.trim();
    }
    if (err.code === 'ECONNABORTED') return 'Request timed out';
    return err.message;
  }
  return err && err.message ? err.message : String(err);
};

// ---------------------------------------------------------------------------
// HTTP source
// ---------------------------------------------------------------------------

const fetchHttpValue = async (cfg) => {
  const url = String(cfg.url || '').trim();
  if (!url) throw new Error('No URL configured');

  const res = await axios.get(url, {
    headers: parseHeaders(cfg.headers),
    timeout: REQUEST_TIMEOUT_MS,
  });

  let raw = res.data;
  const jsonPath = String(cfg.json || '').trim();
  if (jsonPath) {
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        throw new Error(
          'A JSON path is set but the response is not valid JSON'
        );
      }
    }
    raw = resolveJsonPath(raw, jsonPath);
  }

  if (raw === undefined || raw === null) {
    throw new Error('Response value is empty');
  }

  return { text: formatHttpValue(raw, cfg), data: res.data };
};

// ---------------------------------------------------------------------------
// Crypto source (CoinGecko public API, no key required)
// ---------------------------------------------------------------------------

const COINGECKO_API = 'https://api.coingecko.com/api/v3';

// Common tickers -> CoinGecko ids. Anything else is looked up via /search.
const COIN_IDS = {
  btc: 'bitcoin',
  eth: 'ethereum',
  sol: 'solana',
  xrp: 'ripple',
  ada: 'cardano',
  doge: 'dogecoin',
  dot: 'polkadot',
  ltc: 'litecoin',
  bnb: 'binancecoin',
  link: 'chainlink',
  avax: 'avalanche-2',
  matic: 'matic-network',
  pol: 'polygon-ecosystem-token',
  usdt: 'tether',
  usdc: 'usd-coin',
  trx: 'tron',
  shib: 'shiba-inu',
  uni: 'uniswap',
  atom: 'cosmos',
  xlm: 'stellar',
  ton: 'the-open-network',
  near: 'near',
  sui: 'sui',
  apt: 'aptos',
  arb: 'arbitrum',
  op: 'optimism',
  pepe: 'pepe',
  hbar: 'hedera-hashgraph',
  xmr: 'monero',
  bch: 'bitcoin-cash',
  etc: 'ethereum-classic',
  fil: 'filecoin',
  algo: 'algorand',
  vet: 'vechain',
  icp: 'internet-computer',
  inj: 'injective-protocol',
  aave: 'aave',
  mkr: 'maker',
  ldo: 'lido-dao',
  render: 'render-token',
  tao: 'bittensor',
  kas: 'kaspa',
};

// Periods CoinGecko reports directly.
const API_PERIODS = {
  '1h': 'price_change_percentage_1h_in_currency',
  '24h': 'price_change_percentage_24h_in_currency',
  '7d': 'price_change_percentage_7d_in_currency',
  '30d': 'price_change_percentage_30d_in_currency',
};
// Periods worked out from our own price samples (minutes).
const LOCAL_PERIODS = { '1m': 1, '5m': 5, '15m': 15, '30m': 30 };

const coinIdCache = new Map(); // user input (lowercased) -> CoinGecko id
const priceHistory = new PriceHistory();

const coingecko = (endpoint, params) =>
  axios.get(`${COINGECKO_API}${endpoint}`, {
    params,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { Accept: 'application/json' },
  });

const fetchMarket = async (id, currency) => {
  const res = await coingecko('/coins/markets', {
    vs_currency: currency,
    ids: id,
    price_change_percentage: '1h,24h,7d,30d',
  });
  return Array.isArray(res.data) && res.data.length ? res.data[0] : null;
};

const searchCoinId = async (query) => {
  const res = await coingecko('/search', { query });
  const coins = (res.data && res.data.coins) || [];
  const exact = coins.find(
    (coin) =>
      String(coin.symbol).toLowerCase() === query ||
      String(coin.id).toLowerCase() === query ||
      String(coin.name).toLowerCase() === query
  );
  return (exact || coins[0] || {}).id || null;
};

const resolveMarket = async (input, currency) => {
  const query = String(input || '')
    .trim()
    .toLowerCase();
  if (!query) throw new Error('No coin set');

  const candidates = new Set(
    [coinIdCache.get(query), COIN_IDS[query], query].filter(Boolean)
  );
  for (const id of candidates) {
    const market = await fetchMarket(id, currency);
    if (market) {
      coinIdCache.set(query, id);
      return market;
    }
  }

  const id = await searchCoinId(query);
  const market = id ? await fetchMarket(id, currency) : null;
  if (!market) {
    throw new Error(
      `Coin "${input}" not found on CoinGecko. Try its id, e.g. solana or bitcoin`
    );
  }
  coinIdCache.set(query, id);
  return market;
};

// `record` is off for the Test button so trying out a config does not add
// samples that the real minute-scale changes would then be measured against.
const fetchCryptoValue = async (cfg, { record = true } = {}) => {
  const currency =
    String(cfg.currency || '')
      .trim()
      .toLowerCase() || 'gbp';

  let market;
  try {
    market = await resolveMarket(cfg.coin, currency);
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      if (err.response.status === 429) {
        throw new Error(
          'CoinGecko rate limit reached — use a longer refresh interval'
        );
      }
      if (err.response.status === 422 || err.response.status === 400) {
        throw new Error(`Currency "${currency}" is not supported by CoinGecko`);
      }
    }
    throw err;
  }

  const price = Number(market.current_price);
  if (!Number.isFinite(price)) throw new Error('CoinGecko returned no price');

  const holdings = toNumber(cfg.holdings);
  const current = holdings !== null ? holdings * price : price;
  const decimals = parseDecimals(cfg.length);
  const key = `${market.id}:${currency}`;
  if (record) priceHistory.record(key, price);

  const values = {
    symbol: String(market.symbol || '').toUpperCase(),
    name: market.name || '',
    price: formatMoney(price, currency, decimals),
    holdings: holdings !== null ? holdings.toLocaleString() : '',
    balance: formatMoney(current, currency, decimals),
  };
  for (const [label, minutes] of Object.entries(LOCAL_PERIODS)) {
    const pct = priceHistory.changeSince(key, minutes, price);
    values[`change${label}`] = formatPercent(pct);
    values[`gain${label}`] = formatGain(pct, current, currency, decimals);
  }
  for (const [label, field] of Object.entries(API_PERIODS)) {
    const pct = toNumber(market[field]);
    values[`change${label}`] = formatPercent(pct);
    values[`gain${label}`] = formatGain(pct, current, currency, decimals);
  }

  const template =
    String(cfg.template || '').trim() ||
    (holdings !== null
      ? '{symbol} {balance} {change24h}'
      : '{symbol} {price} {change24h}');

  return {
    text: `${cfg.prefix || ''}${renderTemplate(template, values)}${cfg.suffix || ''}`,
    data: {
      id: market.id,
      currency,
      price,
      change24h: market.price_change_percentage_24h_in_currency,
    },
  };
};

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const fetchValue = (request, options) =>
  isCrypto(request)
    ? fetchCryptoValue(request, options)
    : fetchHttpValue(request);

const refreshRequest = async (id) => {
  if (!isReady(id)) {
    delete status[id];
    return;
  }
  if (inFlight.has(id)) return;

  const previous = status[id] || {};

  // A dropped network is not the endpoint's fault: keep the last value, leave
  // the failure count alone so we do not back off, and stay quiet in the log.
  if (!net.isOnline()) {
    status[id] = { ...previous, offline: true };
    return;
  }

  inFlight.add(id);
  try {
    const { text, data } = await fetchValue(findRequest(id));
    status[id] = {
      value: text,
      error: null,
      offline: false,
      updatedAt: new Date(),
      failures: 0,
    };
    log(
      `Success (${nameFor(id)}): showing "${toText(text)}" from ${truncate(JSON.stringify(data), 500)}`
    );
  } catch (err) {
    const message = describeError(err);
    status[id] = {
      value: previous.value ?? null,
      updatedAt: previous.updatedAt ?? null,
      error: message,
      offline: false,
      failures: (previous.failures || 0) + 1,
    };
    log(`Error (${nameFor(id)}): ${message}`);
    // Network and HTTP failures are expected from time to time and are already
    // in the local log; only report genuinely unexpected errors.
    if (!axios.isAxiosError(err)) Sentry.captureException(err);
  } finally {
    inFlight.delete(id);
  }
};

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

const nextRefreshSeconds = (id) => {
  const request = findRequest(id);
  const base = parseRefreshSeconds(request.timer, request.type);
  const current = status[id] || {};

  // While offline there is nothing to hammer — checking the local flag often
  // just means we pick up again quickly once the network is back.
  if (current.offline) return Math.min(base, OFFLINE_RETRY_SECONDS);

  // Back off while a request keeps failing so we don't hammer a broken or
  // rate-limited endpoint: base, 2x, 4x, 8x … capped.
  const multiplier = Math.min(
    2 ** (current.failures || 0),
    MAX_BACKOFF_MULTIPLIER
  );
  return Math.min(base * multiplier, MAX_BACKOFF_SECONDS);
};

const stopRefresh = (id) => {
  clearTimeout(refreshTimers[id]);
  delete refreshTimers[id];
};

const scheduleRefresh = (id) => {
  stopRefresh(id);
  if (paused || !isReady(id)) return;

  refreshTimers[id] = setTimeout(
    async () => {
      await refreshRequest(id);
      renderTray();
      scheduleRefresh(id);
    },
    nextRefreshSeconds(id) * 1000
  );
};

// `force` is for refreshes the user asked for by hand, which should happen even
// while updates are paused. Everything else must respect the pause — checking
// it only in scheduleRefresh would still let one fetch through first.
const startRequest = async (id, { force = false } = {}) => {
  stopRefresh(id);
  if (paused && !force) return;
  await refreshRequest(id);
  renderTray();
  scheduleRefresh(id);
};

const refreshAll = async ({ force = false } = {}) =>
  Promise.all(requestIds().map((id) => startRequest(id, { force })));

const setPaused = (value) => {
  paused = value;
  if (paused) {
    for (const id of requestIds()) stopRefresh(id);
    log('Updates paused');
    renderTray();
  } else {
    log('Updates resumed');
    refreshAll();
  }
};

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

const formatTime = (date) =>
  date ? date.toLocaleTimeString(undefined, { hour12: false }) : '';

// Why a request is not showing a fresh value, or null when it is fine.
const problemWith = (current) =>
  current.offline ? 'No network connection' : current.error || null;

// Keeps the direction markers in place: the menu bar turns them into icons.
const trayTitleFor = (id) => {
  const current = status[id];
  if (!current) return PENDING_TITLE;
  const value =
    current.value == null
      ? null
      : truncate(String(current.value), MAX_ITEM_TITLE_CHARS);
  if (problemWith(current)) {
    return value ? `${MARKS.warn} ${value}` : MARKS.warn;
  }
  return value ?? PENDING_TITLE;
};

const tooltipFor = (id) => {
  const name = nameFor(id);
  const current = status[id];
  if (!current) return `${name}: loading…`;
  const problem = problemWith(current);
  if (problem) {
    const last = current.value
      ? ` (showing value from ${formatTime(current.updatedAt)})`
      : '';
    return `${name}: ${problem}${last}`;
  }
  return `${name}: ${toText(current.value)} (updated ${formatTime(current.updatedAt)})`;
};

const menuLabelFor = (id) => {
  const name = nameFor(id);
  if (!isReady(id)) return `${name}: not set up`;
  const current = status[id];
  if (!current) return `${name}: loading…`;
  const problem = problemWith(current);
  const text = problem ? `⚠ ${problem}` : toText(current.value);
  return `${name}: ${truncate(String(text), 60)}`;
};

const copyableIds = () =>
  requestIds().filter((id) => isReady(id) && status[id] && status[id].value);

const buildCopyItem = () => {
  const copyable = copyableIds();
  if (!copyable.length) return { label: 'Copy Value', enabled: false };

  const submenu = copyable.map((id) => ({
    label: truncate(`${nameFor(id)}: ${toText(status[id].value)}`, 60),
    click: () => clipboard.writeText(toText(status[id].value)),
  }));

  if (copyable.length > 1) {
    submenu.push(
      { type: 'separator' },
      {
        label: 'All Values',
        click: () =>
          clipboard.writeText(
            copyable.map((id) => toText(status[id].value)).join(TITLE_SEPARATOR)
          ),
      }
    );
  }
  return { label: 'Copy Value', submenu };
};

const buildMenu = () =>
  Menu.buildFromTemplate([
    ...(requests.length
      ? requests.map((request) => ({
          label: menuLabelFor(request.id),
          click: () => openConfig(request.id),
        }))
      : [{ label: 'No requests yet', enabled: false }]),
    {
      label: 'Add Request…',
      enabled: requests.length < MAX_REQUESTS,
      click: () => openConfig(NEW_REQUEST_ID),
    },
    { type: 'separator' },
    { label: 'Refresh Now', click: () => refreshAll({ force: true }) },
    buildCopyItem(),
    {
      label: paused ? 'Resume Updates' : 'Pause Updates',
      enabled: requests.length > 0,
      click: () => setPaused(!paused),
    },
    {
      label: 'Rise / Fall Icon',
      submenu: INDICATOR_STYLES.map((style) => ({
        label: style.label,
        type: 'radio',
        checked: indicator === style.id,
        click: () => setIndicator(style.id),
      })),
    },
    {
      label: 'Launch at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        renderTray();
      },
    },
    { label: 'Open Log', click: () => shell.openPath(logFilePath) },
    { type: 'separator' },
    { label: `HTTP Mac Menu ${app.getVersion()}`, enabled: false },
    { label: 'Quit', role: 'quit' },
  ]);

let lastRendered = { title: null, tooltip: null, menu: null };
// Drawing the menu bar image is asynchronous, so a slow render must not be
// allowed to land on top of a newer value.
let renderToken = 0;

const emptyTrayIcon = () =>
  process.platform === 'darwin'
    ? nativeImage.createEmpty()
    : nativeImage.createFromPath(path.join(__dirname, 'assets/trayWin.png'));

const showTrayText = (text) => {
  tray.setImage(emptyTrayIcon());
  tray.setTitle(toText(text));
};

// Icons need the menu bar contents drawn as a template image. Anything that
// goes wrong there falls back to text, so the menu bar is never blank.
const showTrayContents = async (items, text) => {
  const token = ++renderToken;
  if (process.platform !== 'darwin' || indicator === 'text' || !items.length) {
    showTrayText(text);
    return;
  }

  const image = await trayRenderer.render(items, indicator);
  if (token !== renderToken || !tray || tray.isDestroyed()) return;
  if (!image) {
    showTrayText(text);
    return;
  }
  tray.setTitle('');
  tray.setImage(image);
};

const renderTray = () => {
  if (!tray || tray.isDestroyed()) return;
  const ready = requestIds().filter(isReady);

  const items = ready.length ? ready.map(trayTitleFor) : [PLACEHOLDER_TITLE];
  const title = ready.length
    ? truncate(ready.map(trayTitleFor).join(TITLE_SEPARATOR), MAX_TITLE_CHARS)
    : PLACEHOLDER_TITLE;
  const tooltip = ready.length
    ? [...ready.map(tooltipFor), ...(paused ? ['Updates paused'] : [])].join(
        '\n'
      )
    : 'No requests set up yet — click to add one';
  const menu = [
    ...requestIds().map(menuLabelFor),
    ...copyableIds().map((id) => `copy:${status[id].value}`),
    `count:${requests.length}`,
    `paused:${paused}`,
    `indicator:${indicator}`,
    `login:${app.getLoginItemSettings().openAtLogin}`,
  ].join('\n');

  if (title !== lastRendered.title) showTrayContents(items, title);
  if (tooltip !== lastRendered.tooltip) tray.setToolTip(tooltip);
  // Replacing the menu closes it if it is open, so only do it when it changed.
  if (menu !== lastRendered.menu) tray.setContextMenu(buildMenu());
  lastRendered = { title, tooltip, menu };
};

const setIndicator = async (style) => {
  indicator = normalizeIndicator(style);
  await saveSettings();
  log(`Indicator style set to ${indicator}`);
  lastRendered = { title: null, tooltip: null, menu: null };
  renderTray();
};

const createTray = () => {
  tray = new Tray(emptyTrayIcon());
  tray.setTitle('Loading…');
  tray.setToolTip('Loading…');
  tray.setContextMenu(buildMenu());
  lastRendered = { title: null, tooltip: null, menu: null };
};

// ---------------------------------------------------------------------------
// Config window
// ---------------------------------------------------------------------------

// The settings window only ever shows its own page; anything else is either a
// mistake or something a response has talked the renderer into loading.
const isConfigUrl = (url) => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'file:' &&
      decodeURIComponent(parsed.pathname) === CONFIG_VIEW
    );
  } catch {
    return false;
  }
};

const hardenWindow = (contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isConfigUrl(url)) event.preventDefault();
  });
};

// The renderer knows whether the form has been edited since it was loaded.
const configIsDirty = async () => {
  if (!configWindow || configWindow.isDestroyed()) return false;
  try {
    return Boolean(
      await configWindow.webContents.executeJavaScript(
        'typeof configIsDirty === "function" && configIsDirty()'
      )
    );
  } catch {
    // If the page cannot answer, do not stand in the way of closing it.
    return false;
  }
};

// Used by every path that would throw away edits: closing the window, and
// loading a different request into the window that is already open.
const confirmDiscard = async () => {
  if (!(await configIsDirty())) return true;
  const { response } = await dialog.showMessageBox(configWindow, {
    type: 'warning',
    message: 'Discard unsaved changes?',
    detail: 'This request has edits that have not been saved.',
    buttons: ['Discard Changes', 'Keep Editing'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
};

const openConfig = async (id) => {
  const query = { id: String(id) };

  if (configWindow && !configWindow.isDestroyed()) {
    // Loading another request over the top would drop the current edits.
    if (!(await confirmDiscard())) {
      configWindow.show();
      configWindow.focus();
      return;
    }
    configWindow.loadFile(CONFIG_VIEW, { query });
    configWindow.show();
    configWindow.focus();
    return;
  }

  configWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_START_HEIGHT,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    // A settings panel, not a document window: fixed width, no zoom button,
    // and the traffic lights sit over the content instead of on their own bar.
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 8 },
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    title: 'HTTP Mac Menu',
    webPreferences: {
      preload: path.join(__dirname, 'scripts/config.preload.js'),
    },
    icon: nativeImage.createFromPath(
      path.join(__dirname, 'assets/trayWin.png')
    ),
  });

  configWindow.once('ready-to-show', () => {
    if (configWindow) configWindow.show();
  });

  // Catches every way the window can be dismissed — the red button, Cmd-W and
  // Escape all end up here, so the check lives in one place.
  configWindow.on('close', (event) => {
    if (discardConfirmed || quitting) return;
    event.preventDefault();
    const closing = configWindow;
    confirmDiscard().then((confirmed) => {
      if (!confirmed || !closing || closing.isDestroyed()) return;
      discardConfirmed = true;
      closing.close();
    });
  });

  configWindow.on('closed', () => {
    configWindow = null;
    discardConfirmed = false;
  });

  hardenWindow(configWindow.webContents);

  configWindow.webContents.on('before-input-event', (event, input) => {
    const devtools =
      input.key === 'F12' ||
      ((input.meta || input.control) &&
        input.alt &&
        input.key.toLowerCase() === 'i');
    if (devtools) {
      configWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  configWindow.loadFile(CONFIG_VIEW, { query });
};

// `force` is for closes that follow an explicit save or remove, where there is
// nothing left to lose and asking would be nonsense.
const closeConfigWindow = ({ force = false } = {}) => {
  if (!configWindow || configWindow.isDestroyed()) return;
  if (force) discardConfirmed = true;
  configWindow.close();
};

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const blankRequest = () =>
  Object.fromEntries(FIELDS.map((field) => [field, '']));

const registerIpc = () => {
  ipcMain.handle('config:load', (_event, id) => {
    const request = findRequest(id);
    if (!request) {
      // Either "Add Request…" or a request removed from another window.
      return {
        id: NEW_REQUEST_ID,
        values: { ...blankRequest(), type: 'http' },
        position: requests.length + 1,
        isNew: true,
      };
    }
    return {
      id: request.id,
      values: request,
      position: indexOfRequest(id) + 1,
      isNew: false,
    };
  });

  ipcMain.handle('config:save', async (_event, id, values) => {
    const clean = sanitizeConfig(values);
    const index = indexOfRequest(id);

    let savedId;
    if (index === -1) {
      if (requests.length >= MAX_REQUESTS) {
        return { ok: false, error: `You can have at most ${MAX_REQUESTS}.` };
      }
      const request = makeRequest(clean, requests);
      requests.push(request);
      savedId = request.id;
    } else {
      requests[index] = { id, ...clean };
      savedId = id;
      delete status[id];
    }

    await saveSettings();
    log(`Saved ${nameFor(savedId)}`);
    closeConfigWindow({ force: true });
    renderTray();
    await startRequest(savedId);
    return { ok: true };
  });

  ipcMain.handle('config:remove', async (_event, id) => {
    const index = indexOfRequest(id);
    if (index === -1) return { ok: true };

    const name = nameFor(id);
    requests.splice(index, 1);
    stopRefresh(id);
    delete status[id];
    await saveSettings();
    log(`Removed ${name}`);
    closeConfigWindow({ force: true });
    renderTray();
    return { ok: true };
  });

  ipcMain.handle('config:test', async (_event, values) => {
    try {
      const { text } = await fetchValue(sanitizeConfig(values), {
        record: false,
      });
      // The settings window shows this as plain text, so the direction
      // markers become characters rather than icons.
      return { ok: true, value: toText(text) };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  });

  ipcMain.handle('config:close', () => closeConfigWindow());

  // The renderer measures its own content and asks the window to match, so the
  // settings never scroll. Only a screen too short for the form clamps it.
  ipcMain.handle('config:fit', (event, height) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { clamped: false };
    const wanted = Math.ceil(Number(height));
    if (!Number.isFinite(wanted) || wanted <= 0) return { clamped: false };

    const { workAreaSize } = screen.getDisplayMatching(win.getBounds());
    const available = Math.max(
      WINDOW_MIN_HEIGHT,
      workAreaSize.height - WINDOW_SCREEN_MARGIN
    );
    const target = Math.min(Math.max(wanted, WINDOW_MIN_HEIGHT), available);
    if (win.getContentSize()[1] !== target) {
      win.setContentSize(WINDOW_WIDTH, target, false);
    }
    return { clamped: wanted > target };
  });

  // Matching the user's own accent colour is most of what makes a window feel
  // like it belongs to the system rather than to a browser.
  ipcMain.handle('config:accent', () => {
    try {
      return systemPreferences.getAccentColor();
    } catch {
      return null;
    }
  });
};

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const init = async () => {
  await loadSettings();
  log(`Started HTTP Mac Menu ${app.getVersion()}`);

  app.setAppUserModelId('HTTP Mac Menu');
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Timers do not fire while the Mac is asleep, so everything on screen is
  // stale the moment it wakes up.
  powerMonitor.on('resume', () => {
    if (paused) return;
    log('Woke from sleep — refreshing');
    // Checked again on the way out: the pause could have come in since.
    setTimeout(() => {
      if (!paused) refreshAll();
    }, WAKE_REFRESH_DELAY_MS);
  });

  nativeTheme.on('updated', () => {
    if (configWindow && !configWindow.isDestroyed()) {
      configWindow.setBackgroundColor(windowBackground());
    }
  });

  registerIpc();
  createTray();
  renderTray();

  if (!requests.length) openConfig(NEW_REQUEST_ID);

  await refreshAll();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () =>
    openConfig(requests.length ? requests[0].id : NEW_REQUEST_ID)
  );
  // This is a tray app: closing the settings window must not quit it.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    quitting = true;
    trayRenderer.destroy();
  });
  app.whenReady().then(init);
}
