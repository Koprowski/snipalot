/**
 * Snipalot recording HUD.
 *
 * Tiny always-on-top window with content protection enabled (hidden from
 * screen capture), so it won't appear in the recording even when it sits
 * over a captured region. Provides Pause/Resume, Stop, Annotate, and
 * toggle-outline buttons plus the live elapsed-time counter.
 */

const recDotEl = document.getElementById('rec-dot')!;
const recLabelEl = document.getElementById('rec-label')!;
const recTimerEl = document.getElementById('rec-timer')!;
const btnPauseEl = document.getElementById('btn-pause')! as HTMLButtonElement;
const btnStopEl = document.getElementById('btn-stop')! as HTMLButtonElement;
const btnDiscardEl = document.getElementById('btn-discard')! as HTMLButtonElement;
const btnOutlineEl = document.getElementById('btn-outline')! as HTMLButtonElement;
const btnAnnotateEl = document.getElementById('btn-annotate')! as HTMLButtonElement;
const btnSnapEl = document.getElementById('btn-snap')! as HTMLButtonElement;

let startedAt: number | null = null;
let paused = false;
let totalPausedMs = 0;
let tickHandle: number | null = null;

function format(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function render(): void {
  if (startedAt === null) {
    recTimerEl.textContent = '00:00';
    return;
  }
  const elapsed = Date.now() - startedAt - totalPausedMs;
  recTimerEl.textContent = format(elapsed);
  recDotEl.classList.toggle('paused', paused);
  recLabelEl.classList.toggle('paused', paused);
  recLabelEl.textContent = paused ? 'PAUSED' : 'REC';
  btnPauseEl.textContent = paused ? '▶' : '⏸';
}

function startTicker(): void {
  stopTicker();
  tickHandle = window.setInterval(() => {
    if (!paused) render();
  }, 500);
}

function stopTicker(): void {
  if (tickHandle !== null) {
    window.clearInterval(tickHandle);
    tickHandle = null;
  }
}

// ─── button handlers ─────────────────────────────────────────────────

btnPauseEl.addEventListener('click', () => window.snipalotHud.pauseResume());
btnStopEl.addEventListener('click', () => window.snipalotHud.stop());
btnDiscardEl.addEventListener('click', () => {
  // Disable the button while the confirm dialog is up so a frantic user
  // can't double-fire it. Re-enabled regardless of confirm/cancel outcome.
  btnDiscardEl.disabled = true;
  window.snipalotHud.discard().finally(() => { btnDiscardEl.disabled = false; });
});
btnSnapEl.addEventListener('click', () => {
  btnSnapEl.disabled = true;
  window.snipalotHud.snap().finally(() => { btnSnapEl.disabled = false; });
});
btnOutlineEl.addEventListener('click', () => {
  btnOutlineEl.classList.toggle('active');
  window.snipalotHud.toggleOutline();
});
btnAnnotateEl.addEventListener('click', () => window.snipalotHud.enterAnnotation());

// ─── IPC wiring ──────────────────────────────────────────────────────

window.snipalotHud.onState((payload) => {
  startedAt = payload.startedAt;
  paused = payload.paused;
  totalPausedMs = payload.totalPausedMs;
  render();
  startTicker();
});

// Highlight the ✎ button when annotation mode is active so the user has
// a visible toggle cue. Tooltip switches to "Exit annotation" so the
// affordance reads correctly when the button is already lit.
window.snipalotHud.onAnnotationState((payload) => {
  btnAnnotateEl.classList.toggle('active', payload.active);
  btnAnnotateEl.title = payload.active
    ? 'Exit annotation (Ctrl+Shift+A)'
    : 'Annotate (Ctrl+Shift+A)';
});

render();
