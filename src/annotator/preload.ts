/**
 * Snipalot annotator preload.
 *
 * Milestone 1 stub: only exposes a log shim so the renderer can write to
 * the main-process logger via the existing 'log' IPC channel. Milestone 2+
 * adds getInitialImage(), save(), cancel() — at which point the standalone
 * paste-on-load + File System Access API paths in annotator.ts get replaced
 * by these calls.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotAnnotator', {
  log: (scope: string, ...args: unknown[]): Promise<void> =>
    ipcRenderer.invoke('log', `annotator:${scope}`, ...args),
  /**
   * Returns the image the host wants pre-loaded in the canvas, or null if
   * no preload is queued (e.g. the dev-preview tray entry, where the user
   * still pastes via Ctrl+V).
   */
  getInitialImage: (): Promise<{ dataUrl: string; sessionStamp: string } | null> =>
    ipcRenderer.invoke('annotator:get-initial-image'),
  /**
   * Native Electron clipboard fallback. Chromium's navigator.clipboard.read()
   * can miss Windows clipboard images that Electron can still read.
   */
  readClipboardImage: (): Promise<{ dataUrl: string } | null> =>
    ipcRenderer.invoke('annotator:read-clipboard-image'),
  /** Current screenshot save destination from Snipalot settings. */
  getSaveInfo: (): Promise<{ outputDir: string }> =>
    ipcRenderer.invoke('annotator:get-save-info'),
  /** Open Snipalot Settings so the user can change Output Folder. */
  openSettings: (): Promise<void> => ipcRenderer.invoke('annotator:open-settings'),
  /**
   * Persist the annotated PNG + prompt text to disk and put the prompt on
   * the clipboard. Main writes into {outputDir}/{sessionStamp} screenshot/
   * and closes the annotator window on success.
   */
  save: (
    payload: { pngDataUrl: string; promptText: string; sessionStamp?: string }
  ): Promise<{ ok: true; sessionDir: string; pngPath: string; promptPath: string } |
              { ok: false; error: string }> =>
    ipcRenderer.invoke('annotator:save', payload),
  /** Close the annotator window (user-cancel). */
  cancel: (): Promise<void> => ipcRenderer.invoke('annotator:cancel'),
});
