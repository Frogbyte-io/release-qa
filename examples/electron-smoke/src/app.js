const input = document.getElementById('setting-input');
const saved = document.getElementById('saved-value');
const status = document.getElementById('status');

async function refresh() {
  // The displayed value is always read back from disk through the main process, not taken from what was typed.
  const value = await window.smoke.load();
  saved.textContent = value ?? '';
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
    await window.smoke.save(input.value);
    await refresh();
  }),
);

document.getElementById('clear-button').addEventListener('click', () =>
  run(async () => {
    await window.smoke.clear();
    input.value = '';
    await refresh();
  }),
);

run(refresh);
