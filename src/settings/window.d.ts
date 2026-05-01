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
      guidance?: {
        kind: 'gemini-cli-missing';
        title: string;
        explanation: string;
        installCommand: string;
        docsUrl: string;
      };
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
    checkDependencies: (payload: { geminiCliCommand?: string }) => Promise<{
      whisper: { ok: boolean; message: string; exePath?: string; modelPath?: string };
      node: { ok: boolean; message: string; version?: string; optional?: boolean };
      geminiCli: { ok: boolean; message: string; version?: string; command?: string };
    }>;
    installGeminiCli: () => Promise<{
      ok: boolean;
      message: string;
      stdoutTail?: string;
      stderrTail?: string;
    }>;
    installNode: () => Promise<{
      ok: boolean;
      message: string;
      stdoutTail?: string;
      stderrTail?: string;
    }>;
    installWhisper: () => Promise<{
      ok: boolean;
      message: string;
      exePath?: string;
      modelPath?: string;
    }>;
    geminiCliSigninStatus: () => Promise<{ signedIn: boolean; subject?: string | null }>;
    geminiCliSignin: (payload: { command?: string }) => Promise<{ ok: boolean; message: string; subject?: string }>;
    geminiCliSigninCancel: () => Promise<{ ok: boolean; message?: string }>;
    geminiCliSignout: () => Promise<{ ok: boolean; message?: string }>;
    pickFolder: () => Promise<string | null>;
    close: () => Promise<void>;
    log: (scope: string, ...args: unknown[]) => Promise<void>;
  };
}
