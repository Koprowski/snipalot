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
const btnSettingsEl = document.getElementById('btn-settings') as HTMLButtonElement;
const btnMinimizeEl = document.getElementById('btn-minimize') as HTMLButtonElement;
const btnQuitEl = document.getElementById('btn-quit') as HTMLButtonElement;
const hintEl = document.getElementById('hint')!;

let currentState: 'idle' | 'selecting' | 'recording' | 'processing' = 'idle';
let currentProcessingStep: string | null = null;

function renderLauncherImpl(): void {
  // 'processing' is multi-minute background work after Stop. Surface it
  // explicitly so the user doesn't think the recording vanished while
  // ffmpeg + whisper grind in the background.
  if (currentState === 'processing') {
    labelEl.textContent = 'PROCESSING';
  } else {
    labelEl.textContent = currentState.toUpperCase();
  }
  labelEl.classList.toggle('selecting', currentState === 'selecting');
  labelEl.classList.toggle('processing', currentState === 'processing');
  btnPrimaryEl.classList.toggle('selecting', currentState === 'selecting');
  btnPrimaryEl.classList.toggle('processing', currentState === 'processing');
  btnPrimaryEl.disabled = currentState === 'processing';

  if (currentState === 'idle') {
    btnPrimaryLabelEl.textContent = 'Record';
    hintEl.textContent = 'Click Record to select a region · Ctrl+Shift+R';
  } else if (currentState === 'selecting') {
    btnPrimaryLabelEl.textContent = 'Cancel';
    hintEl.textContent = 'Drag a region on any display · release mouse to confirm · Esc to cancel';
  } else if (currentState === 'recording') {
    btnPrimaryLabelEl.textContent = 'Recording…';
    hintEl.textContent = 'Use the HUD to pause, annotate, or stop';
  } else if (currentState === 'processing') {
    btnPrimaryLabelEl.textContent = 'Processing…';
    // Show whichever pipeline stage main last reported. Falls back to a
    // generic message until main pushes a step.
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
  renderLauncherImpl();
});

renderLauncherImpl();
window.snipalotLauncher.log('boot', 'launcher ready');
