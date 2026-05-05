import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotLauncher', {
  record: () => ipcRenderer.invoke('launcher:record'),
  screenshot: () => ipcRenderer.invoke('launcher:screenshot'),
  trade: () => ipcRenderer.invoke('launcher:trade'),
  cancel: () => ipcRenderer.invoke('launcher:cancel'),
  abandonProcessing: () => ipcRenderer.invoke('launcher:abandon-processing'),
  quit: () => ipcRenderer.invoke('launcher:quit'),
  /** Legacy hide-to-tray IPC, retained for compatibility with older renderer code. */
  closeToTray: () => ipcRenderer.invoke('launcher:close-to-tray'),
  /** Toggle launcher's alwaysOnTop pin. Returns the new state so the
      renderer can sync its visual indicator. */
  togglePin: (): Promise<boolean> => ipcRenderer.invoke('launcher:toggle-pin'),
  /** Read the current pin state on boot so the button starts in sync. */
  getPinState: (): Promise<boolean> => ipcRenderer.invoke('launcher:get-pin-state'),
  getCaptureMode: (): Promise<'region' | 'fullscreen' | 'window'> =>
    ipcRenderer.invoke('launcher:get-capture-mode'),
  setCaptureMode: (mode: 'region' | 'fullscreen' | 'window'): Promise<'region' | 'fullscreen' | 'window'> =>
    ipcRenderer.invoke('launcher:set-capture-mode', mode),
  /** Copy the most recent session's prompt back to the clipboard. Useful
      when the user pasted something else over the auto-copied prompt. */
  copyLastPrompt: (): Promise<
    | { ok: true; kind: 'record' | 'trade' | 'screenshot'; sessionName: string; chars: number }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('launcher:copy-last-prompt'),
  copySupportLog: (): Promise<
    | { ok: true; mode: 'file' | 'text'; path: string; bytes: number }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('launcher:copy-support-log'),
  settings: () => ipcRenderer.invoke('launcher:settings'),
  exitApp: (): Promise<boolean> => ipcRenderer.invoke('settings:exit-app'),
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
      processingProgress?: { pct: number; etaSec: number; elapsedSec: number } | null;
      processingStep: string | null;
      startStopHotkey?: string;
      snapshotHotkey?: string;
      startTradeHotkey?: string;
      tradeMarkerHotkey?: string;
      captureMode?: 'region' | 'fullscreen' | 'window';
      visibleActions?: { record: boolean; screenshot: boolean; trade: boolean };
      canAbandonProcessing?: boolean;
    }) => void
  ) => ipcRenderer.on('launcher:state', (_evt, state) => cb(state)),
});
