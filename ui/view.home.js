// Home answers one question: what is showing right now, and is it healthy?
// The surface at the top is the menu bar or widget as it stands; the list
// below is the same values with their names, trends and problems.
(() => {
  const { h, icon, button, iconButton, busy } = window.httpWidgets.dom;
  const { createSurface, notificationPanel } = window.httpWidgets.parts;
  const { sparkline } = window.httpWidgets.chart;
  const { errorText, plural } = window.httpWidgetsUi;

  const NOTIFICATION_ATTENTION = [
    'prompt',
    'denied',
    'unsupported',
    'error',
    'unknown',
  ];

  const rowState = (request) => {
    if (!request.ready) return { state: 'setup', label: 'Setup needed' };
    if (request.error) return { state: 'error', label: 'Needs attention' };
    if (request.value === null || request.value === undefined) {
      return { state: 'waiting', label: 'Waiting for the first reading' };
    }
    return { state: 'live', label: 'Live' };
  };

  const home = ({ root, app }) => {
    const { store } = app;

    const refreshButton = iconButton('refresh', 'Refresh all values', {
      on: {
        click: () =>
          busy(refreshButton, async () => {
            try {
              app.assertSuccessful(
                await window.api.refreshAll(),
                'The values could not be refreshed.'
              );
              await app.poll();
              app.toast('All values refreshed.', 'success');
            } catch (error) {
              app.toast(
                errorText(error, 'The values could not be refreshed.'),
                'error'
              );
            }
          }),
      },
    });
    const addButton = button(
      'Add',
      {
        class: 'btn btn-primary',
        'aria-label': 'Add a value',
        on: { click: () => app.go(app.routes.add()) },
      },
      icon('plus')
    );
    const bar = app.setBar({
      title: 'HTTP Widgets',
      actions: [
        refreshButton,
        iconButton('settings', 'Settings', {
          on: { click: () => app.go(app.routes.settings()) },
        }),
        addButton,
      ],
    });

    // Surface ---------------------------------------------------------------
    const surface = createSurface(store.info.platform);
    const copyButton = iconButton('copy', 'Copy all values', {
      class: 'btn icon-button surface-tool',
      on: {
        click: () =>
          busy(copyButton, async () => {
            try {
              app.assertSuccessful(
                await window.api.copyAllValues(),
                'The values could not be copied.'
              );
              app.toast('Copied all values.', 'success');
            } catch (error) {
              app.toast(
                errorText(error, 'The values could not be copied.'),
                'error'
              );
            }
          }),
      },
    });
    // Elsewhere the widget or tooltip is the same names and values as the
    // list, so only the macOS menu bar gets drawn.
    const showSurface = surface.layout === 'bar';
    if (showSurface) surface.tools.append(copyButton);

    // Things that need a decision -------------------------------------------
    const loadError = h('p', {
      class: 'notice notice-error',
      role: 'alert',
      hidden: true,
    });

    const resumeButton = button('Resume', {
      on: {
        click: () =>
          busy(resumeButton, async () => {
            try {
              app.assertSuccessful(
                await window.api.setUpdatesPaused(false),
                'Updates could not be resumed.'
              );
              await app.poll();
              app.toast('Updates resumed.', 'success');
            } catch (error) {
              app.toast(
                errorText(error, 'Updates could not be resumed.'),
                'error'
              );
            }
          }),
      },
    });
    const pausedBanner = h(
      'section',
      { class: 'banner', hidden: true, 'aria-labelledby': 'pausedHeading' },
      h(
        'div',
        { class: 'banner-copy' },
        h('h2', { id: 'pausedHeading', text: 'Updates are paused' }),
        h('p', { text: 'The last values stay on show until you resume.' })
      ),
      resumeButton
    );

    const backgroundBanner = h(
      'section',
      { class: 'banner', hidden: true, 'aria-labelledby': 'backgroundHeading' },
      h(
        'div',
        { class: 'banner-copy' },
        h('h2', { id: 'backgroundHeading', text: 'Background refresh is off' }),
        h('p', {
          text: 'Turn on Background App Refresh to let iOS fetch occasionally while the app is closed. Low Power Mode can also switch it off.',
        })
      ),
      button('Open Settings', {
        on: {
          click: async () => {
            try {
              await window.api.openNotificationSettings();
            } catch (error) {
              app.toast(
                errorText(
                  error,
                  'Settings could not be opened on this device.'
                ),
                'error'
              );
            }
          },
        },
      })
    );
    backgroundBanner.hidden = !(
      store.info.platform === 'ios' && store.info.backgroundRefresh === 'denied'
    );

    const notificationBanner = notificationPanel({
      title: 'Alerts cannot notify you yet',
    });
    notificationBanner.classList.add('banner');
    notificationBanner.hidden = true;

    // The list ---------------------------------------------------------------
    const count = h('span', { class: 'section-meta' });
    const list = h('ul', { class: 'row-list value-list', role: 'list' });
    const listSection = h(
      'section',
      { class: 'values', 'aria-labelledby': 'valuesHeading' },
      h(
        'div',
        { class: 'section-heading' },
        h('h2', { id: 'valuesHeading', text: 'Values' }),
        count,
        showSurface ? null : copyButton
      ),
      list
    );

    const welcome = h(
      'section',
      { class: 'welcome', hidden: true },
      h('h2', { text: 'Nothing pinned yet' }),
      h('p', {
        text:
          store.info.platform === 'macos'
            ? 'Choose something to keep an eye on. It appears in your menu bar as soon as you save it.'
            : 'Choose something to keep an eye on. It appears here and in your widgets as soon as you save it.',
      }),
      window.httpWidgets.startOptions(app)
    );

    const footnote = h('p', {
      class: 'footnote',
      text: store.info.version ? `HTTP Widgets ${store.info.version}` : '',
    });

    root.append(
      surface.element,
      loadError,
      pausedBanner,
      backgroundBanner,
      notificationBanner,
      listSection,
      welcome,
      footnote
    );

    // Rows are kept by id and patched in place, so a value that changes every
    // few seconds never steals focus or restarts a hover.
    const rows = new Map();

    const createRow = (request) => {
      const name = h('span', { class: 'row-title' });
      const detail = h('span', { class: 'row-detail' });
      const graph = h('span', {
        class: 'value-row-graph',
        'aria-hidden': 'true',
      });
      const value = h('span', { class: 'value-row-value' });
      const control = h(
        'button',
        {
          type: 'button',
          class: 'row-button value-row',
          on: { click: () => app.go(app.routes.value(request.id)) },
        },
        h('span', { class: 'state-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'row-copy' }, name, detail),
        graph,
        value,
        icon('forward', 'icon row-chevron')
      );
      const element = h('li', null, control);
      return { element, control, name, detail, graph, value, signature: '' };
    };

    const patchRow = (row, request) => {
      const { state, label } = rowState(request);
      const text = !request.ready ? 'Not set up' : (request.value ?? '…');
      const last = request.points?.[request.points.length - 1];
      const signature = JSON.stringify([
        request.name,
        text,
        request.error,
        request.failures,
        request.points?.length,
        last?.timestamp,
      ]);
      if (signature === row.signature) return;
      row.signature = signature;

      row.control.dataset.state = state;
      row.name.textContent = request.name;
      row.detail.textContent = request.error
        ? `${request.failures > 1 ? `Failed ${request.failures} times` : 'Update failed'}: ${request.error}`
        : state === 'live'
          ? ''
          : label;
      row.detail.hidden = !row.detail.textContent;
      row.value.textContent = text;
      row.control.setAttribute(
        'aria-label',
        `${request.name}, ${text}. ${label}.`
      );
      const graph = sparkline(request.points);
      row.graph.replaceChildren(...(graph ? [graph] : []));
    };

    const syncNotificationBanner = () => {
      const alerting = store.requests.some((request) => request.alerts > 0);
      notificationBanner.hidden = !(
        alerting &&
        NOTIFICATION_ATTENTION.includes(
          notificationBanner.dataset.notificationState
        )
      );
    };
    window.addEventListener('notifications:updated', syncNotificationBanner);

    const update = () => {
      const { requests } = store;
      loadError.hidden = !store.error;
      loadError.textContent = store.error
        ? `${store.error} Trying again every few seconds.`
        : '';

      const empty = store.loaded && requests.length === 0;
      welcome.hidden = !empty;
      listSection.hidden = empty || !store.loaded;
      surface.element.hidden = empty || !store.loaded || !showSurface;
      pausedBanner.hidden = !store.paused || empty;
      addButton.disabled = app.atLimit();
      addButton.title = app.atLimit()
        ? `You have ${store.max} values, the most this app keeps.`
        : '';
      refreshButton.disabled =
        refreshButton.getAttribute('aria-busy') === 'true' ||
        !requests.some((request) => request.ready);
      copyButton.disabled =
        copyButton.getAttribute('aria-busy') === 'true' ||
        !requests.some((request) => request.ready && request.value);

      const failing = requests.filter((request) => request.error).length;
      bar.setMeta(
        store.paused
          ? 'Updates paused'
          : failing === 1
            ? '1 value needs attention'
            : failing > 1
              ? `${plural(failing, 'value')} need attention`
              : ''
      );
      count.textContent = `${requests.length} of ${store.max}`;

      surface.update({
        items: requests
          .filter((request) => request.ready)
          .map((request) => ({
            id: request.id,
            name: request.name,
            value: request.value,
            error: request.error,
          })),
        message: store.paused ? 'paused' : 'now',
      });

      const seen = new Set();
      requests.forEach((request, index) => {
        seen.add(request.id);
        let row = rows.get(request.id);
        if (!row) {
          row = createRow(request);
          rows.set(request.id, row);
        }
        patchRow(row, request);
        if (list.children[index] !== row.element) {
          list.insertBefore(row.element, list.children[index] || null);
        }
      });
      for (const [id, row] of rows) {
        if (!seen.has(id)) {
          row.element.remove();
          rows.delete(id);
        }
      }
      syncNotificationBanner();
    };

    return {
      update,
      unmount: () =>
        window.removeEventListener(
          'notifications:updated',
          syncNotificationBanner
        ),
    };
  };

  window.httpWidgets.views = window.httpWidgets.views || {};
  window.httpWidgets.views.home = home;
})();
