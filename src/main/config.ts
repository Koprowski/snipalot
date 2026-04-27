/**
 * Snipalot configuration — load / save / access.
 *
 * Config lives at %USERPROFILE%\.snipalot\config.json.
 * Missing keys fall back to DEFAULT_CONFIG so old installs upgrade gracefully.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { log } from './logger';

export interface HotkeyConfig {
  startStop: string;
  annotate: string;
  /** Mirrors the HUD 📸 button: capture this screen and close the chapter. */
  snapshot: string;
  /** Start / stop a Trade session (mirrors the launcher's violet Trade
      button). Always-on global hotkey — toggles. */
  startTrade: string;
  /** Trade-mode marker: appends a recording-relative timestamp the LLM
      extraction prompt uses as an anchor. Recording-only, mode='trade' only. */
  tradeMarker: string;
  clear: string;
  undo: string;
  pauseResume: string;
  toggleOutline: string;
}

export interface SnipalotConfig {
  outputDir: string;
  retention: 'keep-all' | 'keep-latest';
  audio: { microphone: boolean };
  hotkeys: HotkeyConfig;
  annotation: {
    color: string;
    strokeWidth: number;
  };
  snapshot: {
    /**
     * After a snapshot fires (button or hotkey), should the overlay's
     * existing annotations be cleared (true, default — what the HUD
     * button has always done) or kept on screen so they continue to
     * apply to the next chapter (false, the new "carry over" mode)?
     */
    clearAnnotationsAfter: boolean;
  };
  trade: {
    /**
     * After a Trade-mode recording stops, should Snipalot pop the
     * trade-context window asking the user to paste their MockApe /
     * Padre export? When true (default), the window opens automatically.
     * When false, trade-pipeline proceeds straight to extraction without
     * the actual-trade context (LLM has only the transcript). User can
     * toggle from inside the window via "Don't ask again".
     */
    autoPromptForTradeData: boolean;
  };
  /** true until the user completes first-run onboarding. */
  firstRun: boolean;
}

// ─── paths ───────────────────────────────────────────────────────────

export const CONFIG_DIR = path.join(os.homedir(), '.snipalot');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// ─── defaults ────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: SnipalotConfig = {
  outputDir: path.join(os.homedir(), 'Videos', 'Snipalot'),
  retention: 'keep-all',
  audio: { microphone: true },
  hotkeys: {
    // 'S' for Snip (was 'R' for Record). The R chord conflicts with several
    // common reload bindings (Ctrl+Shift+R in browsers, IDEs).
    startStop: 'Ctrl+Shift+S',
    // 'A' for Annotate (was 'N'). N is taken by "new file/window" in many
    // apps and the conflict was costing Jason muscle memory.
    annotate: 'Ctrl+Shift+A',
    // 'P' for "Picture" — Snipalot wins the chord at the OS level via
    // globalShortcut.register, so the browser print-preview default
    // never fires while a recording is active and the binding is live.
    snapshot: 'Ctrl+Shift+P',
    // 'T' for Trade — toggles a Trade session, equivalent to clicking
    // the violet Trade button in the launcher. Always-on global.
    startTrade: 'Ctrl+Shift+T',
    // 'M' for Mark — only registered while a trade-mode recording is
    // live. Each press logs a recording-relative timestamp the LLM
    // uses as an anchor when extracting trades.
    tradeMarker: 'Ctrl+Shift+M',
    clear: 'Ctrl+Shift+C',
    undo: 'Ctrl+Z',
    // Pause/resume moved off Ctrl+Shift+P to make room for snapshot.
    // 'B' for Break — also free of common app conflicts.
    pauseResume: 'Ctrl+Shift+B',
    toggleOutline: 'Ctrl+Shift+H',
  },
  annotation: {
    color: '#EF4444',
    strokeWidth: 3,
  },
  snapshot: {
    clearAnnotationsAfter: true,
  },
  trade: {
    autoPromptForTradeData: true,
  },
  firstRun: true,
};

// ─── in-memory singleton ──────────────────────────────────────────────

let _config: SnipalotConfig = deepMerge(DEFAULT_CONFIG, {}) as SnipalotConfig;

/**
 * Load config from disk. Call once at app startup.
 * Always returns a fully-populated config (missing keys merged from defaults).
 */
export function loadConfig(): SnipalotConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SnipalotConfig>;
      _config = deepMerge(DEFAULT_CONFIG, parsed) as SnipalotConfig;
      log('config', 'loaded', { path: CONFIG_PATH, outputDir: _config.outputDir, firstRun: _config.firstRun });
    } else {
      _config = deepMerge(DEFAULT_CONFIG, {}) as SnipalotConfig;
      log('config', 'no config file found; using defaults');
    }
  } catch (err) {
    _config = deepMerge(DEFAULT_CONFIG, {}) as SnipalotConfig;
    log('config', 'load error; falling back to defaults', { err: (err as Error).message });
  }
  return _config;
}

/**
 * Merge a partial update into the in-memory config and flush to disk.
 */
export function saveConfig(partial: Partial<SnipalotConfig>): void {
  _config = deepMerge(_config, partial) as SnipalotConfig;
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2), 'utf-8');
    log('config', 'saved', { path: CONFIG_PATH });
  } catch (err) {
    log('config', 'save error', { err: (err as Error).message });
  }
}

/** Return the current in-memory config (no disk read). */
export function getConfig(): SnipalotConfig {
  return _config;
}

// ─── helpers ─────────────────────────────────────────────────────────

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === null || override === undefined) return base;
  if (typeof base !== 'object' || Array.isArray(base)) return override ?? base;
  const b = base as Record<string, unknown>;
  const o = override as Record<string, unknown>;
  const result: Record<string, unknown> = { ...b };
  for (const key of Object.keys(o)) {
    result[key] = deepMerge(b[key], o[key]);
  }
  return result;
}
