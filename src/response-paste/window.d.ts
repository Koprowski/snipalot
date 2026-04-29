interface Window {
  snipalotResponsePaste: {
    log(scope: string, ...args: unknown[]): Promise<void>;
    getSessionInfo(): Promise<{ sessionDir: string; promptPath: string }>;
    submit(jsonStr: string): Promise<{ ok: boolean; error?: string }>;
    dismiss(): Promise<void>;
    openFolder(): Promise<void>;
  };
}
