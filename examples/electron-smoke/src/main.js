const { app, BrowserWindow, ipcMain } = require('electron');
const { promises: fs } = require('node:fs');
const path = require('node:path');

// The same contract as the Tauri sample: the value lives in `setting.txt` in the app's data directory, and the page
// always shows what was read back from disk.
app.setName('release-qa-electron-smoke');
const settingFile = () => path.join(app.getPath('userData'), 'setting.txt');

ipcMain.handle('load-value', async () => {
  try {
    return await fs.readFile(settingFile(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
});
ipcMain.handle('save-value', async (_event, value) => {
  await fs.mkdir(path.dirname(settingFile()), { recursive: true });
  await fs.writeFile(settingFile(), String(value));
});
ipcMain.handle('clear-value', async () => {
  await fs.rm(settingFile(), { force: true });
});

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    title: 'Release QA Electron Smoke',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.removeMenu();
  window.loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
