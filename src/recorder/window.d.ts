// Ambient declaration for the `snipalotRecorder` object exposed by the recorder preload.

interface RecorderRegion {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

interface Window {
  snipalotRecorder: {
    getOutputPath: () => Promise<string>;
    saveWebm: (payload: { buffer: ArrayBuffer; filepath: string }) => Promise<{
      ok: boolean;
      filepath: string;
      bytes: number;
    }>;
    reportState: (state: 'started' | 'stopped' | 'error', detail?: string) => Promise<void>;
    onStart: (cb: (region: RecorderRegion) => void) => void;
    onStop: (cb: () => void) => void;
    onPause: (cb: () => void) => void;
    onResume: (cb: () => void) => void;
  };
}
