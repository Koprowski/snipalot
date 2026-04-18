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
  syncAnnotations: (payload: {
    annotations: Array<{
      number: number;
      x: number;
      y: number;
      w: number;
      h: number;
      drawnAtMs: number;
    }>;
    recordingRegion: OverlayRect | null;
  }) => ipcRenderer.invoke('overlay:sync-annotations', payload),
  onEnterAnnotationMode: (cb: () => void) =>
    ipcRenderer.on('overlay:enter-annotation-mode', cb),
  onEnterRegionSelect: (cb: () => void) =>
    ipcRenderer.on('overlay:enter-region-select', cb),
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
});
