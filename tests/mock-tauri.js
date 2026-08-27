(() => {
  const now = Date.now();
  const presets = [
    {
      id: 'weather-london',
      label: 'Weather · London',
      description: 'Current temperature in central London from Open-Meteo.',
      kind: 'http',
      values: { type: 'http' },
    },
    {
      id: 'github-stars',
      label: 'GitHub stars · Tauri',
      description: 'Star count for the public tauri-apps/tauri repository.',
      kind: 'http',
      values: { type: 'http' },
    },
    {
      id: 'solana-live-usd',
      label: 'Solana price · live USD',
      description: 'Fresh SOL price from Jupiter with automatic fallbacks.',
      kind: 'crypto',
      values: {
        type: 'crypto',
        provider: 'auto',
        coin: 'sol',
        currency: 'usd',
        timer: '5',
      },
    },
    {
      id: 'bitcoin-usd',
      label: 'Bitcoin price · USD',
      description: 'Current Bitcoin price with its 24-hour change.',
      kind: 'crypto',
      values: { type: 'crypto' },
    },
    {
      id: 'ethereum-holdings-gbp',
      label: 'Ethereum value · 1 ETH',
      description: 'Current GBP value of exactly one Ether.',
      kind: 'crypto',
      values: { type: 'crypto' },
    },
  ];
  const points = Array.from({ length: 24 }, (_, index) => ({
    timestamp: now - (23 - index) * 60 * 60 * 1000,
    value: 63100 + Math.sin(index / 2.4) * 1300 + index * 54,
  }));
  const requestState = {
    paused: false,
    max: 10,
    requests: [
      {
        id: 'bitcoin',
        name: 'Bitcoin',
        ready: true,
        value: '$64,286 · +2.1%',
        error: null,
        failures: 0,
        attemptedAt: now - 22_000,
        updatedAt: now - 22_000,
        points,
      },
      {
        id: 'temperature',
        name: 'Office temperature',
        ready: true,
        value: '21.4°C',
        error: null,
        failures: 0,
        attemptedAt: now - 90_000,
        updatedAt: now - 90_000,
        points: points.map((point, index) => ({
          timestamp: point.timestamp,
          value: 20.4 + Math.sin(index / 4) * 1.2,
        })),
      },
    ],
  };

  const newConfig = {
    id: 'new',
    isNew: true,
    position: 3,
    values: {
      type: 'http',
      label: '',
      url: '',
      headers: '',
      json: '',
      multiplier: '',
      provider: 'auto',
      decimals: '',
      prefix: '',
      suffix: '',
      coin: '',
      holdings: '',
      currency: 'gbp',
      template: '',
      timer: '60',
      alerts: [],
    },
  };

  const handlers = {
    app_info: () => ({ version: '2.0.0', mobile: true, platform: 'ios' }),
    accent_color: () => null,
    list_requests: () => requestState,
    list_presets: () => presets,
    notification_status: () => ({
      state: 'granted',
      message: 'Notifications ready.',
    }),
    enable_notifications: () => ({
      state: 'granted',
      message: 'Notifications ready.',
    }),
    send_test_notification: () => ({
      ok: true,
      state: 'granted',
      message: 'Test notification sent.',
    }),
    open_notification_settings: () => ({ ok: true }),
    load_config: () => structuredClone(newConfig),
    save_config: () => ({ ok: true }),
    remove_config: () => ({ ok: true }),
    test_config: () => ({ ok: true, value: '21.4°C' }),
    import_curl: () => ({ url: '', headers: '', warnings: [] }),
    set_dirty: () => null,
    close_config: () => null,
    fit_window: () => ({ clamped: true }),
    refresh_all: () => ({ ok: true, changed: true }),
    refresh_request_now: () => ({ ok: true, changed: true }),
    set_updates_paused: () => ({ ok: true, paused: false }),
    copy_request_value: () => ({ ok: true }),
    copy_all_values: () => ({ ok: true }),
    confirm_remove: () => false,
    read_log: () => 'Preview data only',
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
