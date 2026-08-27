import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
  errorText,
  isFiniteNumberText,
  isValidJavaScriptRegex,
  notificationPrimaryAction,
} = require('../ui/reliability.js');

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const files = await Promise.all(
  [
    'ui/index.html',
    'ui/config.html',
    'ui/about.html',
    'ui/about.renderer.js',
    'ui/api.js',
    'ui/reliability.js',
    'ui/list.renderer.js',
    'ui/config.renderer.js',
    'ui/notifications.js',
    'styles.css',
    'tokens.css',
  ].map(async (path) => [path, await read(path)])
);
const source = Object.fromEntries(files);

test('both pages use the shared safe-area app shell', () => {
  for (const page of ['ui/index.html', 'ui/config.html']) {
    const html = source[page];
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /minimum-scale=1/);
    assert.match(html, /maximum-scale=1/);
    assert.match(html, /user-scalable=no/);
    assert.match(html, /class="app-shell [^"]+"/);
    assert.match(html, /class="app-bar [^"]+"/);
    assert.match(html, /class="app-content [^"]+"/);
    assert.ok(
      html.indexOf('src="reliability.js"') <
        html.indexOf('src="notifications.js"')
    );
    assert.doesNotMatch(html, /class="[^"]*\btitlebar\b/);
    assert.doesNotMatch(html, /\sstyle=/);
  }
});

test('the about page keeps to the shell conventions and fixed links', () => {
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
  // Links stay symbolic; the Rust side owns the URL table.
  assert.doesNotMatch(renderer, /https?:/);
});

test('home exposes graphs and useful quick actions', () => {
  const html = source['ui/index.html'];
  const renderer = source['ui/list.renderer.js'];

  for (const id of [
    'copyAllValues',
    'refreshAll',
    'addRequest',
    'pausedBanner',
    'backgroundRefreshBanner',
    'notificationBanner',
    'presetChoices',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  for (const contract of [
    'request-details',
    'request-graph',
    'request-metrics',
    'copyRequestValue',
    'refreshRequestNow',
    'duplicateRequest',
  ]) {
    assert.match(renderer, new RegExp(contract));
  }
  assert.doesNotMatch(renderer, /\.style\./);
});

test('editor keeps common choices visible and advanced HTTP details optional', () => {
  const html = source['ui/config.html'];
  const renderer = source['ui/config.renderer.js'];

  for (const heading of ['Source', 'Display', 'Schedule', 'Alerts']) {
    assert.match(html, new RegExp(`>${heading}<`));
  }
  assert.match(html, /class="advanced-panel"/);
  assert.match(html, /class="choice-chips/);
  assert.match(html, /id="presetConfirm"/);
  assert.match(html, /id="provider"/);
  for (const provider of ['auto', 'jupiter', 'dexscreener', 'coingecko']) {
    assert.match(html, new RegExp(`option value="${provider}"`));
  }
  assert.match(html, /Live · 5s/);
  assert.match(html, /id="alertNotificationControls"[\s\S]*?hidden/);
  assert.match(html, /id="holdings"[\s\S]*?aria-describedby="holdingsError"/);
  assert.match(html, /id="holdingsError"/);
  assert.match(html, /id="presetConfirm"[\s\S]*?role="group"/);
  assert.doesNotMatch(html, /role="alertdialog"/);
  assert.match(renderer, /params\.get\('preset'\)/);
  assert.match(renderer, /const validateHoldings =/);
  assert.match(renderer, /isValidJavaScriptRegex\(rule\.value\)/);
  assert.match(renderer, /presetConfirmationTrigger/);
  assert.match(renderer, /trigger\.focus\(\{ preventScroll: true \}\)/);
  assert.match(renderer, /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(renderer, /event\.preventDefault\(\)/);
  assert.doesNotMatch(renderer, /\.style\./);
});

test('automatic crypto refresh follows the provider it will actually use', () => {
  const renderer = source['ui/config.renderer.js'];

  assert.match(renderer, /const canJupiterConvertCurrency/);
  assert.match(renderer, /\^\[a-z\]\{3\}\$/);
  assert.match(renderer, /const automaticUsesJupiter/);
  assert.match(renderer, /'sol', 'solana', 'wsol', 'jup', 'jupiter', 'usdc'/);
  assert.match(renderer, /looksLikeSolanaMint\(coin\)/);
  assert.match(renderer, /const refreshPolicyProvider/);
  assert.match(renderer, /automaticUsesJupiter\(\) \? 'jupiter' : 'coingecko'/);
  assert.match(renderer, /exchange rates are cached/);
  assert.match(renderer, /provider === 'dexscreener' && currency !== 'usd'/);
  assert.match(
    renderer,
    /provider === 'jupiter' &&[\s\S]*?!canJupiterConvertCurrency\(currency\)/
  );
  assert.doesNotMatch(
    renderer,
    /currentProvider\(\) === 'jupiter' \|\| currentProvider\(\) === 'dexscreener'/
  );
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

  for (const renderer of [
    source['ui/config.renderer.js'],
    source['ui/list.renderer.js'],
    source['ui/notifications.js'],
  ]) {
    assert.match(renderer, /httpWidgetsUi/);
    assert.doesNotMatch(renderer, /error\.message/);
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
});

test('editor loading cannot overwrite interactive fields and can be retried', () => {
  const html = source['ui/config.html'];
  const renderer = source['ui/config.renderer.js'];

  assert.match(html, /id="configForm"[^>]*\binert\b[^>]*aria-busy="true"/);
  assert.match(html, /<\/form>[\s\S]*?id="configLoadState"/);
  assert.match(html, /id="retryConfigLoad"/);
  assert.match(renderer, /let initialLoadInProgress = false/);
  assert.match(renderer, /if \(initialLoadInProgress\) return/);
  assert.match(renderer, /retryConfigLoadButton\.addEventListener\('click'/);
  assert.match(
    renderer,
    /finishConfigLoad\(\);[\s\S]*?activateRequestedPreset\(\)/
  );

  const loadSection = renderer.slice(
    renderer.indexOf('const load = async'),
    renderer.indexOf('let initialLoadInProgress')
  );
  assert.match(loadSection, /markSaved\(\)/);
  assert.doesNotMatch(loadSection, /finally/);
});

test('request polling drops stale successes and failures', () => {
  const renderer = source['ui/list.renderer.js'];
  const poll = renderer.slice(
    renderer.indexOf('const poll = async'),
    renderer.indexOf('const runRequestAction')
  );

  assert.match(renderer, /let pollGeneration = 0/);
  assert.match(poll, /const generation = \+\+pollGeneration/);
  assert.equal((poll.match(/generation !== pollGeneration/g) || []).length, 2);
  assert.ok(
    poll.indexOf('generation !== pollGeneration') <
      poll.indexOf('render(state)')
  );
  assert.ok(
    poll.lastIndexOf('generation !== pollGeneration') <
      poll.indexOf('setFeedback(')
  );
});

test('mobile charts keep dense samples and refresh immediately after resume', () => {
  const renderer = source['ui/list.renderer.js'];
  assert.match(renderer, /const MAX_SPARKLINE_POINTS = 256/);
  assert.match(renderer, /const pollWhenVisible =/);
  assert.match(renderer, /addEventListener\('focus', pollWhenVisible\)/);
  assert.match(renderer, /addEventListener\('pageshow', pollWhenVisible\)/);
  assert.match(
    renderer,
    /addEventListener\('visibilitychange', pollWhenVisible\)/
  );
  assert.match(renderer, /info\.backgroundRefresh === 'denied'/);
  assert.match(renderer, /openBackgroundRefreshSettings/);
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
  assert.match(css, /\.field-error\[hidden\]/);
  assert.match(
    css,
    /\.segment span \{[\s\S]*?min-block-size:\s*var\(--control-height\)/
  );
  assert.match(css, /\.platform-macos/);
  assert.match(source['ui/config.renderer.js'], /event\.preventDefault\(\)/);
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
