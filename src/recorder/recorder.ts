/**
 * Snipalot recorder renderer (hidden in production).
 *
 * Gets the full primary-display stream via getDisplayMedia (routed through
 * main's setDisplayMediaRequestHandler), pipes it into a hidden <video>, then
 * composites the user-chosen region into an offscreen <canvas> via drawImage
 * on every animation frame. The canvas's captureStream() feeds MediaRecorder,
 * so the on-disk webm is already cropped to the region (no post-processing
 * crop pass required).
 *
 * Region coordinates come in as percentages (xPct, yPct, wPct, hPct) of the
 * primary display, which makes the math resolution-independent: we multiply
 * by video.videoWidth / video.videoHeight (the native pixel dimensions of
 * the captured stream) to recover source-pixel coordinates.
 */

import type { MicActiveTrackSummary, MicDiagnosticsPayload } from '../shared/mic-diagnostics';

const logEl = document.getElementById('log')!;

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let displayStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let canvasStream: MediaStream | null = null;
let sourceVideo: HTMLVideoElement | null = null;
let cropCanvas: HTMLCanvasElement | null = null;
let rafHandle: number | null = null;
let pendingFilepath: string | null = null;

function log(line: string): void {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = `${logEl.textContent}\n[${ts}] ${line}`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(`[recorder] ${line}`);
  void window.snipalotRecorder.mainLog(line);
}

function pickJsonSafeSettings(track: MediaStreamTrack): Record<string, unknown> {
  const s = track.getSettings();
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s) as (keyof MediaTrackSettings)[]) {
    const v = s[k];
    if (v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

/**
 * After getUserMedia, capture which mic was bound and enumerate audio inputs
 * for support/debug (written to mic_diagnostics.json by main).
 */
async function collectMicDiagnostics(
  mic: MediaStream | null,
  getUserMediaError: string | null
): Promise<MicDiagnosticsPayload> {
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    devices = [];
  }
  const audioInputDevices = devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label || '(no label — grant mic permission to see names)',
      groupId: d.groupId,
    }));

  let activeAudioTrack: MicActiveTrackSummary | null = null;
  if (mic) {
    const t = mic.getAudioTracks()[0];
    if (t) {
      activeAudioTrack = {
        label: t.label || '(no label)',
        id: t.id,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
        settings: pickJsonSafeSettings(t),
      };
    }
  }

  return {
    capturedAtIso: new Date().toISOString(),
    microphoneRequested: true,
    microphoneGranted: mic !== null,
    getUserMediaError,
    activeAudioTrack,
    audioInputDevices,
  };
}

async function startRecording(region: RecorderRegion): Promise<void> {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    log('already recording, ignoring start');
    return;
  }

  try {
    // 1. Full-screen capture. The main-process display-media handler resolves
    //    this to the primary screen source.
    // Windows: fullscreen overlay is alwaysOnTop 'screen-saver' — the OS
    // screen-share dialog can open behind it; main lowers overlays first.
    log('calling getDisplayMedia (watch for Windows "pick what to share")…');
    await window.snipalotRecorder.prepareDisplayCapture();
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 } as MediaTrackConstraints,
        audio: false,
      });
    } finally {
      await window.snipalotRecorder.restoreDisplayCapture();
    }
    log('getDisplayMedia resolved');

    // 2. Pipe the stream into a hidden video element so we can read frames.
    sourceVideo = document.createElement('video');
    sourceVideo.srcObject = displayStream;
    sourceVideo.muted = true;
    sourceVideo.playsInline = true;
    await sourceVideo.play();
    // Wait for metadata so videoWidth/videoHeight are known.
    await new Promise<void>((resolve) => {
      if (sourceVideo!.videoWidth > 0) {
        resolve();
        return;
      }
      sourceVideo!.addEventListener('loadedmetadata', () => resolve(), { once: true });
    });

    const srcW = sourceVideo.videoWidth;
    const srcH = sourceVideo.videoHeight;
    if (!srcW || !srcH) throw new Error('display stream has zero dimensions');

    // Map region percentages to source-pixel coordinates.
    const cropX = Math.max(0, Math.round(region.xPct * srcW));
    const cropY = Math.max(0, Math.round(region.yPct * srcH));
    const cropW = Math.max(2, Math.round(region.wPct * srcW));
    const cropH = Math.max(2, Math.round(region.hPct * srcH));
    // Even dimensions help encoders (especially vp9).
    const outW = cropW % 2 === 0 ? cropW : cropW - 1;
    const outH = cropH % 2 === 0 ? cropH : cropH - 1;

    log(`source ${srcW}×${srcH}  →  crop ${outW}×${outH} at (${cropX},${cropY})`);

    // 3. Offscreen canvas sized to the crop; drawImage copies the region.
    cropCanvas = document.createElement('canvas');
    cropCanvas.width = outW;
    cropCanvas.height = outH;
    const cctx = cropCanvas.getContext('2d');
    if (!cctx) throw new Error('failed to get 2d context on crop canvas');

    const drawFrame = () => {
      if (!sourceVideo || !cropCanvas) return;
      try {
        cctx.drawImage(sourceVideo, cropX, cropY, outW, outH, 0, 0, outW, outH);
      } catch {
        // Swallow transient drawImage failures while the source video is (re)initializing.
      }
      rafHandle = requestAnimationFrame(drawFrame);
    };
    drawFrame();

    // 4. Mic (best-effort). No system audio in this build.
    let micGetUserMediaError: string | null = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      micGetUserMediaError = (err as Error).message;
      log(`mic unavailable, continuing without audio: ${micGetUserMediaError}`);
      micStream = null;
    }
    const micDiagnostics = await collectMicDiagnostics(micStream, micGetUserMediaError);
    if (micDiagnostics.activeAudioTrack) {
      log(
        `mic track: ${micDiagnostics.activeAudioTrack.label} ` +
          `(deviceId in settings: ${String(micDiagnostics.activeAudioTrack.settings.deviceId ?? 'n/a')})`
      );
    } else if (!micDiagnostics.microphoneGranted) {
      log('mic: no audio track (getUserMedia failed or returned no audio)');
    }

    // 5. Combine canvas video + mic audio into one stream for MediaRecorder.
    canvasStream = cropCanvas.captureStream(30);
    const combined = new MediaStream();
    for (const t of canvasStream.getVideoTracks()) combined.addTrack(t);
    if (micStream) for (const t of micStream.getAudioTracks()) combined.addTrack(t);

    // 6. Watch the source track — if it ends (user closed the display source),
    //    treat that as a graceful stop.
    for (const t of displayStream.getVideoTracks()) {
      t.addEventListener('ended', () => {
        log('display track ended; stopping');
        stopRecording();
      });
    }

    chunks = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
    mediaRecorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 4_000_000 });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      log('stopped; assembling blob');
      const blob = new Blob(chunks, { type: 'video/webm' });
      const buffer = await blob.arrayBuffer();
      // Tell main we're done capturing BEFORE starting the save. Main's
      // save-webm handler is now fire-and-forget (returns immediately while
      // the pipeline runs in the background), so reporting first gives main
      // a tidy stopped event and doesn't actually delay anything — but it
      // keeps the ordering readable.
      window.snipalotRecorder.reportState('stopped');
      cleanup();
      const filepath = pendingFilepath ?? (await window.snipalotRecorder.getOutputPath());
      const result = await window.snipalotRecorder.saveWebm({ buffer, filepath });
      log(`save-webm IPC returned: ${JSON.stringify(result)}`);
    };

    pendingFilepath = await window.snipalotRecorder.getOutputPath();
    mediaRecorder.start(250);
    log(`recording started → ${pendingFilepath}`);
    window.snipalotRecorder.reportState('started', undefined, micDiagnostics);
  } catch (err) {
    const msg = (err as Error).message;
    log(`start failed: ${msg}`);
    cleanup();
    window.snipalotRecorder.reportState('error', msg);
  }
}

function stopRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    log('no active recording to stop');
  }
}

function pauseRecording(): void {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    log('paused');
  }
}

function resumeRecording(): void {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    mediaRecorder.resume();
    log('resumed');
  }
}

function cleanup(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (canvasStream) {
    for (const t of canvasStream.getTracks()) t.stop();
    canvasStream = null;
  }
  if (displayStream) {
    for (const t of displayStream.getTracks()) t.stop();
    displayStream = null;
  }
  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
  }
  if (sourceVideo) {
    sourceVideo.srcObject = null;
    sourceVideo = null;
  }
  cropCanvas = null;
  mediaRecorder = null;
}

// ─── wiring ──────────────────────────────────────────────────────────

window.snipalotRecorder.onStart((region) => {
  startRecording(region);
});

window.snipalotRecorder.onSnap(() => {
  if (!cropCanvas) {
    window.snipalotRecorder.reportSnap(null);
    return;
  }
  cropCanvas.toBlob((blob) => {
    if (!blob) {
      window.snipalotRecorder.reportSnap(null);
      return;
    }
    blob.arrayBuffer().then((buf) => window.snipalotRecorder.reportSnap(buf));
  }, 'image/png');
});

window.snipalotRecorder.onStop(() => {
  stopRecording();
});

window.snipalotRecorder.onPause(() => {
  pauseRecording();
});

window.snipalotRecorder.onResume(() => {
  resumeRecording();
});

log('recorder ready · awaiting region-select');
window.snipalotRecorder.ready().catch((err) => {
  log(`failed to notify main of recorder readiness: ${(err as Error).message}`);
});
