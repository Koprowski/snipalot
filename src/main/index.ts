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
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { log } from './logger';
import { runPipeline, AnnotationRecord } from './pipeline';

const isDev = process.argv.includes('--dev');
const isSpikeM1 = process.argv.includes('--spike=m1');
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

type AppState = 'idle' | 'selecting' | 'recording';
let appState: AppState = 'idle';

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

interface PendingProcessing {
  annotations: AnnotationRecord[];
  recordingRegion: { x: number; y: number; w: number; h: number } | null;
  startedAtMs: number;
  durationMs: number;
}
// Snapshot of the stopping recording's metadata. The webm buffer arrives
// async via recorder:save-webm and the pipeline picks up from here.
let pendingProcessing: PendingProcessing | null = null;

// ─── window constructors ──────────────────────────────────────────────

function setAppState(next: AppState, why: string): void {
  if (appState === next) return;
  log('state', `${appState} → ${next}`, why);
  appState = next;
  broadcastStateToLauncher();
  updateLauncherVisibility();
}

function broadcastStateToLauncher(): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  launcherWindow.webContents.send('launcher:state', { appState });
}

function updateLauncherVisibility(): void {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  // Hide the launcher during active recording — the HUD owns that state.
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
    show: isDev,
    webPreferences: {
      preload: path.join(__dirname, '..', 'recorder', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'recorder', 'recorder.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}

function createLauncherWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const w = 320;
  const h = 120;
  const margin = 16;
  const x = primary.workArea.x + primary.workArea.width - w - margin;
  const y = primary.workArea.y + margin;
  log('main', 'createLauncher', { x, y, w, h });

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
      preload: path.join(__dirname, '..', 'launcher', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Launcher is hidden during Snipalot's own recording, so we don't need
  // content protection on it. Keeping it off means Print Screen / OS-level
  // screen capture still works when debugging the launcher's appearance.
  win.loadFile(path.join(__dirname, '..', 'launcher', 'launcher.html'));
  win.once('ready-to-show', () => {
    win.show();
    broadcastStateToLauncher();
  });
  win.on('closed', () => {
    launcherWindow = null;
    log('main', 'launcher closed');
  });
  return win;
}

function createHudWindow(onDisplay: Display): BrowserWindow {
  const w = 280;
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

// ffmpeg webm → mp4 logic lives in ./pipeline.ts now.

// ─── shared state-machine actions ────────────────────────────────────

function enterSelecting(): void {
  if (appState !== 'idle') {
    log('state', 'enterSelecting ignored', { appState });
    return;
  }
  setAppState('selecting', 'user toggle from idle');
  broadcastOverlay('overlay:enter-region-select');
}

function exitSelecting(reason: string): void {
  if (appState !== 'selecting') return;
  setAppState('idle', `exitSelecting: ${reason}`);
  broadcastOverlay('overlay:exit-region-select');
  pendingRegion = null;
  activeDisplayId = null;
  activeSourceId = null;
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
    };
    log('main', 'pendingProcessing snapshotted', {
      annotations: pendingProcessing.annotations.length,
      durationMs: pendingProcessing.durationMs,
    });
  }

  // Tell the recorder to finalize its stream. The webm buffer arrives
  // later via the save-webm IPC — we don't wait for it here.
  if (recorderWindow) recorderWindow.webContents.send('recorder:stop');

  // Clear UI IMMEDIATELY so the user doesn't see annotations + HUD frozen
  // while ffmpeg/whisper grind away in the background.
  setAppState('idle', `user stop: ${reason}`);
  recordingStartedAt = null;
  recordingPaused = false;
  pausedAt = null;
  totalPausedMs = 0;
  pendingRegion = null;
  activeDisplayId = null;
  activeSourceId = null;
  currentAnnotations = [];
  currentRecordingRegionLocal = null;

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
    if (appState !== 'selecting') {
      log('overlay', 'ignoring region-confirmed (wrong state)', { appState });
      return;
    }

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
    log('overlay', 'computed region', { region, displayBounds: display.bounds });

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
    setAppState('recording', 'region confirmed');
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
  const outDir = path.join(process.cwd(), 'spike-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(outDir, `recording-${ts}.webm`);
});

ipcMain.handle(
  'recorder:save-webm',
  (_evt, payload: { buffer: ArrayBuffer; filepath: string }) => {
    const buf = Buffer.from(payload.buffer);
    log('recorder', 'save-webm received', { bytes: buf.length });

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
    const outputRoot = path.join(process.cwd(), 'spike-output');

    // FIRE AND FORGET: pipeline runs in the background. The UI has already
    // been cleaned up by stopRecording() so the user isn't blocked by this.
    runPipeline({
      webmBuffer: buf,
      outputRoot,
      startedAtMs: snap?.startedAtMs ?? fallbackStart,
      durationMs: snap?.durationMs ?? 1000,
      recordingRegion: snap?.recordingRegion ?? null,
      annotations: snap?.annotations ?? [],
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
      })
      .catch((err) => {
        const msg = (err as Error).message;
        log('recorder', 'pipeline fail', { err: msg });
        showNotification('Snipalot', `Pipeline failed: ${msg}`);
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

      const display = screen
        .getAllDisplays()
        .find((d) => String(d.id) === activeDisplayId) ?? screen.getPrimaryDisplay();
      if (!hudWindow) hudWindow = createHudWindow(display);
      hudWindow.once('ready-to-show', () => {
        hudWindow?.show();
        broadcastRecordingState();
      });
      broadcastRecordingState();

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
          };
        }
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

// ─── IPC: launcher ↔ main ─────────────────────────────────────────────

ipcMain.handle('launcher:record', () => {
  log('launcher', 'record click', { appState });
  if (appState === 'idle') enterSelecting();
  else if (appState === 'recording') stopRecording('launcher button');
});

ipcMain.handle('launcher:cancel', () => {
  log('launcher', 'cancel click', { appState });
  if (appState === 'selecting') exitSelecting('launcher cancel');
});

ipcMain.handle('launcher:quit', () => {
  log('launcher', 'quit click');
  app.quit();
});

let launcherMinimized = false;
const LAUNCHER_SIZE_FULL = { width: 320, height: 120 };
const LAUNCHER_SIZE_MIN = { width: 120, height: 42 };

ipcMain.handle('launcher:toggle-minimize', () => {
  if (!launcherWindow || launcherWindow.isDestroyed()) return;
  launcherMinimized = !launcherMinimized;
  const size = launcherMinimized ? LAUNCHER_SIZE_MIN : LAUNCHER_SIZE_FULL;
  launcherWindow.setSize(size.width, size.height);
  launcherWindow.webContents.send('launcher:minimized', launcherMinimized);
  log('launcher', 'toggle-minimize', { minimized: launcherMinimized, size });
});

// ─── shared coordinators (hotkey entry points) ───────────────────────

function handleToggleHotkey(): void {
  log('hotkey', 'Ctrl+Shift+R', { appState });
  switch (appState) {
    case 'idle':
      enterSelecting();
      break;
    case 'selecting':
      // Treat second press during region-select as a cancel — this prevents
      // the "second overlay opens on top of first" bug.
      exitSelecting('Ctrl+Shift+R during selecting');
      break;
    case 'recording':
      stopRecording('Ctrl+Shift+R during recording');
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

  log('main', 'app ready', {
    isDev,
    isSpikeM1,
    cwd: process.cwd(),
    platform: process.platform,
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

  rebuildOverlays();
  recorderWindow = createRecorderWindow();
  launcherWindow = createLauncherWindow();

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

  function regShortcut(combo: string, handler: () => void): void {
    const ok = globalShortcut.register(combo, handler);
    log('hotkey', 'register', { combo, ok });
    if (!ok) {
      // Another app has the hotkey. Surface this so the user knows.
      showNotification('Snipalot', `Could not register hotkey: ${combo} (another app owns it)`);
    }
  }

  regShortcut('Control+Shift+N', () => {
    log('hotkey', 'Ctrl+Shift+N fired', { appState, activeDisplayId });
    if (appState !== 'recording' || !activeDisplayId) {
      showNotification('Snipalot', 'Annotations require an active recording');
      return;
    }
    targetOverlay(activeDisplayId, 'overlay:enter-annotation-mode');
  });
  regShortcut('Control+Shift+R', () => {
    log('hotkey', 'Ctrl+Shift+R fired', { appState, activeDisplayId });
    handleToggleHotkey();
  });
  regShortcut('Control+Shift+H', () => {
    log('hotkey', 'Ctrl+Shift+H fired', { appState, activeDisplayId });
    if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:toggle-outline');
  });
  regShortcut('Control+Shift+P', () => {
    log('hotkey', 'Ctrl+Shift+P fired', { appState });
    togglePause();
  });
  regShortcut('Control+Z', () => {
    if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:global-undo');
  });
  regShortcut('Control+Shift+C', () => {
    if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:global-clear');
  });

  if (isSpikeM1) {
    log(
      'main',
      'multi-display per-overlay build. State machine: idle/selecting/recording. Ctrl+Shift+R cycles.'
    );
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  log('main', 'will-quit');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
