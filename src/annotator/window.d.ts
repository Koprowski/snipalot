// Ambient declaration for the `snipalotAnnotator` object exposed by the annotator preload.

interface Window {
  snipalotAnnotator: {
    log: (scope: string, ...args: unknown[]) => Promise<void>;
    getInitialImage: () => Promise<{ dataUrl: string; sessionStamp: string } | null>;
    save: (
      payload: { pngDataUrl: string; promptText: string; sessionStamp?: string }
    ) => Promise<
      | { ok: true; sessionDir: string; pngPath: string; promptPath: string }
      | { ok: false; error: string }
    >;
    cancel: () => Promise<void>;
  };
}
