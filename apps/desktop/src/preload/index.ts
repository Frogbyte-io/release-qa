import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type QaBridge } from '../shared/contract.ts';

// The whole surface the window gets. It is built from the allowlist, so there is no generic "send" to misuse.
const qa: QaBridge = {
  loadDashboard: () => ipcRenderer.invoke(CHANNELS.loadDashboard),
};

contextBridge.exposeInMainWorld('qa', qa);
