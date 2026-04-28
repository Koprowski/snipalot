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
// Mirrors config.hotkeys.startStop. Updated on every state broadcast so the
// idle hint always reflects the current binding (default: Ctrl+Shift+S).
let currentStartStopHotkey = 'Ctrl+Shift+S';
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
      ? 'Trade session live · Ctrl+Shift+T marks a trade · stop via HUD'
      : 'Use the HUD to pause, annotate, or stop';
  } else if (currentState === 'processing') {
    btnPrimaryLabelEl.textContent = 'Processing…';
    btnScreenshotLabelEl.textContent = 'Screenshot';
    btnTradeLabelEl.textContent = 'Trade';
    hintEl.textContent = currentProcessingStep
      ? currentProcessingStep
      : 'Saving recording, transcribing, and generating prompt…';
  }
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

window.snipalotLauncher.onState((state) => {
  window.snipalotLauncher.log('state', state);
  currentState = state.appState;
  currentProcessingStep = state.processingStep;
  if (state.startStopHotkey) currentStartStopHotkey = state.startStopHotkey;
  if (state.sessionMode) currentSessionMode = state.sessionMode;
  renderLauncherImpl();
});

renderLauncherImpl();
window.snipalotLauncher.log('boot', 'launcher ready');
