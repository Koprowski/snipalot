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
const btnSettingsEl = document.getElementById('btn-settings') as HTMLButtonElement;
const btnMinimizeEl = document.getElementById('btn-minimize') as HTMLButtonElement;
const btnQuitEl = document.getElementById('btn-quit') as HTMLButtonElement;
const hintEl = document.getElementById('hint')!;

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
// Mirrors config.hotkeys.startStop. Updated on every state broadcast so the
// idle hint always reflects the current binding (default: Ctrl+Shift+S).
let currentStartStopHotkey = 'Ctrl+Shift+S';
// Mirrors config.hotkeys.tradeMarker. Used in the trade-recording hint only.
let currentTradeMarkerHotkey = 'Ctrl+Shift+M';
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
  labelEl.classList.toggle('selecting', isSelectingRecord || isSelectingScreenshot || isSelectingTrade);
  labelEl.classList.toggle('processing', currentState === 'processing');
  btnPrimaryEl.classList.toggle('selecting', isSelectingRecord);
  btnPrimaryEl.classList.toggle('processing', currentState === 'processing');
  btnScreenshotEl.classList.toggle('selecting', isSelectingScreenshot);
  btnTradeEl.classList.toggle('selecting', isSelectingTrade);

  // Disable the off-action buttons while another mode is mid-flight so the
  // user can't accidentally start a different mode partway through.
  btnPrimaryEl.disabled =
    currentState === 'processing' || isSelectingScreenshot || isSelectingTrade || isTrading;
  btnScreenshotEl.disabled =
    currentState === 'processing' || isSelectingRecord || isSelectingTrade || isRecording;
  btnTradeEl.disabled =
    currentState === 'processing' || isSelectingRecord || isSelectingScreenshot ||
    (isRecording && !isTrading);

  if (currentState === 'idle') {
    btnPrimaryLabelEl.textContent = 'Record';
    btnPrimaryEl.title = `Record (${currentStartStopHotkey})`;
    btnScreenshotLabelEl.textContent = 'Screenshot';
    btnScreenshotEl.title = 'Screenshot — capture a region for annotation';
    btnTradeLabelEl.textContent = 'Trade';
    btnTradeEl.title = 'Trade — record a session for trade-log extraction';
    hintEl.textContent = `Record / capture / track trades · ${currentStartStopHotkey}`;
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
    btnPrimaryLabelEl.textContent = 'Processing…';
    btnScreenshotLabelEl.textContent = 'Screenshot';
    btnTradeLabelEl.textContent = 'Trade';
    hintEl.textContent = currentProcessingStep
      ? currentProcessingStep
      : 'Saving recording, transcribing, and generating prompt…';
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

btnPrimaryEl.addEventListener('click', () => {
  window.snipalotLauncher.log('click', 'primary', { currentState });
  if (currentState === 'idle') {
    window.snipalotLauncher.record();
  } else if (currentState === 'selecting') {
    window.snipalotLauncher.cancel();
  }
  // recording state: button is a no-op here; use HUD
});

btnScreenshotEl.addEventListener('click', () => {
  window.snipalotLauncher.log('click', 'screenshot', { currentState });
  if (currentState === 'idle') {
    window.snipalotLauncher.screenshot();
  } else if (currentState === 'selecting-screenshot') {
    window.snipalotLauncher.cancel();
  }
});

btnTradeEl.addEventListener('click', () => {
  window.snipalotLauncher.log('click', 'trade', { currentState });
  if (currentState === 'idle') {
    window.snipalotLauncher.trade();
  } else if (currentState === 'selecting-trade') {
    window.snipalotLauncher.cancel();
  }
});

btnSettingsEl.addEventListener('click', () => {
  window.snipalotLauncher.settings();
});

btnMinimizeEl.addEventListener('click', () => {
  window.snipalotLauncher.toggleMinimize();
});

btnQuitEl.addEventListener('click', () => {
  // X = hide to tray, NOT quit. Snipalot stays running in the background
  // so hotkeys (Ctrl+Shift+S, Ctrl+Shift+T, etc.) keep firing globally.
  // To fully exit, use the tray menu's "Quit Snipalot" option.
  window.snipalotLauncher.closeToTray();
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
  if (state.tradeMarkerHotkey) currentTradeMarkerHotkey = state.tradeMarkerHotkey;
  if (state.sessionMode) currentSessionMode = state.sessionMode;
  currentProcessingProgress = state.processingProgress ?? null;
  renderLauncherImpl();
});

renderLauncherImpl();
window.snipalotLauncher.log('boot', 'launcher ready');
