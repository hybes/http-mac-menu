// Bridge to the Rust backend: every command the two pages can call.
const invoke = (cmd, args = {}) => window.__TAURI__.core.invoke(cmd, args);

window.api = {
  loadConfig: (id) => invoke('load_config', { id }),
  saveConfig: (id, values) => invoke('save_config', { id, values }),
  removeConfig: (id) => invoke('remove_config', { id }),
  testConfig: (values) => invoke('test_config', { values }),
  close: () => invoke('close_config'),
  // Native chrome: size the window to its content and match the system accent.
  fitWindow: (height) => invoke('fit_window', { height }),
  accentColor: () => invoke('accent_color'),
  importCurl: (text) => invoke('import_curl', { text }),
  listPresets: () => invoke('list_presets'),
  setDirty: (dirty) => invoke('set_dirty', { dirty }),
  // The list page is the home screen on phones, where there is no menu bar.
  listRequests: () => invoke('list_requests'),
  refreshAll: () => invoke('refresh_all'),
  refreshRequestNow: (id) => invoke('refresh_request_now', { id }),
  setUpdatesPaused: (paused) => invoke('set_updates_paused', { paused }),
  copyRequestValue: (id) => invoke('copy_request_value', { id }),
  copyAllValues: () => invoke('copy_all_values'),
  notificationStatus: () => invoke('notification_status'),
  enableNotifications: () => invoke('enable_notifications'),
  sendTestNotification: () => invoke('send_test_notification'),
  openNotificationSettings: () => {
    // Android needs an explicit Settings Intent; the thin native shell exposes
    // only that harmless action. Other platforms stay on the Rust command.
    const bridge = window.httpWidgetsNotificationSettings;
    if (bridge && typeof bridge.open === 'function') {
      bridge.open();
      return Promise.resolve();
    }
    return invoke('open_notification_settings');
  },
  appInfo: () => invoke('app_info'),
  // The About page's outbound links; the Rust side owns the URL table.
  openProjectLink: (target) => invoke('open_project_link', { target }),
  confirmRemove: (name) => invoke('confirm_remove', { name }),
  readLog: () => invoke('read_log'),
  log: (message) => invoke('ui_log', { message }),
};

// Phones get one full-screen webview and no keyboard, so the layout and a few
// controls differ. This drives it rather than a width breakpoint: the desktop
// config window is 520px, narrower than a phone on its side.
const root = document.documentElement;
const PLATFORM_CLASSES = [
  'platform-macos',
  'platform-ios',
  'platform-android',
  'platform-windows',
  'platform-linux',
];

const guessedPlatform = () => {
  const agent = navigator.userAgent || '';
  if (/Android/i.test(agent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(agent)) return 'ios';
  if (/Mac/i.test(navigator.platform || agent)) return 'macos';
  if (/Win/i.test(navigator.platform || agent)) return 'windows';
  return 'linux';
};

const applyAppInfo = (info = {}) => {
  const platform = String(info.platform || guessedPlatform()).toLowerCase();
  const mobile = Boolean(
    info.mobile || platform === 'ios' || platform === 'android'
  );
  root.classList.toggle('mobile', mobile);
  root.classList.toggle('desktop', !mobile);
  root.classList.remove(...PLATFORM_CLASSES);
  root.classList.add(`platform-${platform}`);
  root.dataset.platform = platform;
  return { ...info, platform, mobile };
};

const applyAccentColor = (value) => {
  const match = String(value || '')
    .trim()
    .match(/^#?([\da-f]{6})(?:[\da-f]{2})?$/i);
  if (!match) return;

  const hex = `#${match[1]}`;
  const red = Number.parseInt(match[1].slice(0, 2), 16) / 255;
  const green = Number.parseInt(match[1].slice(2, 4), 16) / 255;
  const blue = Number.parseInt(match[1].slice(4, 6), 16) / 255;
  const linear = (channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const luminance =
    0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);

  root.style.setProperty('--color-accent', hex);
  root.style.setProperty(
    '--color-accent-hover',
    `color-mix(in oklch, ${hex} 84%, var(--color-ink))`
  );
  root.style.setProperty(
    '--color-accent-soft',
    `color-mix(in oklch, ${hex} 14%, var(--color-surface))`
  );
  root.style.setProperty(
    '--color-selection',
    `color-mix(in oklch, ${hex} 24%, var(--color-surface))`
  );
  const accentInk =
    luminance > 0.18
      ? 'var(--color-accent-low-ink)'
      : 'var(--color-accent-high-ink)';
  root.style.setProperty('--color-accent-ink', accentInk);
};

// Keep the embedded pages at the platform's app scale. Native WebView
// settings provide the first layer; these cover WebKit gesture events and
// desktop trackpad/keyboard zoom without interfering with one-finger scroll
// or editing controls.
for (const eventName of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(eventName, (event) => event.preventDefault(), {
    passive: false,
  });
}
document.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
  },
  { passive: false }
);
document.addEventListener('keydown', (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    ['+', '-', '=', '0'].includes(event.key)
  ) {
    event.preventDefault();
  }
});

// A guess good enough to style the first paint, since this file runs before
// the page is drawn and long before the backend can answer.
applyAppInfo({ mobile: window.matchMedia('(pointer: coarse)').matches });
window.addEventListener('DOMContentLoaded', () => {
  window.api
    .appInfo()
    .then(applyAppInfo)
    .catch(() => {
      /* keep the guess */
    });

  window.api
    .accentColor()
    .then(applyAccentColor)
    .catch(() => {
      /* keep the cobalt fallback */
    });
});
