import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type QaBridge } from '../shared/contract.ts';

// The whole surface the window gets. It is built from the allowlist, so there is no generic "send" to misuse.
const qa: QaBridge = {
  loadDashboard: () => ipcRenderer.invoke(CHANNELS.loadDashboard),
  prepareCandidate: (target) => ipcRenderer.invoke(CHANNELS.prepareCandidate, target),
  previewMerge: (target) => ipcRenderer.invoke(CHANNELS.previewMerge, target),
  mergePullRequest: (request) => ipcRenderer.invoke(CHANNELS.mergePullRequest, request),
  openPullRequest: (target) => ipcRenderer.invoke(CHANNELS.openPullRequest, target),
};

contextBridge.exposeInMainWorld('qa', qa);
