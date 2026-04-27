// Ambient declaration for the `snipalotHud` object exposed by the HUD preload.

interface Window {
  snipalotHud: {
    pauseResume: () => Promise<void>;
    stop: () => Promise<void>;
    discard: () => Promise<void>;
    toggleOutline: () => Promise<void>;
    enterAnnotation: () => Promise<void>;
    snap: () => Promise<void>;
    onState: (
      cb: (payload: { startedAt: number; paused: boolean; totalPausedMs: number }) => void
    ) => void;
  };
}
