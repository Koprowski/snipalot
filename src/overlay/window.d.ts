// Ambient declaration for the `snipalot` object exposed by the overlay preload.

interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Window {
  snipalot: {
    displayId: string;
    log: (scope: string, ...args: unknown[]) => Promise<void>;
    setInteractive: (interactive: boolean) => Promise<void>;
    focusWindow: () => Promise<void>;
    confirmRegion: (rect: OverlayRect) => Promise<void>;
    cancelRegion: () => Promise<void>;
    /**
     * Annotations are discriminated-union shapes (rect/circle/oval/line/arrow/text)
     * in schema v2; typed as `unknown[]` at the preload boundary so the IPC
     * channel stays shape-agnostic.
     */
    syncAnnotations: (payload: {
      annotations: unknown[];
      recordingRegion: OverlayRect | null;
    }) => Promise<void>;
    reportSnapshotChapter: (payload: {
      annotations: unknown[];
      capturedAtMs: number;
    }) => Promise<void>;
    onEnterAnnotationMode: (cb: () => void) => void;
    onEnterRegionSelect: (cb: () => void) => void;
    onExitRegionSelect: (cb: () => void) => void;
    onOwnsRecording: (cb: (payload: { rect: OverlayRect }) => void) => void;
    onRecordingStarted: (
      cb: (payload: { startedAt: number; activeDisplayId: string | null }) => void
    ) => void;
    onRecordingStopped: (cb: () => void) => void;
    onToggleOutline: (cb: () => void) => void;
    onGlobalUndo: (cb: () => void) => void;
    onGlobalClear: (cb: () => void) => void;
    onSnapshotReset: (cb: (payload: { clearAnnotations: boolean }) => void) => void;
  };
}
