// Ambient declaration for the snipalotTradeContext object exposed by the trade-context preload.

interface Window {
  snipalotTradeContext: {
    log: (scope: string, ...args: unknown[]) => Promise<void>;
    getSessionInfo: () => Promise<{
      sessionDir: string;
      recordingStartedAtMs: number;
      durationMs: number;
    }>;
    submit: (payload: { trades: unknown[]; dontAskAgain: boolean }) => Promise<void>;
    skip: (payload: { dontAskAgain: boolean }) => Promise<void>;
    browseForFile: () => Promise<{ contents: string; filename: string } | null>;
  };
}
