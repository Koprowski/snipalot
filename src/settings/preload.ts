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
  getAppInfo: (): Promise<{ version: string; releasePageUrl: string }> =>
    ipcRenderer.invoke('settings:get-app-info'),
  checkForUpdates: (): Promise<{
    ok: boolean;
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    releaseUrl: string | null;
    installerAssetUrl?: string | null;
    installerAssetName?: string | null;
    message: string;
  }> => ipcRenderer.invoke('settings:check-for-updates'),
  getWilyTraderStatus: (): Promise<{
    installed: boolean;
    version: string | null;
    repoPath: string | null;
    extensionPath: string | null;
    isGitRepo: boolean;
    configuredPath: string | null;
    chromeExtensionPaths: string[];
    message: string;
  }> => ipcRenderer.invoke('settings:get-wilytrader-status'),
  openWilyTraderFolder: (): Promise<{ ok: boolean; message: string; path?: string | null }> =>
    ipcRenderer.invoke('settings:open-wilytrader-folder'),
  moveWilyTraderFolder: (): Promise<{
    ok: boolean;
    message: string;
    version: string | null;
    repoPath: string | null;
    extensionPath: string | null;
  }> => ipcRenderer.invoke('settings:migrate-wilytrader-folder'),
  openChromeExtensions: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('settings:open-chrome-extensions'),
  downloadAndInstallUpdate: (): Promise<{
    ok: boolean;
    message: string;
    installerPath?: string;
    releaseUrl?: string | null;
  }> => ipcRenderer.invoke('settings:download-and-install-update'),
  onUpdateDownloadProgress: (callback: (progress: {
    version: string;
    installerName: string;
    downloadedBytes: number;
    totalBytes: number | null;
    percent: number | null;
  }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: {
      version: string;
      installerName: string;
      downloadedBytes: number;
      totalBytes: number | null;
      percent: number | null;
    }) => callback(progress);
    ipcRenderer.on('settings:update-download-progress', listener);
    return () => ipcRenderer.removeListener('settings:update-download-progress', listener);
  },
  openLatestRelease: (): Promise<void> => ipcRenderer.invoke('settings:open-release-page'),
  openUrl: (url: string): Promise<void> => ipcRenderer.invoke('settings:open-release-page', url),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:pick-folder'),
  exitApp: (): Promise<boolean> => ipcRenderer.invoke('settings:exit-app'),
  close: (): Promise<void> => ipcRenderer.invoke('settings:close'),
  log: (scope: string, ...args: unknown[]): Promise<void> =>
    ipcRenderer.invoke('log', scope, ...args),
});
