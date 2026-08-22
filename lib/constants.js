'use strict';

// Values shared by the main process, the pure helpers in this folder and the
// tests. Anything that only the Electron side cares about stays in index.js.

// Requests are added and removed by the user. The cap only exists to keep the
// menu bar usable — a dozen values side by side is already unreadable.
const MAX_REQUESTS = 10;

// Settings before schema 2 had exactly three numbered slots (url1, coin2, …).
const LEGACY_CONFIG_COUNT = 3;

const FIELDS = [
  'type', // 'http' (default) or 'crypto'
  'label', // optional name shown in the menu instead of "Request N"
  // http
  'url',
  'headers',
  'json',
  'multiplier',
  // crypto
  'coin',
  'holdings',
  'currency',
  'template',
  // shared
  'length',
  'prefix',
  'suffix',
  'timer',
];
// Prefix and suffix keep their whitespace on purpose (" USD", "$ ").
const UNTRIMMED_FIELDS = new Set(['prefix', 'suffix']);

const MIN_REFRESH_SECONDS = { http: 5, crypto: 30 };
const DEFAULT_REFRESH_SECONDS = { http: 5, crypto: 60 };

// After repeated failures the refresh interval doubles, up to this multiple.
const MAX_BACKOFF_MULTIPLIER = 8;
const MAX_BACKOFF_SECONDS = 10 * 60;
// Having no network at all is not the endpoint's fault, so it is retried at a
// steady short interval rather than backed off.
const OFFLINE_RETRY_SECONDS = 15;

const REQUEST_TIMEOUT_MS = 15000;

const TITLE_SEPARATOR = ' | ';
const PLACEHOLDER_TITLE = 'HTTP Menu';
const PENDING_TITLE = '…';
const UNAVAILABLE = '–';
// One runaway response must not push every other menu bar icon off screen.
const MAX_ITEM_TITLE_CHARS = 40;
const MAX_TITLE_CHARS = 100;

// Bumped when a settings migration is added; see migrateSettings in index.js.
// 1: tidied junk keys and millisecond refresh values.
// 2: three numbered slots became a list of requests the user controls.
const SETTINGS_SCHEMA_VERSION = 2;

module.exports = {
  MAX_REQUESTS,
  LEGACY_CONFIG_COUNT,
  FIELDS,
  UNTRIMMED_FIELDS,
  MIN_REFRESH_SECONDS,
  DEFAULT_REFRESH_SECONDS,
  MAX_BACKOFF_MULTIPLIER,
  MAX_BACKOFF_SECONDS,
  OFFLINE_RETRY_SECONDS,
  REQUEST_TIMEOUT_MS,
  TITLE_SEPARATOR,
  PLACEHOLDER_TITLE,
  PENDING_TITLE,
  UNAVAILABLE,
  MAX_ITEM_TITLE_CHARS,
  MAX_TITLE_CHARS,
  SETTINGS_SCHEMA_VERSION,
};
