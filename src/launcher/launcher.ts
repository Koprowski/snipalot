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
const btnSettingsEl = document.getElementById('btn-settings') as HTMLButtonElement;
const btnMinimizeEl = document.getElementById('btn-minimize') as HTMLButtonElement;
const btnQuitEl = document.getElementById('btn-quit') as HTMLButtonElement;
const hintEl = document.getElementById('hint')!;

let currentState:
  | 'idle'
  | 'selecting'
  | 'selecting-screenshot'
  | 'recording'
  | 'processing' = 'idle';
let currentProcessingStep: string | null = null;
// Mirrors config.hotkeys.startStop. Updated on every state broadcast so the
// idle hint always reflects the current binding (default: Ctrl+Shift+S).
let currentStartStopHotkey = 'Ctrl+Shift+S';

function renderLauncherImpl(): void {
  // State label: "PROCESSING" + "SELECTING SCREENSHOT" get friendlier
  // capitalization than the raw hyphenated form.
  if (currentState === 'processing') {
    labelEl.textContent = 'PROCESSING';
  } else if (currentState === 'selecting-screenshot') {
    labelEl.textContent = 'SCREENSHOT';
  } else {
    labelEl.textContent = currentState.toUpperCase();
  }
  // Selecting style applies to whichever button is the active "click to
  // cancel" target. Processing style only on Record (the long-running
  // pipeline runs there).
  const isSelectingRecord = currentState === 'selecting';
  const isSelectingScreenshot = currentState === 'selecting-screenshot';
  labelEl.classList.toggle('selecting', isSelectingRecord || isSelectingScreenshot);
  labelEl.classList.toggle('processing', currentState === 'processing');
  btnPrimaryEl.classList.toggle('selecting', isSelectingRecord);
  btnPrimaryEl.classList.toggle('processing', currentState === 'processing');
  btnScreenshotEl.classList.toggle('selecting', isSelectingScreenshot);

  // Disable the off-action button while one mode is mid-flight, so the
  // user can't accidentally start a recording while picking a screenshot
  // region (or vice versa). Re-enabled when state returns to idle.
  btnPrimaryEl.disabled = currentState === 'processing' || isSelectingScreenshot;
  btnScreenshotEl.disabled =
    currentState === 'processing' || isSelectingRecord || currentState === 'recording';

  if (currentState === 'idle') {
    btnPrimaryLabelEl.textContent = 'Record';
    btnPrimaryEl.title = `Record (${currentStartStopHotkey})`;
    btnScreenshotLabelEl.textContent = 'Screenshot';
    btnScreenshotEl.title = 'Screenshot — capture a region for annotation';
    hintEl.textContent = `Record a walkthrough or capture a single screen · ${currentStartStopHotkey}`;
  } else if (currentState === 'selecting') {
    btnPrimaryLabelEl.textContent = 'Cancel';
    btnScreenshotLabelEl.textContent = 'Screenshot';
    hintEl.textContent = 'Drag a region on any display · release to record · Esc to cancel';
  } else if (currentState === 'selecting-screenshot') {
    btnPrimaryLabelEl.textContent = 'Record';
    btnScreenshotLabelEl.textContent = 'Cancel';
    hintEl.textContent = 'Drag a region on any display · release to capture · Esc to cancel';
  } else if (currentState === 'recording') {
    btnPrimaryLabelEl.textContent = 'Recording…';
    btnScreenshotLabelEl.textContent = 'Screenshot';
    hintEl.textContent = 'Use the HUD to pause, annotate, or stop';
  } else if (currentState === 'processing') {
    btnPrimaryLabelEl.textContent = 'Processing…';
    btnScreenshotLabelEl.textContent = 'Screenshot';
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

btnSettingsEl.addEventListener('click', () => {
  window.snipalotLauncher.settings();
});

btnMinimizeEl.addEventListener('click', () => {
  window.snipalotLauncher.toggleMinimize();
});

btnQuitEl.addEventListener('click', () => {
  window.snipalotLauncher.quit();
});

window.snipalotLauncher.onState((state) => {
  window.snipalotLauncher.log('state', state);
  currentState = state.appState;
  currentProcessingStep = state.processingStep;
  if (state.startStopHotkey) currentStartStopHotkey = state.startStopHotkey;
  renderLauncherImpl();
});

renderLauncherImpl();
window.snipalotLauncher.log('boot', 'launcher ready');
