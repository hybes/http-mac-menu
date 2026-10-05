// Pieces more than one view draws: the miniature of the surface a value ends
// up on, notification controls, switches and single-choice groups.
(() => {
  const { h, button } = window.httpWidgets.dom;
  const { titleItem, TITLE_SEPARATOR } = window.httpWidgetsUi;

  const surfaceKind = (platform) => {
    if (platform === 'macos') return { layout: 'bar', caption: 'Menu bar' };
    if (platform === 'ios' || platform === 'android') {
      return { layout: 'rows', caption: 'Widget' };
    }
    return { layout: 'rows', caption: 'Tray tooltip' };
  };

  // A drawing of where values are shown: the macOS menu bar as one line of
  // text, or the name and value rows of a widget or tray tooltip. The builder
  // marks the value being edited; everything else is dimmed around it.
  const createSurface = (platform) => {
    const kind = surfaceKind(platform);
    const caption = h('span', { class: 'surface-caption', text: kind.caption });
    const note = h('span', { class: 'surface-note' });
    const tools = h('span', { class: 'surface-tools' });
    const heading = h(
      'div',
      { class: 'surface-heading' },
      caption,
      note,
      tools
    );
    const title = h('div', { class: 'surface-title' });
    const clock = h('time', { class: 'surface-clock', 'aria-hidden': 'true' });
    const screen = h(
      'div',
      { class: `surface-screen surface-${kind.layout}` },
      title,
      kind.layout === 'bar' ? clock : null
    );
    const element = h('div', { class: 'surface' }, heading, screen);

    let signature = '';

    const update = ({ items = [], currentId = null, message = '' } = {}) => {
      clock.textContent = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date());
      note.textContent = message;

      const next = JSON.stringify([items, currentId]);
      if (next === signature) return;
      signature = next;
      element.dataset.focused = String(currentId !== null);

      // A widget or tooltip can run to ten rows; while one value is being
      // built, its own row is the whole picture.
      const shown =
        kind.layout === 'rows' && currentId !== null
          ? items.filter((item) => item.id === currentId)
          : items;
      const nodes = [];
      let current = null;
      shown.forEach((item, index) => {
        const text = titleItem(item);
        const isCurrent = item.id === currentId;
        let node;
        if (kind.layout === 'bar') {
          if (index > 0) {
            nodes.push(
              h('span', {
                class: 'surface-separator',
                text: TITLE_SEPARATOR,
                'aria-hidden': 'true',
              })
            );
          }
          node = h('span', { class: 'surface-item', text });
        } else {
          node = h(
            'div',
            { class: 'surface-item' },
            h('span', { class: 'surface-item-name', text: item.name }),
            h('span', { class: 'surface-item-value', text })
          );
        }
        if (isCurrent) {
          node.classList.add('is-current');
          current = node;
        }
        if (item.error) node.classList.add('is-error');
        if (item.pending) node.classList.add('is-pending');
        nodes.push(node);
      });
      if (!nodes.length) {
        nodes.push(
          h('span', { class: 'surface-item is-empty', text: 'HTTP Widgets' })
        );
      }
      title.replaceChildren(...nodes);
      title.setAttribute(
        'aria-label',
        `${kind.caption}: ${items.map(titleItem).join(TITLE_SEPARATOR) || 'empty'}`
      );
      if (current && kind.layout === 'bar') {
        current.scrollIntoView({ block: 'nearest', inline: 'center' });
      }
    };

    return {
      element,
      tools,
      update,
      layout: kind.layout,
      caption: kind.caption,
    };
  };

  // Markup contract for notifications.js: one panel, a message and two buttons.
  const notificationPanel = ({
    title = 'Notifications',
    inline = false,
  } = {}) =>
    h(
      'section',
      {
        class: `notification-panel${inline ? ' notification-panel-inline' : ''}`,
        'data-notification-controls': '',
      },
      h(
        'div',
        { class: 'notification-copy' },
        h(
          'h3',
          { class: 'notification-title' },
          h('span', { class: 'notification-indicator', 'aria-hidden': 'true' }),
          title
        ),
        h('p', {
          class: 'notification-message',
          'data-notification-message': '',
          role: 'status',
          'aria-live': 'polite',
          text: 'Checking notification access…',
        })
      ),
      h(
        'div',
        { class: 'notification-actions' },
        button('Enable', { 'data-notification-enable': '' }),
        button('Send test', { 'data-notification-test': '', disabled: true })
      )
    );

  const switchControl = ({ label, hint = '', checked = false, onChange }) => {
    const input = h('input', {
      type: 'checkbox',
      class: 'switch-input',
      role: 'switch',
      checked,
    });
    const status = h('span', {
      class: 'field-error',
      role: 'alert',
      hidden: true,
    });
    input.addEventListener('change', async () => {
      const wanted = input.checked;
      input.disabled = true;
      status.hidden = true;
      try {
        const result = await onChange(wanted);
        if (typeof result === 'boolean') input.checked = result;
      } catch (error) {
        input.checked = !wanted;
        status.textContent = window.httpWidgetsUi.errorText(
          error,
          'That setting could not be changed.'
        );
        status.hidden = false;
      } finally {
        input.disabled = false;
      }
    });
    const element = h(
      'label',
      { class: 'setting-row setting-switch' },
      h(
        'span',
        { class: 'setting-copy' },
        h('span', { class: 'setting-label', text: label }),
        hint ? h('span', { class: 'hint', text: hint }) : null,
        status
      ),
      input,
      h('span', { class: 'switch-track', 'aria-hidden': 'true' })
    );
    return { element, input };
  };

  // One choice from a few. Chips for short answers, a segmented control for a
  // mode, a list when each answer needs a line of explanation. `options` are
  // [value, label] pairs or { value, label, detail } objects.
  const CHOICE_CLASSES = {
    chips: ['choice-chips', 'choice-chip'],
    segmented: ['segmented', 'segment'],
    list: ['choice-list', 'choice-option'],
  };

  const choiceGroup = ({
    label,
    options,
    value,
    onChange,
    variant = 'chips',
  }) => {
    const [groupClass, itemClass] = CHOICE_CLASSES[variant];
    const element = h('div', {
      class: groupClass,
      role: 'group',
      'aria-label': label,
    });
    let selected = value;
    const choices = options.map((option) => {
      const item = Array.isArray(option)
        ? { value: option[0], label: option[1] }
        : option;
      const labelNode = h('span', { class: 'choice-label', text: item.label });
      const detailNode = h('span', {
        class: 'choice-detail',
        text: item.detail || '',
        hidden: !item.detail,
      });
      const control = h(
        'button',
        {
          type: 'button',
          class: itemClass,
          dataset: { value: String(item.value) },
          on: {
            click: () => {
              select(item.value);
              onChange(item.value);
            },
          },
        },
        variant === 'list'
          ? h('span', { class: 'choice-copy' }, labelNode, detailNode)
          : [labelNode, detailNode]
      );
      element.append(control);
      return { item, control, labelNode, detailNode };
    });
    const select = (next) => {
      selected = next;
      for (const { item, control } of choices) {
        control.setAttribute('aria-pressed', String(item.value === selected));
      }
    };
    const setHidden = (predicate) => {
      for (const { item, control } of choices) {
        control.hidden = Boolean(predicate(item.value));
      }
    };
    const relabel = (target, text, detail) => {
      const choice = choices.find(({ item }) => item.value === target);
      if (!choice) return;
      choice.labelNode.textContent = text;
      if (detail !== undefined) {
        choice.detailNode.textContent = detail;
        choice.detailNode.hidden = !detail;
      }
    };
    select(value);
    return { element, select, setHidden, relabel, value: () => selected };
  };

  window.httpWidgets.parts = {
    createSurface,
    notificationPanel,
    switchControl,
    choiceGroup,
  };
})();
