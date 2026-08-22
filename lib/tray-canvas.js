'use strict';

// Builds the page that is rendered offscreen and handed to the tray as an
// image. Pure string building — the Electron side owns the window.

const { MARK_PATTERN, iconSvg } = require('./indicators');

// Menu bar metrics, in points. The page is built at `scale` times these so the
// result is crisp on a retina display.
const BAR_HEIGHT = 22;
const FONT_SIZE = 13;
const ICON_GAP = 3;
const ITEM_GAP = 11;
const EDGE_PAD = 1;

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]
  );

// A value is text with direction markers scattered through it; each marker
// becomes an inline icon and everything else is escaped as text.
const itemHtml = (text, style, scale) => {
  let html = '';
  let lastIndex = 0;
  const value = String(text);
  MARK_PATTERN.lastIndex = 0;

  for (const match of value.matchAll(MARK_PATTERN)) {
    html += escapeHtml(value.slice(lastIndex, match.index));
    html += iconSvg(style, match[0], scale);
    lastIndex = match.index + match[0].length;
  }
  html += escapeHtml(value.slice(lastIndex));
  return `<span class="item">${html}</span>`;
};

const buildBarHtml = (items, style, scale) => {
  const px = (points) => Math.round(points * scale);
  const body = items.map((text) => itemHtml(text, style, scale)).join('');

  return (
    '<!doctype html><meta charset="utf-8"><style>' +
    'html,body{margin:0;background:transparent}' +
    `#bar{display:inline-flex;align-items:center;height:${px(BAR_HEIGHT)}px;` +
    `font:500 ${px(FONT_SIZE)}px -apple-system,"SF Pro Text",system-ui;` +
    `color:#000;white-space:nowrap;padding:0 ${px(EDGE_PAD)}px}` +
    `.item{display:inline-flex;align-items:center;gap:${px(ICON_GAP)}px}` +
    `.item+.item{margin-left:${px(ITEM_GAP)}px}` +
    'svg{display:block;flex:none}' +
    `</style><div id="bar">${body}</div>`
  );
};

module.exports = { BAR_HEIGHT, buildBarHtml, escapeHtml, itemHtml };
