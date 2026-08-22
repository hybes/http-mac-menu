'use strict';

// The list of requests the user has set up. Pure: the caller owns loading and
// saving, this only decides what a valid list looks like.

const {
  FIELDS,
  MAX_REQUESTS,
  LEGACY_CONFIG_COUNT,
  MIN_REFRESH_SECONDS,
} = require('./constants');
const { sanitizeConfig } = require('./format');

// Before schema 1 the refresh interval was written in milliseconds even though
// the UI asked for seconds.
const LEGACY_MS_THRESHOLD = 1000;

// A request counts as set up once it has the one field its type needs; until
// then it is not fetched and shows as "not set up".
const isConfigured = (request) =>
  Boolean(
    String(
      (request.type === 'crypto' ? request.coin : request.url) ?? ''
    ).trim()
  );

// Ids only have to be unique and stable, so the lowest free one will do — that
// keeps them short and makes tests predictable.
const nextId = (requests) => {
  const used = new Set(requests.map((request) => request.id));
  for (let i = 1; ; i += 1) {
    if (!used.has(`r${i}`)) return `r${i}`;
  }
};

const makeRequest = (values, existing = []) => ({
  id: nextId(existing),
  ...sanitizeConfig(values || {}),
});

// Anything read back from disk goes through here, so a hand-edited or
// half-written settings file cannot take the app down.
const normalizeRequests = (raw) => {
  if (!Array.isArray(raw)) return [];
  const requests = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id =
      typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim()
        : nextId(requests);
    if (requests.some((request) => request.id === id)) continue;
    requests.push({ id, ...sanitizeConfig(entry) });
    if (requests.length >= MAX_REQUESTS) break;
  }
  return requests;
};

// Only for settings that predate schema 1 — later ones already hold seconds,
// and a legitimate 1800 second interval must survive untouched.
const convertLegacyMillisecondTimers = (stored) => {
  const fixed = { ...stored };
  for (let n = 1; n <= LEGACY_CONFIG_COUNT; n += 1) {
    const raw = Number(fixed[`timer${n}`]);
    if (Number.isFinite(raw) && raw >= LEGACY_MS_THRESHOLD) {
      fixed[`timer${n}`] = String(
        Math.max(MIN_REFRESH_SECONDS.http, Math.round(raw / 1000))
      );
    }
  }
  return fixed;
};

// Schema 1 stored three fixed slots as flat `${field}${n}` keys. Slots that
// were never filled in are dropped rather than carried over as blanks.
const migrateNumberedSettings = (stored) => {
  const requests = [];
  for (let n = 1; n <= LEGACY_CONFIG_COUNT; n += 1) {
    const values = sanitizeConfig(
      Object.fromEntries(FIELDS.map((field) => [field, stored[`${field}${n}`]]))
    );
    if (isConfigured(values)) requests.push(makeRequest(values, requests));
  }
  return requests;
};

// What to call a request in the menu: its name, or its position in the list.
const displayName = (request, index) =>
  String(request.label || '').trim() || `Request ${index + 1}`;

module.exports = {
  convertLegacyMillisecondTimers,
  displayName,
  isConfigured,
  makeRequest,
  migrateNumberedSettings,
  nextId,
  normalizeRequests,
};
