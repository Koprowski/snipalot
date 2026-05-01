import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotSettings', {
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('settings:get-config'),
  save: (partial: unknown): Promise<void> => ipcRenderer.invoke('settings:save', partial),
  testLlmConnection: (payload: unknown): Promise<{
    ok: boolean;
    mode: 'gemini-cli' | 'api';
    message: string;
    guidance?: {
      kind: 'gemini-cli-missing';
      title: string;
      explanation: string;
      installCommand: string;
      docsUrl: string;
    };
  }> => ipcRenderer.invoke('settings:test-llm-connection', payload),
  // Backward-compatible aliases for older renderer code paths.
  testApiKeys: (payload: unknown): Promise<{
    ok: boolean;
    mode: 'gemini-cli' | 'api';
    message: string;
    guidance?: {
      kind: 'gemini-cli-missing';
      title: string;
      explanation: string;
      installCommand: string;
      docsUrl: string;
    };
  }> => ipcRenderer.invoke('settings:test-llm-connection', payload),
  testTradeApiKeys: (payload: unknown): Promise<{
    ok: boolean;
    mode: 'gemini-cli' | 'api';
    message: string;
    guidance?: {
      kind: 'gemini-cli-missing';
      title: string;
      explanation: string;
      installCommand: string;
      docsUrl: string;
    };
  }> => ipcRenderer.invoke('settings:test-llm-connection', payload),
  listOpenRouterModels: (): Promise<Array<{ id: string; createdAtMs: number; inputCostPer1M: number }>> =>
    ipcRenderer.invoke('settings:list-openrouter-models'),
  listGeminiCliModels: (command: string): Promise<Array<{ id: string; createdAtMs: number }>> =>
    ipcRenderer.invoke('settings:list-gemini-cli-models', command),
  checkDependencies: (payload: { geminiCliCommand?: string }): Promise<{
    whisper: { ok: boolean; message: string; exePath?: string; modelPath?: string };
    node: { ok: boolean; message: string; version?: string; optional?: boolean };
    geminiCli: { ok: boolean; message: string; version?: string; command?: string };
  }> => ipcRenderer.invoke('settings:check-dependencies', payload),
  installGeminiCli: (): Promise<{ ok: boolean; message: string; stdoutTail?: string; stderrTail?: string }> =>
    ipcRenderer.invoke('settings:install-gemini-cli'),
  installNode: (): Promise<{ ok: boolean; message: string; stdoutTail?: string; stderrTail?: string }> =>
    ipcRenderer.invoke('settings:install-node'),
  installWhisper: (): Promise<{ ok: boolean; message: string; exePath?: string; modelPath?: string }> =>
    ipcRenderer.invoke('settings:install-whisper'),
  geminiCliSigninStatus: (): Promise<{ signedIn: boolean; subject?: string | null }> =>
    ipcRenderer.invoke('settings:gemini-cli-signin-status'),
  geminiCliSignin: (payload: { command?: string }): Promise<{ ok: boolean; message: string; subject?: string }> =>
    ipcRenderer.invoke('settings:gemini-cli-signin', payload),
  geminiCliSigninCancel: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('settings:gemini-cli-signin-cancel'),
  geminiCliSignout: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('settings:gemini-cli-signout'),
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
  openLatestRelease: (): Promise<void> => ipcRenderer.invoke('settings:open-release-page'),
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('settings:open-release-page', url),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:pick-folder'),
  exitApp: (): Promise<boolean> => ipcRenderer.invoke('settings:exit-app'),
  close: (): Promise<void> => ipcRenderer.invoke('settings:close'),
  log: (scope: string, ...args: unknown[]): Promise<void> =>
    ipcRenderer.invoke('log', scope, ...args),
});
