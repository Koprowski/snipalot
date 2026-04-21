/**
 * Snipalot launcher.
 *
 * Small persistent always-on-top control window. Visible when the app is
 * idle or during region-select (so the user always has a clickable
 * "Record" button and a visible state label — no guessing whether a global
 * hotkey actually fired). Hidden during recording itself, when the HUD
 * takes over.
 *
 * Content protection is enabled in main, so this window never appears
 * inside any capture.
 */

const labelEl = document.getElementById('state-label')!;
const btnPrimaryEl = document.getElementById('btn-primary') as HTMLButtonElement;
const btnPrimaryLabelEl = document.getElementById('btn-label')!;
const btnQuitEl = document.getElementById('btn-quit') as HTMLButtonElement;
const btnMinimizeEl = document.getElementById('btn-minimize') as HTMLButtonElement;
const hintEl = document.getElementById('hint')!;

let currentState: 'idle' | 'selecting' | 'recording' = 'idle';

function renderLauncherImpl(): void {
  labelEl.textContent = currentState.toUpperCase();
  labelEl.classList.toggle('selecting', currentState === 'selecting');
  btnPrimaryEl.classList.toggle('selecting', currentState === 'selecting');

  if (currentState === 'idle') {
    btnPrimaryLabelEl.textContent = 'Record';
    hintEl.textContent = 'Click Record to select a region · Ctrl+Shift+R';
  } else if (currentState === 'selecting') {
    btnPrimaryLabelEl.textContent = 'Cancel';
    hintEl.textContent = 'Drag a region on any display · release mouse to confirm · Esc to cancel';
  } else if (currentState === 'recording') {
    btnPrimaryLabelEl.textContent = 'Recording…';
    hintEl.textContent = 'Use the HUD to pause, annotate, or stop';
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

btnQuitEl.addEventListener('click', () => {
  window.snipalotLauncher.quit();
});

btnMinimizeEl.addEventListener('click', () => {
  window.snipalotLauncher.toggleMinimize();
});

window.snipalotLauncher.onState((state) => {
  window.snipalotLauncher.log('state', state);
  currentState = state.appState;
  renderLauncherImpl();
});

renderLauncherImpl();
window.snipalotLauncher.log('boot', 'launcher ready');
