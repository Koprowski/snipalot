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
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { log } from './logger';
import { runPipeline, AnnotationRecord, ChapterRecord, formatSessionStamp } from './pipeline';
import { loadConfig, saveConfig, getConfig, SnipalotConfig } from './config';
import { createTray, updateTrayMenu, destroyTray } from './tray';

const isDev = process.argv.includes('--dev');
const isSpikeM1 = process.argv.includes('--spike=m1');
// --debug shows the hidden recorder window AND opens DevTools on it.
// Useful when a recording fails and you need to inspect MediaRecorder errors.
// npm run dev stays clean; use `npm run debug` to enable.
const isDebug = process.argv.includes('--debug');
// --no-protect disables setContentProtection on the HUD so the user can
// screenshot it for debugging. Don't use in normal recording runs.
const disableContentProtection = process.argv.includes('--no-protect');

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

type AppState =
  | 'idle'
  | 'selecting'
  | 'selecting-screenshot'
  | 'selecting-trade'
  | 'recording'   // active capture (BOTH record-mode and trade-mode use this)
  | 'processing';
let appState: AppState = 'idle';
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

let recordingStartedAt: number | null = null;
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
let currentTradeMarkers: number[] = [];

interface PendingProcessing {
  annotations: AnnotationRecord[];
  recordingRegion: { x: number; y: number; w: number; h: number } | null;
  startedAtMs: number;
  durationMs: number;
  preCreatedSessionDir: string | null;
  chapters: ChapterRecord[];
  mode: 'record' | 'trade';
  tradeMarkers: number[];
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
  }

  // Annotate + snapshot + trade-marker hotkeys are registered ONLY while
  // recording so they never steal keypresses from other apps when Snipalot
  // is idle. Trade-marker is also gated on mode === 'trade' (no point
  // grabbing the chord during a normal recording — markers are a
  // trade-mode concept).
  if (next === 'recording' && prev !== 'recording') {
    registerAnnotationHotkey();
    registerSnapshotHotkey();
    if (currentSessionMode === 'trade') registerTradeMarkerHotkey();
  } else if (prev === 'recording' && next !== 'recording') {
    unregisterAnnotationHotkey();
    unregisterSnapshotHotkey();
    unregisterTradeMarkerHotkey();
  }

  broadcastStateToLauncher();
  updateLauncherVisibility();
  updateTrayMenu(next);
}

/**
 * Update the substep label while remaining in the 'processing' state.
 * Triggers a launcher rebroadcast so the user sees the current pipeline
 * stage (e.g. "Converting video → Transcribing audio → ...").
 */
/**
 * Estimate total post-recording processing wall-clock seconds.
 *
 * The pipeline runs audio (whisper, the long pole) and video (mp4
 * transcode + gif) in parallel after a brief sequential setup. Whisper
 * is ~25% of recording duration on the bundled base.en model + this
 * machine's CPU; mp4 transcode at ultrafast preset is ~10%. Plus a
 * ~5s overhead for save/chapters/prompt write/etc. Trade mode adds a
 * small baseline for the trade-context window setup.
 *
 * These coefficients are approximate; a real run can land within ±25%.
 * The progress bar caps at 95% until the pipeline actually completes,
 * so a slow run just sits at 95% rather than overshooting visually.
 */
function estimateProcessingSec(recordingDurationMs: number, mode: 'record' | 'trade'): number {
  const recordingSec = Math.max(1, recordingDurationMs / 1000);
  // Audio + video branches run in parallel; max() reflects wall clock.
  const audioBranchSec = 1 + 0.25 * recordingSec;   // wav extract + whisper
  const videoBranchSec = 0.10 * recordingSec;       // ultrafast libx264
  const gifTailSec = 0.05 * recordingSec;           // sequential after mp4
  const overheadSec = 5;                            // save webm + chapters + prompt + cleanup
  const tradeExtraSec = mode === 'trade' ? 5 : 0;   // small visible baseline
  return Math.ceil(
    overheadSec + Math.max(audioBranchSec, videoBranchSec) + gifTailSec + tradeExtraSec
  );
}

function startProcessingProgressTick(estimatedTotalSec: number): void {
  processingStartedAtMs = Date.now();
  processingEstimatedTotalSec = estimatedTotalSec;
  if (processingTickInterval) clearInterval(processingTickInterval);
  processingTickInterval = setInterval(() => {
    // Just rebroadcast — the launcher reads the current progress fields
    // and recomputes pct/eta on every tick.
    if (appState === 'processing') broadcastStateToLauncher();
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
  broadcastStateToLauncher();
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

function registerAnnotationHotkey(): void {
  const accel = toAccelerator(getConfig().hotkeys.annotate);
  if (globalShortcut.isRegistered(accel)) return;
  const ok = globalShortcut.register(accel, handleAnnotationHotkey);
  log('hotkey', `${accel} registered (recording started)`, { ok });
}

function unregisterAnnotationHotkey(): void {
  const accel = toAccelerator(getConfig().hotkeys.annotate);
  if (!globalShortcut.isRegistered(accel)) return;
  globalShortcut.unregister(accel);
  log('hotkey', `${accel} unregistered (recording ended)`);
}

/**
 * Snapshot hotkey: only registered while recording, same gating logic as
 * the annotate hotkey. Fires the same code path the HUD 📸 button does.
 */
function registerSnapshotHotkey(): void {
  const accel = toAccelerator(getConfig().hotkeys.snapshot);
  if (globalShortcut.isRegistered(accel)) return;
  const ok = globalShortcut.register(accel, () => {
    log('hotkey', `${accel} fired (snapshot)`, { appState });
    if (appState !== 'recording') return;
    void doSnapshot();
  });
  log('hotkey', `${accel} registered (recording started, snapshot)`, { ok });
}

function unregisterSnapshotHotkey(): void {
  const accel = toAccelerator(getConfig().hotkeys.snapshot);
  if (!globalShortcut.isRegistered(accel)) return;
  globalShortcut.unregister(accel);
  log('hotkey', `${accel} unregistered (recording ended, snapshot)`);
}

/**
 * Trade-marker hotkey: only registered while recording AND mode === 'trade'.
 * Each press appends a recording-relative ms offset to currentTradeMarkers,
 * which the trade-pipeline uses as anchor tags for the LLM extraction prompt.
 * (Default combo is Ctrl+Shift+M; rebindable in Settings — not the same as startTrade.)
 * No separate recording is started — markers are lightweight metadata only.
 */
function registerTradeMarkerHotkey(): void {
  const accel = toAccelerator(getConfig().hotkeys.tradeMarker);
  if (globalShortcut.isRegistered(accel)) return;
  const ok = globalShortcut.register(accel, () => {
    if (appState !== 'recording' || currentSessionMode !== 'trade' || recordingStartedAt === null) {
      log('hotkey', `${accel} fired but not in trade-recording state`, { appState, currentSessionMode });
      return;
    }
    const offsetMs = Date.now() - recordingStartedAt - totalPausedMs;
    currentTradeMarkers.push(offsetMs);
    log('hotkey', `${accel} trade marker added`, { offsetMs, totalMarkers: currentTradeMarkers.length });
    showNotification('Snipalot Trade', `Marker #${currentTradeMarkers.length} at ${formatMs(offsetMs)}`);
  });
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
  globalShortcut.unregisterAll();
  const hk = getConfig().hotkeys;

  const reg = (combo: string, handler: () => void): void => {
    const accel = toAccelerator(combo);
    const ok = globalShortcut.register(accel, handler);
    log('hotkey', 'register', { combo: accel, ok });
    if (!ok) {
      showNotification('Snipalot', `Could not register hotkey: ${accel} (another app owns it)`);
    }
  };

  reg(hk.startStop, () => {
    log('hotkey', 'startStop fired', { appState, activeDisplayId });
    handleToggleHotkey();
  });
  reg(hk.toggleOutline, () => {
    log('hotkey', 'toggleOutline fired', { appState, activeDisplayId });
    if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:toggle-outline');
  });
  reg(hk.pauseResume, () => {
    log('hotkey', 'pauseResume fired', { appState });
    togglePause();
  });
  reg(hk.undo, () => {
    if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:global-undo');
  });
  reg(hk.clear, () => {
    if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:global-clear');
  });
  // Always-on Trade-session toggle hotkey. Mirrors the launcher's violet
  // Trade button: idle → enterSelectingTrade, active trade-recording →
  // stopRecording. Available globally so the user can start a session
  // without finding the launcher first.
  reg(hk.startTrade, () => {
    log('hotkey', 'startTrade fired', { appState, currentSessionMode });
    if (appState === 'idle') {
      enterSelectingTrade();
    } else if (appState === 'recording' && currentSessionMode === 'trade') {
      stopRecording('trade hotkey');
    } else if (appState === 'selecting-trade') {
      exitSelecting('trade hotkey toggle');
    }
  });

  // Re-arm the recording-only annotate + snapshot hotkeys at their new
  // combos if we're mid-session. unregisterAll() above already cleared
  // the OLD combos, so this is just registering the new ones.
  if (appState === 'recording') {
    registerAnnotationHotkey();
    registerSnapshotHotkey();
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
    tradeMarkerHotkey: getConfig().hotkeys.tradeMarker,
    sessionMode: currentSessionMode,
    processingProgress: computeProcessingProgress(),
  });
}

function updateLauncherVisibility(): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  // Hide the launcher during active recording — the HUD owns that state.
  // During 'processing' it stays visible so the user can watch progress.
  if (appState === 'recording') {
    if (launcherWindow.isVisible()) launcherWindow.hide();
  } else {
    if (!launcherWindow.isVisible()) launcherWindow.show();
  }
}

function createOverlayWindowForDisplay(display: Display): BrowserWindow {
  const displayId = String(display.id);
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

  win.on('closed', () => {
    overlayWindows.delete(displayId);
    log('main', 'overlay closed', { displayId });
  });
  return win;
}

function createRecorderWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 300,
    show: isDebug,
    webPreferences: {
      preload: path.join(__dirname, '..', 'recorder', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'recorder', 'recorder.html'));
  if (isDebug) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function createLauncherWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  // Bumped to 480 to fit three primary actions side by side
  // (Record + Screenshot + Trade) without label truncation.
  const w = 480;
  // Custom title bar 28px + content ~140px. The extra ~30px (vs the prior
  // 140 total) makes room for the progress bar block under the hint that
  // shows during the 'processing' state. Hidden during idle but reserves
  // the layout space so transitions don't cause window-size jumps.
  const h = 170;
  const margin = 16;
  const x = primary.workArea.x + primary.workArea.width - w - margin;
  const y = primary.workArea.y + margin;
  log('main', 'createLauncher', { x, y, w, h });

  const iconPath = path.join(process.cwd(), 'resources', 'icons', 'app.png');
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
    icon: iconPath,
    title: 'Snipalot',
    webPreferences: {
      preload: path.join(__dirname, '..', 'launcher', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Launcher is hidden during Snipalot's own recording, so we don't need
  // content protection on it. Keeping it off means Print Screen / OS-level
  // screen capture still works when debugging the launcher's appearance.
  win.loadFile(path.join(__dirname, '..', 'launcher', 'launcher.html'));
  win.once('ready-to-show', () => {
    win.show();
    // Restore pin state from config — set BEFORE broadcasting state so
    // the renderer's getPinState() lookup returns the correct value.
    if (getConfig().launcher.pinnedOnTop) {
      win.setAlwaysOnTop(true);
    }
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
    webPreferences: {
      preload: path.join(__dirname, '..', 'hud', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
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
/**
 * setInterval handle that keeps the trade-context window above the
 * 'screen-saver'-level overlay. See the matching hudKeepOnTopInterval
 * for context — same z-order race, same fix.
 */
let tradeContextKeepOnTopInterval: NodeJS.Timeout | null = null;

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
  const iconPath = path.join(process.cwd(), 'resources', 'icons', 'app.png');
  annotatorWindow = new BrowserWindow({
    width: wa.width,
    height: wa.height,
    x: wa.x,
    y: wa.y,
    minWidth: 720,
    minHeight: 480,
    title: 'Snipalot · Annotator',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'annotator', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  annotatorWindow.removeMenu();
  annotatorWindow.loadFile(path.join(__dirname, '..', 'annotator', 'annotator.html'));
  annotatorWindow.once('ready-to-show', () => annotatorWindow?.show());
  annotatorWindow.on('closed', () => {
    annotatorWindow = null;
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
      fs.writeFileSync(pngPath, pngBuf);
      fs.writeFileSync(promptPath, payload.promptText, 'utf-8');

      clipboard.writeText(payload.promptText);

      log('annotator', 'saved', {
        sessionDir,
        pngBytes: pngBuf.length,
        promptChars: payload.promptText.length,
      });
      showNotification('Snipalot', `Saved · prompt on clipboard. Folder: ${sessionDir}`);

      // Close the annotator window — the user's task is done. Launcher is
      // already at idle (set during the screenshot capture path).
      if (annotatorWindow && !annotatorWindow.isDestroyed()) annotatorWindow.close();

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
  if (annotatorWindow && !annotatorWindow.isDestroyed()) annotatorWindow.close();
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
    tradeContextWindow.focus();
    return;
  }
  pendingTradeContext = { sessionDir, recordingStartedAtMs, durationMs };
  const primary = screen.getPrimaryDisplay();
  const w = 640;
  const h = 560;
  const iconPath = path.join(process.cwd(), 'resources', 'icons', 'app.png');
  tradeContextWindow = new BrowserWindow({
    width: w,
    height: h,
    x: primary.workArea.x + Math.floor((primary.workArea.width - w) / 2),
    y: primary.workArea.y + Math.floor((primary.workArea.height - h) / 2),
    title: 'Snipalot Trade · Add trade data',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#0f1117',
    show: false,
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'trade-context', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  tradeContextWindow.removeMenu();
  tradeContextWindow.loadFile(path.join(__dirname, '..', 'trade-context', 'trade-context.html'));
  tradeContextWindow.once('ready-to-show', () => {
    if (!tradeContextWindow || tradeContextWindow.isDestroyed()) return;
    tradeContextWindow.show();
    // Bump to 'screen-saver' level to match the overlays. The constructor
    // alwaysOnTop:true defaults to 'floating' which is BELOW 'screen-saver',
    // so the still-open overlays would visually cover this window whenever
    // focus shifted (e.g. user clicks browser to copy MockApe data, then
    // the overlay re-stacks on top and the trade-context disappears).
    tradeContextWindow.setAlwaysOnTop(true, 'screen-saver');
    tradeContextWindow.moveTop();
    tradeContextWindow.focus();
  });
  // Defensive: keep trade-context above the overlay through z-order races
  // (overlay calls setAlwaysOnTop in its own state changes, which can shuffle
  // same-level windows on Windows). Same pattern as hudKeepOnTopInterval.
  if (tradeContextKeepOnTopInterval) clearInterval(tradeContextKeepOnTopInterval);
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
  tradeContextWindow.on('closed', () => {
    // If the user dismissed the window without submit/skip (e.g. clicked
    // the X), treat as a skip so trade-pipeline can proceed. Write the
    // sentinel only if neither has already happened (the IPC handlers
    // below also write it; this is the fallback).
    if (pendingTradeContext) {
      const skipPath = path.join(pendingTradeContext.sessionDir, 'mockape.json.skipped');
      try {
        if (!fs.existsSync(skipPath) &&
            !fs.existsSync(path.join(pendingTradeContext.sessionDir, 'mockape.json'))) {
          fs.writeFileSync(skipPath, '', 'utf-8');
          log('trade-context', 'window dismissed without submit/skip → wrote .skipped sentinel');
        }
      } catch (err) {
        log('trade-context', 'sentinel write fail on close', { err: (err as Error).message });
      }
      pendingTradeContext = null;
    }
    if (tradeContextKeepOnTopInterval) {
      clearInterval(tradeContextKeepOnTopInterval);
      tradeContextKeepOnTopInterval = null;
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
    const mockApePath = path.join(sessionDir, 'mockape.json');
    try {
      fs.writeFileSync(mockApePath, JSON.stringify(payload.trades, null, 2), 'utf-8');
      log('trade-context', 'mockape.json written via submit', {
        mockApePath,
        trades: payload.trades.length,
      });
    } catch (err) {
      log('trade-context', 'mockape.json write fail', { err: (err as Error).message });
    }
    if (payload.dontAskAgain) {
      saveConfig({ trade: { autoPromptForTradeData: false } } as never);
      log('trade-context', 'autoPromptForTradeData disabled by user');
    }
    pendingTradeContext = null;
    if (tradeContextWindow && !tradeContextWindow.isDestroyed()) tradeContextWindow.close();
  }
);

ipcMain.handle('trade-context:skip', (_evt, payload: { dontAskAgain: boolean }) => {
  if (!pendingTradeContext) return;
  const { sessionDir } = pendingTradeContext;
  const skipPath = path.join(sessionDir, 'mockape.json.skipped');
  try {
    fs.writeFileSync(skipPath, '', 'utf-8');
    log('trade-context', 'skip sentinel written', { skipPath });
  } catch (err) {
    log('trade-context', 'skip sentinel fail', { err: (err as Error).message });
  }
  if (payload.dontAskAgain) {
    saveConfig({ trade: { autoPromptForTradeData: false } } as never);
    log('trade-context', 'autoPromptForTradeData disabled by user');
  }
  pendingTradeContext = null;
  if (tradeContextWindow && !tradeContextWindow.isDestroyed()) tradeContextWindow.close();
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
    responsePasteWindow.focus();
    return;
  }
  pendingResponsePaste = { sessionDir, responsePath, promptPath };
  const primary = screen.getPrimaryDisplay();
  const w = 600;
  const h = 540;
  const iconPath = path.join(process.cwd(), 'resources', 'icons', 'app.png');
  responsePasteWindow = new BrowserWindow({
    width: w,
    height: h,
    x: primary.workArea.x + Math.floor((primary.workArea.width - w) / 2),
    y: primary.workArea.y + Math.floor((primary.workArea.height - h) / 2),
    minWidth: 480,
    minHeight: 400,
    title: 'Snipalot · Paste LLM Response',
    icon: iconPath,
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'response-paste', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  responsePasteWindow.removeMenu();
  responsePasteWindow.loadFile(
    path.join(__dirname, '..', 'response-paste', 'response-paste.html')
  );
  responsePasteWindow.once('ready-to-show', () => {
    if (!responsePasteWindow || responsePasteWindow.isDestroyed()) return;
    responsePasteWindow.show();
    responsePasteWindow.setAlwaysOnTop(true, 'screen-saver');
    responsePasteWindow.moveTop();
    responsePasteWindow.focus();
  });
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
    // Close the window after a short delay so the "Done" state is visible.
    setTimeout(() => {
      if (responsePasteWindow && !responsePasteWindow.isDestroyed()) {
        responsePasteWindow.close();
      }
      // Open session folder so the user can see the CSV when it appears.
      void shell.openPath(sessionDir);
    }, 1200);
    return { ok: true };
  } catch (err) {
    log('response-paste', 'submit error', { err: (err as Error).message });
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
  const w = 480;
  const h = 520;
  const iconPath = path.join(process.cwd(), 'resources', 'icons', 'app.png');
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: primary.workArea.x + Math.floor((primary.workArea.width - w) / 2),
    y: primary.workArea.y + Math.floor((primary.workArea.height - h) / 2),
    title: 'Snipalot · Settings',
    frame: false,
    transparent: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: false,
    // Always on top at screen-saver level so it isn't buried under the overlay
    // windows, which also run at that level and cover the full screen.
    alwaysOnTop: true,
    show: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '..', 'settings', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'settings', 'settings.html'));
  win.once('ready-to-show', () => {
    win.show();
    win.moveTop();
    win.focus();
    log('settings', 'window opened', { isFirstRun });
  });
  win.on('closed', () => {
    settingsWindow = null;
    log('settings', 'window closed');
  });
  settingsWindow = win;
}

ipcMain.handle('settings:get-config', () => getConfig());

ipcMain.handle('settings:save', (_evt, partial: Partial<SnipalotConfig>) => {
  // Detect a hotkey change so we know whether to re-register globalShortcuts.
  // We compare the partial.hotkeys keys against current to avoid the cost
  // of unregistering/re-registering on a save that only touched outputDir.
  const before = JSON.stringify(getConfig().hotkeys);
  saveConfig(partial);
  const after = JSON.stringify(getConfig().hotkeys);
  if (before !== after) {
    log('hotkey', 'config changed; reloading global shortcuts');
    reloadGlobalHotkeys();
  }
  log('settings', 'config saved via IPC', partial);
});

ipcMain.handle('settings:pick-folder', async () => {
  const parent = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined;
  const result = await dialog.showOpenDialog(parent!, {
    title: 'Choose Output Folder',
    defaultPath: getConfig().outputDir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('settings:close', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
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
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: primary.workArea.x + Math.floor((primary.workArea.width - w) / 2),
    y: primary.workArea.y + Math.floor((primary.workArea.height - h) / 2),
    title: 'Snipalot · Frame Picker',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'framepicker', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
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

function rebuildOverlays(): void {
  log('main', 'rebuildOverlays');
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
  for (const win of overlayWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function targetOverlay(displayId: string, channel: string, payload?: unknown): void {
  const win = overlayWindows.get(displayId);
  if (!win || win.isDestroyed()) {
    log('main', 'targetOverlay missing', { displayId, channel });
    return;
  }
  win.webContents.send(channel, payload);
}

function notifyHud(channel: string, payload?: unknown): void {
  if (!hudWindow || hudWindow.isDestroyed()) return;
  hudWindow.webContents.send(channel, payload);
}

function broadcastRecordingState(): void {
  notifyHud('hud:state', {
    startedAt: recordingStartedAt ?? Date.now(),
    paused: recordingPaused,
    totalPausedMs,
  });
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: false }).show();
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
  const source = sources.find((s) => s.display_id === displayId) ?? sources[0];
  if (!source) {
    log('screenshot', 'captureStillFrame: no source matched', { displayId });
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
  if (captureMode === 'fullscreen') {
    const targetId = getCursorDisplayId();
    targetOverlay(targetId, 'overlay:enter-region-select', {
      countdownSec,
      mode: 'fullscreen',
    });
    log('state', 'dispatchRegionEntry: fullscreen mode', { targetId, countdownSec });
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
  setAppState('selecting-screenshot', 'screenshot button from idle');
  const cfg = getConfig().capture;
  dispatchRegionEntry(cfg.mode, cfg.countdownSec);
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
  dispatchRegionEntry(cfg.mode, cfg.countdownSec);
}

function exitSelecting(reason: string): void {
  if (
    appState !== 'selecting' &&
    appState !== 'selecting-screenshot' &&
    appState !== 'selecting-trade'
  ) return;
  setAppState('idle', `exitSelecting: ${reason}`);
  broadcastOverlay('overlay:exit-region-select');
  pendingRegion = null;
  activeDisplayId = null;
  activeSourceId = null;
}

/**
 * Discard a recording in progress: stop the MediaRecorder, throw away
 * the captured webm buffer when it arrives, delete the live session
 * directory (and any snapshot PNGs already written into it), and skip
 * the pipeline entirely. Returns the user to idle without producing
 * any output files or clipboard content.
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
  const result = await dialog.showMessageBox(parent!, {
    type: 'warning',
    buttons: ['Discard recording', 'Keep recording'],
    defaultId: 1,
    cancelId: 1,
    title: 'Discard this recording?',
    message: 'Discard this recording?',
    detail:
      'The video, any annotations, and all snapshot PNGs taken during ' +
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
  // Skip the pendingProcessing snapshot — pipeline never runs in discard
  // mode, so there's nothing for it to consume.
  pendingProcessing = null;
  const sessionDirToDelete = liveSessionDir;
  liveSessionDir = null;

  // Tell the recorder to finalize (so the MediaRecorder unwinds cleanly
  // and releases mic/screen streams), even though we'll discard the buffer.
  if (recorderWindow) recorderWindow.webContents.send('recorder:stop');

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

  // Delete the session dir + any snapshot PNGs already written into it.
  if (sessionDirToDelete && fs.existsSync(sessionDirToDelete)) {
    try {
      fs.rmSync(sessionDirToDelete, { recursive: true, force: true });
      log('main', 'discard: session dir removed', { sessionDirToDelete });
    } catch (err) {
      log('main', 'discard: session dir cleanup failed', { err: (err as Error).message });
    }
  }

  showNotification('Snipalot', 'Recording discarded — nothing saved.');
}

function stopRecording(reason: string): void {
  if (appState !== 'recording') {
    log('state', 'stopRecording ignored', { appState, reason });
    return;
  }
  log('main', 'stop initiated', { reason });

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

    // For trade-mode sessions, immediately open the trade-context window
    // (parallel to the pipeline's mp4/whisper work) so the user can paste
    // their MockApe export while ffmpeg + whisper are running. Trade-
    // pipeline won't render the LLM extraction prompt until either
    // mockape.json or mockape.json.skipped exists in the session folder.
    if (
      currentSessionMode === 'trade' &&
      liveSessionDir !== null &&
      getConfig().trade.autoPromptForTradeData
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
        fs.writeFileSync(path.join(liveSessionDir, 'mockape.json.skipped'), '', 'utf-8');
        log('trade-context', 'auto-skipped (autoPromptForTradeData=false)');
      } catch {
        /* ignore */
      }
    }
  }
  liveSessionDir = null;

  // Tell the recorder to finalize its stream. The webm buffer arrives
  // later via the save-webm IPC — we don't wait for it here.
  if (recorderWindow) recorderWindow.webContents.send('recorder:stop');

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
    startProcessingProgressTick(
      estimateProcessingSec(pendingProcessing.durationMs, pendingProcessing.mode)
    );
  }
  broadcastStateToLauncher();
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
}

// ─── IPC: forward renderer log calls into the same file ──────────────

ipcMain.handle('log', (_evt, scope: string, ...args: unknown[]) => {
  log(`r:${scope}`, ...args);
});

// ─── IPC: overlay ↔ main ──────────────────────────────────────────────

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
      log('overlay', 'no display matched', { displayId: payload.displayId });
      showNotification('Snipalot', `No display matched id ${payload.displayId}`);
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
      try {
        const png = await captureStillFrame(payload.displayId, region);
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
        });
        // Drop region-select state, hide the overlay, then open the annotator.
        setAppState('idle', 'screenshot captured');
        broadcastOverlay('overlay:exit-region-select');
        openAnnotator();
      } catch (err) {
        log('screenshot', 'capture error', { err: (err as Error).message });
        showNotification('Snipalot', `Screenshot failed: ${(err as Error).message}`);
        setAppState('idle', 'screenshot error');
        broadcastOverlay('overlay:exit-region-select');
      }
      return;
    }

    // ── RECORD or TRADE branch: both start the MediaRecorder. The only
    //    difference is the AppState transition (recording vs trading) and
    //    currentSessionMode, which the pipeline reads at stop time to pick
    //    the folder suffix + extra trade-pipeline stage.
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    log('overlay', 'desktopCapturer sources', sources.map((s) => ({
      id: s.id,
      name: s.name,
      display_id: s.display_id,
    })));
    const source =
      sources.find((s) => s.display_id === payload.displayId) ?? sources[0];
    if (!source) {
      log('overlay', 'no source matched');
      showNotification('Snipalot', 'Could not match region to a display source');
      return;
    }

    activeDisplayId = payload.displayId;
    activeSourceId = source.id;
    pendingRegion = region;
    currentSessionMode = intent === 'trade' ? 'trade' : 'record';
    currentTradeMarkers = [];
    setAppState('recording', `region confirmed (mode=${currentSessionMode})`);
    broadcastOverlay('overlay:exit-region-select');
    // Tell the active display's overlay to draw the region outline + receive annotations.
    targetOverlay(activeDisplayId, 'overlay:owns-recording', { rect: payload.rect });

    if (recorderWindow) recorderWindow.webContents.send('recorder:start', region);
  }
);

ipcMain.handle('overlay:region-cancelled', (_evt, displayId: string) => {
  log('overlay', 'region-cancelled', { displayId });
  exitSelecting('user cancelled');
});

// ─── IPC: recorder ↔ main ─────────────────────────────────────────────

// Kept for back-compat with the recorder renderer, but the path is no longer
// where we save the final mp4 — we just need a temp webm target. We'll
// actually hand the buffer to the pipeline in recorder:save-webm.
ipcMain.handle('recorder:get-output-path', () => {
  const outDir = getConfig().outputDir;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(outDir, `recording-${ts}.webm`);
});

ipcMain.handle(
  'recorder:save-webm',
  (_evt, payload: { buffer: ArrayBuffer; filepath: string }) => {
    const buf = Buffer.from(payload.buffer);
    log('recorder', 'save-webm received', { bytes: buf.length });

    // Discard path: user pressed Discard mid-recording. Throw the buffer
    // away (no pipeline, no clipboard, no files), clear the flag, return.
    if (pendingDiscard) {
      pendingDiscard = false;
      log('recorder', 'save-webm discarded (user requested)', { bytes: buf.length });
      return { ok: true, discarded: true, bytes: buf.length };
    }

    const snap = pendingProcessing;
    if (!snap) {
      // Recording stopped unexpectedly (track ended, app restart, etc.) and
      // we never took a snapshot. Fall back to rough current-ish values.
      log('recorder', 'save-webm: no pending snapshot, using fallback');
      pendingProcessing = null;
    } else {
      pendingProcessing = null;
    }

    const fallbackStart = Date.now() - 1000; // arbitrary; used only if snap missing
    const outputRoot = getConfig().outputDir;

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
    })
      .then((result) => {
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
        setAppState('idle', 'pipeline complete');
      })
      .catch((err) => {
        const msg = (err as Error).message;
        log('recorder', 'pipeline fail', { err: msg });
        showNotification('Snipalot', `Pipeline failed: ${msg}`);
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

ipcMain.handle(
  'recorder:state',
  (_evt, state: 'started' | 'stopped' | 'error', detail?: string) => {
    log('recorder', 'state', { state, detail });

    if (state === 'started') {
      // Confirm transition (we already moved to 'recording' on region-confirmed).
      if (appState !== 'recording') setAppState('recording', 'recorder reported started');
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

      const display = screen
        .getAllDisplays()
        .find((d) => String(d.id) === activeDisplayId) ?? screen.getPrimaryDisplay();
      if (!hudWindow) hudWindow = createHudWindow(display);
      hudWindow.once('ready-to-show', () => {
        hudWindow?.show();
        hudWindow?.moveTop();
        broadcastRecordingState();
      });
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
        log('state', 'recorder stopped unexpectedly; cleaning up');
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
 */
async function doSnapshot(): Promise<void> {
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
  log('launcher', 'record click', { appState });
  if (appState === 'idle') enterSelecting();
  else if (appState === 'recording') stopRecording('launcher button');
});

ipcMain.handle('launcher:cancel', () => {
  log('launcher', 'cancel click', { appState });
  if (appState === 'selecting' || appState === 'selecting-screenshot') {
    exitSelecting('launcher cancel');
  }
});

ipcMain.handle('launcher:screenshot', () => {
  log('launcher', 'screenshot click', { appState });
  if (appState === 'idle') enterSelectingScreenshot();
  else if (appState === 'selecting-screenshot') exitSelecting('screenshot toggle');
});

ipcMain.handle('launcher:trade', () => {
  log('launcher', 'trade click', { appState });
  if (appState === 'idle') enterSelectingTrade();
  else if (appState === 'selecting-trade') exitSelecting('trade toggle');
});

ipcMain.handle('launcher:quit', () => {
  log('launcher', 'quit click');
  app.quit();
});

/**
 * Hide the launcher to tray. App keeps running (so global hotkeys keep
 * firing). One-time notification per session tells the user how to bring
 * the launcher back + how to actually quit if that's what they wanted.
 */
let hideToTrayNotificationShown = false;
ipcMain.handle('launcher:toggle-pin', () => {
  if (!launcherWindow || launcherWindow.isDestroyed()) return false;
  const next = !launcherWindow.isAlwaysOnTop();
  launcherWindow.setAlwaysOnTop(next);
  saveConfig({ launcher: { pinnedOnTop: next } } as never);
  log('launcher', 'pin toggled', { pinnedOnTop: next });
  return next;
});

ipcMain.handle('launcher:get-pin-state', () => {
  if (!launcherWindow || launcherWindow.isDestroyed()) return false;
  return launcherWindow.isAlwaysOnTop();
});

/**
 * Find the most recent session folder under outputDir and re-copy its
 * prompt to the clipboard. Useful when the auto-copy on session
 * completion got overwritten by something the user copied in the
 * intervening minutes.
 *
 * Session-kind detection from folder suffix:
 *   "{stamp} feedback"   → record (uses prompt.txt)
 *   "{stamp} trade"      → trade  (uses extraction_prompt.md, falls back to prompt.txt stub)
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
    // Candidate filenames per session kind. Trade folders contain a
    // prompt.txt stub that's just a pointer ("see extraction_prompt.md")
    // — we deliberately do NOT fall back to it. If extraction_prompt.md
    // isn't there yet (e.g. user clicked Copy before the trade-context
    // window was submitted), walk to the previous session that has a
    // real prompt instead.
    const candidates = kind === 'trade'
      ? ['extraction_prompt.md']
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

ipcMain.handle('launcher:close-to-tray', () => {
  log('launcher', 'close-to-tray click');
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.hide();
  }
  if (!hideToTrayNotificationShown) {
    hideToTrayNotificationShown = true;
    showNotification(
      'Snipalot is still running',
      'Hotkeys (Ctrl+Shift+S record, Ctrl+Shift+T trade) stay active. ' +
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
  // Windows: set an explicit AppUserModelID so toast notifications are
  // attributed to Snipalot rather than the nondescript "electron.app.Electron"
  // default (which Windows sometimes silently suppresses for dev builds).
  if (process.platform === 'win32') {
    app.setAppUserModelId('app.snipalot');
  }

  // Strip Electron's default File/Edit/View/Window/Help menu. We don't use it
  // and it eats ~30px of vertical space off every native-chrome window.
  Menu.setApplicationMenu(null);

  // Load persisted config before anything else so outputDir etc. are available.
  const cfg = loadConfig();

  log('main', 'app ready', {
    isDev,
    isDebug,
    isSpikeM1,
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

  rebuildOverlays();
  recorderWindow = createRecorderWindow();
  launcherWindow = createLauncherWindow();

  // System tray — persistent access point independent of the launcher.
  createTray({
    onStartStop: () => handleToggleHotkey(),
    onSettings: () => openSettings(),
    onOpenAnnotator: () => openAnnotator(),
    onQuit: () => app.quit(),
    onShowLauncher: () => {
      if (launcherWindow && !launcherWindow.isDestroyed()) {
        if (!launcherWindow.isVisible()) launcherWindow.show();
        launcherWindow.focus();
        // Restore from taskbar if minimized.
        if (launcherWindow.isMinimized()) launcherWindow.restore();
      }
    },
  });

  // First-run onboarding: open settings so the user can pick an output dir.
  if (cfg.firstRun) {
    // Slight delay so the launcher renders first, giving context.
    setTimeout(() => openSettings(true), 800);
  }

  screen.on('display-added', () => {
    log('main', 'display-added; rebuilding overlays');
    rebuildOverlays();
  });
  screen.on('display-removed', () => {
    log('main', 'display-removed; rebuilding overlays');
    rebuildOverlays();
  });
  screen.on('display-metrics-changed', () => {
    log('main', 'display-metrics-changed; rebuilding overlays');
    rebuildOverlays();
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  destroyTray();
  log('main', 'will-quit');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
