// A stand-in for the Rust backend so the app can be opened in a browser:
// tests/ui-preview.html loads this before ui/api.js. It keeps state, so the
// whole flow (add, build, save, edit, remove) can be clicked through.
//
//   ?platform=macos|ios|android|windows|linux   which shell to draw
//   ?empty=1                                     start with no values
//   ?notifications=prompt|denied|granted         notification permission
//   ?discard=no                                  answer "Keep Editing"
(() => {
  const params = new URLSearchParams(window.location.search);
  const platform = params.get('platform') || 'macos';
  const mobile = platform === 'ios' || platform === 'android';
  const now = Date.now();
  const MAX = 10;

  const presets = [
    {
      id: 'weather-london',
      label: 'Weather · London',
      description: 'Current temperature in central London from Open-Meteo.',
      kind: 'http',
      values: {
        type: 'http',
        url: 'https://api.open-meteo.com/v1/forecast?latitude=51.51&longitude=-0.13&current=temperature_2m,weather_code',
        json: 'current.temperature_2m',
        suffix: '°C',
        timer: '900',
      },
    },
    {
      id: 'github-stars',
      label: 'GitHub stars · Tauri',
      description:
        'Star count for the public tauri-apps/tauri repository on GitHub.',
      kind: 'http',
      values: {
        type: 'http',
        url: 'https://api.github.com/repos/tauri-apps/tauri',
        json: 'stargazers_count',
        timer: '600',
      },
    },
    {
      id: 'solana-live-usd',
      label: 'Solana price · live USD',
      description:
        'Fresh SOL price from Jupiter with automatic no-key fallbacks.',
      kind: 'crypto',
      values: {
        type: 'crypto',
        provider: 'auto',
        coin: 'sol',
        currency: 'usd',
        template: '{symbol} {price} {change24h}',
        timer: '5',
      },
    },
    {
      id: 'bitcoin-usd',
      label: 'Bitcoin price · USD',
      description:
        'Current Bitcoin price in US dollars with its 24-hour change.',
      kind: 'crypto',
      values: {
        type: 'crypto',
        provider: 'coingecko',
        coin: 'btc',
        currency: 'usd',
        template: '{symbol} {price} {change24h}',
        timer: '60',
      },
    },
    {
      id: 'ethereum-holdings-gbp',
      label: 'Ethereum value · 1 ETH (GBP)',
      description:
        'Current GBP value of exactly 1 ETH; change Holdings to match your amount.',
      kind: 'crypto',
      values: {
        type: 'crypto',
        provider: 'coingecko',
        coin: 'eth',
        holdings: '1',
        currency: 'gbp',
        timer: '60',
      },
    },
  ];

  const sampleResponse = {
    latitude: 51.5,
    longitude: -0.12,
    current_units: { temperature_2m: '°C', weather_code: 'wmo code' },
    current: {
      time: new Date(now).toISOString(),
      interval: 900,
      temperature_2m: 14.2,
      weather_code: 3,
    },
    data: {
      status: 'ok',
      scheduled_reset: {
        scheduled_for: new Date(now + 9_000_000).toISOString(),
        confirmed: false,
      },
      pending: null,
    },
    stargazers_count: 98412,
    items: [
      { name: 'alpha', value: 1 },
      { name: 'beta', value: 2 },
    ],
  };

  const series = (base, swing, drift) =>
    Array.from({ length: 96 }, (_, index) => ({
      timestamp: now - (95 - index) * 15 * 60 * 1000,
      value:
        base +
        Math.sin(index / 7) * swing +
        Math.cos(index / 2.3) * swing * 0.25 +
        index * drift,
    }));

  const blank = () => ({
    type: 'http',
    label: '',
    url: '',
    headers: '',
    json: '',
    http_template: '',
    empty_text: '',
    display_rules: [],
    multiplier: '',
    provider: 'auto',
    coin: '',
    holdings: '',
    currency: '',
    template: '',
    length: '',
    prefix: '',
    suffix: '',
    timer: '',
    alerts: [],
  });

  // Each stored value is its settings plus the status the engine would hold.
  let stored = params.has('empty')
    ? []
    : [
        {
          id: 'r1',
          values: {
            ...blank(),
            type: 'crypto',
            label: 'Bitcoin',
            provider: 'coingecko',
            coin: 'btc',
            currency: 'usd',
            template: '{symbol} {price} {change24h}',
            timer: '60',
            alerts: [
              { id: 'a1', kind: 'below', value: '60000', cooldown_secs: 3600 },
            ],
          },
          value: 'BTC $64,286 ▴2.1%',
          error: null,
          failures: 0,
          updatedAt: now - 22_000,
          points: series(63100, 1300, 12),
        },
        {
          id: 'r2',
          values: {
            ...blank(),
            label: 'Office temperature',
            url: 'https://sensors.example.com/api/office?unit=c',
            json: 'current.temperature_2m',
            suffix: '°C',
            timer: '300',
          },
          value: '21.4°C',
          error: null,
          failures: 0,
          updatedAt: now - 90_000,
          points: series(20.4, 1.2, 0.004),
        },
        {
          id: 'r3',
          values: {
            ...blank(),
            label: 'Codex reset',
            url: 'https://codex-resets.com/api/v1/status',
            json: 'data.scheduled_reset.scheduled_for',
            empty_text: 'No reset scheduled',
            timer: '60',
            display_rules: [
              {
                path: 'data.scheduled_reset.scheduled_for',
                kind: 'before_now',
                value: '',
                template: 'Scheduled {value|relative}; awaiting confirmation',
              },
              {
                path: 'data.scheduled_reset.scheduled_for',
                kind: 'present',
                value: '',
                template: 'Reset {value|relative}',
              },
            ],
          },
          value: 'Reset in 2h 30m',
          error: null,
          failures: 0,
          updatedAt: now - 41_000,
          points: [],
        },
        {
          id: 'r4',
          values: {
            ...blank(),
            label: 'Deploy queue',
            url: 'https://ci.example.com/api/queue',
            json: 'queue.length',
            timer: '30',
          },
          value: '3',
          error: 'HTTP 503 Service Unavailable',
          failures: 4,
          updatedAt: now - 1_500_000,
          points: series(4, 2, -0.01),
        },
      ];

  let paused = false;
  let notificationState = params.get('notifications') || 'prompt';
  const preferences = {
    indicator: 'chevron',
    trayLink: null,
    launchAtLogin: false,
    showInDock: false,
  };

  const resolve = (data, path) => {
    const text = String(path || '').trim();
    if (!text) return data;
    const parts = text
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .filter(Boolean);
    let value = data;
    for (const part of parts) {
      if (value === null || typeof value !== 'object' || !(part in value)) {
        return undefined;
      }
      value = value[part];
    }
    return value;
  };

  const relative = (iso) => {
    const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    const minutes = Math.floor(Math.abs(seconds) / 60);
    const duration =
      minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${minutes}m`;
    return seconds > 0 ? `in ${duration}` : `${duration} ago`;
  };

  const asText = (value) =>
    typeof value === 'string' ? value : JSON.stringify(value);

  // A rough copy of engine::format, enough to make the preview behave.
  const formatHttp = (values, data) => {
    const number = (value) => {
      const numeric = Number(value);
      if (typeof value === 'boolean' || !Number.isFinite(numeric)) {
        return asText(value);
      }
      const scaled = numeric * (Number(values.multiplier) || 1);
      return values.length !== '' && Number.isFinite(Number(values.length))
        ? scaled.toFixed(Number(values.length))
        : String(scaled);
    };
    const render = (template) =>
      template.replace(/\{([^}]*)\}/g, (_, token) => {
        const [path, format] = token.split('|').map((part) => part.trim());
        const value = resolve(data, path === 'value' ? values.json : path);
        if (value === undefined || value === null) {
          throw new Error(
            `Display field "${path}" is null. Add a null condition or fallback text.`
          );
        }
        if (format) {
          if (
            Number.isNaN(new Date(value).getTime()) ||
            typeof value !== 'string'
          ) {
            throw new Error(
              'Date formatting needs an ISO 8601 timestamp, such as 2026-10-05T12:00:00Z.'
            );
          }
          if (format === 'relative') return relative(value);
          const date = new Date(value);
          if (format === 'time') {
            return date.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            });
          }
          return format === 'date'
            ? date.toLocaleDateString()
            : date.toLocaleString([], {
                dateStyle: 'medium',
                timeStyle: 'short',
              });
        }
        return path === 'value' ? number(value) : asText(value);
      });

    const selected = resolve(data, values.json);
    const matches = (rule) => {
      const value = resolve(data, rule.path);
      const present = value !== undefined && value !== null;
      switch (rule.kind) {
        case 'empty':
          return !present;
        case 'present':
          return present;
        case 'equals':
          return present && asText(value) === rule.value;
        case 'not_equals':
          return present && asText(value) !== rule.value;
        case 'contains':
          return typeof value === 'string' && value.includes(rule.value);
        case 'above':
          return present && Number(value) > Number(rule.value);
        case 'below':
          return present && Number(value) < Number(rule.value);
        case 'before_now':
          return present && new Date(value).getTime() < Date.now();
        case 'after_now':
          return present && new Date(value).getTime() > Date.now();
        default:
          return false;
      }
    };

    const rule = (values.display_rules || []).find(matches);
    let text;
    if (rule) text = render(rule.template);
    else if (
      (selected === undefined || selected === null) &&
      values.empty_text
    ) {
      text = render(values.empty_text);
    } else if (values.http_template) text = render(values.http_template);
    else if (selected === undefined) {
      throw new Error(`Nothing found at "${values.json}" in the response.`);
    } else if (selected === null) {
      throw new Error(
        'Response value is null. Set text for null or missing values.'
      );
    } else text = number(selected);
    return `${values.prefix || ''}${text}${values.suffix || ''}`;
  };

  const COINS = {
    btc: ['BTC', 64286.4],
    eth: ['ETH', 2512.18],
    sol: ['SOL', 142.07],
  };

  const formatCrypto = (values) => {
    const coin = String(values.coin || '')
      .trim()
      .toLowerCase();
    const [symbol, price] = COINS[coin] || [
      coin.slice(0, 5).toUpperCase(),
      1.2345,
    ];
    const currency = (values.currency || 'gbp').toUpperCase();
    const money = (amount) => {
      try {
        return new Intl.NumberFormat('en-GB', {
          style: 'currency',
          currency,
          maximumFractionDigits:
            values.length !== '' ? Number(values.length) || 0 : 2,
          minimumFractionDigits:
            values.length !== '' ? Number(values.length) || 0 : 2,
        }).format(amount);
      } catch {
        return `${amount.toFixed(2)} ${currency}`;
      }
    };
    const holdings = Number(values.holdings) || 0;
    const balance = holdings ? holdings * price : price;
    const template =
      String(values.template || '').trim() ||
      (holdings
        ? '{symbol} {balance} {change24h}'
        : '{symbol} {price} {change24h}');
    const facts = {
      symbol,
      name: symbol,
      price: money(price),
      balance: money(balance),
      holdings: String(values.holdings || ''),
      change24h: '▴2.1%',
      gain24h: `▴${money(balance * 0.021)}`,
      source:
        values.provider === 'auto' || !values.provider
          ? 'Jupiter'
          : values.provider,
    };
    const text = template.replace(/\{(\w+)\}/g, (match, key) =>
      key in facts ? facts[key] : /^change|^gain/.test(key) ? '–' : match
    );
    return `${values.prefix || ''}${text}${values.suffix || ''}`;
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const configured = (values) =>
    Boolean(
      String(values.type === 'crypto' ? values.coin : values.url || '').trim()
    );

  const notification = () => ({
    state: notificationState,
    message:
      notificationState === 'granted'
        ? 'Notifications ready.'
        : notificationState === 'denied'
          ? 'Notifications are off. Open Settings to receive alerts.'
          : 'Enable notifications to receive alerts.',
  });

  const handlers = {
    app_info: () => ({
      version: '2.0.2',
      mobile,
      platform,
      backgroundRefresh: null,
    }),
    accent_color: () => null,
    list_requests: () => ({
      paused,
      max: MAX,
      requests: stored.map((item, index) => ({
        id: item.id,
        name: item.values.label.trim() || `Value ${index + 1}`,
        ready: configured(item.values),
        value: item.value,
        error: item.error,
        failures: item.failures,
        attemptedAt: item.updatedAt,
        updatedAt: item.updatedAt,
        alerts: item.values.alerts.length,
        points: item.points,
      })),
    }),
    list_presets: () => presets,
    load_config: ({ id }) => {
      const index = stored.findIndex((item) => item.id === id);
      return index === -1
        ? {
            id: 'new',
            isNew: true,
            position: stored.length + 1,
            values: blank(),
          }
        : {
            id,
            isNew: false,
            position: index + 1,
            values: structuredClone(stored[index].values),
          };
    },
    save_config: async ({ id, values }) => {
      await wait(250);
      const clean = { ...blank(), ...structuredClone(values) };
      let value;
      try {
        value =
          clean.type === 'crypto'
            ? formatCrypto(clean)
            : formatHttp(clean, sampleResponse);
      } catch {
        value = null;
      }
      const existing = stored.find((item) => item.id === id);
      if (existing) {
        Object.assign(existing, {
          values: clean,
          value,
          updatedAt: Date.now(),
        });
        return { ok: true, id };
      }
      if (stored.length >= MAX) {
        return { ok: false, error: `You can have at most ${MAX}.` };
      }
      let next = 1;
      while (stored.some((item) => item.id === `r${next}`)) next++;
      stored.push({
        id: `r${next}`,
        values: clean,
        value,
        error: null,
        failures: 0,
        updatedAt: Date.now(),
        points: [],
      });
      return { ok: true, id: `r${next}` };
    },
    remove_config: ({ id }) => {
      stored = stored.filter((item) => item.id !== id);
      return { ok: true };
    },
    test_config: async ({ values, response }) => {
      if (values.type === 'crypto') {
        await wait(450);
        if (String(values.coin).trim().toLowerCase() === 'nope') {
          return { ok: false, error: 'No coin matches "nope".' };
        }
        return { ok: true, value: formatCrypto(values) };
      }
      let data = sampleResponse;
      if (response) data = JSON.parse(response);
      else {
        await wait(600);
        if (/fail|503/.test(values.url)) {
          return { ok: false, error: 'HTTP 503 Service Unavailable' };
        }
        if (/plain/.test(values.url)) data = 'All systems ready';
      }
      try {
        return {
          ok: true,
          value: formatHttp(values, data),
          response: JSON.stringify(data),
        };
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          response: JSON.stringify(data),
        };
      }
    },
    import_curl: ({ text }) => {
      const url = (text.match(/https?:\/\/[^\s'"]+/) || [''])[0];
      const headers = [...text.matchAll(/-H\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1])
        .join('\n');
      return {
        url,
        headers,
        warnings: /-d\s|--data/.test(text)
          ? ['The request body was ignored; only GET requests are supported.']
          : [],
      };
    },
    set_dirty: () => null,
    close_config: () => {
      console.info('[mock] the window would be put away');
      return null;
    },
    refresh_all: async () => {
      await wait(500);
      for (const item of stored) {
        if (!item.error) item.updatedAt = Date.now();
      }
      return { ok: true, changed: true };
    },
    refresh_request_now: async ({ id }) => {
      await wait(500);
      const item = stored.find((entry) => entry.id === id);
      if (item)
        Object.assign(item, {
          error: null,
          failures: 0,
          updatedAt: Date.now(),
        });
      return { ok: true, changed: true };
    },
    set_updates_paused: ({ paused: next }) => {
      paused = next;
      return { ok: true, paused, changed: true };
    },
    copy_request_value: () => ({ ok: true, count: 1 }),
    copy_all_values: () => ({ ok: true, count: stored.length }),
    notification_status: notification,
    enable_notifications: () => {
      notificationState = 'granted';
      return notification();
    },
    send_test_notification: () => ({
      ok: true,
      state: notificationState,
      message: 'Test notification sent.',
    }),
    open_notification_settings: () => null,
    open_project_link: () => null,
    close_about: () => null,
    get_preferences: () => ({
      ...preferences,
      launchAtLogin: mobile ? null : preferences.launchAtLogin,
      showInDock: platform === 'macos' ? preferences.showInDock : null,
      indicatorStyles: [
        { id: 'chevron', label: 'Chevron', rise: '⌃', fall: '⌄' },
        { id: 'arrow', label: 'Arrow', rise: '↑', fall: '↓' },
        { id: 'triangle', label: 'Triangle', rise: '▲', fall: '▼' },
        { id: 'text', label: 'Text', rise: '▴', fall: '▾' },
      ],
    }),
    set_tray_link: ({ link }) => {
      const trimmed = link.trim();
      if (trimmed && !/^https?:\/\//.test(trimmed)) {
        throw new Error('The link must start with http:// or https://');
      }
      preferences.trayLink = trimmed || null;
      return preferences.trayLink;
    },
    set_indicator_style: ({ style }) => {
      preferences.indicator = style;
      return style;
    },
    set_launch_at_login: ({ enabled }) => {
      preferences.launchAtLogin = enabled;
      return enabled;
    },
    set_show_in_dock: ({ enabled }) => {
      preferences.showInDock = enabled;
      return enabled;
    },
    confirm_remove: () => true,
    confirm_discard: () => params.get('discard') !== 'no',
    read_log: () =>
      [
        '11:04:52 Bitcoin: BTC $64,286 ▴2.1%',
        '11:05:10 Office temperature: 21.4°C',
        '11:05:22 Deploy queue failed: HTTP 503 Service Unavailable',
        '11:05:52 Bitcoin: BTC $64,301 ▴2.1%',
      ].join('\n'),
    ui_log: () => null,
  };

  window.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        if (!(command in handlers)) {
          throw new Error(`No preview handler for ${command}`);
        }
        return handlers[command](args || {});
      },
    },
  };
})();
