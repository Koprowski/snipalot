// Ambient declaration for the `snipalotSettings` object exposed by the settings preload.

interface Window {
  snipalotSettings: {
    getConfig: () => Promise<import('../main/config').SnipalotConfig>;
    save: (partial: Partial<import('../main/config').SnipalotConfig>) => Promise<void>;
    pickFolder: () => Promise<string | null>;
    close: () => Promise<void>;
    testTradeApiKeys: (payload: {
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
    log: (scope: string, ...args: unknown[]) => Promise<void>;
  };
}
