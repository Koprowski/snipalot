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
  feedback: {
    /**
     * Record-mode output artifacts. These do not affect transcription.
     * Trade-mode ignores these switches and still generates the media its
     * reporting pipeline expects.
     */
    generateMp4: boolean;
    generateGif: boolean;
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
    /**
     * OpenAI-compatible API key for automatic trade extraction. Works with:
     *   - OpenAI directly (api.openai.com) — use model gpt-4o-mini
     *   - OpenRouter (openrouter.ai/api/v1) — set a compatible model id
     *     and use OpenRouter-managed billing/free-tier behavior.
     */
    openaiApiKey: string;
    /**
     * Base URL for the OpenAI-compatible API. Defaults to OpenAI
     * (https://api.openai.com/v1). Set to https://openrouter.ai/api/v1
     * for OpenRouter, or any other OpenAI-compatible endpoint.
     */
    openaiBaseUrl: string;
    /**
     * Model to use with the OpenAI-compatible API.
     * OpenRouter examples: "google/gemini-2.5-flash" or a ":free" model
     * OpenAI: "gpt-4o-mini"
     */
    openaiModel: string;
    /**
     * Extraction backend for Trade mode:
     * - 'gemini-cli': local Gemini CLI headless invocation (preferred no-cost mode)
     * - 'api': OpenRouter/OpenAI-compatible HTTP API via key below
     */
    llmMode: 'gemini-cli' | 'api';
    /** Command used to invoke Gemini CLI (binary name or absolute path). */
    geminiCliCommand: string;
    /** Gemini model passed to CLI with --model. */
    geminiCliModel: string;
  };
  launcher: {
    /**
     * When true, the launcher window stays alwaysOnTop above other apps.
     * Toggled via the pin button in the titlebar; persisted across
     * sessions. Default false (normal window stacking).
     */
    pinnedOnTop: boolean;
    /** Which primary launcher action buttons are visible while idle.
     * Record + Screenshot are the default general-user workflow; Trade is
     * opt-in so trading users can make the launcher unmistakable. */
    visibleActions: {
      record: boolean;
      screenshot: boolean;
      trade: boolean;
    };
  };
  capture: {
    /**
     * Default capture mode for Record + Trade hotkeys / buttons.
     *  - 'region':     drag to select a custom region (default, current behavior)
     *  - 'fullscreen': skip region-select, capture the whole display the
     *                  cursor is on (or primary). Fastest workflow.
     *  - 'window':     pick a specific app window via a picker UI. Bounds
     *                  match the window's current size. (UI deferred — falls
     *                  back to 'region' for now if selected.)
     */
    mode: 'region' | 'fullscreen' | 'window';
    /**
     * Seconds to count down after a region is selected (or immediately
     * after a hotkey press in fullscreen / window mode) before recording
     * starts. 0 disables the countdown (recording starts instantly).
     * Default 3.
     */
    countdownSec: number;
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
    // 'S' for Snip/recording. Ctrl+Alt avoids the sticky Shift rearm issues
    // seen on some Windows systems with state-changing global shortcuts.
    startStop: 'Ctrl+Alt+S',
    // 'A' for Annotate (was 'N'). N is taken by "new file/window" in many
    // apps and the conflict was costing Jason muscle memory.
    annotate: 'Ctrl+Shift+A',
    // 'P' for "Picture" — Snipalot wins the chord at the OS level via
    // Ctrl+Shift+P proved unreliable on Windows despite Electron reporting
    // it as registered, so the default uses Ctrl+Alt+P.
    snapshot: 'Ctrl+Alt+P',
    // 'T' for Trade — toggles a Trade session, equivalent to clicking
    // the violet Trade button in the launcher. Always-on global.
    startTrade: 'Ctrl+Alt+T',
    // 'X' for "X marks the spot" — only registered while a trade-mode recording is
    // live. Each press logs a recording-relative timestamp the LLM
    // uses as an anchor when extracting trades.
    tradeMarker: 'Ctrl+Shift+X',
    clear: 'Ctrl+Shift+C',
    undo: 'Ctrl+Z',
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
  feedback: {
    generateMp4: false,
    generateGif: false,
  },
  trade: {
    autoPromptForTradeData: true,
    openaiApiKey: '',
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    openaiModel: 'google/gemini-2.5-flash',
    llmMode: 'gemini-cli',
    geminiCliCommand: 'gemini',
    geminiCliModel: 'gemini-3.1-pro-preview',
  },
  launcher: {
    pinnedOnTop: false,
    visibleActions: {
      record: true,
      screenshot: true,
      trade: false,
    },
  },
  capture: {
    mode: 'region',
    countdownSec: 3,
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
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as Partial<SnipalotConfig>;
      _config = deepMerge(DEFAULT_CONFIG, parsed) as SnipalotConfig;
      migrateLoadedConfig(_config, parsed);
      log('config', 'loaded', {
        path: CONFIG_PATH,
        outputDir: _config.outputDir,
        firstRun: _config.firstRun,
        hotkeys: _config.hotkeys,
        launcherVisibleActions: _config.launcher.visibleActions,
        capture: _config.capture,
        feedback: _config.feedback,
      });
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
  const nextConfig = deepMerge(_config, partial) as SnipalotConfig;
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2), 'utf-8');
    _config = nextConfig;
    log('config', 'saved', { path: CONFIG_PATH });
  } catch (err) {
    log('config', 'save error', { err: (err as Error).message });
    throw err;
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

function migrateLoadedConfig(
  config: SnipalotConfig,
  parsed: Partial<SnipalotConfig>
): void {
  if (parsed.hotkeys?.tradeMarker === 'Ctrl+Shift+M') {
    config.hotkeys.tradeMarker = DEFAULT_CONFIG.hotkeys.tradeMarker;
    log('config', 'migrated old default tradeMarker hotkey', {
      from: 'Ctrl+Shift+M',
      to: config.hotkeys.tradeMarker,
    });
  }
  if (parsed.hotkeys?.snapshot === 'Ctrl+Shift+P') {
    config.hotkeys.snapshot = DEFAULT_CONFIG.hotkeys.snapshot;
    log('config', 'migrated old default snapshot hotkey', {
      from: 'Ctrl+Shift+P',
      to: config.hotkeys.snapshot,
    });
  }
  if (parsed.hotkeys?.startStop === 'Ctrl+Shift+S') {
    config.hotkeys.startStop = DEFAULT_CONFIG.hotkeys.startStop;
    log('config', 'migrated old default startStop hotkey', {
      from: 'Ctrl+Shift+S',
      to: config.hotkeys.startStop,
    });
  }
  if (parsed.hotkeys?.startTrade === 'Ctrl+Shift+T') {
    config.hotkeys.startTrade = DEFAULT_CONFIG.hotkeys.startTrade;
    log('config', 'migrated old default startTrade hotkey', {
      from: 'Ctrl+Shift+T',
      to: config.hotkeys.startTrade,
    });
  }
  if (parsed.trade?.geminiCliModel === 'gemini-2.5-flash') {
    config.trade.geminiCliModel = DEFAULT_CONFIG.trade.geminiCliModel;
    log('config', 'migrated old default Gemini CLI model', {
      from: 'gemini-2.5-flash',
      to: config.trade.geminiCliModel,
    });
  }
  if (
    parsed.launcher?.visibleActions?.record === false &&
    parsed.launcher.visibleActions.screenshot === true &&
    parsed.launcher.visibleActions.trade === true
  ) {
    config.launcher.visibleActions = { ...DEFAULT_CONFIG.launcher.visibleActions };
    log('config', 'migrated legacy launcher visible actions to general default', {
      from: parsed.launcher.visibleActions,
      to: config.launcher.visibleActions,
    });
  }
  sanitizeHotkeys(config);
  sanitizeLauncherActions(config);
}

function sanitizeHotkeys(config: SnipalotConfig): void {
  for (const key of Object.keys(DEFAULT_CONFIG.hotkeys) as Array<keyof HotkeyConfig>) {
    const value = config.hotkeys[key];
    if (isUsableHotkey(value)) continue;
    config.hotkeys[key] = DEFAULT_CONFIG.hotkeys[key];
    log('config', 'reset invalid hotkey to default', {
      key,
      from: value,
      to: config.hotkeys[key],
    });
  }
}

function isUsableHotkey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value) return false;
  const parts = value.split('+').map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => !p)) return false;
  const last = parts[parts.length - 1];
  if (['Ctrl', 'Control', 'Shift', 'Alt', 'Meta', 'Command', 'Cmd'].includes(last)) return false;
  return parts.slice(0, -1).some((p) => ['Ctrl', 'Control', 'Shift', 'Alt', 'Meta', 'Command', 'Cmd'].includes(p));
}

function sanitizeLauncherActions(config: SnipalotConfig): void {
  const actions = config.launcher.visibleActions;
  if (actions.record || actions.screenshot || actions.trade) return;
  config.launcher.visibleActions = { ...DEFAULT_CONFIG.launcher.visibleActions };
  log('config', 'reset launcher visible actions to default; at least one action must be visible');
}
