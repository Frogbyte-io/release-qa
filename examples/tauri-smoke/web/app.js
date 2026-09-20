const { invoke } = window.__TAURI__.core;

const input = document.getElementById('setting-input');
const saved = document.getElementById('saved-value');
const status = document.getElementById('status');

async function refresh() {
  // The displayed value is always read back through the native command so the
  // UI reflects what is on disk, not what was typed.
  const value = await invoke('load_value');
  saved.textContent = value ?? '';
  return value;
}

async function run(action) {
  try {
    await action();
    status.textContent = '';
  } catch (error) {
    status.textContent = `Error: ${error}`;
  }
}

document.getElementById('save-button').addEventListener('click', () =>
  run(async () => {
    await invoke('save_value', { value: input.value });
    await refresh();
  }),
);

document.getElementById('clear-button').addEventListener('click', () =>
  run(async () => {
    await invoke('clear_value');
    input.value = '';
    await refresh();
  }),
);

run(refresh);
