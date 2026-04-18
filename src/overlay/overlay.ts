/**
 * Snipalot annotation + region-select overlay.
 *
 * ONE instance per display. The display id is read from window.location.search
 * (set by main when this window is created). All coordinates here are
 * "display-local CSS pixels" — i.e. relative to the top-left of THIS display.
 *
 * Modes:
 *   - region-select: dim this display, let user drag a rect locally
 *   - annotation: draw numbered rectangles, STRICTLY inside recordingRegion
 *   - region outline: dashed box just OUTSIDE the recording region (drawn
 *     only by the overlay that owns the active recording)
 *
 * Lifecycle: when recording stops, annotation mode exits + annotations clear.
 */

interface Annotation {
  number: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** ms since recording started. 0 if drawn before recording began. */
  drawnAtMs: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;
const regionStatusEl = document.getElementById('region-status')!;
const regionConfirmEl = document.getElementById('region-confirm')!;
const regionDimsEl = document.getElementById('region-dims')!;
const regionConfirmBtn = document.getElementById('region-confirm-btn')!;
const regionCancelBtn = document.getElementById('region-cancel-btn')!;

const DPR = window.devicePixelRatio || 1;
const myDisplayId = window.snipalot.displayId;

window.snipalot.log('boot', {
  displayId: myDisplayId,
  innerW: window.innerWidth,
  innerH: window.innerHeight,
  DPR,
});

let annotations: Annotation[] = [];
let nextNumber = 1;
let drawing = false;
let recordingStartedAt: number | null = null;

function nowDrawMs(): number {
  return recordingStartedAt ? Date.now() - recordingStartedAt : 0;
}

function pushAnnotationSync(): void {
  // Send the current annotation list (plus recording-region snapshot) to main
  // on every change so main can persist annotations.json without having to
  // race with the recording-stopped IPC.
  if (!ownsRecording) return;
  void window.snipalot.syncAnnotations({
    annotations: annotations.map((a) => ({
      number: a.number,
      x: a.x,
      y: a.y,
      w: a.w,
      h: a.h,
      drawnAtMs: a.drawnAtMs,
    })),
    recordingRegion,
  });
}
let dragStart: { x: number; y: number } | null = null;
let currentRect: Rect | null = null;
let annotationMode = false;
let regionSelectMode = false;
let confirmedRegion: Rect | null = null;
let recordingRegion: Rect | null = null; // set only on the overlay that owns the recording
let outlineVisible = true;
let isRecording = false;
let ownsRecording = false;
// Mirror of setIgnoreMouseEvents state. Used to avoid redundant IPC flips.
let overlayInteractive = false;

const STYLE = {
  annotationColor: '#EF4444',
  badgeColor: '#FFFFFF',
  strokeWidth: 3,
  fontSize: 16,
  badgeRadius: 14,
  dimColor: 'rgba(0, 0, 0, 0.5)',
  regionStroke: '#EF4444',
  regionStrokeWidth: 2,
  outlineOutsideOffset: 4,
};

// ─── canvas setup & render ───────────────────────────────────────────

function resizeCanvas(): void {
  canvas.width = window.innerWidth * DPR;
  canvas.height = window.innerHeight * DPR;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  redraw();
}

function redraw(): void {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  if (regionSelectMode) {
    ctx.fillStyle = STYLE.dimColor;
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    const live = currentRect ?? confirmedRegion;
    if (live && live.w > 0 && live.h > 0) {
      ctx.clearRect(live.x, live.y, live.w, live.h);
      ctx.strokeStyle = STYLE.regionStroke;
      ctx.lineWidth = STYLE.regionStrokeWidth;
      ctx.strokeRect(live.x, live.y, live.w, live.h);
    }
  }

  if (recordingRegion && !regionSelectMode && outlineVisible) {
    const o = STYLE.outlineOutsideOffset;
    const r = recordingRegion;
    ctx.save();
    ctx.strokeStyle = STYLE.regionStroke;
    ctx.lineWidth = STYLE.regionStrokeWidth;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(r.x - o, r.y - o, r.w + 2 * o, r.h + 2 * o);
    ctx.restore();
  }

  for (const ann of annotations) drawAnnotation(ann);
  if (annotationMode && currentRect && !regionSelectMode) {
    drawAnnotation({
      number: nextNumber,
      x: currentRect.x,
      y: currentRect.y,
      w: currentRect.w,
      h: currentRect.h,
      drawnAtMs: 0,
    });
  }
}

function drawAnnotation(a: Annotation): void {
  ctx.strokeStyle = STYLE.annotationColor;
  ctx.lineWidth = STYLE.strokeWidth;
  ctx.strokeRect(a.x, a.y, a.w, a.h);

  ctx.fillStyle = STYLE.annotationColor;
  ctx.beginPath();
  ctx.arc(a.x, a.y, STYLE.badgeRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = STYLE.badgeColor;
  ctx.font = `bold ${STYLE.fontSize}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(a.number), a.x, a.y + 1);
}

// ─── containment helpers ─────────────────────────────────────────────

function isInsideRecordingRegion(x: number, y: number): boolean {
  if (!recordingRegion) return false;
  const r = recordingRegion;
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function clampToRecordingRegion(x: number, y: number): { x: number; y: number } {
  if (!recordingRegion) return { x, y };
  const r = recordingRegion;
  return {
    x: Math.min(r.x + r.w, Math.max(r.x, x)),
    y: Math.min(r.y + r.h, Math.max(r.y, y)),
  };
}

// ─── interactivity helper (avoids redundant IPC flips) ──────────────

async function setInteractiveIfChanged(interactive: boolean): Promise<void> {
  if (interactive === overlayInteractive) return;
  overlayInteractive = interactive;
  await window.snipalot.setInteractive(interactive);
}

// ─── mode transitions ────────────────────────────────────────────────

async function enterRegionSelectMode(): Promise<void> {
  if (regionSelectMode) return;
  if (annotationMode) await exitAnnotationMode();
  regionSelectMode = true;
  confirmedRegion = null;
  currentRect = null;
  drawing = false;
  dragStart = null;
  document.body.classList.add('region-select-mode');
  regionStatusEl.classList.remove('region-hidden');
  // Region-select needs the whole overlay interactive — user can drag anywhere.
  await setInteractiveIfChanged(true);
  window.snipalot.log('mode', 'enter region-select');
  redraw();
}

async function exitRegionSelectMode(): Promise<void> {
  if (!regionSelectMode) return;
  regionSelectMode = false;
  document.body.classList.remove('region-select-mode');
  regionStatusEl.classList.add('region-hidden');
  regionConfirmEl.classList.add('region-hidden');
  confirmedRegion = null;
  currentRect = null;
  await setInteractiveIfChanged(false);
  window.snipalot.log('mode', 'exit region-select');
  redraw();
}

function showRegionConfirmPanel(r: Rect): void {
  const panelEstimate = { w: 230, h: 42 };
  let left = r.x + r.w - panelEstimate.w;
  let top = r.y + r.h + 10;
  if (top + panelEstimate.h > window.innerHeight - 8) top = r.y - panelEstimate.h - 10;
  if (top < 8) top = 8;
  if (left < 8) left = 8;
  if (left + panelEstimate.w > window.innerWidth - 8)
    left = window.innerWidth - panelEstimate.w - 8;
  regionConfirmEl.style.left = `${left}px`;
  regionConfirmEl.style.top = `${top}px`;
  regionDimsEl.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
  regionConfirmEl.classList.remove('region-hidden');
}

async function enterAnnotationMode(): Promise<void> {
  if (!isRecording || !ownsRecording || !recordingRegion) {
    window.snipalot.log('mode', 'enter annotation REJECTED', {
      isRecording,
      ownsRecording,
      hasRegion: !!recordingRegion,
    });
    return;
  }
  if (annotationMode) return;
  annotationMode = true;
  document.body.classList.add('annotation-mode');
  statusEl.classList.remove('status-hidden');
  // Start click-through. The mousemove handler flips the overlay to
  // interactive when the cursor enters the recording region, and back to
  // click-through when it leaves, so clicks outside the region (on the HUD
  // especially) pass through to the right window.
  await setInteractiveIfChanged(false);
  // Keyboard focus is separate from mouse interactivity on Windows — this
  // lets Esc reach the overlay even while it's click-through.
  await window.snipalot.focusWindow();
  window.snipalot.log('mode', 'enter annotation (click-through until cursor enters region)');
}

async function exitAnnotationMode(): Promise<void> {
  if (!annotationMode) return;
  annotationMode = false;
  drawing = false;
  dragStart = null;
  currentRect = null;
  document.body.classList.remove('annotation-mode');
  statusEl.classList.add('status-hidden');
  await setInteractiveIfChanged(false);
  window.snipalot.log('mode', 'exit annotation');
  redraw();
}

// Dynamically flip interactivity based on cursor position while in
// annotation mode. mousemove events still fire in the renderer when the
// overlay is click-through because we create it with
// setIgnoreMouseEvents(true, { forward: true }). We never flip during an
// active drag (drawing === true) so mid-drag mouse capture isn't disrupted.
function refreshAnnotationInteractivity(x: number, y: number): void {
  if (!annotationMode) return;
  if (drawing) return;
  const inside = isInsideRecordingRegion(x, y);
  void setInteractiveIfChanged(inside);
}

window.addEventListener('mousemove', (e) => {
  refreshAnnotationInteractivity(e.clientX, e.clientY);
});

// ─── undo / clear ────────────────────────────────────────────────────

function undoLastAnnotation(): void {
  const removed = annotations.pop();
  if (removed) nextNumber = removed.number;
  pushAnnotationSync();
  redraw();
}

function clearAllAnnotations(): void {
  annotations = [];
  pushAnnotationSync();
  redraw();
}

// ─── pointer drawing ─────────────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  if (!(annotationMode || regionSelectMode)) return;

  if (annotationMode && !isInsideRecordingRegion(e.clientX, e.clientY)) {
    window.snipalot.log('input', 'mousedown outside region', { x: e.clientX, y: e.clientY });
    return;
  }

  drawing = true;
  dragStart = { x: e.clientX, y: e.clientY };
  currentRect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  if (regionSelectMode) {
    confirmedRegion = null;
    regionConfirmEl.classList.add('region-hidden');
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (!drawing || !dragStart) return;
  let x = e.clientX;
  let y = e.clientY;
  if (annotationMode && recordingRegion) {
    const c = clampToRecordingRegion(x, y);
    x = c.x;
    y = c.y;
  }
  currentRect = {
    x: Math.min(dragStart.x, x),
    y: Math.min(dragStart.y, y),
    w: Math.abs(x - dragStart.x),
    h: Math.abs(y - dragStart.y),
  };
  redraw();
});

canvas.addEventListener('mouseup', () => {
  if (!drawing || !currentRect) return;
  drawing = false;
  const r = currentRect;

  if (regionSelectMode) {
    if (r.w > 8 && r.h > 8) {
      confirmedRegion = { ...r };
      showRegionConfirmPanel(r);
      window.snipalot.log('region', 'draft confirmed locally', r);
    }
    currentRect = null;
    dragStart = null;
    redraw();
    return;
  }

  if (annotationMode) {
    if (r.w > 4 && r.h > 4) {
      annotations.push({ number: nextNumber, ...r, drawnAtMs: nowDrawMs() });
      nextNumber += 1;
      pushAnnotationSync();
    }
    currentRect = null;
    dragStart = null;
    redraw();
  }
});

// ─── keyboard ────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (regionSelectMode) {
      window.snipalot.cancelRegion();
      return;
    }
    if (annotationMode) {
      exitAnnotationMode();
      return;
    }
  }

  if (regionSelectMode && e.key === 'Enter' && confirmedRegion) {
    e.preventDefault();
    const r = confirmedRegion;
    recordingRegion = { ...r };
    outlineVisible = true;
    ownsRecording = true; // local optimistic; main confirms via owns-recording event
    window.snipalot.confirmRegion(r);
    return;
  }

  if (annotationMode) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoLastAnnotation();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      clearAllAnnotations();
      return;
    }
  }
});

regionConfirmBtn.addEventListener('click', () => {
  if (!confirmedRegion) return;
  const r = confirmedRegion;
  recordingRegion = { ...r };
  outlineVisible = true;
  ownsRecording = true;
  window.snipalot.confirmRegion(r);
});
regionCancelBtn.addEventListener('click', () => {
  window.snipalot.cancelRegion();
});

// ─── IPC wiring ──────────────────────────────────────────────────────

window.snipalot.onEnterRegionSelect(() => {
  enterRegionSelectMode();
});

window.snipalot.onExitRegionSelect(() => {
  exitRegionSelectMode();
});

window.snipalot.onEnterAnnotationMode(() => {
  // Treat this as a toggle: if annotation mode is already on, exit; else enter.
  // That way the HUD button (and Ctrl+Shift+N) can be used to turn annotation
  // back off without relying on Esc + overlay focus.
  if (annotationMode) {
    void exitAnnotationMode();
  } else {
    void enterAnnotationMode();
  }
});

window.snipalot.onOwnsRecording((payload) => {
  // Main confirms this overlay is the one hosting the recording.
  ownsRecording = true;
  recordingRegion = { ...payload.rect };
  window.snipalot.log('owns-recording', payload);
  redraw();
});

window.snipalot.onRecordingStarted((payload) => {
  isRecording = true;
  recordingStartedAt = payload.startedAt;
  if (payload.activeDisplayId !== myDisplayId) {
    ownsRecording = false;
    recordingRegion = null;
  } else {
    ownsRecording = true;
    outlineVisible = true;
    // Seed main with an empty annotation list at session start.
    pushAnnotationSync();
  }
  window.snipalot.log('recording-started', payload);
  redraw();
});

window.snipalot.onRecordingStopped(() => {
  // Do a final sync BEFORE clearing, so main gets whatever was on screen at
  // stop time.
  if (ownsRecording) pushAnnotationSync();
  isRecording = false;
  recordingStartedAt = null;
  ownsRecording = false;
  recordingRegion = null;
  outlineVisible = true;
  annotations = [];
  nextNumber = 1;
  if (annotationMode) {
    void exitAnnotationMode();
  } else {
    redraw();
  }
  window.snipalot.log('recording-stopped');
});

window.snipalot.onGlobalUndo(() => {
  if (!annotationMode) return;
  undoLastAnnotation();
});

window.snipalot.onGlobalClear(() => {
  if (!annotationMode) return;
  clearAllAnnotations();
});

window.snipalot.onToggleOutline(() => {
  outlineVisible = !outlineVisible;
  redraw();
});

// ─── boot ────────────────────────────────────────────────────────────

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
