// Ambient declaration for the `snipalotAnnotator` object exposed by the annotator preload.

interface Window {
  snipalotAnnotator: {
    log: (scope: string, ...args: unknown[]) => Promise<void>;
    getInitialImage: () => Promise<{ dataUrl: string; sessionStamp: string } | null>;
  };
}
