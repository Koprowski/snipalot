// Ambient declaration for the `snipalotFramePicker` object exposed by the framepicker preload.

interface Window {
  snipalotFramePicker: {
    onInit: (cb: (payload: { mp4Path: string; sessionDir: string }) => void) => void;
    exportFrame: (timeSec: number, sessionDir: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  };
}
