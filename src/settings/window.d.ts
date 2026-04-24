// Ambient declaration for the `snipalotSettings` object exposed by the settings preload.

interface Window {
  snipalotSettings: {
    getConfig: () => Promise<import('../main/config').SnipalotConfig>;
    save: (partial: Partial<import('../main/config').SnipalotConfig>) => Promise<void>;
    pickFolder: () => Promise<string | null>;
    close: () => Promise<void>;
    log: (scope: string, ...args: unknown[]) => Promise<void>;
  };
}
