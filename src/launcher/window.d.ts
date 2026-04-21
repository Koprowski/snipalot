// Ambient declaration for the `snipalotLauncher` object exposed by the launcher preload.

interface Window {
  snipalotLauncher: {
    record: () => Promise<void>;
    cancel: () => Promise<void>;
    quit: () => Promise<void>;
    toggleMinimize: () => Promise<void>;
    log: (scope: string, ...args: unknown[]) => Promise<void>;
    onState: (cb: (state: { appState: 'idle' | 'selecting' | 'recording' }) => void) => void;
  };
}
