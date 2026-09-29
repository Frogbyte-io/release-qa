const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smoke', {
  load: () => ipcRenderer.invoke('load-value'),
  save: (value) => ipcRenderer.invoke('save-value', value),
  clear: () => ipcRenderer.invoke('clear-value'),
});
