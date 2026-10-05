// The shell around every view: one polled copy of the live values, a hash
// router, the app bar and a toast. Views are plain factories registered on
// window.httpWidgets.views and never talk to each other directly.
(() => {
  const { h, icon } = window.httpWidgets.dom;
  const { errorText, parseRoute, routes } = window.httpWidgetsUi;

  const POLL_MS = 2000;
  const viewRoot = document.getElementById('view');
  const barRoot = document.getElementById('appBar');
  const toastRoot = document.getElementById('toast');

  const store = {
    requests: [],
    paused: false,
    max: 0,
    loaded: false,
    error: null,
    info: {
      platform: document.documentElement.dataset.platform,
      mobile: false,
    },
  };

  let pollGeneration = 0;
  let current = null;
  let appliedHash = null;
  let navigating = false;
  let pendingSeed = null;
  let toastTimer = null;

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  const currentHash = () => location.hash || '#/';

  const canLeave = async () => {
    if (!current?.view.canLeave) return true;
    try {
      return await current.view.canLeave();
    } catch {
      return true;
    }
  };

  const show = (hash) => {
    appliedHash = hash;
    const route = parseRoute(hash);
    current?.view.unmount?.();
    current = null;
    viewRoot.replaceChildren();
    viewRoot.scrollTop = 0;
    viewRoot.className = `app-content app-view view-${route.name}`;
    viewRoot.setAttribute('aria-busy', 'false');
    const factory =
      window.httpWidgets.views[route.name] || window.httpWidgets.views.home;
    current = { route, view: factory({ root: viewRoot, route, app }) || {} };
    current.view.update?.(store);
    window.notificationControls.mount(viewRoot);
  };

  // `force` skips the unsaved-changes question: the native side has already
  // asked it, or the draft was just saved or removed.
  const go = async (hash, { force = false, replace = false } = {}) => {
    if (navigating) return false;
    navigating = true;
    try {
      if (!force && !(await canLeave())) return false;
      if (currentHash() !== hash) {
        history[replace ? 'replaceState' : 'pushState'](null, '', hash);
      }
      show(hash);
      return true;
    } finally {
      navigating = false;
    }
  };

  // Back, forward and the Android back button arrive here, as does a native
  // request made before this script had loaded.
  const onLocationChange = async () => {
    const hash = currentHash();
    if (hash === appliedHash || navigating) return;
    navigating = true;
    try {
      if (await canLeave()) show(hash);
      else history.pushState(null, '', appliedHash);
    } finally {
      navigating = false;
    }
  };
  window.addEventListener('hashchange', onLocationChange);
  window.addEventListener('popstate', onLocationChange);

  // -------------------------------------------------------------------------
  // App bar and toast
  // -------------------------------------------------------------------------

  const setBar = ({
    back = null,
    title = '',
    meta = '',
    actions = [],
  } = {}) => {
    const heading = h('h1', { text: title });
    const metaLine = h('span', {
      class: 'app-bar-meta',
      text: meta,
      hidden: !meta,
    });
    barRoot.replaceChildren(
      ...[
        back
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-quiet bar-back',
                on: { click: back.action },
              },
              icon('back'),
              h('span', { text: back.label })
            )
          : null,
        h('div', { class: 'app-bar-title' }, heading, metaLine),
        h('div', { class: 'app-bar-actions' }, actions),
      ].filter(Boolean)
    );
    document.title =
      title && title !== 'HTTP Widgets'
        ? `${title} – HTTP Widgets`
        : 'HTTP Widgets';
    return {
      setTitle: (text) => {
        heading.textContent = text;
        document.title = `${text} – HTTP Widgets`;
      },
      setMeta: (text) => {
        metaLine.textContent = text;
        metaLine.hidden = !text;
      },
    };
  };

  const toast = (message, state = 'neutral') => {
    window.clearTimeout(toastTimer);
    toastRoot.textContent = message;
    toastRoot.dataset.state = state;
    toastRoot.classList.toggle('is-visible', Boolean(message));
    if (message) {
      toastTimer = window.setTimeout(
        () => toastRoot.classList.remove('is-visible'),
        state === 'error' ? 6000 : 3200
      );
    }
  };

  // -------------------------------------------------------------------------
  // Live values
  // -------------------------------------------------------------------------

  const poll = async () => {
    const generation = ++pollGeneration;
    try {
      const state = await window.api.listRequests();
      if (generation !== pollGeneration) return false;
      const requests = Array.isArray(state.requests) ? state.requests : [];
      Object.assign(store, {
        requests,
        paused: Boolean(state.paused),
        max: Number.isFinite(state.max) ? state.max : requests.length,
        loaded: true,
        error: null,
      });
      current?.view.update?.(store);
      return true;
    } catch (error) {
      if (generation !== pollGeneration) return false;
      console.error('Error loading values:', error);
      store.error = errorText(error, 'Could not read your values.');
      current?.view.update?.(store);
      return false;
    }
  };

  // Commands answer `{ ok: false, error }` for expected failures.
  const assertSuccessful = (response, fallback) => {
    if (response && response.ok === false) {
      throw new Error(response.error || fallback);
    }
    return response;
  };

  const app = {
    store,
    routes,
    go,
    poll,
    toast,
    setBar,
    assertSuccessful,
    atLimit: () => store.loaded && store.requests.length >= store.max,
    // What the add screen hands to the builder: starting values and whether
    // to fetch straight away. Read once, so a reload starts blank.
    setSeed: (seed) => {
      pendingSeed = seed;
    },
    takeSeed: () => {
      const seed = pendingSeed;
      pendingSeed = null;
      return seed;
    },
    closeWindow: () => window.api.close().catch(() => {}),
  };
  window.httpWidgets.app = app;

  // The native side opens a value from the tray menu through this. It has
  // already settled any unsaved edits, so the view is replaced outright.
  window.httpWidgets.open = (page) => {
    const hash = String(page || '').includes('#')
      ? String(page).slice(String(page).indexOf('#'))
      : '#/';
    return go(hash, { force: true });
  };

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (current?.view.onEscape?.()) return;
      // Phones have no window to put away; Escape there is a hardware
      // keyboard asking to go back.
      if (store.info.mobile) {
        if (current?.route.name !== 'home') go(routes.home());
      } else {
        app.closeWindow();
      }
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      if (current?.view.onSubmit) {
        event.preventDefault();
        current.view.onSubmit();
      }
    }
  });

  window.addEventListener('DOMContentLoaded', async () => {
    store.info = await window.appInfoReady;
    await poll();
    show(currentHash());
    window.setInterval(() => {
      if (document.visibilityState === 'visible') poll();
    }, POLL_MS);
  });

  // WebKit throttles JavaScript timers while iOS is inactive. Pull the latest
  // Rust state immediately when the scene returns instead of making the user
  // wait for an interval that may resume late or be coalesced by the system.
  const pollWhenVisible = () => {
    if (document.visibilityState === 'visible' && appliedHash !== null) poll();
  };
  window.addEventListener('focus', pollWhenVisible);
  window.addEventListener('pageshow', pollWhenVisible);
  document.addEventListener('visibilitychange', pollWhenVisible);
})();
