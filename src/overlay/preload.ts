import { contextBridge, ipcRenderer } from 'electron';

export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Display id is baked into the URL by main when loading this overlay.
const params = new URLSearchParams(globalThis.location.search);
const myDisplayId = params.get('displayId') ?? 'unknown';

contextBridge.exposeInMainWorld('snipalot', {
  displayId: myDisplayId,
  log: (scope: string, ...args: unknown[]) =>
    ipcRenderer.invoke('log', `overlay:${myDisplayId}:${scope}`, ...args),
  setInteractive: (interactive: boolean) =>
    ipcRenderer.invoke('overlay:set-interactive', myDisplayId, interactive),
  focusWindow: () => ipcRenderer.invoke('overlay:focus', myDisplayId),
  confirmRegion: (rect: OverlayRect) =>
    ipcRenderer.invoke('overlay:region-confirmed', { displayId: myDisplayId, rect }),
  cancelRegion: () => ipcRenderer.invoke('overlay:region-cancelled', myDisplayId),
  /**
   * Push the current annotation list to main. Payload is JSON-compatible
   * (discriminated-union shapes v2).
   */
  syncAnnotations: (payload: {
    annotations: unknown[];
    recordingRegion: OverlayRect | null;
  }) => ipcRenderer.invoke('overlay:sync-annotations', payload),
  /**
   * Report a snapshot chapter to main (annotations accumulated since the last
   * 📸, plus the ms offset when the snapshot fired). Overlay has already
   * cleared its local annotation list and reset numbering before this call.
   */
  reportSnapshotChapter: (payload: { annotations: unknown[]; capturedAtMs: number }) =>
    ipcRenderer.invoke('overlay:report-snapshot-chapter', payload),
  /**
   * Report annotation-mode entry/exit so main can light up the HUD's
   * Annotate button (and any future affordances tied to mode state).
   */
  reportAnnotationMode: (active: boolean) =>
    ipcRenderer.invoke('overlay:annotation-mode-changed', { active }),
  onEnterAnnotationMode: (cb: () => void) =>
    ipcRenderer.on('overlay:enter-annotation-mode', cb),
  onEnterRegionSelect: (
    cb: (payload?: { countdownSec?: number; mode?: 'region' | 'fullscreen' }) => void
  ) => ipcRenderer.on('overlay:enter-region-select', (_evt, payload) => cb(payload)),
  onExitRegionSelect: (cb: () => void) =>
    ipcRenderer.on('overlay:exit-region-select', cb),
  onOwnsRecording: (cb: (payload: { rect: OverlayRect }) => void) =>
    ipcRenderer.on('overlay:owns-recording', (_evt, payload) => cb(payload)),
  onRecordingStarted: (
    cb: (payload: { startedAt: number; activeDisplayId: string | null }) => void
  ) => ipcRenderer.on('overlay:recording-started', (_evt, payload) => cb(payload)),
  onRecordingStopped: (cb: () => void) =>
    ipcRenderer.on('overlay:recording-stopped', cb),
  onToggleOutline: (cb: () => void) =>
    ipcRenderer.on('overlay:toggle-outline', cb),
  onGlobalUndo: (cb: () => void) => ipcRenderer.on('overlay:global-undo', cb),
  onGlobalClear: (cb: () => void) => ipcRenderer.on('overlay:global-clear', cb),
  onSnapshotReset: (cb: (payload: { clearAnnotations: boolean }) => void) =>
    ipcRenderer.on('overlay:snapshot-reset', (_evt, payload) =>
      // payload may be undefined for older callers; default to clear-after
      // so existing behavior is preserved.
      cb(payload ?? { clearAnnotations: true })
    ),
});
