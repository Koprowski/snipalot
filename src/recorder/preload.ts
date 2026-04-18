import { contextBridge, ipcRenderer } from 'electron';

export interface RegionSelection {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

contextBridge.exposeInMainWorld('snipalotRecorder', {
  getOutputPath: () => ipcRenderer.invoke('recorder:get-output-path'),
  saveWebm: (payload: { buffer: ArrayBuffer; filepath: string }) =>
    ipcRenderer.invoke('recorder:save-webm', payload),
  reportState: (state: 'started' | 'stopped' | 'error', detail?: string) =>
    ipcRenderer.invoke('recorder:state', state, detail),
  onStart: (cb: (region: RegionSelection) => void) =>
    ipcRenderer.on('recorder:start', (_evt, region) => cb(region)),
  onStop: (cb: () => void) => ipcRenderer.on('recorder:stop', cb),
  onPause: (cb: () => void) => ipcRenderer.on('recorder:pause', cb),
  onResume: (cb: () => void) => ipcRenderer.on('recorder:resume', cb),
});
