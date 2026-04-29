// @ts-nocheck
/**
 * Snipalot annotator.
 *
 * Direct port of github.com/Koprowski/screenshot-annotator. Milestone 1
 * keeps it BYTE-FOR-BYTE compatible with the standalone tool — same
 * shape, hit-testing, prompt logic, save/load. ts-nocheck because the
 * source is non-strict JS; later milestones will strip File System
 * Access API + replace paste-on-load with an IPC handoff and we can
 * typify gradually then.
 */

// IIFE wrap so the annotator port keeps its 50+ top-level globals out of
// the shared script-scope of the Snipalot TS project (overlay.ts already
// declares some of the same names — annotations, dragStart). Inline
// onclick="setTool(...)" handlers in annotator.html require these
// functions on `window`, so the bottom of this IIFE bridges the needed
// names back. When milestone 2+ refactors away from inline handlers we
// can drop the bridge.
(() => {

  // ── STATE ──────────────────────────────────────────────────────────────────
  let image = null;
  let annotations = []; // { id, x, y, w, h, color, opacity, note, type, isArrow, x2, y2 }
  let nextId = 1;
  let selectedId = null;

  // Overlay images
  let overlays = []; // { id, el, imgObj, src, x, y, w, h }
  let nextOverlayId = 1;
  let selectedOverlayId = null;
  let _ovDrag = null;   // { id, startX, startY, origX, origY }
  let _ovResize = null; // { id, handle, startX, startY, origX, origY, origW, origH }
  let _cropState = null; // { ovId, uiEl, actionsEl, cropX, cropY, cropW, cropH, dragging, handle, startX, startY, origCropX, origCropY, origCropW, origCropH }

  // Undo / Redo history
  const MAX_HISTORY = 60;
  let _history = [];
  let _histIdx = -1;

  let tool = 'rect'; // 'rect' | 'shape-rect' | 'shape-circle' | 'shape-oval' | 'shape-line' | 'shape-arrow' | 'doodle' | 'text' | 'select'
  let currentColor = '#ef4444';
  let currentOpacity = 0;      // 0 = no fill by default
  let currentStrokeWidth = 2;

  const SHAPE_TOOLS = ['shape-rect','shape-circle','shape-oval','shape-line','shape-arrow'];
  const isShapeTool = () => SHAPE_TOOLS.includes(tool);
  const isLinearTool = () => tool === 'shape-line' || tool === 'shape-arrow';

  let isDrawing = false;
  let dragStart = null;
  let previewRect = null;

  // Doodle state
  let doodlePoints = []; // array of {x, y} collected while drawing

  // Select-mode interaction state
  let isDragging = false;
  let dragOffset = null;       // { dx, dy } offset from mouse to annotation origin
  let isResizing = false;
  let resizeHandle = null;     // { index 0-7 for box shapes, 'start'/'end' for linear }
  let resizeOrigin = null;     // snapshot of annotation at resize start

  const HANDLE_R = 6; // hit radius for resize handles

  const baseCanvas = document.getElementById('base-canvas');
  const drawCanvas = document.getElementById('draw-canvas');
  const interLayer = document.getElementById('interaction-layer');
  const bCtx = baseCanvas.getContext('2d');
  const dCtx = drawCanvas.getContext('2d');

  // ── CANVAS SIZING ──────────────────────────────────────────────────────────
  function resizeCanvases(w, h) {
    [baseCanvas, drawCanvas, interLayer].forEach(c => {
      c.width = w;
      c.height = h;
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    });
    interLayer.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  }

  // ── INITIAL IMAGE FROM HOST ────────────────────────────────────────────────
  // Snipalot can pre-load an image when the annotator window opens (e.g. via
  // the region-select capture flow). The IPC returns null when the window is
  // opened standalone (dev preview from the tray), and we fall back to the
  // existing paste-on-Ctrl+V behavior in that case.
  // The session stamp is held in module scope so saveSession() can pass it
  // back to main, ensuring the saved folder name matches the capture moment
  // rather than the click-Save moment.
  let hostSessionStamp = null;
  if (window.snipalotAnnotator?.getInitialImage) {
    window.snipalotAnnotator.getInitialImage().then((img) => {
      if (!img) return;
      hostSessionStamp = img.sessionStamp;
      void window.snipalotAnnotator.log('init', 'preloaded image from host', {
        bytes: img.dataUrl.length,
        sessionStamp: img.sessionStamp,
      });
      // Convert the data URL into a Blob and feed the existing loader.
      fetch(img.dataUrl).then((r) => r.blob()).then(loadImageBlob);
    }).catch((err) => {
      console.warn('getInitialImage failed; staying on drop zone', err);
    });
  }

  // ── PASTE IMAGE ────────────────────────────────────────────────────────────
  document.addEventListener('paste', handlePaste);
  function triggerPaste() {
    navigator.clipboard.read().then(items => {
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            item.getType(type).then(blob => loadImageBlob(blob));
            return;
          }
        }
      }
    }).catch(() => {
      alert('No image in clipboard. Take a screenshot first, then press Ctrl+V or use the Paste button.');
    });
  }

  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        loadImageBlob(blob);
        break;
      }
    }
  }

  let displayScale = 1; // scale applied when image is drawn

  function loadImageBlob(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      image = img;

      // Compute scale to fit within the visible canvas-area (minus padding)
      const area = document.getElementById('canvas-area');
      const availW = area.clientWidth  - 48; // 24px padding each side
      const availH = area.clientHeight - 48;
      displayScale = Math.min(1, availW / img.width, availH / img.height);

      const drawW = Math.round(img.width  * displayScale);
      const drawH = Math.round(img.height * displayScale);

      resizeCanvases(drawW, drawH);
      document.getElementById('drop-zone').style.display = 'none';
      document.getElementById('canvas-wrap').style.display = 'inline-block';

      // Show scale indicator if image was shrunk
      const scaleEl = document.getElementById('scale-indicator');
      if (displayScale < 1) {
        scaleEl.textContent = `${Math.round(displayScale * 100)}% — original ${img.width}×${img.height}`;
        scaleEl.style.display = 'inline';
      } else {
        scaleEl.style.display = 'none';
      }

      renderBase();
      renderAnnotations();
      updatePrompt();
    };
    img.src = url;
  }

  function renderBase() {
    if (!image) return;
    bCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
    bCtx.drawImage(image, 0, 0, baseCanvas.width, baseCanvas.height);
  }

  // ── ROTATE BASE IMAGE 90° (left or right) ─────────────────────────────────
  //
  // Rotates the base image AND any existing annotations as a unit so the
  // user can fix sideways screenshots without losing annotation work. The
  // image is replaced with a new in-memory copy at the rotated orientation;
  // annotation coordinates are transformed via the standard 90° rotation:
  //   CW (right): (x, y) → (oldH - y, x)        — width/height swap
  //   CCW (left): (x, y) → (y, oldW - x)        — width/height swap
  // Same transform applies whether we use canvas dims or image dims, since
  // both scale by the same displayScale factor — so we use the canvas dims
  // (which match the annotation coordinate space directly).
  function rotateImage(direction) {
    if (!image) return;
    if (!direction || (direction !== 'left' && direction !== 'right')) return;

    const oldW = baseCanvas.width;
    const oldH = baseCanvas.height;

    // Step 1: produce a new Image containing the rotated pixels. Render
    // to a fresh offscreen canvas at the ORIGINAL (un-display-scaled)
    // image resolution so we don't lose detail through the rotation.
    const off = document.createElement('canvas');
    off.width = image.height;
    off.height = image.width;
    const oCtx = off.getContext('2d');
    if (!oCtx) return;
    oCtx.save();
    if (direction === 'right') {
      // Translate to where the new top-left should be after rotation
      oCtx.translate(image.height, 0);
      oCtx.rotate(Math.PI / 2);
    } else {
      oCtx.translate(0, image.width);
      oCtx.rotate(-Math.PI / 2);
    }
    oCtx.drawImage(image, 0, 0);
    oCtx.restore();

    const rotated = new Image();
    rotated.onload = () => {
      image = rotated;

      // Step 2: resize canvases — the displayed dims swap.
      resizeCanvases(oldH, oldW);

      // Step 3: transform every annotation's coordinates so they land on
      // the same image content they were drawn over, just at the new
      // orientation. Each shape kind has its own field set.
      annotations = annotations.map((ann) => transformAnnotationOnRotate(ann, direction, oldW, oldH));

      // Step 4: re-render base + annotations at new dims.
      renderBase();
      renderAnnotations();
      updatePrompt();
    };
    rotated.src = off.toDataURL('image/png');
  }

  /** Apply a 90° rotation transform to a single annotation in-place. */
  function transformAnnotationOnRotate(ann, direction, oldW, oldH) {
    // Helper: rotate a point (x, y) in OLD coords to NEW coords.
    const rot = (x, y) =>
      direction === 'right'
        ? { x: oldH - y, y: x }
        : { x: y, y: oldW - x };

    const shape = ann.shape || (ann.isArrow ? 'arrow' : 'rect');

    if (shape === 'rect' || shape === 'circle' || shape === 'oval' || shape === 'highlight' || shape === 'shape-rect' || shape === 'shape-circle' || shape === 'shape-oval') {
      // Bounding-box shapes. Rotate the (x, y) corner that has the
      // smallest x and smallest y in the NEW coordinate system. Width
      // and height swap.
      // Old corners: (x, y) [top-left] and (x+w, y+h) [bottom-right].
      // After CW rotation, the OLD bottom-left (x, y+h) becomes the
      // NEW top-left. After CCW rotation, the OLD top-right (x+w, y)
      // becomes the NEW top-left.
      const newTopLeft = direction === 'right'
        ? rot(ann.x, ann.y + (ann.h || 0))
        : rot(ann.x + (ann.w || 0), ann.y);
      return {
        ...ann,
        x: newTopLeft.x,
        y: newTopLeft.y,
        w: ann.h || 0,
        h: ann.w || 0,
      };
    }

    if (shape === 'line' || shape === 'arrow' || shape === 'shape-line' || shape === 'shape-arrow' || ann.isArrow) {
      // Two-point shapes. Just rotate both endpoints.
      const p1 = rot(ann.x1 ?? ann.x, ann.y1 ?? ann.y);
      const p2 = rot(
        ann.x2 ?? (ann.x + (ann.w || 0)),
        ann.y2 ?? (ann.y + (ann.h || 0))
      );
      return { ...ann, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }

    if (shape === 'text') {
      // Text annotations have a single anchor point. The text itself
      // stays horizontal — we just move the anchor.
      const p = rot(ann.x, ann.y);
      return { ...ann, x: p.x, y: p.y };
    }

    // Doodle (free draw): array of points.
    if (shape === 'doodle' && Array.isArray(ann.points)) {
      const newPoints = ann.points.map((pt) => rot(pt.x, pt.y));
      return { ...ann, points: newPoints };
    }

    // Unknown shape — best-effort rotate the (x, y) origin and swap any
    // present w/h. Won't be perfect but won't crash either.
    if (typeof ann.x === 'number' && typeof ann.y === 'number') {
      const p = rot(ann.x, ann.y);
      return {
        ...ann,
        x: p.x,
        y: p.y,
        w: ann.h ?? ann.w,
        h: ann.w ?? ann.h,
      };
    }
    return ann;
  }

  // ── DRAW ANNOTATIONS ──────────────────────────────────────────────────────
  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function renderAnnotations() {
    dCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

    annotations.forEach((ann, i) => {
      const isSelected = ann.id === selectedId;
      dCtx.save();
      drawAnnotation(dCtx, ann, i + 1, isSelected, false);
      dCtx.restore();
    });

    // Draw resize handles for selected annotation
    const selAnn = annotations.find(a => a.id === selectedId);
    if (selAnn && selAnn.shape !== 'text') {
      dCtx.save();
      const shape = selAnn.shape || 'highlight';
      const handlePositions = (shape === 'line' || shape === 'arrow')
        ? [{ x: selAnn.x, y: selAnn.y }, { x: selAnn.x2, y: selAnn.y2 }]
        : getBoxHandles(selAnn);
      handlePositions.forEach(h => {
        dCtx.beginPath();
        dCtx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2);
        dCtx.fillStyle = '#fff';
        dCtx.fill();
        dCtx.strokeStyle = selAnn.color;
        dCtx.lineWidth = 2;
        dCtx.setLineDash([]);
        dCtx.stroke();
      });
      dCtx.restore();
    }

    // Preview while drawing
    if (previewRect) {
      dCtx.save();
      dCtx.globalAlpha = 0.75;
      drawAnnotation(dCtx, previewRect, '?', false, true);
      dCtx.restore();
    }

    renderLabels();
    updateTextStyleBar();
  }

  function drawAnnotation(ctx, ann, num, isSelected, isPreview) {
    const sw = ann.strokeWidth || 2;
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = isSelected ? sw + 1.5 : sw;
    ctx.setLineDash(isSelected && !isPreview ? [6, 3] : isPreview ? [4, 3] : []);

    const shape = ann.shape || (ann.isArrow ? 'arrow' : 'highlight');

    if (shape === 'highlight') {
      // Filled highlight rect
      ctx.fillStyle = hexToRgba(ann.color, ann.opacity);
      ctx.fillRect(ann.x, ann.y, ann.w, ann.h);
      ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
      if (!isPreview) drawBadge(ctx, Math.min(ann.x, ann.x + ann.w), Math.min(ann.y, ann.y + ann.h), num, ann.color, isSelected);

    } else if (shape === 'rect') {
      ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
      if (!isPreview) drawBadge(ctx, Math.min(ann.x, ann.x + ann.w), Math.min(ann.y, ann.y + ann.h), num, ann.color, isSelected);

    } else if (shape === 'circle') {
      // Square bounding box → perfect circle from center
      const cx = ann.x + ann.w / 2;
      const cy = ann.y + ann.h / 2;
      const r = Math.min(Math.abs(ann.w), Math.abs(ann.h)) / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      if (!isPreview) drawBadge(ctx, Math.min(ann.x, ann.x + ann.w), Math.min(ann.y, ann.y + ann.h), num, ann.color, isSelected);

    } else if (shape === 'oval') {
      const cx = ann.x + ann.w / 2;
      const cy = ann.y + ann.h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(ann.w / 2), Math.abs(ann.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      if (!isPreview) drawBadge(ctx, Math.min(ann.x, ann.x + ann.w), Math.min(ann.y, ann.y + ann.h), num, ann.color, isSelected);

    } else if (shape === 'line') {
      ctx.beginPath();
      ctx.moveTo(ann.x, ann.y);
      ctx.lineTo(ann.x2, ann.y2);
      ctx.stroke();
      if (!isPreview) drawBadge(ctx, ann.x, ann.y, num, ann.color, isSelected);

    } else if (shape === 'arrow') {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ann.x, ann.y);
      ctx.lineTo(ann.x2, ann.y2);
      ctx.stroke();

      // Arrowhead
      const angle = Math.atan2(ann.y2 - ann.y, ann.x2 - ann.x);
      const hLen = 12 + sw * 2;
      ctx.beginPath();
      ctx.moveTo(ann.x2, ann.y2);
      ctx.lineTo(ann.x2 - hLen * Math.cos(angle - 0.4), ann.y2 - hLen * Math.sin(angle - 0.4));
      ctx.lineTo(ann.x2 - hLen * Math.cos(angle + 0.4), ann.y2 - hLen * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = ann.color;
      ctx.fill();

      if (!isPreview) drawBadge(ctx, ann.x, ann.y, num, ann.color, isSelected);

    } else if (shape === 'text') {
      // Don't draw text while the inline editor is active for this annotation
      if (_activeInlineAnnId === ann.id) {
        if (!isPreview) drawBadge(ctx, ann.x, ann.y - 20, num, ann.color, isSelected);
        return;
      }
      const fontSize = ann.fontSize || 18;
      const fontFamily = ann.fontFamily || "system-ui, -apple-system, sans-serif";
      ctx.font = `bold ${fontSize}px ${fontFamily}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const displayText = ann.text || '';

      // Measure bounds for background / border (must be AFTER ctx.font is set)
      const metrics = measureTextAnnotation(ctx, ann);
      const px = 4, py = 2; // padding around text box

      // Background fill
      const bgColor = ann.bgColor;
      if (bgColor && bgColor !== 'transparent') {
        ctx.setLineDash([]);
        ctx.fillStyle = bgColor;
        ctx.fillRect(ann.x - px, ann.y - py, metrics.w + px * 2, metrics.h + py * 2);
      }

      // Text
      ctx.fillStyle = ann.color;
      if (!displayText) {
        // Empty text — show faint placeholder
        ctx.globalAlpha = 0.3;
        ctx.fillText('(text)', ann.x, ann.y);
        ctx.globalAlpha = 1;
      } else {
        const lines = displayText.split('\n');
        const lineHeight = fontSize * 1.3;
        lines.forEach((line, li) => {
          ctx.fillText(line, ann.x, ann.y + li * lineHeight);
        });
      }

      // Border stroke (drawn after text so it's on top of the fill)
      const borderColor = ann.borderColor;
      if (borderColor && borderColor !== 'none') {
        ctx.setLineDash([]);
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(ann.x - px, ann.y - py, metrics.w + px * 2, metrics.h + py * 2);
      }

      // Selection outline (dashed) — slightly outside the border
      if (isSelected && !isPreview) {
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(ann.x - px - 2, ann.y - py - 2, metrics.w + (px + 2) * 2, metrics.h + (py + 2) * 2);
        ctx.setLineDash([]);
      }
      if (!isPreview) drawBadge(ctx, ann.x, ann.y - 20, num, ann.color, isSelected);

    } else if (shape === 'doodle') {
      const pts = ann.points;
      if (!pts || pts.length < 2) return;
      ctx.setLineDash(isSelected && !isPreview ? [6, 3] : []);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!isPreview) {
        // Badge at topmost-leftmost point of the stroke
        const bx = Math.min(...pts.map(p => p.x));
        const by = Math.min(...pts.map(p => p.y));
        drawBadge(ctx, bx, by, num, ann.color, isSelected);
      }
    }
  }

  function measureTextAnnotation(ctx, ann) {
    const fontSize = ann.fontSize || 18;
    const fontFamily = ann.fontFamily || "system-ui, -apple-system, sans-serif";
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    const text = ann.text || '(text)';
    const lines = text.split('\n');
    const lineHeight = fontSize * 1.3;
    let maxW = 0;
    lines.forEach(line => {
      const m = ctx.measureText(line);
      if (m.width > maxW) maxW = m.width;
    });
    return { w: Math.max(maxW, 60), h: Math.max(lines.length * lineHeight, lineHeight) };
  }

  function drawBadge(ctx, x, y, num, color, selected) {
    const r = 10;
    const bx = x - r;
    const by = y - r;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = selected ? '#fff' : color;
    ctx.fill();
    ctx.font = 'bold 11px -apple-system, sans-serif';
    ctx.fillStyle = selected ? color : '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(num, bx, by);
  }

  function renderLabels() {
    // Labels for annotations with notes - shown as overlays
    const layer = document.getElementById('labels-layer');
    layer.innerHTML = '';
    // No floating labels needed - handled in side panel
  }

  // ── INTERACTION LAYER ──────────────────────────────────────────────────────
  // mousedown on the canvas element; mousemove + mouseup on document so that
  // releasing or moving the mouse outside the canvas still commits the shape.
  interLayer.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Double-click to edit text annotations in select mode
  interLayer.addEventListener('dblclick', e => {
    if (!image) return;
    const pos = getCanvasPos(e);
    // Find a text annotation under the cursor
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i];
      if (a.shape === 'text' && hitTestText(pos, a)) {
        selectedId = a.id;
        renderAnnotations();
        renderSidePanel();
        openInlineTextEditor(a);
        return;
      }
    }
  });

  // Capture canvas rect at mousedown so coordinates stay stable
  // even if the viewport scrolls mid-drag.
  let _canvasRect = null;

  function getCanvasPos(e) {
    // For mousedown (target = interLayer), use offsetX/Y directly
    if (e.target === interLayer && !isDrawing && !isDragging && !isResizing) {
      return { x: e.offsetX, y: e.offsetY };
    }
    // For document-level move/up events, use the captured rect
    const rect = _canvasRect || interLayer.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  // ── HANDLE GEOMETRY ────────────────────────────────────────────────────────
  // Returns 8 handle positions [{x,y}] for a box annotation (TL,T,TR,R,BR,B,BL,L)
  function getBoxHandles(ann) {
    const x = Math.min(ann.x, ann.x + ann.w);
    const y = Math.min(ann.y, ann.y + ann.h);
    const w = Math.abs(ann.w), h = Math.abs(ann.h);
    return [
      { x: x,       y: y       }, // 0 TL
      { x: x+w/2,   y: y       }, // 1 T
      { x: x+w,     y: y       }, // 2 TR
      { x: x+w,     y: y+h/2   }, // 3 R
      { x: x+w,     y: y+h     }, // 4 BR
      { x: x+w/2,   y: y+h     }, // 5 B
      { x: x,       y: y+h     }, // 6 BL
      { x: x,       y: y+h/2   }, // 7 L
    ];
  }

  function hitTestHandles(pos, ann) {
    const shape = ann.shape || 'highlight';
    if (shape === 'line' || shape === 'arrow') {
      if (Math.hypot(pos.x - ann.x,  pos.y - ann.y)  < HANDLE_R + 4) return 'start';
      if (Math.hypot(pos.x - ann.x2, pos.y - ann.y2) < HANDLE_R + 4) return 'end';
      return null;
    }
    const handles = getBoxHandles(ann);
    for (let i = 0; i < handles.length; i++) {
      if (Math.hypot(pos.x - handles[i].x, pos.y - handles[i].y) < HANDLE_R + 4) return i;
    }
    return null;
  }

  function applyResize(ann, handle, pos) {
    const shape = ann.shape || 'highlight';
    if (shape === 'line' || shape === 'arrow') {
      if (handle === 'start') { ann.x = pos.x; ann.y = pos.y; }
      else                    { ann.x2 = pos.x; ann.y2 = pos.y; }
      return;
    }
    // For box shapes, manipulate x/y/w/h based on which handle is dragged
    const ox = resizeOrigin.x, oy = resizeOrigin.y;
    const ow = resizeOrigin.w, oh = resizeOrigin.h;
    const r = Math.min(ox, ox+ow), t = Math.min(oy, oy+oh);
    const ri = Math.max(ox, ox+ow), bo = Math.max(oy, oy+oh);

    switch (handle) {
      case 0: ann.x = pos.x; ann.y = pos.y; ann.w = ri - pos.x; ann.h = bo - pos.y; break; // TL
      case 1: ann.y = pos.y; ann.h = bo - pos.y; break;                                      // T
      case 2: ann.y = pos.y; ann.w = pos.x - r; ann.h = bo - pos.y; ann.x = r; break;       // TR
      case 3: ann.w = pos.x - r; ann.x = r; break;                                           // R
      case 4: ann.w = pos.x - r; ann.h = pos.y - t; ann.x = r; ann.y = t; break;            // BR
      case 5: ann.h = pos.y - t; ann.y = t; break;                                           // B
      case 6: ann.x = pos.x; ann.w = ri - pos.x; ann.h = pos.y - t; ann.y = t; break;       // BL
      case 7: ann.x = pos.x; ann.w = ri - pos.x; break;                                      // L
    }
  }

  // ── CURSOR ─────────────────────────────────────────────────────────────────
  const RESIZE_CURSORS = [
    'nw-resize','n-resize','ne-resize','e-resize',
    'se-resize','s-resize','sw-resize','w-resize'
  ];

  function updateSelectCursor(pos) {
    if (!image) return;
    const sel = annotations.find(a => a.id === selectedId);
    if (sel) {
      const shape = sel.shape || 'highlight';
      if (shape !== 'text') {
        const h = hitTestHandles(pos, sel);
        if (h !== null) {
          interLayer.style.cursor = typeof h === 'number' ? RESIZE_CURSORS[h] : (h === 'start' ? 'crosshair' : 'crosshair');
          return;
        }
      }
      // Check if inside selection bounding box → move cursor
      if (shape === 'text') {
        if (hitTestText(pos, sel)) { interLayer.style.cursor = 'move'; return; }
      } else if (shape !== 'line' && shape !== 'arrow') {
        const bx = Math.min(sel.x, sel.x + sel.w), by = Math.min(sel.y, sel.y + sel.h);
        if (pos.x >= bx && pos.x <= bx + Math.abs(sel.w) && pos.y >= by && pos.y <= by + Math.abs(sel.h)) {
          interLayer.style.cursor = 'move'; return;
        }
      } else if (pointNearLine(pos, sel)) {
        interLayer.style.cursor = 'move'; return;
      }
    }
    interLayer.style.cursor = 'default';
  }

  // ── INTERACTION ─────────────────────────────────────────────────────────────
  function onMouseDown(e) {
    if (_cropState) return; // block annotation drawing while cropping
    if (!image) return;
    if (selectedOverlayId !== null) deselectOverlay();
    _canvasRect = interLayer.getBoundingClientRect(); // lock rect for this gesture
    const pos = getCanvasPos(e);

    if (tool === 'select') {
      const sel = annotations.find(a => a.id === selectedId);

      // 1. Check resize handles on currently selected annotation
      if (sel) {
        const h = hitTestHandles(pos, sel);
        if (h !== null) {
          isResizing = true;
          resizeHandle = h;
          resizeOrigin = { ...sel };
          return;
        }
      }

      // 2. Check if clicking inside current selection to drag
      if (sel) {
        const shape = sel.shape || 'highlight';
        let inside = false;
        if (shape === 'text') {
          inside = hitTestText(pos, sel);
        } else if (shape === 'line' || shape === 'arrow') {
          inside = pointNearLine(pos, sel);
        } else if (shape === 'doodle') {
          inside = pointNearDoodle(pos, sel);
        } else {
          const bx = Math.min(sel.x, sel.x+sel.w), by = Math.min(sel.y, sel.y+sel.h);
          inside = pos.x >= bx && pos.x <= bx+Math.abs(sel.w) && pos.y >= by && pos.y <= by+Math.abs(sel.h);
        }
        if (inside) {
          isDragging = true;
          const shape = sel.shape || 'highlight';
          if (shape === 'doodle') {
            dragOffset = { px: pos.x, py: pos.y };
          } else {
            dragOffset = { dx: pos.x - sel.x, dy: pos.y - sel.y };
          }
          return;
        }
      }

      // 3. Hit-test all annotations to select a new one
      let hit = null;
      for (let i = annotations.length - 1; i >= 0; i--) {
        const a = annotations[i];
        const shape = a.shape || (a.isArrow ? 'arrow' : 'highlight');
        if (shape === 'text') {
          if (hitTestText(pos, a)) { hit = a; break; }
        } else if (shape === 'line' || shape === 'arrow') {
          if (pointNearLine(pos, a)) { hit = a; break; }
        } else if (shape === 'doodle') {
          if (pointNearDoodle(pos, a)) { hit = a; break; }
        } else {
          const bx = Math.min(a.x, a.x+(a.w||0)), by = Math.min(a.y, a.y+(a.h||0));
          if (pos.x >= bx && pos.x <= bx+Math.abs(a.w||0) && pos.y >= by && pos.y <= by+Math.abs(a.h||0)) {
            hit = a; break;
          }
        }
      }
      selectedId = hit ? hit.id : null;
      renderAnnotations();
      renderSidePanel();
      if (selectedId) {
        setTimeout(() => {
          const el = document.querySelector(`[data-ann-id="${selectedId}"] textarea`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
      return;
    }

    // Text tool: single click to place and immediately open inline editor
    if (tool === 'text') {
      const ann = { id: nextId++, shape: 'text', x: pos.x, y: pos.y, text: '', fontSize: 18, color: currentColor, strokeWidth: currentStrokeWidth, opacity: currentOpacity, note: '', type: 'improvement', fontFamily: (document.getElementById('font-family-select') as any)?.value || 'system-ui, -apple-system, sans-serif', bgColor: 'transparent', borderColor: 'none' };
      annotations.push(ann);
      selectedId = ann.id;
      renderAnnotations();
      renderSidePanel();
      updatePrompt();
      openInlineTextEditor(ann);
      return;
    }

    // If an annotation is currently selected (dotted), the first click deselects
    // it and makes it solid — but does NOT start drawing yet.
    if (selectedId !== null) {
      selectedId = null;
      renderAnnotations();
      renderSidePanel();
      return;
    }

    if (tool === 'doodle') {
      isDrawing = true;
      doodlePoints = [pos];
      return;
    }

    isDrawing = true;
    dragStart = pos;
  }

  function onMouseMove(e) {
    if (_cropState)  { handleCropMouseMove(e); return; }
    if (_ovResize) { handleOverlayResize(e); return; }
    if (_ovDrag)   { handleOverlayDrag(e);   return; }
    if (!image) return;
    const pos = getCanvasPos(e);

    if (tool === 'select') {
      if (isResizing) {
        const ann = annotations.find(a => a.id === selectedId);
        if (ann) { applyResize(ann, resizeHandle, pos); renderAnnotations(); }
        return;
      }
      if (isDragging) {
        const ann = annotations.find(a => a.id === selectedId);
        if (ann) {
          const shape = ann.shape || 'highlight';
          const dx = pos.x - dragOffset.dx;
          const dy = pos.y - dragOffset.dy;
          if (shape === 'line' || shape === 'arrow') {
            const lx = ann.x2 - ann.x, ly = ann.y2 - ann.y;
            ann.x = dx; ann.y = dy; ann.x2 = dx + lx; ann.y2 = dy + ly;
          } else if (shape === 'doodle') {
            const ddx = pos.x - dragOffset.px;
            const ddy = pos.y - dragOffset.py;
            ann.points = ann.points.map(p => ({ x: p.x + ddx, y: p.y + ddy }));
            dragOffset.px = pos.x;
            dragOffset.py = pos.y;
          } else {
            ann.x = dx; ann.y = dy;
          }
          renderAnnotations();
        }
        return;
      }
      updateSelectCursor(pos);
      return;
    }

    if (!isDrawing || !image) return;

    if (tool === 'doodle') {
      doodlePoints.push(pos);
      // Live preview: draw directly on display canvas, renderAnnotations will repaint fully
      previewRect = { shape: 'doodle', points: doodlePoints, color: currentColor, strokeWidth: currentStrokeWidth, opacity: currentOpacity };
      renderAnnotations();
      return;
    }

    if (isLinearTool()) {
      previewRect = { shape: tool.replace('shape-',''), x: dragStart.x, y: dragStart.y, x2: pos.x, y2: pos.y, color: currentColor, strokeWidth: currentStrokeWidth };
    } else {
      const x = Math.min(dragStart.x, pos.x);
      const y = Math.min(dragStart.y, pos.y);
      const w = Math.abs(pos.x - dragStart.x);
      const h = Math.abs(pos.y - dragStart.y);
      previewRect = { shape: tool === 'rect' ? 'highlight' : tool.replace('shape-',''), x, y, w, h, color: currentColor, opacity: currentOpacity, strokeWidth: currentStrokeWidth };
    }
    renderAnnotations();
  }

  function onMouseUp(e) {
    if (_cropState)           { handleCropMouseUp(); return; }
    if (_ovDrag || _ovResize) { _ovDrag = null; _ovResize = null; _pushHistory(); return; }
    if (!isDrawing && !isDragging && !isResizing) return; // nothing active

    // Finish resize or drag
    if (isResizing || isDragging) {
      resetGestureState();
      renderAnnotations();
      updatePrompt();
      _pushHistory();
      return;
    }

    if (!image) { resetGestureState(); return; }
    isDrawing = false;
    const pos = getCanvasPos(e);
    let ann = null;

    if (tool === 'doodle') {
      doodlePoints.push(pos);
      if (doodlePoints.length >= 2) {
        ann = { id: nextId++, shape: 'doodle', points: doodlePoints, color: currentColor, strokeWidth: currentStrokeWidth, opacity: currentOpacity, note: '', type: 'improvement' };
      }
      doodlePoints = [];
      if (ann) {
        annotations.push(ann);
        selectedId = ann.id;
      }
      resetGestureState();
      renderAnnotations();
      renderSidePanel();
      updatePrompt();
      if (ann) {
        _pushHistory();
        setTimeout(() => {
          const ta = document.querySelector(`[data-ann-id="${ann.id}"] textarea`);
          if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        }, 60);
      }
      return;
    }

    if (isLinearTool()) {
      const len = Math.hypot(pos.x - dragStart.x, pos.y - dragStart.y);
      if (len > 8) {
        ann = { id: nextId++, shape: tool.replace('shape-',''), x: dragStart.x, y: dragStart.y, x2: pos.x, y2: pos.y, color: currentColor, strokeWidth: currentStrokeWidth, opacity: currentOpacity, note: '', type: 'improvement' };
      }
    } else {
      const x = Math.min(dragStart.x, pos.x);
      const y = Math.min(dragStart.y, pos.y);
      const w = Math.abs(pos.x - dragStart.x);
      const h = Math.abs(pos.y - dragStart.y);
      if (w > 8 && h > 8) {
        ann = { id: nextId++, shape: tool === 'rect' ? 'highlight' : tool.replace('shape-',''), x, y, w, h, color: currentColor, strokeWidth: currentStrokeWidth, opacity: currentOpacity, note: '', type: 'improvement' };
      }
    }

    if (ann) {
      annotations.push(ann);
      selectedId = ann.id;
    }

    resetGestureState();
    renderAnnotations();
    renderSidePanel();
    updatePrompt();
    if (ann) {
      _pushHistory();
      setTimeout(() => {
        const ta = document.querySelector(`[data-ann-id="${ann.id}"] textarea`);
        if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      }, 60);
    }
  }

  function resetGestureState() {
    isDrawing = false; isDragging = false; isResizing = false;
    previewRect = null; resizeHandle = null; resizeOrigin = null; dragOffset = null;
    doodlePoints = [];
    _canvasRect = null;
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _cropState) { cancelCrop(); return; }
    if (e.key === 'Enter' && _cropState) { applyCrop(); return; }
    // Undo / Redo — handled before textarea check so they work globally
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    // Ctrl+S — save (works even when typing in a textarea)
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveSession(); return; }
    // Esc closes the prompt overlay
    if (e.key === 'Escape' && document.getElementById('prompt-overlay')?.classList.contains('open')) { toggleOverlay(false); return; }
    const tag = document.activeElement?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedOverlayId !== null) { deleteOverlay(selectedOverlayId); return; }
      if (tool === 'select' && selectedId !== null) deleteAnnotation(selectedId);
    }
  });

  function hitTestText(pos, ann) {
    const metrics = measureTextAnnotation(dCtx, ann);
    // Extend hit area by the same padding used when drawing bg/border (px=4, py=2) plus a bit extra
    const px = 6, py = 4;
    return pos.x >= ann.x - px && pos.x <= ann.x + metrics.w + px &&
           pos.y >= ann.y - py && pos.y <= ann.y + metrics.h + py;
  }

  function pointNearLine(pos, ann) {
    const dx = ann.x2 - ann.x, dy = ann.y2 - ann.y;
    const len2 = dx*dx + dy*dy;
    if (len2 === 0) return false;
    const t = Math.max(0, Math.min(1, ((pos.x-ann.x)*dx + (pos.y-ann.y)*dy) / len2));
    const px = ann.x + t*dx - pos.x, py = ann.y + t*dy - pos.y;
    return Math.sqrt(px*px + py*py) < 12;
  }

  function pointNearDoodle(pos, ann) {
    const pts = ann.points;
    if (!pts || pts.length < 2) return false;
    const threshold = 10;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i+1].x - pts[i].x, dy = pts[i+1].y - pts[i].y;
      const len2 = dx*dx + dy*dy;
      if (len2 === 0) continue;
      const t = Math.max(0, Math.min(1, ((pos.x-pts[i].x)*dx + (pos.y-pts[i].y)*dy) / len2));
      const nx = pts[i].x + t*dx - pos.x, ny = pts[i].y + t*dy - pos.y;
      if (Math.sqrt(nx*nx + ny*ny) < threshold) return true;
    }
    return false;
  }

  // ── INLINE TEXT EDITOR ────────────────────────────────────────────────────
  let _activeInlineEditor = null;

  function openInlineTextEditor(ann) {
    closeInlineTextEditor(); // close any existing one

    const wrap = document.getElementById('canvas-wrap');
    const textarea = document.createElement('textarea');
    textarea.className = 'inline-text-editor';
    textarea.style.left = ann.x + 'px';
    textarea.style.top = ann.y + 'px';
    textarea.style.fontSize = (ann.fontSize || 18) + 'px';
    textarea.style.fontFamily = ann.fontFamily || "system-ui, -apple-system, sans-serif";
    textarea.style.color = ann.color;
    // Apply background: use annotation's bgColor (transparent by default means clear)
    const bgColor = ann.bgColor;
    textarea.style.background = (bgColor && bgColor !== 'transparent') ? bgColor : 'transparent';
    // Apply border: use annotation's borderColor or fall back to accent focus ring
    const borderColor = ann.borderColor;
    if (borderColor && borderColor !== 'none') {
      textarea.style.border = `2px solid ${borderColor}`;
      textarea.style.boxShadow = `0 0 0 3px ${borderColor}44`;
    }
    textarea.value = ann.text || '';
    textarea.placeholder = 'Type here...';

    // Auto-grow height
    function autoResize() {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    }

    textarea.addEventListener('input', () => {
      ann.text = textarea.value;
      autoResize();
      renderAnnotations();
      updatePrompt();
    });

    // Close on Escape or clicking outside
    textarea.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeInlineTextEditor();
        e.stopPropagation();
      }
    });

    textarea.addEventListener('blur', () => {
      // Small delay to allow click events to process first
      setTimeout(() => {
        if (_activeInlineEditor === textarea) {
          closeInlineTextEditor();
        }
      }, 150);
    });

    wrap.appendChild(textarea);
    _activeInlineEditor = textarea;
    _activeInlineAnnId = ann.id;

    // Focus and auto-resize after append
    requestAnimationFrame(() => {
      textarea.focus();
      autoResize();
    });
  }

  let _activeInlineAnnId = null;

  function closeInlineTextEditor() {
    if (_activeInlineEditor) {
      // Commit final value
      if (_activeInlineAnnId !== null) {
        const ann = annotations.find(a => a.id === _activeInlineAnnId);
        if (ann) {
          ann.text = _activeInlineEditor.value;
          // Remove empty text annotations
          if (!ann.text.trim()) {
            annotations = annotations.filter(a => a.id !== ann.id);
            if (selectedId === ann.id) selectedId = null;
          }
        }
      }
      _activeInlineEditor.remove();
      _activeInlineEditor = null;
      _activeInlineAnnId = null;
      renderAnnotations();
      renderSidePanel();
      updatePrompt();
      _pushHistory();
    }
  }

  // ── UNDO / REDO ────────────────────────────────────────────────────────────
  function _takeSnapshot() {
    return {
      annotations: JSON.parse(JSON.stringify(annotations)),
      overlays: overlays.map(ov => ({ id: ov.id, src: ov.src, x: ov.x, y: ov.y, w: ov.w, h: ov.h })),
      nextId,
      nextOverlayId
    };
  }

  function _pushHistory() {
    _history = _history.slice(0, _histIdx + 1);
    _history.push(_takeSnapshot());
    if (_history.length > MAX_HISTORY) _history.shift();
    else _histIdx++;
    _updateUndoRedo();
  }

  function _updateUndoRedo() {
    const u = document.getElementById('btn-undo');
    const r = document.getElementById('btn-redo');
    if (u) { u.disabled = _histIdx <= 0; u.style.opacity = _histIdx <= 0 ? '0.4' : '1'; }
    if (r) { r.disabled = _histIdx >= _history.length - 1; r.style.opacity = _histIdx >= _history.length - 1 ? '0.4' : '1'; }
  }

  function undo() {
    if (_histIdx <= 0) return;
    _histIdx--;
    _applySnapshot(_history[_histIdx]);
  }

  function redo() {
    if (_histIdx >= _history.length - 1) return;
    _histIdx++;
    _applySnapshot(_history[_histIdx]);
  }

  function _applySnapshot(snap) {
    if (_cropState) _cleanupCropUI();
    annotations = JSON.parse(JSON.stringify(snap.annotations));
    nextId = snap.nextId;
    selectedId = null;
    // Rebuild overlays from snapshot
    overlays.forEach(ov => ov.el.remove());
    overlays = [];
    nextOverlayId = snap.nextOverlayId;
    selectedOverlayId = null;
    snap.overlays.forEach(ovSnap => {
      const imgObj = new Image();
      imgObj.src = ovSnap.src;
      _buildOverlayEl(ovSnap.src, imgObj, ovSnap.x, ovSnap.y, ovSnap.w, ovSnap.h, ovSnap.id);
    });
    renderAnnotations();
    renderSidePanel();
    updatePrompt();
    _updateUndoRedo();
  }

  // ── OVERLAY IMAGES ─────────────────────────────────────────────────────────
  function pasteOverlayImage() {
    if (!image) { alert('Paste a base screenshot first before adding overlays.'); return; }
    navigator.clipboard.read().then(items => {
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            item.getType(type).then(blob => loadOverlayBlob(blob));
            return;
          }
        }
      }
      alert('No image in clipboard. Copy an image first.');
    }).catch(() => {
      alert('No image in clipboard. Copy an image first.');
    });
  }

  function loadOverlayBlob(blob) {
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      const imgObj = new Image();
      imgObj.onload = () => {
        const maxW = baseCanvas.width * 0.5;
        const maxH = baseCanvas.height * 0.5;
        const scale = Math.min(1, maxW / imgObj.width, maxH / imgObj.height);
        const w = Math.round(imgObj.width * scale);
        const h = Math.round(imgObj.height * scale);
        const x = Math.round((baseCanvas.width - w) / 2);
        const y = Math.round((baseCanvas.height - h) / 2);
        createOverlay(dataUrl, imgObj, x, y, w, h);
      };
      imgObj.src = dataUrl;
    };
    reader.readAsDataURL(blob);
  }

  function _buildOverlayEl(src, imgObj, x, y, w, h, id) {
    const canvasWrap = document.getElementById('canvas-wrap');

    const div = document.createElement('div');
    div.className = 'overlay-wrap';
    div.dataset.ovId = id;
    div.style.left = x + 'px';
    div.style.top = y + 'px';
    div.style.width = w + 'px';
    div.style.height = h + 'px';

    const imgEl = document.createElement('img');
    imgEl.src = src;
    imgEl.draggable = false;
    div.appendChild(imgEl);

    ['tl','t','tr','r','br','b','bl','l'].forEach(pos => {
      const hEl = document.createElement('div');
      hEl.className = `ov-handle ov-${pos}`;
      hEl.dataset.handle = pos;
      hEl.style.display = 'none';
      div.appendChild(hEl);
    });

    const del = document.createElement('div');
    del.className = 'ov-delete';
    del.textContent = '×';
    del.style.display = 'none';
    del.addEventListener('mousedown', e => { e.stopPropagation(); deleteOverlay(id); });
    div.appendChild(del);

    div.addEventListener('mousedown', e => {
      if (e.target.classList.contains('ov-delete')) return;
      e.stopPropagation();
      e.preventDefault();
      selectOverlay(id);
      const ov = overlays.find(o => o.id === id);
      if (e.target.classList.contains('ov-handle')) {
        _ovResize = { id, handle: e.target.dataset.handle, startX: e.clientX, startY: e.clientY,
          origX: ov.x, origY: ov.y, origW: ov.w, origH: ov.h };
      } else {
        _ovDrag = { id, startX: e.clientX, startY: e.clientY, origX: ov.x, origY: ov.y };
      }
    });

    canvasWrap.appendChild(div);
    overlays.push({ id, el: div, imgObj, src, x, y, w, h });
  }

  function createOverlay(src, imgObj, x, y, w, h) {
    const id = nextOverlayId++;
    _buildOverlayEl(src, imgObj, x, y, w, h, id);
    selectOverlay(id);
    _pushHistory();
  }

  function selectOverlay(id) {
    selectedOverlayId = id;
    overlays.forEach(ov => {
      const sel = ov.id === id;
      ov.el.classList.toggle('ov-selected', sel);
      ov.el.querySelectorAll('.ov-handle, .ov-delete').forEach(el => {
        el.style.display = sel ? '' : 'none';
      });
    });
  }

  function deselectOverlay() {
    selectedOverlayId = null;
    overlays.forEach(ov => {
      ov.el.classList.remove('ov-selected');
      ov.el.querySelectorAll('.ov-handle, .ov-delete').forEach(el => { el.style.display = 'none'; });
    });
  }

  function deleteOverlay(id) {
    const idx = overlays.findIndex(o => o.id === id);
    if (idx === -1) return;
    overlays[idx].el.remove();
    overlays.splice(idx, 1);
    if (selectedOverlayId === id) selectedOverlayId = null;
    _pushHistory();
  }

  function handleOverlayDrag(e) {
    const ov = overlays.find(o => o.id === _ovDrag.id);
    if (!ov) return;
    ov.x = _ovDrag.origX + (e.clientX - _ovDrag.startX);
    ov.y = _ovDrag.origY + (e.clientY - _ovDrag.startY);
    ov.el.style.left = ov.x + 'px';
    ov.el.style.top = ov.y + 'px';
  }

  function handleOverlayResize(e) {
    const ov = overlays.find(o => o.id === _ovResize.id);
    if (!ov) return;
    const dx = e.clientX - _ovResize.startX;
    const dy = e.clientY - _ovResize.startY;
    const { origX: ox, origY: oy, origW: ow, origH: oh } = _ovResize;
    let nx = ox, ny = oy, nw = ow, nh = oh;
    switch (_ovResize.handle) {
      case 'tl': nx=ox+dx; ny=oy+dy; nw=ow-dx; nh=oh-dy; break;
      case 't':  ny=oy+dy; nh=oh-dy; break;
      case 'tr': ny=oy+dy; nw=ow+dx; nh=oh-dy; break;
      case 'r':  nw=ow+dx; break;
      case 'br': nw=ow+dx; nh=oh+dy; break;
      case 'b':  nh=oh+dy; break;
      case 'bl': nx=ox+dx; nw=ow-dx; nh=oh+dy; break;
      case 'l':  nx=ox+dx; nw=ow-dx; break;
    }
    if (nw < 20) { if (['tl','l','bl'].includes(_ovResize.handle)) nx = ox + ow - 20; nw = 20; }
    if (nh < 20) { if (['tl','t','tr'].includes(_ovResize.handle)) ny = oy + oh - 20; nh = 20; }
    ov.x = nx; ov.y = ny; ov.w = nw; ov.h = nh;
    ov.el.style.left = nx + 'px';
    ov.el.style.top = ny + 'px';
    ov.el.style.width = nw + 'px';
    ov.el.style.height = nh + 'px';
  }

  // ── CROP MODE ──────────────────────────────────────────────────────────────
  function startCropMode() {
    if (_cropState) return; // already cropping
    if (selectedOverlayId === null) { alert('Select an overlay image first, then click Crop Overlay.'); return; }
    const ov = overlays.find(o => o.id === selectedOverlayId);
    if (!ov) return;

    // Hide overlay handles/outline while cropping
    ov.el.classList.remove('ov-selected');
    ov.el.querySelectorAll('.ov-handle, .ov-delete').forEach(el => { el.style.display = 'none'; });

    const canvasWrap = document.getElementById('canvas-wrap');

    // Crop rect starts inset 10% on each side
    const insetX = Math.round(ov.w * 0.1);
    const insetY = Math.round(ov.h * 0.1);
    const cropX = insetX, cropY = insetY;
    const cropW = ov.w - insetX * 2;
    const cropH = ov.h - insetY * 2;

    // Build crop UI positioned exactly over the overlay
    const uiEl = document.createElement('div');
    uiEl.className = 'crop-ui';
    uiEl.style.left = ov.x + 'px';
    uiEl.style.top  = ov.y + 'px';
    uiEl.style.width  = ov.w + 'px';
    uiEl.style.height = ov.h + 'px';

    const cropRectEl = document.createElement('div');
    cropRectEl.className = 'crop-rect';
    uiEl.appendChild(cropRectEl);

    ['tl','t','tr','r','br','b','bl','l'].forEach(pos => {
      const h = document.createElement('div');
      h.className = `crop-handle c-${pos}`;
      h.dataset.handle = pos;
      cropRectEl.appendChild(h);
    });

    canvasWrap.appendChild(uiEl);

    // Floating confirm/cancel bar
    const actionsEl = document.createElement('div');
    actionsEl.className = 'crop-actions-bar';
    actionsEl.innerHTML = `
      <span>Drag handles to adjust crop</span>
      <div class="toolbar-sep" style="width:1px;height:20px;background:var(--border);margin:0 4px"></div>
      <button class="tool-btn primary" style="height:28px;padding:0 12px;font-size:12px" onclick="applyCrop()">✓ Apply Crop</button>
      <button class="tool-btn" style="height:28px;padding:0 10px;font-size:12px" onclick="cancelCrop()">✗ Cancel</button>`;
    document.body.appendChild(actionsEl);

    _cropState = { ovId: ov.id, uiEl, cropRectEl, actionsEl, cropX, cropY, cropW, cropH,
      dragging: false, handle: null, startX: 0, startY: 0,
      origCropX: 0, origCropY: 0, origCropW: 0, origCropH: 0 };

    _updateCropRect();

    // Wire mouse interactions on the crop-rect
    cropRectEl.addEventListener('mousedown', e => {
      e.stopPropagation();
      e.preventDefault();
      _cropState.startX = e.clientX;
      _cropState.startY = e.clientY;
      _cropState.origCropX = _cropState.cropX;
      _cropState.origCropY = _cropState.cropY;
      _cropState.origCropW = _cropState.cropW;
      _cropState.origCropH = _cropState.cropH;
      if (e.target.classList.contains('crop-handle')) {
        _cropState.handle = e.target.dataset.handle;
        _cropState.dragging = false;
      } else {
        _cropState.handle = null;
        _cropState.dragging = true;
      }
    });
  }

  function _updateCropRect() {
    if (!_cropState) return;
    const { cropRectEl, cropX, cropY, cropW, cropH } = _cropState;
    cropRectEl.style.left   = cropX + 'px';
    cropRectEl.style.top    = cropY + 'px';
    cropRectEl.style.width  = cropW + 'px';
    cropRectEl.style.height = cropH + 'px';
  }

  function handleCropMouseMove(e) {
    if (!_cropState) return;
    if (!_cropState.dragging && !_cropState.handle) return;
    const ov = overlays.find(o => o.id === _cropState.ovId);
    if (!ov) return;
    const dx = e.clientX - _cropState.startX;
    const dy = e.clientY - _cropState.startY;
    const { origCropX: ox, origCropY: oy, origCropW: ow, origCropH: oh } = _cropState;
    const MIN = 20;

    if (_cropState.dragging) {
      // Move: clamp within overlay bounds
      _cropState.cropX = Math.max(0, Math.min(ov.w - ow, ox + dx));
      _cropState.cropY = Math.max(0, Math.min(ov.h - oh, oy + dy));
    } else {
      let nx = ox, ny = oy, nw = ow, nh = oh;
      switch (_cropState.handle) {
        case 'tl': nx=ox+dx; ny=oy+dy; nw=ow-dx; nh=oh-dy; break;
        case 't':  ny=oy+dy; nh=oh-dy; break;
        case 'tr': ny=oy+dy; nw=ow+dx; nh=oh-dy; break;
        case 'r':  nw=ow+dx; break;
        case 'br': nw=ow+dx; nh=oh+dy; break;
        case 'b':  nh=oh+dy; break;
        case 'bl': nx=ox+dx; nw=ow-dx; nh=oh+dy; break;
        case 'l':  nx=ox+dx; nw=ow-dx; break;
      }
      // Clamp: no smaller than MIN, no larger than overlay
      if (nw < MIN) { if (['tl','l','bl'].includes(_cropState.handle)) nx = ox + ow - MIN; nw = MIN; }
      if (nh < MIN) { if (['tl','t','tr'].includes(_cropState.handle)) ny = oy + oh - MIN; nh = MIN; }
      nx = Math.max(0, nx); ny = Math.max(0, ny);
      if (nx + nw > ov.w) { if (['tl','l','bl'].includes(_cropState.handle)) nx = ov.w - nw; else nw = ov.w - nx; }
      if (ny + nh > ov.h) { if (['tl','t','tr'].includes(_cropState.handle)) ny = ov.h - nh; else nh = ov.h - ny; }
      _cropState.cropX = nx; _cropState.cropY = ny;
      _cropState.cropW = nw; _cropState.cropH = nh;
    }
    _updateCropRect();
  }

  function handleCropMouseUp() {
    if (!_cropState) return;
    _cropState.dragging = false;
    _cropState.handle = null;
  }

  function applyCrop() {
    if (!_cropState) return;
    const ov = overlays.find(o => o.id === _cropState.ovId);
    if (!ov) { cancelCrop(); return; }

    const { cropX, cropY, cropW, cropH } = _cropState;
    // Map crop rect (overlay-local pixels) → source image pixels
    const scaleX = ov.imgObj.naturalWidth  / ov.w;
    const scaleY = ov.imgObj.naturalHeight / ov.h;
    const srcX = cropX * scaleX, srcY = cropY * scaleY;
    const srcW = cropW * scaleX, srcH = cropH * scaleY;

    const offscreen = document.createElement('canvas');
    offscreen.width = Math.round(srcW);
    offscreen.height = Math.round(srcH);
    const ctx = offscreen.getContext('2d');
    ctx.drawImage(ov.imgObj, srcX, srcY, srcW, srcH, 0, 0, offscreen.width, offscreen.height);

    const newSrc = offscreen.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload = () => {
      ov.imgObj = newImg;
      ov.src = newSrc;
      ov.el.querySelector('img').src = newSrc;
      // Update overlay position/size to match the crop rect
      ov.x += cropX; ov.y += cropY;
      ov.w = cropW;  ov.h = cropH;
      ov.el.style.left   = ov.x + 'px';
      ov.el.style.top    = ov.y + 'px';
      ov.el.style.width  = ov.w + 'px';
      ov.el.style.height = ov.h + 'px';
      _cleanupCropUI();
      selectOverlay(ov.id);
      _pushHistory();
    };
    newImg.src = newSrc;
  }

  function cancelCrop() {
    if (!_cropState) return;
    const ov = overlays.find(o => o.id === _cropState.ovId);
    _cleanupCropUI();
    if (ov) selectOverlay(ov.id);
  }

  function _cleanupCropUI() {
    if (!_cropState) return;
    _cropState.uiEl.remove();
    _cropState.actionsEl.remove();
    _cropState = null;
  }

  // ── TOOLS & COLORS ─────────────────────────────────────────────────────────
  const ALL_TOOL_BTNS = ['rect', 'shape-rect', 'shape-circle', 'shape-oval', 'shape-line', 'shape-arrow', 'doodle', 'text', 'select'];

  function setTool(t) {
    tool = t;
    ALL_TOOL_BTNS.forEach(n => {
      const el = document.getElementById('btn-' + n);
      if (el) el.classList.toggle('active', n === t);
    });
    interLayer.style.cursor = t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair';
    // Show/hide opacity slider only for highlight tool
    const opacityLabel = document.getElementById('opacity-label');
    const opacitySlider = document.getElementById('opacity-slider');
    const isHighlight = t === 'rect';
    opacityLabel.style.opacity = isHighlight ? '1' : '0.35';
    opacitySlider.style.opacity = isHighlight ? '1' : '0.35';
    opacitySlider.disabled = !isHighlight;
  }

  function setShapeTool(t) {
    // If an annotation is selected, change its shape instead of switching drawing tool
    if (selectedId !== null) {
      const ann = annotations.find(a => a.id === selectedId);
      if (ann) {
        const newShape = t.replace('shape-', '');
        const wasLinear = ann.shape === 'line' || ann.shape === 'arrow';
        const willBeLinear = newShape === 'line' || newShape === 'arrow';
        if (wasLinear && !willBeLinear) {
          // Convert linear → box using x2/y2
          ann.w = (ann.x2 ?? ann.x) - ann.x;
          ann.h = (ann.y2 ?? ann.y) - ann.y;
          if (ann.w < 0) { ann.x += ann.w; ann.w = Math.abs(ann.w); }
          if (ann.h < 0) { ann.y += ann.h; ann.h = Math.abs(ann.h); }
          if (ann.w < 20) ann.w = 20;
          if (ann.h < 20) ann.h = 20;
        } else if (!wasLinear && willBeLinear) {
          // Convert box → linear
          ann.x2 = ann.x + (ann.w || 0);
          ann.y2 = ann.y + (ann.h || 0);
        }
        ann.shape = newShape;
        renderAnnotations();
        renderSidePanel();
        updatePrompt();
        _pushHistory();
        return; // stay in select mode
      }
    }
    setTool(t);
  }

  function setColor(el) {
    currentColor = el.dataset.color;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    el.classList.add('active');
    // If an annotation is selected, update its color immediately
    if (selectedId !== null) {
      const ann = annotations.find(a => a.id === selectedId);
      if (ann) {
        ann.color = currentColor;
        renderAnnotations();
        renderSidePanel();
        updatePrompt();
        _pushHistory();
      }
    }
  }

  function setOpacity(val) {
    currentOpacity = val / 100;
  }

  function setStrokeWidth(val) {
    currentStrokeWidth = parseInt(val);
    document.getElementById('stroke-val').textContent = val;
  }

  // ── TEXT ANNOTATION STYLE CONTROLS ────────────────────────────────────────

  /** Sync the text-style-bar controls to the currently selected text annotation. */
  function updateTextStyleBar() {
    const bar = document.getElementById('text-style-bar');
    if (!bar) return;
    const sel = annotations.find(a => a.id === selectedId);
    const isTextSel = !!(sel && sel.shape === 'text');
    bar.style.display = isTextSel ? 'flex' : 'none';
    if (!isTextSel) return;

    // Font size
    const sizeSlider = document.getElementById('text-size-slider') as HTMLInputElement;
    const sizeVal = document.getElementById('text-size-val');
    const fontSize = sel.fontSize || 18;
    if (sizeSlider) sizeSlider.value = String(fontSize);
    if (sizeVal) sizeVal.textContent = String(fontSize);

    // Font family
    const fontSelect = document.getElementById('font-family-select') as HTMLSelectElement;
    if (fontSelect) fontSelect.value = sel.fontFamily || 'system-ui, -apple-system, sans-serif';

    // Background
    const bgNoneBtn = document.getElementById('text-bg-none-btn');
    const bgInput = document.getElementById('text-bg-color-input') as HTMLInputElement;
    const bgColor = sel.bgColor || 'transparent';
    if (bgNoneBtn) bgNoneBtn.classList.toggle('active', bgColor === 'transparent');
    if (bgInput && bgColor !== 'transparent') bgInput.value = bgColor;

    // Border
    const borderNoneBtn = document.getElementById('text-border-none-btn');
    const borderInput = document.getElementById('text-border-color-input') as HTMLInputElement;
    const borderColor = sel.borderColor || 'none';
    if (borderNoneBtn) borderNoneBtn.classList.toggle('active', borderColor === 'none');
    if (borderInput && borderColor !== 'none') borderInput.value = borderColor;
  }

  function setSelectedFontSize(val) {
    const numVal = parseInt(val);
    const sizeVal = document.getElementById('text-size-val');
    if (sizeVal) sizeVal.textContent = String(numVal);
    const sel = annotations.find(a => a.id === selectedId);
    if (!sel || sel.shape !== 'text') return;
    sel.fontSize = numVal;
    // Keep inline editor in sync if open
    if (_activeInlineEditor && _activeInlineAnnId === sel.id) {
      _activeInlineEditor.style.fontSize = numVal + 'px';
    }
    renderAnnotations();
    _pushHistory();
  }

  function setSelectedFontFamily(val) {
    const sel = annotations.find(a => a.id === selectedId);
    if (!sel || sel.shape !== 'text') return;
    sel.fontFamily = val;
    // Keep inline editor in sync if open
    if (_activeInlineEditor && _activeInlineAnnId === sel.id) {
      _activeInlineEditor.style.fontFamily = val;
    }
    renderAnnotations();
    _pushHistory();
  }

  function setSelectedTextBg(val) {
    const sel = annotations.find(a => a.id === selectedId);
    if (!sel || sel.shape !== 'text') return;
    sel.bgColor = val;
    const bgNoneBtn = document.getElementById('text-bg-none-btn');
    if (bgNoneBtn) bgNoneBtn.classList.toggle('active', val === 'transparent');
    // Keep inline editor in sync if open
    if (_activeInlineEditor && _activeInlineAnnId === sel.id) {
      _activeInlineEditor.style.background = (val && val !== 'transparent') ? val : 'transparent';
    }
    renderAnnotations();
    _pushHistory();
  }

  function setSelectedBorderColor(val) {
    const sel = annotations.find(a => a.id === selectedId);
    if (!sel || sel.shape !== 'text') return;
    sel.borderColor = val;
    const borderNoneBtn = document.getElementById('text-border-none-btn');
    if (borderNoneBtn) borderNoneBtn.classList.toggle('active', val === 'none');
    // Keep inline editor in sync if open
    if (_activeInlineEditor && _activeInlineAnnId === sel.id) {
      if (val && val !== 'none') {
        _activeInlineEditor.style.border = `2px solid ${val}`;
        _activeInlineEditor.style.boxShadow = `0 0 0 3px ${val}44`;
      } else {
        _activeInlineEditor.style.border = '2px solid var(--accent)';
        _activeInlineEditor.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.3)';
      }
    }
    renderAnnotations();
    _pushHistory();
  }

  // ── SIDE PANEL ─────────────────────────────────────────────────────────────
  function renderSidePanel() {
    document.getElementById('ann-count').textContent = annotations.length;

    const list = document.getElementById('annotations-list');

    if (annotations.length === 0) {
      list.innerHTML = `<div class="empty-state">Draw a shape on the screenshot, then type your note in the box that appears here.</div>`;
      return;
    }

    const typeLabels = { bug: '🐛 Bug', improvement: '💡 Improvement', question: '❓ Question', praise: '✅ Praise' };

    list.innerHTML = annotations.map((ann, i) => {
      const isSelected = ann.id === selectedId;
      const hasNote = ann.note && ann.note.trim().length > 0;
      const shapeLabel = (ann.shape || 'highlight').charAt(0).toUpperCase() + (ann.shape || 'highlight').slice(1);

      const typeBadges = ['bug', 'improvement', 'question', 'praise'].map(t =>
        `<span class="type-badge ${ann.type === t ? 'active-' + t : ''}" onclick="setAnnType(${ann.id},'${t}')">${typeLabels[t]}</span>`
      ).join('');

      // Expanded body (textarea + type badges) only shown for selected annotation
      const isTextAnn = (ann.shape === 'text');
      const textInput = isTextAnn ? `
          <div class="ann-note-wrap">
            <label style="font-size:11px;color:var(--muted);margin-bottom:2px;display:block">Display text:</label>
            <textarea class="ann-note ann-text-input" style="font-weight:600;${!ann.text ? 'border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,0.2)' : ''}" placeholder="Type text to show on image…" oninput="updateTextContent(${ann.id},this.value)">${ann.text || ''}</textarea>
            <label style="font-size:11px;color:var(--muted);margin-bottom:2px;margin-top:6px;display:block">Font size:</label>
            <input type="range" min="10" max="72" value="${ann.fontSize || 18}" oninput="updateFontSize(${ann.id},this.value)" style="width:100%">
          </div>` : '';
      const noteInput = `
          <div class="ann-note-wrap">
            ${!isTextAnn && !hasNote ? '<div style="font-size:11px;color:#3b82f6;margin-bottom:4px">Click to type your note</div>' : ''}
            <textarea class="ann-note" style="${!hasNote ? 'border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,0.2)' : ''}" placeholder="What needs to change here? Be specific…" oninput="updateNote(${ann.id},this.value)">${ann.note}</textarea>
          </div>`;
      const body = isSelected ? `
          ${textInput}
          ${noteInput}
          <div class="ann-type-row">${typeBadges}</div>` : '';

      return `
        <div class="annotation-item${isSelected ? ' selected' : ''}" data-ann-id="${ann.id}">
          <div class="ann-header" onclick="selectAnnotation(${ann.id})">
            <span class="ann-color-dot" style="background:${ann.color}"></span>
            <span class="ann-num" style="color:${ann.color}">#${i + 1}</span>
            <span style="font-size:10px;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;margin-right:4px">${shapeLabel}</span>
            <span class="ann-label" style="flex:1;font-size:11px;color:${isTextAnn ? (ann.text ? 'var(--text)' : 'var(--muted)') : (hasNote ? 'var(--text)' : 'var(--muted)')}">${isTextAnn ? (ann.text ? ann.text.slice(0, 38) + (ann.text.length > 38 ? '…' : '') : 'no text yet') : (hasNote ? ann.note.slice(0, 38) + (ann.note.length > 38 ? '…' : '') : 'no note yet')}</span>
            <span class="ann-delete" onclick="event.stopPropagation();deleteAnnotation(${ann.id})">×</span>
          </div>
          ${body}
        </div>`;
    }).join('');
  }

  function selectAnnotation(id) {
    selectedId = id;
    renderAnnotations();
    renderSidePanel();
    // Focus the textarea for the newly selected annotation
    setTimeout(() => {
      const ta = document.querySelector(`[data-ann-id="${id}"] textarea`);
      if (ta) ta.focus();
    }, 30);
  }

  function deleteAnnotation(id) {
    annotations = annotations.filter(a => a.id !== id);
    if (selectedId === id) selectedId = null;
    renderAnnotations();
    renderSidePanel();
    updatePrompt();
    _pushHistory();
  }

  function updateNote(id, val) {
    const ann = annotations.find(a => a.id === id);
    if (!ann) return;
    ann.note = val;
    updatePrompt();
    // Update only the label preview — don't re-render the whole panel (would reset focus/scroll)
    const label = document.querySelector(`[data-ann-id="${id}"] .ann-label`);
    if (label) {
      const hasNote = val.trim().length > 0;
      label.textContent = hasNote ? val.slice(0, 38) + (val.length > 38 ? '…' : '') : 'no note yet';
      label.style.color = hasNote ? 'var(--text)' : 'var(--muted)';
    }
    // Remove the blue hint once user starts typing
    const hint = document.querySelector(`[data-ann-id="${id}"] .ann-note-wrap div`);
    if (hint && val.trim().length > 0) hint.style.display = 'none';
  }

  function updateTextContent(id, val) {
    const ann = annotations.find(a => a.id === id);
    if (!ann) return;
    ann.text = val;
    renderAnnotations();
    updatePrompt();
    // Update header label
    const label = document.querySelector(`[data-ann-id="${id}"] .ann-label`);
    if (label) {
      const preview = val.trim() ? val.slice(0, 38) + (val.length > 38 ? '…' : '') : 'no text yet';
      label.textContent = preview;
      label.style.color = val.trim() ? 'var(--text)' : 'var(--muted)';
    }
  }

  function updateFontSize(id, val) {
    const ann = annotations.find(a => a.id === id);
    if (!ann) return;
    ann.fontSize = parseInt(val);
    renderAnnotations();
  }

  function setAnnType(id, type) {
    const ann = annotations.find(a => a.id === id);
    if (ann) ann.type = type;
    renderSidePanel();
    updatePrompt();
    _pushHistory();
  }

  // ── PROMPT GENERATION ──────────────────────────────────────────────────────
  let _promptManuallyEdited = false;

  function buildPromptText() {
    const context = document.getElementById('context-input').value.trim();
    const typeEmoji = { bug: '🐛', improvement: '💡', question: '❓', praise: '✅' };
    const groups = { bug: [], improvement: [], question: [], praise: [] };
    annotations.forEach((ann, i) => {
      const desc = ann.shape === 'text'
        ? (ann.text ? `[Text: "${ann.text}"] ` : '') + (ann.note || '(no note added)')
        : (ann.note || '(no note added)');
      groups[ann.type || 'improvement'].push({ num: i + 1, note: desc });
    });
    const lines = [];
    if (context) lines.push('Context: ' + context + '\n');
    lines.push("I've annotated a screenshot with " + annotations.length + ' note' + (annotations.length !== 1 ? 's' : '') + '. Please apply the following feedback:\n');
    ['bug', 'improvement', 'question', 'praise'].forEach(type => {
      if (groups[type].length > 0) {
        lines.push(typeEmoji[type] + ' ' + type.charAt(0).toUpperCase() + type.slice(1) + 's:');
        groups[type].forEach(item => lines.push('  #' + item.num + ': ' + item.note));
        lines.push('');
      }
    });
    lines.push('Please make all changes in the file, keeping the same overall structure. Address each numbered item.');
    return lines.join('\n');
  }

  function updatePrompt() {
    if (_promptManuallyEdited) return;
    const box = document.getElementById('prompt-box');
    if (annotations.length === 0) {
      box.value = 'Add annotations to generate a feedback prompt.';
      return;
    }
    box.value = buildPromptText();
  }

  function resetPrompt() {
    _promptManuallyEdited = false;
    const box = document.getElementById('prompt-box');
    box.value = annotations.length === 0 ? 'Add annotations to generate a feedback prompt.' : buildPromptText();
    const btn = document.getElementById('prompt-reset-btn');
    if (btn) btn.classList.remove('modified');
  }

  function onPromptEdit(val) {
    _promptManuallyEdited = true;
    const btn = document.getElementById('prompt-reset-btn');
    if (btn) btn.classList.add('modified');
    // Parse #N: lines back to annotation notes (bi-directional sync)
    val.split('\n').forEach(line => {
      const m = line.match(/^\s*#(\d+):\s*(.*)/);
      if (!m) return;
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < annotations.length) annotations[idx].note = m[2].trim();
    });
    renderSidePanel();
    // Mirror to overlay if open
    const ov = document.getElementById('prompt-overlay-textarea');
    if (ov && ov.value !== val) ov.value = val;
  }

  function onOverlayPromptEdit(val) {
    const box = document.getElementById('prompt-box');
    if (box && box.value !== val) box.value = val;
    onPromptEdit(val);
  }

  function copyPromptFromOverlay() {
    const ov = document.getElementById('prompt-overlay-textarea');
    const box = document.getElementById('prompt-box');
    if (ov && box) box.value = ov.value;
    copyPrompt();
  }

  function toggleOverlay(open) {
    const ov = document.getElementById('prompt-overlay');
    const ta = document.getElementById('prompt-overlay-textarea');
    const box = document.getElementById('prompt-box');
    if (!ov || !ta || !box) return;
    if (open) {
      ta.value = box.value;
      ov.classList.add('open');
      setTimeout(() => ta.focus(), 50);
    } else {
      box.value = ta.value;
      ov.classList.remove('open');
    }
  }

  function copyPrompt() {
    const text = document.getElementById('prompt-box').value;
    if (!text || text === 'Add annotations to generate a feedback prompt.') return;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copy-btn');
      btn.textContent = '✓ Copied!';
      btn.classList.add('success');
      setTimeout(() => { btn.textContent = 'Copy Prompt'; btn.classList.remove('success'); }, 2000);
    });
  }

  // Save path is implicit in Snipalot: the main process writes into
  // {outputDir}/{stamp} screenshot/. The standalone "Set Path" button
  // and localStorage memory are no longer relevant — milestone 4 will
  // route saveSession() through the annotator:save IPC instead.
  function changeSavePath() {
    alert('Save path is set in Snipalot Settings → Output Folder.');
  }

  async function saveSession() {
    if (!image) { alert('Paste a screenshot first before saving.'); return; }

    const saveBtns = [document.getElementById('save-btn'), document.getElementById('toolbar-save-btn')].filter(Boolean);
    const setSaveBtnText = (txt) => saveBtns.forEach(b => {
      const orig = b.dataset.origText || b.textContent;
      b.dataset.origText = orig;
      b.textContent = txt;
    });
    const restoreSaveBtnText = () => saveBtns.forEach(b => {
      if (b.dataset.origText) b.textContent = b.dataset.origText;
    });

    // ── 1. Build the annotated PNG (base + overlays + draw layer + legend) ──
    const composite = document.createElement('canvas');
    composite.width = baseCanvas.width;
    composite.height = baseCanvas.height;
    const cx = composite.getContext('2d');
    cx.drawImage(baseCanvas, 0, 0);
    overlays.forEach(ov => cx.drawImage(ov.imgObj, ov.x, ov.y, ov.w, ov.h));
    cx.drawImage(drawCanvas, 0, 0);

    // Stamp numbered legend at bottom-right corner
    const legendLines = annotations.map((ann, i) => {
      const label = ann.note ? ann.note.slice(0, 60) + (ann.note.length > 60 ? '…' : '') : '(no note)';
      return { num: i + 1, color: ann.color, type: ann.type || 'improvement', label };
    });
    if (legendLines.length > 0) {
      const lineH = 20;
      const padding = 12;
      const legendH = legendLines.length * lineH + padding * 2;
      const legendW = Math.min(composite.width, 600);
      const lx = composite.width - legendW - 12;
      const ly = composite.height - legendH - 12;
      cx.fillStyle = 'rgba(0,0,0,0.78)';
      cx.beginPath();
      cx.roundRect(lx, ly, legendW, legendH, 8);
      cx.fill();
      cx.font = 'bold 12px -apple-system, Arial, sans-serif';
      legendLines.forEach((item, i) => {
        const y = ly + padding + i * lineH + 12;
        cx.fillStyle = item.color;
        cx.fillText(`#${item.num}`, lx + padding, y);
        cx.fillStyle = '#e8eaf6';
        cx.font = '11px -apple-system, Arial, sans-serif';
        cx.fillText(item.label, lx + padding + 30, y);
        cx.font = 'bold 12px -apple-system, Arial, sans-serif';
      });
    }

    // ── 2. Build the prompt body ────────────────────────────────────────────
    // Prefer the user-edited prompt-box content (matches what they actually
    // see in the preview). Fall back to a fresh build if the box is empty
    // or hasn't been touched.
    const promptText =
      (document.getElementById('prompt-box')?.value || '').trim() ||
      buildPromptText();

    // ── 3. Convert composite to data URL and hand off to main ──────────────
    setSaveBtnText('⏳ Saving…');
    const pngDataUrl = composite.toDataURL('image/png');
    try {
      const result = await window.snipalotAnnotator.save({
        pngDataUrl,
        promptText,
        sessionStamp: hostSessionStamp ?? undefined,
      });
      if (result.ok) {
        setSaveBtnText('✓ Saved + prompt copied!');
        void window.snipalotAnnotator.log('save', 'success', {
          sessionDir: result.sessionDir,
        });
        // Main closes the annotator window after this resolves; the toast
        // is just a brief confirmation in case the close hasn't fired yet.
        setTimeout(restoreSaveBtnText, 2500);
      } else {
        setSaveBtnText('✗ Save failed');
        void window.snipalotAnnotator.log('save', 'fail', { error: result.error });
        alert(`Save failed: ${result.error}`);
        setTimeout(restoreSaveBtnText, 3000);
      }
    } catch (err) {
      setSaveBtnText('✗ Save failed');
      void window.snipalotAnnotator.log('save', 'exception', { error: String(err) });
      alert(`Save failed: ${err}`);
      setTimeout(restoreSaveBtnText, 3000);
    }
  }

  function exportAnnotations() {
    const data = JSON.stringify({ annotations, context: document.getElementById('context-input').value }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'annotations.json';
    a.click();
  }

  function clearAll() {
    if (annotations.length === 0 && overlays.length === 0 && !image) return;
    if (!confirm('Clear all annotations and image?')) return;
    annotations = [];
    selectedId = null;
    if (_cropState) { _cleanupCropUI(); }
    overlays.forEach(ov => ov.el.remove());
    overlays = [];
    selectedOverlayId = null;
    image = null;
    displayScale = 1;
    resizeCanvases(1, 1);
    bCtx.clearRect(0, 0, 1, 1);
    dCtx.clearRect(0, 0, 1, 1);
    document.getElementById('drop-zone').style.display = '';
    document.getElementById('canvas-wrap').style.display = 'none';
    document.getElementById('scale-indicator').style.display = 'none';
    renderSidePanel();
    updatePrompt();
  }

  // ── DRAG & DROP IMAGE ──────────────────────────────────────────────────────
  document.getElementById('canvas-area').addEventListener('dragover', e => e.preventDefault());
  document.getElementById('canvas-area').addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) loadImageBlob(file);
  });

  // ── INIT ───────────────────────────────────────────────────────────────────
  resizeCanvases(800, 500);
  renderSidePanel();
  _pushHistory(); // initial empty state

  // ── SIDEBAR RESIZE HANDLES ─────────────────────────────────────────────────
  (function() {
    function makeResizable(handleId, topElId) {
      const handle = document.getElementById(handleId);
      if (!handle) return;
      let startY, startH;
      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        startY = e.clientY;
        startH = document.getElementById(topElId).getBoundingClientRect().height;
        handle.classList.add('dragging');
        const onMove = e => {
          const el = document.getElementById(topElId);
          el.style.height = Math.max(48, startH + (e.clientY - startY)) + 'px';
          el.style.flex = 'none';
        };
        const onUp = () => {
          handle.classList.remove('dragging');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
    makeResizable('rh-ann', 'annotations-list');
    makeResizable('rh-ctx', 'context-section');
  })();

  // ── SIDEBAR AUTO-SYNC LOOP ──────────────────────────────────────────────────
  // Drives the sidebar from a rAF loop so it always reflects ground truth,
  // regardless of any timing/ordering issue in the event-driven calls.
  let _lastAnnLen = -1;
  let _lastSelectedId = undefined;
  let _lastHasChanges = false;
  function _syncLoop() {
    if (annotations.length !== _lastAnnLen || selectedId !== _lastSelectedId) {
      _lastAnnLen = annotations.length;
      _lastSelectedId = selectedId;
      renderSidePanel();
    }
    // Show toolbar save icon whenever there's anything to save
    const hasChanges = !!(image && (annotations.length > 0 || overlays.length > 0));
    if (hasChanges !== _lastHasChanges) {
      _lastHasChanges = hasChanges;
      const icon = document.getElementById('toolbar-save-icon');
      if (icon) icon.style.display = hasChanges ? 'inline-block' : 'none';
    }
    requestAnimationFrame(_syncLoop);
  }
  requestAnimationFrame(_syncLoop);

  // ── window bridge for inline event attributes ─────────────────
  // All functions called via onclick="..." in dynamically-generated HTML
  // (renderSidePanel, text-style-bar) must be on window since attribute
  // handlers are evaluated in the global scope, not the IIFE closure.
  Object.assign(window, {
    // Tool + color
    setTool, setShapeTool, setColor, setOpacity, setStrokeWidth,
    // Annotation lifecycle (used in renderSidePanel innerHTML)
    selectAnnotation, deleteAnnotation, updateNote, updateTextContent,
    updateFontSize, setAnnType,
    // Text annotation style controls (text-style-bar)
    setSelectedFontSize, setSelectedFontFamily, setSelectedTextBg, setSelectedBorderColor,
    // Utilities
    triggerPaste, undo, redo, rotateImage, pasteOverlayImage, startCropMode,
    clearAll, changeSavePath, saveSession, copyPrompt,
    copyPromptFromOverlay, toggleOverlay, resetPrompt,
    onPromptEdit, onOverlayPromptEdit, updatePrompt,
  });
})();
