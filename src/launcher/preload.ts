import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotLauncher', {
  record: () => ipcRenderer.invoke('launcher:record'),
  screenshot: () => ipcRenderer.invoke('launcher:screenshot'),
  trade: () => ipcRenderer.invoke('launcher:trade'),
  cancel: () => ipcRenderer.invoke('launcher:cancel'),
  quit: () => ipcRenderer.invoke('launcher:quit'),
  settings: () => ipcRenderer.invoke('launcher:settings'),
  toggleMinimize: () => ipcRenderer.invoke('launcher:toggle-minimize'),
  log: (scope: string, ...args: unknown[]) =>
    ipcRenderer.invoke('log', `launcher:${scope}`, ...args),
  onState: (
    cb: (state: {
      appState:
        | 'idle'
        | 'selecting'
        | 'selecting-screenshot'
        | 'selecting-trade'
        | 'recording'
        | 'trading'
        | 'processing';
      processingStep: string | null;
      startStopHotkey?: string;
    }) => void
  ) => ipcRenderer.on('launcher:state', (_evt, state) => cb(state)),
});
