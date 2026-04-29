/**
 * Snipalot response-paste preload.
 *
 * Exposes IPC for the "Paste LLM Response" window that appears after the
 * extraction prompt is ready. The user pastes the LLM's JSON reply here;
 * main writes it to extraction_response.json and the existing pipeline
 * poller picks it up to generate trade_log.csv / .md / adherence_report.md.
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('snipalotResponsePaste', {
  log: (scope: string, ...args: unknown[]): Promise<void> =>
    ipcRenderer.invoke('log', `response-paste:${scope}`, ...args),
  /** Returns session info so the window can display context. */
  getSessionInfo: (): Promise<{ sessionDir: string; promptPath: string }> =>
    ipcRenderer.invoke('response-paste:get-session-info'),
  /** User submitted JSON. Main validates, writes extraction_response.json, closes. */
  submit: (jsonStr: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('response-paste:submit', jsonStr),
  /** User clicked "I'll do it later" — closes without writing anything. */
  dismiss: (): Promise<void> =>
    ipcRenderer.invoke('response-paste:dismiss'),
  /** Open session folder in Explorer. */
  openFolder: (): Promise<void> =>
    ipcRenderer.invoke('response-paste:open-folder'),
});
