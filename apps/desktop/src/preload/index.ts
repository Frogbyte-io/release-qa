import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, EVENTS, type QaBridge, type RunStatus } from '../shared/contract.ts';

// The whole surface the window gets. It is built from the allowlist, so there is no generic "send" to misuse.
const qa: QaBridge = {
  loadDashboard: () => ipcRenderer.invoke(CHANNELS.loadDashboard),
  prepareCandidate: (target) => ipcRenderer.invoke(CHANNELS.prepareCandidate, target),
  previewMerge: (target) => ipcRenderer.invoke(CHANNELS.previewMerge, target),
  mergePullRequest: (request) => ipcRenderer.invoke(CHANNELS.mergePullRequest, request),
  openPullRequest: (target) => ipcRenderer.invoke(CHANNELS.openPullRequest, target),
  loadManualCheck: (target) => ipcRenderer.invoke(CHANNELS.loadManualCheck, target),
  pickEvidence: () => ipcRenderer.invoke(CHANNELS.pickEvidence),
  recordManualCheck: (request) => ipcRenderer.invoke(CHANNELS.recordManualCheck, request),
  syncManualResult: (request) => ipcRenderer.invoke(CHANNELS.syncManualResult, request),
  claimManualCheck: (request) => ipcRenderer.invoke(CHANNELS.claimManualCheck, request),
  runOnLinux: (request) => ipcRenderer.invoke(CHANNELS.runOnLinux, request),
  listRemoteRuns: (target) => ipcRenderer.invoke(CHANNELS.listRemoteRuns, target),
  getCheckout: (repository) => ipcRenderer.invoke(CHANNELS.getCheckout, repository),
  chooseCheckout: (repository) => ipcRenderer.invoke(CHANNELS.chooseCheckout, repository),
  previewRun: (request) => ipcRenderer.invoke(CHANNELS.previewRun, request),
  startRun: (request) => ipcRenderer.invoke(CHANNELS.startRun, request),
  cancelRun: () => ipcRenderer.invoke(CHANNELS.cancelRun),
  getRunStatus: () => ipcRenderer.invoke(CHANNELS.getRunStatus),
  listRuns: (target) => ipcRenderer.invoke(CHANNELS.listRuns, target),
  syncRun: (request) => ipcRenderer.invoke(CHANNELS.syncRun, request),
  // The listener gets the status only, never the IPC event object; and only the one named event can reach it.
  onRunStatus: (listener) => {
    const handler = (_event: unknown, status: RunStatus): void => listener(status);
    ipcRenderer.on(EVENTS.runStatus, handler);
    return () => { ipcRenderer.removeListener(EVENTS.runStatus, handler); };
  },
};

contextBridge.exposeInMainWorld('qa', qa);
