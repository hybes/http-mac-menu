'use strict';

// Rise / fall / warning are decided while a value is formatted, but drawn much
// later — either as an icon in the menu bar image or as a text glyph. So the
// formatter leaves a marker behind and this module turns it into whichever the
// user has chosen. Control characters are used as the markers because they
// cannot show up in a real response or in a user's template.

const MARKS = { rise: '\u0001', fall: '\u0002', warn: '\u0003' };
const MARK_PATTERN = /[\u0001-\u0003]/g;

const TEXT_GLYPH = {
  [MARKS.rise]: '▴',
  [MARKS.fall]: '▾',
  [MARKS.warn]: '⚠',
};

// Anywhere a value is shown as plain text — menu items, tooltips, the log, the
// clipboard — the markers become ordinary characters.
const toText = (value) =>
  String(value).replace(MARK_PATTERN, (mark) => TEXT_GLYPH[mark] || '');

const INDICATOR_STYLES = [
  { id: 'chevron', label: 'Chevron' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'text', label: 'Text' },
];

const DEFAULT_INDICATOR = 'chevron';

const isIndicatorStyle = (id) =>
  INDICATOR_STYLES.some((style) => style.id === id);

const normalizeIndicator = (id) =>
  isIndicatorStyle(id) ? id : DEFAULT_INDICATOR;

// Every icon is drawn on the same 10x10 grid so the styles line up with one
// another and with the text beside them.
const PATHS = {
  chevron: {
    size: 9,
    stroke: 1.7,
    up: 'M1.6 6.4 L5 3 L8.4 6.4',
    down: 'M1.6 3.6 L5 7 L8.4 3.6',
  },
  arrow: {
    size: 9,
    stroke: 1.6,
    up: 'M5 8.2 L5 2.2 M2.2 5 L5 2.2 L7.8 5',
    down: 'M5 1.8 L5 7.8 M2.2 5 L5 7.8 L7.8 5',
  },
  triangle: {
    size: 8,
    fill: true,
    stroke: 1.2,
    up: 'M5 2.3 L8.1 7.5 L1.9 7.5 Z',
    down: 'M5 7.7 L1.9 2.5 L8.1 2.5 Z',
  },
};

// A warning sign at the same weight as the direction icons.
const WARNING = {
  size: 10,
  stroke: 1.3,
  path: 'M5 1.7 L9.1 8.6 L0.9 8.6 Z M5 4.2 L5 6.1 M5 7.4 L5 7.5',
};

const svg = (px, stroke, d, fill) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 10 10">` +
  `<path fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor"` +
  ` stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"` +
  ` d="${d}"/></svg>`;

const iconSvg = (styleId, mark, scale) => {
  if (mark === MARKS.warn) {
    return svg(Math.round(WARNING.size * scale), WARNING.stroke, WARNING.path);
  }
  const spec = PATHS[normalizeIndicator(styleId)] || PATHS.chevron;
  return svg(
    Math.round(spec.size * scale),
    spec.stroke,
    mark === MARKS.fall ? spec.down : spec.up,
    spec.fill
  );
};

module.exports = {
  DEFAULT_INDICATOR,
  INDICATOR_STYLES,
  MARKS,
  MARK_PATTERN,
  iconSvg,
  isIndicatorStyle,
  normalizeIndicator,
  toText,
};
