import { contextBridge, ipcRenderer } from 'electron';
import type { MicDiagnosticsPayload } from '../shared/mic-diagnostics';

export interface RegionSelection {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

contextBridge.exposeInMainWorld('snipalotRecorder', {
  /** Lines land in main snipalot.log (same file as other scopes). */
  mainLog: (line: string) => ipcRenderer.invoke('log', 'recorder', line),
  /** Lower fullscreen overlays so Windows' screen-share picker is not hidden behind them. */
  prepareDisplayCapture: () => ipcRenderer.invoke('recorder:prepare-display-capture'),
  /** Restore overlay always-on-top after getDisplayMedia completes or fails. */
  restoreDisplayCapture: () => ipcRenderer.invoke('recorder:restore-display-capture'),
  getOutputPath: () => ipcRenderer.invoke('recorder:get-output-path'),
  saveWebm: (payload: { buffer: ArrayBuffer; filepath: string }) =>
    ipcRenderer.invoke('recorder:save-webm', payload),
  reportState: (
    state: 'started' | 'stopped' | 'error',
    detail?: string,
    micDiagnostics?: MicDiagnosticsPayload
  ) => ipcRenderer.invoke('recorder:state', state, detail, micDiagnostics),
  reportSnap: (buffer: ArrayBuffer | null) =>
    ipcRenderer.send('recorder:snap-result', buffer),
  onStart: (cb: (region: RegionSelection) => void) =>
    ipcRenderer.on('recorder:start', (_evt, region) => cb(region)),
  onStop: (cb: () => void) => ipcRenderer.on('recorder:stop', cb),
  onPause: (cb: () => void) => ipcRenderer.on('recorder:pause', cb),
  onResume: (cb: () => void) => ipcRenderer.on('recorder:resume', cb),
  onSnap: (cb: () => void) => ipcRenderer.on('recorder:snap', _evt => cb()),
});
