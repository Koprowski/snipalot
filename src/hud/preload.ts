import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotHud', {
  pauseResume: () => ipcRenderer.invoke('hud:pause-resume'),
  stop: () => ipcRenderer.invoke('hud:stop'),
  toggleOutline: () => ipcRenderer.invoke('hud:toggle-outline'),
  enterAnnotation: () => ipcRenderer.invoke('hud:enter-annotation'),
  snap: () => ipcRenderer.invoke('hud:snap'),
  onState: (
    cb: (payload: { startedAt: number; paused: boolean; totalPausedMs: number }) => void
  ) => ipcRenderer.on('hud:state', (_evt, payload) => cb(payload)),
});
