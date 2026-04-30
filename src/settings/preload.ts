import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotSettings', {
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('settings:get-config'),
  save: (partial: unknown): Promise<void> => ipcRenderer.invoke('settings:save', partial),
  testApiKeys: (payload: unknown): Promise<{ ok: boolean; message: string; provider?: string }> =>
    ipcRenderer.invoke('settings:test-api-keys', payload),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:pick-folder'),
  close: (): Promise<void> => ipcRenderer.invoke('settings:close'),
  log: (scope: string, ...args: unknown[]): Promise<void> =>
    ipcRenderer.invoke('log', scope, ...args),
});
