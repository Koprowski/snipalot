// Ambient declaration for the `snipalotSettings` object exposed by the settings preload.

interface Window {
  snipalotSettings: {
    getConfig: () => Promise<import('../main/config').SnipalotConfig>;
    getAppInfo: () => Promise<{
      version: string;
      releasePageUrl: string;
    }>;
    checkForUpdates: () => Promise<{
      ok: boolean;
      currentVersion: string;
      latestVersion: string | null;
      updateAvailable: boolean;
      releaseUrl: string | null;
      message: string;
    }>;
    openLatestRelease: () => Promise<void>;
    openUrl: (url: string) => Promise<void>;
    exitApp: () => Promise<boolean>;
    save: (partial: Partial<import('../main/config').SnipalotConfig>) => Promise<void>;
    testLlmConnection: (payload: {
      llmMode?: 'gemini-cli' | 'api';
      geminiCliCommand?: string;
      geminiCliModel?: string;
      openaiApiKey?: string;
      openaiBaseUrl?: string;
      openaiModel?: string;
    }) => Promise<{
      ok: boolean;
      mode: 'gemini-cli' | 'api';
      message: string;
    }>;
    listOpenRouterModels: () => Promise<Array<{
      id: string;
      createdAtMs: number;
      inputCostPer1M: number;
    }>>;
    listGeminiCliModels: (command: string) => Promise<Array<{
      id: string;
      createdAtMs: number;
    }>>;
    pickFolder: () => Promise<string | null>;
    close: () => Promise<void>;
    log: (scope: string, ...args: unknown[]) => Promise<void>;
  };
}
