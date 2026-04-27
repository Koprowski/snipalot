import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotHud', {
  pauseResume: () => ipcRenderer.invoke('hud:pause-resume'),
  stop: () => ipcRenderer.invoke('hud:stop'),
  /** Discard the in-progress recording (no save, no clipboard). Confirmed
      via a modal dialog in main before anything is destroyed. */
  discard: () => ipcRenderer.invoke('hud:discard'),
  toggleOutline: () => ipcRenderer.invoke('hud:toggle-outline'),
  enterAnnotation: () => ipcRenderer.invoke('hud:enter-annotation'),
  snap: () => ipcRenderer.invoke('hud:snap'),
  onState: (
    cb: (payload: { startedAt: number; paused: boolean; totalPausedMs: number }) => void
  ) => ipcRenderer.on('hud:state', (_evt, payload) => cb(payload)),
});
