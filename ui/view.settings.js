// Everything that belongs to the app rather than to one value. Each setting
// saves itself as it changes; there is nothing to submit.
(() => {
  const { h, button, busy } = window.httpWidgets.dom;
  const { notificationPanel, switchControl, choiceGroup } =
    window.httpWidgets.parts;
  const { errorText } = window.httpWidgetsUi;

  const LOG_REFRESH_MS = 10_000;

  const group = (id, title, ...children) =>
    h(
      'section',
      { class: 'settings-group', 'aria-labelledby': id },
      h('h2', { id, text: title }),
      h('div', { class: 'settings-rows' }, ...children)
    );

  const settings = ({ root, app }) => {
    const { store } = app;
    const { platform, mobile } = store.info;

    app.setBar({
      back: { label: 'Values', action: () => app.go(app.routes.home()) },
      title: 'Settings',
    });

    // Menu bar or tray -------------------------------------------------------
    const surfaceName = platform === 'macos' ? 'Menu bar' : 'Tray';
    const surfaceRows = h('div', { class: 'settings-rows' });
    const surfaceGroup = h(
      'section',
      {
        class: 'settings-group',
        'aria-labelledby': 'surfaceHeading',
        hidden: true,
      },
      h('h2', { id: 'surfaceHeading', text: surfaceName }),
      surfaceRows
    );

    const buildSurfaceRows = (preferences) => {
      const rows = [];

      if (Array.isArray(preferences.indicatorStyles)) {
        const error = h('span', {
          class: 'field-error',
          role: 'alert',
          hidden: true,
        });
        let confirmed = preferences.indicator;
        const marks = choiceGroup({
          label: 'Rise and fall marks',
          value: preferences.indicator,
          options: preferences.indicatorStyles.map((style) => ({
            value: style.id,
            label: `${style.rise} ${style.fall}`,
            detail: style.label,
          })),
          onChange: async (style) => {
            error.hidden = true;
            try {
              confirmed = await window.api.setIndicatorStyle(style);
              marks.select(confirmed);
            } catch (failure) {
              marks.select(confirmed);
              error.textContent = errorText(
                failure,
                'The marks could not be changed.'
              );
              error.hidden = false;
            }
          },
        });
        marks.element.classList.add('mark-choices');
        rows.push(
          h(
            'div',
            { class: 'setting-row setting-stack' },
            h(
              'span',
              { class: 'setting-copy' },
              h('span', {
                class: 'setting-label',
                text: 'Rise and fall marks',
              }),
              h('span', {
                class: 'hint',
                text:
                  platform === 'macos'
                    ? 'How a crypto price shows its direction in the menu bar. Menus and widgets keep the Text style.'
                    : 'How a crypto price shows its direction in the tray.',
              })
            ),
            marks.element,
            error
          )
        );
      }

      const link = h('input', {
        class: 'input',
        id: 'trayLink',
        type: 'text',
        placeholder: 'https://example.com/dashboard',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: false,
        'aria-describedby': 'trayLinkHint trayLinkError',
      });
      link.value = preferences.trayLink ?? '';
      const linkError = h('span', {
        class: 'field-error',
        id: 'trayLinkError',
        role: 'alert',
        hidden: true,
        text: 'Enter a link that starts with http:// or https://.',
      });
      link.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          link.blur();
        }
      });
      link.addEventListener('change', async () => {
        try {
          const saved = await window.api.setTrayLink(link.value);
          link.value = saved ?? '';
          linkError.hidden = true;
          link.removeAttribute('aria-invalid');
          app.toast(
            saved
              ? 'Left click now opens that link.'
              : 'Left click opens the menu.',
            'success'
          );
        } catch {
          linkError.hidden = false;
          link.setAttribute('aria-invalid', 'true');
        }
      });
      rows.push(
        h(
          'div',
          { class: 'setting-row setting-stack' },
          h('label', {
            class: 'setting-label',
            htmlFor: 'trayLink',
            text: 'Left click opens',
          }),
          link,
          h('span', {
            class: 'hint',
            id: 'trayLinkHint',
            text:
              platform === 'linux'
                ? 'A dashboard or any other link. Linux trays only support menus, so the menu stays on both buttons.'
                : 'A dashboard or any other link. The menu moves to right click. Leave it empty to keep the menu on left click.',
          }),
          linkError
        )
      );

      if (typeof preferences.launchAtLogin === 'boolean') {
        rows.push(
          switchControl({
            label: 'Launch at login',
            checked: preferences.launchAtLogin,
            onChange: (enabled) => window.api.setLaunchAtLogin(enabled),
          }).element
        );
      }
      if (typeof preferences.showInDock === 'boolean') {
        rows.push(
          switchControl({
            label: 'Show in Dock',
            hint: 'Off, the app appears in the Dock only while this window is open.',
            checked: preferences.showInDock,
            onChange: (enabled) => window.api.setShowInDock(enabled),
          }).element
        );
      }
      surfaceRows.replaceChildren(...rows);
      surfaceGroup.hidden = false;
    };

    // Updates ----------------------------------------------------------------
    const pause = switchControl({
      label: 'Pause updates',
      hint: 'The last values stay on show. Refreshing by hand still works.',
      checked: store.paused,
      onChange: async (paused) => {
        const result = app.assertSuccessful(
          await window.api.setUpdatesPaused(paused),
          'Updates could not be changed.'
        );
        await app.poll();
        return Boolean(result?.paused ?? paused);
      },
    });
    const updatesGroup = group('updatesHeading', 'Updates', pause.element);

    // Notifications ----------------------------------------------------------
    const notifications = group(
      'notificationsHeading',
      'Notifications',
      h(
        'div',
        { class: 'setting-row setting-stack' },
        notificationPanel({ title: 'Alerts on this device' })
      )
    );

    // Activity ---------------------------------------------------------------
    const log = h('pre', { class: 'log', tabindex: '0', text: 'Loading…' });
    const loadLog = async () => {
      try {
        const body = await window.api.readLog();
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
        log.textContent = body || 'Nothing logged yet.';
        if (atEnd) log.scrollTop = log.scrollHeight;
      } catch (error) {
        log.textContent = errorText(
          error,
          'The activity log could not be read.'
        );
      }
    };
    const copyLog = button('Copy', {
      on: {
        click: () =>
          busy(copyLog, async () => {
            try {
              await navigator.clipboard.writeText(log.textContent);
              app.toast('Activity copied.', 'success');
            } catch {
              app.toast('Select the text to copy it.', 'error');
            }
          }),
      },
    });
    const activity = group(
      'activityHeading',
      'Recent activity',
      h(
        'div',
        { class: 'setting-row setting-stack' },
        h('span', {
          class: 'hint',
          text: 'Every fetch, alert and background refresh, newest last. Useful when a value is not behaving.',
        }),
        log,
        h('div', { class: 'action-row' }, copyLog)
      )
    );

    // About ------------------------------------------------------------------
    const link = (text, target) =>
      button(text, {
        on: {
          click: () => window.api.openProjectLink(target).catch(() => {}),
        },
      });
    const about = group(
      'aboutHeading',
      'About',
      h(
        'div',
        { class: 'setting-row setting-stack' },
        h('span', {
          class: 'setting-label',
          text: store.info.version
            ? `HTTP Widgets ${store.info.version}`
            : 'HTTP Widgets',
        }),
        h('span', {
          class: 'hint',
          text: 'Fetching, formatting and alerts all run on this device. There is no server and no account.',
        }),
        h(
          'div',
          { class: 'action-row' },
          link('GitHub', 'repo'),
          link('Releases', 'releases'),
          link('Support', 'support')
        )
      )
    );

    const loadError = h('p', {
      class: 'notice notice-error',
      role: 'alert',
      hidden: true,
    });

    root.append(
      h(
        'div',
        { class: 'settings-page' },
        loadError,
        surfaceGroup,
        updatesGroup,
        notifications,
        activity,
        about
      )
    );

    if (!mobile) {
      window.api
        .preferences()
        .then(buildSurfaceRows)
        .catch((error) => {
          loadError.textContent = errorText(
            error,
            `The ${surfaceName.toLowerCase()} settings could not be read.`
          );
          loadError.hidden = false;
        });
    }

    loadLog();
    const logTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadLog();
    }, LOG_REFRESH_MS);

    return {
      update: () => {
        if (!pause.input.disabled) pause.input.checked = store.paused;
      },
      unmount: () => window.clearInterval(logTimer),
    };
  };

  window.httpWidgets.views = window.httpWidgets.views || {};
  window.httpWidgets.views.settings = settings;
})();
