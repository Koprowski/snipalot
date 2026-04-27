/**
 * Snipalot annotation + region-select overlay.
 *
 * ONE instance per display. The display id is read from window.location.search
 * (set by main when this window is created). All coordinates here are
 * "display-local CSS pixels" — i.e. relative to the top-left of THIS display.
 *
 * Modes:
 *   - region-select: dim this display, let user drag a rect locally
 *   - annotation: draw numbered shapes (rect, circle, oval, line, arrow, text),
 *     STRICTLY inside recordingRegion; click an existing shape to move it, drag
 *     a handle to resize it
 *   - region outline: dashed box just OUTSIDE the recording region (drawn
 *     only by the overlay that owns the active recording)
 *
 * Snapshot chapters: main sends overlay:snapshot-reset on 📸; we flush the
 * current annotation list then zero it out and restart numbering at 1.
 *
 * Lifecycle: when recording stops, annotation mode exits + annotations clear.
 */

// ─── schema v2: discriminated shape union ────────────────────────────

type FeedbackType = 'bug' | 'improvement' | 'question' | 'praise';
/**
 * Drawable shape kinds plus a 'select' pseudo-mode that disables drawing.
 * In select mode, mousedown on empty canvas does nothing — only clicks on
 * existing annotations are honored. This gives the user a safe way to
 * pick/move/delete annotations without accidentally drawing a new one.
 */
type ShapeKind = 'rect' | 'circle' | 'oval' | 'line' | 'arrow' | 'text' | 'select';

interface BoundedAnnotation {
  id: string;
  shape: 'rect' | 'circle' | 'oval';
  number: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  strokeWidth: number;
  drawnAtMs: number;
  type?: FeedbackType;
  note?: string;
}

interface LineAnnotation {
  id: string;
  shape: 'line' | 'arrow';
  number: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
  drawnAtMs: number;
  type?: FeedbackType;
  note?: string;
}

interface TextAnnotation {
  id: string;
  shape: 'text';
  number: number;
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
  strokeWidth: number;
  drawnAtMs: number;
  type?: FeedbackType;
  note?: string;
}

type Annotation = BoundedAnnotation | LineAnnotation | TextAnnotation;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Bbox {
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
const shapePickerEl = document.getElementById('shape-picker')!;
const textInputEl = document.getElementById('text-input') as HTMLInputElement;

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
let recordingStartedAt: number | null = null;
let currentShape: ShapeKind = 'rect';
/**
 * True once the user has dragged the shape picker by its grip. While true,
 * positionShapePicker() short-circuits so we never yank it back to the
 * auto-computed position. Reset implicitly by overlay reload (per-recording).
 */
let pickerManuallyPositioned = false;

function nowDrawMs(): number {
  return recordingStartedAt ? Date.now() - recordingStartedAt : 0;
}

function genId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pushAnnotationSync(): void {
  if (!ownsRecording) return;
  // Send a plain-JSON copy so IPC doesn't choke on class instances or proxies.
  void window.snipalot.syncAnnotations({
    annotations: annotations.map((a) => JSON.parse(JSON.stringify(a))),
    recordingRegion,
  });
}

let dragStart: { x: number; y: number } | null = null;
let currentRect: Rect | null = null;
let currentLine: { x1: number; y1: number; x2: number; y2: number } | null = null;
let annotationMode = false;
let regionSelectMode = false;
/**
 * Last cursor position seen by ANY mousemove (forwarded mousemoves still
 * fire while the overlay is click-through). Used by enterAnnotationMode
 * to immediately decide interactive vs click-through + which cursor to
 * show, instead of waiting on the next mousemove. -1 means "never seen".
 */
let lastMouseX = -1;
let lastMouseY = -1;
let confirmedRegion: Rect | null = null;
let recordingRegion: Rect | null = null;
let outlineVisible = true;
let isRecording = false;
let ownsRecording = false;
let overlayInteractive = false;

// ─── selection / move / resize state ────────────────────────────────

type HandleId = 'tl' | 'tr' | 'bl' | 'br' | 'p1' | 'p2';
type DragMode = 'none' | 'draw' | 'move' | 'resize';

let selectedIndex: number | null = null;
let dragMode: DragMode = 'none';
let activeHandle: HandleId | null = null;
let dragStartAnn: Annotation | null = null;
let resizeAnchor: { x: number; y: number } | null = null;

const HANDLE_HIT = 8; // px radius for handle hit test

const STYLE = {
  annotationColor: '#EF4444',
  badgeColor: '#FFFFFF',
  strokeWidth: 3,
  fontSize: 16,
  textFontSize: 18,
  badgeRadius: 14,
  dimColor: 'rgba(0, 0, 0, 0.5)',
  regionStroke: '#EF4444',
  regionStrokeWidth: 2,
  outlineOutsideOffset: 4,
  handleSize: 8, // half-width of corner handle square
  handleColor: '#FFFFFF',
  handleBorderColor: '#EF4444',
  arrowHeadLen: 14,
  arrowHeadWidth: 10,
};

// ─── shape geometry helpers ─────────────────────────────────────────

/** Compute the bounding box for any annotation (used for badge placement + clamp). */
function bboxOf(a: Annotation): Bbox {
  if (a.shape === 'line' || a.shape === 'arrow') {
    const minX = Math.min(a.x1, a.x2);
    const minY = Math.min(a.y1, a.y2);
    return { x: minX, y: minY, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }
  if (a.shape === 'text') {
    // Approximate: measure the text width.
    ctx.save();
    ctx.font = `bold ${a.fontSize}px "Segoe UI", system-ui, sans-serif`;
    const w = Math.max(40, ctx.measureText(a.text || ' ').width + 12);
    ctx.restore();
    const h = a.fontSize + 12;
    return { x: a.x, y: a.y, w, h };
  }
  // Remaining: BoundedAnnotation (rect/circle/oval).
  const b = a as BoundedAnnotation;
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

/**
 * Badge center position for an annotation.
 *
 * Placed just below-and-left of the bbox's bottom-left corner so:
 *   - For lines/arrows pointing up-and-right, the badge stays attached
 *     to the visible shape instead of floating in the empty upper-left
 *     corner of the rectangular bounding box.
 *   - For rects, circles, ovals, and text, the badge sits outside the
 *     shape so it doesn't obscure the annotated content.
 *
 * The -6 / +6 offsets pull the badge clear of the shape's stroke while
 * keeping it visually associated with the shape.
 */
function badgePosOf(a: Annotation): { x: number; y: number } {
  const bb = bboxOf(a);
  return { x: bb.x - 6, y: bb.y + bb.h + 6 };
}

/** Get handle positions for a selected annotation. */
function getHandlePositions(a: Annotation): Array<{ id: HandleId; x: number; y: number }> {
  if (a.shape === 'line' || a.shape === 'arrow') {
    return [
      { id: 'p1', x: a.x1, y: a.y1 },
      { id: 'p2', x: a.x2, y: a.y2 },
    ];
  }
  if (a.shape === 'text') {
    // No resize handles on text — move only (body drag).
    return [];
  }
  const b = a as BoundedAnnotation;
  return [
    { id: 'tl', x: b.x, y: b.y },
    { id: 'tr', x: b.x + b.w, y: b.y },
    { id: 'bl', x: b.x, y: b.y + b.h },
    { id: 'br', x: b.x + b.w, y: b.y + b.h },
  ];
}

/** Returns handle id if (mx,my) is within HANDLE_HIT of any handle of a, else null. */
function hitHandle(mx: number, my: number, a: Annotation): HandleId | null {
  for (const h of getHandlePositions(a)) {
    if (Math.abs(mx - h.x) <= HANDLE_HIT && Math.abs(my - h.y) <= HANDLE_HIT) return h.id;
  }
  return null;
}

/** Distance from point (px,py) to segment (x1,y1)-(x2,y2). */
function distPointToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** Hit test: returns annotation index (topmost first) containing (mx,my), else null. */
function hitAnnotation(mx: number, my: number): number | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.shape === 'rect') {
      if (mx >= a.x && mx <= a.x + a.w && my >= a.y && my <= a.y + a.h) return i;
    } else if (a.shape === 'circle' || a.shape === 'oval') {
      // Ellipse equation: ((mx-cx)/rx)^2 + ((my-cy)/ry)^2 <= 1
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      const rx = Math.max(1, a.w / 2);
      const ry = Math.max(1, a.h / 2);
      const v = ((mx - cx) / rx) ** 2 + ((my - cy) / ry) ** 2;
      // Allow a small inner miss so clicks on the outline itself count.
      if (v <= 1.05) return i;
    } else if (a.shape === 'line' || a.shape === 'arrow') {
      if (distPointToSegment(mx, my, a.x1, a.y1, a.x2, a.y2) <= Math.max(6, a.strokeWidth + 2)) return i;
    } else if (a.shape === 'text') {
      const bb = bboxOf(a);
      if (mx >= bb.x && mx <= bb.x + bb.w && my >= bb.y && my <= bb.y + bb.h) return i;
    }
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

function renumberAnnotations(): void {
  for (let i = 0; i < annotations.length; i++) {
    annotations[i].number = i + 1;
  }
  nextNumber = annotations.length + 1;
}

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
    // Skip the annotation currently being edited via the floating text input
    // so the live <input> doesn't sit on top of a stale render of itself.
    if (i === editingTextIndex) continue;
    drawAnnotation(annotations[i], i === selectedIndex);
  }

  // Live-preview draw (new shape being created).
  if (dragMode === 'draw' && !regionSelectMode) {
    if ((currentShape === 'rect' || currentShape === 'circle' || currentShape === 'oval') && currentRect) {
      drawAnnotation(
        {
          id: 'preview',
          shape: currentShape,
          number: nextNumber,
          x: currentRect.x,
          y: currentRect.y,
          w: currentRect.w,
          h: currentRect.h,
          color: STYLE.annotationColor,
          strokeWidth: STYLE.strokeWidth,
          drawnAtMs: 0,
        } as BoundedAnnotation,
        false
      );
    } else if ((currentShape === 'line' || currentShape === 'arrow') && currentLine) {
      drawAnnotation(
        {
          id: 'preview',
          shape: currentShape,
          number: nextNumber,
          x1: currentLine.x1,
          y1: currentLine.y1,
          x2: currentLine.x2,
          y2: currentLine.y2,
          color: STYLE.annotationColor,
          strokeWidth: STYLE.strokeWidth,
          drawnAtMs: 0,
        } as LineAnnotation,
        false
      );
    }
  }
}

function drawAnnotation(a: Annotation, selected = false): void {
  ctx.save();
  ctx.strokeStyle = a.color || STYLE.annotationColor;
  ctx.fillStyle = a.color || STYLE.annotationColor;
  ctx.lineWidth = a.strokeWidth || STYLE.strokeWidth;

  if (a.shape === 'rect') {
    ctx.strokeRect(a.x, a.y, a.w, a.h);
  } else if (a.shape === 'circle' || a.shape === 'oval') {
    const cx = a.x + a.w / 2;
    const cy = a.y + a.h / 2;
    const rx = Math.max(1, a.w / 2);
    const ry = Math.max(1, a.h / 2);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (a.shape === 'line') {
    ctx.beginPath();
    ctx.moveTo(a.x1, a.y1);
    ctx.lineTo(a.x2, a.y2);
    ctx.stroke();
  } else if (a.shape === 'arrow') {
    drawArrow(a);
  } else if (a.shape === 'text') {
    drawText(a);
  }

  // Badge at the annotation's top-left.
  const badge = badgePosOf(a);
  ctx.fillStyle = a.color || STYLE.annotationColor;
  ctx.beginPath();
  ctx.arc(badge.x, badge.y, STYLE.badgeRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = STYLE.badgeColor;
  ctx.font = `bold ${STYLE.fontSize}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(a.number), badge.x, badge.y + 1);

  // Handles if selected.
  if (selected) {
    const hs = STYLE.handleSize;
    for (const h of getHandlePositions(a)) {
      ctx.fillStyle = STYLE.handleColor;
      ctx.fillRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
      ctx.strokeStyle = STYLE.handleBorderColor;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(h.x - hs, h.y - hs, hs * 2, hs * 2);
    }
  }

  ctx.restore();
}

function drawArrow(a: LineAnnotation): void {
  ctx.beginPath();
  ctx.moveTo(a.x1, a.y1);
  ctx.lineTo(a.x2, a.y2);
  ctx.stroke();

  // Arrow head at (x2,y2).
  const dx = a.x2 - a.x1;
  const dy = a.y2 - a.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = STYLE.arrowHeadLen;
  const headW = STYLE.arrowHeadWidth;
  const baseX = a.x2 - ux * headLen;
  const baseY = a.y2 - uy * headLen;
  const leftX = baseX + -uy * (headW / 2);
  const leftY = baseY + ux * (headW / 2);
  const rightX = baseX + uy * (headW / 2);
  const rightY = baseY + -ux * (headW / 2);
  ctx.beginPath();
  ctx.moveTo(a.x2, a.y2);
  ctx.lineTo(leftX, leftY);
  ctx.lineTo(rightX, rightY);
  ctx.closePath();
  ctx.fill();
}

function drawText(a: TextAnnotation): void {
  ctx.save();
  ctx.font = `bold ${a.fontSize}px "Segoe UI", system-ui, sans-serif`;
  const metrics = ctx.measureText(a.text || ' ');
  const w = Math.max(40, metrics.width + 12);
  const h = a.fontSize + 12;
  // White background box with red border so text reads against any backdrop.
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = a.color;
  ctx.lineWidth = a.strokeWidth;
  ctx.fillRect(a.x, a.y, w, h);
  ctx.strokeRect(a.x, a.y, w, h);
  ctx.fillStyle = a.color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(a.text || '', a.x + 6, a.y + h / 2);
  ctx.restore();
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

function clampBboxToRegion(bb: Bbox): Bbox {
  if (!recordingRegion) return bb;
  const rr = recordingRegion;
  const x = Math.max(rr.x, Math.min(rr.x + rr.w - bb.w, bb.x));
  const y = Math.max(rr.y, Math.min(rr.y + rr.h - bb.h, bb.y));
  return { x, y, w: bb.w, h: bb.h };
}

/** Translate any annotation by (dx, dy), clamped to recording region. */
function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  if (a.shape === 'line' || a.shape === 'arrow') {
    // Clamp based on bbox so both endpoints stay in-region.
    const bb = bboxOf(a);
    const clamped = clampBboxToRegion({ x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h });
    const actualDx = clamped.x - bb.x;
    const actualDy = clamped.y - bb.y;
    return { ...a, x1: a.x1 + actualDx, y1: a.y1 + actualDy, x2: a.x2 + actualDx, y2: a.y2 + actualDy };
  }
  if (a.shape === 'text') {
    const bb = bboxOf(a);
    const c = clampBboxToRegion({ x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h });
    return { ...a, x: c.x, y: c.y };
  }
  const b = a as BoundedAnnotation;
  const c = clampBboxToRegion({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
  return { ...b, x: c.x, y: c.y };
}

// ─── interactivity helper ─────────────────────────────────────────────

async function setInteractiveIfChanged(interactive: boolean): Promise<void> {
  if (interactive === overlayInteractive) return;
  overlayInteractive = interactive;
  await window.snipalot.setInteractive(interactive);
}

/**
 * Force the overlay back to click-through, bypassing the cache check.
 * Used on every exit-from-annotation and on recording-stopped so even if
 * `overlayInteractive` got out of sync (e.g. main and renderer disagree
 * after a focus race), the user is guaranteed to get clicks through to
 * the app underneath. The IPC is idempotent — calling it twice is safe.
 */
async function forceClickThrough(): Promise<void> {
  overlayInteractive = false;
  await window.snipalot.setInteractive(false);
}

// ─── mode transitions ────────────────────────────────────────────────

async function enterRegionSelectMode(): Promise<void> {
  if (regionSelectMode) return;
  if (annotationMode) await exitAnnotationMode();
  regionSelectMode = true;
  confirmedRegion = null;
  currentRect = null;
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
  shapePickerEl.classList.remove('region-hidden');
  positionShapePicker();
  // Decide interactive + cursor state RIGHT NOW based on the last known
  // cursor position, instead of waiting for the next mousemove. Without
  // this, a user who triggers annotation mode (hotkey or button) with the
  // mouse already parked over the recording region has to nudge the
  // mouse before the overlay starts capturing clicks — meaning their
  // first click on the spot they actually wanted to annotate just passes
  // through to the underlying app. (-1 means we've never seen a
  // mousemove, in which case fall back to the original "wait for move"
  // behaviour by starting click-through; the next forwarded mousemove
  // will flip it correctly.)
  if (lastMouseX >= 0 && lastMouseY >= 0) {
    const overPicker = isPointOverShapePicker(lastMouseX, lastMouseY);
    const inside = isInsideRecordingRegion(lastMouseX, lastMouseY) || overPicker;
    await setInteractiveIfChanged(inside);
    updateCursor(lastMouseX, lastMouseY);
  } else {
    await setInteractiveIfChanged(false);
  }
  await window.snipalot.focusWindow();
  // Tell main (and through it the HUD) that annotation mode is now on.
  // Lets the HUD ✎ button light up so the user has a visual cue that
  // toggling will turn it OFF.
  void window.snipalot.reportAnnotationMode(true);
  window.snipalot.log('mode', 'enter annotation', {
    cursor: lastMouseX >= 0 ? { x: lastMouseX, y: lastMouseY } : 'unknown',
  });
}

async function exitAnnotationMode(): Promise<void> {
  if (!annotationMode) return;
  annotationMode = false;
  dragMode = 'none';
  dragStart = null;
  currentRect = null;
  currentLine = null;
  deselect();
  hideTextInput();
  document.body.classList.remove('annotation-mode');
  overlayStatusEl.classList.add('status-hidden');
  shapePickerEl.classList.add('region-hidden');
  // Force-flip to click-through (bypass the cache). If main and renderer
  // disagree on the current ignore-mouse state, the user could otherwise
  // end up with a "stuck" interactive overlay that swallows their clicks
  // even though annotation mode is off.
  await forceClickThrough();
  // Tell main (and through it the HUD) that annotation mode is now off,
  // so the HUD ✎ button can drop its highlight.
  void window.snipalot.reportAnnotationMode(false);
  window.snipalot.log('mode', 'exit annotation');
  redraw();
}

// Dynamically flip interactivity based on cursor position.
function refreshAnnotationInteractivity(x: number, y: number): void {
  if (!annotationMode) return;
  if (dragMode !== 'none') return; // never flip during an active drag
  // Shape-picker area or text-input is also interactive even when outside region.
  const overPicker = isPointOverShapePicker(x, y);
  const overTextInput = textInputEl.style.display !== 'none'
    && isPointOverTextInput(x, y);
  const inside = isInsideRecordingRegion(x, y) || overPicker || overTextInput;
  void setInteractiveIfChanged(inside);
}

function isPointOverShapePicker(x: number, y: number): boolean {
  if (shapePickerEl.classList.contains('region-hidden')) return false;
  const r = shapePickerEl.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function isPointOverTextInput(x: number, y: number): boolean {
  const r = textInputEl.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

window.addEventListener('mousemove', (e) => {
  // Track cursor continuously (forwarded mousemoves fire even while
  // click-through is active) so enterAnnotationMode can decide interactive
  // state without waiting for a fresh move.
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  refreshAnnotationInteractivity(e.clientX, e.clientY);
});

// ─── undo / clear / reset ────────────────────────────────────────────

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
  nextNumber = 1;
  pushAnnotationSync();
  redraw();
  // After clearing (whether via the trash button or Ctrl+Shift+C),
  // also exit annotation mode so the user is returned to the underlying
  // app for normal mouse/keyboard interaction. The intent of "clear" is
  // "I'm done with this annotation pass" — staying in annotation mode
  // would mean the next click on the page is captured by the overlay
  // instead of going through to the app.
  if (annotationMode) void exitAnnotationMode();
}

/**
 * Flush current annotations to main as a chapter. Whether to also wipe
 * the on-screen annotations + reset numbering depends on the user's
 * "Snapshot behavior" setting, threaded down via `clearAfter`:
 *  - true  (default): clear on-screen + restart numbering at 1, so the
 *          next chapter starts fresh. Matches the historical behavior
 *          of the HUD 📸 button.
 *  - false (carry-over): keep annotations visible and continue numbering.
 *          The same shapes will appear in the NEXT chapter too. Useful
 *          when you're walking through one screen with persistent callouts
 *          and want each snapshot to retain them as context.
 */
function snapshotReset(clearAfter: boolean): Annotation[] {
  const chapter = annotations.map((a) => JSON.parse(JSON.stringify(a))) as Annotation[];
  if (clearAfter) {
    annotations = [];
    nextNumber = 1;
    deselect();
    hideTextInput();
    pushAnnotationSync();
    redraw();
  }
  // In carry-over mode we leave annotations + nextNumber alone; nothing
  // to redraw because nothing changed visually.
  return chapter;
}

// ─── cursor style ─────────────────────────────────────────────────────

function updateCursor(mx: number, my: number): void {
  if (!annotationMode || regionSelectMode) { canvas.style.cursor = ''; return; }
  if (dragMode === 'move') { canvas.style.cursor = 'grabbing'; return; }
  if (dragMode === 'resize') {
    canvas.style.cursor = resizeCursorFor(activeHandle);
    return;
  }
  if (selectedIndex !== null) {
    const h = hitHandle(mx, my, annotations[selectedIndex]);
    if (h) { canvas.style.cursor = resizeCursorFor(h); return; }
  }
  const idx = hitAnnotation(mx, my);
  if (idx !== null) { canvas.style.cursor = 'grab'; return; }
  canvas.style.cursor = 'crosshair';
}

function resizeCursorFor(h: HandleId | null): string {
  switch (h) {
    case 'tl': case 'br': return 'nwse-resize';
    case 'tr': case 'bl': return 'nesw-resize';
    case 'p1': case 'p2': return 'move';
    default: return 'se-resize';
  }
}

// ─── pointer drawing ─────────────────────────────────────────────────

canvas.addEventListener('mousemove', (e) => {
  const mx = e.clientX;
  const my = e.clientY;

  updateCursor(mx, my);

  if (dragMode === 'draw') {
    if (currentShape === 'rect' || currentShape === 'circle' || currentShape === 'oval') {
      let x = mx, y = my;
      if (recordingRegion) { const c = clampToRecordingRegion(x, y); x = c.x; y = c.y; }
      if (dragStart) {
        currentRect = {
          x: Math.min(dragStart.x, x),
          y: Math.min(dragStart.y, y),
          w: Math.abs(x - dragStart.x),
          h: Math.abs(y - dragStart.y),
        };
      }
    } else if (currentShape === 'line' || currentShape === 'arrow') {
      let x = mx, y = my;
      if (recordingRegion) { const c = clampToRecordingRegion(x, y); x = c.x; y = c.y; }
      if (dragStart) currentLine = { x1: dragStart.x, y1: dragStart.y, x2: x, y2: y };
    }
    redraw();
    return;
  }

  if (dragMode === 'move' && dragStartAnn && dragStart) {
    const dx = mx - dragStart.x;
    const dy = my - dragStart.y;
    if (selectedIndex !== null) {
      annotations[selectedIndex] = translateAnnotation(dragStartAnn, dx, dy);
    }
    redraw();
    return;
  }

  if (dragMode === 'resize' && dragStart && selectedIndex !== null && dragStartAnn) {
    const c = recordingRegion ? clampToRecordingRegion(mx, my) : { x: mx, y: my };
    const a = dragStartAnn;
    if (a.shape === 'rect' || a.shape === 'circle' || a.shape === 'oval') {
      if (!resizeAnchor) return;
      const ax = resizeAnchor.x, ay = resizeAnchor.y;
      const newBb: Bbox = {
        x: Math.min(ax, c.x),
        y: Math.min(ay, c.y),
        w: Math.max(4, Math.abs(c.x - ax)),
        h: Math.max(4, Math.abs(c.y - ay)),
      };
      annotations[selectedIndex] = { ...a, ...newBb };
    } else if (a.shape === 'line' || a.shape === 'arrow') {
      // Drag one endpoint, keep the other pinned.
      if (activeHandle === 'p1') {
        annotations[selectedIndex] = { ...a, x1: c.x, y1: c.y };
      } else if (activeHandle === 'p2') {
        annotations[selectedIndex] = { ...a, x2: c.x, y2: c.y };
      }
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
    dragStart = { x: mx, y: my };
    currentRect = { x: mx, y: my, w: 0, h: 0 };
    confirmedRegion = null;
    regionConfirmEl.classList.add('region-hidden');
    dragMode = 'draw';
    return;
  }

  // ── annotation path ──
  if (!isInsideRecordingRegion(mx, my)) return;

  // 1. Check handle on selected annotation first.
  if (selectedIndex !== null) {
    const h = hitHandle(mx, my, annotations[selectedIndex]);
    if (h) {
      const a = annotations[selectedIndex];
      dragMode = 'resize';
      activeHandle = h;
      dragStart = { x: mx, y: my };
      dragStartAnn = JSON.parse(JSON.stringify(a));
      if (a.shape === 'rect' || a.shape === 'circle' || a.shape === 'oval') {
        const opposite: Record<string, { x: number; y: number }> = {
          tl: { x: a.x + a.w, y: a.y + a.h },
          tr: { x: a.x, y: a.y + a.h },
          bl: { x: a.x + a.w, y: a.y },
          br: { x: a.x, y: a.y },
        };
        resizeAnchor = opposite[h];
      } else {
        resizeAnchor = null;
      }
      return;
    }
  }

  // 2. Click inside an existing annotation body → start move drag.
  const hit = hitAnnotation(mx, my);
  if (hit !== null) {
    selectedIndex = hit;
    dragMode = 'move';
    dragStart = { x: mx, y: my };
    dragStartAnn = JSON.parse(JSON.stringify(annotations[hit]));
    activeHandle = null;
    resizeAnchor = null;
    redraw();
    return;
  }

  // 3. Start a new draw (or text placement) — unless we're in 'select'
  //    mode, in which case mousedown on empty canvas is a no-op (just
  //    clears any current selection). This is the "select-only" mode the
  //    user asked for: a way to manipulate existing annotations without
  //    risking an accidental new draw.
  deselect();
  if (currentShape === 'select') {
    redraw();
    return;
  }
  if (currentShape === 'text') {
    startTextInput(mx, my);
    return;
  }
  dragMode = 'draw';
  dragStart = { x: mx, y: my };
  if (currentShape === 'rect' || currentShape === 'circle' || currentShape === 'oval') {
    currentRect = { x: mx, y: my, w: 0, h: 0 };
  } else {
    currentLine = { x1: mx, y1: my, x2: mx, y2: my };
  }
  redraw();
});

canvas.addEventListener('mouseup', (e) => {
  const mx = e.clientX;
  const my = e.clientY;

  if (regionSelectMode) {
    if (!currentRect) return;
    const r = currentRect;
    if (r.w > 8 && r.h > 8) {
      confirmedRegion = { ...r };
      showRegionConfirmPanel(r);
    }
    currentRect = null;
    dragStart = null;
    dragMode = 'none';
    redraw();
    return;
  }

  if (dragMode === 'draw') {
    if ((currentShape === 'rect' || currentShape === 'circle' || currentShape === 'oval') && currentRect) {
      const r = currentRect;
      if (r.w > 4 && r.h > 4) {
        const newAnn: BoundedAnnotation = {
          id: genId(),
          shape: currentShape,
          number: nextNumber,
          x: r.x, y: r.y, w: r.w, h: r.h,
          color: STYLE.annotationColor,
          strokeWidth: STYLE.strokeWidth,
          drawnAtMs: nowDrawMs(),
        };
        annotations.push(newAnn);
        selectedIndex = annotations.length - 1;
        nextNumber += 1;
        pushAnnotationSync();
      } else {
        deselect();
      }
    } else if ((currentShape === 'line' || currentShape === 'arrow') && currentLine) {
      const l = currentLine;
      if (Math.hypot(l.x2 - l.x1, l.y2 - l.y1) > 6) {
        const newAnn: LineAnnotation = {
          id: genId(),
          shape: currentShape,
          number: nextNumber,
          x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2,
          color: STYLE.annotationColor,
          strokeWidth: STYLE.strokeWidth,
          drawnAtMs: nowDrawMs(),
        };
        annotations.push(newAnn);
        selectedIndex = annotations.length - 1;
        nextNumber += 1;
        pushAnnotationSync();
      } else {
        deselect();
      }
    }
    currentRect = null;
    currentLine = null;
    dragStart = null;
    dragMode = 'none';
    redraw();
    return;
  }

  if (dragMode === 'move' || dragMode === 'resize') {
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

// Double-click a text annotation to re-edit its contents in place.
canvas.addEventListener('dblclick', (e) => {
  if (!annotationMode || regionSelectMode) return;
  if (!isInsideRecordingRegion(e.clientX, e.clientY)) return;

  // The sequence leading here is: mousedown → mouseup → click → mousedown →
  // mousemove (possibly, even a 1px jitter) → mouseup → click → dblclick.
  // The second mousedown set dragMode='move' with a deep-copy dragStartAnn,
  // and any jitter during the double-click translated the annotation. Revert
  // that pre-edit mutation so the text re-opens at its original position.
  if (dragMode === 'move' && dragStartAnn && selectedIndex !== null) {
    annotations[selectedIndex] = dragStartAnn;
  }
  dragMode = 'none';
  dragStart = null;
  dragStartAnn = null;
  resizeAnchor = null;
  activeHandle = null;

  // Walk top-down so the most recently drawn annotation wins on overlap.
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.shape !== 'text') continue;
    const bb = bboxOf(a);
    if (e.clientX >= bb.x && e.clientX <= bb.x + bb.w &&
        e.clientY >= bb.y && e.clientY <= bb.y + bb.h) {
      e.preventDefault();
      selectedIndex = i;
      startTextInput(a.x, a.y, { editingIndex: i, initialText: a.text });
      redraw();
      return;
    }
  }
});

// ─── text input ──────────────────────────────────────────────────────

let textInputAt: { x: number; y: number } | null = null;
/**
 * Index of the annotation we're re-editing (set by dblclick on an existing
 * text annotation). When non-null, commitTextInput updates that annotation
 * in-place instead of appending a new one, and redraw() skips rendering it
 * so the live input is the only thing the user sees at that position.
 */
let editingTextIndex: number | null = null;

function startTextInput(x: number, y: number, opts?: { editingIndex: number; initialText: string }): void {
  textInputAt = { x, y };
  textInputEl.style.left = `${x}px`;
  textInputEl.style.top = `${y}px`;
  textInputEl.style.display = 'block';
  textInputEl.value = opts?.initialText ?? '';
  editingTextIndex = opts?.editingIndex ?? null;
  setTimeout(() => {
    textInputEl.focus();
    textInputEl.select();
  }, 0);
}

function hideTextInput(): void {
  textInputEl.style.display = 'none';
  textInputAt = null;
  editingTextIndex = null;
}

function commitTextInput(): void {
  if (!textInputAt) return;
  const text = textInputEl.value.trim();
  if (editingTextIndex !== null) {
    // Editing an existing text annotation: update text in place.
    const existing = annotations[editingTextIndex];
    if (existing && existing.shape === 'text') {
      if (text) {
        annotations[editingTextIndex] = { ...existing, text };
      } else {
        // Empty text deletes the annotation and renumbers.
        annotations.splice(editingTextIndex, 1);
        renumberAnnotations();
        if (selectedIndex === editingTextIndex) deselect();
      }
      pushAnnotationSync();
    }
  } else if (text) {
    const newAnn: TextAnnotation = {
      id: genId(),
      shape: 'text',
      number: nextNumber,
      x: textInputAt.x,
      y: textInputAt.y,
      text,
      color: STYLE.annotationColor,
      fontSize: STYLE.textFontSize,
      strokeWidth: STYLE.strokeWidth,
      drawnAtMs: nowDrawMs(),
    };
    annotations.push(newAnn);
    selectedIndex = annotations.length - 1;
    nextNumber += 1;
    pushAnnotationSync();
  }
  hideTextInput();
  redraw();
}

textInputEl.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); commitTextInput(); }
  else if (e.key === 'Escape') { e.preventDefault(); hideTextInput(); }
});
textInputEl.addEventListener('blur', () => {
  // Commit on blur so clicking elsewhere finalizes the text.
  if (textInputEl.value.trim()) commitTextInput(); else hideTextInput();
});

// ─── shape picker ────────────────────────────────────────────────────

function setCurrentShape(s: ShapeKind): void {
  currentShape = s;
  for (const btn of Array.from(shapePickerEl.querySelectorAll('button'))) {
    btn.classList.toggle('active', btn.getAttribute('data-shape') === s);
  }
  hideTextInput();
}

function positionShapePicker(): void {
  if (!recordingRegion) return;
  // Once the user has dragged the picker manually, never auto-reposition
  // it — that would yank it back from where they put it and re-trigger
  // the same hidden-behind-RDP-chrome problem they were avoiding.
  if (pickerManuallyPositioned) return;
  const pickerH = 44;
  const margin = 8;
  // Center horizontally over the recording region, just below its bottom edge.
  const rect = recordingRegion;
  let top = rect.y + rect.h + margin;
  if (top + pickerH > window.innerHeight - 8) {
    top = Math.max(8, rect.y - pickerH - margin);
  }
  shapePickerEl.style.top = `${top}px`;
  // Horizontal center.
  const pickerW = shapePickerEl.getBoundingClientRect().width || 320;
  let left = rect.x + rect.w / 2 - pickerW / 2;
  if (left < 8) left = 8;
  if (left + pickerW > window.innerWidth - 8) left = window.innerWidth - pickerW - 8;
  shapePickerEl.style.left = `${left}px`;
}

shapePickerEl.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  // Clear-all (trash) button: distinct from the shape buttons because it's
  // an action, not a mode switch.
  if (target.closest('#btn-clear-all')) {
    clearAllAnnotations();
    return;
  }
  const btn = target.closest('button[data-shape]') as HTMLButtonElement | null;
  if (!btn) return;
  const s = btn.getAttribute('data-shape') as ShapeKind;
  setCurrentShape(s);
});

// ─── shape picker dragging ───────────────────────────────────────────
//
// The picker is auto-positioned (positionShapePicker) below or above the
// recording region, but on RDP/multi-display setups it can land behind
// remote desktop chrome and become unreachable. The grip lets the user
// drag it anywhere on the overlay. Once dragged, we switch to manual
// positioning and stop running positionShapePicker on resize/region change.
// (`pickerManuallyPositioned` is declared with the other module state
// near the top of this file to avoid a TDZ if positionShapePicker fires
// before this section is reached.)
let pickerDragOffset: { dx: number; dy: number } | null = null;

const pickerGripEl = document.getElementById('shape-picker-grip')!;

pickerGripEl.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const rect = shapePickerEl.getBoundingClientRect();
  pickerDragOffset = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  pickerManuallyPositioned = true;
  document.body.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', (e) => {
  if (!pickerDragOffset) return;
  const left = Math.max(8, Math.min(window.innerWidth - 60, e.clientX - pickerDragOffset.dx));
  const top = Math.max(8, Math.min(window.innerHeight - 40, e.clientY - pickerDragOffset.dy));
  shapePickerEl.style.left = `${left}px`;
  shapePickerEl.style.top = `${top}px`;
});

window.addEventListener('mouseup', () => {
  if (pickerDragOffset) {
    pickerDragOffset = null;
    document.body.style.cursor = '';
  }
});

// ─── keyboard ────────────────────────────────────────────────────────

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (regionSelectMode) { window.snipalot.cancelRegion(); return; }
    if (annotationMode) {
      if (textInputEl.style.display !== 'none') { hideTextInput(); return; }
      if (selectedIndex !== null) { deselect(); redraw(); return; }
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
    // Shape-picker shortcuts: 1..6 select shape.
    if (['1','2','3','4','5','6'].includes(e.key)) {
      const shapes: ShapeKind[] = ['rect','circle','oval','line','arrow','text'];
      setCurrentShape(shapes[parseInt(e.key, 10) - 1]);
      e.preventDefault();
      return;
    }
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIndex !== null) {
      e.preventDefault();
      annotations.splice(selectedIndex, 1);
      renumberAnnotations();
      deselect();
      pushAnnotationSync();
      redraw();
      return;
    }
    if (selectedIndex !== null && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const nudge = {
        ArrowUp:    { x: 0, y: -step },
        ArrowDown:  { x: 0, y: step },
        ArrowLeft:  { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
      }[e.key]!;
      const a = annotations[selectedIndex];
      annotations[selectedIndex] = translateAnnotation(a, nudge.x, nudge.y);
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
  positionShapePicker();
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
  // Belt-and-suspenders: even if annotation mode wasn't on (so
  // exitAnnotationMode wouldn't have fired its forceClickThrough),
  // guarantee the overlay drops to click-through after a recording
  // ends. Otherwise a stale interactive flag from a focus race could
  // leave the (now-empty) overlay swallowing app clicks.
  void forceClickThrough();
  window.snipalot.log('recording-stopped');
});

window.snipalot.onGlobalUndo(() => { if (annotationMode) undoLastAnnotation(); });
window.snipalot.onGlobalClear(() => { if (annotationMode) clearAllAnnotations(); });

window.snipalot.onToggleOutline(() => {
  outlineVisible = !outlineVisible;
  redraw();
});

// Snapshot reset: flush current chapter's annotations to main. The
// `clearAnnotations` flag is the user's "Snapshot behavior" setting —
// true wipes the canvas for a fresh chapter, false keeps everything
// visible so the same callouts apply to the next chapter too.
window.snipalot.onSnapshotReset(({ clearAnnotations }) => {
  if (!ownsRecording) return;
  const chapter = snapshotReset(clearAnnotations);
  void window.snipalot.reportSnapshotChapter({ annotations: chapter, capturedAtMs: nowDrawMs() });
  window.snipalot.log('snapshot', 'chapter flushed', { count: chapter.length, clearAnnotations });
});

// ─── boot ────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
  resizeCanvas();
  positionShapePicker();
});
setCurrentShape('rect');
resizeCanvas();
