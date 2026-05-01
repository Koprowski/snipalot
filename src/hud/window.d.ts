// Ambient declaration for the `snipalotHud` object exposed by the HUD preload.

interface Window {
  snipalotHud: {
    pauseResume: () => Promise<void>;
    stop: () => Promise<void>;
    discard: () => Promise<void>;
    toggleOutline: () => Promise<void>;
    enterAnnotation: () => Promise<void>;
    snap: () => Promise<void>;
    tradeMarker: () => Promise<void>;
    onState: (
      cb: (payload: {
        startedAt: number;
        paused: boolean;
        totalPausedMs: number;
        sessionMode?: 'record' | 'trade';
        annotateHotkey?: string;
        snapshotHotkey?: string;
        pauseResumeHotkey?: string;
        tradeMarkerHotkey?: string;
      }) => void
    ) => void;
    onAnnotationState: (cb: (payload: { active: boolean }) => void) => void;
  };
}
