'use strict';

// Pure parsing and formatting helpers. Nothing in here touches Electron, the
// network or the filesystem, so it can all be unit tested directly.

const {
  FIELDS,
  UNTRIMMED_FIELDS,
  MIN_REFRESH_SECONDS,
  DEFAULT_REFRESH_SECONDS,
  UNAVAILABLE,
} = require('./constants');
const { MARKS } = require('./indicators');

const truncate = (text, max) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const toNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseDecimals = (raw) => {
  const decimals = toNumber(raw);
  if (decimals === null) return null;
  return Math.min(20, Math.max(0, Math.round(decimals)));
};

const parseRefreshSeconds = (raw, type) => {
  const kind = type === 'crypto' ? 'crypto' : 'http';
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_REFRESH_SECONDS[kind];
  }
  return Math.max(MIN_REFRESH_SECONDS[kind], Math.round(seconds));
};

const sanitizeConfig = (values) => {
  const clean = {};
  for (const field of FIELDS) {
    const raw = values && values[field] != null ? String(values[field]) : '';
    clean[field] = UNTRIMMED_FIELDS.has(field) ? raw : raw.trim();
  }
  clean.type = clean.type === 'crypto' ? 'crypto' : 'http';
  if (clean.timer) {
    clean.timer = String(parseRefreshSeconds(clean.timer, clean.type));
  }
  return clean;
};

// ---------------------------------------------------------------------------
// HTTP responses
// ---------------------------------------------------------------------------

const parseHeaders = (raw) => {
  const headers = {};
  String(raw || '')
    .split(/[\n,]/)
    .forEach((part) => {
      const index = part.indexOf(':');
      if (index === -1) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) headers[key] = value;
    });
  return headers;
};

const resolveJsonPath = (data, rawPath) => {
  const tokens = String(rawPath)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((token) => token.trim())
    .filter(Boolean);

  let value = data;
  for (const token of tokens) {
    if (value === null || typeof value !== 'object' || !(token in value)) {
      throw new Error(
        `JSON path "${rawPath}" not found in response (stopped at "${token}")`
      );
    }
    value = value[token];
  }
  return value;
};

const formatHttpValue = (raw, cfg) => {
  const multiplier = toNumber(cfg.multiplier);
  const decimals = parseDecimals(cfg.length);
  const numeric = toNumber(raw);

  let text;
  if (numeric !== null && (multiplier !== null || decimals !== null)) {
    const value = multiplier !== null ? numeric * multiplier : numeric;
    if (multiplier !== null) {
      // A multiplier also switches on locale formatting (12000 -> 12,000).
      const options =
        decimals !== null
          ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
          : {};
      text = value.toLocaleString(undefined, options);
    } else {
      text = value.toFixed(decimals);
    }
  } else {
    text =
      raw !== null && typeof raw === 'object'
        ? JSON.stringify(raw)
        : String(raw);
    // For non-numeric values "decimals" acts as a maximum length.
    if (decimals !== null && decimals > 0) text = text.slice(0, decimals);
  }

  return `${cfg.prefix || ''}${text}${cfg.suffix || ''}`;
};

// ---------------------------------------------------------------------------
// Money and percentages
// ---------------------------------------------------------------------------

const formatMoney = (value, currency, decimals) => {
  const code = String(currency || 'gbp').toUpperCase();
  const abs = Math.abs(value);
  let options;
  if (decimals !== null && decimals !== undefined) {
    options = {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    };
  } else if (abs > 0 && abs < 1) {
    options = { maximumSignificantDigits: 4 };
  } else {
    options = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  }
  try {
    return value.toLocaleString(undefined, {
      style: 'currency',
      currency: code,
      ...options,
    });
  } catch {
    // Not an ISO currency (e.g. "sats", "eth") – fall back to a plain number.
    return `${value.toLocaleString(undefined, options)} ${code}`;
  }
};

// A marker, not a glyph: the menu bar turns it into an icon or a character
// depending on what the user picked. See lib/indicators.js.
const directionMark = (value) => (value >= 0 ? MARKS.rise : MARKS.fall);

const formatPercent = (pct) =>
  Number.isFinite(pct)
    ? `${directionMark(pct)}${Math.abs(pct).toFixed(2)}%`
    : UNAVAILABLE;

// Money gained/lost over a period, given the percentage move and today's value.
const formatGain = (pct, current, currency, decimals) => {
  if (!Number.isFinite(pct)) return UNAVAILABLE;
  const previous = pct <= -100 ? 0 : current / (1 + pct / 100);
  const delta = current - previous;
  return `${directionMark(delta)}${formatMoney(Math.abs(delta), currency, decimals)}`;
};

// Replaces {placeholders} that we know about and leaves the rest alone, so a
// typo shows up in the menu bar rather than silently vanishing.
const renderTemplate = (template, values) =>
  String(template).replace(/\{(\w+)\}/g, (match, name) =>
    name in values ? values[name] : match
  );

module.exports = {
  formatGain,
  formatHttpValue,
  formatMoney,
  formatPercent,
  parseDecimals,
  parseHeaders,
  parseRefreshSeconds,
  renderTemplate,
  resolveJsonPath,
  sanitizeConfig,
  toNumber,
  truncate,
};
