import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotFramePicker', {
  onInit: (cb: (payload: { mp4Path: string; sessionDir: string }) => void) =>
    ipcRenderer.on('framepicker:init', (_evt, payload) => cb(payload)),
  exportFrame: (timeSec: number, sessionDir: string) =>
    ipcRenderer.invoke('framepicker:export', { timeSec, sessionDir }),
});
