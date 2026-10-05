// Small, dependency-free UI contracts shared by every view and the Node test
// suite. Keep these helpers free of DOM state so validation, wording and
// provider policy cannot drift between the views that show them.
(() => {
  const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

  const errorText = (error, fallback) => {
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    return fallback;
  };

  const isFiniteNumberText = (value) => {
    const text = String(value ?? '').trim();
    return DECIMAL_NUMBER.test(text) && Number.isFinite(Number(text));
  };

  const isValidJavaScriptRegex = (value) => {
    try {
      new RegExp(String(value ?? ''));
      return true;
    } catch {
      return false;
    }
  };

  const notificationPrimaryAction = (state) => {
    if (state === 'denied') return 'settings';
    if (state === 'error') return 'retry';
    return 'enable';
  };

  const kindOf = (value) => {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
  };

  // Include containers: today's null may become tomorrow's object. Use JSON
  // Pointer when a key cannot be represented faithfully by a dotted path.
  // `depth`, `key` and `kind` let the picker draw the response as a tree.
  const responseFields = (data) => {
    const fields = [];
    const visit = (value, parts, dotted) => {
      if (fields.length >= 250) return;
      if (parts.length) {
        const path =
          dotted ??
          `/${parts.map((key) => String(key).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
        const summary = Array.isArray(value)
          ? `[${value.length} items]`
          : value !== null && typeof value === 'object'
            ? '{…}'
            : JSON.stringify(value);
        fields.push({
          path,
          summary: summary.length > 80 ? `${summary.slice(0, 80)}…` : summary,
          key: String(parts[parts.length - 1]),
          depth: parts.length - 1,
          kind: kindOf(value),
        });
      }
      if (value !== null && typeof value === 'object') {
        for (const key of Object.keys(value)) {
          if (fields.length >= 250) break;
          const next =
            dotted !== null &&
            (Array.isArray(value) || /^[a-z_$][\w$-]*$/i.test(key))
              ? Array.isArray(value)
                ? `${dotted}[${key}]`
                : `${dotted ? `${dotted}.` : ''}${key}`
              : null;
          visit(value[key], [...parts, key], next);
        }
      }
    };
    visit(data, [], '');
    return fields;
  };

  // -------------------------------------------------------------------------
  // Crypto provider policy. Mirrors engine::crypto_route: this is schedule
  // policy, not a claim that a temporary provider fallback can never occur.
  // -------------------------------------------------------------------------

  const SOLANA_TICKERS = ['sol', 'solana', 'wsol', 'jup', 'jupiter', 'usdc'];

  const looksLikeSolanaMint = (value) =>
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value ?? '').trim());

  const canJupiterConvertCurrency = (value) =>
    /^[a-z]{3}$/i.test(String(value ?? '').trim() || 'gbp');

  const automaticUsesJupiter = (values = {}) => {
    const coin = String(values.coin ?? '').trim();
    return (
      canJupiterConvertCurrency(values.currency) &&
      (SOLANA_TICKERS.includes(coin.toLowerCase()) || looksLikeSolanaMint(coin))
    );
  };

  const cryptoProvider = (values = {}) =>
    ['jupiter', 'dexscreener', 'coingecko'].includes(values.provider)
      ? values.provider
      : 'auto';

  const refreshPolicyProvider = (values = {}) => {
    const provider = cryptoProvider(values);
    if (provider !== 'auto') return provider;
    return automaticUsesJupiter(values) ? 'jupiter' : 'coingecko';
  };

  // Matches the provider-aware limits in src-tauri/src/engine/constants.rs.
  const DEFAULT_TIMER = {
    http: 5,
    jupiter: 5,
    dexscreener: 30,
    coingecko: 60,
  };
  const MAX_TIMER = 24 * 60 * 60;

  const isCrypto = (values = {}) => values.type === 'crypto';

  const timerMinimum = (values = {}) => {
    if (!isCrypto(values)) return 5;
    const provider = refreshPolicyProvider(values);
    return provider === 'coingecko' || provider === 'dexscreener' ? 30 : 5;
  };

  const timerDefault = (values = {}) =>
    isCrypto(values)
      ? DEFAULT_TIMER[refreshPolicyProvider(values)] || DEFAULT_TIMER.coingecko
      : DEFAULT_TIMER.http;

  // The interval a request will actually run at, as the engine clamps it.
  const effectiveTimer = (values = {}) => {
    const text = String(values.timer ?? '').trim();
    if (!/^\d+$/.test(text)) return timerDefault(values);
    return Math.min(MAX_TIMER, Math.max(timerMinimum(values), Number(text)));
  };

  // -------------------------------------------------------------------------
  // Plain-language summaries. Every step of the builder and every row of a
  // value's setup reads its current state through these.
  // -------------------------------------------------------------------------

  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  const describeDuration = (seconds) => {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (total < 60) return plural(total, 'second');
    if (total < 3600) {
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      return rest
        ? `${plural(minutes, 'minute')} ${rest}s`
        : plural(minutes, 'minute');
    }
    const hours = Math.floor(total / 3600);
    const minutes = Math.round((total % 3600) / 60);
    return minutes
      ? `${plural(hours, 'hour')} ${minutes}m`
      : plural(hours, 'hour');
  };

  // "every minute", not "every 1 minute".
  const everyPhrase = (seconds) => {
    const text = describeDuration(seconds);
    return text.startsWith('1 ') && !/\d[sm]$/.test(text)
      ? `every ${text.slice(2)}`
      : `every ${text}`;
  };

  const describeInterval = (seconds) => {
    const phrase = everyPhrase(seconds);
    return `E${phrase.slice(1)}`;
  };

  const fetchesPerDay = (seconds) => {
    const interval = Math.max(1, Number(seconds) || 1);
    return Math.round(86400 / interval);
  };

  const PROVIDER_NAMES = {
    auto: 'Automatic',
    jupiter: 'Jupiter',
    dexscreener: 'DEX Screener',
    coingecko: 'CoinGecko',
  };

  const shortUrl = (url) => {
    const text = String(url ?? '').trim();
    try {
      const parsed = new URL(text);
      const path = parsed.pathname === '/' ? '' : parsed.pathname;
      return `${parsed.host}${path}${parsed.search ? '?…' : ''}`;
    } catch {
      return text;
    }
  };

  const describeSource = (values = {}) => {
    if (isCrypto(values)) {
      const coin = String(values.coin ?? '').trim();
      if (!coin) return 'Choose a coin';
      const name = looksLikeSolanaMint(coin)
        ? `${coin.slice(0, 4)}…${coin.slice(-4)}`
        : coin.toUpperCase();
      const currency = (
        String(values.currency ?? '').trim() || 'gbp'
      ).toUpperCase();
      const holdings = String(values.holdings ?? '').trim();
      return `${holdings ? `${holdings} ` : ''}${name} in ${currency}`;
    }
    const url = String(values.url ?? '').trim();
    return url ? shortUrl(url) : 'Add a URL';
  };

  const describeProvider = (values = {}) => {
    const provider = cryptoProvider(values);
    if (provider !== 'auto') return PROVIDER_NAMES[provider];
    return `Automatic · ${PROVIDER_NAMES[refreshPolicyProvider(values)]}`;
  };

  const describeField = (values = {}) => {
    const path = String(values.json ?? '').trim();
    return path || 'The whole response';
  };

  // What the HTTP display text does, so common shapes can be offered as
  // choices rather than typed as template syntax.
  const displayMode = (template) => {
    const text = String(template ?? '').trim();
    if (!text || text === '{value}') return 'plain';
    const match = text.match(/^\{value\|(datetime|date|time|relative)\}$/);
    return match ? match[1] : 'custom';
  };

  const DISPLAY_MODE_NAMES = {
    plain: 'As it comes',
    datetime: 'Date and time',
    date: 'Date',
    time: 'Time',
    relative: 'Time until or since',
  };

  const describeDisplay = (values = {}) => {
    const parts = [];
    if (isCrypto(values)) {
      const template = String(values.template ?? '').trim();
      parts.push(
        template ||
          (String(values.holdings ?? '').trim()
            ? '{symbol} {balance} {change24h}'
            : '{symbol} {price} {change24h}')
      );
    } else {
      const mode = displayMode(values.http_template);
      parts.push(
        mode === 'custom'
          ? String(values.http_template).trim()
          : DISPLAY_MODE_NAMES[mode]
      );
      const rules = Array.isArray(values.display_rules)
        ? values.display_rules.length
        : 0;
      if (rules) parts.push(plural(rules, 'condition'));
    }
    const prefix = String(values.prefix ?? '');
    const suffix = String(values.suffix ?? '');
    if (prefix || suffix) {
      parts.push(`wrapped as ${prefix}…${suffix}`);
    }
    return parts.join(' · ');
  };

  const ALERT_KINDS = [
    ['above', 'goes above'],
    ['below', 'goes below'],
    ['pct_up', 'gains at least'],
    ['pct_down', 'drops at least'],
    ['contains', 'contains'],
    ['regex', 'matches regex'],
  ];
  const NUMERIC_ALERT_KINDS = ['above', 'below', 'pct_up', 'pct_down'];
  const PERCENT_ALERT_KINDS = ['pct_up', 'pct_down'];

  const describeCooldown = (seconds) => {
    const total = Number(seconds) || 0;
    return total > 0 ? `at most ${everyPhrase(total)}` : 'every time';
  };

  const describeAlert = (rule = {}, values = {}) => {
    const subject = isCrypto(values) ? 'Price' : 'Value';
    const phrase =
      ALERT_KINDS.find(([kind]) => kind === rule.kind)?.[1] ?? 'goes above';
    const amount = String(rule.value ?? '').trim() || '…';
    const unit = PERCENT_ALERT_KINDS.includes(rule.kind) ? '%' : '';
    return `${subject} ${phrase} ${amount}${unit}, ${describeCooldown(rule.cooldown_secs)}`;
  };

  const describeAlerts = (values = {}) => {
    const alerts = Array.isArray(values.alerts) ? values.alerts : [];
    if (!alerts.length) return 'None';
    if (alerts.length === 1) return describeAlert(alerts[0], values);
    return plural(alerts.length, 'alert');
  };

  const CONDITION_KINDS = [
    ['empty', 'is null or missing'],
    ['present', 'has a value'],
    ['equals', 'equals'],
    ['not_equals', 'does not equal'],
    ['contains', 'contains'],
    ['above', 'is above'],
    ['below', 'is below'],
    ['before_now', 'is before now'],
    ['after_now', 'is after now'],
  ];
  const VALUELESS_CONDITION_KINDS = [
    'empty',
    'present',
    'before_now',
    'after_now',
  ];
  const NUMERIC_CONDITION_KINDS = ['above', 'below'];

  // -------------------------------------------------------------------------
  // The menu bar title, drawn the way the tray draws it (see tray_title_for
  // and the title limits in engine::constants).
  // -------------------------------------------------------------------------

  const TITLE_SEPARATOR = ' | ';
  const MAX_ITEM_TITLE_CHARS = 40;

  const truncate = (text, limit) => {
    const characters = Array.from(String(text ?? ''));
    return characters.length > limit
      ? `${characters.slice(0, limit - 1).join('')}…`
      : characters.join('');
  };

  const titleItem = (item = {}) => {
    const value =
      item.value === null || item.value === undefined || item.value === ''
        ? null
        : truncate(item.value, MAX_ITEM_TITLE_CHARS);
    if (item.error) return value ? `⚠ ${value}` : '⚠';
    return value ?? '…';
  };

  // What someone pasted to start a value: a cURL command, a URL, or neither.
  const classifySource = (text) => {
    const source = String(text ?? '').trim();
    if (!source) return { kind: 'empty' };
    if (/^curl(\s|$)/i.test(source)) return { kind: 'curl', text: source };
    if (/\s/.test(source)) return { kind: 'invalid' };
    // A typed scheme is taken at its word, so LAN names such as
    // http://printer/status work. Without one, only something shaped like a
    // host is completed to https://.
    const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(source);
    const candidate = hasScheme ? source : `https://${source}`;
    try {
      const parsed = new URL(candidate);
      const web = parsed.protocol === 'http:' || parsed.protocol === 'https:';
      const hostLike =
        parsed.hostname.includes('.') || parsed.hostname === 'localhost';
      if (web && parsed.hostname && (hasScheme || hostLike)) {
        return { kind: 'url', url: candidate };
      }
    } catch {
      /* fall through */
    }
    return { kind: 'invalid' };
  };

  // -------------------------------------------------------------------------
  // Routes. The native side opens `#/new` and `#/v/<id>` from the tray menu;
  // keep these in step with config_page in src-tauri/src/lib.rs.
  // -------------------------------------------------------------------------

  const parseRoute = (hash) => {
    let parts;
    try {
      parts = String(hash || '')
        .replace(/^#\/?/, '')
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent);
    } catch {
      return { name: 'home' };
    }
    if (parts[0] === 'new') return { name: 'add' };
    if (parts[0] === 'build') {
      return { name: 'builder', id: 'new', step: parts[1] || null };
    }
    if (parts[0] === 'settings') return { name: 'settings' };
    if (parts[0] === 'v' && parts[1]) {
      return parts[2] === 'edit'
        ? { name: 'builder', id: parts[1], step: parts[3] || null }
        : { name: 'value', id: parts[1] };
    }
    return { name: 'home' };
  };

  const routes = Object.freeze({
    home: () => '#/',
    add: () => '#/new',
    build: () => '#/build',
    settings: () => '#/settings',
    value: (id) => `#/v/${encodeURIComponent(id)}`,
    edit: (id, step) =>
      `#/v/${encodeURIComponent(id)}/edit${step ? `/${encodeURIComponent(step)}` : ''}`,
  });

  const api = Object.freeze({
    parseRoute,
    routes,
    errorText,
    isFiniteNumberText,
    isValidJavaScriptRegex,
    notificationPrimaryAction,
    responseFields,
    looksLikeSolanaMint,
    canJupiterConvertCurrency,
    automaticUsesJupiter,
    cryptoProvider,
    refreshPolicyProvider,
    timerMinimum,
    timerDefault,
    effectiveTimer,
    plural,
    describeDuration,
    describeInterval,
    fetchesPerDay,
    shortUrl,
    describeSource,
    describeProvider,
    describeField,
    displayMode,
    describeDisplay,
    describeCooldown,
    describeAlert,
    describeAlerts,
    titleItem,
    truncate,
    classifySource,
    ALERT_KINDS,
    NUMERIC_ALERT_KINDS,
    PERCENT_ALERT_KINDS,
    CONDITION_KINDS,
    VALUELESS_CONDITION_KINDS,
    NUMERIC_CONDITION_KINDS,
    PROVIDER_NAMES,
    DISPLAY_MODE_NAMES,
    TITLE_SEPARATOR,
    MAX_TIMER,
  });

  if (typeof window !== 'undefined') window.httpWidgetsUi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
