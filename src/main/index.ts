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

interface PendingProcessing {
  annotations: AnnotationRecord[];
  recordingRegion: { x: number; y: number; w: number; h: number } | null;
  startedAtMs: number;
  durationMs: number;
  preCreatedSessionDir: string | null;
  chapters: ChapterRecord[];
}
// Snapshot of the stopping recording's metadata. The webm buffer arrives
// async via recorder:save-webm and the pipeline picks up from here.
let pendingProcessing: PendingProcessing | null = null;

// ─── window constructors ──────────────────────────────────────────────

function setAppState(next: AppState, why: string): void {
  const prev = appState;
  if (prev === next) return;
  log('state', `${prev} → ${next}`, why);
  appState = next;

  // Ctrl+Shift+N is registered ONLY while recording so it never steals
  // the keypress from other apps when Snipalot isn't actively capturing.
  if (next === 'recording' && prev !== 'recording') {
    registerAnnotationHotkey();
  } else if (prev === 'recording' && next !== 'recording') {
    unregisterAnnotationHotkey();
  }

  broadcastStateToLauncher();
  updateLauncherVisibility();
  updateTrayMenu(next);
}

function registerAnnotationHotkey(): void {
  if (globalShortcut.isRegistered('Control+Shift+N')) return;
  const ok = globalShortcut.register('Control+Shift+N', handleAnnotationHotkey);
  log('hotkey', 'Ctrl+Shift+N registered (recording started)', { ok });
}

function unregisterAnnotationHotkey(): void {
  if (!globalShortcut.isRegistered('Control+Shift+N')) return;
  globalShortcut.unregister('Control+Shift+N');
  log('hotkey', 'Ctrl+Shift+N unregistered (recording ended)');
}

function handleAnnotationHotkey(): void {
  log('hotkey', 'Ctrl+Shift+N fired', { appState, activeDisplayId });
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
        log('hotkey', 'Ctrl+Shift+N: cursor outside recording region, no-op');
        return;
      }
    }
  }

  targetOverlay(activeDisplayId, 'overlay:enter-annotation-mode');
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
  const w = 340;
  // Native title bar adds ~30px on Windows; bump content height accordingly.
  const h = 150;
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
    // Native window chrome: OS-drawn title bar + minimize/close in upper-right.
    // Previous build was a frameless always-on-top floater; users asked for a
    // normal windowed experience that dismisses naturally when another app is
    // brought forward.
    frame: true,
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

let framePickerWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

// ─── settings window ──────────────────────────────────────────────────

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
  saveConfig(partial);
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
    const mp4 = path.join(path.dirname(payload.sessionDir), 'recording.mp4');
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
      preCreatedSessionDir: liveSessionDir,
      chapters: [...currentChapters],
    };
    log('main', 'pendingProcessing snapshotted', {
      annotations: pendingProcessing.annotations.length,
      chapters: pendingProcessing.chapters.length,
      durationMs: pendingProcessing.durationMs,
    });
  }
  liveSessionDir = null;

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
  currentChapters = [];
  pendingChapterPngs.clear();

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

    // FIRE AND FORGET: pipeline runs in the background. The UI has already
    // been cleaned up by stopRecording() so the user isn't blocked by this.
    runPipeline({
      webmBuffer: buf,
      outputRoot,
      startedAtMs: snap?.startedAtMs ?? fallbackStart,
      durationMs: snap?.durationMs ?? 1000,
      recordingRegion: snap?.recordingRegion ?? null,
      annotations: snap?.annotations ?? [],
      preCreatedSessionDir: snap?.preCreatedSessionDir ?? undefined,
      chapters: snap?.chapters ?? [],
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
      snapCount = 0;
      currentChapters = [];
      pendingChapterPngs.clear();

      // Pre-create the session folder so live snaps have somewhere to land.
      const outputRoot = getConfig().outputDir;
      if (!fs.existsSync(outputRoot)) fs.mkdirSync(outputRoot, { recursive: true });
      const stamp = formatSessionStamp(new Date(recordingStartedAt));
      liveSessionDir = path.join(outputRoot, `${stamp} feedback`);
      if (!fs.existsSync(liveSessionDir)) fs.mkdirSync(liveSessionDir, { recursive: true });
      log('main', 'liveSessionDir created', { liveSessionDir });

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
            preCreatedSessionDir: liveSessionDir,
            chapters: [...currentChapters],
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

ipcMain.handle('hud:snap', () => {
  if (appState !== 'recording' || !recorderWindow || !liveSessionDir) return;
  snapCount++;
  const snapIndex = snapCount;
  const folderName = `snapshot-${snapIndex}`;
  const chapterDir = path.join(liveSessionDir, 'snapshots', folderName);
  if (!fs.existsSync(chapterDir)) fs.mkdirSync(chapterDir, { recursive: true });
  const snapPath = path.join(chapterDir, `${folderName}.png`);
  pendingChapterPngs.set(snapIndex, snapPath);

  // Tell the overlay to flush its current annotations as a chapter and
  // reset numbering. Overlay replies via `overlay:report-snapshot-chapter`.
  if (activeDisplayId) targetOverlay(activeDisplayId, 'overlay:snapshot-reset');

  return new Promise<void>((resolve) => {
    ipcMain.once('recorder:snap-result', (_evt, buffer: ArrayBuffer | null) => {
      if (buffer) {
        fs.writeFileSync(snapPath, Buffer.from(buffer));
        log('hud', 'snap saved', { snapPath, bytes: buffer.byteLength, snapIndex });
      } else {
        log('hud', 'snap failed: no buffer from renderer', { snapIndex });
      }
      resolve();
    });
    recorderWindow!.webContents.send('recorder:snap');
  });
});

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
  if (appState === 'selecting') exitSelecting('launcher cancel');
});

ipcMain.handle('launcher:quit', () => {
  log('launcher', 'quit click');
  app.quit();
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

  function regShortcut(combo: string, handler: () => void): void {
    const ok = globalShortcut.register(combo, handler);
    log('hotkey', 'register', { combo, ok });
    if (!ok) {
      // Another app has the hotkey. Surface this so the user knows.
      showNotification('Snipalot', `Could not register hotkey: ${combo} (another app owns it)`);
    }
  }

  // Ctrl+Shift+N is registered/unregistered dynamically in setAppState so it
  // only captures keystrokes from the OS while a recording is active.
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
  destroyTray();
  log('main', 'will-quit');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
