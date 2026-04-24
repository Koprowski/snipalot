/**
 * Snipalot annotation + region-select overlay.
 *
 * ONE instance per display. The display id is read from window.location.search
 * (set by main when this window is created). All coordinates here are
 * "display-local CSS pixels" — i.e. relative to the top-left of THIS display.
 *
 * Modes:
 *   - region-select: dim this display, let user drag a rect locally
 *   - annotation: draw numbered rectangles, STRICTLY inside recordingRegion;
 *     click an existing rect to move it, drag a corner handle to resize it
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
const overlayStatusEl = document.getElementById('status')!;
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
let recordingRegion: Rect | null = null;
let outlineVisible = true;
let isRecording = false;
let ownsRecording = false;
let overlayInteractive = false;

// ─── selection / move / resize state ────────────────────────────────

type HandleId = 'tl' | 'tr' | 'bl' | 'br';
type DragMode = 'none' | 'draw' | 'move' | 'resize';

let selectedIndex: number | null = null;
let dragMode: DragMode = 'none';
let activeHandle: HandleId | null = null;
// The annotation snapshot at drag start (for applying deltas cleanly).
let dragStartAnn: Annotation | null = null;
// The anchor corner (opposite to the dragged handle) used for resize.
let resizeAnchor: { x: number; y: number } | null = null;

const HANDLE_HIT = 8; // px radius for corner handle hit test

function getHandlePos(a: Annotation): Record<HandleId, { x: number; y: number }> {
  return {
    tl: { x: a.x,       y: a.y },
    tr: { x: a.x + a.w, y: a.y },
    bl: { x: a.x,       y: a.y + a.h },
    br: { x: a.x + a.w, y: a.y + a.h },
  };
}

/** Returns the HandleId if (mx, my) is within HANDLE_HIT of any corner of a. */
function hitHandle(mx: number, my: number, a: Annotation): HandleId | null {
  const handles = getHandlePos(a);
  for (const [id, pos] of Object.entries(handles) as [HandleId, { x: number; y: number }][]) {
    if (Math.abs(mx - pos.x) <= HANDLE_HIT && Math.abs(my - pos.y) <= HANDLE_HIT) return id;
  }
  return null;
}

/** Returns annotation index (topmost first) if (mx, my) is inside its rect. */
function hitAnnotation(mx: number, my: number): number | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (mx >= a.x && mx <= a.x + a.w && my >= a.y && my <= a.y + a.h) return i;
  }
  return null;
}

function deselect(): void {
  selectedIndex = null;
  dragMode = 'none';
  activeHandle = null;
  dragStartAnn = null;
  resizeAnchor = null;
}

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
  handleSize: 8,    // half-width of corner handle square
  handleColor: '#FFFFFF',
  handleBorderColor: '#EF4444',
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

  for (let i = 0; i < annotations.length; i++) {
    drawAnnotation(annotations[i], i === selectedIndex);
  }

  // Draw the live preview rect (new draw or active drag of existing).
  if (dragMode === 'draw' && currentRect && !regionSelectMode) {
    drawAnnotation({
      number: nextNumber,
      x: currentRect.x,
      y: currentRect.y,
      w: currentRect.w,
      h: currentRect.h,
      drawnAtMs: 0,
    }, false);
  }
}

function drawAnnotation(a: Annotation, selected = false): void {
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

  // Corner handles when selected.
  if (selected) {
    const hs = STYLE.handleSize;
    const handles = getHandlePos(a);
    for (const pos of Object.values(handles)) {
      // White fill, red border.
      ctx.fillStyle = STYLE.handleColor;
      ctx.fillRect(pos.x - hs, pos.y - hs, hs * 2, hs * 2);
      ctx.strokeStyle = STYLE.handleBorderColor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(pos.x - hs, pos.y - hs, hs * 2, hs * 2);
    }
  }
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

function clampRectToRegion(r: Rect): Rect {
  if (!recordingRegion) return r;
  const rr = recordingRegion;
  const x = Math.max(rr.x, Math.min(rr.x + rr.w - r.w, r.x));
  const y = Math.max(rr.y, Math.min(rr.y + rr.h - r.h, r.y));
  return { x, y, w: r.w, h: r.h };
}

// ─── interactivity helper ─────────────────────────────────────────────

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
      isRecording, ownsRecording, hasRegion: !!recordingRegion,
    });
    return;
  }
  if (annotationMode) return;
  annotationMode = true;
  document.body.classList.add('annotation-mode');
  overlayStatusEl.classList.remove('status-hidden');
  await setInteractiveIfChanged(false);
  await window.snipalot.focusWindow();
  window.snipalot.log('mode', 'enter annotation');
}

async function exitAnnotationMode(): Promise<void> {
  if (!annotationMode) return;
  annotationMode = false;
  drawing = false;
  dragMode = 'none';
  dragStart = null;
  currentRect = null;
  deselect();
  document.body.classList.remove('annotation-mode');
  overlayStatusEl.classList.add('status-hidden');
  await setInteractiveIfChanged(false);
  window.snipalot.log('mode', 'exit annotation');
  redraw();
}

// Dynamically flip interactivity based on cursor position.
function refreshAnnotationInteractivity(x: number, y: number): void {
  if (!annotationMode) return;
  if (dragMode !== 'none') return; // never flip during an active drag
  const inside = isInsideRecordingRegion(x, y);
  void setInteractiveIfChanged(inside);
}

window.addEventListener('mousemove', (e) => {
  refreshAnnotationInteractivity(e.clientX, e.clientY);
});

// ─── undo / clear ────────────────────────────────────────────────────

function undoLastAnnotation(): void {
  if (selectedIndex !== null) deselect();
  const removed = annotations.pop();
  if (removed) nextNumber = removed.number;
  pushAnnotationSync();
  redraw();
}

function clearAllAnnotations(): void {
  deselect();
  annotations = [];
  pushAnnotationSync();
  redraw();
}

// ─── cursor style ─────────────────────────────────────────────────────

/** Update canvas cursor to give move/resize affordance. */
function updateCursor(mx: number, my: number): void {
  if (!annotationMode || regionSelectMode) { canvas.style.cursor = ''; return; }
  if (dragMode === 'move') { canvas.style.cursor = 'grabbing'; return; }
  if (dragMode === 'resize') {
    const cursors: Record<HandleId, string> = { tl: 'nw-resize', tr: 'ne-resize', bl: 'sw-resize', br: 'se-resize' };
    canvas.style.cursor = activeHandle ? cursors[activeHandle] : 'se-resize';
    return;
  }
  // Hover feedback.
  if (selectedIndex !== null) {
    const h = hitHandle(mx, my, annotations[selectedIndex]);
    if (h) {
      const cursors: Record<HandleId, string> = { tl: 'nw-resize', tr: 'ne-resize', bl: 'sw-resize', br: 'se-resize' };
      canvas.style.cursor = cursors[h];
      return;
    }
  }
  const idx = hitAnnotation(mx, my);
  if (idx !== null) { canvas.style.cursor = 'grab'; return; }
  canvas.style.cursor = 'crosshair';
}

// ─── pointer drawing ─────────────────────────────────────────────────

canvas.addEventListener('mousemove', (e) => {
  const mx = e.clientX;
  const my = e.clientY;

  updateCursor(mx, my);

  if (dragMode === 'draw') {
    let x = mx;
    let y = my;
    if (recordingRegion) { const c = clampToRecordingRegion(x, y); x = c.x; y = c.y; }
    if (dragStart) {
      currentRect = {
        x: Math.min(dragStart.x, x),
        y: Math.min(dragStart.y, y),
        w: Math.abs(x - dragStart.x),
        h: Math.abs(y - dragStart.y),
      };
    }
    redraw();
    return;
  }

  if (dragMode === 'move' && dragStartAnn && dragStart) {
    const dx = mx - dragStart.x;
    const dy = my - dragStart.y;
    const moved = clampRectToRegion({
      x: dragStartAnn.x + dx,
      y: dragStartAnn.y + dy,
      w: dragStartAnn.w,
      h: dragStartAnn.h,
    });
    if (selectedIndex !== null) {
      annotations[selectedIndex] = { ...annotations[selectedIndex], ...moved };
    }
    redraw();
    return;
  }

  if (dragMode === 'resize' && resizeAnchor && dragStart) {
    // Clamp mouse to recording region.
    const c = recordingRegion ? clampToRecordingRegion(mx, my) : { x: mx, y: my };
    const ax = resizeAnchor.x;
    const ay = resizeAnchor.y;
    const newRect: Rect = {
      x: Math.min(ax, c.x),
      y: Math.min(ay, c.y),
      w: Math.max(4, Math.abs(c.x - ax)),
      h: Math.max(4, Math.abs(c.y - ay)),
    };
    if (selectedIndex !== null) {
      annotations[selectedIndex] = { ...annotations[selectedIndex], ...newRect };
    }
    redraw();
    return;
  }
});

canvas.addEventListener('mousedown', (e) => {
  if (!(annotationMode || regionSelectMode)) return;

  const mx = e.clientX;
  const my = e.clientY;

  // ── region-select path ──
  if (regionSelectMode) {
    drawing = true;
    dragStart = { x: mx, y: my };
    currentRect = { x: mx, y: my, w: 0, h: 0 };
    confirmedRegion = null;
    regionConfirmEl.classList.add('region-hidden');
    return;
  }

  // ── annotation path ──
  if (!isInsideRecordingRegion(mx, my)) return;

  // 1. Check handles on selected annotation first.
  if (selectedIndex !== null) {
    const h = hitHandle(mx, my, annotations[selectedIndex]);
    if (h) {
      // Resize drag: anchor = opposite corner.
      const a = annotations[selectedIndex];
      const opposite: Record<HandleId, HandleId> = { tl: 'br', tr: 'bl', bl: 'tr', br: 'tl' };
      const anchorPos = getHandlePos(a)[opposite[h]];
      dragMode = 'resize';
      activeHandle = h;
      resizeAnchor = anchorPos;
      dragStart = { x: mx, y: my };
      dragStartAnn = { ...a };
      return;
    }
  }

  // 2. Check if click lands inside any existing annotation body.
  const hit = hitAnnotation(mx, my);
  if (hit !== null) {
    // Move drag.
    selectedIndex = hit;
    dragMode = 'move';
    dragStart = { x: mx, y: my };
    dragStartAnn = { ...annotations[hit] };
    activeHandle = null;
    resizeAnchor = null;
    redraw();
    return;
  }

  // 3. No hit — start a new draw and deselect.
  deselect();
  dragMode = 'draw';
  dragStart = { x: mx, y: my };
  currentRect = { x: mx, y: my, w: 0, h: 0 };
  redraw();
});

canvas.addEventListener('mouseup', (e) => {
  const mx = e.clientX;
  const my = e.clientY;

  if (regionSelectMode) {
    if (!currentRect) return;
    const r = currentRect;
    drawing = false;
    if (r.w > 8 && r.h > 8) {
      confirmedRegion = { ...r };
      showRegionConfirmPanel(r);
    }
    currentRect = null;
    dragStart = null;
    redraw();
    return;
  }

  if (dragMode === 'draw') {
    const r = currentRect;
    if (r && r.w > 4 && r.h > 4) {
      const newAnn: Annotation = { number: nextNumber, ...r, drawnAtMs: nowDrawMs() };
      annotations.push(newAnn);
      selectedIndex = annotations.length - 1;
      nextNumber += 1;
      pushAnnotationSync();
    } else {
      deselect();
    }
    currentRect = null;
    dragStart = null;
    dragMode = 'none';
    redraw();
    return;
  }

  if (dragMode === 'move' || dragMode === 'resize') {
    // Commit the in-place edit already applied during mousemove.
    dragMode = 'none';
    dragStart = null;
    dragStartAnn = null;
    resizeAnchor = null;
    activeHandle = null;
    pushAnnotationSync();
    updateCursor(mx, my);
    redraw();
    return;
  }
});

// Clicking outside the recording region deselects.
canvas.addEventListener('click', (e) => {
  if (!annotationMode || regionSelectMode) return;
  if (!isInsideRecordingRegion(e.clientX, e.clientY)) {
    if (selectedIndex !== null) { deselect(); redraw(); }
  }
});

// ─── keyboard ────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (regionSelectMode) { window.snipalot.cancelRegion(); return; }
    if (annotationMode) {
      if (selectedIndex !== null) {
        // First Esc: deselect. Second Esc: exit annotation mode.
        deselect(); redraw(); return;
      }
      exitAnnotationMode();
      return;
    }
  }

  if (regionSelectMode && e.key === 'Enter' && confirmedRegion) {
    e.preventDefault();
    const r = confirmedRegion;
    recordingRegion = { ...r };
    outlineVisible = true;
    ownsRecording = true;
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
    // Delete / Backspace removes selected annotation.
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIndex !== null) {
      e.preventDefault();
      annotations.splice(selectedIndex, 1);
      // Renumber from the removed point to keep badges sequential.
      for (let i = selectedIndex; i < annotations.length; i++) {
        annotations[i].number = i + 1;
      }
      nextNumber = annotations.length + 1;
      deselect();
      pushAnnotationSync();
      redraw();
      return;
    }
    // Arrow keys nudge selected annotation.
    if (selectedIndex !== null && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const a = annotations[selectedIndex];
      const nudge = {
        ArrowUp:    { x: 0, y: -step },
        ArrowDown:  { x: 0, y: step },
        ArrowLeft:  { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
      }[e.key]!;
      annotations[selectedIndex] = { ...a, ...clampRectToRegion({ ...a, x: a.x + nudge.x, y: a.y + nudge.y }) };
      pushAnnotationSync();
      redraw();
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

window.snipalot.onEnterRegionSelect(() => { enterRegionSelectMode(); });
window.snipalot.onExitRegionSelect(() => { exitRegionSelectMode(); });

window.snipalot.onEnterAnnotationMode(() => {
  if (annotationMode) { void exitAnnotationMode(); } else { void enterAnnotationMode(); }
});

window.snipalot.onOwnsRecording((payload) => {
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
    pushAnnotationSync();
  }
  window.snipalot.log('recording-started', payload);
  redraw();
});

window.snipalot.onRecordingStopped(() => {
  if (ownsRecording) pushAnnotationSync();
  isRecording = false;
  recordingStartedAt = null;
  ownsRecording = false;
  recordingRegion = null;
  outlineVisible = true;
  annotations = [];
  nextNumber = 1;
  deselect();
  if (annotationMode) { void exitAnnotationMode(); } else { redraw(); }
  window.snipalot.log('recording-stopped');
});

window.snipalot.onGlobalUndo(() => { if (annotationMode) undoLastAnnotation(); });
window.snipalot.onGlobalClear(() => { if (annotationMode) clearAllAnnotations(); });

window.snipalot.onToggleOutline(() => {
  outlineVisible = !outlineVisible;
  redraw();
});

// ─── boot ────────────────────────────────────────────────────────────

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
