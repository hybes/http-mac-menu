const params = new URLSearchParams(window.location.search);
// 'new' until the request has been saved and given an id of its own.
let requestId = params.get('id') || 'new';
let slotName = 'Request';

const form = document.getElementById('configForm');
const fields = Array.from(form.querySelectorAll('[data-key]'));
const typeInputs = Array.from(form.querySelectorAll('input[name="type"]'));
const typedSections = Array.from(form.querySelectorAll('[data-type]'));
// The crypto layout shows its own "Decimals" box; it mirrors the shared field.
const mirrors = Array.from(form.querySelectorAll('[data-mirror]'));
const statusLine = document.getElementById('status');
const saveButton = document.getElementById('saveConfig');
const testButton = document.getElementById('testConfig');
const removeButton = document.getElementById('removeConfig');

const labelField = fields.find((el) => el.dataset.key === 'label');
const timerField = fields.find((el) => el.dataset.key === 'timer');

// Matches DEFAULT_REFRESH_SECONDS in lib/constants.js.
const DEFAULT_TIMER = { http: '5', crypto: '60' };

const heading = document.getElementById('heading');

// Until it is named, a request is known by its place in the menu.
const applySlot = (position) => {
  slotName = `Request ${position}`;
  heading.textContent = slotName;
  if (labelField) labelField.placeholder = slotName;
  for (const el of document.querySelectorAll('[data-slot-name]')) {
    el.textContent = slotName;
  }
};

const currentType = () =>
  (typeInputs.find((input) => input.checked) || {}).value || 'http';

const setType = (type) => {
  for (const input of typeInputs) input.checked = input.value === type;
  for (const section of typedSections) {
    section.hidden = section.dataset.type !== type;
  }
  // The default refresh differs per type, so the greyed-out hint should too.
  if (timerField) timerField.placeholder = DEFAULT_TIMER[type] || '5';
};

const fieldByKey = (key) => fields.find((el) => el.dataset.key === key);

// Hide the sections for the other type straight away, before settings load.
setType(currentType());

const collect = () => ({
  ...Object.fromEntries(fields.map((el) => [el.dataset.key, el.value])),
  type: currentType(),
});

// ---------------------------------------------------------------------------
// Native window chrome
// ---------------------------------------------------------------------------

// The window is sized to its content so it never scrolls. Anything that can
// change the height — swapping type, opening the placeholder list, a long
// error — goes through here.
let fitQueued = false;
const fit = () => {
  if (fitQueued) return;
  fitQueued = true;
  // A timer rather than requestAnimationFrame: the first fit happens while the
  // window is still hidden, and frames are throttled until it is shown.
  setTimeout(async () => {
    fitQueued = false;
    try {
      const { clamped } = await window.api.fitWindow(
        document.body.scrollHeight
      );
      // Only a screen too short for the form brings scrolling back.
      document.body.style.overflowY = clamped ? 'auto' : 'hidden';
    } catch {
      /* the window is closing */
    }
  }, 0);
};

// Catch-all for anything that changes the height without going through the
// handlers below — a wrapped error message, a late font, a longer hint.
new ResizeObserver(fit).observe(document.body);

// Pick readable text for accent colours across the spectrum (a yellow accent
// needs black, the default blue needs white).
const contrastingText = (r, g, b) =>
  (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#000' : '#fff';

const applyAccent = async () => {
  try {
    const raw = await window.api.accentColor();
    if (!raw || !/^[0-9a-f]{6,8}$/i.test(raw)) return;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
    const root = document.documentElement.style;
    root.setProperty('--accent', `#${raw.slice(0, 6)}`);
    root.setProperty('--accent-text', contrastingText(r, g, b));
  } catch {
    /* keep the default blue */
  }
};

// ---------------------------------------------------------------------------
// Status line — a test result if there is one, otherwise the unsaved marker
// ---------------------------------------------------------------------------

let savedSnapshot = JSON.stringify(collect());
let testMessage = null; // { kind, text }

const isDirty = () => JSON.stringify(collect()) !== savedSnapshot;

const renderStatus = () => {
  const message =
    testMessage ||
    (isDirty() ? { kind: 'dirty', text: 'Unsaved changes' } : null);
  statusLine.textContent = message ? message.text : '';
  statusLine.className = message ? `status status-${message.kind}` : 'status';
  fit();
};

const setTestMessage = (kind, text) => {
  testMessage = kind ? { kind, text } : null;
  renderStatus();
};

const markSaved = () => {
  savedSnapshot = JSON.stringify(collect());
  renderStatus();
};

const updateTitle = () => {
  const name = (labelField ? labelField.value.trim() : '') || slotName;
  document.title = `${name} – HTTP Mac Menu`;
};

const setBusy = (busy) => {
  for (const button of [saveButton, testButton, removeButton]) {
    button.disabled = busy;
  }
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const load = async () => {
  try {
    const config = await window.api.loadConfig(requestId);
    requestId = config.id;
    applySlot(config.position);
    // A request that has never been saved has nothing to remove.
    removeButton.hidden = config.isNew;
    const values = config.values || {};
    for (const el of fields) el.value = values[el.dataset.key] ?? '';
    for (const el of mirrors) el.value = values[el.dataset.mirror] ?? '';
    setType(values.type === 'crypto' ? 'crypto' : 'http');
  } catch (error) {
    console.error('Error loading configuration:', error);
    setTestMessage('error', `Could not load settings: ${error.message}`);
  } finally {
    updateTitle();
    markSaved();
  }
};

const save = async () => {
  setBusy(true);
  try {
    const response = await window.api.saveConfig(requestId, collect());
    if (response && response.ok === false) {
      setTestMessage('error', response.error);
      setBusy(false);
      return;
    }
    markSaved();
  } catch (error) {
    console.error('Error saving configuration:', error);
    setTestMessage('error', `Could not save: ${error.message}`);
    setBusy(false);
  }
};

const test = async () => {
  setBusy(true);
  setTestMessage('dirty', 'Testing…');
  try {
    const response = await window.api.testConfig(collect());
    if (response.ok) {
      setTestMessage('ok', `Shows: ${response.value}`);
    } else {
      setTestMessage('error', response.error);
    }
  } catch (error) {
    setTestMessage('error', error.message);
  } finally {
    setBusy(false);
  }
};

const remove = async () => {
  const name = (labelField ? labelField.value.trim() : '') || slotName;
  const confirmed = window.confirm(
    `Remove ${name} from the menu bar? This deletes its settings.`
  );
  if (!confirmed) return;
  setBusy(true);
  try {
    await window.api.removeConfig(requestId);
  } catch (error) {
    console.error('Error removing request:', error);
    setTestMessage('error', `Could not remove: ${error.message}`);
    setBusy(false);
  }
};

const close = () => {
  if (isDirty() && !window.confirm('Discard unsaved changes?')) return;
  window.api.close();
};

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});
testButton.addEventListener('click', test);
removeButton.addEventListener('click', remove);

for (const input of typeInputs) {
  input.addEventListener('change', () => {
    setType(currentType());
    setTestMessage(null);
  });
}

for (const el of fields) {
  el.addEventListener('input', () => setTestMessage(null));
}

if (labelField) labelField.addEventListener('input', updateTitle);

for (const mirror of mirrors) {
  const target = fieldByKey(mirror.dataset.mirror);
  mirror.addEventListener('input', () => {
    if (target) target.value = mirror.value;
    setTestMessage(null);
  });
  if (target) {
    target.addEventListener('input', () => {
      mirror.value = target.value;
    });
  }
}

// Opening the placeholder list changes the height.
for (const details of document.querySelectorAll('details')) {
  details.addEventListener('toggle', fit);
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    close();
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    save();
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  applyAccent();
  await load();
  fit();
});
// Fonts and late layout can shift the height after DOMContentLoaded.
window.addEventListener('load', fit);
