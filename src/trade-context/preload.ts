/**
 * Snipalot trade-context preload.
 *
 * Exposes the IPC the trade-context window uses to:
 *  - Read the session info on boot (recording started-at + sessionDir)
 *  - Submit the parsed trade data (writes mockape.json in main + closes window)
 *  - Skip (writes mockape.json.skipped sentinel)
 *  - Browse for a file via the OS file picker
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotTradeContext', {
  log: (scope: string, ...args: unknown[]): Promise<void> =>
    ipcRenderer.invoke('log', `trade-context:${scope}`, ...args),
  /** Returns the session metadata the window needs on boot. */
  getSessionInfo: (): Promise<{
    sessionDir: string;
    recordingStartedAtMs: number;
    durationMs: number;
  }> => ipcRenderer.invoke('trade-context:get-session-info'),
  /** User clicked Continue with parsed trade data. Main writes mockape.json + closes. */
  submit: (payload: { trades: unknown[]; dontAskAgain: boolean }): Promise<void> =>
    ipcRenderer.invoke('trade-context:submit', payload),
  /** User clicked Skip. Main writes mockape.json.skipped sentinel + closes. */
  skip: (payload: { dontAskAgain: boolean }): Promise<void> =>
    ipcRenderer.invoke('trade-context:skip', payload),
  /** User clicked Browse — main shows OS file picker, returns file contents. */
  browseForFile: (): Promise<{ contents: string; filename: string } | null> =>
    ipcRenderer.invoke('trade-context:browse'),
});
