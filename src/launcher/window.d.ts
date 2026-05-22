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
    getCaptureMode: () => Promise<'region' | 'fullscreen' | 'window'>;
    setCaptureMode: (mode: 'region' | 'fullscreen' | 'window') => Promise<'region' | 'fullscreen' | 'window'>;
    copyLastPrompt: () => Promise<
      | { ok: true; kind: 'record' | 'trade' | 'screenshot'; sessionName: string; chars: number }
      | { ok: false; error: string }
    >;
    copySupportLog: () => Promise<
      | { ok: true; mode: 'file' | 'text'; path: string; bytes: number }
      | { ok: false; error: string }
    >;
    checkForUpdates: () => Promise<{
      ok: boolean;
      currentVersion: string;
      latestVersion: string | null;
      releaseUrl: string;
      updateAvailable: boolean;
      message: string;
      installerAssetUrl?: string | null;
    }>;
    onUpdateCheckResult: (callback: (result: {
      ok: boolean;
      currentVersion: string;
      latestVersion: string | null;
      releaseUrl: string;
      updateAvailable: boolean;
      message: string;
      installerAssetUrl?: string | null;
    }) => void) => (() => void);
    installUpdate: () => Promise<{ ok: boolean; message: string; releaseUrl?: string; installerPath?: string }>;
    onUpdateDownloadProgress: (callback: (progress: {
      version: string;
      installerName: string;
      downloadedBytes: number;
      totalBytes: number | null;
      percent: number | null;
    }) => void) => (() => void);
    setUpdateBannerVisible: (visible: boolean) => Promise<boolean>;
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
        captureMode?: 'region' | 'fullscreen' | 'window';
        visibleActions?: { record: boolean; screenshot: boolean; trade: boolean };
        sessionMode?: 'record' | 'trade';
        canAbandonProcessing?: boolean;
        processingProgress?: { pct: number; etaSec: number; elapsedSec: number } | null;
      }) => void
    ) => void;
  };
}
