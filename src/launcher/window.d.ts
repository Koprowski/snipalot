// Ambient declaration for the `snipalotLauncher` object exposed by the launcher preload.

interface Window {
  snipalotLauncher: {
    record: () => Promise<void>;
    screenshot: () => Promise<void>;
    trade: () => Promise<void>;
    cancel: () => Promise<void>;
    quit: () => Promise<void>;
    settings: () => Promise<void>;
    toggleMinimize: () => Promise<void>;
    log: (scope: string, ...args: unknown[]) => Promise<void>;
    onState: (
      cb: (state: {
        appState:
          | 'idle'
          | 'selecting'
          | 'selecting-screenshot'
          | 'selecting-trade'
          | 'recording'
          | 'trading'
          | 'processing';
        processingStep: string | null;
        startStopHotkey?: string;
      }) => void
    ) => void;
  };
}
