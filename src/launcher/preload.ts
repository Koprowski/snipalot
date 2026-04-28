import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotLauncher', {
  record: () => ipcRenderer.invoke('launcher:record'),
  screenshot: () => ipcRenderer.invoke('launcher:screenshot'),
  trade: () => ipcRenderer.invoke('launcher:trade'),
  cancel: () => ipcRenderer.invoke('launcher:cancel'),
  quit: () => ipcRenderer.invoke('launcher:quit'),
  /** Hide launcher to tray (app keeps running, hotkeys stay live).
      The X button on the launcher routes here, not to quit, so users
      who hit X expecting "minimize" don't accidentally kill the app. */
  closeToTray: () => ipcRenderer.invoke('launcher:close-to-tray'),
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
        | 'processing';
      sessionMode?: 'record' | 'trade';
      processingStep: string | null;
      startStopHotkey?: string;
    }) => void
  ) => ipcRenderer.on('launcher:state', (_evt, state) => cb(state)),
});
