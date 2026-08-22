'use strict';

const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  nativeImage,
  ipcMain,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const settings = require('electron-settings');
const axios = require('axios');
const Sentry = require('@sentry/electron/main');

const CONFIG_COUNT = 3;
const CONFIG_NUMBERS = Array.from({ length: CONFIG_COUNT }, (_, i) => i + 1);
const FIELDS = [
  'type', // 'http' (default) or 'crypto'
  // http
  'url',
  'headers',
  'json',
  'multiplier',
  // crypto
  'coin',
  'holdings',
  'currency',
  'template',
  // shared
  'length',
  'prefix',
  'suffix',
  'timer',
];
// Prefix and suffix keep their whitespace on purpose (" USD", "$ ").
const UNTRIMMED_FIELDS = new Set(['prefix', 'suffix']);

const MIN_REFRESH_SECONDS = { http: 5, crypto: 30 };
const DEFAULT_REFRESH_SECONDS = { http: 5, crypto: 60 };
// After repeated failures the refresh interval doubles, up to this multiple.
const MAX_BACKOFF_MULTIPLIER = 8;
const MAX_BACKOFF_SECONDS = 10 * 60;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const TITLE_SEPARATOR = ' | ';
const PLACEHOLDER_TITLE = 'HTTP Menu';
const PENDING_TITLE = '…';
const ERROR_MARK = '⚠';
const UNAVAILABLE = '–';
const CONFIG_VIEW = path.join(__dirname, 'views/config.html');

if (process.env.NODE_ENV !== 'development') {
  Sentry.init({
    dsn: 'https://cafe8add82bc452cae5a17bcd0939493@error.brth.uk/4',
  });
}

const logFilePath = path.join(app.getPath('userData'), 'http-mac-menu.log');

let tray = null;
let configWindow = null;
let settingsCache = {};
const refreshTimers = {};
const inFlight = new Set();
// configNumber -> { value, error, updatedAt }
const status = {};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const timestamp = () =>
  new Date().toISOString().replace('T', ' ').substring(0, 19);

const truncate = (text, max) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

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

const configKey = (configNumber, field) => `${field}${configNumber}`;

const getConfig = (configNumber) =>
  Object.fromEntries(
    FIELDS.map((field) => [
      field,
      settingsCache[configKey(configNumber, field)] ?? '',
    ])
  );

const isCrypto = (cfg) => cfg.type === 'crypto';

const isConfigured = (configNumber) => {
  const cfg = getConfig(configNumber);
  const source = isCrypto(cfg) ? cfg.coin : cfg.url;
  return Boolean(String(source ?? '').trim());
};

const persistSettings = async (changes) => {
  settingsCache = { ...settingsCache, ...changes };
  await settings.set(settingsCache);
};

const parseRefreshSeconds = (raw, type) => {
  const kind = type === 'crypto' ? 'crypto' : 'http';
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_REFRESH_SECONDS[kind];
  }
  return Math.max(MIN_REFRESH_SECONDS[kind], Math.round(seconds));
};

const validConfigNumber = (value) => {
  const configNumber = Number(value);
  if (!CONFIG_NUMBERS.includes(configNumber)) {
    throw new Error(`Invalid request number: ${value}`);
  }
  return configNumber;
};

const sanitizeConfig = (values) => {
  const clean = {};
  for (const field of FIELDS) {
    const raw = values && values[field] != null ? String(values[field]) : '';
    clean[field] = UNTRIMMED_FIELDS.has(field) ? raw : raw.trim();
  }
  clean.type = clean.type === 'crypto' ? 'crypto' : 'http';
  if (clean.timer) {
    clean.timer = String(parseRefreshSeconds(clean.timer, clean.type));
  }
  return clean;
};

// Older versions stored junk button values and treated the refresh value as
// milliseconds even though the UI asked for seconds. Tidy that up once.
const migrateSettings = async () => {
  const changes = {};
  let dirty = false;

  for (const key of Object.keys(settingsCache)) {
    if (/^(saveConfig|clearConfig)\d+$/.test(key) || key === 'timer') {
      delete settingsCache[key];
      dirty = true;
    }
  }

  for (const configNumber of CONFIG_NUMBERS) {
    const key = configKey(configNumber, 'timer');
    const raw = Number(settingsCache[key]);
    if (Number.isFinite(raw) && raw >= 1000) {
      changes[key] = String(
        Math.max(MIN_REFRESH_SECONDS.http, Math.round(raw / 1000))
      );
      dirty = true;
    }
  }

  if (dirty) {
    await persistSettings(changes);
    log('Migrated settings from a previous version');
  }
};

// ---------------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------------

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseDecimals = (raw) => {
  const decimals = toNumber(raw);
  if (decimals === null) return null;
  return Math.min(20, Math.max(0, Math.round(decimals)));
};

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

const parseHeaders = (raw) => {
  const headers = {};
  String(raw || '')
    .split(/[\n,]/)
    .forEach((part) => {
      const index = part.indexOf(':');
      if (index === -1) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) headers[key] = value;
    });
  return headers;
};

const resolveJsonPath = (data, rawPath) => {
  const tokens = String(rawPath)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((token) => token.trim())
    .filter(Boolean);

  let value = data;
  for (const token of tokens) {
    if (value === null || typeof value !== 'object' || !(token in value)) {
      throw new Error(
        `JSON path "${rawPath}" not found in response (stopped at "${token}")`
      );
    }
    value = value[token];
  }
  return value;
};

const formatHttpValue = (raw, cfg) => {
  const multiplier = toNumber(cfg.multiplier);
  const decimals = parseDecimals(cfg.length);
  const numeric = toNumber(raw);

  let text;
  if (numeric !== null && (multiplier !== null || decimals !== null)) {
    const value = multiplier !== null ? numeric * multiplier : numeric;
    if (multiplier !== null) {
      // A multiplier also switches on locale formatting (12000 -> 12,000).
      const options =
        decimals !== null
          ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
          : {};
      text = value.toLocaleString(undefined, options);
    } else {
      text = value.toFixed(decimals);
    }
  } else {
    text =
      raw !== null && typeof raw === 'object'
        ? JSON.stringify(raw)
        : String(raw);
    // For non-numeric values "decimals" acts as a maximum length.
    if (decimals !== null && decimals > 0) text = text.slice(0, decimals);
  }

  return `${cfg.prefix || ''}${text}${cfg.suffix || ''}`;
};

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
const HISTORY_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const coinIdCache = new Map(); // user input (lowercased) -> CoinGecko id
const priceHistory = {}; // `${id}:${currency}` -> [{ t, p }]

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

const recordSample = (key, price) => {
  const now = Date.now();
  const samples = (priceHistory[key] || []).filter(
    (sample) => now - sample.t <= HISTORY_MAX_AGE_MS
  );
  samples.push({ t: now, p: price });
  priceHistory[key] = samples;
};

// Percentage change versus the newest sample that is at least `minutes` old
// (and no more than twice that), or null if we have not been running long
// enough / refreshing often enough.
const localChange = (key, minutes, price) => {
  const target = Date.now() - minutes * 60000;
  const sample = (priceHistory[key] || [])
    .filter((s) => s.t <= target && s.t >= target - minutes * 60000)
    .pop();
  if (!sample || !sample.p) return null;
  return ((price - sample.p) / sample.p) * 100;
};

const formatMoney = (value, currency, decimals) => {
  const code = String(currency || 'gbp').toUpperCase();
  const abs = Math.abs(value);
  let options;
  if (decimals !== null) {
    options = {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    };
  } else if (abs > 0 && abs < 1) {
    options = { maximumSignificantDigits: 4 };
  } else {
    options = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  }
  try {
    return value.toLocaleString(undefined, {
      style: 'currency',
      currency: code,
      ...options,
    });
  } catch {
    // Not an ISO currency (e.g. "sats", "eth") – fall back to a plain number.
    return `${value.toLocaleString(undefined, options)} ${code}`;
  }
};

const formatPercent = (pct) =>
  Number.isFinite(pct)
    ? `${pct >= 0 ? '▲' : '▼'}${Math.abs(pct).toFixed(2)}%`
    : UNAVAILABLE;

// Money gained/lost over a period, given the percentage move and today's value.
const formatGain = (pct, current, currency, decimals) => {
  if (!Number.isFinite(pct)) return UNAVAILABLE;
  const previous = pct <= -100 ? 0 : current / (1 + pct / 100);
  const delta = current - previous;
  return `${delta >= 0 ? '▲' : '▼'}${formatMoney(Math.abs(delta), currency, decimals)}`;
};

const fetchCryptoValue = async (cfg) => {
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
  recordSample(key, price);

  const values = {
    symbol: String(market.symbol || '').toUpperCase(),
    name: market.name || '',
    price: formatMoney(price, currency, decimals),
    holdings: holdings !== null ? holdings.toLocaleString() : '',
    balance: formatMoney(current, currency, decimals),
  };
  for (const [label, minutes] of Object.entries(LOCAL_PERIODS)) {
    const pct = localChange(key, minutes, price);
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
  const text = template.replace(/\{(\w+)\}/g, (match, name) =>
    name in values ? values[name] : match
  );

  return {
    text: `${cfg.prefix || ''}${text}${cfg.suffix || ''}`,
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

const fetchValue = (cfg) =>
  isCrypto(cfg) ? fetchCryptoValue(cfg) : fetchHttpValue(cfg);

const refreshConfig = async (configNumber) => {
  if (!isConfigured(configNumber)) {
    delete status[configNumber];
    return;
  }
  if (inFlight.has(configNumber)) return;
  inFlight.add(configNumber);

  try {
    const { text, data } = await fetchValue(getConfig(configNumber));
    status[configNumber] = {
      value: text,
      error: null,
      updatedAt: new Date(),
      failures: 0,
    };
    log(
      `Success (Request ${configNumber}): showing "${text}" from ${truncate(JSON.stringify(data), 500)}`
    );
  } catch (err) {
    const message = describeError(err);
    const previous = status[configNumber] || {};
    status[configNumber] = {
      value: previous.value ?? null,
      updatedAt: previous.updatedAt ?? null,
      error: message,
      failures: (previous.failures || 0) + 1,
    };
    log(`Error (Request ${configNumber}): ${message}`);
    // Network and HTTP failures are expected from time to time and are already
    // in the local log; only report genuinely unexpected errors.
    if (!axios.isAxiosError(err)) Sentry.captureException(err);
  } finally {
    inFlight.delete(configNumber);
  }
};

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

const scheduleRefresh = (configNumber) => {
  clearTimeout(refreshTimers[configNumber]);
  delete refreshTimers[configNumber];
  if (!isConfigured(configNumber)) return;

  const cfg = getConfig(configNumber);
  const base = parseRefreshSeconds(cfg.timer, cfg.type);
  // Back off while a request keeps failing so we don't hammer a broken or
  // rate-limited endpoint: base, 2x, 4x, 8x … capped.
  const failures = (status[configNumber] && status[configNumber].failures) || 0;
  const multiplier = Math.min(2 ** failures, MAX_BACKOFF_MULTIPLIER);
  const seconds = Math.min(base * multiplier, MAX_BACKOFF_SECONDS);
  refreshTimers[configNumber] = setTimeout(async () => {
    await refreshConfig(configNumber);
    renderTray();
    scheduleRefresh(configNumber);
  }, seconds * 1000);
};

const startConfig = async (configNumber) => {
  clearTimeout(refreshTimers[configNumber]);
  await refreshConfig(configNumber);
  renderTray();
  scheduleRefresh(configNumber);
};

const refreshAll = async () => {
  await Promise.all(
    CONFIG_NUMBERS.map((configNumber) => startConfig(configNumber))
  );
};

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

const formatTime = (date) =>
  date ? date.toLocaleTimeString(undefined, { hour12: false }) : '';

const trayTitleFor = (configNumber) => {
  const current = status[configNumber];
  if (!current) return PENDING_TITLE;
  if (current.error) {
    return current.value ? `${ERROR_MARK} ${current.value}` : ERROR_MARK;
  }
  return current.value;
};

const tooltipFor = (configNumber) => {
  const current = status[configNumber];
  if (!current) return `Request ${configNumber}: loading…`;
  if (current.error) {
    const last = current.value
      ? ` (showing value from ${formatTime(current.updatedAt)})`
      : '';
    return `Request ${configNumber}: ${current.error}${last}`;
  }
  return `Request ${configNumber}: ${current.value} (updated ${formatTime(current.updatedAt)})`;
};

const menuLabelFor = (configNumber) => {
  if (!isConfigured(configNumber)) return `Request ${configNumber}: not set up`;
  const current = status[configNumber];
  if (!current) return `Request ${configNumber}: loading…`;
  const text = current.error ? `${ERROR_MARK} ${current.error}` : current.value;
  return `Request ${configNumber}: ${truncate(String(text), 60)}`;
};

const buildMenu = () =>
  Menu.buildFromTemplate([
    ...CONFIG_NUMBERS.map((configNumber) => ({
      label: menuLabelFor(configNumber),
      click: () => openConfig(configNumber),
    })),
    { type: 'separator' },
    { label: 'Refresh Now', click: refreshAll },
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

const renderTray = () => {
  if (!tray || tray.isDestroyed()) return;
  const configured = CONFIG_NUMBERS.filter(isConfigured);

  const title = configured.length
    ? configured.map(trayTitleFor).join(TITLE_SEPARATOR)
    : PLACEHOLDER_TITLE;
  const tooltip = configured.length
    ? configured.map(tooltipFor).join('\n')
    : 'No requests set up yet — click to add one';
  const menu = [
    ...CONFIG_NUMBERS.map(menuLabelFor),
    `login:${app.getLoginItemSettings().openAtLogin}`,
  ].join('\n');

  if (title !== lastRendered.title) tray.setTitle(title);
  if (tooltip !== lastRendered.tooltip) tray.setToolTip(tooltip);
  // Replacing the menu closes it if it is open, so only do it when it changed.
  if (menu !== lastRendered.menu) tray.setContextMenu(buildMenu());
  lastRendered = { title, tooltip, menu };
};

const createTray = () => {
  const icon =
    process.platform === 'darwin'
      ? nativeImage.createEmpty()
      : nativeImage.createFromPath(path.join(__dirname, 'assets/trayWin.png'));
  tray = new Tray(icon);
  tray.setTitle('Loading…');
  tray.setToolTip('Loading…');
  tray.setContextMenu(buildMenu());
};

// ---------------------------------------------------------------------------
// Config window
// ---------------------------------------------------------------------------

const openConfig = (configNumber) => {
  const query = { n: String(configNumber) };

  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.loadFile(CONFIG_VIEW, { query });
    configWindow.show();
    configWindow.focus();
    return;
  }

  configWindow = new BrowserWindow({
    width: 560,
    height: 820,
    minWidth: 480,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: `Request ${configNumber} – HTTP Mac Menu`,
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

  configWindow.on('closed', () => {
    configWindow = null;
  });

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

const closeConfigWindow = () => {
  if (configWindow && !configWindow.isDestroyed()) configWindow.close();
};

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

const registerIpc = () => {
  ipcMain.handle('config:load', (_event, configNumber) =>
    getConfig(validConfigNumber(configNumber))
  );

  ipcMain.handle('config:save', async (_event, configNumber, values) => {
    const n = validConfigNumber(configNumber);
    const clean = sanitizeConfig(values);
    const changes = Object.fromEntries(
      FIELDS.map((field) => [configKey(n, field), clean[field]])
    );
    await persistSettings(changes);
    delete status[n];
    log(`Saved Request ${n}`);
    closeConfigWindow();
    renderTray();
    await startConfig(n);
    return { ok: true };
  });

  ipcMain.handle('config:clear', async (_event, configNumber) => {
    const n = validConfigNumber(configNumber);
    const changes = Object.fromEntries(
      FIELDS.map((field) => [configKey(n, field), ''])
    );
    await persistSettings(changes);
    clearTimeout(refreshTimers[n]);
    delete refreshTimers[n];
    delete status[n];
    log(`Cleared Request ${n}`);
    closeConfigWindow();
    renderTray();
    return { ok: true };
  });

  ipcMain.handle('config:test', async (_event, values) => {
    try {
      const { text } = await fetchValue(sanitizeConfig(values));
      return { ok: true, value: text };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  });

  ipcMain.handle('config:close', () => closeConfigWindow());
};

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const init = async () => {
  settingsCache = (await settings.get()) || {};
  await migrateSettings();
  log(`Started HTTP Mac Menu ${app.getVersion()}`);

  app.setAppUserModelId('HTTP Mac Menu');
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  registerIpc();
  createTray();
  renderTray();

  if (!CONFIG_NUMBERS.some(isConfigured)) openConfig(1);

  await refreshAll();
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openConfig(1));
  // This is a tray app: closing the settings window must not quit it.
  app.on('window-all-closed', () => {});
  app.whenReady().then(init);
}
