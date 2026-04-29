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
  /** Toggle launcher's alwaysOnTop pin. Returns the new state so the
      renderer can sync its visual indicator. */
  togglePin: (): Promise<boolean> => ipcRenderer.invoke('launcher:toggle-pin'),
  /** Read the current pin state on boot so the button starts in sync. */
  getPinState: (): Promise<boolean> => ipcRenderer.invoke('launcher:get-pin-state'),
  /** Copy the most recent session's prompt back to the clipboard. Useful
      when the user pasted something else over the auto-copied prompt. */
  copyLastPrompt: (): Promise<
    | { ok: true; kind: 'record' | 'trade' | 'screenshot'; sessionName: string; chars: number }
    | { ok: false; error: string }
  > => ipcRenderer.invoke('launcher:copy-last-prompt'),
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
      processingProgress?: { pct: number; etaSec: number; elapsedSec: number } | null;
      processingStep: string | null;
      startStopHotkey?: string;
    }) => void
  ) => ipcRenderer.on('launcher:state', (_evt, state) => cb(state)),
});
