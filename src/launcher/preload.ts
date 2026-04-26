import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotLauncher', {
  record: () => ipcRenderer.invoke('launcher:record'),
  cancel: () => ipcRenderer.invoke('launcher:cancel'),
  quit: () => ipcRenderer.invoke('launcher:quit'),
  settings: () => ipcRenderer.invoke('launcher:settings'),
  toggleMinimize: () => ipcRenderer.invoke('launcher:toggle-minimize'),
  log: (scope: string, ...args: unknown[]) =>
    ipcRenderer.invoke('log', `launcher:${scope}`, ...args),
  onState: (
    cb: (state: {
      appState: 'idle' | 'selecting' | 'recording' | 'processing';
      processingStep: string | null;
    }) => void
  ) => ipcRenderer.on('launcher:state', (_evt, state) => cb(state)),
});
