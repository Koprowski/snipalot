/**
 * Snipalot launcher.
 *
 * Native-framed control window (OS draws the title bar + minimize/close in
 * the upper right). Visible when the app is idle or during region-select
 * so the user always has a clickable "Record" button and a visible state
 * label. Hidden during recording itself, when the HUD takes over.
 *
 * Behaves like any normal window: dismisses to the back when another app
 * is brought forward, minimizes to taskbar via the native title bar.
 */

const labelEl = document.getElementById('state-label')!;
const btnPrimaryEl = document.getElementById('btn-primary') as HTMLButtonElement;
const btnPrimaryLabelEl = document.getElementById('btn-label')!;
const btnScreenshotEl = document.getElementById('btn-screenshot') as HTMLButtonElement;
const btnScreenshotLabelEl = document.getElementById('btn-screenshot-label')!;
const btnTradeEl = document.getElementById('btn-trade') as HTMLButtonElement;
const btnTradeLabelEl = document.getElementById('btn-trade-label')!;
const btnCopyLogEl = document.getElementById('btn-copy-log') as HTMLButtonElement;
const btnSettingsEl = document.getElementById('btn-settings') as HTMLButtonElement;
const btnMinimizeEl = document.getElementById('btn-minimize') as HTMLButtonElement;
const btnQuitEl = document.getElementById('btn-quit') as HTMLButtonElement;
const hintEl = document.getElementById('hint')!;
const hkRecordEl = document.getElementById('hk-record')!;
const hkScreenshotEl = document.getElementById('hk-screenshot')!;
const hkTradeEl = document.getElementById('hk-trade')!;
const launcherUpdateEl = document.getElementById('launcher-update') as HTMLButtonElement;
const launcherUpdateLabelEl = document.getElementById('launcher-update-label')!;
const launcherUpdateProgressFillEl = document.getElementById('launcher-update-progress-fill') as HTMLElement;
const captureModeEl = document.querySelector('.capture-mode') as HTMLDivElement;
const captureModeButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.capture-mode-btn')
);

let currentState:
  | 'idle'
  | 'selecting'
  | 'selecting-screenshot'
  | 'selecting-trade'
  | 'recording'
  | 'processing' = 'idle';
let currentProcessingStep: string | null = null;
let currentProcessingProgress:
  | { pct: number; etaSec: number; elapsedSec: number }
  | null = null;
let currentCanAbandonProcessing = false;
// Mirrors config.hotkeys.startStop. Updated on every state broadcast so the
// idle hint always reflects the current binding (default: Ctrl+Shift+S).
let currentStartStopHotkey = 'Ctrl+Shift+S';
let currentSnapshotHotkey = 'Ctrl+Shift+P';
let currentStartTradeHotkey = 'Ctrl+Shift+T';
// Mirrors config.hotkeys.tradeMarker. Used in the trade-recording hint only.
let currentTradeMarkerHotkey = 'Ctrl+Shift+X';
let currentCaptureMode: 'region' | 'fullscreen' | 'window' = 'region';
let currentVisibleActions = {
  record: true,
  screenshot: true,
  trade: false,
};
let availableUpdateVersion: string | null = null;
let availableUpdateHasInstaller = false;
let updateInstallInProgress = false;
let updateBannerVisible: boolean | null = null;
let updateDownloadProgress: {
  version: string;
  installerName: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
} | null = null;
let updateStatusMessage: string | null = null;
let updateStatusIsError = false;
// Tracks whether the active recording is record-mode or trade-mode (both
// share the 'recording' AppState; only the launcher label/hint differ).
let currentSessionMode: 'record' | 'trade' = 'record';

function renderLauncherImpl(): void {
  // State label: hyphenated states get friendlier capitalization. While
  // recording, the label distinguishes record vs trade by sessionMode
  // (both share the 'recording' AppState).
  if (currentState === 'processing') {
    labelEl.textContent = 'PROCESSING';
  } else if (currentState === 'selecting-screenshot') {
    labelEl.textContent = 'SCREENSHOT';
  } else if (currentState === 'selecting-trade') {
    labelEl.textContent = 'TRADE';
  } else if (currentState === 'recording' && currentSessionMode === 'trade') {
    labelEl.textContent = 'TRADING';
  } else {
    labelEl.textContent = currentState.toUpperCase();
  }
  const isSelectingRecord = currentState === 'selecting';
  const isSelectingScreenshot = currentState === 'selecting-screenshot';
  const isSelectingTrade = currentState === 'selecting-trade';
  const isRecording = currentState === 'recording';
  const isTrading = isRecording && currentSessionMode === 'trade';
  const isProcessing = currentState === 'processing';
  const shouldShowRecord =
    isProcessing ||
    currentVisibleActions.record ||
    isSelectingRecord;
  const shouldShowScreenshot =
    !isProcessing && (currentVisibleActions.screenshot || isSelectingScreenshot);
  const shouldShowTrade =
    !isProcessing && (currentVisibleActions.trade || isSelectingTrade || isTrading);
  labelEl.classList.toggle('selecting', isSelectingRecord || isSelectingScreenshot || isSelectingTrade);
  labelEl.classList.toggle('processing', currentState === 'processing');
  btnPrimaryEl.classList.toggle('selecting', isSelectingRecord);
  btnPrimaryEl.classList.toggle('processing', currentState === 'processing');
  btnPrimaryEl.classList.toggle(
    'processing-abandon',
    currentState === 'processing' && currentCanAbandonProcessing
  );
  btnScreenshotEl.classList.toggle('selecting', isSelectingScreenshot);
  btnTradeEl.classList.toggle('selecting', isSelectingTrade);
  btnPrimaryEl.hidden = !shouldShowRecord;
  btnScreenshotEl.hidden = !shouldShowScreenshot;
  btnTradeEl.hidden = !shouldShowTrade;
  hkRecordEl.hidden = isProcessing || !shouldShowRecord;
  hkScreenshotEl.hidden = isProcessing || !shouldShowScreenshot;
  hkTradeEl.hidden = isProcessing || !shouldShowTrade;
  const visibleCount = [shouldShowRecord, shouldShowScreenshot, shouldShowTrade].filter(Boolean).length;
  document.body.dataset.visibleActionCount = String(Math.max(1, visibleCount));
  renderCaptureModeButtons();
  renderLauncherUpdate();

  // Disable the off-action buttons while another mode is mid-flight so the
  // user can't accidentally start a different mode partway through.
  btnPrimaryEl.disabled =
    (currentState === 'processing' && !currentCanAbandonProcessing) ||
    isSelectingScreenshot || isSelectingTrade || isTrading;
  btnScreenshotEl.disabled =
    currentState === 'processing' || isSelectingRecord || isSelectingTrade || isRecording;
  btnTradeEl.disabled =
    currentState === 'processing' || isSelectingRecord || isSelectingScreenshot ||
    (isRecording && !isTrading);
  hkRecordEl.textContent = currentStartStopHotkey;
  hkScreenshotEl.textContent = currentSnapshotHotkey;
  hkTradeEl.textContent = currentStartTradeHotkey;

  if (currentState === 'idle') {
    btnPrimaryLabelEl.textContent = 'Record';
    btnPrimaryEl.title = `Record (${currentStartStopHotkey})`;
    btnScreenshotLabelEl.textContent = 'Screenshot';
    btnScreenshotEl.title = currentCaptureMode === 'fullscreen'
      ? 'Screenshot - captures full screen based upon cursor location'
      : 'Screenshot - capture a selected region for annotation';
    btnTradeLabelEl.textContent = 'Trade';
    btnTradeEl.title = 'Trade — record a session for trade-log extraction';
    hintEl.textContent = currentCaptureMode === 'fullscreen'
      ? 'Captures Full Screen Based Upon Cursor Location'
      : 'Select mode lets you drag the area to capture.';
  } else if (currentState === 'selecting') {
    btnPrimaryLabelEl.textContent = 'Cancel';
    btnScreenshotLabelEl.textContent = 'Screenshot';
    btnTradeLabelEl.textContent = 'Trade';
    hintEl.textContent = 'Drag a region on any display · release to record · Esc to cancel';
  } else if (currentState === 'selecting-screenshot') {
    btnPrimaryLabelEl.textContent = 'Record';
    btnScreenshotLabelEl.textContent = 'Cancel';
    btnTradeLabelEl.textContent = 'Trade';
    hintEl.textContent = 'Drag a region on any display · release to capture · Esc to cancel';
  } else if (currentState === 'selecting-trade') {
    btnPrimaryLabelEl.textContent = 'Record';
    btnScreenshotLabelEl.textContent = 'Screenshot';
    btnTradeLabelEl.textContent = 'Cancel';
    hintEl.textContent = 'Drag a region on any display · release to start a trade session · Esc to cancel';
  } else if (currentState === 'recording') {
    btnPrimaryLabelEl.textContent = isTrading ? 'Record' : 'Recording…';
    btnScreenshotLabelEl.textContent = 'Screenshot';
    btnTradeLabelEl.textContent = isTrading ? 'Trading…' : 'Trade';
    hintEl.textContent = isTrading
      ? `Trade session live · ${currentTradeMarkerHotkey} marks a trade · stop via HUD`
      : 'Use the HUD to pause, annotate, or stop';
  } else if (currentState === 'processing') {
    btnPrimaryLabelEl.textContent = currentCanAbandonProcessing ? 'Abandon' : 'Processing…';
    btnScreenshotLabelEl.textContent = 'Screenshot';
    btnTradeLabelEl.textContent = 'Trade';
    hintEl.textContent = currentProcessingStep
      ? currentProcessingStep
      : 'Saving recording, transcribing, and generating prompt…';
    btnPrimaryEl.title = currentCanAbandonProcessing
      ? 'Abandon this processing run and delete its session folder'
      : 'Processing…';
  }

  // Progress bar visibility + fill: shown only during 'processing' state
  // when main has sent us a progress estimate. The 'transition: width' on
  // .progress-fill smooths the 250ms tick into a gentle slide.
  const block = document.getElementById('progress-block') as HTMLDivElement;
  const fill = document.getElementById('progress-fill') as HTMLDivElement;
  const elapsedEl = document.getElementById('progress-elapsed')!;
  const etaEl = document.getElementById('progress-eta')!;
  if (currentState === 'processing' && currentProcessingProgress) {
    block.style.display = 'flex';
    fill.style.width = `${currentProcessingProgress.pct.toFixed(1)}%`;
    elapsedEl.textContent = formatProgressTime(currentProcessingProgress.elapsedSec);
    // ETA hidden once we're in the cap-at-95% tail; the bar sits there
    // while waiting on slow steps so a rolling ETA would just count down
    // forever. Show "wrapping up…" instead.
    if (currentProcessingProgress.etaSec <= 0 || currentProcessingProgress.pct >= 95) {
      etaEl.textContent = 'wrapping up…';
    } else {
      etaEl.textContent = `~${formatProgressTime(currentProcessingProgress.etaSec)} remaining`;
    }
  } else {
    block.style.display = 'none';
  }
}

function formatProgressTime(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatLauncherBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function renderLauncherUpdate(): void {
  const shouldShow = Boolean(availableUpdateVersion);
  launcherUpdateEl.hidden = !shouldShow;
  if (updateBannerVisible !== shouldShow) {
    updateBannerVisible = shouldShow;
    void window.snipalotLauncher.setUpdateBannerVisible(shouldShow).catch((err) => {
      window.snipalotLauncher.log('update-banner-resize', 'fail', { message: (err as Error).message });
    });
  }
  if (!shouldShow) return;
  launcherUpdateEl.disabled = updateInstallInProgress || !availableUpdateHasInstaller;
  launcherUpdateEl.classList.toggle('installing', updateInstallInProgress && !updateStatusIsError);
  launcherUpdateEl.classList.toggle('downloading', updateInstallInProgress && updateDownloadProgress !== null);
  launcherUpdateEl.classList.toggle('err', updateStatusIsError);
  const percent = updateDownloadProgress?.percent ?? (
    updateDownloadProgress?.totalBytes
      ? Math.round((updateDownloadProgress.downloadedBytes / updateDownloadProgress.totalBytes) * 100)
      : null
  );
  launcherUpdateProgressFillEl.style.width = updateDownloadProgress
    ? `${Math.max(0, Math.min(100, percent ?? 8))}%`
    : '0%';
  if (updateStatusMessage) {
    launcherUpdateLabelEl.textContent = updateStatusMessage;
  } else if (updateDownloadProgress) {
    const sizeText = updateDownloadProgress.totalBytes
      ? `${formatLauncherBytes(updateDownloadProgress.downloadedBytes)} of ${formatLauncherBytes(updateDownloadProgress.totalBytes)}`
      : formatLauncherBytes(updateDownloadProgress.downloadedBytes);
    launcherUpdateLabelEl.textContent = percent === null
      ? `Downloading Snipalot ${updateDownloadProgress.version} installer... ${sizeText}`
      : `Downloading Snipalot ${updateDownloadProgress.version} installer... ${percent}% (${sizeText})`;
  } else {
    launcherUpdateLabelEl.textContent = updateInstallInProgress
      ? `Installing Snipalot ${availableUpdateVersion}...`
      : `Snipalot ${availableUpdateVersion} is available. Click here to install.`;
  }
  launcherUpdateEl.title = availableUpdateHasInstaller
    ? `Download and install Snipalot ${availableUpdateVersion}`
    : `Snipalot ${availableUpdateVersion} is available, but no installer asset was found`;
}

function renderCaptureModeButtons(): void {
  captureModeEl.classList.toggle('mode-region', currentCaptureMode === 'region');
  captureModeEl.classList.toggle('mode-fullscreen', currentCaptureMode === 'fullscreen');
  captureModeEl.classList.toggle('mode-window', currentCaptureMode === 'window');
  for (const button of captureModeButtons) {
    const mode = button.dataset.mode as 'region' | 'fullscreen' | 'window' | undefined;
    const active = mode === currentCaptureMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.disabled = currentState !== 'idle' || mode === 'window';
  }
}

for (const button of captureModeButtons) {
  button.addEventListener('click', async () => {
    const mode = button.dataset.mode as 'region' | 'fullscreen' | 'window' | undefined;
    if (!mode || mode === 'window' || currentState !== 'idle') return;
    currentCaptureMode = await window.snipalotLauncher.setCaptureMode(mode);
    renderLauncherImpl();
  });
}

btnPrimaryEl.addEventListener('click', () => {
  window.snipalotLauncher.log('click', 'primary', {
    currentState,
    visibleActions: currentVisibleActions,
  });
  if (currentState === 'idle') {
    window.snipalotLauncher.record();
  } else if (currentState === 'selecting') {
    window.snipalotLauncher.cancel();
  } else if (currentState === 'processing' && currentCanAbandonProcessing) {
    void window.snipalotLauncher.abandonProcessing();
  }
  // recording state: button is a no-op here; use HUD
});

btnScreenshotEl.addEventListener('click', () => {
  window.snipalotLauncher.log('click', 'screenshot', {
    currentState,
    visibleActions: currentVisibleActions,
  });
  if (currentState === 'idle') {
    window.snipalotLauncher.screenshot();
  } else if (currentState === 'selecting-screenshot') {
    window.snipalotLauncher.cancel();
  }
});

btnTradeEl.addEventListener('click', () => {
  window.snipalotLauncher.log('click', 'trade', {
    currentState,
    visibleActions: currentVisibleActions,
  });
  if (currentState === 'idle') {
    window.snipalotLauncher.trade();
  } else if (currentState === 'selecting-trade') {
    window.snipalotLauncher.cancel();
  }
});

btnSettingsEl.addEventListener('click', () => {
  window.snipalotLauncher.settings();
});

btnCopyLogEl.addEventListener('click', async () => {
  btnCopyLogEl.disabled = true;
  const prevTitle = btnCopyLogEl.title;
  try {
    const result = await window.snipalotLauncher.copySupportLog();
    if (result.ok) {
      btnCopyLogEl.classList.add('copied');
      btnCopyLogEl.title = result.mode === 'file'
        ? 'Copied sanitized log file to clipboard'
        : 'Copied sanitized log text to clipboard';
      window.snipalotLauncher.log('copy-support-log', 'success', result);
      setTimeout(() => {
        btnCopyLogEl.classList.remove('copied');
        btnCopyLogEl.title = prevTitle;
      }, 2500);
    } else {
      btnCopyLogEl.classList.add('err');
      btnCopyLogEl.title = result.error;
      window.snipalotLauncher.log('copy-support-log', 'fail', result);
      setTimeout(() => {
        btnCopyLogEl.classList.remove('err');
        btnCopyLogEl.title = prevTitle;
      }, 3500);
    }
  } finally {
    btnCopyLogEl.disabled = false;
  }
});

btnMinimizeEl.addEventListener('click', () => {
  window.snipalotLauncher.toggleMinimize();
});

btnQuitEl.addEventListener('click', () => {
  // X triggers full app exit (same path as Settings -> Exit Snipalot),
  // including main-process shutdown cleanup.
  void window.snipalotLauncher.exitApp();
});

// ── Copy last prompt ─────────────────────────────────────────────────
const btnCopyLastEl = document.getElementById('btn-copy-last') as HTMLButtonElement;

btnCopyLastEl.addEventListener('click', async () => {
  btnCopyLastEl.disabled = true;
  const prevTitle = btnCopyLastEl.title;
  try {
    const result = await window.snipalotLauncher.copyLastPrompt();
    if (result.ok) {
      // Brief visual confirmation. Color flash + tooltip update so even
      // if the user is looking elsewhere they can hover later to verify.
      btnCopyLastEl.classList.add('copied');
      btnCopyLastEl.title = `✓ Copied ${result.kind} prompt (${result.sessionName}, ${result.chars} chars)`;
      window.snipalotLauncher.log('copy-last', 'success', {
        kind: result.kind,
        sessionName: result.sessionName,
        chars: result.chars,
      });
      setTimeout(() => {
        btnCopyLastEl.classList.remove('copied');
        btnCopyLastEl.title = prevTitle;
      }, 2000);
    } else {
      btnCopyLastEl.classList.add('err');
      btnCopyLastEl.title = `✗ ${result.error}`;
      window.snipalotLauncher.log('copy-last', 'fail', { error: result.error });
      setTimeout(() => {
        btnCopyLastEl.classList.remove('err');
        btnCopyLastEl.title = prevTitle;
      }, 3000);
    }
  } finally {
    btnCopyLastEl.disabled = false;
  }
});

// ── Pin (alwaysOnTop) toggle ─────────────────────────────────────────
const btnPinEl = document.getElementById('btn-pin') as HTMLButtonElement;

function applyPinVisualState(pinned: boolean): void {
  btnPinEl.classList.toggle('active', pinned);
  btnPinEl.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  btnPinEl.title = pinned
    ? 'Pinned on top — click to unpin (launcher will hide behind other windows)'
    : 'Pin on top — keep launcher visible above other windows';
}

btnPinEl.addEventListener('click', async () => {
  const pinned = await window.snipalotLauncher.togglePin();
  applyPinVisualState(pinned);
});

// Sync the button visual to whatever main has stored in config.
window.snipalotLauncher.getPinState().then(applyPinVisualState).catch(() => { /* ignore */ });

window.snipalotLauncher.onState((state) => {
  window.snipalotLauncher.log('state', state);
  currentState = state.appState;
  currentProcessingStep = state.processingStep;
  if (state.startStopHotkey) currentStartStopHotkey = state.startStopHotkey;
  if (state.snapshotHotkey) currentSnapshotHotkey = state.snapshotHotkey;
  if (state.startTradeHotkey) currentStartTradeHotkey = state.startTradeHotkey;
  if (state.tradeMarkerHotkey) currentTradeMarkerHotkey = state.tradeMarkerHotkey;
  if (state.captureMode) currentCaptureMode = state.captureMode;
  if (state.visibleActions) currentVisibleActions = state.visibleActions;
  if (state.sessionMode) currentSessionMode = state.sessionMode;
  currentCanAbandonProcessing = state.canAbandonProcessing ?? false;
  currentProcessingProgress = state.processingProgress ?? null;
  renderLauncherImpl();
});

launcherUpdateEl.addEventListener('click', async () => {
  if (!availableUpdateVersion || updateInstallInProgress || !availableUpdateHasInstaller) return;
  updateInstallInProgress = true;
  updateStatusMessage = null;
  updateStatusIsError = false;
  updateDownloadProgress = {
    version: availableUpdateVersion,
    installerName: '',
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
  };
  renderLauncherUpdate();
  try {
    const result = await window.snipalotLauncher.installUpdate();
    if (!result.ok) {
      updateInstallInProgress = false;
      updateDownloadProgress = null;
      updateStatusMessage = result.message;
      updateStatusIsError = true;
      renderLauncherUpdate();
      window.snipalotLauncher.log('update-install', 'fail', result);
      return;
    }
    updateDownloadProgress = null;
    updateStatusMessage = result.message;
    updateStatusIsError = false;
    renderLauncherUpdate();
    window.snipalotLauncher.log('update-install', 'success', result);
  } catch (err) {
    updateInstallInProgress = false;
    const message = `Update install failed: ${(err as Error).message}`;
    updateDownloadProgress = null;
    updateStatusMessage = message;
    updateStatusIsError = true;
    renderLauncherUpdate();
    window.snipalotLauncher.log('update-install', 'error', { message });
  }
});

window.snipalotLauncher.onUpdateDownloadProgress((progress) => {
  updateInstallInProgress = true;
  updateDownloadProgress = progress;
  updateStatusMessage = null;
  updateStatusIsError = false;
  renderLauncherUpdate();
});

renderLauncherImpl();
window.snipalotLauncher.getCaptureMode()
  .then((mode) => {
    currentCaptureMode = mode;
    renderLauncherImpl();
  })
  .catch(() => { /* ignore */ });
window.snipalotLauncher.checkForUpdates()
  .then((result) => {
    if (result.ok && result.updateAvailable && result.latestVersion) {
      availableUpdateVersion = result.latestVersion;
      availableUpdateHasInstaller = Boolean(result.installerAssetUrl);
      updateStatusMessage = null;
      updateStatusIsError = false;
      updateDownloadProgress = null;
      renderLauncherImpl();
    }
  })
  .catch((err) => {
    window.snipalotLauncher.log('update-check', 'fail', { message: (err as Error).message });
  });
window.snipalotLauncher.log('boot', 'launcher ready');
