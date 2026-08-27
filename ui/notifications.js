// Shared notification permission and test controls. Both pages use the same
// small state machine so permission wording and button behaviour cannot drift.
(() => {
  const PANEL_SELECTOR = '[data-notification-controls]';
  const panels = new Set();
  const { errorText, notificationPrimaryAction } = window.httpWidgetsUi;

  let status = {
    state: 'checking',
    message: 'Checking notification access…',
    result: 'neutral',
  };
  let busy = false;
  let loaded = false;

  const normalizeState = (value) => {
    const state = String(value || 'unknown')
      .trim()
      .toLowerCase()
      .replaceAll(' ', '_');
    if (['allowed', 'authorized', 'enabled'].includes(state)) return 'granted';
    if (['not_determined', 'undetermined'].includes(state)) return 'prompt';
    return state || 'unknown';
  };

  const fallbackMessage = (state) => {
    switch (state) {
      case 'granted':
        return 'Notifications ready.';
      case 'denied':
        return 'Notifications are off. Open Settings to receive alerts.';
      case 'unsupported':
        return 'Notifications are not available on this device.';
      case 'error':
        return 'Notification status could not be checked.';
      default:
        return 'Enable notifications to receive alerts.';
    }
  };

  const responseStatus = (response, result = 'neutral') => {
    const state = normalizeState(response && response.state);
    const message =
      response &&
      typeof response.message === 'string' &&
      response.message.trim()
        ? response.message.trim()
        : fallbackMessage(state);
    return { state, message, result };
  };

  const isGranted = () => status.state === 'granted';
  const isUnavailable = () => status.state === 'unsupported';

  const renderPanel = (panel) => {
    const message = panel.querySelector('[data-notification-message]');
    const enable = panel.querySelector('[data-notification-enable]');
    const test = panel.querySelector('[data-notification-test]');

    panel.dataset.notificationState = status.state;
    panel.dataset.notificationResult = status.result;
    panel.dataset.notificationAttention = String(
      !isGranted() || status.result !== 'neutral'
    );
    panel.setAttribute(
      'aria-busy',
      String(busy || status.state === 'checking')
    );

    if (message) message.textContent = status.message;
    if (enable) {
      const primaryAction = notificationPrimaryAction(status.state);
      enable.hidden = isGranted();
      enable.disabled = busy || isUnavailable() || status.state === 'checking';
      enable.textContent =
        primaryAction === 'settings'
          ? 'Open settings'
          : primaryAction === 'retry'
            ? 'Retry'
            : 'Enable';
      enable.title =
        primaryAction === 'settings'
          ? 'Open this app’s notification settings'
          : primaryAction === 'retry'
            ? 'Check notification access again'
            : 'Ask this device to allow notifications';
    }
    if (test) {
      test.disabled = busy || !isGranted();
      test.title = isGranted()
        ? 'Send a notification to this device'
        : 'Enable notifications before sending a test';
    }
  };

  const render = () => {
    for (const panel of panels) renderPanel(panel);
    window.dispatchEvent(new CustomEvent('notifications:updated'));
  };

  const setStatus = (next) => {
    status = next;
    render();
  };

  const runAction = async (action) => {
    if (busy) return null;
    busy = true;
    render();
    try {
      return await action();
    } catch (error) {
      setStatus({
        state: 'error',
        message: errorText(
          error,
          'The notification service could not be reached.'
        ),
        result: 'error',
      });
      return null;
    } finally {
      busy = false;
      render();
    }
  };

  const refresh = async () => {
    const response = await runAction(() => window.api.notificationStatus());
    loaded = true;
    if (response) setStatus(responseStatus(response));
  };

  const enable = async () => {
    const response = await runAction(() => window.api.enableNotifications());
    if (response) setStatus(responseStatus(response));
  };

  const openSettings = async () => {
    await runAction(() => window.api.openNotificationSettings());
    // The operating system takes focus now. Its permission state is queried
    // again by the focus/visibility listeners when the user comes back.
  };

  const runPrimaryAction = () => {
    const action = notificationPrimaryAction(status.state);
    if (action === 'settings') return openSettings();
    if (action === 'retry') return refresh();
    return enable();
  };

  const sendTest = async () => {
    const response = await runAction(() => window.api.sendTestNotification());
    if (!response) return;
    setStatus(
      responseStatus(response, response.ok === false ? 'error' : 'success')
    );
  };

  const register = (panel) => {
    if (panels.has(panel)) return;
    panels.add(panel);
    panel
      .querySelector('[data-notification-enable]')
      ?.addEventListener('click', runPrimaryAction);
    panel
      .querySelector('[data-notification-test]')
      ?.addEventListener('click', sendTest);
    renderPanel(panel);
  };

  const mount = (root = document) => {
    for (const panel of root.querySelectorAll(PANEL_SELECTOR)) register(panel);
    if (!loaded) refresh();
  };

  window.notificationControls = { mount, refresh };
  window.addEventListener('DOMContentLoaded', () => mount());
  window.addEventListener('focus', () => {
    if (loaded && !busy) refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && loaded && !busy) refresh();
  });
})();
