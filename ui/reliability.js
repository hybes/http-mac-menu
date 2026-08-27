// Small, dependency-free UI contracts shared by both webview pages and the
// Node test suite. Keep these helpers free of DOM state so error and validation
// behaviour cannot drift between renderers.
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

  const api = Object.freeze({
    errorText,
    isFiniteNumberText,
    isValidJavaScriptRegex,
    notificationPrimaryAction,
  });

  if (typeof window !== 'undefined') window.httpWidgetsUi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
