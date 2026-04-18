import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotLauncher', {
  record: () => ipcRenderer.invoke('launcher:record'),
  cancel: () => ipcRenderer.invoke('launcher:cancel'),
  quit: () => ipcRenderer.invoke('launcher:quit'),
  toggleMinimize: () => ipcRenderer.invoke('launcher:toggle-minimize'),
  log: (scope: string, ...args: unknown[]) =>
    ipcRenderer.invoke('log', `launcher:${scope}`, ...args),
  onState: (cb: (state: { appState: 'idle' | 'selecting' | 'recording' }) => void) =>
    ipcRenderer.on('launcher:state', (_evt, state) => cb(state)),
  onMinimized: (cb: (minimized: boolean) => void) =>
    ipcRenderer.on('launcher:minimized', (_evt, minimized) => cb(minimized)),
});
