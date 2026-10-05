// The whole app is drawn with these few helpers: no framework, no templates
// from strings. Text always goes in as text, so API responses and names can
// never become markup.
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Set as DOM properties; everything else is an attribute.
  const PROPERTIES = new Set([
    'value',
    'checked',
    'disabled',
    'hidden',
    'id',
    'type',
    'name',
    'placeholder',
    'rows',
    'htmlFor',
    'title',
    'open',
    'selected',
    'inputMode',
    'readOnly',
    'required',
    'tabIndex',
    'spellcheck',
  ]);

  const append = (parent, ...children) => {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      parent.append(
        child instanceof Node ? child : document.createTextNode(String(child))
      );
    }
    return parent;
  };

  const assign = (element, props) => {
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) {
        if (key === 'hidden' || key === 'disabled') element[key] = false;
        continue;
      }
      if (key === 'class') element.setAttribute('class', value);
      else if (key === 'text') element.textContent = value;
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else if (key === 'on') {
        for (const [type, listener] of Object.entries(value)) {
          element.addEventListener(type, listener);
        }
      } else if (PROPERTIES.has(key)) element[key] = value;
      else element.setAttribute(key, value === true ? '' : String(value));
    }
    return element;
  };

  const h = (tag, props, ...children) =>
    append(assign(document.createElement(tag), props), ...children);

  const svg = (tag, props, ...children) =>
    append(assign(document.createElementNS(SVG_NS, tag), props), ...children);

  // Stroke icons on a 24px grid, used only where a control has no room for a
  // word or where a mark carries state.
  const ICONS = {
    plus: ['M12 5v14', 'M5 12h14'],
    back: ['M15 5l-7 7 7 7'],
    forward: ['M9 5l7 7-7 7'],
    down: ['M5 9l7 7 7-7'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    refresh: [
      'M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5',
      'M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5',
    ],
    settings: [
      'M4 7h9',
      'M17 7h3',
      'M4 17h3',
      'M11 17h9',
      'M15 5v4',
      'M9 15v4',
    ],
    copy: [
      'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z',
      'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    ],
    up: ['M12 19V5', 'M6 11l6-6 6 6'],
    remove: [
      'M4 7h16',
      'M10 11v6',
      'M14 11v6',
      'M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12',
      'M9 7V4h6v3',
    ],
    warning: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17.2v.3'],
    search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M16 16l4.5 4.5'],
  };

  const icon = (name, className = 'icon') => {
    const element = svg('svg', {
      class: className,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    });
    for (const d of ICONS[name] || []) element.append(svg('path', { d }));
    return element;
  };

  const button = (label, props = {}, ...children) =>
    h('button', { type: 'button', class: 'btn', ...props }, ...children, label);

  const iconButton = (name, label, props = {}) =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn icon-button',
        'aria-label': label,
        title: label,
        ...props,
      },
      icon(name)
    );

  // Show a control as working while its promise is pending, and never let it
  // start the same work twice.
  const busy = async (control, work) => {
    if (control.getAttribute('aria-busy') === 'true') return undefined;
    const wasDisabled = control.disabled;
    control.setAttribute('aria-busy', 'true');
    control.disabled = true;
    try {
      return await work();
    } finally {
      control.removeAttribute('aria-busy');
      control.disabled = wasDisabled;
    }
  };

  const insertAtCaret = (input, text) => {
    const start = input.selectionStart ?? input.value.length;
    input.setRangeText(text, start, input.selectionEnd ?? start, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };

  window.httpWidgets = window.httpWidgets || {};
  window.httpWidgets.dom = {
    h,
    svg,
    append,
    icon,
    button,
    iconButton,
    busy,
    insertAtCaret,
  };
})();
