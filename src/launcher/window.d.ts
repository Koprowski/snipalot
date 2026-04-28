// Ambient declaration for the `snipalotLauncher` object exposed by the launcher preload.

interface Window {
  snipalotLauncher: {
    record: () => Promise<void>;
    screenshot: () => Promise<void>;
    trade: () => Promise<void>;
    cancel: () => Promise<void>;
    quit: () => Promise<void>;
    closeToTray: () => Promise<void>;
    togglePin: () => Promise<boolean>;
    getPinState: () => Promise<boolean>;
    copyLastPrompt: () => Promise<
      | { ok: true; kind: 'record' | 'trade' | 'screenshot'; sessionName: string; chars: number }
      | { ok: false; error: string }
    >;
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
          | 'processing';
        processingStep: string | null;
        startStopHotkey?: string;
        sessionMode?: 'record' | 'trade';
      }) => void
    ) => void;
  };
}
