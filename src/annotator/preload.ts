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
});
