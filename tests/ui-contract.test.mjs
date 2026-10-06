import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ui = require('../ui/reliability.js');
const {
  errorText,
  isFiniteNumberText,
  isValidJavaScriptRegex,
  notificationPrimaryAction,
  responseFields,
} = ui;

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path) =>
  access(new URL(`../${path}`, import.meta.url)).then(
    () => true,
    () => false
  );

const VIEWS = [
  'ui/view.add.js',
  'ui/view.home.js',
  'ui/view.value.js',
  'ui/view.builder.js',
  'ui/view.settings.js',
];
const SCRIPTS = [
  'ui/reliability.js',
  'ui/notifications.js',
  'ui/dom.js',
  'ui/parts.js',
  'ui/chart.js',
  ...VIEWS,
  'ui/app.js',
];

const files = await Promise.all(
  [
    'ui/index.html',
    'ui/about.html',
    'ui/about.renderer.js',
    'ui/api.js',
    ...SCRIPTS,
    'styles.css',
    'tokens.css',
    'package.json',
    'src-tauri/src/lib.rs',
    'src-tauri/src/commands.rs',
  ].map(async (path) => [path, await read(path)])
);
const source = Object.fromEntries(files);

test('response picker retains nulls, arrays and unusual JSON keys with a bounded list', () => {
  const fields = responseFields({
    data: { pending: null, count: 0, enabled: false },
    items: [{ name: '<b>text</b>' }],
    'a.b': { 'x/y~': 2 },
  });
  const find = (path) => fields.find((field) => field.path === path);

  assert.deepEqual(find('data.pending'), {
    path: 'data.pending',
    summary: 'null',
    key: 'pending',
    depth: 1,
    kind: 'null',
  });
  assert.equal(find('data.count').summary, '0');
  assert.equal(find('data.enabled').summary, 'false');
  assert.equal(find('items[0].name').summary, '"<b>text</b>"');
  assert.equal(find('/a.b/x~1y~0').summary, '2');

  // The tree is drawn from depth and kind, in document order.
  assert.deepEqual(
    fields.map((field) => [field.depth, field.kind, field.key]).slice(0, 6),
    [
      [0, 'object', 'data'],
      [1, 'null', 'pending'],
      [1, 'number', 'count'],
      [1, 'boolean', 'enabled'],
      [0, 'array', 'items'],
      [1, 'object', '0'],
    ]
  );

  assert.deepEqual(responseFields(null), []);
  assert.deepEqual(responseFields('plain text'), []);
  assert.equal(
    responseFields(Array.from({ length: 1000 }, () => 1)).length,
    250
  );
  assert.equal(
    responseFields({ long: 'x'.repeat(1000) })[0].summary.length,
    81
  );
});

test('the app is one page in the shared safe-area shell', async () => {
  const html = source['ui/index.html'];
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /minimum-scale=1/);
  assert.match(html, /maximum-scale=1/);
  assert.match(html, /user-scalable=no/);
  assert.match(html, /class="app-shell [^"]+"/);
  assert.match(html, /class="app-bar [^"]+"/);
  assert.match(html, /class="app-content [^"]+"/);
  assert.match(html, /data-tauri-drag-region/);
  assert.doesNotMatch(html, /\sstyle=/);

  // Every script the page names exists, and each loads after what it uses.
  const order = [...html.matchAll(/<script src="([\w.-]+)"/g)].map(
    (match) => `ui/${match[1]}`
  );
  assert.deepEqual(order, ['ui/api.js', ...SCRIPTS]);
  for (const path of order) assert.equal(await exists(path), true, path);

  // The form and the list were separate pages once; nothing may link to them.
  for (const gone of [
    'ui/config.html',
    'ui/config.renderer.js',
    'ui/list.renderer.js',
  ]) {
    assert.equal(await exists(gone), false, gone);
  }
  for (const path of SCRIPTS) {
    assert.doesNotMatch(source[path], /config\.html|list\.renderer/, path);
    assert.match(source['package.json'], new RegExp(path.replace('.', '\\.')));
  }
});

test('routes agree with the pages the native side opens', () => {
  const { parseRoute, routes } = ui;
  assert.deepEqual(parseRoute(''), { name: 'home' });
  assert.deepEqual(parseRoute('#/'), { name: 'home' });
  assert.deepEqual(parseRoute('#/new'), { name: 'add' });
  assert.deepEqual(parseRoute('#/settings'), { name: 'settings' });
  assert.deepEqual(parseRoute('#/build'), {
    name: 'builder',
    id: 'new',
    step: null,
  });
  assert.deepEqual(parseRoute('#/v/r1'), { name: 'value', id: 'r1' });
  assert.deepEqual(parseRoute('#/v/r1/edit/display'), {
    name: 'builder',
    id: 'r1',
    step: 'display',
  });
  assert.deepEqual(parseRoute('#/nonsense'), { name: 'home' });
  assert.deepEqual(parseRoute('#/v/%E0%A4%A'), { name: 'home' });

  // Hand-edited ids survive the round trip through the fragment.
  const awkward = "r 1'&?#/";
  assert.deepEqual(parseRoute(routes.value(awkward)), {
    name: 'value',
    id: awkward,
  });
  assert.deepEqual(parseRoute(routes.edit(awkward, 'alerts')), {
    name: 'builder',
    id: awkward,
    step: 'alerts',
  });
  assert.deepEqual(
    parseRoute('#/v/r%201%27%26%3F%23'),
    { name: 'value', id: "r 1'&?#" },
    'the encoding config_page uses in lib.rs'
  );

  const native = source['src-tauri/src/lib.rs'];
  assert.match(native, /"index\.html#\/new"/);
  assert.match(native, /"index\.html#\/v\/\{\}"/);
  assert.match(native, /const HOME_ROUTE: &str = "index\.html#\/";/);
  assert.match(native, /window\.httpWidgets\.open\(\{page\}\)/);
  assert.match(source['ui/app.js'], /window\.httpWidgets\.open = /);
  assert.doesNotMatch(native, /config\.html/);
});

test('the about window keeps to the shell conventions and fixed links', () => {
  const html = source['ui/about.html'];
  assert.match(html, /class="app-shell [^"]+"/);
  assert.match(html, /class="app-bar [^"]+"/);
  assert.match(html, /class="app-content [^"]+"/);
  assert.match(html, /data-tauri-drag-region/);
  assert.match(html, /id="aboutVersion"/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.ok(html.indexOf('src="api.js"') < html.indexOf('about.renderer.js'));

  const renderer = source['ui/about.renderer.js'];
  assert.match(renderer, /openProjectLink/);
  // Escape puts the window away, and links stay symbolic; the Rust side owns
  // both the hide and the URL table.
  assert.match(renderer, /'Escape'/);
  assert.doesNotMatch(renderer, /https?:/);
});

test('app preferences save themselves and never ride along with a value', () => {
  const settings = source['ui/view.settings.js'];
  const builder = source['ui/view.builder.js'];

  for (const command of [
    'preferences',
    'setTrayLink',
    'setIndicatorStyle',
    'setLaunchAtLogin',
    'setShowInDock',
    'setUpdatesPaused',
    'readLog',
    'openProjectLink',
  ]) {
    assert.match(
      settings,
      new RegExp(`window\\.api\\s*\\.${command}\\(`),
      command
    );
    assert.match(source['ui/api.js'], new RegExp(`${command}:`), command);
  }
  // The link is committed on change and never sits in a value's draft.
  assert.match(settings, /link\.addEventListener\('change'/);
  assert.doesNotMatch(builder, /trayLink|setTrayLink/);

  const commands = source['src-tauri/src/commands.rs'];
  for (const command of [
    'get_preferences',
    'set_tray_link',
    'set_indicator_style',
    'set_launch_at_login',
    'set_show_in_dock',
    'confirm_discard',
  ]) {
    assert.match(commands, new RegExp(`pub (async )?fn ${command}\\(`));
    assert.match(
      source['src-tauri/src/lib.rs'],
      new RegExp(`commands::${command},`)
    );
  }
});

test('home shows the surface, the list and only the banners that matter', () => {
  const home = source['ui/view.home.js'];
  for (const contract of [
    'createSurface',
    'copyAllValues',
    'refreshAll',
    'setUpdatesPaused(false)',
    'notificationPanel',
    'startOptions',
    'sparkline(request.points)',
  ]) {
    assert.ok(home.includes(contract), contract);
  }
  // Permission is only worth a banner once some value has an alert.
  assert.match(home, /request\.alerts > 0/);
  assert.match(
    source['src-tauri/src/commands.rs'],
    /alerts: r\.alerts\.len\(\)/
  );
  assert.match(home, /info\.backgroundRefresh === 'denied'/);
  // Rows are patched by id rather than rebuilt, so focus survives a poll.
  assert.match(home, /const rows = new Map\(\)/);
  assert.match(home, /if \(signature === row\.signature\) return/);
});

test('a value can be read, acted on and opened at any step of its setup', () => {
  const value = source['ui/view.value.js'];
  for (const contract of [
    'createTrend',
    'copyRequestValue',
    'refreshRequestNow',
    "saveConfig('new', values)",
    'confirmRemove',
    'removeConfig',
  ]) {
    assert.ok(value.includes(contract), contract);
  }
  for (const step of ['source', 'value', 'display', 'refresh', 'alerts']) {
    assert.match(value, new RegExp(`setupRow\\(\\s*'${step}'`), step);
  }
});

test('adding starts from an address, a coin or an example', () => {
  const add = source['ui/view.add.js'];
  assert.match(add, /classifySource\(sourceInput\.value\)/);
  assert.match(add, /window\.api\.importCurl\(/);
  assert.match(add, /\.listPresets\(\)/);
  assert.match(add, /app\.setSeed\(seed\)/);
  assert.match(add, /app\.atLimit\(\)/);

  const { classifySource } = ui;
  assert.deepEqual(classifySource('  '), { kind: 'empty' });
  assert.deepEqual(classifySource('https://api.example.com/v1?x=1'), {
    kind: 'url',
    url: 'https://api.example.com/v1?x=1',
  });
  assert.deepEqual(classifySource('api.example.com/status'), {
    kind: 'url',
    url: 'https://api.example.com/status',
  });
  assert.deepEqual(classifySource('http://printer/status'), {
    kind: 'url',
    url: 'http://printer/status',
  });
  assert.equal(classifySource('localhost:8080/health').kind, 'url');
  assert.equal(classifySource("curl 'https://x.test' -H 'A: b'").kind, 'curl');
  assert.equal(classifySource('CURL https://x.test').kind, 'curl');
  assert.deepEqual(classifySource('weather'), { kind: 'invalid' });
  assert.deepEqual(classifySource('two words.com'), { kind: 'invalid' });
  assert.deepEqual(classifySource('ftp://example.com/file'), {
    kind: 'invalid',
  });
});

test('the builder walks the same steps for every value and validates before saving', () => {
  const builder = source['ui/view.builder.js'];

  assert.match(
    builder,
    /http: \['source', 'value', 'display', 'refresh', 'alerts'\]/
  );
  assert.match(builder, /crypto: \['source', 'display', 'refresh', 'alerts'\]/);
  for (const provider of ['auto', 'jupiter', 'dexscreener', 'coingecko']) {
    assert.match(builder, new RegExp(`value: '${provider}'`), provider);
  }
  for (const contract of [
    'const validateHoldings =',
    'const validateCurrency =',
    'const validateTimer =',
    'isValidJavaScriptRegex(rule.value)',
    "setAttribute('aria-invalid', 'true')",
    'event.preventDefault()',
    'window.api.confirmDiscard()',
    'window.api.confirmRemove(name)',
    'createSurface(store.info.platform)',
    'ui.responseFields(JSON.parse(text))',
  ]) {
    assert.ok(builder.includes(contract), contract);
  }

  // The preview is the Rust formatter: a fetch, then re-reads of its response.
  assert.match(builder, /window\.api\.testConfig\(collect\(\)\)/);
  assert.match(builder, /window\.api\.testConfig\(collect\(\), response\)/);
  assert.match(builder, /token !== fetchToken/);
  assert.match(builder, /token === formatToken/);
  // Importing a cURL command never keeps a previous endpoint's headers.
  assert.match(builder, /setValue\('headers', result\.headers \|\| ''\)/);

  // Saving reports the id back so the page can show the value it made.
  assert.match(builder, /result\?\.id/);
  assert.match(
    source['src-tauri/src/commands.rs'],
    /"ok": true, "id": saved_id/
  );
});

test('the builder cannot be edited while it loads and offers a retry', () => {
  const builder = source['ui/view.builder.js'];
  assert.match(builder, /class: 'builder', hidden: true/);
  assert.match(builder, /let loading = false/);
  assert.match(builder, /if \(loading\) return/);
  assert.match(builder, /retryButton\.addEventListener\('click', load\)/);
  assert.match(builder, /if \(saving \|\| page\.hidden\) return/);

  const load = builder.slice(
    builder.indexOf('const load = async'),
    builder.indexOf("retryButton.addEventListener('click', load)")
  );
  // The draft is only shown once it has been read in full.
  assert.ok(
    load.indexOf('savedSnapshot = JSON.stringify(draft)') <
      load.indexOf('page.hidden = false')
  );
  assert.match(load, /retryButton\.hidden = false/);
});

test('no view styles from script or builds markup from strings', () => {
  for (const path of [...VIEWS, 'ui/parts.js', 'ui/chart.js', 'ui/app.js']) {
    assert.doesNotMatch(source[path], /\.style\./, path);
    assert.doesNotMatch(source[path], /innerHTML|insertAdjacentHTML/, path);
  }
  assert.doesNotMatch(source['ui/dom.js'], /innerHTML|insertAdjacentHTML/);
});

test('automatic crypto refresh follows the provider it will actually use', () => {
  const { refreshPolicyProvider, timerMinimum, timerDefault, effectiveTimer } =
    ui;
  const crypto = (values) => ({ type: 'crypto', ...values });
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

  // Mirrors engine::crypto_route::refresh_policy_provider.
  for (const coin of [
    'sol',
    'SOL',
    ' wsol ',
    'jup',
    'usdc',
    SOL_MINT,
    JUP_MINT,
  ]) {
    assert.equal(
      refreshPolicyProvider(
        crypto({ provider: 'auto', coin, currency: 'usd' })
      ),
      'jupiter',
      coin
    );
  }
  assert.equal(
    refreshPolicyProvider(crypto({ provider: 'auto', coin: 'sol' })),
    'jupiter',
    'a blank currency is GBP'
  );
  for (const [coin, currency] of [
    ['btc', 'usd'],
    ['eth', 'gbp'],
    ['sol', 'bits'],
    ['sol', 'us'],
    ['', 'usd'],
    // Mints are case-sensitive: this one is not base58.
    [SOL_MINT.toLowerCase().replace('s', 'l'), 'usd'],
  ]) {
    assert.equal(
      refreshPolicyProvider(crypto({ provider: 'auto', coin, currency })),
      'coingecko',
      `${coin}/${currency}`
    );
  }
  for (const provider of ['jupiter', 'dexscreener', 'coingecko']) {
    assert.equal(
      refreshPolicyProvider(crypto({ provider, coin: 'btc' })),
      provider
    );
  }
  assert.equal(
    refreshPolicyProvider(crypto({ provider: 'nonsense', coin: 'btc' })),
    'coingecko'
  );

  // Matches the provider-aware limits in engine::constants.
  const btc = crypto({ provider: 'auto', coin: 'btc' });
  const sol = crypto({ provider: 'auto', coin: 'sol' });
  const pool = crypto({ provider: 'dexscreener', coin: 'sol' });
  assert.deepEqual(
    [btc, sol, pool, { type: 'http' }].map(timerMinimum),
    [30, 5, 30, 5]
  );
  assert.deepEqual(
    [btc, sol, pool, { type: 'http' }].map(timerDefault),
    [60, 5, 30, 5]
  );
  assert.equal(effectiveTimer({ ...btc, timer: '' }), 60);
  assert.equal(effectiveTimer({ ...btc, timer: '5' }), 30);
  assert.equal(effectiveTimer({ ...sol, timer: '5' }), 5);
  assert.equal(effectiveTimer({ type: 'http', timer: 'soon' }), 5);
  assert.equal(effectiveTimer({ type: 'http', timer: '999999' }), 86400);

  const builder = source['ui/view.builder.js'];
  assert.match(builder, /provider === 'dexscreener' && currency !== 'usd'/);
  assert.match(
    builder,
    /provider === 'jupiter' &&\s*!ui\.canJupiterConvertCurrency\(currency\)/
  );
});

test('every step states its setting in plain words', () => {
  assert.deepEqual(
    [1, 5, 60, 90, 300, 900, 3600, 5400, 86400].map(ui.describeInterval),
    [
      'Every second',
      'Every 5 seconds',
      'Every minute',
      'Every 1 minute 30s',
      'Every 5 minutes',
      'Every 15 minutes',
      'Every hour',
      'Every 1 hour 30m',
      'Every 24 hours',
    ]
  );
  assert.equal(ui.fetchesPerDay(60), 1440);
  assert.equal(ui.fetchesPerDay(900), 96);

  assert.equal(ui.describeSource({ type: 'http', url: '' }), 'Add a URL');
  assert.equal(
    ui.describeSource({
      type: 'http',
      url: 'https://api.example.com/v1/status?key=secret',
    }),
    'api.example.com/v1/status?…',
    'query strings can hold keys, so they are never echoed'
  );
  assert.equal(
    ui.describeSource({ type: 'crypto', coin: 'eth', holdings: '2' }),
    '2 ETH in GBP'
  );
  assert.equal(
    ui.describeSource({
      type: 'crypto',
      coin: 'So11111111111111111111111111111111111111112',
      currency: 'usd',
    }),
    'So11…1112 in USD'
  );
  assert.equal(
    ui.describeProvider({ type: 'crypto', provider: 'auto', coin: 'sol' }),
    'Automatic · Jupiter'
  );
  assert.equal(ui.describeField({ json: '' }), 'The whole response');

  for (const [template, mode] of [
    ['', 'plain'],
    ['{value}', 'plain'],
    ['{value|relative}', 'relative'],
    ['{value|datetime}', 'datetime'],
    ['{value|date}', 'date'],
    ['{value|time}', 'time'],
    ['Next: {value|relative}', 'custom'],
    ['{data.status}', 'custom'],
  ]) {
    assert.equal(ui.displayMode(template), mode, template);
  }
  assert.equal(
    ui.describeDisplay({
      type: 'http',
      http_template: '{value|relative}',
      suffix: ' left',
      display_rules: [{}, {}],
    }),
    'Time until or since · 2 conditions · wrapped as … left'
  );
  assert.equal(
    ui.describeDisplay({ type: 'crypto', holdings: '3' }),
    '{symbol} {balance} {change24h}'
  );
  for (const [affix, one, many] of [
    [' order(s)', ' order', ' orders'],
    ['Box(es): ', 'Box: ', 'Boxes: '],
    [' (GBP) ms (s) a(1) b()', ' (GBP) ms (s) a(1) b()'],
    ['match(es)(s)', 'match(s)', 'matches(s)'],
    ['café(s', 'café(s'],
  ]) {
    assert.equal(ui.pluralAffix(affix, true), one, affix);
    assert.equal(ui.pluralAffix(affix, false), many ?? one, affix);
  }

  assert.equal(ui.describeAlerts({ alerts: [] }), 'None');
  assert.equal(
    ui.describeAlerts({
      type: 'crypto',
      alerts: [{ kind: 'pct_down', value: '5', cooldown_secs: 3600 }],
    }),
    'Price drops at least 5%, at most every hour'
  );
  assert.equal(
    ui.describeAlert({ kind: 'contains', value: 'down', cooldown_secs: 0 }),
    'Value contains down, every time'
  );
  assert.equal(ui.describeAlerts({ alerts: [{}, {}, {}] }), '3 alerts');
});

test('the surface draws titles the way the tray does', () => {
  const { titleItem } = ui;
  assert.equal(titleItem({ value: '21.4°C' }), '21.4°C');
  assert.equal(titleItem({ value: null }), '…');
  assert.equal(titleItem({ value: '3', error: 'HTTP 503' }), '⚠ 3');
  assert.equal(titleItem({ value: null, error: 'HTTP 503' }), '⚠');
  // MAX_ITEM_TITLE_CHARS in engine::constants.
  assert.equal(Array.from(titleItem({ value: 'x'.repeat(60) })).length, 40);
  assert.ok(titleItem({ value: '€'.repeat(60) }).endsWith('…'));
  assert.equal(ui.TITLE_SEPARATOR, ' | ');

  const parts = source['ui/parts.js'];
  assert.match(parts, /platform === 'macos'/);
  assert.match(parts, /titleItem\(item\)/);
});

test('shared notification state covers permission and test flows', () => {
  const notifications = source['ui/notifications.js'];
  for (const command of [
    'notificationStatus',
    'enableNotifications',
    'openNotificationSettings',
    'sendTestNotification',
  ]) {
    assert.match(notifications, new RegExp(command));
  }
  assert.match(notifications, /notifications:updated/);
  assert.match(notifications, /primaryAction === 'retry'/);
  assert.match(notifications, /if \(action === 'retry'\) return refresh\(\)/);
  assert.doesNotMatch(
    notifications,
    /\['unsupported',\s*'error'\]\.includes\(status\.state\)/
  );
  // Panels belong to views that come and go.
  assert.match(notifications, /panel\.isConnected === false/);
  assert.match(source['ui/app.js'], /notificationControls\.mount\(viewRoot\)/);

  const panel = source['ui/parts.js'];
  for (const hook of [
    'data-notification-controls',
    'data-notification-message',
    'data-notification-enable',
    'data-notification-test',
  ]) {
    assert.ok(panel.includes(hook), hook);
  }
});

test('shared reliability helpers match backend-facing input and error shapes', () => {
  for (const value of ['0', '-1.25', '+.5', '1.', '1e3', '2.5E-2']) {
    assert.equal(isFiniteNumberText(value), true, value);
  }
  for (const value of ['', '10O', '1,000', '0x10', 'NaN', 'Infinity']) {
    assert.equal(isFiniteNumberText(value), false, value);
  }

  assert.equal(isValidJavaScriptRegex('^sol\\s+\\d+$'), true);
  assert.equal(isValidJavaScriptRegex('('), false);
  assert.equal(errorText(' disk full ', 'fallback'), 'disk full');
  assert.equal(errorText(new Error('offline'), 'fallback'), 'offline');
  assert.equal(errorText({ message: '  ' }, 'fallback'), 'fallback');
  assert.equal(errorText(null, 'fallback'), 'fallback');
  assert.equal(notificationPrimaryAction('denied'), 'settings');
  assert.equal(notificationPrimaryAction('error'), 'retry');
  assert.equal(notificationPrimaryAction('prompt'), 'enable');

  for (const path of [...VIEWS, 'ui/app.js', 'ui/notifications.js']) {
    assert.match(source[path], /httpWidgetsUi/, path);
    assert.doesNotMatch(source[path], /error\.message/, path);
  }
});

test('notification errors expose a working Retry action', async () => {
  const notificationSource = source['ui/notifications.js'];
  const reliabilitySource = source['ui/reliability.js'];
  const listeners = {};
  const button = () => ({
    hidden: false,
    disabled: false,
    textContent: '',
    title: '',
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    listeners: {},
  });
  const enable = button();
  const sendTest = button();
  const message = { textContent: '' };
  const panel = {
    dataset: {},
    attributes: {},
    querySelector(selector) {
      return {
        '[data-notification-message]': message,
        '[data-notification-enable]': enable,
        '[data-notification-test]': sendTest,
      }[selector];
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  const responses = [
    () => Promise.reject('offline'),
    () => Promise.resolve({ state: 'granted' }),
    () => Promise.resolve({ state: 'unsupported' }),
  ];
  const document = {
    visibilityState: 'visible',
    querySelectorAll: () => [panel],
    addEventListener: () => {},
  };
  const window = {
    api: {
      notificationStatus: () => responses.shift()(),
      enableNotifications: () => Promise.resolve({ state: 'granted' }),
      openNotificationSettings: () => Promise.resolve(),
      sendTestNotification: () => Promise.resolve({ state: 'granted' }),
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    dispatchEvent: () => {},
  };
  const context = vm.createContext({
    CustomEvent: class CustomEvent {},
    document,
    module: undefined,
    window,
  });
  vm.runInContext(reliabilitySource, context);
  vm.runInContext(notificationSource, context);

  window.notificationControls.mount();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(panel.dataset.notificationState, 'error');
  assert.equal(message.textContent, 'offline');
  assert.equal(enable.textContent, 'Retry');
  assert.equal(enable.disabled, false);

  await enable.listeners.click();
  assert.equal(panel.dataset.notificationState, 'granted');
  assert.equal(enable.hidden, true);
  assert.equal(sendTest.disabled, false);

  await window.notificationControls.refresh();
  assert.equal(panel.dataset.notificationState, 'unsupported');
  assert.equal(enable.hidden, false);
  assert.equal(enable.disabled, true);

  // A panel whose view has gone is dropped rather than drawn again.
  panel.isConnected = false;
  panel.dataset.notificationState = 'stale';
  await window.notificationControls.refresh();
  assert.equal(panel.dataset.notificationState, 'stale');
});

test('polling drops stale successes and failures', () => {
  const app = source['ui/app.js'];
  const poll = app.slice(
    app.indexOf('const poll = async'),
    app.indexOf('const assertSuccessful')
  );

  assert.match(app, /let pollGeneration = 0/);
  assert.match(poll, /const generation = \+\+pollGeneration/);
  assert.equal((poll.match(/generation !== pollGeneration/g) || []).length, 2);
  assert.ok(
    poll.indexOf('generation !== pollGeneration') <
      poll.indexOf('Object.assign(store')
  );
  assert.ok(
    poll.lastIndexOf('generation !== pollGeneration') <
      poll.indexOf('store.error =')
  );
});

test('leaving a draft is asked about once, wherever the request comes from', () => {
  const app = source['ui/app.js'];
  const builder = source['ui/view.builder.js'];

  // In-app navigation, back and forward all pass the view's own question.
  assert.match(app, /if \(!force && !\(await canLeave\(\)\)\) return false/);
  assert.match(app, /if \(await canLeave\(\)\) show\(hash\)/);
  assert.match(app, /else history\.pushState\(null, '', appliedHash\)/);
  assert.match(app, /addEventListener\('hashchange', onLocationChange\)/);
  // The native side has already asked before it opens another page.
  assert.match(app, /return go\(hash, \{ force: true \}\)/);
  assert.match(builder, /window\.api\.setDirty\(dirty\)/);
  assert.match(builder, /window\.api\.setDirty\(false\)/);
  assert.match(builder, /addEventListener\('focus', reportDirty\)/);
  assert.match(builder, /removeEventListener\('focus', reportDirty\)/);

  // Saving and removing leave the window where it is; the page moves on.
  const commands = source['src-tauri/src/commands.rs'];
  assert.doesNotMatch(commands, /close_config_window\(&app, true\)/);
});

test('charts keep dense samples and values refresh immediately after resume', () => {
  const chart = source['ui/chart.js'];
  const app = source['ui/app.js'];
  assert.match(chart, /const MAX_SPARKLINE_POINTS = 256/);
  assert.match(chart, /role: 'slider'/);
  assert.match(chart, /ArrowLeft: -1, ArrowRight: 1/);
  assert.match(chart, /plot\.addEventListener\('pointermove'/);
  assert.match(app, /const pollWhenVisible =/);
  assert.match(app, /addEventListener\('focus', pollWhenVisible\)/);
  assert.match(app, /addEventListener\('pageshow', pollWhenVisible\)/);
  assert.match(app, /addEventListener\('visibilitychange', pollWhenVisible\)/);
});

test('iOS app and widget share a writable app-group snapshot path', async () => {
  const bridge = await read(
    'src-tauri/gen/apple/Sources/http-widgets/SnapshotBridge.swift'
  );
  const widget = await read(
    'src-tauri/ios-widget/Swift/HttpWidgetsWidget.swift'
  );

  for (const source of [bridge, widget]) {
    assert.match(source, /snapshotDirectory = "Library\/Application Support"/);
    assert.match(
      source,
      /appendingPathComponent\(snapshotDirectory, isDirectory: true\)/
    );
  }
  assert.match(
    bridge,
    /createDirectory\(at: directory, withIntermediateDirectories: true\)/
  );
  assert.match(
    bridge,
    /directory\.appendingPathComponent\("widget-snapshot\.tmp"\)/
  );
  const install = bridge.slice(
    bridge.indexOf('static func install()'),
    bridge.indexOf('static func syncSnapshot()')
  );
  assert.match(install, /startPollingIfNeeded\(\)/);
  assert.match(bridge, /RunLoop\.main\.add\(timer, forMode: \.common\)/);
});

test('native-feeling interaction safeguards remain in the design system', () => {
  const css = source['styles.css'];
  const tokens = source['tokens.css'];

  assert.match(css, /overflow-x:\s*clip/);
  assert.match(css, /scrollbar-width:\s*none/);
  assert.match(css, /::-webkit-scrollbar/);
  assert.match(css, /touch-action:\s*pan-y/);
  assert.match(css, /overscroll-behavior:\s*none/);
  assert.match(css, /-webkit-touch-callout:\s*none/);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /@media \(pointer:\s*coarse\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /@media \(forced-colors:\s*active\)/);
  assert.match(css, /\.field-error\[hidden\]/);
  assert.match(
    css,
    /\.mobile \.segment \{[\s\S]*?min-block-size:\s*var\(--control-height\)/
  );
  assert.match(css, /\.platform-macos/);
  // Sixteen-pixel fields stop iOS zooming the page on focus.
  assert.match(
    css,
    /\.mobile :is\(\.input[^)]*\) \{\s*font-size:\s*var\(--text-base\)/
  );
  assert.match(source['ui/api.js'], /'platform-ios'/);
  assert.match(source['ui/api.js'], /'gesturestart'/);
  assert.match(source['ui/api.js'], /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(source['ui/api.js'], /luminance > 0\.18/);
  assert.match(tokens, /--control-height:\s*44px/);
  assert.match(tokens, /--color-accent-high-ink:/);
  assert.match(tokens, /--color-accent-low-ink:/);
  assert.match(tokens, /--color-accent-text:/);
  assert.match(tokens, /--color-data:/);
  assert.doesNotMatch(source['ui/api.js'], /setProperty\('--color-focus'/);

  const mobileRule =
    css.match(/\.mobile \.app-content\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(mobileRule, /touch-action:\s*pan-y/);
  assert.match(mobileRule, /overscroll-behavior-y:\s*contain/);
  assert.match(
    css,
    /padding-inline:\s*max\(var\(--space-md\), env\(safe-area-inset-left\)\)\s+max\(var\(--space-md\), env\(safe-area-inset-right\)\)/
  );
});
