import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  globalShortcut,
  desktopCapturer,
  session,
  Notification,
  Display,
  dialog,
  Menu,
  clipboard,
  shell,
  nativeImage,
} from 'electron';
import type { MessageBoxOptions, OpenDialogOptions, WebContents } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import JSZip from 'jszip';
import { getLogPath, log } from './logger';
import {
  runPipeline,
  runDiscardedTradeAudit,
  AnnotationRecord,
  ChapterRecord,
  TradeMarkerRecord,
  DiscardedTradeAuditResult,
  formatSessionStamp,
  transcribeIncrementalAudioChunk,
  mergeTranscriptSegments,
  IncrementalTranscriptionResult,
  IncrementalTranscriptionChunkResult,
} from './pipeline';
import { loadConfig, saveConfig, getConfig, SnipalotConfig, CONFIG_PATH } from './config';
import { createTray, updateTrayMenu, destroyTray } from './tray';
import type { MicDiagnosticsPayload } from '../shared/mic-diagnostics';
import { resolveGeminiCliExecutable } from './gemini-cli-exec';
import { writeSessionLog } from './session-log';
import type { SessionLogStatus } from './session-log';
import { startWilyTraderBridge, stopWilyTraderBridge } from './wilytrader-bridge';
import type { WilyTraderExecutionEvent } from './wilytrader-bridge';

const isDev = process.argv.includes('--dev');
const isSpikeM1 = process.argv.includes('--spike=m1');
const appUserModelId = app.isPackaged ? 'app.snipalot' : 'app.snipalot.dev';
// --debug shows the hidden recorder window AND opens DevTools on it.
// Useful when a recording fails and you need to inspect MediaRecorder errors.
// npm run dev stays clean; use `npm run debug` to enable.
const isDebug = process.argv.includes('--debug');
// --no-protect disables setContentProtection on the HUD so the user can
// screenshot it for debugging. Don't use in normal recording runs.
const disableContentProtection = process.argv.includes('--no-protect');

process.on('uncaughtException', (err) => {
  log('process', 'uncaughtException', {
    message: err.message,
    stack: err.stack,
  });
});

process.on('unhandledRejection', (reason) => {
  log('process', 'unhandledRejection', {
    reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason),
  });
});

process.on('exit', (code) => {
  log('process', 'exit', { code });
});

// Windows uses this id for taskbar grouping. Keep dev and packaged identities
// separate so a dev electron.exe shortcut cannot contaminate production.
if (process.platform === 'win32') {
  app.setAppUserModelId(appUserModelId);
}

// Prevent multiple instances of Snipalot from running simultaneously.
// If we can't acquire the lock, a previous instance is still alive — bail
// out so we don't spawn a second launcher/HUD/overlay set.
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  log('main', `second instance blocked; quitting pid=${process.pid}`);
  app.quit();
  process.exit(0);
}
log('main', `single-instance lock acquired pid=${process.pid}`);
app.on('second-instance', () => {
  log('main', 'second-instance event fired; focusing existing launcher');
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    if (!launcherWindow.isVisible()) launcherWindow.show();
    launcherWindow.focus();
  }
});

// ─── windows + state ──────────────────────────────────────────────────

// One overlay per display, keyed by display id (as string).
const overlayWindows = new Map<string, BrowserWindow>();
/** Nested prepare/restore pairs from recorder around getDisplayMedia. */
let overlayPrecaptureDepth = 0;
let recorderWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;
let launcherWindow: BrowserWindow | null = null;
/**
 * setInterval handle that re-asserts the HUD on top of the overlay every
 * second while recording. Both windows live at 'screen-saver' alwaysOnTop
 * level (the highest Electron exposes), so OS z-order between them isn't
 * strictly defined and focus changes (clicking into RDP, the underlying
 * app, etc.) can drop the HUD behind the full-display overlay. When that
 * happens the user can't click Stop, which is the worst possible failure
 * mode of a recording app. moveTop() is cheap and harmless when the HUD
 * is already on top.
 */
let hudKeepOnTopInterval: NodeJS.Timeout | null = null;
let quitCleanupRan = false;
let appExitRequested = false;
let recorderRendererReady = false;
let pendingRecorderStartRegion: RegionSelection | null = null;
let pendingRecorderStartTimeout: NodeJS.Timeout | null = null;
let captureSurfacesInitialized = false;

interface PendingRecorderLifecycleEvent {
  ts: string;
  event: string;
  details?: unknown;
  status: SessionLogStatus;
}

const MAX_PENDING_RECORDER_LIFECYCLE_EVENTS = 250;
let pendingRecorderLifecycleEvents: PendingRecorderLifecycleEvent[] = [];

const LAUNCHER_WIDTH = 480;
const LAUNCHER_BASE_HEIGHT = 198;
const LAUNCHER_UPDATE_HEIGHT = 246;

function clearPendingRecorderStartTimeout(): void {
  if (pendingRecorderStartTimeout) {
    clearTimeout(pendingRecorderStartTimeout);
    pendingRecorderStartTimeout = null;
  }
}

function resetRecorderLifecycleBuffer(reason: string): void {
  pendingRecorderLifecycleEvents = [];
  recordRecorderLifecycle('recorder lifecycle buffer reset', { reason }, 'start');
}

function recordRecorderLifecycle(
  event: string,
  details?: unknown,
  status: SessionLogStatus = 'info'
): void {
  const ts = new Date().toISOString();
  const enrichedDetails = {
    appVersion: app.getVersion(),
    appState,
    currentSessionMode,
    recorderMediaReady,
    details,
  };
  log('recorder-lifecycle', event, enrichedDetails);
  const sessionDir = liveSessionDir ?? activeProcessingRun?.sessionDir ?? pendingProcessing?.preCreatedSessionDir ?? null;
  if (sessionDir) {
    writeSessionLog(sessionDir, 'recorder', event, enrichedDetails, status, ts);
    return;
  }
  pendingRecorderLifecycleEvents.push({ ts, event, details: enrichedDetails, status });
  if (pendingRecorderLifecycleEvents.length > MAX_PENDING_RECORDER_LIFECYCLE_EVENTS) {
    pendingRecorderLifecycleEvents.shift();
  }
}

function flushPendingRecorderLifecycle(sessionDir: string): void {
  const pending = pendingRecorderLifecycleEvents;
  pendingRecorderLifecycleEvents = [];
  for (const entry of pending) {
    writeSessionLog(
      sessionDir,
      'recorder',
      entry.event,
      { bufferedBeforeSessionDir: true, ...(entry.details as Record<string, unknown>) },
      entry.status,
      entry.ts
    );
  }
  writeSessionLog(sessionDir, 'recorder', 'recorder lifecycle buffer flushed', {
    eventCount: pending.length,
  }, 'info');
}

function resourcesRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'resources')
    : path.join(process.cwd(), 'resources');
}

function appIconPath(ext: 'ico' | 'png' = process.platform === 'win32' ? 'ico' : 'png'): string {
  const root = resourcesRoot();
  const ico = path.join(root, 'icons', 'app.ico');
  const png = path.join(root, 'icons', 'app.png');
  if (ext === 'png') {
    if (fs.existsSync(png)) return png;
    return ico;
  }
  if (fs.existsSync(ico)) return ico;
  return png;
}

function appWindowIcon() {
  const iconPath = process.platform === 'win32' ? appIconPath('ico') : appIconPath('png');
  if (process.platform === 'win32') return iconPath;
  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? iconPath : image;
}

function applyAppWindowIcon(win: BrowserWindow, label: string): void {
  try {
    const icon = appWindowIcon();
    win.setIcon(icon);
    log('main', 'window icon applied', {
      label,
      icon: typeof icon === 'string' ? icon : '[nativeImage]',
    });
  } catch (err) {
    log('main', 'window icon apply failed', {
      label,
      err: (err as Error).message,
    });
  }
}

function initializeCaptureSurfaces(reason: string): void {
  if (captureSurfacesInitialized) return;
  captureSurfacesInitialized = true;
  log('main', 'initialize capture surfaces', { reason });
  rebuildOverlays(reason);
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    recorderWindow = createRecorderWindow();
  }
}

function killSiblingSnipalotElectronProcesses(): void {
  if (process.platform !== 'win32') return;
  const repoPath = process.cwd().replace(/\\/g, '\\\\');
  const ps = [
    '$self = $PID',
    `$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'electron.exe' -and $_.ProcessId -ne $self -and $_.CommandLine -like '*${repoPath}*' }`,
    'foreach ($p in $procs) {',
    '  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}',
    '}',
  ].join(' ; ');
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, {
      windowsHide: true,
      stdio: 'pipe',
    });
    log('main', 'quit cleanup: attempted sibling electron kill', { repoPath });
  } catch (err) {
    log('main', 'quit cleanup: sibling electron kill failed', {
      err: (err as Error).message,
    });
  }
}

function requestAppExit(reason: string): boolean {
  if (appExitRequested) {
    log('main', 'app exit already in progress', { reason });
    return true;
  }
  if (isSelectingState()) {
    log('main', 'app exit converted to selection cancel', { reason, appState });
    exitSelecting(`app exit requested during selection: ${reason}`);
    return false;
  }
  if (appState === 'recording' && currentSessionMode === 'trade') {
    log('main', 'app exit converted to trade discard audit', { reason });
    void discardRecording(`app exit requested: ${reason}`);
    return false;
  }
  appExitRequested = true;
  log('main', 'app exit requested', {
    reason,
    appState,
    windowCount: BrowserWindow.getAllWindows().length,
    windows: BrowserWindow.getAllWindows().map((win) => ({
      title: win.getTitle(),
      visible: win.isVisible(),
      focused: win.isFocused(),
      destroyed: win.isDestroyed(),
    })),
  });
  if (appState === 'recording') {
    updateActiveSessionStatus('failed', {
      stage: 'app exited while recording before finalization',
      reason,
    }, false);
  } else if (appState === 'processing') {
    updateActiveSessionStatus('stalled', {
      stage: 'app exited while processing',
      reason,
    }, false);
  }
  killSiblingSnipalotElectronProcesses();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.close();
  }
  // Force exit shortly after quit to avoid hanging renderer/process states.
  setTimeout(() => app.exit(0), 300);
  app.quit();
  return true;
}

type AppState =
  | 'idle'
  | 'selecting'
  | 'selecting-screenshot'
  | 'selecting-trade'
  | 'recording'   // active capture (BOTH record-mode and trade-mode use this)
  | 'processing';
let appState: AppState = 'idle';
const OVERLAY_REBUILD_DEBOUNCE_MS = 600;
let overlayRebuildTimer: NodeJS.Timeout | null = null;
let pendingOverlayRebuildReason: string | null = null;
/**
 * When appState === 'processing', this carries the current pipeline step
 * (e.g. "Converting video", "Transcribing audio") so the launcher can show
 * the user what's happening during the multi-minute background work.
 * Null in any other state.
 */
let processingStep: string | null = null;
/**
 * Wall-clock progress estimate for the current pipeline run. Set when
 * stopRecording fires, cleared when state returns to 'idle'. Lets the
 * launcher render a progress bar + ETA under the step label so a long
 * (e.g. 1-hour) recording's processing doesn't look stuck at "Saving
 * recording…" for 5 seconds and then "Transcribing…" for 14 minutes
 * with no visible progression.
 */
let processingStartedAtMs: number | null = null;
let processingEstimatedTotalSec: number | null = null;
/** 250ms tick that re-broadcasts state so the launcher's progress bar
 *  animates smoothly while the pipeline runs. */
let processingTickInterval: NodeJS.Timeout | null = null;
/** Fires if we stay in `processing` without completing (e.g. save-webm never arrives). */
let processingWatchdog: NodeJS.Timeout | null = null;

let recordingStartedAt: number | null = null;
/** True only after recorder:state 'started' (MediaRecorder actually running). */
let recorderMediaReady = false;
let recordingPaused = false;
let pausedAt: number | null = null;
let totalPausedMs = 0;

export interface RegionSelection {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

let pendingRegion: RegionSelection | null = null;
let activeDisplayId: string | null = null;
let activeSourceId: string | null = null;
let activeScreenshotCaptureId = 0;
const SCREENSHOT_HOTKEY_CANCEL_DEBOUNCE_MS = 600;
const STATE_HOTKEY_REARM_DELAY_MS = 2000;
type StateHotkeyName = 'startStop' | 'startTrade';
const stateHotkeySuppressedUntil = new Map<StateHotkeyName, number>();
const stateHotkeyRearmTimers = new Map<StateHotkeyName, NodeJS.Timeout>();
let globalShortcutDispatchDepth = 0;
let globalHotkeyReloadQueued = false;
let globalHotkeyReloadTimer: NodeJS.Timeout | null = null;
let selectingScreenshotEnteredAtMs = 0;
let suppressLauncherDuringScreenshotCapture = false;

// Latest annotation snapshot from the owning overlay. Updated on every
// add / undo / clear. Captured at stop time into pendingProcessing so the
// pipeline has what it needs even after the UI state is cleared.
let currentAnnotations: AnnotationRecord[] = [];
let currentRecordingRegionLocal: { x: number; y: number; w: number; h: number } | null = null;

// Session folder pre-created when recording starts so live snaps have
// somewhere to land immediately. Passed to the pipeline at stop time so
// both sources write into the same directory.
let liveSessionDir: string | null = null;
let snapCount = 0;

// Snapshot chapters accumulated during the current recording. Each 📸
// press pushes one entry; overlay reports the annotation payload via
// `overlay:report-snapshot-chapter` after we send `overlay:snapshot-reset`.
let currentChapters: ChapterRecord[] = [];
// Pending chapter PNG path, keyed by snapshotIndex — filled in by hud:snap
// and merged into the corresponding chapter record when the overlay reports
// its annotation payload.
const pendingChapterPngs = new Map<number, string>();

/**
 * Chains snapshot work so a second 📸 (hotkey + HUD, or double-tap) cannot
 * register a second `ipcMain.once('recorder:snap-result')` while the first
 * is still awaiting — which would pair the wrong reply with the wrong chapter.
 */
let snapshotChain: Promise<void> = Promise.resolve();

/**
 * Capture mode of the current/most-recent recording. Decides the session
 * folder suffix ('feedback' for record, 'trade' for trade) and which
 * post-recording pipeline path runs. Set when region-confirmed lands,
 * carried into the pipeline via PendingProcessing.
 */
let currentSessionMode: 'record' | 'trade' = 'record';
/**
 * Recording-relative ms offsets where the user pressed the Trade marker
 * hotkey (see config `hotkeys.tradeMarker`). Empty for non-trade sessions. The trade-pipeline
 * uses these as anchor tags in the LLM extraction prompt so the model
 * focuses on the trader-flagged moments.
 */
let currentTradeMarkers: TradeMarkerRecord[] = [];

interface PendingProcessing {
  annotations: AnnotationRecord[];
  recordingRegion: { x: number; y: number; w: number; h: number } | null;
  startedAtMs: number;
  durationMs: number;
  preCreatedSessionDir: string | null;
  chapters: ChapterRecord[];
  mode: 'record' | 'trade';
  tradeMarkers: TradeMarkerRecord[];
}

interface PendingDiscardAudit {
  annotations: AnnotationRecord[];
  startedAtMs: number;
  durationMs: number;
  preCreatedSessionDir: string;
  chapters: ChapterRecord[];
  mode: 'trade';
  tradeMarkers: TradeMarkerRecord[];
}

// Snapshot of the stopping recording's metadata. The webm buffer arrives
// async via recorder:save-webm and the pipeline picks up from here.
let pendingProcessing: PendingProcessing | null = null;
/**
 * When true, the next save-webm IPC binning the buffer instead of running
 * the pipeline. Set by discardRecording() and cleared after the discard
 * completes. The MediaRecorder always finalizes its blob and fires the
 * IPC; this flag lets us reuse that path in discard mode without changes
 * to the recorder renderer.
 */
let pendingDiscard = false;
let pendingDiscardSessionDir: string | null = null;
let pendingDiscardAudit: PendingDiscardAudit | null = null;

interface ActiveProcessingRun {
  mode: 'record' | 'trade';
  sessionDir: string | null;
  abortController: AbortController;
  abandoned: boolean;
}

let activeProcessingRun: ActiveProcessingRun | null = null;

interface IncrementalAudioChunkPayload {
  buffer: ArrayBuffer;
  index: number;
  startMs: number;
  endMs: number;
  mimeType?: string | null;
  final?: boolean;
}

interface IncrementalTranscriptionRun {
  sessionDir: string;
  mode: 'record' | 'trade';
  abortController: AbortController;
  queue: Promise<void>;
  chunksReceived: number;
  failedChunks: number;
  warnings: string[];
  results: IncrementalTranscriptionChunkResult[];
}

let activeIncrementalTranscription: IncrementalTranscriptionRun | null = null;

function startIncrementalTranscriptionSession(sessionDir: string, mode: 'record' | 'trade'): void {
  cancelIncrementalTranscription('starting new incremental transcription session');
  activeIncrementalTranscription = {
    sessionDir,
    mode,
    abortController: new AbortController(),
    queue: Promise.resolve(),
    chunksReceived: 0,
    failedChunks: 0,
    warnings: [],
    results: [],
  };
  writeSessionLog(sessionDir, 'whisper', 'incremental transcription session started', {
    mode,
  }, 'start');
}

function cancelIncrementalTranscription(reason: string): void {
  const run = activeIncrementalTranscription;
  if (!run) return;
  try {
    run.abortController.abort();
  } catch {
    /* ignore */
  }
  writeSessionLog(run.sessionDir, 'whisper', 'incremental transcription session canceled', {
    reason,
    chunksReceived: run.chunksReceived,
    failedChunks: run.failedChunks,
  }, 'skipped');
  activeIncrementalTranscription = null;
}

function enqueueIncrementalAudioChunk(payload: IncrementalAudioChunkPayload): { ok: boolean; skipped?: boolean; reason?: string } {
  const run = activeIncrementalTranscription;
  if (!run) {
    return { ok: true, skipped: true, reason: 'no active incremental transcription session' };
  }
  const buffer = Buffer.from(payload.buffer);
  if (buffer.length === 0) {
    return { ok: true, skipped: true, reason: 'empty audio chunk' };
  }
  run.chunksReceived += 1;
  const chunkInfo = {
    index: payload.index,
    startMs: payload.startMs,
    endMs: payload.endMs,
    bytes: buffer.length,
    final: Boolean(payload.final),
    mimeType: payload.mimeType ?? null,
  };
  writeSessionLog(run.sessionDir, 'whisper', 'incremental audio chunk received', chunkInfo, 'info');
  run.queue = run.queue
    .then(async () => {
      const result = await transcribeIncrementalAudioChunk({
        audioBuffer: buffer,
        sessionDir: run.sessionDir,
        index: payload.index,
        startMs: payload.startMs,
        endMs: payload.endMs,
        mimeType: payload.mimeType,
        abortSignal: run.abortController.signal,
      });
      run.results.push(result);
    })
    .catch((err) => {
      const message = (err as Error).message;
      if (run.abortController.signal.aborted) return;
      run.failedChunks += 1;
      run.warnings.push(`chunk ${payload.index}: ${message}`);
      writeSessionLog(run.sessionDir, 'whisper', 'incremental chunk failed', {
        ...chunkInfo,
        error: message,
      }, 'warning');
    });
  return { ok: true };
}

function finalizeIncrementalTranscription(sessionDir: string | null | undefined): Promise<IncrementalTranscriptionResult | null> | undefined {
  const run = activeIncrementalTranscription;
  if (!run || (sessionDir && run.sessionDir !== sessionDir)) return undefined;
  activeIncrementalTranscription = null;
  return run.queue.then(() => {
    const ordered = [...run.results].sort((a, b) => a.index - b.index);
    const segments = mergeTranscriptSegments(ordered.flatMap((result) => result.segments));
    const diagnostics = ordered.map((result) => result.diagnostic);
    const result: IncrementalTranscriptionResult = {
      segments,
      diagnostics,
      chunkCount: run.chunksReceived,
      failedChunks: run.failedChunks,
      warnings: run.warnings,
    };
    writeSessionLog(run.sessionDir, 'whisper', 'incremental transcription session finalized', {
      chunksReceived: result.chunkCount,
      failedChunks: result.failedChunks,
      segments: result.segments.length,
      warnings: result.warnings,
    }, result.failedChunks > 0 ? 'warning' : 'success');
    return result;
  });
}

type SessionStatusState =
  | 'recording'
  | 'processing'
  | 'complete'
  | 'failed'
  | 'stalled'
  | 'abandoned'
  | 'discarded';

const SESSION_STATUS_JSON = 'session_status.json';
const SESSION_STATUS_TEXT = 'SESSION_STATUS.txt';
const SESSION_STATUS_HEARTBEAT_MS = 15 * 1000;

let sessionStatusHeartbeat: NodeJS.Timeout | null = null;
let activeSessionStatusDir: string | null = null;
let activeSessionStatus: SessionStatusState | null = null;
let activeSessionStatusDetails: Record<string, unknown> = {};

function clearSessionStatusHeartbeat(): void {
  if (sessionStatusHeartbeat) {
    clearInterval(sessionStatusHeartbeat);
    sessionStatusHeartbeat = null;
  }
}

function writeSessionStatusFile(
  sessionDir: string | null | undefined,
  status: SessionStatusState,
  details: Record<string, unknown> = {}
): void {
  if (!sessionDir) return;
  const updatedAtIso = new Date().toISOString();
  const payload = {
    status,
    updatedAtIso,
    lastHeartbeatIso: status === 'recording' || status === 'processing' ? updatedAtIso : null,
    terminal: status !== 'recording' && status !== 'processing',
    appVersion: app.getVersion(),
    pid: process.pid,
    sessionName: path.basename(sessionDir),
    sessionDir,
    details,
  };
  const detailTextValue = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : null;
    return String(value);
  };
  const optionalDetailLines = [
    ['reviewStatus', details.reviewStatus],
    ['comments', details.comments],
    ['suspectedTradeTimestamps', details.suspectedTradeTimestamps],
    ['retainedRecording', details.retainedRecording],
    ['reviewPath', details.reviewPath],
    ['transcriptPath', details.transcriptPath],
  ]
    .map(([key, value]) => {
      const formatted = detailTextValue(value);
      return formatted ? `${key}=${formatted}` : null;
    })
    .filter(Boolean);
  const text = [
    `status=${payload.status}`,
    `updatedAtIso=${payload.updatedAtIso}`,
    `lastHeartbeatIso=${payload.lastHeartbeatIso ?? ''}`,
    `terminal=${payload.terminal}`,
    `appVersion=${payload.appVersion}`,
    `pid=${payload.pid}`,
    `sessionName=${payload.sessionName}`,
    details.stage ? `stage=${String(details.stage)}` : null,
    details.mode ? `mode=${String(details.mode)}` : null,
    ...optionalDetailLines,
  ].filter(Boolean).join(os.EOL) + os.EOL;

  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    const jsonPath = path.join(sessionDir, SESSION_STATUS_JSON);
    const textPath = path.join(sessionDir, SESSION_STATUS_TEXT);
    const tmpJsonPath = `${jsonPath}.tmp`;
    const tmpTextPath = `${textPath}.tmp`;
    fs.writeFileSync(tmpJsonPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.writeFileSync(tmpTextPath, text, 'utf-8');
    fs.renameSync(tmpJsonPath, jsonPath);
    fs.renameSync(tmpTextPath, textPath);
  } catch (err) {
    log('session-status', 'write failed', {
      sessionDir,
      status,
      err: (err as Error).message,
    });
  }
}

function setSessionStatus(
  sessionDir: string | null | undefined,
  status: SessionStatusState,
  details: Record<string, unknown> = {},
  keepHeartbeat = status === 'recording' || status === 'processing'
): void {
  if (!sessionDir) return;
  writeSessionStatusFile(sessionDir, status, details);
  writeSessionLog(
    sessionDir,
    'session-status',
    `status ${status}`,
    details,
    status === 'complete' ? 'success' : status === 'failed' || status === 'stalled' ? 'error' : 'info'
  );
  if (keepHeartbeat) {
    activeSessionStatusDir = sessionDir;
    activeSessionStatus = status;
    activeSessionStatusDetails = details;
    if (!sessionStatusHeartbeat) {
      sessionStatusHeartbeat = setInterval(() => {
        if (activeSessionStatusDir && activeSessionStatus) {
          writeSessionStatusFile(activeSessionStatusDir, activeSessionStatus, {
            ...activeSessionStatusDetails,
            heartbeat: true,
          });
        }
      }, SESSION_STATUS_HEARTBEAT_MS);
    }
  } else {
    activeSessionStatusDir = null;
    activeSessionStatus = null;
    activeSessionStatusDetails = {};
    clearSessionStatusHeartbeat();
  }
}

function updateActiveSessionStatus(
  status: SessionStatusState,
  details: Record<string, unknown> = {},
  keepHeartbeat = status === 'recording' || status === 'processing'
): void {
  const sessionDir = activeSessionStatusDir ?? activeProcessingRun?.sessionDir ?? liveSessionDir ?? pendingProcessing?.preCreatedSessionDir;
  if (!sessionDir) return;
  setSessionStatus(sessionDir, status, {
    ...activeSessionStatusDetails,
    ...details,
  }, keepHeartbeat);
}

// ─── window constructors ──────────────────────────────────────────────

function setAppState(next: AppState, why: string): void {
  const prev = appState;
  if (prev === next) return;
  log('state', `${prev} → ${next}`, why);
  appState = next;
  // processingStep is only meaningful while in 'processing'; clear on exit.
  if (next !== 'processing') {
    processingStep = null;
    stopProcessingProgressTick();
    if (processingWatchdog) {
      clearTimeout(processingWatchdog);
      processingWatchdog = null;
    }
  }

  // Re-sync global shortcuts whenever state changes. Idle start shortcuts
  // follow launcher button visibility; recording-only shortcuts follow the
  // active HUD controls.
  reloadGlobalHotkeys();
  broadcastStateToLauncher();
  updateLauncherVisibility();
  updateTrayMenu(next);
  if (next === 'idle') {
    runDeferredOverlayRebuildIfIdle('app returned to idle');
  }
}

/**
 * Update the substep label while remaining in the 'processing' state.
 * Triggers a launcher rebroadcast so the user sees the current pipeline
 * stage (e.g. "Converting video → Transcribing audio → ...").
 */
/**
 * Estimate total post-recording processing wall-clock seconds.
 *
 * Incremental transcription means post-stop audio work is usually only
 * waiting for the final rolling chunk. Video work depends on feedback output
 * settings; trade mode still generates its media artifacts.
 *
 * These coefficients are approximate; a real run can land within ±25%.
 * The progress bar caps at 95% until the pipeline actually completes,
 * so a slow run just sits at 95% rather than overshooting visually.
 */
function estimateProcessingSec(recordingDurationMs: number, mode: 'record' | 'trade'): number {
  const recordingSec = Math.max(1, recordingDurationMs / 1000);
  const feedback = getConfig().feedback;
  const mediaEnabled = mode === 'trade' || feedback.generateMp4 || feedback.generateGif;
  // Audio + video branches run in parallel; max() reflects wall clock.
  const audioBranchSec = Math.min(18, 2 + 0.06 * recordingSec); // live chunks + final chunk settle
  const videoBranchSec = mediaEnabled ? 0.10 * recordingSec : 0; // ultrafast libx264
  const gifTailSec = mode === 'trade' || feedback.generateGif ? 0.05 * recordingSec : 0;
  const overheadSec = 5;                            // save webm + chapters + prompt + cleanup
  // Trade sessions include an additional LLM extraction leg after the
  // local media/transcript work. That step is bursty and backend-dependent,
  // so use a generous baseline plus a small transcript-scaled component.
  const tradeExtraSec = mode === 'trade' ? Math.max(90, 0.20 * recordingSec) : 0;
  return Math.ceil(
    overheadSec + Math.max(audioBranchSec, videoBranchSec) + gifTailSec + tradeExtraSec
  );
}

function startProcessingProgressTick(estimatedTotalSec: number): void {
  processingStartedAtMs = Date.now();
  processingEstimatedTotalSec = estimatedTotalSec;
  if (processingTickInterval) clearInterval(processingTickInterval);
  let topReassertCounter = 0;
  processingTickInterval = setInterval(() => {
    // Just rebroadcast - the launcher reads the current progress fields
    // and recomputes pct/eta on every tick.
    if (appState === 'processing') {
      broadcastStateToLauncher();
      topReassertCounter += 1;
      if (topReassertCounter >= 4) {
        topReassertCounter = 0;
        ensureProcessingLauncherVisible(false);
      }
    }
  }, 250);
  log('processing', 'progress tick started', { estimatedTotalSec });
}

function stopProcessingProgressTick(): void {
  if (processingTickInterval) {
    clearInterval(processingTickInterval);
    processingTickInterval = null;
  }
  processingStartedAtMs = null;
  processingEstimatedTotalSec = null;
}

function computeProcessingProgress(): { pct: number; etaSec: number; elapsedSec: number } | null {
  if (processingStartedAtMs === null || processingEstimatedTotalSec === null) return null;
  const elapsedSec = (Date.now() - processingStartedAtMs) / 1000;
  // Cap the visible bar at 95% so we never claim "done" before the
  // pipeline actually fires its 'idle' transition. The final 5% jump
  // on completion is fine — better than a premature 100%.
  const rawPct = (elapsedSec / processingEstimatedTotalSec) * 100;
  const pct = Math.min(95, Math.max(0, rawPct));
  const etaSec = Math.max(0, processingEstimatedTotalSec - elapsedSec);
  return { pct, etaSec, elapsedSec };
}

function setProcessingStep(step: string): void {
  if (appState !== 'processing') return;
  processingStep = step;
  log('state', 'processing step', { step });
  updateActiveSessionStatus('processing', { stage: step });
  broadcastStateToLauncher();
  ensureProcessingLauncherVisible(false);
}

/**
 * Translates a config combo string (always "Ctrl+..." form for portability)
 * into the Electron globalShortcut accelerator shape ("Control+..." on
 * Windows/Linux). macOS Command keys aren't in scope today; left as a
 * future generalization.
 */
function toAccelerator(combo: string): string {
  return combo.replace(/\bCtrl\b/gi, 'Control');
}

function hotkeyParts(combo: string): string[] {
  return combo
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => (part === 'ctrl' ? 'control' : part));
}

function inputMatchesHotkey(
  input: { key?: string; code?: string; control?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
  combo: string
): boolean {
  const parts = hotkeyParts(combo);
  const wantedKey = parts.find((part) => !['control', 'shift', 'alt', 'meta', 'cmd', 'command'].includes(part));
  if (!wantedKey) return false;
  const inputKey = String(input.key ?? '').trim().toLowerCase();
  const inputCode = String(input.code ?? '').trim().toLowerCase().replace(/^key/, '');
  const wantsCtrl = parts.includes('control');
  const wantsShift = parts.includes('shift');
  const wantsAlt = parts.includes('alt');
  const wantsMeta = parts.includes('meta') || parts.includes('cmd') || parts.includes('command');
  return (
    Boolean(input.control) === wantsCtrl &&
    Boolean(input.shift) === wantsShift &&
    Boolean(input.alt) === wantsAlt &&
    Boolean(input.meta) === wantsMeta &&
    (inputKey === wantedKey || inputCode === wantedKey)
  );
}

function isSnapshotLikeInput(input: { key?: string; code?: string; control?: boolean; shift?: boolean; alt?: boolean }): boolean {
  const inputKey = String(input.key ?? '').trim().toLowerCase();
  const inputCode = String(input.code ?? '').trim().toLowerCase();
  const isP = inputKey === 'p' || inputCode === 'keyp';
  return Boolean(input.control) && isP && (Boolean(input.shift) || Boolean(input.alt));
}

function isLocalOnlyUndoHotkey(combo: string): boolean {
  const parts = hotkeyParts(combo);
  return parts.length === 2 && parts.includes('control') && parts.includes('z');
}

function isStateHotkeySuppressed(name: StateHotkeyName): boolean {
  const until = stateHotkeySuppressedUntil.get(name) ?? 0;
  return Date.now() < until;
}

function suppressStateHotkey(name: StateHotkeyName): void {
  const until = Date.now() + STATE_HOTKEY_REARM_DELAY_MS;
  stateHotkeySuppressedUntil.set(name, until);
  const existingTimer = stateHotkeyRearmTimers.get(name);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    stateHotkeyRearmTimers.delete(name);
    if ((stateHotkeySuppressedUntil.get(name) ?? 0) <= Date.now()) {
      stateHotkeySuppressedUntil.delete(name);
      log('hotkey', 'state hotkey rearm window ended', { name, appState });
      reloadGlobalHotkeys();
    }
  }, STATE_HOTKEY_REARM_DELAY_MS);
  stateHotkeyRearmTimers.set(name, timer);
}

function consumeStateHotkey(name: StateHotkeyName): boolean {
  if (isStateHotkeySuppressed(name)) {
    log('hotkey', 'state hotkey repeat ignored during rearm window', {
      name,
      appState,
      remainingMs: (stateHotkeySuppressedUntil.get(name) ?? 0) - Date.now(),
    });
    return false;
  }
  suppressStateHotkey(name);
  return true;
}

function flushDeferredGlobalHotkeyReload(): void {
  if (globalShortcutDispatchDepth > 0 || !globalHotkeyReloadQueued || globalHotkeyReloadTimer) return;
  globalHotkeyReloadTimer = setTimeout(() => {
    globalHotkeyReloadTimer = null;
    if (globalShortcutDispatchDepth > 0 || !globalHotkeyReloadQueued) return;
    globalHotkeyReloadQueued = false;
    log('hotkey', 'deferred reload running after global shortcut dispatch', { appState });
    reloadGlobalHotkeys();
  }, 0);
}

function runGlobalShortcutHandler(name: string, handler: () => void): void {
  globalShortcutDispatchDepth += 1;
  try {
    handler();
  } catch (err) {
    log('hotkey', 'handler failed', {
      name,
      err: (err as Error).message,
      stack: (err as Error).stack,
      appState,
    });
  } finally {
    globalShortcutDispatchDepth = Math.max(0, globalShortcutDispatchDepth - 1);
    flushDeferredGlobalHotkeyReload();
  }
}

function registerAnnotationHotkey(): void {
  const accel = toAccelerator(getConfig().hotkeys.annotate);
  if (globalShortcut.isRegistered(accel)) return;
  const ok = globalShortcut.register(accel, () => runGlobalShortcutHandler('annotate', handleAnnotationHotkey));
  log('hotkey', `${accel} registered (recording started)`, { ok });
}

function unregisterAnnotationHotkey(): void {
  const accel = toAccelerator(getConfig().hotkeys.annotate);
  if (!globalShortcut.isRegistered(accel)) return;
  globalShortcut.unregister(accel);
  log('hotkey', `${accel} unregistered (recording ended)`);
}

/**
 * Trade-marker hotkey: only registered while recording AND mode === 'trade'.
 * Each press appends a recording-relative ms offset to currentTradeMarkers,
 * which the trade-pipeline uses as anchor tags for the LLM extraction prompt.
 * (Default combo is Ctrl+Shift+X; rebindable in Settings — not the same as startTrade.)
 * No separate recording is started — markers are lightweight metadata only.
 */
function registerTradeMarkerHotkey(): void {
  const accel = toAccelerator(getConfig().hotkeys.tradeMarker);
  if (globalShortcut.isRegistered(accel)) return;
  const ok = globalShortcut.register(accel, () => runGlobalShortcutHandler('tradeMarker', () => {
    log('hotkey', `${accel} fired (trade marker)`, { appState, currentSessionMode });
    void doTradeMarker();
  }));
  log('hotkey', `${accel} registered (trade-recording started)`, { ok });
}

function unregisterTradeMarkerHotkey(): void {
  const accel = toAccelerator(getConfig().hotkeys.tradeMarker);
  if (!globalShortcut.isRegistered(accel)) return;
  globalShortcut.unregister(accel);
  log('hotkey', `${accel} unregistered (trade-recording ended)`);
}

/** Format ms offset as "M:SS" for the trade-marker notification. */
function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Wipe all global shortcuts and re-register from current config. Called
 * once at startup and again whenever the settings save mutates hotkeys.
 * The annotation hotkey is intentionally NOT registered here — it lives
 * in registerAnnotationHotkey/unregisterAnnotationHotkey, gated to
 * recording sessions so it doesn't steal global keystrokes when idle.
 * If we're currently recording when reload fires, re-arm the annotation
 * hotkey at the (potentially new) combo.
 */
function reloadGlobalHotkeys(): void {
  if (globalShortcutDispatchDepth > 0) {
    if (!globalHotkeyReloadQueued) {
      log('hotkey', 'reload queued until global shortcut callback exits', {
        appState,
        dispatchDepth: globalShortcutDispatchDepth,
      });
    }
    globalHotkeyReloadQueued = true;
    return;
  }
  globalShortcut.unregisterAll();
  const cfg = getConfig();
  const hk = cfg.hotkeys;
  const visibleActions = cfg.launcher.visibleActions;

  const reg = (name: string, combo: string, handler: () => void): void => {
    const accel = toAccelerator(combo);
    try {
      const registeredBefore = globalShortcut.isRegistered(accel);
      const ok = globalShortcut.register(accel, () => runGlobalShortcutHandler(name, handler));
      const registeredAfter = globalShortcut.isRegistered(accel);
      log('hotkey', 'register', {
        name,
        combo,
        accel,
        ok,
        registeredBefore,
        registeredAfter,
        visibleActions,
        appState,
        currentSessionMode,
      });
      if (!ok) {
        showNotification('Snipalot', `Could not register hotkey: ${accel} (another app owns it)`);
      }
      if (name === 'snapshot') {
        setTimeout(() => {
          log('hotkey', 'snapshot registration verify', {
            name,
            combo,
            accel,
            isRegistered: globalShortcut.isRegistered(accel),
            appState,
            visibleActions: getConfig().launcher.visibleActions,
            snapshotConfig: getConfig().hotkeys.snapshot,
          });
        }, 250);
      }
    } catch (err) {
      log('hotkey', 'register failed', { combo: accel, err: (err as Error).message });
      showNotification('Snipalot', `Invalid hotkey ignored: ${combo}`);
    }
  };

  const skip = (name: string, combo: string, reason: string): void => {
    log('hotkey', 'skip register', {
      name,
      combo: toAccelerator(combo),
      reason,
      visibleActions,
      appState,
      currentSessionMode,
    });
  };

  if (visibleActions.record) {
    if (isStateHotkeySuppressed('startStop')) {
      skip('startStop', hk.startStop, 'state transition rearm window');
    } else {
      reg('startStop', hk.startStop, () => {
        log('hotkey', 'startStop fired', { appState, activeDisplayId });
        if (consumeStateHotkey('startStop')) handleToggleHotkey();
      });
    }
  } else {
    skip('startStop', hk.startStop, 'record action hidden');
  }

  if (visibleActions.screenshot || appState === 'recording') {
    const handleSnapshotShortcut = (combo: string): void => {
      log('hotkey', 'snapshot fired', {
        appState,
        activeDisplayId,
        combo,
        configuredCombo: hk.snapshot,
        visibleActions,
        focusedWindow: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
      });
      if (appState === 'idle') {
        enterSelectingScreenshot();
      } else if (appState === 'recording') {
        void doSnapshot();
      } else if (appState === 'selecting-screenshot') {
        const ageMs = Date.now() - selectingScreenshotEnteredAtMs;
        if (ageMs < SCREENSHOT_HOTKEY_CANCEL_DEBOUNCE_MS) {
          log('hotkey', 'snapshot repeat ignored during screenshot debounce', { ageMs });
          return;
        }
        exitSelecting('snapshot hotkey toggle');
      }
    };

    reg('snapshot', hk.snapshot, () => {
      handleSnapshotShortcut(hk.snapshot);
    });
  } else {
    skip('snapshot', hk.snapshot, 'screenshot action hidden');
  }

  if (
    appState === 'selecting' ||
    appState === 'selecting-screenshot' ||
    appState === 'selecting-trade'
  ) {
    reg('cancelSelection', 'Escape', () => {
      log('hotkey', 'Escape fired (selection cancel queued)', { appState });
      setTimeout(() => {
        log('hotkey', 'Escape selection cancel running deferred', { appState });
        exitSelecting('escape hotkey');
      }, 0);
    });
  } else {
    skip('cancelSelection', 'Escape', 'not selecting');
  }

  reg('toggleOutline', hk.toggleOutline, () => {
    log('hotkey', 'toggleOutline fired', { appState, activeDisplayId });
    if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:toggle-outline');
  });
  reg('pauseResume', hk.pauseResume, () => {
    log('hotkey', 'pauseResume fired', { appState });
    togglePause();
  });
  if (isLocalOnlyUndoHotkey(hk.undo)) {
    skip('undo', hk.undo, 'Ctrl+Z is local-only so it does not block Undo in other apps');
  } else {
    reg('undo', hk.undo, () => {
      if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:global-undo');
    });
  }
  reg('clear', hk.clear, () => {
    if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:global-clear');
  });
  // Always-on Trade-session toggle hotkey. Mirrors the launcher's violet
  // Trade button: idle → enterSelectingTrade, active trade-recording →
  // stopRecording. Available globally so the user can start a session
  // without finding the launcher first.
  if (visibleActions.trade || appState === 'selecting-trade' || (appState === 'recording' && currentSessionMode === 'trade')) {
    if (isStateHotkeySuppressed('startTrade')) {
      skip('startTrade', hk.startTrade, 'state transition rearm window');
    } else {
      reg('startTrade', hk.startTrade, () => {
        log('hotkey', 'startTrade fired', { appState, currentSessionMode });
        if (!consumeStateHotkey('startTrade')) return;
        if (appState === 'idle') {
          enterSelectingTrade();
        } else if (appState === 'recording' && currentSessionMode === 'trade') {
          stopRecording('trade hotkey');
        } else if (appState === 'selecting-trade') {
          exitSelecting('trade hotkey toggle');
        }
      });
    }
  } else {
    skip('startTrade', hk.startTrade, 'trade action hidden');
  }

  // Re-arm the recording-only annotate/trade-marker hotkeys at their new
  // combos if we're mid-session. unregisterAll() above already cleared
  // the OLD combos, so this is just registering the new ones.
  if (appState === 'recording') {
    registerAnnotationHotkey();
    if (currentSessionMode === 'trade') registerTradeMarkerHotkey();
  }
}

function handleAnnotationHotkey(): void {
  const combo = getConfig().hotkeys.annotate;
  log('hotkey', `${combo} fired (annotate)`, { appState, activeDisplayId });
  if (appState !== 'recording' || !activeDisplayId) return;

  // If the cursor is outside the recording region, silently do nothing.
  // The keypress is unfortunately already consumed by the OS at this point,
  // but at least Snipalot won't activate annotation mode unexpectedly.
  if (currentRecordingRegionLocal) {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getAllDisplays().find((d) => String(d.id) === activeDisplayId);
    if (display) {
      const rx = display.bounds.x + currentRecordingRegionLocal.x;
      const ry = display.bounds.y + currentRecordingRegionLocal.y;
      const rw = currentRecordingRegionLocal.w;
      const rh = currentRecordingRegionLocal.h;
      if (cursor.x < rx || cursor.x > rx + rw || cursor.y < ry || cursor.y > ry + rh) {
        log('hotkey', `${combo}: cursor outside recording region, no-op`);
        return;
      }
    }
  }

  targetOverlay(activeDisplayId, 'overlay:enter-annotation-mode');
}

function broadcastStateToLauncher(): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  launcherWindow.webContents.send('launcher:state', {
    appState,
    processingStep,
    startStopHotkey: getConfig().hotkeys.startStop,
    snapshotHotkey: getConfig().hotkeys.snapshot,
    startTradeHotkey: getConfig().hotkeys.startTrade,
    tradeMarkerHotkey: getConfig().hotkeys.tradeMarker,
    captureMode: getConfig().capture.mode,
    visibleActions: getConfig().launcher.visibleActions,
    sessionMode: currentSessionMode,
    canAbandonProcessing: appState === 'processing' && activeProcessingRun !== null,
    processingProgress: computeProcessingProgress(),
  });
}

function ensureProcessingLauncherVisible(focus = false): void {
  if (appState !== 'processing') return;
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  if (launcherWindow.isMinimized()) launcherWindow.restore();
  if (!launcherWindow.isVisible()) launcherWindow.show();
  launcherWindow.setAlwaysOnTop(true, 'screen-saver');
  if (focus) launcherWindow.moveTop();
  if (focus) launcherWindow.focus();
}

function isSelectingState(): boolean {
  return appState === 'selecting' ||
    appState === 'selecting-screenshot' ||
    appState === 'selecting-trade';
}

function cancelSelectionFromEscape(source: string): boolean {
  if (!isSelectingState()) return false;
  log('hotkey', 'Escape cancelled selection', { source, appState });
  exitSelecting(`escape from ${source}`);
  return true;
}

function updateLauncherVisibility(): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  const before = {
    visible: launcherWindow.isVisible(),
    minimized: launcherWindow.isMinimized(),
    focused: launcherWindow.isFocused(),
    alwaysOnTop: launcherWindow.isAlwaysOnTop(),
  };
  // Hide the launcher during active recording and screenshot selection so it
  // does not obscure the user's capture target. During 'processing' it stays
  // visible so the user can watch progress.
  if (appState === 'recording') {
    if (launcherWindow.isVisible()) launcherWindow.hide();
    launcherWindow.setAlwaysOnTop(false);
  } else if (appState === 'processing') {
    ensureProcessingLauncherVisible(true);
  } else if (appState === 'selecting-screenshot' && suppressLauncherDuringScreenshotCapture) {
    launcherWindow.setAlwaysOnTop(false);
    if (launcherWindow.isVisible()) launcherWindow.hide();
  } else {
    launcherWindow.setAlwaysOnTop(false);
    if (!launcherWindow.isVisible()) launcherWindow.show();
    if (launcherWindow.isMinimized()) launcherWindow.restore();
    if (appState === 'idle') {
      launcherWindow.moveTop();
      launcherWindow.focus();
    }
  }
  log('launcher', 'visibility updated', {
    appState,
    before,
    after: {
      visible: launcherWindow.isVisible(),
      minimized: launcherWindow.isMinimized(),
      focused: launcherWindow.isFocused(),
      alwaysOnTop: launcherWindow.isAlwaysOnTop(),
      bounds: launcherWindow.getBounds(),
    },
  });
}

function createOverlayWindowForDisplay(display: Display): BrowserWindow {
  const displayId = String(display.id);
  const icon = appWindowIcon();
  log('main', 'createOverlay requested', {
    displayId,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal,
  });

  // Workaround for a long-standing Electron + Windows per-monitor-DPI bug:
  // creating a BrowserWindow with bounds on a non-primary display causes the
  // initial size to be computed using the PRIMARY display's scale factor,
  // and the window is then clamped to the primary display's workArea. The
  // end result is a window that's positioned on the target monitor but
  // sized wrong (often matching primary's dimensions instead of the target's).
  //
  // The fix is a two-step dance:
  //   1. Create the window with a tiny placeholder size at the TARGET
  //      display's origin. Starting on the correct monitor makes subsequent
  //      size changes honor that monitor's DPI.
  //   2. Call setBounds() AFTER construction. Windows then applies the
  //      per-monitor DPI translation correctly.
  const win = new BrowserWindow({
    show: false,
    x: display.bounds.x,
    y: display.bounds.y,
    width: 100,
    height: 100,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    icon,
    focusable: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  applyAppWindowIcon(win, `overlay:${displayId}`);

  // Step 2: force the full display bounds. setBounds() on Windows routes
  // through per-monitor DPI translation correctly even when the primary
  // display has a different scale factor.
  win.setBounds(display.bounds);
  log('main', 'overlay bounds after setBounds', {
    displayId,
    requested: display.bounds,
    actual: win.getBounds(),
    content: win.getContentBounds(),
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'), {
    query: { displayId },
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && cancelSelectionFromEscape(`overlay ${displayId}`)) {
      event.preventDefault();
    }
  });
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('overlay', 'console-message', { displayId, level, message, line, sourceId });
  });
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      log('overlay', 'window failed load', {
        displayId,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
    }
  );
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('overlay', 'preload error', { displayId, preloadPath, err: error.message });
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log('overlay', 'renderer process gone', { displayId, ...details });
  });
  win.once('ready-to-show', () => {
    // Re-assert bounds once the renderer is ready, in case Chromium resized
    // during load.
    win.setBounds(display.bounds);
    win.show();
    log('main', 'overlay shown', {
      displayId,
      finalBounds: win.getBounds(),
    });
  });

  win.on('close', (event) => {
    log('main', 'overlay close requested', {
      displayId,
      appState,
      appExitRequested,
      focused: win.isFocused(),
    });
    if (!appExitRequested && isSelectingState()) {
      event.preventDefault();
      log('main', 'overlay close prevented during selection', { displayId, appState });
      exitSelecting(`overlay close requested during selection (${displayId})`);
    }
  });

  win.on('closed', () => {
    // Rebuilds can create a replacement overlay for the same display before
    // the old BrowserWindow finishes closing. Only remove the map entry when
    // this exact window is still the registered overlay.
    if (overlayWindows.get(displayId) === win) {
      overlayWindows.delete(displayId);
      log('main', 'overlay closed', { displayId, removedFromMap: true });
    } else {
      log('main', 'stale overlay closed', { displayId, removedFromMap: false });
    }
  });
  return win;
}

function createRecorderWindow(): BrowserWindow {
  recorderRendererReady = false;
  const icon = appWindowIcon();
  const win = new BrowserWindow({
    width: 420,
    height: 300,
    show: isDebug,
    skipTaskbar: !isDebug,
    icon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'recorder', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyAppWindowIcon(win, 'recorder');
  win.loadFile(path.join(__dirname, '..', 'recorder', 'recorder.html'));
  win.webContents.on('did-finish-load', () => {
    log('recorder', 'window finished load');
    recordRecorderLifecycle('recorder window finished load');
    // Fallback: if renderer-ready IPC is missing due preload/runtime quirks,
    // still dispatch queued start once the page has loaded.
    if (pendingRecorderStartRegion && !win.isDestroyed()) {
      const queued = pendingRecorderStartRegion;
      pendingRecorderStartRegion = null;
      clearPendingRecorderStartTimeout();
      win.webContents.send('recorder:start', queued);
      log('recorder', 'dispatched queued start after did-finish-load fallback');
      recordRecorderLifecycle('recorder start dispatched after load fallback', { region: queued }, 'start');
    }
  });
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      log('recorder', 'window failed load', {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
      recordRecorderLifecycle('recorder window failed load', {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      }, 'error');
    }
  );
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('recorder', 'console-message', { level, message, line, sourceId });
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('recorder', 'preload error', { preloadPath, err: error.message });
    recordRecorderLifecycle('recorder preload error', {
      preloadPath,
      error: error.message,
    }, 'error');
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    recorderRendererReady = false;
    log('recorder', 'renderer process gone', details);
    recordRecorderLifecycle('recorder renderer process gone', details, 'error');
  });
  win.on('closed', () => {
    recorderRendererReady = false;
    pendingRecorderStartRegion = null;
    clearPendingRecorderStartTimeout();
    recordRecorderLifecycle('recorder window closed', undefined, 'warning');
  });
  if (isDebug) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function createLauncherWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  // Bumped to 480 to fit three primary actions side by side
  // (Record + Screenshot + Trade) without label truncation.
  const w = LAUNCHER_WIDTH;
  // Custom title bar 28px + content includes the launcher capture-mode
  // segmented control, action row, shortcuts, hint, and processing bar.
  const h = LAUNCHER_BASE_HEIGHT;
  const margin = 16;
  const x = primary.workArea.x + primary.workArea.width - w - margin;
  const y = primary.workArea.y + margin;
  log('main', 'createLauncher', { x, y, w, h });

  const icon = appWindowIcon();
  const win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    // Frameless so we can draw our own slim title bar with only minimize +
    // close (no maximize). Windows' native frame doesn't let us hide the
    // maximize box even with maximizable:false + resizable:false — it just
    // grays it out. Window still behaves like a normal windowed app:
    // alwaysOnTop:false means it drops to the back when another app is
    // brought forward; minimizable:true routes our custom button through
    // the OS minimize path to the taskbar.
    frame: false,
    transparent: false,
    alwaysOnTop: false,
    resizable: false,
    skipTaskbar: false,
    focusable: true,
    minimizable: true,
    maximizable: false,
    show: false,
    icon,
    title: 'Snipalot',
    webPreferences: {
      preload: path.join(__dirname, '..', 'launcher', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyAppWindowIcon(win, 'launcher');
  // Launcher is hidden during Snipalot's own recording, so we don't need
  // content protection on it. Keeping it off means Print Screen / OS-level
  // screen capture still works when debugging the launcher's appearance.
  win.loadFile(path.join(__dirname, '..', 'launcher', 'launcher.html'));
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && isSnapshotLikeInput(input)) {
      const cfg = getConfig();
      const matchesConfiguredSnapshot = inputMatchesHotkey(input, cfg.hotkeys.snapshot);
      log('hotkey', 'launcher before-input snapshot chord', {
        key: input.key,
        code: input.code,
        control: input.control,
        shift: input.shift,
        alt: input.alt,
        meta: input.meta,
        appState,
        snapshotHotkey: cfg.hotkeys.snapshot,
        matchesConfiguredSnapshot,
        screenshotVisible: cfg.launcher.visibleActions.screenshot,
        globalRegistered: globalShortcut.isRegistered(toAccelerator(cfg.hotkeys.snapshot)),
      });
      if (
        matchesConfiguredSnapshot &&
        cfg.launcher.visibleActions.screenshot &&
        (appState === 'idle' || appState === 'selecting-screenshot')
      ) {
        event.preventDefault();
        if (appState === 'idle') enterSelectingScreenshot();
        else exitSelecting('launcher before-input snapshot toggle');
        return;
      }
    }
    if (input.type === 'keyDown' && input.key === 'Escape' && cancelSelectionFromEscape('launcher')) {
      event.preventDefault();
    }
  });
  win.on('close', (event) => {
    if (appExitRequested) return;
    event.preventDefault();
    if (isSelectingState()) {
      exitSelecting('launcher window close during selection');
      return;
    }
    requestAppExit('launcher window close');
  });
  win.once('ready-to-show', () => {
    win.show();
    // Launcher is a normal desktop window; only the recording HUD is topmost.
    win.setAlwaysOnTop(false);
    broadcastStateToLauncher();
  });
  win.on('closed', () => {
    launcherWindow = null;
    log('main', 'launcher closed');
  });
  return win;
}

function createHudWindow(onDisplay: Display): BrowserWindow {
  // Bumped to 320 to accommodate the 6th button (Discard, added alongside
  // Stop). Each .btn is 28px wide with ~6px gaps, plus the drag region
  // (REC dot + label + 00:00 timer).
  const w = 320;
  const h = 44;
  const margin = 16;
  const x = onDisplay.workArea.x + onDisplay.workArea.width - w - margin;
  const y = onDisplay.workArea.y + margin;
  const icon = appWindowIcon();
  log('main', 'createHud', { onDisplay: String(onDisplay.id), x, y });

  const win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    minimizable: false,
    maximizable: false,
    show: false,
    hasShadow: false,
    icon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'hud', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyAppWindowIcon(win, 'hud');
  win.setAlwaysOnTop(true, 'screen-saver');
  // Content protection hides the HUD from screen capture (so its buttons
  // never appear inside a recording). --no-protect turns it off so the user
  // can Print Screen while debugging.
  if (!disableContentProtection) win.setContentProtection(true);
  win.loadFile(path.join(__dirname, '..', 'hud', 'hud.html'));
  win.on('closed', () => {
    hudWindow = null;
    log('main', 'hud closed');
  });
  return win;
}

function showHudForDisplay(display: Display): void {
  if (!hudWindow || hudWindow.isDestroyed()) hudWindow = createHudWindow(display);
  const showHud = () => {
    if (!hudWindow || hudWindow.isDestroyed()) return;
    if (!hudWindow.isVisible()) hudWindow.show();
    hudWindow.moveTop();
    broadcastRecordingState();
  };
  if (hudWindow.webContents.isLoading()) {
    hudWindow.once('ready-to-show', showHud);
  } else {
    showHud();
  }
}

async function showProcessingIssueDialog(
  title: string,
  message: string,
  details: string[],
  willOpenFolder = true
): Promise<void> {
  const parent = launcherWindow && !launcherWindow.isDestroyed() ? launcherWindow : undefined;
  const clipped = details.slice(0, 6);
  const extra = details.length > clipped.length
    ? `\n\n...and ${details.length - clipped.length} more warning(s).`
    : '';
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title,
    message,
    detail: `${clipped.map((w) => `- ${w}`).join('\n')}${extra}\n\n${
      willOpenFolder
        ? 'The session folder will open next.'
        : 'Use the bug icon in the launcher to copy the troubleshooting log.'
    }`,
    buttons: [willOpenFolder ? 'Open folder' : 'OK'],
    defaultId: 0,
    noLink: true,
  };
  if (parent) await dialog.showMessageBox(parent, options);
  else await dialog.showMessageBox(options);
}

let framePickerWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

// ─── settings window ──────────────────────────────────────────────────

// ─── annotator window ────────────────────────────────────────────────
//
// Opens the ported screenshot-annotator in a Snipalot BrowserWindow.
// The dev-preview tray entry opens it standalone (no preloaded image —
// user pastes via Ctrl+V). M3+ adds the region-select capture flow that
// stages a PNG buffer in `pendingAnnotatorImage` before opening the
// window; the renderer then pulls it via the annotator:get-initial-image
// IPC on boot.
let annotatorWindow: BrowserWindow | null = null;
/**
 * Image queued for the next annotator window to load on boot. Cleared
 * after the renderer fetches it. Null when the annotator is opened
 * standalone (e.g. via the tray dev-preview entry).
 */
let pendingAnnotatorImage: { dataUrl: string; sessionStamp: string } | null = null;
let lastAnnotatorEscapeAtMs = 0;
let annotatorCloseIntent: string | null = null;

// ─── trade-context window (TradeCall trade-data input) ───────────────
//
// Opens automatically after a Trade-mode recording stops (unless the user
// has set config.trade.autoPromptForTradeData = false). Collects a
// MockApe / Padre trade export from the user (paste JSON or CSV, or browse
// for a file). Writes the parsed data to mockape.json in the session dir
// before the trade-pipeline renders the LLM extraction prompt — so the
// prompt can embed the actual trades as context for the LLM to align
// against the spoken transcript.

let tradeContextWindow: BrowserWindow | null = null;
/**
 * Session info handed to the trade-context window on boot via the
 * trade-context:get-session-info IPC. Set by openTradeContextWindow();
 * cleared when the window submits or skips.
 */
let pendingTradeContext: {
  sessionDir: string;
  recordingStartedAtMs: number;
  durationMs: number;
} | null = null;

function hasWilyTraderLedger(sessionDir: string): boolean {
  const priorBrandFileName = ['wily', 'mem', 'trader.json'].join('');
  return (
    fs.existsSync(path.join(sessionDir, 'Inputs', 'wilytrader.json')) ||
    fs.existsSync(path.join(sessionDir, 'wilytrader.json')) ||
    fs.existsSync(path.join(sessionDir, 'Inputs', priorBrandFileName)) ||
    fs.existsSync(path.join(sessionDir, priorBrandFileName))
  );
}

function openAnnotator(): void {
  if (annotatorWindow && !annotatorWindow.isDestroyed()) {
    annotatorWindow.focus();
    return;
  }
  // Size to the active display's full work area instead of a hardcoded
  // 1280×800. On a 1280-wide display the prior fixed size left no room
  // for the toolbar to render its full intrinsic width, so even with
  // flex-wrap the user only saw partial content. Using the work area
  // also matches what an annotator-on-a-screenshot workflow wants —
  // maximum canvas room for the captured image.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;
  const icon = appWindowIcon();
  annotatorWindow = new BrowserWindow({
    width: wa.width,
    height: wa.height,
    x: wa.x,
    y: wa.y,
    minWidth: 720,
    minHeight: 480,
    title: 'Snipalot · Annotator',
    icon,
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'annotator', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyAppWindowIcon(annotatorWindow, 'annotator');
  annotatorWindow.removeMenu();
  annotatorWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('annotator', 'console-message', { level, message, line, sourceId });
  });
  annotatorWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    log('annotator', 'preload error', { preloadPath, err: error.message });
  });
  annotatorWindow.webContents.on('render-process-gone', (_event, details) => {
    log('annotator', 'render-process-gone', details);
  });
  annotatorWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    lastAnnotatorEscapeAtMs = Date.now();
    log('annotator', 'Escape before-input intercepted', {
      appState,
      focused: annotatorWindow?.isFocused() ?? false,
      closeIntent: annotatorCloseIntent,
    });
    event.preventDefault();
    annotatorWindow?.webContents.send('annotator:escape-key');
  });
  annotatorWindow.loadFile(path.join(__dirname, '..', 'annotator', 'annotator.html'));
  annotatorWindow.once('ready-to-show', () => annotatorWindow?.show());
  annotatorWindow.on('close', (event) => {
    const msSinceEscape = lastAnnotatorEscapeAtMs ? Date.now() - lastAnnotatorEscapeAtMs : null;
    log('annotator', 'window close requested', {
      appState,
      appExitRequested,
      closeIntent: annotatorCloseIntent,
      msSinceEscape,
    });
    if (!appExitRequested && annotatorCloseIntent === null && msSinceEscape !== null && msSinceEscape < 1000) {
      event.preventDefault();
      log('annotator', 'window close prevented after Escape', { msSinceEscape });
      annotatorWindow?.show();
      annotatorWindow?.focus();
    }
  });
  annotatorWindow.on('closed', () => {
    annotatorWindow = null;
    annotatorCloseIntent = null;
    log('main', 'annotator closed');
  });
  log('main', 'annotator opened', { hasPreloadedImage: pendingAnnotatorImage !== null });
}

// IPC: renderer pulls the preloaded image on boot. Returns null when no
// image is queued (dev-preview tray entry or any standalone open).
ipcMain.handle('annotator:get-initial-image', () => {
  const img = pendingAnnotatorImage;
  pendingAnnotatorImage = null;
  return img;
});

ipcMain.handle('annotator:read-clipboard-image', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) {
    log('annotator', 'clipboard image read: empty');
    return null;
  }
  const size = img.getSize();
  const dataUrl = img.toDataURL();
  log('annotator', 'clipboard image read: success', {
    width: size.width,
    height: size.height,
    chars: dataUrl.length,
  });
  return { dataUrl };
});

ipcMain.handle('annotator:get-save-info', () => ({
  outputDir: getConfig().outputDir,
}));

ipcMain.handle('annotator:open-settings', () => {
  openSettings(false);
});

/**
 * IPC: annotator save flow (M4). Renderer hands us the annotated PNG as
 * a base64 data URL plus the prompt.md text body. We:
 *   1. Compute / reuse the session stamp (from the queued image's stamp
 *      so the saved folder matches the capture timestamp, not when the
 *      user clicked Save).
 *   2. mkdir {outputDir}/{stamp} screenshot/
 *   3. Write snapshot.png + prompt.md
 *   4. clipboard.writeText(promptText)
 *   5. Close the annotator window so the user lands back on the
 *      launcher (already at idle since openAnnotator was called from
 *      the screenshot capture path).
 *
 * Returns { ok, sessionDir, pngPath, promptPath } on success or
 * { ok: false, error } on failure. Renderer surfaces the result to
 * the user via a save-button toast.
 */
ipcMain.handle(
  'annotator:save',
  async (
    _evt,
    payload: { pngDataUrl: string; promptText: string; sessionStamp?: string }
  ) => {
    try {
      const stamp = payload.sessionStamp ?? formatSessionStamp(new Date());
      const outRoot = getConfig().outputDir;
      const sessionDir = path.join(outRoot, `${stamp} screenshot`);
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

      // Strip the data URL prefix and decode base64 to a Buffer.
      const m = /^data:image\/png;base64,(.+)$/.exec(payload.pngDataUrl);
      if (!m) return { ok: false as const, error: 'invalid png data url' };
      const pngBuf = Buffer.from(m[1], 'base64');

      const pngPath = path.join(sessionDir, 'snapshot.png');
      const promptPath = path.join(sessionDir, 'prompt.md');
      const savedPromptText = [
        payload.promptText.trimEnd(),
        '',
        '---',
        'Snipalot saved files:',
        `- Session folder: ${sessionDir}`,
        `- Annotated image: ${pngPath}`,
      ].join('\n');
      fs.writeFileSync(pngPath, pngBuf);
      fs.writeFileSync(promptPath, savedPromptText, 'utf-8');

      clipboard.writeText(savedPromptText);

      log('annotator', 'saved', {
        sessionDir,
        pngBytes: pngBuf.length,
        promptChars: savedPromptText.length,
      });
      showNotification('Snipalot', `Saved · prompt on clipboard. Folder: ${sessionDir}`);

      // Close the annotator window — the user's task is done. Launcher is
      // already at idle (set during the screenshot capture path).
      if (annotatorWindow && !annotatorWindow.isDestroyed()) {
        annotatorCloseIntent = 'save';
        annotatorWindow.close();
      }

      return {
        ok: true as const,
        sessionDir,
        pngPath,
        promptPath,
      };
    } catch (err) {
      const msg = (err as Error).message;
      log('annotator', 'save fail', { err: msg });
      return { ok: false as const, error: msg };
    }
  }
);

// IPC: renderer asks main to close the annotator (e.g. user hits Cancel).
ipcMain.handle('annotator:cancel', () => {
  if (annotatorWindow && !annotatorWindow.isDestroyed()) {
    annotatorCloseIntent = 'cancel';
    annotatorWindow.close();
  }
});

/**
 * Open the trade-context window for an in-flight trade-mode session.
 * The window collects MockApe trade data from the user and writes it
 * (or a sentinel) to the session folder. Trade-pipeline polls for the
 * file before rendering the LLM extraction prompt.
 *
 * Pre-creates the trade-context state so the window can fetch session
 * info on boot. Window auto-closes when user submits or skips.
 */
function openTradeContextWindow(
  sessionDir: string,
  recordingStartedAtMs: number,
  durationMs: number
): void {
  if (tradeContextWindow && !tradeContextWindow.isDestroyed()) {
    if (tradeContextWindow.isMinimized()) tradeContextWindow.restore();
    if (!tradeContextWindow.isVisible()) tradeContextWindow.show();
    tradeContextWindow.focus();
    writeSessionLog(sessionDir, 'trade-context', 'existing trade data window focused', undefined, 'info');
    return;
  }
  pendingTradeContext = { sessionDir, recordingStartedAtMs, durationMs };
  writeSessionLog(sessionDir, 'trade-context', 'trade data window opening', {
    recordingStartedAtMs,
    durationMs,
  }, 'start');
  const primary = screen.getPrimaryDisplay();
  const w = 640;
  const h = 560;
  const icon = appWindowIcon();
  tradeContextWindow = new BrowserWindow({
    width: w,
    height: h,
    x: primary.workArea.x + Math.floor((primary.workArea.width - w) / 2),
    y: primary.workArea.y + Math.floor((primary.workArea.height - h) / 2),
    title: 'Snipalot Trade · Add trade data',
    icon,
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'trade-context', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyAppWindowIcon(tradeContextWindow, 'trade-context');
  tradeContextWindow.removeMenu();
  tradeContextWindow.loadFile(path.join(__dirname, '..', 'trade-context', 'trade-context.html'));
  const showTradeContext = () => {
    if (!tradeContextWindow || tradeContextWindow.isDestroyed()) return;
    if (!tradeContextWindow.isVisible()) tradeContextWindow.show();
    tradeContextWindow.focus();
  };
  if (tradeContextWindow.webContents.isLoading()) tradeContextWindow.once('ready-to-show', showTradeContext);
  else showTradeContext();
  /*
  tradeContextKeepOnTopInterval = setInterval(() => {
    if (
      tradeContextWindow &&
      !tradeContextWindow.isDestroyed() &&
      tradeContextWindow.isVisible() &&
      !tradeContextWindow.isFocused()
    ) {
      // Only re-assert if NOT focused — if the user is actively using
      // another app (e.g. copying from browser), we don't want to keep
      // stealing focus from them. moveTop without focus is enough to
      // keep the window visible above the overlay.
      tradeContextWindow.moveTop();
    }
  }, 1000);
  */
  tradeContextWindow.on('closed', () => {
    // If the user dismissed the window without submit/skip (e.g. clicked
    // the X), treat as a skip so trade-pipeline can proceed. Write the
    // sentinel only if neither has already happened (the IPC handlers
    // below also write it; this is the fallback).
    if (pendingTradeContext) {
      const skipPath = path.join(pendingTradeContext.sessionDir, 'Inputs', 'mockape.json.skipped');
      const legacySkipPath = path.join(pendingTradeContext.sessionDir, 'mockape.json.skipped');
      try {
        const inputDir = path.dirname(skipPath);
        if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
        if (!fs.existsSync(skipPath) &&
            !fs.existsSync(legacySkipPath) &&
            !fs.existsSync(path.join(pendingTradeContext.sessionDir, 'Inputs', 'mockape.json')) &&
            !fs.existsSync(path.join(pendingTradeContext.sessionDir, 'mockape.json'))) {
          fs.writeFileSync(skipPath, '', 'utf-8');
          log('trade-context', 'window dismissed without submit/skip → wrote .skipped sentinel');
        }
      } catch (err) {
        log('trade-context', 'sentinel write fail on close', { err: (err as Error).message });
      }
      pendingTradeContext = null;
    }
    tradeContextWindow = null;
  });
  log('trade-context', 'opened', { sessionDir, recordingStartedAtMs, durationMs });
}

ipcMain.handle('trade-context:get-session-info', () => {
  return pendingTradeContext ?? { sessionDir: '', recordingStartedAtMs: 0, durationMs: 0 };
});

ipcMain.handle(
  'trade-context:submit',
  (_evt, payload: { trades: unknown[]; dontAskAgain: boolean }) => {
    if (!pendingTradeContext) return;
    const { sessionDir } = pendingTradeContext;
    const mockApePath = path.join(sessionDir, 'Inputs', 'mockape.json');
    try {
      const inputDir = path.dirname(mockApePath);
      if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(mockApePath, JSON.stringify(payload.trades, null, 2), 'utf-8');
      log('trade-context', 'mockape.json written via submit', {
        mockApePath,
        trades: payload.trades.length,
      });
      writeSessionLog(sessionDir, 'trade-context', 'mockape submitted', {
        mockApePath,
        trades: payload.trades.length,
      }, 'success');
    } catch (err) {
      log('trade-context', 'mockape.json write fail', { err: (err as Error).message });
      writeSessionLog(sessionDir, 'trade-context', 'mockape write failed', { error: (err as Error).message }, 'error');
    }
    if (payload.dontAskAgain) {
      saveConfig({ trade: { autoPromptForTradeData: false } } as never);
      log('trade-context', 'autoPromptForTradeData disabled by user');
    }
    pendingTradeContext = null;
    if (tradeContextWindow && !tradeContextWindow.isDestroyed()) tradeContextWindow.close();
    setTimeout(() => ensureProcessingLauncherVisible(true), 100);
  }
);

ipcMain.handle('trade-context:skip', (_evt, payload: { dontAskAgain: boolean }) => {
  if (!pendingTradeContext) return;
  const { sessionDir } = pendingTradeContext;
  const skipPath = path.join(sessionDir, 'Inputs', 'mockape.json.skipped');
  try {
    const inputDir = path.dirname(skipPath);
    if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(skipPath, '', 'utf-8');
    log('trade-context', 'skip sentinel written', { skipPath });
    writeSessionLog(sessionDir, 'trade-context', 'mockape skipped', { skipPath }, 'skipped');
  } catch (err) {
    log('trade-context', 'skip sentinel fail', { err: (err as Error).message });
    writeSessionLog(sessionDir, 'trade-context', 'skip sentinel write failed', { error: (err as Error).message }, 'error');
  }
  if (payload.dontAskAgain) {
    saveConfig({ trade: { autoPromptForTradeData: false } } as never);
    log('trade-context', 'autoPromptForTradeData disabled by user');
  }
  pendingTradeContext = null;
  if (tradeContextWindow && !tradeContextWindow.isDestroyed()) tradeContextWindow.close();
  setTimeout(() => ensureProcessingLauncherVisible(true), 100);
});

ipcMain.handle('trade-context:browse', async () => {
  if (!tradeContextWindow || tradeContextWindow.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(tradeContextWindow, {
    title: 'Choose trade export file',
    properties: ['openFile'],
    filters: [
      { name: 'Trade exports', extensions: ['json', 'csv'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filepath = result.filePaths[0];
  try {
    const contents = fs.readFileSync(filepath, 'utf-8');
    return { contents, filename: path.basename(filepath) };
  } catch (err) {
    log('trade-context', 'browse read fail', { err: (err as Error).message });
    return null;
  }
});

// ── Response-paste window ──────────────────────────────────────────────────
// Opens after the extraction prompt is written. User pastes the LLM's JSON
// reply here; we write it to extraction_response.json and the pipeline
// poller picks it up automatically.

let responsePasteWindow: BrowserWindow | null = null;
let pendingResponsePaste: { sessionDir: string; responsePath: string; promptPath: string } | null = null;

function openResponsePasteWindow(
  sessionDir: string,
  responsePath: string,
  promptPath: string
): void {
  if (responsePasteWindow && !responsePasteWindow.isDestroyed()) {
    if (responsePasteWindow.isMinimized()) responsePasteWindow.restore();
    if (!responsePasteWindow.isVisible()) responsePasteWindow.show();
    responsePasteWindow.focus();
    writeSessionLog(sessionDir, 'response-paste', 'existing response window focused', { responsePath }, 'info');
    return;
  }
  pendingResponsePaste = { sessionDir, responsePath, promptPath };
  writeSessionLog(sessionDir, 'response-paste', 'response paste window opening', {
    responsePath,
    promptPath,
  }, 'start');
  const primary = screen.getPrimaryDisplay();
  const w = 600;
  const h = 540;
  const icon = appWindowIcon();
  responsePasteWindow = new BrowserWindow({
    width: w,
    height: h,
    x: primary.workArea.x + Math.floor((primary.workArea.width - w) / 2),
    y: primary.workArea.y + Math.floor((primary.workArea.height - h) / 2),
    minWidth: 480,
    minHeight: 400,
    title: 'Snipalot · Paste LLM Response',
    icon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'response-paste', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyAppWindowIcon(responsePasteWindow, 'response-paste');
  responsePasteWindow.removeMenu();
  responsePasteWindow.loadFile(
    path.join(__dirname, '..', 'response-paste', 'response-paste.html')
  );
  const showResponsePaste = () => {
    if (!responsePasteWindow || responsePasteWindow.isDestroyed()) return;
    if (!responsePasteWindow.isVisible()) responsePasteWindow.show();
    responsePasteWindow.focus();
  };
  if (responsePasteWindow.webContents.isLoading()) responsePasteWindow.once('ready-to-show', showResponsePaste);
  else showResponsePaste();
  responsePasteWindow.on('closed', () => {
    responsePasteWindow = null;
  });
}

ipcMain.handle('response-paste:get-session-info', () => {
  return pendingResponsePaste ?? { sessionDir: '', responsePath: '', promptPath: '' };
});

ipcMain.handle('response-paste:submit', (_evt, jsonStr: string) => {
  if (!pendingResponsePaste) return { ok: false, error: 'No active session.' };
  const { responsePath, sessionDir } = pendingResponsePaste;
  // Strip markdown code fences if the user accidentally included them.
  const stripped = jsonStr
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    const parsed = JSON.parse(stripped);
    if (!Array.isArray(parsed)) throw new Error('Response must be a JSON array.');
    // Write the file — the pipeline poller picks it up within 2 s.
    fs.writeFileSync(responsePath, JSON.stringify(parsed, null, 2), 'utf-8');
    log('response-paste', 'extraction_response.json written', {
      trades: parsed.length,
      responsePath,
    });
    writeSessionLog(sessionDir, 'response-paste', 'extraction_response.json written from paste window', {
      trades: parsed.length,
      responsePath,
    }, 'success');
    // Close the window after a short delay so the "Done" state is visible.
    setTimeout(() => {
      if (responsePasteWindow && !responsePasteWindow.isDestroyed()) {
        responsePasteWindow.close();
      }
    }, 1200);
    return { ok: true };
  } catch (err) {
    log('response-paste', 'submit error', { err: (err as Error).message });
    writeSessionLog(sessionDir, 'response-paste', 'submit error', { error: (err as Error).message }, 'error');
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('response-paste:dismiss', () => {
  if (responsePasteWindow && !responsePasteWindow.isDestroyed()) {
    responsePasteWindow.close();
  }
});

ipcMain.handle('response-paste:open-folder', () => {
  if (pendingResponsePaste) {
    void shell.openPath(pendingResponsePaste.sessionDir);
  }
});

function openSettings(isFirstRun = false): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // Bring it above the overlays and focus.
    settingsWindow.setAlwaysOnTop(true, 'screen-saver');
    settingsWindow.moveTop();
    settingsWindow.focus();
    return;
  }
  const primary = screen.getPrimaryDisplay();
  const w = 760;
  const h = 700;
  const icon = appWindowIcon();
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: primary.workArea.x + Math.floor((primary.workArea.width - w) / 2),
    y: primary.workArea.y + Math.floor((primary.workArea.height - h) / 2),
    title: 'Snipalot · Settings',
    frame: false,
    transparent: false,
    resizable: true,
    minWidth: 700,
    minHeight: 620,
    maximizable: false,
    minimizable: false,
    skipTaskbar: false,
    // Always on top at screen-saver level so it isn't buried under the overlay
    // windows, which also run at that level and cover the full screen.
    alwaysOnTop: true,
    show: false,
    icon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'settings', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyAppWindowIcon(win, 'settings');
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'settings', 'settings.html'));
  win.on('close', (event) => {
    if (appExitRequested) return;
  });
  win.once('ready-to-show', () => {
    win.show();
    win.moveTop();
    win.focus();
    log('settings', 'window opened', { isFirstRun });
  });
  win.on('closed', () => {
    settingsWindow = null;
    if (launcherWindow && !launcherWindow.isDestroyed()) {
      if (!launcherWindow.isVisible()) launcherWindow.show();
      launcherWindow.focus();
    }
    log('settings', 'window closed');
  });
  settingsWindow = win;
}

ipcMain.handle('settings:get-config', () => getConfig());
ipcMain.handle('settings:get-app-info', () => ({
  version: app.getVersion(),
  releasePageUrl: 'https://github.com/Koprowski/snipalot/releases/latest',
}));

interface WilyTraderInstallStatus {
  installed: boolean;
  version: string | null;
  repoPath: string | null;
  extensionPath: string | null;
  isGitRepo: boolean;
  configuredPath: string | null;
  chromeExtensionPaths: string[];
  message: string;
}

interface WilyTraderMoveResult {
  ok: boolean;
  message: string;
  version: string | null;
  repoPath: string | null;
  extensionPath: string | null;
}

interface SettingsUpdateCheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  installerAssetUrl?: string | null;
  installerAssetName?: string | null;
  message: string;
}

interface SettingsUpdateInstallResult {
  ok: boolean;
  message: string;
  installerPath?: string;
  releaseUrl?: string | null;
}

interface WilyTraderUpdateCheckResult {
  ok: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  repoPath: string | null;
  extensionPath: string | null;
  releaseUrl: string | null;
  message: string;
}

interface WilyTraderUpdateInstallResult {
  ok: boolean;
  message: string;
  repoPath?: string | null;
  extensionPath?: string | null;
  releaseUrl?: string | null;
}

interface GitHubReleaseInfo {
  tagName: string;
  version: string;
  htmlUrl: string;
  installerAssetUrl: string | null;
  installerAssetName: string | null;
}

interface GitHubTagInfo {
  name?: string;
  zipball_url?: string;
}

interface WilyTraderReleaseInfo {
  tagName: string;
  version: string;
  zipballUrl: string;
  htmlUrl: string;
}

const UPDATE_CHECK_CACHE_TTL_MS = 5 * 60 * 1000;
const WILYTRADER_REPO_URL = 'https://github.com/Koprowski/WilyTrader';
const WILYTRADER_TAGS_API_URL = 'https://api.github.com/repos/Koprowski/WilyTrader/tags?per_page=10';
const WILYTRADER_MANAGED_DIR = path.join(os.homedir(), '.snipalot', 'wilytrader');

let cachedUpdateCheckResult: SettingsUpdateCheckResult | null = null;
let cachedUpdateCheckResultAtMs = 0;
let updateCheckPromise: Promise<SettingsUpdateCheckResult> | null = null;
let cachedWilyTraderUpdateCheckResult: WilyTraderUpdateCheckResult | null = null;
let cachedWilyTraderUpdateCheckResultAtMs = 0;
let wilyTraderUpdateCheckPromise: Promise<WilyTraderUpdateCheckResult> | null = null;

type SettingsTestLlmGuidance = {
  kind: 'gemini-cli-missing';
  title: string;
  explanation: string;
  installCommand: string;
  docsUrl: string;
};

function parseSemverParts(v: string): number[] | null {
  const clean = v.trim().replace(/^v/i, '');
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isRemoteVersionNewer(current: string, latest: string): boolean {
  const a = parseSemverParts(current);
  const b = parseSemverParts(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

function findInstallerAsset(
  assets: Array<{ name?: string; browser_download_url?: string }> | undefined
): { name: string; url: string } | null {
  const candidates = (assets ?? [])
    .map((asset) => ({
      name: asset.name ?? '',
      url: asset.browser_download_url ?? '',
    }))
    .filter((asset) => (
      /^Snipalot-.*-setup\.exe$/i.test(asset.name) &&
      /^https?:\/\//i.test(asset.url)
    ));
  return candidates[0] ?? null;
}

async function fetchLatestSnipalotReleaseInfo(signal?: AbortSignal): Promise<GitHubReleaseInfo> {
  const currentVersion = app.getVersion();
  const fallbackUrl = 'https://github.com/Koprowski/snipalot/releases/latest';
  const res = await fetch('https://api.github.com/repos/Koprowski/snipalot/releases/latest', {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `snipalot/${currentVersion}`,
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`GitHub release check failed (HTTP ${res.status}).`);
  }
  const json = await res.json() as {
    tag_name?: string;
    html_url?: string;
    name?: string;
    assets?: Array<{ name?: string; browser_download_url?: string }>;
  };
  const tagName = (json.tag_name ?? json.name ?? '').trim();
  const version = tagName.replace(/^v/i, '');
  if (!version) {
    throw new Error('GitHub release metadata did not include a valid version.');
  }
  const installer = findInstallerAsset(json.assets);
  return {
    tagName,
    version,
    htmlUrl: json.html_url || fallbackUrl,
    installerAssetUrl: installer?.url ?? null,
    installerAssetName: installer?.name ?? null,
  };
}

async function performSnipalotUpdateCheck(reason: string): Promise<SettingsUpdateCheckResult> {
  const currentVersion = app.getVersion();
  const fallbackUrl = 'https://github.com/Koprowski/snipalot/releases/latest';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const latest = await fetchLatestSnipalotReleaseInfo(controller.signal);
    const latestVersion = latest.version;
    const releaseUrl = latest.htmlUrl;
    const updateAvailable = isRemoteVersionNewer(currentVersion, latestVersion);
    const result: SettingsUpdateCheckResult = {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable,
      releaseUrl,
      installerAssetUrl: latest.installerAssetUrl,
      installerAssetName: latest.installerAssetName,
      message: updateAvailable
        ? `Update available: v${latestVersion} (installed v${currentVersion}).`
        : `You are up to date (v${currentVersion}).`,
    };
    log('settings', 'update check complete', {
      reason,
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable,
      hasInstallerAsset: Boolean(latest.installerAssetUrl),
    });
    return result;
  } catch (err) {
    log('settings', 'update check failed', { reason, err: (err as Error).message });
    const result: SettingsUpdateCheckResult = {
      ok: false,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: fallbackUrl,
      installerAssetUrl: null,
      installerAssetName: null,
      message: `Update check failed: ${(err as Error).message}`,
    };
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

function getSnipalotUpdateCheckResult(
  reason: string,
  options: { force?: boolean } = {}
): Promise<SettingsUpdateCheckResult> {
  const cacheAgeMs = cachedUpdateCheckResultAtMs > 0
    ? Date.now() - cachedUpdateCheckResultAtMs
    : Number.POSITIVE_INFINITY;
  if (
    !options.force &&
    cachedUpdateCheckResult?.ok &&
    cacheAgeMs >= 0 &&
    cacheAgeMs < UPDATE_CHECK_CACHE_TTL_MS
  ) {
    log('settings', 'update check cache hit', {
      reason,
      currentVersion: cachedUpdateCheckResult.currentVersion,
      latestVersion: cachedUpdateCheckResult.latestVersion,
      updateAvailable: cachedUpdateCheckResult.updateAvailable,
      cacheAgeMs,
      cacheTtlMs: UPDATE_CHECK_CACHE_TTL_MS,
    });
    return Promise.resolve(cachedUpdateCheckResult);
  }
  if (cachedUpdateCheckResult?.ok) {
    log('settings', 'update check cache bypassed', {
      reason,
      force: Boolean(options.force),
      cacheAgeMs,
      cacheTtlMs: UPDATE_CHECK_CACHE_TTL_MS,
      cachedLatestVersion: cachedUpdateCheckResult.latestVersion,
      cachedUpdateAvailable: cachedUpdateCheckResult.updateAvailable,
    });
  }
  if (updateCheckPromise) {
    log('settings', 'update check joining in-flight request', { reason, force: Boolean(options.force) });
    return updateCheckPromise;
  }
  log('settings', 'update check start', { reason, force: Boolean(options.force), currentVersion: app.getVersion() });
  updateCheckPromise = performSnipalotUpdateCheck(reason)
    .then((result) => {
      cachedUpdateCheckResult = result;
      cachedUpdateCheckResultAtMs = Date.now();
      sendLauncherUpdateCheckResult(result);
      return result;
    })
    .finally(() => {
      updateCheckPromise = null;
    });
  return updateCheckPromise;
}

function startBackgroundUpdateCheck(reason: string): void {
  void getSnipalotUpdateCheckResult(reason);
  void getWilyTraderUpdateCheckResult(reason);
}

function sendLauncherUpdateCheckResult(result: SettingsUpdateCheckResult): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  launcherWindow.webContents.send('launcher:update-check-result', result);
}

function sendLauncherWilyTraderUpdateCheckResult(result: WilyTraderUpdateCheckResult): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  launcherWindow.webContents.send('launcher:wilytrader-update-check-result', result);
}

function normalizeVersionTag(tag: string): string {
  return tag.trim().replace(/^v/i, '');
}

function readWilyTraderManifest(candidatePath: string): { repoPath: string; extensionPath: string; version: string } | null {
  const possibleExtensionPaths = [
    candidatePath,
    path.join(candidatePath, 'extension'),
  ];
  for (const extensionPath of possibleExtensionPaths) {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown };
      const name = typeof json.name === 'string' ? json.name.trim() : '';
      const version = typeof json.version === 'string' ? json.version.trim() : '';
      if (name !== 'WilyTrader' || !version) continue;
      return {
        repoPath: path.basename(extensionPath).toLowerCase() === 'extension'
          ? path.dirname(extensionPath)
          : extensionPath,
        extensionPath,
        version,
      };
    } catch (err) {
      log('wilytrader-update', 'manifest read failed', { manifestPath, err: (err as Error).message });
    }
  }
  return null;
}

function wilyTraderPathsFromChromeProfiles(): string[] {
  const userDataRoot = chromeUserDataRoot();
  if (!fs.existsSync(userDataRoot)) return [];
  const paths: string[] = [];
  for (const profile of chromeProfileDirs()) {
    const preferencesPath = path.join(profile.path, 'Preferences');
    if (!fs.existsSync(preferencesPath)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) as {
        extensions?: { settings?: Record<string, { path?: unknown; manifest?: { name?: unknown } }> };
      };
      const settings = json.extensions?.settings ?? {};
      for (const extension of Object.values(settings)) {
        const extensionPath = typeof extension.path === 'string' ? extension.path : '';
        const manifestName = typeof extension.manifest?.name === 'string' ? extension.manifest.name : '';
        if (!extensionPath) continue;
        if (manifestName === 'WilyTrader' || readWilyTraderManifest(extensionPath)) {
          paths.push(extensionPath);
        }
      }
    } catch (err) {
      log('wilytrader-update', 'chrome preferences scan failed', {
        preferencesPath,
        err: (err as Error).message,
      });
    }
  }
  return paths;
}

function chromeUserDataRoot(): string {
  return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
}

function chromeProfileDirs(): Array<{ name: string; path: string }> {
  const userDataRoot = chromeUserDataRoot();
  if (!fs.existsSync(userDataRoot)) return [];
  return fs.readdirSync(userDataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/i.test(entry.name)))
    .map((entry) => ({
      name: entry.name,
      path: path.join(userDataRoot, entry.name),
    }));
}

function chromeLastUsedProfileName(): string | null {
  const localStatePath = path.join(chromeUserDataRoot(), 'Local State');
  if (!fs.existsSync(localStatePath)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) as {
      profile?: {
        last_used?: unknown;
        last_active_profiles?: unknown;
      };
    };
    const lastUsed = typeof json.profile?.last_used === 'string' ? json.profile.last_used : '';
    if (lastUsed) return lastUsed;
    const activeProfiles = Array.isArray(json.profile?.last_active_profiles)
      ? json.profile.last_active_profiles.filter((item): item is string => typeof item === 'string')
      : [];
    return activeProfiles[0] ?? null;
  } catch (err) {
    log('wilytrader-update', 'chrome local state read failed', {
      localStatePath,
      err: (err as Error).message,
    });
    return null;
  }
}

function wilyTraderExtensionProfilesFromChromeProfiles(): Array<{ id: string; profileName: string }> {
  const found: Array<{ id: string; profileName: string }> = [];
  for (const profile of chromeProfileDirs()) {
    const preferencesPath = path.join(profile.path, 'Preferences');
    if (!fs.existsSync(preferencesPath)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) as {
        extensions?: { settings?: Record<string, { path?: unknown; manifest?: { name?: unknown } }> };
      };
      const settings = json.extensions?.settings ?? {};
      for (const [extensionId, extension] of Object.entries(settings)) {
        const extensionPath = typeof extension.path === 'string' ? extension.path : '';
        const manifestName = typeof extension.manifest?.name === 'string' ? extension.manifest.name : '';
        if (manifestName === 'WilyTrader' || (extensionPath && readWilyTraderManifest(extensionPath))) {
          found.push({ id: extensionId, profileName: profile.name });
        }
      }
    } catch (err) {
      log('wilytrader-update', 'chrome extension id scan failed', {
        preferencesPath,
        err: (err as Error).message,
      });
    }
  }
  const seen = new Set<string>();
  return found.filter((item) => {
    const key = `${item.profileName}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function wilyTraderExtensionIdsFromChromeProfiles(): string[] {
  return [...new Set(wilyTraderExtensionProfilesFromChromeProfiles().map((item) => item.id))];
}

function wilyTraderCandidateRepoPaths(): string[] {
  const configuredInstallPath = getConfig().wilyTrader?.installPath;
  const candidates = [
    configuredInstallPath,
    ...wilyTraderPathsFromChromeProfiles(),
    process.env.WILYTRADER_HOME,
    path.join(os.homedir(), '.snipalot', 'wilytrader'),
    path.join(os.homedir(), 'WilyTrader'),
    path.join(os.homedir(), 'Documents', 'WilyTrader'),
    'C:\\Tools\\WilyTrader',
    'E:\\Apps\\wilytrader',
  ].filter((candidate): candidate is string => Boolean(candidate && candidate.trim()));
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function detectWilyTraderInstall(): { repoPath: string; extensionPath: string; version: string; isGitRepo: boolean } | null {
  for (const candidatePath of wilyTraderCandidateRepoPaths()) {
    const manifest = readWilyTraderManifest(candidatePath);
    if (!manifest) continue;
    return {
      repoPath: manifest.repoPath,
      extensionPath: manifest.extensionPath,
      version: manifest.version,
      isGitRepo: fs.existsSync(path.join(manifest.repoPath, '.git')),
    };
  }
  return null;
}

function saveWilyTraderInstallPath(repoPath: string): void {
  saveConfig({ wilyTrader: { installPath: path.resolve(repoPath) } } as Partial<SnipalotConfig>);
}

function isDirectoryEmpty(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) &&
      fs.statSync(dirPath).isDirectory() &&
      fs.readdirSync(dirPath).length === 0;
  } catch {
    return false;
  }
}

async function fetchLatestWilyTraderReleaseInfo(signal?: AbortSignal): Promise<WilyTraderReleaseInfo> {
  const res = await fetch(WILYTRADER_TAGS_API_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `snipalot/${app.getVersion()}`,
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`WilyTrader tag check failed (HTTP ${res.status}).`);
  }
  const tags = await res.json() as GitHubTagInfo[];
  const latest = tags
    .map((tag) => ({
      tagName: (tag.name ?? '').trim(),
      version: normalizeVersionTag(tag.name ?? ''),
      zipballUrl: tag.zipball_url ?? '',
    }))
    .filter((tag) => /^\d+\.\d+\.\d+$/.test(tag.version) && /^https?:\/\//i.test(tag.zipballUrl))
    .sort((a, b) => (isRemoteVersionNewer(a.version, b.version) ? -1 : isRemoteVersionNewer(b.version, a.version) ? 1 : 0))
    .pop();
  if (!latest) {
    throw new Error('WilyTrader tag metadata did not include a valid version tag.');
  }
  return {
    ...latest,
    htmlUrl: `${WILYTRADER_REPO_URL}/releases/tag/${latest.tagName || `v${latest.version}`}`,
  };
}

async function performWilyTraderUpdateCheck(reason: string): Promise<WilyTraderUpdateCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const [latest, install] = await Promise.all([
      fetchLatestWilyTraderReleaseInfo(controller.signal),
      Promise.resolve(detectWilyTraderInstall()),
    ]);
    const currentVersion = install?.version ?? null;
    const updateAvailable = !currentVersion || isRemoteVersionNewer(currentVersion, latest.version);
    const result: WilyTraderUpdateCheckResult = {
      ok: true,
      currentVersion,
      latestVersion: latest.version,
      updateAvailable,
      repoPath: install?.repoPath ?? WILYTRADER_MANAGED_DIR,
      extensionPath: install?.extensionPath ?? path.join(WILYTRADER_MANAGED_DIR, 'extension'),
      releaseUrl: latest.htmlUrl,
      message: updateAvailable
        ? currentVersion
          ? `WilyTrader ${latest.version} is available (installed ${currentVersion}).`
          : `WilyTrader ${latest.version} is available to install locally.`
        : `WilyTrader is up to date (${currentVersion}).`,
    };
    log('wilytrader-update', 'check complete', {
      reason,
      ok: true,
      currentVersion,
      latestVersion: latest.version,
      updateAvailable,
      repoPath: result.repoPath,
    });
    return result;
  } catch (err) {
    log('wilytrader-update', 'check failed', { reason, err: (err as Error).message });
    return {
      ok: false,
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      repoPath: detectWilyTraderInstall()?.repoPath ?? WILYTRADER_MANAGED_DIR,
      extensionPath: null,
      releaseUrl: WILYTRADER_REPO_URL,
      message: `WilyTrader update check failed: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getWilyTraderUpdateCheckResult(
  reason: string,
  options: { force?: boolean } = {}
): Promise<WilyTraderUpdateCheckResult> {
  const cacheAgeMs = cachedWilyTraderUpdateCheckResultAtMs > 0
    ? Date.now() - cachedWilyTraderUpdateCheckResultAtMs
    : Number.POSITIVE_INFINITY;
  if (
    !options.force &&
    cachedWilyTraderUpdateCheckResult?.ok &&
    cacheAgeMs >= 0 &&
    cacheAgeMs < UPDATE_CHECK_CACHE_TTL_MS
  ) {
    log('wilytrader-update', 'check cache hit', {
      reason,
      latestVersion: cachedWilyTraderUpdateCheckResult.latestVersion,
      updateAvailable: cachedWilyTraderUpdateCheckResult.updateAvailable,
      cacheAgeMs,
    });
    return Promise.resolve(cachedWilyTraderUpdateCheckResult);
  }
  if (wilyTraderUpdateCheckPromise) {
    log('wilytrader-update', 'check joining in-flight request', { reason, force: Boolean(options.force) });
    return wilyTraderUpdateCheckPromise;
  }
  log('wilytrader-update', 'check start', { reason, force: Boolean(options.force) });
  wilyTraderUpdateCheckPromise = performWilyTraderUpdateCheck(reason)
    .then((result) => {
      cachedWilyTraderUpdateCheckResult = result;
      cachedWilyTraderUpdateCheckResultAtMs = Date.now();
      sendLauncherWilyTraderUpdateCheckResult(result);
      return result;
    })
    .finally(() => {
      wilyTraderUpdateCheckPromise = null;
    });
  return wilyTraderUpdateCheckPromise;
}

ipcMain.handle('settings:check-for-updates', async (): Promise<SettingsUpdateCheckResult> => {
  return getSnipalotUpdateCheckResult('settings', { force: true });
});

ipcMain.handle('launcher:check-for-updates', async (): Promise<SettingsUpdateCheckResult> => {
  return getSnipalotUpdateCheckResult('launcher');
});

ipcMain.handle('launcher:check-wilytrader-updates', async (): Promise<WilyTraderUpdateCheckResult> => {
  return getWilyTraderUpdateCheckResult('launcher');
});

ipcMain.handle('launcher:update-wilytrader', async (evt): Promise<WilyTraderUpdateInstallResult> => {
  return updateWilyTraderFiles(evt.sender);
});

ipcMain.handle('settings:check-wilytrader-updates', async (): Promise<WilyTraderUpdateCheckResult> => {
  return getWilyTraderUpdateCheckResult('settings', { force: true });
});

ipcMain.handle('settings:update-wilytrader', async (evt): Promise<WilyTraderUpdateInstallResult> => {
  return updateWilyTraderFiles(evt.sender);
});

ipcMain.handle('settings:get-wilytrader-status', async (): Promise<WilyTraderInstallStatus> => {
  const install = detectWilyTraderInstall();
  const configuredPath = getConfig().wilyTrader?.installPath?.trim() || null;
  const chromeExtensionPaths = wilyTraderPathsFromChromeProfiles();
  if (!install) {
    return {
      installed: false,
      version: null,
      repoPath: WILYTRADER_MANAGED_DIR,
      extensionPath: path.join(WILYTRADER_MANAGED_DIR, 'extension'),
      isGitRepo: false,
      configuredPath,
      chromeExtensionPaths,
      message: 'No local WilyTrader manifest was found. Install from the launcher WilyTrader update notice first.',
    };
  }
  return {
    installed: true,
    version: install.version,
    repoPath: install.repoPath,
    extensionPath: install.extensionPath,
    isGitRepo: install.isGitRepo,
    configuredPath,
    chromeExtensionPaths,
    message: `WilyTrader ${install.version} is installed at ${install.extensionPath}.`,
  };
});

ipcMain.handle('settings:open-wilytrader-folder', async (): Promise<{ ok: boolean; message: string; path?: string | null }> => {
  const install = detectWilyTraderInstall();
  if (!install) {
    return {
      ok: false,
      message: 'No local WilyTrader install was found yet.',
      path: null,
    };
  }
  await revealWilyTraderExtensionFolder(install.extensionPath);
  return {
    ok: true,
    message: `Opened WilyTrader folder: ${install.extensionPath}`,
    path: install.extensionPath,
  };
});

ipcMain.handle('settings:open-chrome-extensions', async (): Promise<{ ok: boolean; message: string }> => {
  const extensionIds = wilyTraderExtensionIdsFromChromeProfiles();
  await openChromeExtensionsPage({ closeSettings: true });
  return {
    ok: true,
    message: extensionIds.length > 0
      ? 'Closed Settings and opened Chrome Extensions for WilyTrader. Use Reload if needed.'
      : 'Closed Settings and opened chrome://extensions/. Use Developer mode and Load unpacked for WilyTrader.',
  };
});

ipcMain.handle('settings:migrate-wilytrader-folder', async (): Promise<WilyTraderMoveResult> => {
  const install = detectWilyTraderInstall();
  if (!install) {
    return {
      ok: false,
      message: 'No local WilyTrader install was found yet.',
      version: null,
      repoPath: null,
      extensionPath: null,
    };
  }

  const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
  const selection = parent
    ? await dialog.showOpenDialog(parent, {
      title: 'Choose new WilyTrader folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    : await dialog.showOpenDialog({
      title: 'Choose new WilyTrader folder',
      properties: ['openDirectory', 'createDirectory'],
    });
  if (selection.canceled || selection.filePaths.length === 0) {
    return {
      ok: false,
      message: 'WilyTrader move canceled. No files were changed.',
      version: install.version,
      repoPath: install.repoPath,
      extensionPath: install.extensionPath,
    };
  }

  const destination = path.resolve(selection.filePaths[0]);
  try {
    const existingManifest = readWilyTraderManifest(destination);
    if (existingManifest) {
      saveWilyTraderInstallPath(existingManifest.repoPath);
      return {
        ok: true,
        message: `Using existing WilyTrader folder: ${existingManifest.extensionPath}`,
        version: existingManifest.version,
        repoPath: existingManifest.repoPath,
        extensionPath: existingManifest.extensionPath,
      };
    }
    const moveResult = moveWilyTraderDirectory(install.repoPath, destination);
    const movedManifest = readWilyTraderManifest(destination);
    if (!movedManifest) {
      throw new Error('Move completed, but the destination WilyTrader manifest could not be verified.');
    }
    saveWilyTraderInstallPath(movedManifest.repoPath);
    cachedWilyTraderUpdateCheckResult = null;
    cachedWilyTraderUpdateCheckResultAtMs = 0;
    clipboard.writeText(movedManifest.extensionPath);
    await revealWilyTraderExtensionFolder(movedManifest.extensionPath);
    const note = moveResult.note ? ` ${moveResult.note}` : '';
    return {
      ok: true,
      message: `Moved WilyTrader files folder to ${movedManifest.repoPath}. Load unpacked from ${movedManifest.extensionPath}.${note}`,
      version: movedManifest.version,
      repoPath: movedManifest.repoPath,
      extensionPath: movedManifest.extensionPath,
    };
  } catch (err) {
    log('wilytrader-update', 'move failed', {
      from: install.repoPath,
      to: destination,
      err: (err as Error).message,
    });
    return {
      ok: false,
      message: `WilyTrader move failed: ${(err as Error).message}`,
      version: install.version,
      repoPath: install.repoPath,
      extensionPath: install.extensionPath,
    };
  }
});

ipcMain.handle('settings:open-release-page', async (_evt, url?: string) => {
  const target = url && /^https?:\/\//i.test(url)
    ? url
    : 'https://github.com/Koprowski/snipalot/releases/latest';
  await shell.openExternal(target);
});

function safeUpdateInstallerName(name: string): string {
  const base = path.basename(name || 'Snipalot-update-setup.exe');
  return base.replace(/[^a-z0-9._-]/gi, '_') || 'Snipalot-update-setup.exe';
}

async function launchUpdateInstaller(installerPath: string): Promise<void> {
  const shellOpenError = await shell.openPath(installerPath);
  if (!shellOpenError) {
    log('settings', 'update installer shell.openPath handoff started', { installerPath });
    return;
  }
  log('settings', 'update installer shell.openPath failed', { installerPath, err: shellOpenError });

  if (process.platform !== 'win32') {
    throw new Error(shellOpenError);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Start-Process -LiteralPath $args[0] -WorkingDirectory (Split-Path -Parent $args[0])',
        installerPath,
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Timed out while launching the update installer.'));
    }, 5_000);

    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log('settings', 'update installer launch handoff started', { installerPath, pid: child.pid });
      child.unref();
      resolve();
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function runGitPull(repoPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-C', repoPath, 'pull', '--ff-only'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        log('wilytrader-update', 'git pull complete', { repoPath, stdout: stdout.trim().slice(-500) });
        resolve();
      } else {
        reject(new Error((stderr || stdout || `git pull exited ${code}`).trim().slice(-800)));
      }
    });
  });
}

async function extractWilyTraderZip(
  zipPath: string,
  destination: string,
  options: { extensionOnly?: boolean } = {}
): Promise<number> {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const rootNames = Object.keys(zip.files)
    .map((name) => name.split('/')[0])
    .filter(Boolean);
  const rootPrefix = rootNames.length > 0 ? `${rootNames[0]}/` : '';
  let fileCount = 0;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    let rawName = entry.name.startsWith(rootPrefix) ? entry.name.slice(rootPrefix.length) : entry.name;
    if (options.extensionOnly) {
      if (!rawName.startsWith('extension/')) continue;
      rawName = rawName.slice('extension/'.length);
    }
    const normalized = path.normalize(rawName);
    if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) continue;
    const targetPath = path.join(destination, normalized);
    const resolvedTarget = path.resolve(targetPath);
    const resolvedDestination = path.resolve(destination);
    if (!resolvedTarget.startsWith(resolvedDestination + path.sep)) continue;
    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    const content = await entry.async('nodebuffer');
    fs.writeFileSync(resolvedTarget, content);
    fileCount += 1;
  }
  return fileCount;
}

function closeSettingsBeforeExternalHandoff(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  try {
    settingsWindow.setAlwaysOnTop(false);
    settingsWindow.close();
  } catch (err) {
    log('settings', 'close before external handoff failed', { err: (err as Error).message });
  }
}

function chromeExtensionsTarget(): { url: string; profileName: string | null; extensionId: string | null } {
  const extensionProfile = wilyTraderExtensionProfilesFromChromeProfiles()[0] ?? null;
  const extensionId = extensionProfile?.id ?? null;
  return {
    url: extensionId ? `chrome://extensions/?id=${extensionId}` : 'chrome://extensions/',
    profileName: extensionProfile?.profileName ?? chromeLastUsedProfileName() ?? 'Default',
    extensionId,
  };
}

function chromeExecutableCandidates(): string[] {
  if (process.platform !== 'win32') return [];
  return [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env.PROGRAMFILES
      ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.env['PROGRAMFILES(X86)']
      ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
}

function startChromeDetached(args: string[]): void {
  const chromeCandidates = chromeExecutableCandidates();
  const child = chromeCandidates.length > 0
    ? spawn(chromeCandidates[0], args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    : spawn('cmd.exe', ['/d', '/c', 'start', '""', 'chrome', ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  child.unref();
}

function createChromeHandoffUrl(marker: string): string {
  const html = [
    '<!doctype html>',
    '<html>',
    '<head>',
    `<title>${marker}</title>`,
    '<meta charset="utf-8">',
    '</head>',
    '<body></body>',
    '</html>',
  ].join('');
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function navigateChromeHandoffWindowWithClipboard(marker: string, url: string): Promise<boolean> {
  const previousClipboardText = clipboard.readText();
  clipboard.writeText(url);
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    'Add-Type -AssemblyName System.Windows.Forms',
    `$marker = '${marker}'`,
    '$ws = New-Object -ComObject WScript.Shell',
    '$deadline = (Get-Date).AddSeconds(6)',
    'do {',
    '  if ($ws.AppActivate($marker) -or $ws.AppActivate(\"$marker - Google Chrome\")) {',
    '    Start-Sleep -Milliseconds 250',
    '    [System.Windows.Forms.SendKeys]::SendWait(\'^l\')',
    '    Start-Sleep -Milliseconds 80',
    '    [System.Windows.Forms.SendKeys]::SendWait(\'^v\')',
    '    Start-Sleep -Milliseconds 80',
    '    [System.Windows.Forms.SendKeys]::SendWait(\'{ENTER}\')',
    '    exit 0',
    '  }',
    '  Start-Sleep -Milliseconds 150',
    '} while ((Get-Date) -lt $deadline)',
    'exit 1',
  ].join('; ');

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => {
      log('wilytrader-update', 'chrome handoff navigation failed to start', {
        marker,
        err: err.message,
      });
      clipboard.writeText(previousClipboardText);
      resolve(false);
    });
    child.on('exit', (code) => {
      clipboard.writeText(previousClipboardText);
      if (code !== 0) {
        log('wilytrader-update', 'chrome handoff navigation failed', { marker, code });
      }
      resolve(code === 0);
    });
  });
}

async function openChromeExtensionsPage(options: { closeSettings?: boolean } = {}): Promise<void> {
  if (options.closeSettings) {
    closeSettingsBeforeExternalHandoff();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const target = chromeExtensionsTarget();
  const profileArgs = target.profileName ? [`--profile-directory=${target.profileName}`] : [];
  if (process.platform === 'win32') {
    try {
      const marker = `SnipalotChromeHandoff${process.pid}${Date.now()}`;
      const handoffUrl = createChromeHandoffUrl(marker);
      const args = [...profileArgs, handoffUrl];
      log('wilytrader-update', 'opening chrome extensions page', {
        hasExtensionId: Boolean(target.extensionId),
        profileName: target.profileName,
        args,
      });
      startChromeDetached(args);
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (await navigateChromeHandoffWindowWithClipboard(marker, target.url)) {
        return;
      }
      clipboard.writeText(target.url);
      log('wilytrader-update', 'chrome extensions url copied after handoff navigation failed', {
        url: target.url,
      });
      return;
    } catch (err) {
      log('wilytrader-update', 'chrome start failed, falling back to shell.openExternal', {
        err: (err as Error).message,
      });
    }
  }
  await shell.openExternal(target.url);
}

async function revealWilyTraderExtensionFolder(extensionPath: string): Promise<void> {
  try {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      shell.showItemInFolder(manifestPath);
      return;
    }
    const openError = await shell.openPath(extensionPath);
    if (openError) {
      log('wilytrader-update', 'extension folder open failed', { extensionPath, err: openError });
    }
  } catch (err) {
    log('wilytrader-update', 'extension folder reveal failed', {
      extensionPath,
      err: (err as Error).message,
    });
  }
}

function assertSafeWilyTraderMove(sourcePath: string, destinationPath: string): void {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  if (source === destination) {
    throw new Error('That is already the current WilyTrader location.');
  }
  if (destination.startsWith(source + path.sep)) {
    throw new Error('Choose a folder outside the current WilyTrader folder.');
  }
  if (source.startsWith(destination + path.sep)) {
    throw new Error('Choose a folder that is not a parent of the current WilyTrader folder.');
  }
  if (!readWilyTraderManifest(source)) {
    throw new Error('Current WilyTrader files are missing a valid manifest.json.');
  }
}

function copyWilyTraderDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
  const movedManifest = readWilyTraderManifest(destination);
  if (!movedManifest) {
    throw new Error('Copied WilyTrader files, but the destination manifest could not be verified.');
  }
}

function moveWilyTraderDirectory(sourcePath: string, destinationPath: string): { sourceRemoved: boolean; note: string | null } {
  const source = path.resolve(sourcePath);
  const destination = path.resolve(destinationPath);
  assertSafeWilyTraderMove(source, destination);
  const destinationExists = fs.existsSync(destination);
  if (fs.existsSync(destination)) {
    if (!isDirectoryEmpty(destination)) {
      throw new Error('Choose an empty folder, or choose an existing WilyTrader folder to use without moving files.');
    }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (destinationExists) {
    copyWilyTraderDirectory(source, destination);
    try {
      fs.rmSync(source, { recursive: true, force: false });
      return { sourceRemoved: true, note: null };
    } catch (removeErr) {
      return {
        sourceRemoved: false,
        note: `Copied to the new folder, but Windows would not remove the old folder automatically: ${(removeErr as Error).message}`,
      };
    }
  }
  try {
    fs.renameSync(source, destination);
    return { sourceRemoved: true, note: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!['EXDEV', 'EPERM', 'EACCES'].includes(code ?? '')) throw err;
    copyWilyTraderDirectory(source, destination);
    try {
      fs.rmSync(source, { recursive: true, force: false });
      return { sourceRemoved: true, note: null };
    } catch (removeErr) {
      return {
        sourceRemoved: false,
        note: `Copied to the new folder, but Windows would not remove the old folder automatically: ${(removeErr as Error).message}`,
      };
    }
  }
}

async function showWilyTraderInstallCompleteDialog(options: {
  version: string;
  repoPath: string;
  extensionPath: string;
}): Promise<void> {
  const parent = launcherWindow && !launcherWindow.isDestroyed() ? launcherWindow : undefined;
  const dialogOptions: MessageBoxOptions = {
    type: 'info',
    buttons: ['Open Chrome Extensions', 'Open WilyTrader Folder', 'OK'],
    defaultId: 2,
    cancelId: 2,
    title: 'WilyTrader files are ready',
    message: `WilyTrader ${options.version} files are ready.`,
    detail: [
      `Load unpacked folder:`,
      options.extensionPath,
      '',
      `WilyTrader files folder:`,
      options.repoPath,
      '',
      'That folder path has been copied to your clipboard.',
      'In Chrome, turn on Developer mode, click Load unpacked, and choose this folder.',
    ].join('\n'),
  };
  const response = parent
    ? await dialog.showMessageBox(parent, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);

  if (response.response === 0) {
    await openChromeExtensionsPage();
  } else if (response.response === 1) {
    await revealWilyTraderExtensionFolder(options.extensionPath);
  }
}

async function prepareWilyTraderPostInstall(options: {
  version: string;
  repoPath: string;
  extensionPath: string;
}): Promise<void> {
  clipboard.writeText(options.extensionPath);
  await revealWilyTraderExtensionFolder(options.extensionPath);
  await showWilyTraderInstallCompleteDialog(options);
}

async function resolveWilyTraderUpdateTarget(
  install: ReturnType<typeof detectWilyTraderInstall>
): Promise<{ repoPath: string; extensionPath: string; isGitRepo: boolean } | null> {
  if (install) {
    return {
      repoPath: install.repoPath,
      extensionPath: install.extensionPath,
      isGitRepo: install.isGitRepo,
    };
  }

  const messageBoxOptions: MessageBoxOptions = {
    type: 'question',
    buttons: ['Select folder', 'Use Snipalot-managed folder', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Find WilyTrader',
    message: 'Snipalot could not find the local WilyTrader extension folder.',
    detail: 'Select an existing WilyTrader repo/extension folder, or select an empty folder where Snipalot can install WilyTrader. You can also use the managed folder.',
  };
  const response = launcherWindow
    ? await dialog.showMessageBox(launcherWindow, messageBoxOptions)
    : await dialog.showMessageBox(messageBoxOptions);

  if (response.response === 2) return null;
  if (response.response === 1) {
    return {
      repoPath: WILYTRADER_MANAGED_DIR,
      extensionPath: path.join(WILYTRADER_MANAGED_DIR, 'extension'),
      isGitRepo: false,
    };
  }

  const openDialogOptions: OpenDialogOptions = {
    title: 'Select WilyTrader folder',
    properties: ['openDirectory'],
  };
  const selection = launcherWindow
    ? await dialog.showOpenDialog(launcherWindow, openDialogOptions)
    : await dialog.showOpenDialog(openDialogOptions);
  if (selection.canceled || selection.filePaths.length === 0) return null;
  const selectedPath = path.resolve(selection.filePaths[0]);
  const manifest = readWilyTraderManifest(selectedPath);
  if (!manifest) {
    if (isDirectoryEmpty(selectedPath)) {
      return {
        repoPath: selectedPath,
        extensionPath: path.join(selectedPath, 'extension'),
        isGitRepo: false,
      };
    }
    throw new Error('The selected folder is not WilyTrader and is not empty. Select the WilyTrader repo/extension folder, or select an empty folder where Snipalot can install WilyTrader.');
  }
  return {
    repoPath: manifest.repoPath,
    extensionPath: manifest.extensionPath,
    isGitRepo: fs.existsSync(path.join(manifest.repoPath, '.git')),
  };
}

async function updateWilyTraderFiles(sender: WebContents): Promise<WilyTraderUpdateInstallResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  const install = detectWilyTraderInstall();
  let target: Awaited<ReturnType<typeof resolveWilyTraderUpdateTarget>> = null;
  let latest: WilyTraderReleaseInfo | null = null;
  try {
    latest = await fetchLatestWilyTraderReleaseInfo(controller.signal);
    target = await resolveWilyTraderUpdateTarget(install);
    if (!target) {
      return {
        ok: false,
        message: 'WilyTrader update canceled. No local folder was changed.',
        repoPath: null,
        extensionPath: null,
        releaseUrl: latest.htmlUrl,
      };
    }
    const { repoPath, extensionPath, isGitRepo } = target;
    log('wilytrader-update', 'update start', {
      repoPath,
      currentVersion: install?.version ?? null,
      latestVersion: latest.version,
      isGitRepo,
    });

    if (isGitRepo) {
      await runGitPull(repoPath);
    } else {
      const downloadDir = path.join(os.tmpdir(), 'snipalot-wilytrader-updates');
      const zipPath = path.join(downloadDir, `WilyTrader-${latest.version}.zip`);
      const bytes = await downloadFile(latest.zipballUrl, zipPath, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (sender.isDestroyed()) return;
          sender.send('launcher:wilytrader-download-progress', {
            version: latest?.version ?? '',
            ...progress,
          });
        },
      });
      const extensionOnly = fs.existsSync(path.join(repoPath, 'manifest.json')) &&
        !fs.existsSync(path.join(repoPath, 'extension', 'manifest.json'));
      const files = await extractWilyTraderZip(zipPath, repoPath, { extensionOnly });
      log('wilytrader-update', 'zip update complete', { repoPath, bytes, files });
    }

    const manifest = readWilyTraderManifest(repoPath);
    const installedVersion = manifest?.version ?? latest.version;
    const finalExtensionPath = manifest?.extensionPath ?? extensionPath;
    saveWilyTraderInstallPath(manifest?.repoPath ?? repoPath);
    cachedWilyTraderUpdateCheckResult = {
      ok: true,
      currentVersion: installedVersion,
      latestVersion: latest.version,
      updateAvailable: false,
      repoPath,
      extensionPath: finalExtensionPath,
      releaseUrl: latest.htmlUrl,
      message: `WilyTrader files are updated to ${installedVersion}. Load unpacked from ${finalExtensionPath}.`,
    };
    cachedWilyTraderUpdateCheckResultAtMs = Date.now();
    sendLauncherWilyTraderUpdateCheckResult(cachedWilyTraderUpdateCheckResult);
    await prepareWilyTraderPostInstall({
      version: installedVersion,
      repoPath,
      extensionPath: finalExtensionPath,
    });
    return {
      ok: true,
      message: `Updated WilyTrader files to ${installedVersion}. Load unpacked from ${finalExtensionPath}.`,
      repoPath,
      extensionPath: finalExtensionPath,
      releaseUrl: latest.htmlUrl,
    };
  } catch (err) {
    const message = (err as Error).message;
    log('wilytrader-update', 'update failed', { repoPath: target?.repoPath ?? install?.repoPath ?? null, err: message });
    return {
      ok: false,
      message: `WilyTrader update failed: ${message}`,
      repoPath: target?.repoPath ?? install?.repoPath ?? null,
      extensionPath: target?.extensionPath ?? install?.extensionPath ?? null,
      releaseUrl: latest?.htmlUrl ?? WILYTRADER_REPO_URL,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadAndInstallSnipalotUpdate(
  sender: WebContents,
  source: 'settings' | 'launcher'
): Promise<SettingsUpdateInstallResult> {
  const currentVersion = app.getVersion();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  let latest: GitHubReleaseInfo | null = null;
  let installerPath: string | null = null;
  try {
    latest = await fetchLatestSnipalotReleaseInfo(controller.signal);
    const release = latest;
    if (!isRemoteVersionNewer(currentVersion, release.version)) {
      return {
        ok: false,
        message: `Snipalot is already up to date (v${currentVersion}).`,
        releaseUrl: release.htmlUrl,
      };
    }
    if (!release.installerAssetUrl || !release.installerAssetName) {
      return {
        ok: false,
        message: `Update v${release.version} is available, but no setup.exe asset was found. Opening the release page instead.`,
        releaseUrl: release.htmlUrl,
      };
    }
    const updateDir = path.join(os.tmpdir(), 'snipalot-updates');
    installerPath = path.join(updateDir, safeUpdateInstallerName(release.installerAssetName));
    log(source, 'update download start', {
      currentVersion,
      latestVersion: release.version,
      installerName: release.installerAssetName,
    });
    const sendProgress = (progress: DownloadProgress) => {
      if (sender.isDestroyed()) return;
      const channel = source === 'launcher'
        ? 'launcher:update-download-progress'
        : 'settings:update-download-progress';
      sender.send(channel, {
        version: release.version,
        installerName: release.installerAssetName,
        ...progress,
      });
    };
    const bytes = await downloadFile(release.installerAssetUrl, installerPath, {
      signal: controller.signal,
      onProgress: sendProgress,
    });
    sendProgress({ downloadedBytes: bytes, totalBytes: bytes, percent: 100 });
    log(source, 'update download complete', { installerPath, bytes });
    await launchUpdateInstaller(installerPath);
    setTimeout(() => requestAppExit(`install update v${release.version}`), 750);
    return {
      ok: true,
      message: `Downloaded v${release.version}. Snipalot will close and launch the installer.`,
      installerPath,
      releaseUrl: release.htmlUrl,
    };
  } catch (err) {
    const message = (err as Error).message;
    log(source, 'download-and-install-update failed', { err: message });
    if (installerPath && fs.existsSync(installerPath)) {
      shell.showItemInFolder(installerPath);
      return {
        ok: false,
        message: `Update installer was downloaded, but Windows did not launch it automatically: ${message}. The installer has been shown in File Explorer; run it there and use More info -> Run anyway if SmartScreen appears.`,
        installerPath,
        releaseUrl: latest?.htmlUrl ?? 'https://github.com/Koprowski/snipalot/releases/latest',
      };
    }
    return {
      ok: false,
      message: `Update install failed: ${message}`,
      releaseUrl: 'https://github.com/Koprowski/snipalot/releases/latest',
    };
  } finally {
    clearTimeout(timeout);
  }
}

ipcMain.handle('settings:download-and-install-update', async (evt): Promise<SettingsUpdateInstallResult> => {
  return downloadAndInstallSnipalotUpdate(evt.sender, 'settings');
});

ipcMain.handle('launcher:install-update', async (evt): Promise<SettingsUpdateInstallResult> => {
  return downloadAndInstallSnipalotUpdate(evt.sender, 'launcher');
});

function sanitizeSettingsPartialForLog(
  partial: Partial<SnipalotConfig>
): Partial<SnipalotConfig> & { redactedKeys?: string[] } {
  const clone: Partial<SnipalotConfig> & { redactedKeys?: string[] } = JSON.parse(
    JSON.stringify(partial)
  );
  const redacted: string[] = [];
  if (clone.trade) {
    if (typeof clone.trade.openaiApiKey === 'string' && clone.trade.openaiApiKey.length > 0) {
      clone.trade.openaiApiKey = '[REDACTED]';
      redacted.push('trade.openaiApiKey');
    }
    if (
      typeof (clone.trade as unknown as { geminiApiKey?: unknown }).geminiApiKey === 'string' &&
      ((clone.trade as unknown as { geminiApiKey?: string }).geminiApiKey ?? '').length > 0
    ) {
      (clone.trade as unknown as { geminiApiKey?: string }).geminiApiKey = '[REDACTED]';
      redacted.push('trade.geminiApiKey');
    }
  }
  if (redacted.length > 0) clone.redactedKeys = redacted;
  return clone;
}

type TradeProvider = 'openai';
interface TradeApiTestRequest {
  provider: TradeProvider;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}
interface TradeApiTestResult {
  ok: boolean;
  provider: TradeProvider;
  status: number | null;
  message: string;
}

async function testOpenAiCompatibleApiKey(
  apiKey: string,
  baseUrl: string,
  model: string
): Promise<TradeApiTestResult> {
  if (!apiKey) {
    return { ok: false, provider: 'openai', status: null, message: 'API key is required.' };
  }
  const normalizedBase = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const useModel = model || 'google/gemini-2.5-flash';
  const url = `${normalizedBase}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
        max_tokens: 6,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    const body = await res.text().catch(() => '');
    if (!res.ok) {
      log('settings', 'test-api-key openai-compatible HTTP error', {
        status: res.status,
        baseUrl: normalizedBase,
        model: useModel,
        bodyPreview: body.slice(0, 300),
      });
      return {
        ok: false,
        provider: 'openai',
        status: res.status,
        message: `OpenAI-compatible auth/test failed (HTTP ${res.status}).`,
      };
    }
    return {
      ok: true,
      provider: 'openai',
      status: res.status,
      message: 'OpenAI-compatible API key is valid.',
    };
  } catch (err) {
    log('settings', 'test-api-key openai-compatible failed', {
      baseUrl: normalizedBase,
      model: useModel,
      err: (err as Error).message,
    });
    return {
      ok: false,
      provider: 'openai',
      status: null,
      message: `OpenAI-compatible test request failed: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function testGeminiCliConnection(
  command: string,
  model: string
): Promise<{ ok: boolean; message: string; guidance?: SettingsTestLlmGuidance }> {
  const geminiCliInstallDocsUrl = 'https://github.com/google-gemini/gemini-cli#installation';
  const installCommand = process.platform === 'win32'
    ? 'npm install -g @google/gemini-cli'
    : 'npm install -g @google/gemini-cli';
  const buildGeminiCliMissingGuidance = (reason: string): SettingsTestLlmGuidance => ({
    kind: 'gemini-cli-missing',
    title: 'Gemini CLI is not installed yet',
    explanation: reason,
    installCommand,
    docsUrl: geminiCliInstallDocsUrl,
  });
  const isMissingCliError = (value: string): boolean =>
    /(enoent|not found|is not recognized|cannot find|no such file)/i.test(value);
  const cliCommand = (command || 'gemini').trim();
  const resolvedCli = resolveGeminiCliExecutable(cliCommand);
  const cliModel = (model || 'gemini-3.1-pro-preview').trim();
  // Strip GEMINI_API_KEY from the spawn env so the CLI uses whatever
  // auth method is configured in ~/.gemini/settings.json (OAuth via
  // Google account = free tier, vs. paid API key auth). Without this,
  // a stale env var forces api-key mode and triggers expired-key errors.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? 'true',
    // Resolver returns process.execPath as the spawn binary so we bypass
    // the .cmd shim's EINVAL on Node 22+. Inside Electron, process.execPath
    // is electron.exe — it only behaves like Node when this env var is set.
    ELECTRON_RUN_AS_NODE: '1',
    // Gemini CLI relaunches itself on startup for heap-size tuning. The
    // relaunch bypasses our shim (calls spawn(process.execPath, ...) with
    // the original argv), so the child process triggers yargs's
    // "phantom positional" bug under Electron all over again. Disabling
    // the relaunch keeps everything in the shim'd parent process. We pay
    // a default-heap-size penalty, irrelevant for short test prompts.
    GEMINI_CLI_NO_RELAUNCH: 'true',
  };
  delete env.GEMINI_API_KEY;
  const runGemini = (
    args: string[],
    timerMs: number
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; launchError?: string }> =>
    new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const { spawn } = require('node:child_process') as typeof import('node:child_process');
      // Windows + shell:true runs through cmd.exe and breaks argv quoting for
      // multi-word --prompt values, which makes Gemini CLI see both -p and a
      // positional prompt ("Cannot use both..."). Prefer direct CreateProcess.
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(resolvedCli.command, [...resolvedCli.prefixArgs, ...args], {
          windowsHide: true,
          shell: false,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({
          code: -1,
          stdout,
          stderr,
          timedOut,
          launchError: (err as Error).message,
        });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timerMs);
      child.stdout?.on('data', (d) => { stdout += String(d); });
      child.stderr?.on('data', (d) => { stderr += String(d); });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          code: -1,
          stdout,
          stderr,
          timedOut,
          launchError: (err as Error).message,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });

  const cleanStderrTail = (stderr: string, max = 500): string =>
    stderr
      .split('\n')
      .filter((line) => !/crashpad/i.test(line))
      .join('\n')
      .trim()
      .slice(0, max);

  log('settings', 'gemini-cli test start', {
    cliCommand,
    resolvedCommand: resolvedCli.command,
    hasPrefixArgs: resolvedCli.prefixArgs.length > 0,
    model: cliModel,
  });

  const versionProbe = await runGemini(['--version'], 10_000);
  if (versionProbe.launchError) {
    const launchErr = versionProbe.launchError.trim();
    const missingCli = isMissingCliError(launchErr);
    log('settings', 'gemini-cli test launch failed', {
      step: 'version',
      err: launchErr,
      missingCli,
      resolvedCommand: resolvedCli.command,
    });
    if (missingCli) {
      return {
        ok: false,
        message: 'Gemini CLI was not found on this machine. Install it, then run this test again.',
        guidance: buildGeminiCliMissingGuidance('Snipalot could not find the configured Gemini CLI command.'),
      };
    }
    return { ok: false, message: `Gemini CLI launch failed: ${launchErr}` };
  }
  if (versionProbe.code !== 0) {
    const stderrTail = cleanStderrTail(versionProbe.stderr, 400);
    const missingCli = isMissingCliError(stderrTail);
    log('settings', 'gemini-cli test step failed', {
      step: 'version',
      code: versionProbe.code,
      stderrTail,
      missingCli,
    });
    if (missingCli) {
      return {
        ok: false,
        message: 'Gemini CLI was not found on this machine. Install it, then run this test again.',
        guidance: buildGeminiCliMissingGuidance('The configured Gemini CLI command is unavailable in your PATH.'),
      };
    }
    return {
      ok: false,
      message: `Gemini CLI --version failed (code ${versionProbe.code}). ${versionProbe.stderr.trim().slice(0, 400)}`,
    };
  }

// Skip the model-listing probe — `gemini models` is not a real subcommand
  // (CLI parses it as a positional query and enters interactive mode → 20s
  // hang every time). The actual prompt probe below catches an unavailable
  // model with a useful error from the API anyway.

  const promptProbe = await runGemini(
    ['--model', cliModel, '--output-format', 'json', '--prompt', 'Reply with exactly: ok'],
    30_000
  );

  if (promptProbe.timedOut) {
    log('settings', 'gemini-cli test step failed', {
      step: 'prompt-flag',
      reason: 'timeout',
      code: promptProbe.code,
    });
    return {
      ok: false,
      message: 'Gemini CLI prompt test timed out after 30s.',
    };
  }
  if (promptProbe.code !== 0) {
    const promptFlagErr = cleanStderrTail(promptProbe.stderr);
    const positionalConflict = /Cannot use both a positional prompt and the --prompt flag together/i.test(promptProbe.stderr);
    if (positionalConflict) {
      // Some Gemini CLI + runtime combos still surface a phantom positional
      // prompt. Retry without --prompt so the test succeeds on either parser.
      log('settings', 'gemini-cli test retrying positional prompt', {
        code: promptProbe.code,
        stderrTail: promptFlagErr,
      });
      const positionalProbe = await runGemini(
        ['--model', cliModel, '--output-format', 'json', 'Reply with exactly: ok'],
        30_000
      );
      if (positionalProbe.timedOut) {
        log('settings', 'gemini-cli test step failed', {
          step: 'prompt-positional',
          reason: 'timeout',
          code: positionalProbe.code,
        });
        return { ok: false, message: 'Gemini CLI prompt test timed out after 30s.' };
      }
      if (positionalProbe.code !== 0) {
        log('settings', 'gemini-cli test step failed', {
          step: 'prompt-positional',
          code: positionalProbe.code,
          stderrTail: cleanStderrTail(positionalProbe.stderr),
        });
        return {
          ok: false,
          message: `Gemini CLI prompt test failed (code ${positionalProbe.code}). ${cleanStderrTail(positionalProbe.stderr)}`,
        };
      }
      if (!positionalProbe.stdout.trim()) {
        log('settings', 'gemini-cli test step failed', {
          step: 'prompt-positional',
          reason: 'empty-stdout',
        });
        return { ok: false, message: 'Gemini CLI prompt test returned empty output.' };
      }
      log('settings', 'gemini-cli test success', {
        fallback: 'positional-prompt',
        resolvedCommand: resolvedCli.command,
        model: cliModel,
      });
      return {
        ok: true,
        message: `Gemini CLI connection OK (command: ${resolvedCli.command}, model: ${cliModel}).`,
      };
    }
    log('settings', 'gemini-cli test step failed', {
      step: 'prompt-flag',
      code: promptProbe.code,
      stderrTail: promptFlagErr,
    });
    return {
      ok: false,
      message: `Gemini CLI prompt test failed (code ${promptProbe.code}). ${promptFlagErr}`,
    };
  }
  if (!promptProbe.stdout.trim()) {
    log('settings', 'gemini-cli test step failed', {
      step: 'prompt-flag',
      reason: 'empty-stdout',
    });
    return { ok: false, message: 'Gemini CLI prompt test returned empty output.' };
  }
  log('settings', 'gemini-cli test success', {
    fallback: 'none',
    resolvedCommand: resolvedCli.command,
    model: cliModel,
  });
  return {
    ok: true,
    message: `Gemini CLI connection OK (command: ${resolvedCli.command}, model: ${cliModel}).`,
  };
}

function findBundledWhisperDependency(): {
  ok: boolean;
  message: string;
  exePath?: string;
  modelPath?: string;
} {
  const roots = app.isPackaged
    ? [
        path.join(app.getPath('userData'), 'resources'),
        path.join(process.resourcesPath || '', 'resources'),
        path.join(process.cwd(), 'resources'),
      ]
    : [
        path.join(process.cwd(), 'resources'),
        path.join(app.getPath('userData'), 'resources'),
        path.join(process.resourcesPath || '', 'resources'),
      ];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const binDir = path.join(root, 'bin', 'whisper');
    const exe = [
      path.join(binDir, 'whisper-cli.exe'),
      path.join(binDir, 'main.exe'),
      path.join(binDir, 'Release', 'whisper-cli.exe'),
      path.join(binDir, 'Release', 'main.exe'),
    ]
      .find((candidate) => fs.existsSync(candidate));
    const model = path.join(root, 'models', 'ggml-base.en.bin');
    if (exe && fs.existsSync(model)) {
      return {
        ok: true,
        message: 'Bundled local transcription engine is installed.',
        exePath: exe,
        modelPath: model,
      };
    }
  }
  return {
    ok: false,
    message: 'Whisper files were not found. Use Install Whisper in this setup checklist.',
  };
}

const WHISPER_RELEASE_TAG = 'v1.8.4';
const WHISPER_ZIP_NAME = 'whisper-blas-bin-x64.zip';
const WHISPER_ZIP_URL =
  `https://github.com/ggerganov/whisper.cpp/releases/download/${WHISPER_RELEASE_TAG}/${WHISPER_ZIP_NAME}`;
const WHISPER_MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

type DownloadProgress = {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
};

async function downloadFile(
  url: string,
  dest: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: DownloadProgress) => void;
  } = {}
): Promise<number> {
  const res = await fetch(url, { redirect: 'follow', signal: options.signal });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const totalHeader = res.headers.get('content-length');
  const totalBytes = totalHeader ? Number(totalHeader) : NaN;
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null;
  const body = res.body;
  let downloaded = 0;

  options.onProgress?.({
    downloadedBytes: 0,
    totalBytes: total,
    percent: total ? 0 : null,
  });

  if (!body) {
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buffer);
    options.onProgress?.({
      downloadedBytes: buffer.length,
      totalBytes: total ?? buffer.length,
      percent: 100,
    });
    return buffer.length;
  }

  const file = fs.createWriteStream(dest);
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk);
      downloaded += buffer.length;
      if (!file.write(buffer)) {
        await new Promise<void>((resolve) => file.once('drain', resolve));
      }
      options.onProgress?.({
        downloadedBytes: downloaded,
        totalBytes: total,
        percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null,
      });
    }
    await new Promise<void>((resolve, reject) => {
      file.end((err?: Error | null) => err ? reject(err) : resolve());
    });
    return downloaded;
  } catch (err) {
    file.destroy();
    try { fs.rmSync(dest, { force: true }); } catch {}
    throw err;
  }
}

async function installWhisperDependency(): Promise<{ ok: boolean; message: string; exePath?: string; modelPath?: string }> {
  const existing = findBundledWhisperDependency();
  if (existing.ok) return existing;

  const root = path.join(app.getPath('userData'), 'resources');
  const binDir = path.join(root, 'bin', 'whisper');
  const modelPath = path.join(root, 'models', 'ggml-base.en.bin');
  const zipPath = path.join(binDir, WHISPER_ZIP_NAME);

  try {
    log('settings', 'whisper install start', { root });
    if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 100_000_000) {
      const bytes = await downloadFile(WHISPER_MODEL_URL, modelPath);
      log('settings', 'whisper model downloaded', { modelPath, bytes });
    }

    const exeExists =
      fs.existsSync(path.join(binDir, 'whisper-cli.exe')) ||
      fs.existsSync(path.join(binDir, 'main.exe')) ||
      fs.existsSync(path.join(binDir, 'Release', 'whisper-cli.exe')) ||
      fs.existsSync(path.join(binDir, 'Release', 'main.exe'));
    if (!exeExists) {
      const bytes = await downloadFile(WHISPER_ZIP_URL, zipPath);
      log('settings', 'whisper binary zip downloaded', { zipPath, bytes });
      const extract = await runDependencyProbe(
        'powershell',
        ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${binDir}" -Force`],
        2 * 60 * 1000
      );
      if (!extract.ok) {
        throw new Error(`Whisper zip extraction failed: ${(extract.stderr || extract.error || '').slice(-500)}`);
      }
    }

    const installed = findBundledWhisperDependency();
    if (!installed.ok) {
      log('settings', 'whisper install verify failed', { root });
      return {
        ok: false,
        message: 'Whisper downloaded, but Snipalot could not verify the executable and model.',
      };
    }
    return {
      ...installed,
      message: `Whisper installed under ${root}.`,
    };
  } catch (err) {
    log('settings', 'whisper install failed', { err: (err as Error).message });
    return {
      ok: false,
      message: `Whisper install failed: ${(err as Error).message}`,
    };
  }
}

function runDependencyProbe(
  command: string,
  args: string[],
  timeoutMs = 15_000,
  env?: NodeJS.ProcessEnv
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; error?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout, stderr, error: (err as Error).message, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr, error: err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}

function dependencyPathEntries(): string[] {
  if (process.platform !== 'win32') return [];
  return [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '',
  ].filter((entry) => !!entry && fs.existsSync(entry));
}

function dependencyProbeEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return { ...process.env };
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
  const existingPath = process.env[pathKey] ?? '';
  const extra = dependencyPathEntries();
  return {
    ...process.env,
    [pathKey]: [...extra, existingPath].filter(Boolean).join(path.delimiter),
  };
}

function resolveNpmExecutable(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return 'npm';
  const candidates = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'npm.cmd') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'npm.cmd') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'npm.cmd') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const found = execSync('where.exe npm.cmd', {
      env,
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line && fs.existsSync(line));
    if (found) return found;
  } catch {
    // Fall through to PATH lookup through cmd.exe below.
  }
  return 'npm.cmd';
}

function quoteCmdArg(arg: string): string {
  if (!/[\s&()^|<>"]/g.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function runNpmDependencyProbe(
  args: string[],
  timeoutMs = 15_000
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string; error?: string; timedOut: boolean }> {
  const env = dependencyProbeEnv();
  if (process.platform !== 'win32') {
    return runDependencyProbe('npm', args, timeoutMs, env);
  }
  const npm = resolveNpmExecutable(env);
  const comspec = process.env.ComSpec || 'cmd.exe';
  const npmCommand = ['call', quoteCmdArg(npm), ...args.map(quoteCmdArg)].join(' ');
  return runDependencyProbe(
    comspec,
    ['/d', '/c', npmCommand],
    timeoutMs,
    env
  );
}

function wingetCommand(): string {
  return process.platform === 'win32' ? 'winget.exe' : 'winget';
}

function sanitizeSupportLog(contents: string): string {
  return contents
    .replace(/(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s\\]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)(sk-[A-Za-z0-9._-]+)/g, '$1[REDACTED]')
    .replace(/((?:openaiApiKey|geminiApiKey|apiKey|token|secret|password)["']?\s*[:=]\s*["']?)[^"',\s\\]+/gi, '$1[REDACTED]')
    .replace(/sk-or-[A-Za-z0-9._-]+/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/sk-[A-Za-z0-9._-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_GOOGLE_API_KEY]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

async function copySupportLogToClipboard(): Promise<
  | { ok: true; mode: 'file' | 'text'; path: string; bytes: number }
  | { ok: false; error: string }
> {
  const sourcePath = getLogPath();
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, error: 'Log file was not found yet.' };
  }

  try {
    const raw = fs.readFileSync(sourcePath, 'utf-8');
    const sanitized = sanitizeSupportLog(raw);
    const supportDir = path.join(app.getPath('temp'), 'snipalot-support');
    fs.mkdirSync(supportDir, { recursive: true });
    const supportPath = path.join(supportDir, 'snipalot-support.log');
    fs.writeFileSync(supportPath, sanitized, 'utf-8');

    if (process.platform === 'win32') {
      const result = await runDependencyProbe(
        'powershell',
        ['-NoProfile', '-Command', `Set-Clipboard -LiteralPath "${supportPath}"`],
        10_000
      );
      if (result.ok) {
        log('launcher', 'support log file copied to clipboard', { supportPath });
        return { ok: true, mode: 'file', path: supportPath, bytes: Buffer.byteLength(sanitized) };
      }
      log('launcher', 'support log file clipboard failed; falling back to text', {
        error: result.error,
        stderr: result.stderr.slice(-500),
      });
    }

    clipboard.writeText(sanitized);
    log('launcher', 'support log text copied to clipboard', { supportPath });
    return { ok: true, mode: 'text', path: supportPath, bytes: Buffer.byteLength(sanitized) };
  } catch (err) {
    log('launcher', 'support log copy failed', { err: (err as Error).message });
    return { ok: false, error: `Could not copy support log: ${(err as Error).message}` };
  }
}

ipcMain.handle('settings:check-dependencies', async (_evt, payload?: { geminiCliCommand?: string }) => {
  const whisper = findBundledWhisperDependency();
  const npmProbe = await runNpmDependencyProbe(['--version'], 10_000);
  const cliCommand = (payload?.geminiCliCommand || 'gemini').trim() || 'gemini';
  const resolvedCli = resolveGeminiCliExecutable(cliCommand);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? 'true',
    ELECTRON_RUN_AS_NODE: '1',
    GEMINI_CLI_NO_RELAUNCH: 'true',
  };
  delete env.GEMINI_API_KEY;
  const geminiProbe = await runDependencyProbe(
    resolvedCli.command,
    [...resolvedCli.prefixArgs, '--version'],
    10_000,
    env
  );
  const geminiCli = geminiProbe.ok
    ? {
        ok: true,
        message: `${geminiProbe.stdout.trim() || 'Gemini CLI'} is installed.`,
        version: geminiProbe.stdout.trim(),
        command: resolvedCli.command,
      }
    : {
        ok: false,
        message: geminiProbe.error
          ? `Gemini CLI was not found (${geminiProbe.error}).`
          : `Gemini CLI check failed${geminiProbe.timedOut ? ' (timed out)' : ''}.`,
        command: resolvedCli.command,
      };
  log('settings', 'dependency check', {
    appVersion: app.getVersion(),
    whisperOk: whisper.ok,
    npmOk: npmProbe.ok,
    npmCode: npmProbe.code,
    npmError: npmProbe.error,
    npmTimedOut: npmProbe.timedOut,
    npmStdoutTail: npmProbe.stdout.slice(-300),
    npmStderrTail: npmProbe.stderr.slice(-300),
    geminiOk: geminiCli.ok,
  });
  const nodeStatus = npmProbe.ok
    ? {
        ok: true,
        message: `npm ${npmProbe.stdout.trim()} is available.`,
        version: npmProbe.stdout.trim(),
      }
    : geminiCli.ok
      ? {
          ok: true,
          optional: true,
          message: 'Gemini CLI is already installed and working. Node/npm is only needed if Snipalot needs to install or update Gemini CLI for you.',
        }
      : {
          ok: false,
          message: npmProbe.error
            ? `npm was not found (${npmProbe.error}). Install Node.js LTS first.`
            : `npm check failed${npmProbe.timedOut ? ' (timed out)' : ''}. Install Node.js LTS first.`,
        };
  return { whisper, node: nodeStatus, geminiCli };
});

ipcMain.handle('settings:install-gemini-cli', async () => {
  log('settings', 'gemini-cli install start');
  const result = await runNpmDependencyProbe(
    ['install', '-g', '@google/gemini-cli'],
    5 * 60 * 1000
  );
  const stdoutTail = result.stdout.slice(-1000);
  const stderrTail = result.stderr.slice(-1000);
  if (!result.ok) {
    log('settings', 'gemini-cli install failed', {
      code: result.code,
      timedOut: result.timedOut,
      error: result.error,
      stderrTail,
    });
    return {
      ok: false,
      message: result.error
        ? `Could not start npm: ${result.error}. Install Node.js LTS, then try again.`
        : `Gemini CLI install failed${result.timedOut ? ' (timed out)' : ''}.`,
      stdoutTail,
      stderrTail,
    };
  }
  log('settings', 'gemini-cli install complete', { stdoutTail, stderrTail });
  return {
    ok: true,
    message: 'Gemini CLI installed. Next, click Sign in with Google.',
    stdoutTail,
    stderrTail,
  };
});

ipcMain.handle('settings:install-whisper', async () => {
  return installWhisperDependency();
});

ipcMain.handle('settings:install-node', async () => {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Automatic Node.js install is only supported on Windows. Open nodejs.org/download to install Node.js LTS.' };
  }
  log('settings', 'node install start via winget');
  const result = await runDependencyProbe(
    wingetCommand(),
    [
      'install',
      '--id',
      'OpenJS.NodeJS.LTS',
      '-e',
      '--source',
      'winget',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ],
    10 * 60 * 1000
  );
  const stdoutTail = result.stdout.slice(-1000);
  const stderrTail = result.stderr.slice(-1000);
  if (!result.ok) {
    log('settings', 'node install failed', {
      code: result.code,
      timedOut: result.timedOut,
      error: result.error,
      stderrTail,
    });
    return {
      ok: false,
      message: result.error
        ? `Could not start winget: ${result.error}. Open nodejs.org/download to install Node.js LTS.`
        : `Node.js install failed${result.timedOut ? ' (timed out)' : ''}. Open nodejs.org/download if needed.`,
      stdoutTail,
      stderrTail,
    };
  }
  log('settings', 'node install complete', { stdoutTail, stderrTail });
  return {
    ok: true,
    message: 'Node.js LTS install completed. If npm is still missing, restart Snipalot so Windows refreshes PATH.',
    stdoutTail,
    stderrTail,
  };
});

interface OpenRouterModelSummary {
  id: string;
  createdAtMs: number;
  inputCostPer1M: number;
}

interface GeminiCliModelSummary {
  id: string;
  createdAtMs: number;
}

const GEMINI_CLI_FALLBACK_MODELS: GeminiCliModelSummary[] = [
  { id: 'gemini-3.1-pro-preview', createdAtMs: Date.parse('2026-02-19') || 0 },
  { id: 'gemini-3.1-flash-lite-preview', createdAtMs: Date.parse('2026-03-03') || 0 },
  { id: 'gemini-3.1-flash-image-preview', createdAtMs: Date.parse('2026-03-03') || 0 },
  { id: 'gemini-3-flash-preview', createdAtMs: Date.parse('2025-12-01') || 0 },
  { id: 'gemini-3-pro-preview', createdAtMs: Date.parse('2025-11-01') || 0 },
  { id: 'gemini-3-pro-image-preview', createdAtMs: Date.parse('2025-11-01') || 0 },
  { id: 'gemini-2.5-pro', createdAtMs: Date.parse('2025-03-01') || 0 },
  { id: 'gemini-2.5-flash', createdAtMs: Date.parse('2025-03-01') || 0 },
  { id: 'gemini-2.0-flash', createdAtMs: Date.parse('2024-12-01') || 0 },
  { id: 'gemini-2.0-flash-lite', createdAtMs: Date.parse('2024-12-01') || 0 },
  { id: 'gemini-1.5-pro', createdAtMs: Date.parse('2024-02-01') || 0 },
  { id: 'gemini-1.5-flash', createdAtMs: Date.parse('2024-02-01') || 0 },
];

function getOpenRouterModelsCachePath(): string {
  return path.join(app.getPath('userData'), 'openrouter-models-cache.json');
}

async function listOpenRouterModelsWithCache(): Promise<OpenRouterModelSummary[]> {
  const cachePath = getOpenRouterModelsCachePath();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json() as {
      data?: Array<{
        id?: string;
        created_at?: number | string | null;
        createdAt?: number | string | null;
        pricing?: {
          prompt?: string | number | null;
          input?: string | number | null;
        } | null;
      }>;
    };
    const models = (raw.data ?? [])
      .filter((m) => typeof m.id === 'string' && m.id.length > 0)
      .map((m) => {
        const createdRaw = m.created_at ?? m.createdAt ?? 0;
        const createdAtMs = typeof createdRaw === 'number'
          ? (createdRaw > 1_000_000_000_000 ? createdRaw : createdRaw * 1000)
          : (Date.parse(String(createdRaw)) || 0);
        const rawInputCost = m.pricing?.prompt ?? m.pricing?.input ?? 0;
        const inputCostPerToken = Number(rawInputCost) || 0;
        const inputCostPer1M = inputCostPerToken * 1_000_000;
        return { id: String(m.id), createdAtMs, inputCostPer1M };
      })
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    fs.writeFileSync(cachePath, JSON.stringify({ updatedAtMs: Date.now(), models }, null, 2), 'utf8');
    return models;
  } catch (err) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { models?: OpenRouterModelSummary[] };
      if (Array.isArray(cached.models) && cached.models.length > 0) {
        log('settings', 'openrouter model fetch failed, using cache', { err: (err as Error).message });
        return cached.models;
      }
    } catch {
      // no cache available
    }
    throw err;
  }
}

async function listGeminiCliModelsWithCache(_command: string): Promise<GeminiCliModelSummary[]> {
  // Note: Gemini CLI has no `models` subcommand — passing it makes the CLI
  // treat "models" as a positional query and hang in interactive REPL mode.
  // Just return the curated static list based on the public Gemini model
  // docs. Users can still type any model name into the input field manually
  // if their CLI/account exposes something off-list.
  return [...GEMINI_CLI_FALLBACK_MODELS].sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id));
}

ipcMain.handle(
  'settings:test-llm-connection',
  async (
    _evt,
    payload: {
      llmMode?: 'gemini-cli' | 'api';
      geminiCliCommand?: string;
      geminiCliModel?: string;
      openaiApiKey?: string;
      openaiBaseUrl?: string;
      openaiModel?: string;
    }
  ): Promise<{ ok: boolean; mode: 'gemini-cli' | 'api'; message: string; guidance?: SettingsTestLlmGuidance }> => {
    const mode = payload?.llmMode === 'api' ? 'api' : 'gemini-cli';
    if (mode === 'gemini-cli') {
      const result = await testGeminiCliConnection(
        payload?.geminiCliCommand ?? 'gemini',
        payload?.geminiCliModel ?? 'gemini-3.1-pro-preview'
      );
      return { ok: result.ok, mode, message: result.message, guidance: result.guidance };
    }

    const apiKey = payload?.openaiApiKey?.trim() ?? '';
    if (!apiKey) {
      return {
        ok: false,
        mode,
        message: 'API mode: OpenRouter/OpenAI API key is required.',
      };
    }
    const baseUrl = payload?.openaiBaseUrl ?? 'https://openrouter.ai/api/v1';
    const model = payload?.openaiModel ?? 'google/gemini-2.5-flash';
    const result = await testOpenAiCompatibleApiKey(apiKey, baseUrl, model);
    return {
      ok: result.ok,
      mode,
      message: result.ok
        ? `API connection OK (${baseUrl.includes('openrouter') ? 'OpenRouter' : 'OpenAI-compatible'}).`
        : result.message,
    };
  }
);

ipcMain.handle('settings:list-openrouter-models', async (): Promise<OpenRouterModelSummary[]> => {
  return listOpenRouterModelsWithCache();
});

ipcMain.handle('settings:list-gemini-cli-models', async (_evt, command?: string): Promise<GeminiCliModelSummary[]> => {
  return listGeminiCliModelsWithCache(command ?? 'gemini');
});

// ─── Gemini CLI OAuth sign-in (free tier via Google account) ─────────
//
// User clicks "Sign in with Google" in Settings → we spawn gemini with
// piped stdio, auto-respond "y" to its "Open authentication page?"
// prompt, the CLI opens the browser for OAuth and runs a local HTTP
// callback server. When the user completes the Google login flow,
// the CLI writes oauth_creds.json. We poll for that file and return
// success the moment it appears, killing the now-idle CLI process.

const OAUTH_CREDS_PATH = path.join(os.homedir(), '.gemini', 'oauth_creds.json');

let activeGeminiSigninChild: import('node:child_process').ChildProcess | null = null;

function readOauthCredsSubject(): string | null {
  try {
    if (!fs.existsSync(OAUTH_CREDS_PATH)) return null;
    const raw = fs.readFileSync(OAUTH_CREDS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { id_token?: string; subject?: string };
    if (parsed?.subject && typeof parsed.subject === 'string') return parsed.subject;
    // id_token is a JWT — decode payload for the email if present
    if (parsed?.id_token && typeof parsed.id_token === 'string') {
      const parts = parsed.id_token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8')) as {
          email?: string;
        };
        if (payload?.email) return payload.email;
      }
    }
    return 'signed-in';
  } catch {
    return null;
  }
}

ipcMain.handle('settings:gemini-cli-signin-status', () => {
  const subject = readOauthCredsSubject();
  return { signedIn: !!subject, subject };
});

ipcMain.handle('settings:gemini-cli-signout', () => {
  try {
    if (fs.existsSync(OAUTH_CREDS_PATH)) {
      fs.unlinkSync(OAUTH_CREDS_PATH);
      log('settings', 'gemini-cli signout: oauth creds removed');
    }
    return { ok: true };
  } catch (err) {
    log('settings', 'gemini-cli signout: failed', { err: (err as Error).message });
    return { ok: false, message: (err as Error).message };
  }
});

ipcMain.handle('settings:gemini-cli-signin-cancel', () => {
  if (activeGeminiSigninChild) {
    try { activeGeminiSigninChild.kill(); } catch { /* ignore */ }
    activeGeminiSigninChild = null;
    return { ok: true };
  }
  return { ok: false, message: 'No active sign-in to cancel.' };
});

ipcMain.handle(
  'settings:gemini-cli-signin',
  async (_evt, payload: { command?: string }): Promise<{ ok: boolean; message: string; subject?: string }> => {
    if (activeGeminiSigninChild) {
      return { ok: false, message: 'Sign-in already in progress. Wait for it to finish or cancel it.' };
    }
    const cliCommand = (payload?.command ?? 'gemini').trim() || 'gemini';
    const resolvedCli = resolveGeminiCliExecutable(cliCommand);
    log('settings', 'gemini-cli signin: starting', { cliCommand, resolved: resolvedCli.command });

    // Stamp the timestamp so we can detect a fresh login (vs. a stale file
    // from a previous session). The CLI rewrites oauth_creds.json when it
    // completes OAuth, so the mtime jumps forward.
    const startedAtMs = Date.now();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? 'true',
      // Resolver returns process.execPath (electron.exe in our context).
      // Without this flag, electron.exe ignores the JS arg and opens an
      // empty Electron window instead of running the script — browser
      // never opens, OAuth flow never starts.
      ELECTRON_RUN_AS_NODE: '1',
      // Skip the gemini-cli self-respawn — it bypasses our argv shim and
      // re-triggers the yargs phantom-positional bug under Electron.
      GEMINI_CLI_NO_RELAUNCH: 'true',
    };
    delete env.GEMINI_API_KEY;

    return new Promise<{ ok: boolean; message: string; subject?: string }>((resolve) => {
      const { spawn } = require('node:child_process') as typeof import('node:child_process');
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(resolvedCli.command, [...resolvedCli.prefixArgs], {
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        });
      } catch (err) {
        resolve({ ok: false, message: `Failed to launch Gemini CLI: ${(err as Error).message}` });
        return;
      }
      activeGeminiSigninChild = child;
      let stdoutBuf = '';
      let answered = false;
      let resolved = false;

      const finish = (result: { ok: boolean; message: string; subject?: string }): void => {
        if (resolved) return;
        resolved = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        try { child.kill(); } catch { /* ignore */ }
        if (activeGeminiSigninChild === child) activeGeminiSigninChild = null;
        log('settings', 'gemini-cli signin: finish', { ok: result.ok, message: result.message });
        resolve(result);
      };

      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString();
        stdoutBuf += text;
        if (!answered && /continue\?\s*\[Y\/n\]/i.test(stdoutBuf)) {
          answered = true;
          try { child.stdin?.write('y\n'); } catch { /* ignore */ }
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        log('settings', 'gemini-cli signin stderr', { tail: d.toString().slice(-300) });
      });
      child.on('error', (err) => {
        finish({ ok: false, message: `Gemini CLI process error: ${err.message}` });
      });
      child.on('close', (code) => {
        // If the CLI exited on its own without us finishing, surface that.
        // (Polling below normally finishes first when creds appear.)
        if (!resolved) {
          // Give the file-system a moment in case creds were just written.
          setTimeout(() => {
            const subject = readOauthCredsSubject();
            const fresh = subject && fs.existsSync(OAUTH_CREDS_PATH) && fs.statSync(OAUTH_CREDS_PATH).mtimeMs >= startedAtMs;
            if (fresh) {
              finish({ ok: true, message: `Signed in as ${subject}.`, subject: subject ?? undefined });
            } else {
              finish({
                ok: false,
                message: `Sign-in did not complete (exit ${code}). Try again or cancel.`,
              });
            }
          }, 500);
        }
      });

      // Poll for the OAuth creds file every 1s.
      const pollTimer = setInterval(() => {
        try {
          if (fs.existsSync(OAUTH_CREDS_PATH)) {
            const stat = fs.statSync(OAUTH_CREDS_PATH);
            if (stat.mtimeMs >= startedAtMs) {
              const subject = readOauthCredsSubject();
              finish({
                ok: true,
                message: subject ? `Signed in as ${subject}.` : 'Signed in successfully.',
                subject: subject ?? undefined,
              });
            }
          }
        } catch {
          // ignore transient stat errors mid-write
        }
      }, 1000);

      // Hard timeout — 5 minutes.
      const timeoutTimer = setTimeout(() => {
        finish({
          ok: false,
          message: 'Sign-in timed out after 5 minutes. Try again.',
        });
      }, 5 * 60 * 1000);
    });
  }
);

ipcMain.handle(
  'settings:test-api-keys',
  async (
    _evt,
    payload: {
      openaiApiKey?: string;
      openaiBaseUrl?: string;
      openaiModel?: string;
    }
  ) => {
    const openaiApiKey = payload?.openaiApiKey?.trim() ?? '';
    const openaiBaseUrl = payload?.openaiBaseUrl?.trim() || 'https://openrouter.ai/api/v1';
    const openaiModel = payload?.openaiModel?.trim() || 'google/gemini-2.5-flash';
    const openaiLabel = openaiBaseUrl.toLowerCase().includes('openrouter')
      ? 'OpenRouter'
      : 'OpenAI-compatible';

    const openaiTried = openaiApiKey.length > 0;

    let openaiOk = false;
    let openaiMessage = '';

    if (openaiTried) {
      const res = await testOpenAiCompatibleApiKey(openaiApiKey, openaiBaseUrl, openaiModel);
      openaiOk = res.ok;
      openaiMessage = res.message;
    }

    return {
      triedAny: openaiTried,
      openaiTried,
      openaiOk,
      openaiLabel,
      openaiMessage,
      anyOk: openaiTried && openaiOk,
    };
  }
);

ipcMain.handle('settings:save', (_evt, partial: Partial<SnipalotConfig>) => {
  // Detect shortcut-surface changes so we know whether to re-register
  // globalShortcuts. Visible launcher actions gate idle start shortcuts,
  // so they matter here just as much as the actual accelerator strings.
  const before = JSON.stringify({
    hotkeys: getConfig().hotkeys,
    visibleActions: getConfig().launcher.visibleActions,
  });
  saveConfig(partial);
  const after = JSON.stringify({
    hotkeys: getConfig().hotkeys,
    visibleActions: getConfig().launcher.visibleActions,
  });
  if (before !== after) {
    log('hotkey', 'shortcut surface changed; reloading global shortcuts');
    reloadGlobalHotkeys();
  }
  broadcastStateToLauncher();
  updateLauncherVisibility();
  log('settings', 'config saved via IPC', sanitizeSettingsPartialForLog(partial));
});

type ProviderUnderTest = 'openai-compatible';

interface ApiKeyTestPayload {
  provider: ProviderUnderTest;
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

function normalizeProviderLabel(payload: ApiKeyTestPayload): string {
  const base = (payload.baseUrl ?? '').toLowerCase();
  if (base.includes('openrouter')) return 'OpenRouter';
  return 'OpenAI-compatible';
}

ipcMain.handle('settings:test-api-key', async (_evt, payload: ApiKeyTestPayload) => {
  const provider = payload.provider;
  const apiKey = payload.apiKey?.trim() ?? '';
  const label = normalizeProviderLabel(payload);
  if (!apiKey) {
    return {
      ok: false,
      provider,
      message: `${label}: API key is empty.`,
    };
  }

  const controller = new AbortController();
  const timeoutMs = 20000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = (payload.baseUrl || 'https://openrouter.ai/api/v1').trim();
    const model = (payload.model || 'google/gemini-2.5-flash').trim();
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        temperature: 0,
        max_tokens: 4,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('settings', 'api-key-test failed', {
        provider,
        label,
        status: res.status,
        baseUrl,
        model,
        body: body.slice(0, 200),
      });
      return {
        ok: false,
        provider,
        message: `${label} test failed (HTTP ${res.status}).`,
      };
    }
    return {
      ok: true,
      provider,
      message: `${label} key works for model "${model}".`,
    };
  } catch (err) {
    log('settings', 'api-key-test threw', {
      provider,
      label,
      err: (err as Error).message,
    });
    return {
      ok: false,
      provider,
      message: `${label} test failed: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
});

ipcMain.handle('settings:test-trade-api-key', async (_evt, req: TradeApiTestRequest) => {
  const provider = req?.provider;
  log('settings', 'test-api-key request', {
    provider,
    hasApiKey: !!req?.apiKey,
    baseUrl: req?.baseUrl ?? null,
    model: req?.model ?? null,
  });
  if (provider !== 'openai') {
    return {
      ok: false,
      provider: 'openai',
      status: null,
      message: 'Unknown provider.',
    } satisfies TradeApiTestResult;
  }
  return testOpenAiCompatibleApiKey(
    req.apiKey ?? '',
    req.baseUrl ?? 'https://openrouter.ai/api/v1',
    req.model ?? 'google/gemini-2.5-flash'
  );
});

ipcMain.handle('settings:pick-folder', async () => {
  let parent: BrowserWindow | undefined;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    parent = settingsWindow;
  } else {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) parent = focused;
  }
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose Output Folder',
    defaultPath: getConfig().outputDir,
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('settings:close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    if (!launcherWindow.isVisible()) launcherWindow.show();
    launcherWindow.focus();
  }
});

ipcMain.handle('settings:exit-app', () => {
  log('settings', 'exit requested from settings');
  return requestAppExit('settings exit button');
});

function openFramePicker(mp4Path: string, sessionDir: string): void {
  // Skip if the mp4 didn't land (pipeline error).
  if (!fs.existsSync(mp4Path)) return;
  // Close previous picker if still open.
  if (framePickerWindow && !framePickerWindow.isDestroyed()) {
    framePickerWindow.close();
  }
  const primary = screen.getPrimaryDisplay();
  const w = Math.min(960, primary.workArea.width - 80);
  const h = Math.min(620, primary.workArea.height - 80);
  const icon = appWindowIcon();
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: primary.workArea.x + Math.floor((primary.workArea.width - w) / 2),
    y: primary.workArea.y + Math.floor((primary.workArea.height - h) / 2),
    title: 'Snipalot · Frame Picker',
    show: false,
    icon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'framepicker', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  applyAppWindowIcon(win, 'frame-picker');
  win.loadFile(path.join(__dirname, '..', 'framepicker', 'framepicker.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.webContents.send('framepicker:init', { mp4Path, sessionDir });
    log('main', 'framepicker opened', { mp4Path, sessionDir });
  });
  win.on('closed', () => {
    framePickerWindow = null;
    log('main', 'framepicker closed');
  });
  framePickerWindow = win;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegBin: string | null = require('ffmpeg-static');

ipcMain.handle(
  'framepicker:export',
  async (_evt, payload: { timeSec: number; sessionDir: string }) => {
    if (!ffmpegBin) return { ok: false, error: 'ffmpeg-static missing' };
    const mm = String(Math.floor(payload.timeSec / 60)).padStart(2, '0');
    const ss = String(Math.floor(payload.timeSec) % 60).padStart(2, '0');
    const outPath = path.join(payload.sessionDir, `exported-${mm}-${ss}.png`);
    const mp4 = path.join(payload.sessionDir, 'recording.mp4');
    if (!fs.existsSync(mp4)) return { ok: false, error: 'mp4 not found' };
    try {
      await new Promise<void>((resolve, reject) => {
        const { spawn } = require('node:child_process') as typeof import('node:child_process');
        const args = ['-y', '-ss', payload.timeSec.toFixed(3), '-i', mp4, '-frames:v', '1', '-q:v', '2', outPath];
        log('framepicker', 'export frame', { args });
        const proc = spawn(ffmpegBin!, args, { windowsHide: true });
        proc.on('error', reject);
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
      });
      log('framepicker', 'frame exported', { outPath });
      return { ok: true, path: outPath };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
);

function shouldDeferOverlayRebuild(): boolean {
  return appState === 'recording' || appState === 'processing';
}

function runDeferredOverlayRebuildIfIdle(trigger: string): void {
  if (!pendingOverlayRebuildReason || appState !== 'idle') return;
  const reason = `${pendingOverlayRebuildReason}; ${trigger}`;
  pendingOverlayRebuildReason = null;
  rebuildOverlays(reason);
}

function scheduleOverlayRebuild(reason: string): void {
  pendingOverlayRebuildReason = pendingOverlayRebuildReason
    ? `${pendingOverlayRebuildReason}; ${reason}`
    : reason;
  if (overlayRebuildTimer) clearTimeout(overlayRebuildTimer);
  overlayRebuildTimer = setTimeout(() => {
    overlayRebuildTimer = null;
    if (isSelectingState()) {
      log('main', 'display change cancelled active selection before overlay rebuild', {
        reason: pendingOverlayRebuildReason,
        appState,
      });
      exitSelecting('display changed');
    }
    if (shouldDeferOverlayRebuild()) {
      log('main', 'overlay rebuild deferred until idle', {
        reason: pendingOverlayRebuildReason,
        appState,
      });
      return;
    }
    runDeferredOverlayRebuildIfIdle('debounced display change');
  }, OVERLAY_REBUILD_DEBOUNCE_MS);
  log('main', 'overlay rebuild scheduled', { reason, appState });
}

function rebuildOverlays(reason = 'manual'): void {
  if (overlayWindows.size > 0 && isSelectingState()) {
    log('main', 'overlay rebuild requested during selection; scheduling clean rebuild', { reason, appState });
    scheduleOverlayRebuild(reason);
    return;
  }
  if (overlayWindows.size > 0 && shouldDeferOverlayRebuild()) {
    pendingOverlayRebuildReason = pendingOverlayRebuildReason
      ? `${pendingOverlayRebuildReason}; ${reason}`
      : reason;
    log('main', 'overlay rebuild requested during active session; deferred until idle', {
      reason: pendingOverlayRebuildReason,
      appState,
    });
    return;
  }
  captureSurfacesInitialized = true;
  log('main', 'rebuildOverlays', { reason });
  for (const [id, win] of overlayWindows) {
    log('main', 'closing existing overlay', { id });
    if (!win.isDestroyed()) win.close();
  }
  overlayWindows.clear();

  const displays = screen.getAllDisplays();
  log('main', 'displays', displays.map((d) => ({
    id: String(d.id),
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    primary: d.id === screen.getPrimaryDisplay().id,
  })));

  for (const d of displays) {
    const win = createOverlayWindowForDisplay(d);
    overlayWindows.set(String(d.id), win);
  }
}

// ─── broadcast helpers ────────────────────────────────────────────────

function broadcastOverlay(channel: string, payload?: unknown): void {
  for (const displayId of overlayWindows.keys()) {
    targetOverlay(displayId, channel, payload);
  }
}

function targetOverlay(displayId: string, channel: string, payload?: unknown): boolean {
  const win = overlayWindows.get(displayId);
  if (!win || win.isDestroyed()) {
    log('main', 'targetOverlay missing', { displayId, channel });
    return false;
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });
    log('main', 'targetOverlay queued until overlay load completes', { displayId, channel });
    return true;
  }
  win.webContents.send(channel, payload);
  return true;
}

function notifyHud(channel: string, payload?: unknown): void {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudWindow.webContents.send(channel, payload);
}

function broadcastRecordingState(): void {
  const hotkeys = getConfig().hotkeys;
  notifyHud('hud:state', {
    startedAt: recordingStartedAt ?? Date.now(),
    paused: recordingPaused,
    totalPausedMs,
    sessionMode: currentSessionMode,
    annotateHotkey: hotkeys.annotate,
    snapshotHotkey: hotkeys.snapshot,
    pauseResumeHotkey: hotkeys.pauseResume,
    tradeMarkerHotkey: hotkeys.tradeMarker,
  });
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: false }).show();
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single-frame capture for the Screenshot flow. Asks desktopCapturer for
 * a thumbnail of the chosen display at the display's full device pixel
 * resolution, then crops it to the user-selected region. Returns a PNG
 * buffer ready to be encoded as a data URL for the annotator.
 *
 * The `regionPct` is in normalized [0..1] of the display's logical
 * (CSS-pixel) bounds, so we multiply by display.size in device pixels
 * to get the crop rect that lines up with the thumbnail. The thumbnail
 * itself is requested at device resolution (logical * scaleFactor) so
 * cropping doesn't scale or lose detail.
 */
async function captureStillFrame(
  displayId: string,
  regionPct: { xPct: number; yPct: number; wPct: number; hPct: number }
): Promise<Buffer | null> {
  const display = screen.getAllDisplays().find((d) => String(d.id) === displayId);
  if (!display) {
    log('screenshot', 'captureStillFrame: display not found', { displayId });
    return null;
  }
  const devW = Math.round(display.bounds.width * display.scaleFactor);
  const devH = Math.round(display.bounds.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: devW, height: devH },
  });
  const source = sources.find((s) => s.display_id === displayId);
  if (!source) {
    log('screenshot', 'captureStillFrame: no source matched', {
      displayId,
      sources: sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id })),
    });
    return null;
  }
  const thumb = source.thumbnail;
  const ts = thumb.getSize();
  // The crop rect is in DEVICE pixels (matches the thumbnail's own units).
  const cropX = Math.round(regionPct.xPct * ts.width);
  const cropY = Math.round(regionPct.yPct * ts.height);
  const cropW = Math.max(2, Math.round(regionPct.wPct * ts.width));
  const cropH = Math.max(2, Math.round(regionPct.hPct * ts.height));
  log('screenshot', 'cropping thumbnail', {
    displayId,
    thumbSize: ts,
    cropRect: { x: cropX, y: cropY, w: cropW, h: cropH },
  });
  const cropped = thumb.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
  return cropped.toPNG();
}

async function captureScreenshotToAnnotator(
  displayId: string,
  region: RegionSelection,
  reason: string,
  options?: { requestId?: number; hideLauncherForCapture?: boolean }
): Promise<void> {
  try {
    const requestId = options?.requestId ?? activeScreenshotCaptureId;
    const isCurrentRequest = (): boolean =>
      appState === 'selecting-screenshot' && requestId === activeScreenshotCaptureId;

    if (!isCurrentRequest()) {
      log('screenshot', 'capture skipped; request no longer current', { reason, requestId, activeScreenshotCaptureId, appState });
      return;
    }
    if (options?.hideLauncherForCapture && launcherWindow && !launcherWindow.isDestroyed() && launcherWindow.isVisible()) {
      launcherWindow.hide();
      await waitMs(150);
    }
    if (!isCurrentRequest()) {
      log('screenshot', 'capture cancelled before frame grab', { reason, requestId, activeScreenshotCaptureId, appState });
      return;
    }
    const png = await captureStillFrame(displayId, region);
    if (!isCurrentRequest()) {
      log('screenshot', 'capture discarded after cancel', { reason, requestId, activeScreenshotCaptureId, appState });
      return;
    }
    if (!png) {
      showNotification('Snipalot', 'Screenshot capture failed (no source)');
      setAppState('idle', 'screenshot capture failed');
      broadcastOverlay('overlay:exit-region-select');
      return;
    }
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    pendingAnnotatorImage = {
      dataUrl,
      sessionStamp: formatSessionStamp(new Date()),
    };
    log('screenshot', 'captured + queued for annotator', {
      bytes: png.length,
      sessionStamp: pendingAnnotatorImage.sessionStamp,
      reason,
      displayId,
      region,
    });
    setAppState('idle', 'screenshot captured');
    broadcastOverlay('overlay:exit-region-select');
    openAnnotator();
  } catch (err) {
    log('screenshot', 'capture error', { err: (err as Error).message, reason, displayId });
    showNotification('Snipalot', `Screenshot failed: ${(err as Error).message}`);
    setAppState('idle', 'screenshot error');
    broadcastOverlay('overlay:exit-region-select');
  } finally {
    suppressLauncherDuringScreenshotCapture = false;
  }
}

// ffmpeg webm → mp4 logic lives in ./pipeline.ts now.

// ─── shared state-machine actions ────────────────────────────────────

/**
 * Detects which display the cursor is currently on. Used by fullscreen
 * capture mode to decide which display's overlay should start its
 * fullscreen countdown.
 */
function getCursorDisplayId(): string {
  const cursor = screen.getCursorScreenPoint();
  return String(screen.getDisplayNearestPoint(cursor).id);
}

/**
 * Send the region-select / fullscreen-countdown IPC to either every
 * overlay (region mode — user picks which display by dragging on it)
 * or just the cursor's overlay (fullscreen mode — no drag needed).
 * Returns true if a fullscreen short-circuit was used.
 */
function dispatchRegionEntry(captureMode: 'region' | 'fullscreen' | 'window', countdownSec: number): void {
  initializeCaptureSurfaces('capture requested');
  if (captureMode === 'fullscreen') {
    const targetId = getCursorDisplayId();
    const sent = targetOverlay(targetId, 'overlay:enter-region-select', {
      countdownSec,
      mode: 'fullscreen',
    });
    log('state', 'dispatchRegionEntry: fullscreen mode', { targetId, countdownSec, sent });
    if (!sent) {
      showNotification('Snipalot', 'Could not reach the fullscreen overlay. Falling back to region selection.');
      broadcastOverlay('overlay:enter-region-select', { countdownSec, mode: 'region' });
    }
  } else {
    // 'region' (and 'window' fallback for now) → the existing drag-to-select
    // flow, broadcast to all overlays.
    broadcastOverlay('overlay:enter-region-select', { countdownSec, mode: 'region' });
  }
}

function enterSelecting(): void {
  if (appState !== 'idle') {
    log('state', 'enterSelecting ignored', { appState });
    return;
  }
  setAppState('selecting', 'user toggle from idle');
  const cfg = getConfig().capture;
  log('state', 'enterSelecting capture config', cfg);
  dispatchRegionEntry(cfg.mode, cfg.countdownSec);
}

/**
 * Region-select for the Screenshot flow. Same overlay UI as record-mode
 * region-select; the post-confirm branch in overlay:region-confirmed
 * decides whether to start MediaRecorder (record) or call captureStillFrame
 * + openAnnotator (screenshot). The caller of this function is launcher's
 * Screenshot button.
 */
function enterSelectingScreenshot(): void {
  if (appState !== 'idle') {
    log('state', 'enterSelectingScreenshot ignored', { appState });
    return;
  }
  const cfg = getConfig().capture;
  selectingScreenshotEnteredAtMs = Date.now();
  suppressLauncherDuringScreenshotCapture = true;
  setAppState('selecting-screenshot', 'screenshot button from idle');
  log('state', 'enterSelectingScreenshot capture config', { ...cfg, effectiveCountdownSec: 0 });
  const requestId = ++activeScreenshotCaptureId;
  if (cfg.mode === 'fullscreen') {
    const displayId = getCursorDisplayId();
    void captureScreenshotToAnnotator(
      displayId,
      { xPct: 0, yPct: 0, wPct: 1, hPct: 1 },
      'fullscreen launcher mode',
      { requestId, hideLauncherForCapture: true }
    );
    return;
  }
  // Screenshots should capture immediately after the user picks a region.
  // The countdown preference is for recording/trade sessions only.
  dispatchRegionEntry('region', 0);
}

/**
 * Region-select for the Trade flow. Same overlay UI as record-mode
 * region-select; the post-confirm branch in overlay:region-confirmed
 * decides whether to start MediaRecorder normally (record), capture a
 * still PNG (screenshot), or start MediaRecorder with mode='trade'
 * (which produces a 'trade'-suffix session folder and runs the trade-
 * pipeline after whisper).
 */
function enterSelectingTrade(): void {
  if (appState !== 'idle') {
    log('state', 'enterSelectingTrade ignored', { appState });
    return;
  }
  setAppState('selecting-trade', 'trade button from idle');
  const cfg = getConfig().capture;
  log('state', 'enterSelectingTrade capture config', cfg);
  dispatchRegionEntry(cfg.mode, cfg.countdownSec);
}

function exitSelecting(reason: string): void {
  if (
    appState !== 'selecting' &&
    appState !== 'selecting-screenshot' &&
    appState !== 'selecting-trade'
  ) {
    log('state', 'exitSelecting ignored', { reason, appState });
    return;
  }
  log('state', 'exitSelecting start', { reason, appState });
  if (appState === 'selecting-screenshot') {
    activeScreenshotCaptureId++;
    suppressLauncherDuringScreenshotCapture = false;
  }
  setAppState('idle', `exitSelecting: ${reason}`);
  broadcastOverlay('overlay:exit-region-select');
  pendingRegion = null;
  activeDisplayId = null;
  activeSourceId = null;
  setTimeout(() => {
    if (appState !== 'idle') return;
    updateLauncherVisibility();
    log('state', 'exitSelecting complete', {
      reason,
      launcher: launcherWindow && !launcherWindow.isDestroyed()
        ? {
            visible: launcherWindow.isVisible(),
            minimized: launcherWindow.isMinimized(),
            focused: launcherWindow.isFocused(),
            bounds: launcherWindow.getBounds(),
          }
        : null,
    });
  }, 50);
}

function failSelectionStart(reason: string, userMessage: string, details?: unknown): void {
  log('overlay', 'selection start failed', { reason, details });
  showNotification('Snipalot', userMessage);
  if (
    appState === 'selecting' ||
    appState === 'selecting-screenshot' ||
    appState === 'selecting-trade'
  ) {
    exitSelecting(reason);
  } else if (appState === 'recording' && !recorderMediaReady) {
    resetFailedRecordingStart(reason, userMessage);
  }
}

function resetFailedRecordingStart(reason: string, userMessage: string): void {
  log('state', 'recording start failed; resetting to idle', { reason });
  if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:exit-region-select');
  broadcastOverlay('overlay:exit-region-select');
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
  activeDisplayId = null;
  activeSourceId = null;
  pendingRegion = null;
  recorderMediaReady = false;
  pendingRecorderStartRegion = null;
  clearPendingRecorderStartTimeout();
  setAppState('idle', `recording start failed: ${reason}`);
  showNotification('Snipalot', userMessage);
}

/**
 * Discard a recording in progress. Normal recordings are still destructive.
 * Trade recordings keep the session folder long enough to audit the finalized
 * WebM under Inputs, transcribe it, and write status evidence.
 *
 * Destructive so we always confirm. Confirmation dialog is anchored to
 * the launcher (or any focused window) so it can't be missed.
 */
async function discardRecording(reason: string): Promise<void> {
  if (appState !== 'recording') {
    log('state', 'discardRecording ignored', { appState, reason });
    return;
  }
  const parent = launcherWindow && !launcherWindow.isDestroyed() ? launcherWindow : undefined;
  const isTradeDiscard = currentSessionMode === 'trade';
  const result = await dialog.showMessageBox(parent!, {
    type: 'warning',
    buttons: [isTradeDiscard ? 'Discard and audit' : 'Discard recording', 'Keep recording'],
    defaultId: 1,
    cancelId: 1,
    title: 'Discard this recording?',
    message: 'Discard this recording?',
    detail: isTradeDiscard
      ? 'Snipalot will stop the recording, save the raw WebM under Inputs, transcribe it, and write a discarded-session review. If no trade evidence is found, the raw WebM will be deleted after transcription. Markers, screenshots, annotations, transcript, and status files will remain.'
      : 'The video, any annotations, and all snapshot PNGs taken during ' +
        'this session will be permanently deleted. Nothing will be saved ' +
        'to disk and nothing will land on the clipboard.\n\nThis cannot be undone.',
    noLink: true,
  });
  if (result.response !== 0) {
    log('main', 'discard cancelled by user');
    return;
  }
  log('main', 'discard initiated', { reason });

  // Mark the in-flight save-webm IPC for disposal. The recorder will fire
  // it shortly after we send recorder:stop below; the handler checks this
  // flag and bins the buffer instead of running the pipeline.
  pendingDiscard = true;
  recorderMediaReady = false;
  // Skip the pendingProcessing snapshot — pipeline never runs in discard
  // mode, so there's nothing for it to consume.
  pendingProcessing = null;
  cancelIncrementalTranscription(`discard: ${reason}`);
  const sessionDirToDiscard = liveSessionDir;
  pendingDiscardSessionDir = sessionDirToDiscard;
  pendingDiscardAudit = isTradeDiscard && recordingStartedAt !== null && sessionDirToDiscard !== null
    ? {
        annotations: [...currentAnnotations],
        startedAtMs: recordingStartedAt,
        durationMs: Math.max(0, Date.now() - recordingStartedAt - totalPausedMs),
        preCreatedSessionDir: sessionDirToDiscard,
        chapters: [...currentChapters],
        mode: 'trade',
        tradeMarkers: [...currentTradeMarkers],
      }
    : null;
  setSessionStatus(sessionDirToDiscard, 'discarded', {
    mode: currentSessionMode,
    stage: pendingDiscardAudit
      ? 'recording discarded by user; waiting for WebM audit'
      : 'recording discarded by user',
    reason,
    auditPending: Boolean(pendingDiscardAudit),
  }, false);
  const tradeDiscardAuditQueued = Boolean(pendingDiscardAudit);
  liveSessionDir = null;

  // Tell the recorder to finalize (so the MediaRecorder unwinds cleanly
  // and releases mic/screen streams), even though we'll discard the buffer.
  if (recorderWindow) {
    recordRecorderLifecycle('main sending recorder stop', {
      reason,
      pendingProcessing: Boolean(pendingProcessing),
      activeProcessingRun: Boolean(activeProcessingRun),
    }, 'start');
    recorderWindow.webContents.send('recorder:stop');
  }

  // Drop straight back to idle (no processing state — nothing's processing).
  setAppState('idle', `discard: ${reason}`);
  recordingStartedAt = null;
  recordingPaused = false;
  pausedAt = null;
  totalPausedMs = 0;
  pendingRegion = null;
  activeDisplayId = null;
  activeSourceId = null;
  currentAnnotations = [];
  currentRecordingRegionLocal = null;
  currentChapters = [];
  pendingChapterPngs.clear();

  if (hudKeepOnTopInterval) { clearInterval(hudKeepOnTopInterval); hudKeepOnTopInterval = null; }
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
  broadcastOverlay('overlay:recording-stopped');

  // Non-trade discards remain destructive. Trade discards are audited when
  // recorder:save-webm arrives.
  if (!tradeDiscardAuditQueued) {
    cleanupSessionDir(sessionDirToDiscard, 'discard recording');
  }

  showNotification(
    'Snipalot',
    tradeDiscardAuditQueued
      ? 'Trade recording discarded. Snipalot will audit the finalized recording.'
      : 'Recording discarded - nothing saved.'
  );
}

const SESSION_CLEANUP_RETRY_DELAYS_MS = [1000, 5000, 15000, 60000, 180000];
const pendingSessionCleanupTimers = new Map<string, NodeJS.Timeout>();

function cleanupSessionDir(sessionDir: string | null, reason = 'cleanup'): void {
  if (!sessionDir) return;
  const existingTimer = pendingSessionCleanupTimers.get(sessionDir);
  if (existingTimer) {
    clearTimeout(existingTimer);
    pendingSessionCleanupTimers.delete(sessionDir);
  }
  if (!fs.existsSync(sessionDir)) return;
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    log('main', 'session dir removed', { sessionDir, reason });
  } catch (err) {
    log('main', 'session dir cleanup failed', {
      sessionDir,
      reason,
      err: (err as Error).message,
    });
  }
  if (fs.existsSync(sessionDir)) {
    scheduleSessionDirCleanupRetry(sessionDir, reason, 0);
  }
}

function scheduleSessionDirCleanupRetry(sessionDir: string, reason: string, attemptIndex: number): void {
  if (attemptIndex >= SESSION_CLEANUP_RETRY_DELAYS_MS.length) {
    log('main', 'session dir cleanup retries exhausted', { sessionDir, reason });
    return;
  }
  const delayMs = SESSION_CLEANUP_RETRY_DELAYS_MS[attemptIndex];
  const timer = setTimeout(() => {
    pendingSessionCleanupTimers.delete(sessionDir);
    if (!fs.existsSync(sessionDir)) {
      log('main', 'session dir cleanup retry skipped; already gone', { sessionDir, reason, attempt: attemptIndex + 1 });
      return;
    }
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      log('main', 'session dir cleanup retry removed folder', {
        sessionDir,
        reason,
        attempt: attemptIndex + 1,
      });
    } catch (err) {
      log('main', 'session dir cleanup retry failed', {
        sessionDir,
        reason,
        attempt: attemptIndex + 1,
        err: (err as Error).message,
      });
    }
    if (fs.existsSync(sessionDir)) {
      scheduleSessionDirCleanupRetry(sessionDir, reason, attemptIndex + 1);
    }
  }, delayMs);
  pendingSessionCleanupTimers.set(sessionDir, timer);
}

function applyDiscardedTradeAuditStatus(result: DiscardedTradeAuditResult): void {
  setSessionStatus(result.sessionDir, 'discarded', {
    mode: 'trade',
    stage: result.suspected
      ? 'discard audit complete: potential trade activity found'
      : result.status === 'no_trade_evidence'
        ? 'discard audit complete: no trade evidence found'
        : 'discard audit incomplete',
    reviewStatus: result.status,
    comments: result.comments,
    suspectedTradeTimestamps: result.suspectedTradeTimestamps,
    retainedRecording: result.retainedWebm,
    reviewPath: result.reviewJsonPath,
    transcriptPath: result.transcriptPath,
    markerCount: result.markerCount,
    evidenceCount: result.evidenceCount,
    warnings: result.warnings,
  }, false);
  showNotification(
    'Snipalot Trade',
    result.suspected
      ? `Discard audit found possible trade activity at ${result.suspectedTradeTimestamps.join(', ')}.`
      : result.status === 'no_trade_evidence'
        ? 'Discard audit found no trade evidence; raw WebM was deleted.'
        : 'Discard audit could not rule out trade activity; raw WebM was retained.'
  );
}

function cleanupAbandonedTradePipelineMedia(sessionDir: string, reason: string): void {
  const pathsToDelete = [
    path.join(sessionDir, 'recording.mp4'),
    path.join(sessionDir, 'recording.webm'),
    path.join(sessionDir, 'recording.gif'),
    path.join(sessionDir, 'Inputs', 'recording.wav'),
  ];
  for (const targetPath of pathsToDelete) {
    if (!fs.existsSync(targetPath)) continue;
    try {
      fs.rmSync(targetPath, { force: true });
      log('discard-audit', 'removed abandoned pipeline media', { sessionDir, targetPath, reason });
      writeSessionLog(sessionDir, 'discard-audit', 'removed abandoned pipeline media', {
        path: targetPath,
        reason,
      }, 'success');
    } catch (err) {
      const message = (err as Error).message;
      log('discard-audit', 'failed to remove abandoned pipeline media', {
        sessionDir,
        targetPath,
        reason,
        err: message,
      });
      writeSessionLog(sessionDir, 'discard-audit', 'failed to remove abandoned pipeline media', {
        path: targetPath,
        reason,
        error: message,
      }, 'warning');
    }
  }
}

function queueAbandonedTradeAudit(
  webmBuffer: Buffer,
  sessionDir: string,
  snap: PendingProcessing | null,
  run: ActiveProcessingRun | null,
  errorMessage?: string
): void {
  if (run?.mode !== 'trade') return;
  const startedAtMs = snap?.startedAtMs ?? Date.now() - Math.max(1000, snap?.durationMs ?? 1000);
  const durationMs = snap?.durationMs ?? Math.max(1000, Date.now() - startedAtMs);
  writeSessionLog(sessionDir, 'discard-audit', 'queued after processing abandon', {
    bytes: webmBuffer.length,
    durationMs,
    tradeMarkers: snap?.tradeMarkers.length ?? 0,
    pipelineError: errorMessage ?? null,
  }, 'start');
  cleanupAbandonedTradePipelineMedia(sessionDir, 'before abandoned trade audit');
  void runDiscardedTradeAudit({
    webmBuffer,
    sessionDir,
    startedAtMs,
    durationMs,
    annotations: snap?.annotations ?? [],
    chapters: snap?.chapters ?? [],
    tradeMarkers: snap?.tradeMarkers ?? [],
  })
    .then((result) => {
      cleanupAbandonedTradePipelineMedia(result.sessionDir, 'after abandoned trade audit');
      applyDiscardedTradeAuditStatus(result);
      activeProcessingRun = null;
    })
    .catch((err) => {
      const message = (err as Error).message;
      cleanupAbandonedTradePipelineMedia(sessionDir, 'after failed abandoned trade audit');
      log('discard-audit', 'abandoned processing audit failed', { sessionDir, err: message });
      writeSessionLog(sessionDir, 'discard-audit', 'failed after processing abandon', { error: message }, 'error');
      setSessionStatus(sessionDir, 'abandoned', {
        mode: 'trade',
        stage: 'abandon audit failed',
        reviewStatus: 'review_incomplete',
        comments: `Abandon audit failed: ${message}. Review any retained Inputs artifacts manually.`,
        retainedRecording: true,
        pipelineError: errorMessage ?? null,
      }, false);
      activeProcessingRun = null;
    });
}

function abandonProcessing(reason: string): boolean {
  if (appState !== 'processing' || !activeProcessingRun) {
    log('state', 'abandonProcessing ignored', { appState, reason });
    return false;
  }

  const run = activeProcessingRun;
  run.abandoned = true;
  run.abortController.abort();

  if (tradeContextWindow && !tradeContextWindow.isDestroyed()) tradeContextWindow.close();
  if (responsePasteWindow && !responsePasteWindow.isDestroyed()) responsePasteWindow.close();
  pendingTradeContext = null;
  pendingResponsePaste = null;
  pendingDiscardSessionDir = null;

  setSessionStatus(run.sessionDir, 'abandoned', {
    mode: run.mode,
    stage: run.mode === 'trade'
      ? 'processing abandoned by user; waiting for audit'
      : 'processing abandoned by user',
    reason,
  }, false);
  if (run.mode !== 'trade') {
    pendingProcessing = null;
    cleanupSessionDir(run.sessionDir, 'abandon processing');
    activeProcessingRun = null;
  }
  setAppState('idle', `processing abandoned: ${reason}`);
  broadcastStateToLauncher();
  showNotification(
    'Snipalot',
    run.mode === 'trade'
      ? 'Processing abandoned. Snipalot will audit the finalized trade recording.'
      : 'Processing abandoned. The session folder was deleted.'
  );
  log('main', 'processing abandoned', {
    reason,
    mode: run.mode,
    sessionDir: run.sessionDir,
  });
  return true;
}

function stopRecording(reason: string): void {
  if (appState !== 'recording') {
    log('state', 'stopRecording ignored', { appState, reason });
    return;
  }
  log('main', 'stop initiated', { reason });

  // If the recorder never reached MediaRecorder.start(), we never got
  // recorder:state 'started' — pendingProcessing would be empty and we'd
  // sit in 'processing' forever waiting for save-webm. Bail out cleanly.
  if (!recorderMediaReady) {
    log('main', 'stopRecording: recorder never reported started — cannot finalize');
    recordRecorderLifecycle('main stop requested before recorder media ready', {
      reason,
      appState,
    }, 'error');
    writeSessionLog(liveSessionDir, 'recorder', 'stop requested before recorder was media-ready', {
      reason,
      appState,
    }, 'error');
    setSessionStatus(liveSessionDir, 'failed', {
      mode: currentSessionMode,
      stage: 'stop requested before recorder media-ready',
      reason,
    }, false);
    showNotification(
      'Snipalot',
      'Recording did not start (screen/mic permission or display capture failed). Check that you allowed capture when prompted, then try again.'
    );
    setAppState('idle', 'stop aborted: recorder never started');
    pendingRegion = null;
    activeDisplayId = null;
    activeSourceId = null;
    currentAnnotations = [];
    currentRecordingRegionLocal = null;
    currentChapters = [];
    pendingChapterPngs.clear();
    if (hudKeepOnTopInterval) {
      clearInterval(hudKeepOnTopInterval);
      hudKeepOnTopInterval = null;
    }
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
    broadcastOverlay('overlay:recording-stopped');
    if (recorderWindow) {
      recordRecorderLifecycle('main sending recorder stop after failed start', { reason }, 'start');
      recorderWindow.webContents.send('recorder:stop');
    }
    recorderMediaReady = false;
    return;
  }

  // Snapshot the data the pipeline will need, BEFORE we clear state.
  if (recordingStartedAt !== null) {
    pendingProcessing = {
      annotations: [...currentAnnotations],
      recordingRegion: currentRecordingRegionLocal,
      startedAtMs: recordingStartedAt,
      durationMs: Math.max(0, Date.now() - recordingStartedAt - totalPausedMs),
      preCreatedSessionDir: liveSessionDir,
      chapters: [...currentChapters],
      mode: currentSessionMode,
      tradeMarkers: [...currentTradeMarkers],
    };
    log('main', 'pendingProcessing snapshotted', {
      annotations: pendingProcessing.annotations.length,
      chapters: pendingProcessing.chapters.length,
      durationMs: pendingProcessing.durationMs,
      mode: pendingProcessing.mode,
      tradeMarkers: pendingProcessing.tradeMarkers.length,
    });
    writeSessionLog(liveSessionDir, 'recorder', 'stop snapshotted for processing', {
      reason,
      annotations: pendingProcessing.annotations.length,
      chapters: pendingProcessing.chapters.length,
      durationMs: pendingProcessing.durationMs,
      mode: pendingProcessing.mode,
      tradeMarkers: pendingProcessing.tradeMarkers.length,
    }, 'start');
    if (currentSessionMode === 'trade' && liveSessionDir !== null) {
      startWilyTraderBridge({
        sessionDir: liveSessionDir,
        startedAtMs: recordingStartedAt,
        durationMs: pendingProcessing.durationMs,
        captureTradeScreenshot: captureWilyTraderTradeScreenshot,
      });
    }
    setSessionStatus(liveSessionDir, 'processing', {
      mode: pendingProcessing.mode,
      stage: 'waiting for recorder save-webm',
      reason,
      durationMs: pendingProcessing.durationMs,
      chapters: pendingProcessing.chapters.length,
      tradeMarkers: pendingProcessing.tradeMarkers.length,
    });

    // For trade-mode sessions, immediately open the trade-context window
    // (parallel to the pipeline's mp4/whisper work) so the user can paste
    // their MockApe export while ffmpeg + whisper are running. Trade-
    // pipeline won't render the LLM extraction prompt until either
    // mockape.json or mockape.json.skipped exists in the session folder.
    if (
      currentSessionMode === 'trade' &&
      liveSessionDir !== null &&
      getConfig().trade.autoPromptForTradeData &&
      !hasWilyTraderLedger(liveSessionDir)
    ) {
      openTradeContextWindow(
        liveSessionDir,
        recordingStartedAt,
        pendingProcessing.durationMs
      );
    } else if (currentSessionMode === 'trade' && liveSessionDir !== null) {
      // User opted out of the prompt — write the .skipped sentinel so
      // trade-pipeline doesn't wait.
      try {
        const skipPath = path.join(liveSessionDir, 'Inputs', 'mockape.json.skipped');
        const inputDir = path.dirname(skipPath);
        if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(skipPath, '', 'utf-8');
        log('trade-context', 'auto-skipped (autoPromptForTradeData=false)');
      } catch {
        /* ignore */
      }
    }
  }
  liveSessionDir = null;

  activeProcessingRun = pendingProcessing
    ? {
        mode: pendingProcessing.mode,
        sessionDir: pendingProcessing.preCreatedSessionDir,
        abortController: new AbortController(),
        abandoned: false,
      }
    : null;

  // Tell the recorder to finalize its stream. The webm buffer arrives
  // later via the save-webm IPC — we don't wait for it here.
  if (recorderWindow) {
    recordRecorderLifecycle('main sending recorder stop', {
      reason,
      pendingProcessing: Boolean(pendingProcessing),
      activeProcessingRun: Boolean(activeProcessingRun),
    }, 'start');
    recorderWindow.webContents.send('recorder:stop');
  }

  // Clear UI IMMEDIATELY so the user doesn't see annotations + HUD frozen
  // while ffmpeg/whisper grind away in the background. Transition through
  // 'processing' (not 'idle') so the launcher reflects the multi-minute
  // background work; the pipeline .then/.catch handler kicks us back to
  // 'idle' when it's actually done.
  setAppState('processing', `user stop: ${reason}`);
  processingStep = 'Saving recording…';
  // Kick off the wall-clock progress estimator. The 250ms tick keeps the
  // launcher's progress bar animating smoothly until pipeline completion
  // toggles state back to 'idle' (which also stops the tick via the
  // setAppState side-effect below).
  if (pendingProcessing) {
    const estSec = estimateProcessingSec(
      pendingProcessing.durationMs,
      pendingProcessing.mode
    );
    startProcessingProgressTick(estSec);
    if (processingWatchdog) clearTimeout(processingWatchdog);
    const watchdogMs = Math.min(
      45 * 60 * 1000,
      Math.max(10 * 60 * 1000, Math.ceil(estSec * 2) * 1000)
    );
    processingWatchdog = setTimeout(() => {
      processingWatchdog = null;
      if (appState !== 'processing') return;
      log('main', 'processing watchdog fired — save-webm or pipeline hung', { watchdogMs });
      writeSessionLog(activeProcessingRun?.sessionDir ?? liveSessionDir, 'pipeline', 'processing watchdog fired before completion', {
        watchdogMs,
        hasPendingProcessing: Boolean(pendingProcessing),
        hasActiveProcessingRun: Boolean(activeProcessingRun),
      }, 'timeout');
      updateActiveSessionStatus('stalled', {
        stage: 'processing watchdog fired before completion',
        watchdogMs,
        hasPendingProcessing: Boolean(pendingProcessing),
        hasActiveProcessingRun: Boolean(activeProcessingRun),
      }, false);
      showNotification(
        'Snipalot',
        'Processing is taking too long or stalled. Quit from the tray and try again. Logs: %APPDATA%\\Snipalot\\logs\\snipalot.log'
      );
      activeProcessingRun = null;
      setAppState('idle', 'processing watchdog');
    }, watchdogMs);
  }
  broadcastStateToLauncher();
  recordingStartedAt = null;
  recorderMediaReady = false;
  recordingPaused = false;
  pausedAt = null;
  totalPausedMs = 0;
  pendingRegion = null;
  activeDisplayId = null;
  activeSourceId = null;
  currentAnnotations = [];
  currentRecordingRegionLocal = null;
  currentChapters = [];
  pendingChapterPngs.clear();

  if (hudKeepOnTopInterval) { clearInterval(hudKeepOnTopInterval); hudKeepOnTopInterval = null; }
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
  broadcastOverlay('overlay:recording-stopped');
}

// ─── IPC: forward renderer log calls into the same file ──────────────

ipcMain.handle('log', (_evt, scope: string, ...args: unknown[]) => {
  log(`r:${scope}`, ...args);
});

ipcMain.handle(
  'recorder:lifecycle',
  (_evt, payload: { event?: unknown; details?: unknown; status?: unknown }) => {
    const event = typeof payload?.event === 'string' && payload.event.trim()
      ? payload.event.trim()
      : 'renderer lifecycle event';
    const allowedStatuses: SessionLogStatus[] = [
      'info',
      'start',
      'success',
      'warning',
      'error',
      'timeout',
      'skipped',
    ];
    const status = allowedStatuses.includes(payload?.status as SessionLogStatus)
      ? payload.status as SessionLogStatus
      : 'info';
    recordRecorderLifecycle(event, payload?.details, status);
    return { ok: true };
  }
);

// ─── IPC: overlay ↔ main ──────────────────────────────────────────────

function dispatchRecorderStart(region: RegionSelection): void {
  resetRecorderLifecycleBuffer('new recorder start dispatch');
  recordRecorderLifecycle('recorder start dispatch requested', {
    region,
    rendererReady: recorderRendererReady,
    hasRecorderWindow: Boolean(recorderWindow && !recorderWindow.isDestroyed()),
  }, 'start');
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    recorderWindow = createRecorderWindow();
    log('recorder', 'recorder window recreated before start dispatch');
    recordRecorderLifecycle('recorder window recreated before start dispatch', undefined, 'start');
  }
  if (!recorderRendererReady) {
    pendingRecorderStartRegion = region;
    clearPendingRecorderStartTimeout();
    pendingRecorderStartTimeout = setTimeout(() => {
      pendingRecorderStartTimeout = null;
      if (!pendingRecorderStartRegion || appState !== 'recording') return;
      log('recorder', 'renderer readiness timeout; aborting recording start');
      recordRecorderLifecycle('recorder readiness timeout before start', {
        appState,
        hasPendingStartRegion: Boolean(pendingRecorderStartRegion),
      }, 'timeout');
      pendingRecorderStartRegion = null;
      recorderMediaReady = false;
      pendingRegion = null;
      activeDisplayId = null;
      activeSourceId = null;
      currentAnnotations = [];
      currentRecordingRegionLocal = null;
      currentChapters = [];
      pendingChapterPngs.clear();
      if (hudKeepOnTopInterval) { clearInterval(hudKeepOnTopInterval); hudKeepOnTopInterval = null; }
      if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
      setAppState('idle', 'recorder did not initialize');
      broadcastOverlay('overlay:recording-stopped');
      showNotification(
        'Snipalot',
        'Recorder did not initialize. Please try again. If this repeats, restart Snipalot and check snipalot.log.'
      );
    }, 5000);
    log('recorder', 'queued start; recorder renderer not ready yet');
    recordRecorderLifecycle('recorder start queued because renderer not ready', { region }, 'start');
    return;
  }
  pendingRecorderStartRegion = null;
  clearPendingRecorderStartTimeout();
  recorderWindow.webContents.send('recorder:start', region);
  log('recorder', 'dispatched start to recorder renderer');
  recordRecorderLifecycle('recorder start sent to renderer', { region }, 'start');
}

ipcMain.handle('overlay:set-interactive', (_evt, displayId: string, interactive: boolean) => {
  const win = overlayWindows.get(displayId);
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!interactive, { forward: true });
  if (interactive) win.focus();
  // Focusing the overlay is the most common trigger for the HUD getting
  // pushed behind it (both at 'screen-saver' level). Re-assert HUD on top
  // immediately rather than waiting for the next interval tick.
  if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) {
    hudWindow.moveTop();
  }
  log('overlay', 'set-interactive', { displayId, interactive });
});

ipcMain.handle('overlay:focus', (_evt, displayId: string) => {
  const win = overlayWindows.get(displayId);
  if (!win || win.isDestroyed()) return;
  win.focus();
});

ipcMain.handle(
  'overlay:region-confirmed',
  async (_evt, payload: { displayId: string; rect: OverlayRect }) => {
    log('overlay', 'region-confirmed received', payload);
    if (
      appState !== 'selecting' &&
      appState !== 'selecting-screenshot' &&
      appState !== 'selecting-trade'
    ) {
      log('overlay', 'ignoring region-confirmed (wrong state)', { appState });
      return;
    }
    const intent: 'record' | 'screenshot' | 'trade' =
      appState === 'selecting-screenshot' ? 'screenshot' :
      appState === 'selecting-trade' ? 'trade' :
      'record';

    const display = screen
      .getAllDisplays()
      .find((d) => String(d.id) === payload.displayId);
    if (!display) {
      failSelectionStart(
        'no display matched after region confirmed',
        `No display matched id ${payload.displayId}`,
        { displayId: payload.displayId }
      );
      return;
    }

    // Clip the region to the display bounds (rect is in display-local CSS px).
    const clippedX = Math.max(0, payload.rect.x);
    const clippedY = Math.max(0, payload.rect.y);
    const clippedW = Math.max(2, Math.min(display.bounds.width - clippedX, payload.rect.w));
    const clippedH = Math.max(2, Math.min(display.bounds.height - clippedY, payload.rect.h));

    const region: RegionSelection = {
      xPct: clippedX / display.bounds.width,
      yPct: clippedY / display.bounds.height,
      wPct: clippedW / display.bounds.width,
      hPct: clippedH / display.bounds.height,
    };
    log('overlay', 'computed region', { region, displayBounds: display.bounds, intent });

    // ── SCREENSHOT branch: capture single PNG, queue for annotator, open. ──
    if (intent === 'screenshot') {
      await captureScreenshotToAnnotator(payload.displayId, region, 'region selected');
      return;
    }

    // ── RECORD or TRADE branch: both start the MediaRecorder. The only
    //    difference is the AppState transition (recording vs trading) and
    //    currentSessionMode, which the pipeline reads at stop time to pick
    //    the folder suffix + extra trade-pipeline stage.
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      log('overlay', 'desktopCapturer sources', sources.map((s) => ({
        id: s.id,
        name: s.name,
        display_id: s.display_id,
      })));
      const source = sources.find((s) => s.display_id === payload.displayId);
      if (!source) {
        failSelectionStart(
          'no desktopCapturer source matched after region confirmed',
          'Could not match region to a display source',
          { displayId: payload.displayId, sourceCount: sources.length }
        );
        return;
      }

      activeDisplayId = payload.displayId;
      activeSourceId = source.id;
      pendingRegion = region;
      currentSessionMode = intent === 'trade' ? 'trade' : 'record';
      currentTradeMarkers = [];
      recorderMediaReady = false;
      try {
        setAppState('recording', `region confirmed (mode=${currentSessionMode})`);
        broadcastOverlay('overlay:exit-region-select');
        // Tell the active display's overlay to draw the region outline + receive annotations.
        targetOverlay(activeDisplayId, 'overlay:owns-recording', { rect: payload.rect });
        showHudForDisplay(display);

        dispatchRecorderStart(region);
      } catch (err) {
        resetFailedRecordingStart(
          'recording startup threw',
          `Recording could not start: ${(err as Error).message}`
        );
      }
    } catch (err) {
      failSelectionStart(
        'desktopCapturer failed after region confirmed',
        `Recording could not start: ${(err as Error).message}`,
        { err: (err as Error).message, displayId: payload.displayId, intent }
      );
    }
  }
);

ipcMain.handle('overlay:region-cancelled', (_evt, displayId: string) => {
  log('overlay', 'region-cancelled', { displayId });
  exitSelecting('user cancelled');
});

// ─── IPC: recorder ↔ main ─────────────────────────────────────────────

ipcMain.handle('recorder:ready', () => {
  recorderRendererReady = true;
  clearPendingRecorderStartTimeout();
  log('recorder', 'renderer signaled ready');
  recordRecorderLifecycle('recorder renderer signaled ready', undefined, 'success');
  if (pendingRecorderStartRegion && recorderWindow && !recorderWindow.isDestroyed()) {
    const queued = pendingRecorderStartRegion;
    pendingRecorderStartRegion = null;
    recorderWindow.webContents.send('recorder:start', queued);
    log('recorder', 'flushed queued start to recorder renderer');
    recordRecorderLifecycle('queued recorder start flushed to renderer', { region: queued }, 'start');
  }
});

// Kept for back-compat with the recorder renderer, but the path is no longer
// where we save the final mp4 — we just need a temp webm target. We'll
// actually hand the buffer to the pipeline in recorder:save-webm.
ipcMain.handle('recorder:get-output-path', () => {
  const outDir = getConfig().outputDir;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(outDir, `recording-${ts}.webm`);
});

/**
 * Fullscreen overlays sit at 'screen-saver' alwaysOnTop — on Windows the
 * Chromium/Electron screen-share picker can open *behind* them, so the user
 * never sees it and getDisplayMedia never resolves. Temporarily drop
 * alwaysOnTop on all overlays so the picker is visible.
 */
ipcMain.handle('recorder:prepare-display-capture', () => {
  overlayPrecaptureDepth += 1;
  if (overlayPrecaptureDepth === 1) {
    log('recorder', 'prepare-display-capture: lowering overlays for screen picker');
    recordRecorderLifecycle('prepare display capture', {
      overlayCount: overlayWindows.size,
    });
    for (const win of overlayWindows.values()) {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false);
    }
  }
});

ipcMain.handle('recorder:restore-display-capture', () => {
  overlayPrecaptureDepth = Math.max(0, overlayPrecaptureDepth - 1);
  if (overlayPrecaptureDepth === 0) {
    log('recorder', 'restore-display-capture: re-raising overlays');
    recordRecorderLifecycle('restore display capture', {
      overlayCount: overlayWindows.size,
    });
    for (const win of overlayWindows.values()) {
      if (!win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
    }
  }
});

ipcMain.handle(
  'recorder:audio-chunk',
  (_evt, payload: IncrementalAudioChunkPayload) => enqueueIncrementalAudioChunk(payload)
);

ipcMain.handle(
  'recorder:save-webm',
  (_evt, payload: { buffer: ArrayBuffer; filepath: string }) => {
    const buf = Buffer.from(payload.buffer);
    log('recorder', 'save-webm received', { bytes: buf.length });
    recordRecorderLifecycle('main received save-webm', {
      bytes: buf.length,
      filepath: payload.filepath,
      hasPendingProcessing: Boolean(pendingProcessing),
      pendingDiscard,
    }, buf.length > 0 ? 'success' : 'error');

    // Discard path: user pressed Discard mid-recording. Normal recordings
    // still throw the buffer away. Trade recordings run a salvage audit
    // against the finalized WebM under Inputs.
    if (pendingDiscard) {
      pendingDiscard = false;
      const discardedSessionDir = pendingDiscardSessionDir ?? liveSessionDir;
      const discardAudit = pendingDiscardAudit;
      pendingDiscardSessionDir = null;
      pendingDiscardAudit = null;
      log('recorder', 'save-webm discarded (user requested)', { bytes: buf.length });
      writeSessionLog(discardedSessionDir, 'recorder', 'save-webm discarded by user', { bytes: buf.length }, 'skipped');
      if (discardAudit && discardedSessionDir) {
        writeSessionLog(discardedSessionDir, 'discard-audit', 'queued after save-webm', {
          bytes: buf.length,
          durationMs: discardAudit.durationMs,
          tradeMarkers: discardAudit.tradeMarkers.length,
        }, 'start');
        void runDiscardedTradeAudit({
          webmBuffer: buf,
          sessionDir: discardedSessionDir,
          startedAtMs: discardAudit.startedAtMs,
          durationMs: discardAudit.durationMs,
          annotations: discardAudit.annotations,
          chapters: discardAudit.chapters,
          tradeMarkers: discardAudit.tradeMarkers,
        })
          .then((result) => applyDiscardedTradeAuditStatus(result))
          .catch((err) => {
            const message = (err as Error).message;
            log('discard-audit', 'failed', { sessionDir: discardedSessionDir, err: message });
            writeSessionLog(discardedSessionDir, 'discard-audit', 'failed', { error: message }, 'error');
            setSessionStatus(discardedSessionDir, 'discarded', {
              mode: 'trade',
              stage: 'discard audit failed',
              reviewStatus: 'review_incomplete',
              comments: `Discard audit failed: ${message}. Review any retained Inputs artifacts manually.`,
              retainedRecording: true,
            }, false);
          });
        return { ok: true, discarded: true, audit: true, bytes: buf.length };
      }
      cleanupSessionDir(discardedSessionDir, 'discard save-webm finalized');
      return { ok: true, discarded: true, audit: false, bytes: buf.length };
    }

    const snap = pendingProcessing;
    if (!snap) {
      // Recording stopped unexpectedly (track ended, app restart, etc.) and
      // we never took a snapshot. Fall back to rough current-ish values.
      log('recorder', 'save-webm: no pending snapshot, using fallback');
      writeSessionLog(liveSessionDir, 'recorder', 'save-webm received without pending processing snapshot', {
        bytes: buf.length,
      }, 'warning');
      pendingProcessing = null;
    } else {
      pendingProcessing = null;
      writeSessionLog(snap.preCreatedSessionDir, 'recorder', 'save-webm received', {
        bytes: buf.length,
        mode: snap.mode,
        durationMs: snap.durationMs,
        annotations: snap.annotations.length,
        chapters: snap.chapters.length,
        tradeMarkers: snap.tradeMarkers.length,
      }, 'success');
      setSessionStatus(snap.preCreatedSessionDir, 'processing', {
        mode: snap.mode,
        stage: 'save-webm received; pipeline running',
        bytes: buf.length,
        durationMs: snap.durationMs,
        chapters: snap.chapters.length,
        tradeMarkers: snap.tradeMarkers.length,
      });
    }

    const fallbackStart = Date.now() - 1000; // arbitrary; used only if snap missing
    const outputRoot = getConfig().outputDir;
    const run = activeProcessingRun;
    const incrementalTranscript = finalizeIncrementalTranscription(
      snap?.preCreatedSessionDir ?? run?.sessionDir
    );

    // FIRE AND FORGET: pipeline runs in the background. The UI is in
    // 'processing' state from stopRecording(); the .then/.catch below
    // returns it to 'idle' when ffmpeg/whisper actually finish.
    runPipeline({
      webmBuffer: buf,
      outputRoot,
      startedAtMs: snap?.startedAtMs ?? fallbackStart,
      durationMs: snap?.durationMs ?? 1000,
      recordingRegion: snap?.recordingRegion ?? null,
      annotations: snap?.annotations ?? [],
      preCreatedSessionDir: snap?.preCreatedSessionDir ?? undefined,
      chapters: snap?.chapters ?? [],
      mode: snap?.mode ?? 'record',
      tradeMarkers: snap?.tradeMarkers ?? [],
      onStep: (step) => setProcessingStep(step),
      onTradePromptReady: (sDir, rPath, pPath) => openResponsePasteWindow(sDir, rPath, pPath),
      abortSignal: run?.abortController.signal,
      incrementalTranscript,
      feedbackOutputs: getConfig().feedback,
    })
      .then(async (result) => {
        if (run?.abandoned) {
          if (run.mode === 'trade') {
            writeSessionLog(result.sessionDir, 'pipeline', 'completed after trade abandon; running audit', undefined, 'skipped');
            queueAbandonedTradeAudit(buf, result.sessionDir, snap, run);
            return;
          }
          setSessionStatus(result.sessionDir, 'abandoned', {
            mode: run.mode,
            stage: 'pipeline completed after abandon; cleaning session folder',
          }, false);
          writeSessionLog(result.sessionDir, 'pipeline', 'completed after abandon; cleaning session folder', undefined, 'skipped');
          cleanupSessionDir(result.sessionDir, 'pipeline completed after abandon');
          return;
        }
        log('recorder', 'pipeline complete', {
          sessionDir: result.sessionDir,
          warnings: result.warnings,
          frames: result.framePaths.length,
        });
        const warningsLine =
          result.warnings.length > 0
            ? ` (${result.warnings.length} warning${result.warnings.length > 1 ? 's' : ''})`
            : '';
        showNotification(
          'Snipalot',
          `Ready · prompt on clipboard${warningsLine}. Folder: ${result.sessionDir}`
        );
        if (result.warnings.length > 0) {
          await showProcessingIssueDialog(
            'Snipalot finished with warnings',
            'Some outputs may be incomplete.',
            result.warnings
          );
        }
        activeProcessingRun = null;
        if ((run?.mode ?? snap?.mode) === 'trade') {
          stopWilyTraderBridge('trade pipeline complete');
        }
        writeSessionLog(result.sessionDir, 'pipeline', 'complete', {
          warnings: result.warnings.length,
          frameCount: result.framePaths.length,
          transcriptWritten: Boolean(result.transcriptPath),
        }, result.warnings.length > 0 ? 'warning' : 'success');
        setSessionStatus(result.sessionDir, 'complete', {
          mode: run?.mode ?? snap?.mode ?? 'record',
          stage: result.warnings.length > 0 ? 'pipeline complete with warnings' : 'pipeline complete',
          warnings: result.warnings,
          frameCount: result.framePaths.length,
          transcriptWritten: Boolean(result.transcriptPath),
        }, false);
        setAppState('idle', 'pipeline complete');
        void shell.openPath(result.sessionDir);
      })
      .catch(async (err) => {
        const msg = (err as Error).message;
        if (run?.abandoned) {
          if (run.mode === 'trade' && run.sessionDir) {
            setSessionStatus(run.sessionDir, 'abandoned', {
              mode: 'trade',
              stage: 'pipeline abandoned; running audit',
              error: msg,
            }, false);
            writeSessionLog(run.sessionDir, 'pipeline', 'abandoned; running trade audit', { error: msg }, 'skipped');
            queueAbandonedTradeAudit(buf, run.sessionDir, snap, run, msg);
            return;
          }
          setSessionStatus(run.sessionDir, 'abandoned', {
            stage: 'pipeline abandoned; cleaning session folder',
            error: msg,
          }, false);
          writeSessionLog(run.sessionDir, 'pipeline', 'abandoned; cleaning session folder', { error: msg }, 'skipped');
          cleanupSessionDir(run.sessionDir, 'pipeline failed after abandon');
          return;
        }
        log('recorder', 'pipeline fail', { err: msg });
        writeSessionLog(snap?.preCreatedSessionDir ?? run?.sessionDir, 'pipeline', 'failed', { error: msg }, 'error');
        showNotification('Snipalot', `Pipeline failed: ${msg}`);
        await showProcessingIssueDialog(
          'Snipalot processing failed',
          'The recording stopped, but post-processing did not complete.',
          [msg],
          false
        );
        activeProcessingRun = null;
        if ((run?.mode ?? snap?.mode) === 'trade') {
          stopWilyTraderBridge('trade pipeline failed');
        }
        updateActiveSessionStatus('failed', {
          stage: 'pipeline failed',
          error: msg,
        }, false);
        setAppState('idle', 'pipeline failed');
      });

    // Return immediately so the recorder renderer isn't blocked waiting on
    // whisper/ffmpeg. The pipeline promise above resolves whenever.
    return { ok: true, filepath: payload.filepath, bytes: buf.length, async: true };
  }
);

ipcMain.handle(
  'overlay:sync-annotations',
  (
    _evt,
    payload: {
      annotations: AnnotationRecord[];
      recordingRegion: { x: number; y: number; w: number; h: number } | null;
    }
  ) => {
    currentAnnotations = payload.annotations;
    currentRecordingRegionLocal = payload.recordingRegion;
    log('overlay', 'sync-annotations', { count: currentAnnotations.length });
  }
);

function isMicDiagnosticsPayload(x: unknown): x is MicDiagnosticsPayload {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.capturedAtIso === 'string' &&
    typeof o.microphoneRequested === 'boolean' &&
    typeof o.microphoneGranted === 'boolean' &&
    (o.getUserMediaError === null || typeof o.getUserMediaError === 'string') &&
    Array.isArray(o.audioInputDevices)
  );
}

function writeMicDiagnosticsFile(sessionDir: string, payload: MicDiagnosticsPayload): void {
  const outPath = path.join(sessionDir, 'mic_diagnostics.json');
  const payloadWithVersion: MicDiagnosticsPayload = {
    ...payload,
    appVersion: app.getVersion(),
  };
  try {
    fs.writeFileSync(outPath, JSON.stringify(payloadWithVersion, null, 2), 'utf-8');
    log('recorder', 'mic_diagnostics.json written', { outPath });
    writeSessionLog(sessionDir, 'recorder', 'mic diagnostics written', {
      appVersion: payloadWithVersion.appVersion,
      microphoneGranted: payload.microphoneGranted,
      getUserMediaError: payload.getUserMediaError,
      activeLabel: payload.activeAudioTrack?.label ?? null,
      audioInputCount: payload.audioInputDevices.length,
    }, payload.microphoneGranted ? 'success' : 'warning');
  } catch (err) {
    log('recorder', 'mic_diagnostics.json write failed', { err: (err as Error).message });
    writeSessionLog(sessionDir, 'recorder', 'mic diagnostics write failed', { error: (err as Error).message }, 'error');
  }
}

function sanitizedConfigSummaryForSessionManifest(config: SnipalotConfig): Record<string, unknown> {
  const tradeConfig = config.trade as SnipalotConfig['trade'] & {
    geminiApiKey?: string;
  };
  return {
    outputDir: config.outputDir,
    retention: config.retention,
    audio: {
      microphone: config.audio.microphone,
    },
    hotkeys: { ...config.hotkeys },
    annotation: {
      color: config.annotation.color,
      strokeWidth: config.annotation.strokeWidth,
    },
    snapshot: {
      clearAnnotationsAfter: config.snapshot.clearAnnotationsAfter,
    },
    feedback: {
      generateMp4: config.feedback.generateMp4,
      generateGif: config.feedback.generateGif,
    },
    trade: {
      autoPromptForTradeData: config.trade.autoPromptForTradeData,
      llmMode: config.trade.llmMode,
      geminiCliCommand: config.trade.geminiCliCommand,
      geminiCliModel: config.trade.geminiCliModel,
      openaiBaseUrl: config.trade.openaiBaseUrl,
      openaiModel: config.trade.openaiModel,
      hasOpenaiApiKey: Boolean(config.trade.openaiApiKey),
      hasLegacyGeminiApiKey: Boolean(tradeConfig.geminiApiKey),
    },
    launcher: {
      pinnedOnTop: config.launcher.pinnedOnTop,
      visibleActions: { ...config.launcher.visibleActions },
    },
    capture: { ...config.capture },
    firstRun: config.firstRun,
  };
}

function writeSessionManifestFile(sessionDir: string): void {
  const manifestPath = path.join(sessionDir, 'Inputs', 'session_manifest.json');
  const cfg = getConfig();
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const manifest = {
      schemaVersion: 1,
      capturedAtIso: new Date().toISOString(),
      app: {
        name: app.getName(),
        version: app.getVersion(),
        isPackaged: app.isPackaged,
      },
      process: {
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd(),
        resourcesPath: process.resourcesPath,
        userDataPath: app.getPath('userData'),
        logPath: getLogPath(),
      },
      session: {
        mode: currentSessionMode,
        sessionDir,
        outputRoot: cfg.outputDir,
        startedAtMs: recordingStartedAt,
        startedAtIso: recordingStartedAt ? new Date(recordingStartedAt).toISOString() : null,
        displayId: activeDisplayId,
        sourceId: activeSourceId,
        regionPct: pendingRegion,
      },
      config: {
        path: CONFIG_PATH,
        summary: sanitizedConfigSummaryForSessionManifest(cfg),
      },
      displays: screen.getAllDisplays().map((display) => ({
        id: String(display.id),
        bounds: display.bounds,
        workArea: display.workArea,
        scaleFactor: display.scaleFactor,
        rotation: display.rotation,
        internal: display.internal,
      })),
      diagnostics: {
        processingLogPath: path.join(sessionDir, 'Inputs', 'processing_log.jsonl'),
        micDiagnosticsPath: path.join(sessionDir, 'mic_diagnostics.json'),
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    log('main', 'session_manifest.json written', { manifestPath });
    writeSessionLog(sessionDir, 'session', 'session manifest written', { manifestPath }, 'success');
  } catch (err) {
    const message = (err as Error).message;
    log('main', 'session_manifest.json write failed', { err: message, sessionDir });
    writeSessionLog(sessionDir, 'session', 'session manifest write failed', { error: message }, 'error');
  }
}

ipcMain.handle(
  'recorder:state',
  (
    _evt,
    state: 'started' | 'stopped' | 'error',
    detail?: string,
    micDiagnostics?: unknown
  ) => {
    log('recorder', 'state', { state, detail, hasMicDiagnostics: Boolean(micDiagnostics) });
    recordRecorderLifecycle('main received recorder state', {
      state,
      detail,
      hasMicDiagnostics: Boolean(micDiagnostics),
    }, state === 'error' ? 'error' : 'info');

    if (state === 'started') {
      // Confirm transition (we already moved to 'recording' on region-confirmed).
      if (appState !== 'recording') setAppState('recording', 'recorder reported started');
      recorderMediaReady = true;
      recordingStartedAt = Date.now();
      recordingPaused = false;
      pausedAt = null;
      totalPausedMs = 0;
      snapCount = 0;
      currentChapters = [];
      pendingChapterPngs.clear();

      // Pre-create the session folder so live snaps have somewhere to land.
      // Folder suffix reflects the capture mode (`feedback` for record-mode,
      // `trade` for trade-mode); pipeline.ts reads the same currentSessionMode
      // via PendingProcessing so its naming matches.
      const outputRoot = getConfig().outputDir;
      if (!fs.existsSync(outputRoot)) fs.mkdirSync(outputRoot, { recursive: true });
      const stamp = formatSessionStamp(new Date(recordingStartedAt));
      const suffix = currentSessionMode === 'trade' ? 'trade' : 'feedback';
      liveSessionDir = path.join(outputRoot, `${stamp} ${suffix}`);
      if (!fs.existsSync(liveSessionDir)) fs.mkdirSync(liveSessionDir, { recursive: true });
      log('main', 'liveSessionDir created', { liveSessionDir, mode: currentSessionMode });
      setSessionStatus(liveSessionDir, 'recording', {
        mode: currentSessionMode,
        stage: 'recording',
        outputRoot,
        displayId: activeDisplayId,
        sourceId: activeSourceId,
      });
      writeSessionManifestFile(liveSessionDir);
      writeSessionLog(liveSessionDir, 'recorder', 'session folder created', {
        mode: currentSessionMode,
        outputRoot,
        displayId: activeDisplayId,
        sourceId: activeSourceId,
      }, 'start');
      if (currentSessionMode === 'trade') {
        startWilyTraderBridge({
          sessionDir: liveSessionDir,
          startedAtMs: recordingStartedAt,
          durationMs: null,
          captureTradeScreenshot: captureWilyTraderTradeScreenshot,
        });
      } else {
        stopWilyTraderBridge('non-trade recording started');
      }
      flushPendingRecorderLifecycle(liveSessionDir);
      startIncrementalTranscriptionSession(liveSessionDir, currentSessionMode);

      if (isMicDiagnosticsPayload(micDiagnostics)) {
        const d = micDiagnostics;
        log('recorder', 'mic capture summary', {
          microphoneGranted: d.microphoneGranted,
          getUserMediaError: d.getUserMediaError,
          activeLabel: d.activeAudioTrack?.label ?? null,
          activeDeviceId: d.activeAudioTrack?.settings?.deviceId ?? null,
          audioInputCount: d.audioInputDevices.length,
        });
        writeMicDiagnosticsFile(liveSessionDir, d);
      } else if (micDiagnostics !== undefined) {
        log('recorder', 'mic diagnostics payload ignored (invalid shape)', { micDiagnostics });
      }

      const display = screen
        .getAllDisplays()
        .find((d) => String(d.id) === activeDisplayId) ?? screen.getPrimaryDisplay();
      showHudForDisplay(display);
      broadcastRecordingState();
      // Aggressively keep the HUD above the overlay. See hudKeepOnTopInterval
      // declaration for the rationale (same alwaysOnTop level → racy z-order).
      if (hudKeepOnTopInterval) clearInterval(hudKeepOnTopInterval);
      hudKeepOnTopInterval = setInterval(() => {
        if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) {
          hudWindow.moveTop();
        }
      }, 1000);

      broadcastOverlay('overlay:recording-started', {
        startedAt: recordingStartedAt,
        activeDisplayId,
      });
    } else if (state === 'stopped') {
      // User-initiated stops go through stopRecording() which already
      // clears state and closes the HUD. This handler just confirms the
      // recorder's mediaRecorder actually finalized. If the track ended
      // on its own (e.g., the user closed the captured window) and we
      // didn't stop manually, we still need to clean up here.
      if (appState === 'recording') {
        recorderMediaReady = false;
        log('state', 'recorder stopped unexpectedly; cleaning up');
        writeSessionLog(liveSessionDir, 'recorder', 'recorder stopped unexpectedly', { detail }, 'warning');
        // Take a snapshot for the pipeline (save-webm will arrive next).
        if (recordingStartedAt !== null && !pendingProcessing) {
          pendingProcessing = {
            annotations: [...currentAnnotations],
            recordingRegion: currentRecordingRegionLocal,
            startedAtMs: recordingStartedAt,
            durationMs: Math.max(0, Date.now() - recordingStartedAt - totalPausedMs),
            preCreatedSessionDir: liveSessionDir,
            chapters: [...currentChapters],
            mode: currentSessionMode,
            tradeMarkers: [...currentTradeMarkers],
          };
          setSessionStatus(pendingProcessing.preCreatedSessionDir, 'processing', {
            mode: pendingProcessing.mode,
            stage: 'recorder stopped unexpectedly; waiting for save-webm',
            durationMs: pendingProcessing.durationMs,
            tradeMarkers: pendingProcessing.tradeMarkers.length,
          });
        }
        liveSessionDir = null;
        setAppState('idle', 'recorder reported stopped (unexpected)');
        recordingStartedAt = null;
        recordingPaused = false;
        pausedAt = null;
        totalPausedMs = 0;
        pendingRegion = null;
        activeDisplayId = null;
        activeSourceId = null;
        currentAnnotations = [];
        currentRecordingRegionLocal = null;
        currentChapters = [];
        pendingChapterPngs.clear();
        if (hudKeepOnTopInterval) { clearInterval(hudKeepOnTopInterval); hudKeepOnTopInterval = null; }
        if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
        broadcastOverlay('overlay:recording-stopped');
      } else {
        log('recorder', 'stopped confirmed (UI already cleaned)');
      }
    } else if (state === 'error') {
      recorderMediaReady = false;
      cancelIncrementalTranscription(`recorder error: ${detail ?? '?'}`);
      writeSessionLog(liveSessionDir, 'recorder', 'recorder error', { detail }, 'error');
      setSessionStatus(liveSessionDir, 'failed', {
        mode: currentSessionMode,
        stage: 'recorder error',
        detail: detail ?? null,
      }, false);
      setAppState('idle', `recorder error: ${detail ?? '?'}`);
      pendingRegion = null;
      activeDisplayId = null;
      activeSourceId = null;
      if (hudKeepOnTopInterval) { clearInterval(hudKeepOnTopInterval); hudKeepOnTopInterval = null; }
      if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close();
      broadcastOverlay('overlay:recording-stopped');
      showNotification('Snipalot', `Recording error: ${detail ?? 'unknown'}`);
    }
  }
);

// ─── IPC: HUD ↔ main ──────────────────────────────────────────────────

function togglePause(): void {
  if (appState !== 'recording' || !recorderWindow) return;
  if (recordingPaused) {
    if (pausedAt !== null) totalPausedMs += Date.now() - pausedAt;
    pausedAt = null;
    recordingPaused = false;
    recorderWindow.webContents.send('recorder:resume');
    log('hud', 'resume');
  } else {
    pausedAt = Date.now();
    recordingPaused = true;
    recorderWindow.webContents.send('recorder:pause');
    log('hud', 'pause');
  }
  broadcastRecordingState();
}

ipcMain.handle('hud:pause-resume', () => togglePause());
ipcMain.handle('hud:stop', () => stopRecording('hud button'));
ipcMain.handle('hud:discard', () => discardRecording('hud button'));

// Overlay → main → HUD bridge. The overlay emits this whenever annotation
// mode flips so the HUD's ✎ button can show its active state. Light shim;
// we don't track the value in main beyond forwarding it.
ipcMain.handle('overlay:annotation-mode-changed', (_evt, payload: { active: boolean }) => {
  log('overlay', 'annotation-mode-changed', payload);
  notifyHud('hud:annotation-state', payload);
});
ipcMain.handle('hud:toggle-outline', () => {
  if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:toggle-outline');
});
ipcMain.handle('hud:enter-annotation', () => {
  if (appState !== 'recording' || !activeDisplayId) {
    showNotification('Snipalot', 'Annotations require an active recording');
    return;
  }
  targetOverlay(activeDisplayId, 'overlay:enter-annotation-mode');
});

/**
 * Single source of truth for the snapshot action — used by both the HUD
 * button click (hud:snap IPC) and the global snapshot hotkey. Returns a
 * Promise that resolves when the PNG has been captured + written, so the
 * HUD button can disable itself for the duration. The annotation-wipe
 * behavior is gated by config.snapshot.clearAnnotationsAfter and threaded
 * to the overlay through the `overlay:snapshot-reset` IPC payload.
 *
 * Invocations are serialized via `snapshotChain` so overlapping snap
 * requests cannot cross-wire `recorder:snap-result` listeners.
 */
function doSnapshot(): Promise<void> {
  snapshotChain = snapshotChain
    .then(() => runSnapshot())
    .catch((err) => {
      log('hud', 'snap chain error', { err: (err as Error).message });
    });
  return snapshotChain;
}

async function runSnapshot(): Promise<void> {
  if (appState !== 'recording' || !recorderWindow || !liveSessionDir) return;
  snapCount++;
  const snapIndex = snapCount;
  const folderName = `snapshot-${snapIndex}`;
  const chapterDir = path.join(liveSessionDir, 'snapshots', folderName);
  if (!fs.existsSync(chapterDir)) fs.mkdirSync(chapterDir, { recursive: true });
  const snapPath = path.join(chapterDir, `${folderName}.png`);
  pendingChapterPngs.set(snapIndex, snapPath);

  const clearAnnotations = getConfig().snapshot.clearAnnotationsAfter;

  // ── ORDER MATTERS ──
  // 1. Capture the frame FIRST while the overlay still has its
  //    annotations rendered. The recorder's cropCanvas is fed by an
  //    rAF loop copying from the live display-capture stream, and the
  //    overlay's annotations are visible on that display. If we sent
  //    snapshot-reset before the snap, the overlay would clear its
  //    canvas synchronously, the next display refresh would show no
  //    annotations, and the next rAF tick would write an empty crop
  //    into the recorder's canvas before toBlob even fires. The first
  //    snap might race-win, but later snaps reliably miss annotations.
  // 2. Only AFTER the buffer is in main do we send snapshot-reset to
  //    flush the chapter + clear the overlay.
  const buffer = await new Promise<ArrayBuffer | null>((resolve) => {
    ipcMain.once('recorder:snap-result', (_evt, buf: ArrayBuffer | null) => resolve(buf));
    recorderWindow!.webContents.send('recorder:snap');
  });
  if (buffer) {
    fs.writeFileSync(snapPath, Buffer.from(buffer));
    log('hud', 'snap saved', { snapPath, bytes: buffer.byteLength, snapIndex, clearAnnotations });
  } else {
    log('hud', 'snap failed: no buffer from renderer', { snapIndex });
  }

  // Now safe to flush + (optionally) clear: the PNG is already on disk
  // with the annotations baked in.
  if (activeDisplayId) {
    targetOverlay(activeDisplayId, 'overlay:snapshot-reset', { clearAnnotations });
  }
}

ipcMain.handle('hud:snap', () => doSnapshot());
ipcMain.handle('hud:trade-marker', () => doTradeMarker());

function captureWilyTraderTradeScreenshot(event: WilyTraderExecutionEvent): Promise<string | null> {
  let screenshotPath: string | null = null;
  snapshotChain = snapshotChain
    .then(async () => {
      screenshotPath = await runWilyTraderTradeScreenshot(event);
    })
    .catch((err) => {
      log('wilytrader', 'trade screenshot chain error', {
        err: (err as Error).message,
        executionId: event.executionId,
      });
      screenshotPath = null;
    });
  return snapshotChain.then(() => screenshotPath);
}

async function runWilyTraderTradeScreenshot(event: WilyTraderExecutionEvent): Promise<string | null> {
  if (
    appState !== 'recording' ||
    currentSessionMode !== 'trade' ||
    recordingStartedAt === null ||
    !recorderWindow ||
    !liveSessionDir
  ) {
    log('wilytrader', 'trade screenshot ignored (not in active trade recording)', {
      appState,
      currentSessionMode,
      executionId: event.executionId,
    });
    return null;
  }

  const offsetMs = Math.max(0, Date.now() - recordingStartedAt - totalPausedMs);
  const screenshotDir = path.join(liveSessionDir, 'Inputs', 'wilytrader-screenshots');
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const side = sanitizeFilePart(event.side || 'trade');
  const executionId = sanitizeFilePart(event.executionId).slice(0, 80);
  const screenshotPath = path.join(screenshotDir, `${timestamp}-${side}-${executionId}.png`);

  const buffer = await new Promise<ArrayBuffer | null>((resolve) => {
    ipcMain.once('recorder:snap-result', (_evt, buf: ArrayBuffer | null) => resolve(buf));
    recorderWindow!.webContents.send('recorder:snap');
  });
  if (!buffer) {
    log('wilytrader', 'trade screenshot failed: no buffer from renderer', {
      executionId: event.executionId,
      offsetMs,
    });
    writeSessionLog(liveSessionDir, 'wilytrader', 'trade screenshot failed', {
      executionId: event.executionId,
      side: event.side ?? null,
      offsetMs,
    }, 'warning');
    return null;
  }

  fs.writeFileSync(screenshotPath, Buffer.from(buffer));
  log('wilytrader', 'trade screenshot saved', {
    screenshotPath,
    bytes: buffer.byteLength,
    executionId: event.executionId,
    side: event.side ?? null,
    offsetMs,
  });
  writeSessionLog(liveSessionDir, 'wilytrader', 'trade screenshot saved', {
    screenshotPath,
    bytes: buffer.byteLength,
    executionId: event.executionId,
    side: event.side ?? null,
    offsetMs,
    offsetLabel: formatMs(offsetMs),
  }, 'success');
  return screenshotPath;
}

function sanitizeFilePart(value: string): string {
  const cleaned = value.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'trade';
}

function doTradeMarker(): Promise<void> {
  snapshotChain = snapshotChain
    .then(() => runTradeMarker())
    .catch((err) => {
      log('hud', 'trade marker chain error', { err: (err as Error).message });
    });
  return snapshotChain;
}

async function runTradeMarker(): Promise<void> {
  if (appState !== 'recording' || currentSessionMode !== 'trade' || recordingStartedAt === null) {
    log('hud', 'trade marker ignored (not in trade recording)', { appState, currentSessionMode });
    return;
  }

  const offsetMs = Math.max(0, Date.now() - recordingStartedAt - totalPausedMs);
  const markerIndex = currentTradeMarkers.length + 1;
  const marker: TradeMarkerRecord = {
    offsetMs,
    offsetLabel: formatMs(offsetMs),
  };

  if (recorderWindow && liveSessionDir) {
    const markerDir = path.join(liveSessionDir, 'Inputs', 'trade-screenshots');
    if (!fs.existsSync(markerDir)) fs.mkdirSync(markerDir, { recursive: true });
    const screenshotPath = path.join(markerDir, `marker-${markerIndex}.png`);
    const buffer = await new Promise<ArrayBuffer | null>((resolve) => {
      ipcMain.once('recorder:snap-result', (_evt, buf: ArrayBuffer | null) => resolve(buf));
      recorderWindow!.webContents.send('recorder:snap');
    });
    if (buffer) {
      fs.writeFileSync(screenshotPath, Buffer.from(buffer));
      marker.screenshotPath = screenshotPath;
      log('hud', 'trade marker screenshot saved', {
        markerIndex,
        offsetMs,
        screenshotPath,
        bytes: buffer.byteLength,
      });
    } else {
      log('hud', 'trade marker screenshot failed: no buffer from renderer', { markerIndex, offsetMs });
    }
  }

  currentTradeMarkers.push(marker);
  log('hud', 'trade marker added', {
    markerIndex,
    offsetMs,
    offsetLabel: marker.offsetLabel,
    screenshotPath: marker.screenshotPath ?? null,
    totalMarkers: currentTradeMarkers.length,
  });
  showNotification('Snipalot Trade', `Trade marker #${markerIndex} at ${marker.offsetLabel}`);
  broadcastRecordingState();
}

// Overlay reports its chapter-closed annotations after receiving
// `overlay:snapshot-reset`. We merge with the pre-reserved PNG path
// (written by the hud:snap handler) and push onto currentChapters.
ipcMain.handle(
  'overlay:report-snapshot-chapter',
  (_evt, payload: { annotations: AnnotationRecord[]; capturedAtMs: number }) => {
    if (appState !== 'recording') {
      log('overlay', 'report-snapshot-chapter ignored (not recording)');
      return;
    }
    const snapshotIndex = currentChapters.length + 1;
    const folderName = `snapshot-${snapshotIndex}`;
    const pngPath = pendingChapterPngs.get(snapshotIndex);
    pendingChapterPngs.delete(snapshotIndex);
    const record: ChapterRecord = {
      snapshotIndex,
      folderName,
      capturedAtMs: payload.capturedAtMs,
      annotations: payload.annotations ?? [],
      pngPath,
    };
    currentChapters.push(record);
    log('overlay', 'chapter reported', {
      snapshotIndex,
      annotations: record.annotations.length,
      capturedAtMs: record.capturedAtMs,
      pngPath: pngPath ?? '(none)',
    });
  }
);

// ─── IPC: launcher ↔ main ─────────────────────────────────────────────

ipcMain.handle('launcher:record', () => {
  log('launcher', 'record click', {
    appState,
    visibleActions: getConfig().launcher.visibleActions,
  });
  if (appState === 'idle') enterSelecting();
  else if (appState === 'recording') stopRecording('launcher button');
});

ipcMain.handle('launcher:cancel', () => {
  log('launcher', 'cancel click', { appState });
  if (appState === 'selecting' || appState === 'selecting-screenshot' || appState === 'selecting-trade') {
    exitSelecting('launcher cancel');
  }
});

ipcMain.handle('launcher:abandon-processing', () => {
  log('launcher', 'abandon-processing click', { appState });
  return abandonProcessing('launcher button');
});

ipcMain.handle('launcher:screenshot', () => {
  log('launcher', 'screenshot click', {
    appState,
    visibleActions: getConfig().launcher.visibleActions,
  });
  if (appState === 'idle') enterSelectingScreenshot();
  else if (appState === 'selecting-screenshot') exitSelecting('screenshot toggle');
});

ipcMain.handle('launcher:trade', () => {
  log('launcher', 'trade click', {
    appState,
    visibleActions: getConfig().launcher.visibleActions,
  });
  if (appState === 'idle') enterSelectingTrade();
  else if (appState === 'selecting-trade') exitSelecting('trade toggle');
});

ipcMain.handle('launcher:quit', () => {
  log('launcher', 'quit click');
  return requestAppExit('launcher quit action');
});

/**
 * Hide the launcher to tray. App keeps running (so global hotkeys keep
 * firing). One-time notification per session tells the user how to bring
 * the launcher back + how to actually quit if that's what they wanted.
 */
let hideToTrayNotificationShown = false;
ipcMain.handle('launcher:toggle-pin', () => {
  if (!launcherWindow || launcherWindow.isDestroyed()) return false;
  launcherWindow.setAlwaysOnTop(false);
  saveConfig({ launcher: { pinnedOnTop: false } } as never);
  log('launcher', 'pin ignored; launcher remains normal window');
  return false;
});

ipcMain.handle('launcher:get-pin-state', () => {
  if (!launcherWindow || launcherWindow.isDestroyed()) return false;
  launcherWindow.setAlwaysOnTop(false);
  return false;
});

ipcMain.handle('launcher:get-capture-mode', () => getConfig().capture.mode);

ipcMain.handle('launcher:set-update-banner-visible', (_evt, visible: boolean, countArg?: number) => {
  if (!launcherWindow || launcherWindow.isDestroyed()) return false;
  const count = visible ? Math.max(1, Math.min(2, Math.round(Number(countArg || 1)))) : 0;
  const nextHeight = visible
    ? LAUNCHER_BASE_HEIGHT + (LAUNCHER_UPDATE_HEIGHT - LAUNCHER_BASE_HEIGHT) * count
    : LAUNCHER_BASE_HEIGHT;
  const [currentWidth, currentHeight] = launcherWindow.getSize();
  if (currentWidth !== LAUNCHER_WIDTH || currentHeight !== nextHeight) {
    launcherWindow.setSize(LAUNCHER_WIDTH, nextHeight, false);
    log('launcher', 'resize for update banner', { visible, count, height: nextHeight });
  }
  return true;
});

ipcMain.handle('launcher:set-capture-mode', (_evt, mode: 'region' | 'fullscreen' | 'window') => {
  const nextMode = mode === 'fullscreen' ? 'fullscreen' : mode === 'window' ? 'window' : 'region';
  if (nextMode === 'window') {
    log('launcher', 'window capture mode ignored; not implemented');
    return getConfig().capture.mode;
  }
  saveConfig({ capture: { mode: nextMode } } as never);
  log('launcher', 'capture mode saved', { mode: nextMode });
  broadcastStateToLauncher();
  return nextMode;
});

/**
 * Find the most recent session folder under outputDir and re-copy its
 * prompt to the clipboard. Useful when the auto-copy on session
 * completion got overwritten by something the user copied in the
 * intervening minutes.
 *
 * Session-kind detection from folder suffix:
 *   "{stamp} feedback"   → record (uses prompt.txt)
 *   "{stamp} trade"      → trade  (uses prompt.txt)
 *   "{stamp} screenshot" → screenshot (uses prompt.md)
 *
 * Sorted by mtime so we always grab the newest regardless of session type.
 */
ipcMain.handle('launcher:copy-last-prompt', () => {
  const outputDir = getConfig().outputDir;
  if (!fs.existsSync(outputDir)) {
    return { ok: false as const, error: 'Output folder does not exist' };
  }
  let entries: { name: string; mtimeMs: number }[];
  try {
    entries = fs
      .readdirSync(outputDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const stat = fs.statSync(path.join(outputDir, e.name));
        return { name: e.name, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (err) {
    log('launcher', 'copy-last: outputDir read fail', { err: (err as Error).message });
    return { ok: false as const, error: 'Could not read output folder' };
  }

  // Walk from newest to oldest; skip folders without a recognizable prompt.
  for (const entry of entries) {
    const dir = path.join(outputDir, entry.name);
    const kind: 'record' | 'trade' | 'screenshot' =
      entry.name.endsWith(' trade') ? 'trade' :
      entry.name.endsWith(' screenshot') ? 'screenshot' :
      entry.name.endsWith(' feedback') ? 'record' :
      // Unknown suffix — try anyway, kind will default to 'record'
      'record';
    // Candidate filenames per session kind.
    const candidates = kind === 'trade'
      ? ['prompt.txt']
      : kind === 'screenshot'
      ? ['prompt.md']
      : ['prompt.txt'];
    for (const candidate of candidates) {
      const filePath = path.join(dir, candidate);
      if (!fs.existsSync(filePath)) continue;
      try {
        const text = fs.readFileSync(filePath, 'utf-8');
        clipboard.writeText(text);
        log('launcher', 'copy-last: prompt re-clipboarded', {
          sessionName: entry.name,
          kind,
          file: candidate,
          chars: text.length,
        });
        return {
          ok: true as const,
          kind,
          sessionName: entry.name,
          chars: text.length,
        };
      } catch (err) {
        log('launcher', 'copy-last: read fail', {
          filePath,
          err: (err as Error).message,
        });
        // Try the next candidate / next session.
      }
    }
  }
  return {
    ok: false as const,
    error: 'No prompt file found in any session folder',
  };
});

ipcMain.handle('launcher:copy-support-log', () => {
  log('launcher', 'copy-support-log click');
  return copySupportLogToClipboard();
});

ipcMain.handle('launcher:close-to-tray', () => {
  log('launcher', 'close-to-tray click');
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.hide();
  }
  if (!hideToTrayNotificationShown) {
    hideToTrayNotificationShown = true;
    showNotification(
      'Snipalot is still running',
      'Hotkeys (Ctrl+Alt+S record, Ctrl+Alt+T trade) stay active. ' +
        'Click the tray icon to bring the launcher back, or right-click ' +
        'the tray → Quit Snipalot to fully exit.'
    );
  }
});

ipcMain.handle('launcher:settings', () => {
  log('launcher', 'settings click');
  openSettings();
});

ipcMain.handle('launcher:toggle-minimize', () => {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  // Taskbar button is always present (skipTaskbar:false at creation), so just minimize.
  launcherWindow.minimize();
  log('launcher', 'minimized to taskbar');
});

// ─── shared coordinators (hotkey entry points) ───────────────────────

function handleToggleHotkey(): void {
  const combo = getConfig().hotkeys.startStop;
  log('hotkey', `${combo} fired (start/stop)`, { appState });
  switch (appState) {
    case 'idle':
      enterSelecting();
      break;
    case 'selecting':
      // Treat second press during region-select as a cancel — this prevents
      // the "second overlay opens on top of first" bug.
      exitSelecting(`${combo} during selecting`);
      break;
    case 'recording':
      stopRecording(`${combo} during recording`);
      break;
  }
}

// ─── app lifecycle ────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Strip Electron's default File/Edit/View/Window/Help menu. We don't use it
  // and it eats ~30px of vertical space off every native-chrome window.
  Menu.setApplicationMenu(null);

  // Load persisted config before anything else so outputDir etc. are available.
  const cfg = loadConfig();

  log('main', 'app ready', {
    isDev,
    isDebug,
    isSpikeM1,
    appUserModelId,
    cwd: process.cwd(),
    platform: process.platform,
    outputDir: cfg.outputDir,
    firstRun: cfg.firstRun,
  });

  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length === 0) {
        log('display-media', 'no sources');
        callback({});
        return;
      }
      const chosen = activeSourceId
        ? sources.find((s) => s.id === activeSourceId) ?? sources[0]
        : sources[0];
      log('display-media', 'chosen source', { id: chosen.id, name: chosen.name });
      callback({ video: chosen, audio: 'loopback' });
    });
  });

  // The hidden recorder window calls getUserMedia({audio:true}) to capture
  // the microphone. Electron's default permission handler denies this
  // silently for hidden windows (no prompt can fire), so we have to
  // explicitly grant 'media' permission. Without this the recording's
  // MP4 has a video stream but no audio, and whisper's mp4→wav step
  // fails with "Output file does not contain any stream".
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') {
      log('permissions', 'granted', { permission });
      callback(true);
      return;
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media';
  });

  launcherWindow = createLauncherWindow();
  startBackgroundUpdateCheck('startup');

  // System tray — persistent access point independent of the launcher.
  createTray({
    onStartStop: () => handleToggleHotkey(),
    onSettings: () => openSettings(),
    onOpenAnnotator: () => openAnnotator(),
    onQuit: () => requestAppExit('tray quit menu'),
    onShowLauncher: () => {
      if (launcherWindow && !launcherWindow.isDestroyed()) {
        if (!launcherWindow.isVisible()) launcherWindow.show();
        launcherWindow.focus();
        // Restore from taskbar if minimized.
        if (launcherWindow.isMinimized()) launcherWindow.restore();
      }
    },
  });

  // Defer the heavyweight hidden capture windows until after the visible
  // launcher has had a chance to paint. When the installer auto-launches
  // Snipalot from the Finish button, creating full-display transparent
  // overlays before any visible window can make Windows mark the new app
  // as "Not Responding" even though startup eventually completes.
  setTimeout(() => initializeCaptureSurfaces('post-launch deferred init'), 600);

  // First-run onboarding: open settings so the user can pick an output dir.
  if (cfg.firstRun) {
    // Slight delay so the launcher renders first, giving context.
    setTimeout(() => openSettings(true), 1200);
  }

  screen.on('display-added', () => {
    scheduleOverlayRebuild('display-added');
  });
  screen.on('display-removed', () => {
    scheduleOverlayRebuild('display-removed');
  });
  screen.on('display-metrics-changed', () => {
    scheduleOverlayRebuild('display-metrics-changed');
  });

  // Initial registration. Kept inside whenReady so app.isReady() is true
  // before globalShortcut.register is touched. After this, hotkey changes
  // from the settings UI route through reloadGlobalHotkeys().
  reloadGlobalHotkeys();

  if (isSpikeM1) {
    log(
      'main',
      `multi-display per-overlay build. State machine: idle/selecting/recording. ${getConfig().hotkeys.startStop} cycles record.`
    );
  }
});

app.on('before-quit', () => {
  log('main', 'before-quit', { appState, appExitRequested });
});

app.on('will-quit', () => {
  if (!quitCleanupRan) {
    quitCleanupRan = true;
    killSiblingSnipalotElectronProcesses();
  }
  stopWilyTraderBridge('app will quit');
  globalShortcut.unregisterAll();
  destroyTray();
  log('main', 'will-quit', { appState, appExitRequested });
});

app.on('quit', (_event, exitCode) => {
  log('main', 'quit', { exitCode, appState, appExitRequested });
});

app.on('window-all-closed', () => {
  log('main', 'window-all-closed', {
    appState,
    appExitRequested,
    windowCount: BrowserWindow.getAllWindows().length,
  });
  if (isSelectingState()) {
    log('main', 'window-all-closed converted to selection cancel', { appState });
    exitSelecting('window-all-closed during selection');
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});
