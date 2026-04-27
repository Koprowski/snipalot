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
  /**
   * Fires when the overlay enters / exits annotation mode. Lets the HUD
   * highlight (or un-highlight) the ✎ button so the user has a visual
   * cue that the toggle is currently active.
   */
  onAnnotationState: (cb: (payload: { active: boolean }) => void) =>
    ipcRenderer.on('hud:annotation-state', (_evt, payload) => cb(payload)),
});
