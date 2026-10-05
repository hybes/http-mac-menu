// One value, watched: what it says now, how it has moved, and how it is put
// together. Each line of the setup opens the builder at that step.
(() => {
  const { h, icon, button, busy } = window.httpWidgets.dom;
  const { createTrend, relativeTime } = window.httpWidgets.chart;
  const {
    errorText,
    describeSource,
    describeProvider,
    describeField,
    describeDisplay,
    describeInterval,
    describeAlerts,
    effectiveTimer,
  } = window.httpWidgetsUi;

  const value = ({ root, route, app }) => {
    const { store } = app;
    const id = route.id;
    let config = null;
    let missingSince = null;

    const find = () => store.requests.find((request) => request.id === id);

    const editButton = button('Edit', {
      class: 'btn btn-primary',
      on: { click: () => app.go(app.routes.edit(id)) },
    });
    const bar = app.setBar({
      back: { label: 'Values', action: () => app.go(app.routes.home()) },
      title: find()?.name || 'Value',
      actions: [editButton],
    });

    // Now --------------------------------------------------------------------
    const stateLine = h('p', { class: 'value-state' });
    const reading = h('p', { class: 'value-reading' });
    const problem = h('p', {
      class: 'notice notice-error',
      role: 'alert',
      hidden: true,
    });

    const act = (control, work, done, failed) =>
      busy(control, async () => {
        try {
          app.assertSuccessful(await work(), failed);
          await app.poll();
          app.toast(done, 'success');
        } catch (error) {
          app.toast(errorText(error, failed), 'error');
        }
      });

    const copyButton = button('Copy', {
      on: {
        click: () =>
          act(
            copyButton,
            () => window.api.copyRequestValue(id),
            'Copied.',
            'The value could not be copied.'
          ),
      },
    });
    const refreshButton = button('Refresh now', {
      on: {
        click: () =>
          act(
            refreshButton,
            () => window.api.refreshRequestNow(id),
            'Refreshed.',
            'The value could not be refreshed.'
          ),
      },
    });

    const now = h(
      'section',
      { class: 'value-now', 'aria-label': 'Current value' },
      stateLine,
      reading,
      problem,
      h('div', { class: 'action-row' }, copyButton, refreshButton)
    );

    // Trend ------------------------------------------------------------------
    const trend = createTrend();
    const trendSection = h(
      'section',
      { class: 'value-section', 'aria-labelledby': 'trendHeading' },
      h(
        'div',
        { class: 'section-heading' },
        h('h2', { id: 'trendHeading', text: 'Last 24 hours' })
      ),
      trend.element
    );

    // Setup ------------------------------------------------------------------
    const setupList = h('ol', { class: 'row-list setup-list' });
    const setupStatus = h('p', {
      class: 'status',
      role: 'status',
      text: 'Loading setup…',
    });
    const setupSection = h(
      'section',
      { class: 'value-section', 'aria-labelledby': 'setupHeading' },
      h(
        'div',
        { class: 'section-heading' },
        h('h2', { id: 'setupHeading', text: 'How it is made' })
      ),
      setupList,
      setupStatus
    );

    const setupRow = (step, title, detail) =>
      h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            class: 'row-button setup-row',
            'aria-label': `${title}: ${detail}. Edit.`,
            on: { click: () => app.go(app.routes.edit(id, step)) },
          },
          h('span', { class: 'setup-term', text: title }),
          h('span', { class: 'setup-detail', text: detail }),
          icon('forward', 'icon row-chevron')
        )
      );

    const renderSetup = () => {
      if (!config) return;
      const values = config.values || {};
      const crypto = values.type === 'crypto';
      setupStatus.hidden = true;
      setupList.replaceChildren(
        ...[
          crypto
            ? setupRow(
                'source',
                'Coin',
                `${describeSource(values)} · ${describeProvider(values)}`
              )
            : setupRow('source', 'Source', describeSource(values)),
          crypto ? null : setupRow('value', 'Value', describeField(values)),
          setupRow('display', 'Display', describeDisplay(values)),
          setupRow(
            'refresh',
            'Refresh',
            describeInterval(effectiveTimer(values))
          ),
          setupRow('alerts', 'Alerts', describeAlerts(values)),
        ].filter(Boolean)
      );
    };

    const loadSetup = async () => {
      try {
        const loaded = await window.api.loadConfig(id);
        if (loaded.isNew) return;
        config = loaded;
        renderSetup();
        update();
      } catch (error) {
        setupStatus.dataset.state = 'error';
        setupStatus.textContent = errorText(
          error,
          'The setup could not be read.'
        );
      }
    };

    // Housekeeping -----------------------------------------------------------
    const duplicateButton = button('Duplicate', {
      on: {
        click: () =>
          busy(duplicateButton, async () => {
            try {
              const loaded = await window.api.loadConfig(id);
              const values = JSON.parse(JSON.stringify(loaded.values || {}));
              const name = String(values.label || find()?.name || '').trim();
              values.label = `${name || 'Value'} copy`;
              app.assertSuccessful(
                await window.api.saveConfig('new', values),
                'The value could not be duplicated.'
              );
              await app.poll();
              app.toast(`Added ${values.label}.`, 'success');
              app.go(app.routes.home(), { force: true });
            } catch (error) {
              app.toast(
                errorText(error, 'The value could not be duplicated.'),
                'error'
              );
            }
          }),
      },
    });
    const removeButton = button('Remove', {
      class: 'btn btn-danger',
      on: {
        click: () =>
          busy(removeButton, async () => {
            const name = find()?.name || 'this value';
            try {
              if (!(await window.api.confirmRemove(name))) return;
              app.assertSuccessful(
                await window.api.removeConfig(id),
                'The value could not be removed.'
              );
              await app.poll();
              app.toast(`Removed ${name}.`, 'success');
              app.go(app.routes.home(), { force: true, replace: true });
            } catch (error) {
              app.toast(
                errorText(error, 'The value could not be removed.'),
                'error'
              );
            }
          }),
      },
    });
    const housekeeping = h(
      'div',
      { class: 'action-row action-row-end' },
      duplicateButton,
      removeButton
    );

    const gone = h(
      'section',
      { class: 'welcome', hidden: true },
      h('h2', { text: 'This value is no longer here' }),
      h('p', { text: 'It may have been removed from the menu.' }),
      button('Back to values', {
        class: 'btn btn-primary',
        on: { click: () => app.go(app.routes.home(), { replace: true }) },
      })
    );

    const content = h(
      'div',
      { class: 'value-page' },
      now,
      trendSection,
      setupSection,
      housekeeping
    );
    root.append(content, gone);

    const update = () => {
      const request = find();
      if (!request) {
        // A poll can land between a save and the list catching up.
        if (!store.loaded) return;
        missingSince = missingSince ?? Date.now();
        if (Date.now() - missingSince < 2500) return;
        content.hidden = true;
        gone.hidden = false;
        editButton.hidden = true;
        return;
      }
      missingSince = null;
      content.hidden = false;
      gone.hidden = true;
      editButton.hidden = false;
      bar.setTitle(request.name);

      const interval = config
        ? describeInterval(effectiveTimer(config.values || {})).toLowerCase()
        : '';
      const updated = relativeTime(
        request.updatedAt > 0 ? request.updatedAt : null
      );
      let state = 'live';
      let words = 'Live';
      if (!request.ready) {
        state = 'setup';
        words = 'Setup needed';
      } else if (request.error) {
        state = 'error';
        words = 'Needs attention';
      } else if (store.paused) {
        state = 'paused';
        words = 'Paused';
      } else if (request.value === null || request.value === undefined) {
        state = 'waiting';
        words = 'Waiting for the first reading';
      }
      now.dataset.state = state;
      stateLine.replaceChildren(
        h('span', { class: 'state-dot', 'aria-hidden': 'true' }),
        [
          words,
          state === 'live' && interval ? interval : null,
          request.updatedAt > 0 ? `updated ${updated.label}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      );
      if (updated.exact) stateLine.title = updated.exact;

      reading.textContent = !request.ready
        ? 'Not set up'
        : (request.value ?? '…');
      problem.hidden = !request.error;
      const sentence = request.error
        ? /[.!?]$/.test(request.error)
          ? request.error
          : `${request.error}.`
        : '';
      problem.textContent = request.error
        ? `${request.failures > 1 ? `The last ${request.failures} updates failed` : 'The last update failed'}: ${sentence}${request.value ? ' Showing the last good value.' : ''}`
        : '';

      copyButton.disabled =
        copyButton.getAttribute('aria-busy') === 'true' || !request.value;
      refreshButton.disabled =
        refreshButton.getAttribute('aria-busy') === 'true' || !request.ready;
      duplicateButton.disabled =
        duplicateButton.getAttribute('aria-busy') === 'true' || app.atLimit();
      duplicateButton.title = app.atLimit()
        ? `You have ${store.max} values, the most this app keeps.`
        : '';

      trend.update(request.points, {
        name: request.name,
        ready: request.ready,
      });
    };

    loadSetup();

    return {
      update,
      unmount: () => trend.destroy(),
    };
  };

  window.httpWidgets.views = window.httpWidgets.views || {};
  window.httpWidgets.views.value = value;
})();
