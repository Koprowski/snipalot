import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotSettings', {
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('settings:get-config'),
  save: (partial: unknown): Promise<void> => ipcRenderer.invoke('settings:save', partial),
  testTradeApiKeys: (payload: unknown): Promise<{
    triedAny: boolean;
    geminiTried: boolean;
    geminiOk: boolean;
    geminiMessage: string;
    openaiTried: boolean;
    openaiOk: boolean;
    openaiLabel: string;
    openaiMessage: string;
    anyOk: boolean;
  }> => ipcRenderer.invoke('settings:test-api-keys', payload),
  getAppInfo: (): Promise<{ version: string; platform: string }> =>
    ipcRenderer.invoke('settings:get-app-info'),
  checkForUpdates: (): Promise<{
    ok: boolean;
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    releaseUrl: string | null;
    message: string;
  }> => ipcRenderer.invoke('settings:check-for-updates'),
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('settings:open-url', url),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:pick-folder'),
  close: (): Promise<void> => ipcRenderer.invoke('settings:close'),
  log: (scope: string, ...args: unknown[]): Promise<void> =>
    ipcRenderer.invoke('log', scope, ...args),
});
