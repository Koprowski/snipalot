// Ambient declaration for the `snipalotLauncher` object exposed by the launcher preload.

interface Window {
  snipalotLauncher: {
    record: () => Promise<void>;
    screenshot: () => Promise<void>;
    trade: () => Promise<void>;
    cancel: () => Promise<void>;
    abandonProcessing: () => Promise<boolean>;
    quit: () => Promise<void>;
    closeToTray: () => Promise<void>;
    togglePin: () => Promise<boolean>;
    getPinState: () => Promise<boolean>;
    copyLastPrompt: () => Promise<
      | { ok: true; kind: 'record' | 'trade' | 'screenshot'; sessionName: string; chars: number }
      | { ok: false; error: string }
    >;
    copySupportLog: () => Promise<
      | { ok: true; mode: 'file' | 'text'; path: string; bytes: number }
      | { ok: false; error: string }
    >;
    settings: () => Promise<void>;
    exitApp: () => Promise<boolean>;
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
        snapshotHotkey?: string;
        startTradeHotkey?: string;
        tradeMarkerHotkey?: string;
        sessionMode?: 'record' | 'trade';
        canAbandonProcessing?: boolean;
        processingProgress?: { pct: number; etaSec: number; elapsedSec: number } | null;
      }) => void
    ) => void;
  };
}
