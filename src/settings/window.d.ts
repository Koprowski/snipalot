// Ambient declaration for the `snipalotSettings` object exposed by the settings preload.

interface Window {
  snipalotSettings: {
    getConfig: () => Promise<import('../main/config').SnipalotConfig>;
    getAppInfo: () => Promise<{
      version: string;
      startupRevision: string;
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
    save: (partial: Partial<import('../main/config').SnipalotConfig>) => Promise<void>;
    testApiKeys: (payload: {
      geminiApiKey?: string;
      openaiApiKey?: string;
      openaiBaseUrl?: string;
      openaiModel?: string;
    }) => Promise<{
      triedAny: boolean;
      geminiTried: boolean;
      geminiOk: boolean;
      geminiMessage: string;
      openaiTried: boolean;
      openaiOk: boolean;
      openaiLabel: string;
      openaiMessage: string;
      anyOk: boolean;
    }>;
    pickFolder: () => Promise<string | null>;
    close: () => Promise<void>;
    log: (scope: string, ...args: unknown[]) => Promise<void>;
  };
}
