const params = new URLSearchParams(window.location.search);
const configNumber = Number(params.get('n')) || 1;

const form = document.getElementById('configForm');
const fields = Array.from(form.querySelectorAll('[data-key]'));
const typeInputs = Array.from(form.querySelectorAll('input[name="type"]'));
const typedSections = Array.from(form.querySelectorAll('[data-type]'));
// The crypto layout shows its own "Decimals" box; it mirrors the shared field.
const mirrors = Array.from(form.querySelectorAll('[data-mirror]'));
const result = document.getElementById('testResult');
const saveButton = document.getElementById('saveConfig');
const testButton = document.getElementById('testConfig');
const clearButton = document.getElementById('clearConfig');

document.title = `Request ${configNumber} – HTTP Mac Menu`;
document.getElementById('heading').textContent = `Request ${configNumber}`;

const currentType = () =>
  (typeInputs.find((input) => input.checked) || {}).value || 'http';

const setType = (type) => {
  for (const input of typeInputs) input.checked = input.value === type;
  for (const section of typedSections) {
    section.classList.toggle('hidden', section.dataset.type !== type);
  }
};

const fieldByKey = (key) => fields.find((el) => el.dataset.key === key);

// Hide the sections for the other type straight away, before settings load.
setType(currentType());

const collect = () => ({
  ...Object.fromEntries(fields.map((el) => [el.dataset.key, el.value])),
  type: currentType(),
});

const showResult = (kind, text) => {
  const tone = {
    pending: 'bg-white/5 text-stone-300',
    ok: 'bg-emerald-500/15 text-emerald-300',
    error: 'bg-red-500/15 text-red-300',
  }[kind];
  result.textContent = text;
  result.className = `rounded-md px-4 py-3 text-sm break-words ${tone}`;
};

const hideResult = () => {
  result.className = 'hidden';
  result.textContent = '';
};

const setBusy = (busy) => {
  for (const button of [saveButton, testButton, clearButton]) {
    button.disabled = busy;
  }
};

const load = async () => {
  try {
    const config = await window.api.loadConfig(configNumber);
    for (const el of fields) el.value = config[el.dataset.key] ?? '';
    for (const el of mirrors) el.value = config[el.dataset.mirror] ?? '';
    setType(config.type === 'crypto' ? 'crypto' : 'http');
  } catch (error) {
    console.error('Error loading configuration:', error);
    showResult('error', `Could not load settings: ${error.message}`);
  }
};

const save = async () => {
  setBusy(true);
  try {
    await window.api.saveConfig(configNumber, collect());
  } catch (error) {
    console.error('Error saving configuration:', error);
    showResult('error', `Could not save: ${error.message}`);
    setBusy(false);
  }
};

const test = async () => {
  setBusy(true);
  showResult('pending', 'Testing…');
  try {
    const response = await window.api.testConfig(collect());
    if (response.ok) {
      showResult('ok', `Menu bar will show: ${response.value}`);
    } else {
      showResult('error', response.error);
    }
  } catch (error) {
    showResult('error', error.message);
  } finally {
    setBusy(false);
  }
};

const clear = async () => {
  const confirmed = window.confirm(
    `Remove Request ${configNumber} from the menu bar? This deletes its settings.`
  );
  if (!confirmed) return;
  setBusy(true);
  try {
    await window.api.clearConfig(configNumber);
  } catch (error) {
    console.error('Error clearing configuration:', error);
    showResult('error', `Could not clear: ${error.message}`);
    setBusy(false);
  }
};

form.addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});
testButton.addEventListener('click', test);
clearButton.addEventListener('click', clear);

for (const input of typeInputs) {
  input.addEventListener('change', () => {
    setType(currentType());
    hideResult();
  });
}

for (const el of fields) el.addEventListener('input', hideResult);

for (const mirror of mirrors) {
  const target = fieldByKey(mirror.dataset.mirror);
  mirror.addEventListener('input', () => {
    if (target) target.value = mirror.value;
    hideResult();
  });
  if (target) {
    target.addEventListener('input', () => {
      mirror.value = target.value;
    });
  }
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.api.close();
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    save();
  }
});

window.addEventListener('DOMContentLoaded', load);
