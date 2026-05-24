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

const logEl = document.getElementById('log')!;

interface MicActiveTrackSummary {
  label: string;
  id: string;
  enabled: boolean;
  muted: boolean;
  readyState: string;
  settings: Record<string, unknown>;
}

interface MicDiagnosticsPayload {
  capturedAtIso: string;
  microphoneRequested: boolean;
  microphoneGranted: boolean;
  getUserMediaError: string | null;
  activeAudioTrack: MicActiveTrackSummary | null;
  audioInputDevices: Array<{ deviceId: string; label: string; groupId: string }>;
}

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let displayStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let canvasStream: MediaStream | null = null;
let sourceVideo: HTMLVideoElement | null = null;
let cropCanvas: HTMLCanvasElement | null = null;
let rafHandle: number | null = null;
let pendingFilepath: string | null = null;
let chunkCount = 0;
let chunkBytes = 0;
let lastChunkLifecycleAtMs = 0;
let audioChunkStream: MediaStream | null = null;
let audioChunkRecorder: MediaRecorder | null = null;
let audioChunkBlobs: Blob[] = [];
let audioChunkIndex = 0;
let audioChunkStartMs = 0;
let audioChunkTimer: number | null = null;
let audioChunkStopResolve: (() => void) | null = null;
let audioChunkStopFinal = false;
let rollingAudioActive = false;
let recordingClockStartMs = 0;
let recordingClockPausedAtMs: number | null = null;
let recordingClockPausedTotalMs = 0;

const INCREMENTAL_AUDIO_CHUNK_MS = 30_000;

function log(line: string): void {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = `${logEl.textContent}\n[${ts}] ${line}`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(`[recorder] ${line}`);
  void window.snipalotRecorder.mainLog(line);
}

function lifecycle(event: string, details?: Record<string, unknown>, status: string = 'info'): void {
  void window.snipalotRecorder.lifecycle(event, details, status);
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

function resetRecordingClock(): void {
  recordingClockStartMs = performance.now();
  recordingClockPausedAtMs = null;
  recordingClockPausedTotalMs = 0;
}

function currentRecordingOffsetMs(): number {
  if (!recordingClockStartMs) return 0;
  const now = recordingClockPausedAtMs ?? performance.now();
  return Math.max(0, Math.round(now - recordingClockStartMs - recordingClockPausedTotalMs));
}

function clearAudioChunkTimer(): void {
  if (audioChunkTimer !== null) {
    window.clearTimeout(audioChunkTimer);
    audioChunkTimer = null;
  }
}

function startRollingAudioTranscription(): void {
  if (!micStream || micStream.getAudioTracks().length === 0) {
    lifecycle('incremental audio skipped; no mic stream', undefined, 'skipped');
    return;
  }
  stopRollingAudioTranscriptionSync('restart');
  const audioTrack = micStream.getAudioTracks()[0];
  audioChunkStream = new MediaStream([audioTrack.clone()]);
  rollingAudioActive = true;
  audioChunkIndex = 0;
  lifecycle('incremental audio started', {
    chunkMs: INCREMENTAL_AUDIO_CHUNK_MS,
    trackLabel: audioTrack.label,
  }, 'start');
  startNextAudioChunk();
}

function startNextAudioChunk(): void {
  if (!rollingAudioActive || !audioChunkStream) return;
  audioChunkBlobs = [];
  audioChunkIndex += 1;
  audioChunkStartMs = currentRecordingOffsetMs();
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  try {
    audioChunkRecorder = new MediaRecorder(audioChunkStream, { mimeType });
  } catch (err) {
    lifecycle('incremental audio recorder construction failed', {
      error: (err as Error).message,
      mimeType,
    }, 'warning');
    rollingAudioActive = false;
    return;
  }

  const index = audioChunkIndex;
  audioChunkRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) audioChunkBlobs.push(event.data);
  };
  audioChunkRecorder.onstop = async () => {
    const final = audioChunkStopFinal;
    const resolve = audioChunkStopResolve;
    audioChunkStopFinal = false;
    audioChunkStopResolve = null;
    clearAudioChunkTimer();
    const endMs = Math.max(audioChunkStartMs + 1, currentRecordingOffsetMs());
    const blob = new Blob(audioChunkBlobs, { type: mimeType });
    audioChunkBlobs = [];
    if (blob.size > 0) {
      try {
        const buffer = await blob.arrayBuffer();
        await window.snipalotRecorder.sendAudioChunk({
          buffer,
          index,
          startMs: audioChunkStartMs,
          endMs,
          mimeType,
          final,
        });
        lifecycle('incremental audio chunk sent', {
          index,
          startMs: audioChunkStartMs,
          endMs,
          bytes: buffer.byteLength,
          final,
        }, 'success');
      } catch (err) {
        lifecycle('incremental audio chunk send failed', {
          index,
          error: (err as Error).message,
        }, 'warning');
      }
    }
    audioChunkRecorder = null;
    if (!final && rollingAudioActive && mediaRecorder && mediaRecorder.state !== 'inactive') {
      startNextAudioChunk();
    }
    resolve?.();
  };
  audioChunkRecorder.onerror = (event) => {
    lifecycle('incremental audio recorder error', {
      index,
      error: String((event as ErrorEvent).message ?? event.type),
    }, 'warning');
  };
  audioChunkRecorder.start();
  audioChunkTimer = window.setTimeout(() => {
    void stopCurrentAudioChunk(false);
  }, INCREMENTAL_AUDIO_CHUNK_MS);
}

function stopCurrentAudioChunk(final: boolean): Promise<void> {
  clearAudioChunkTimer();
  if (audioChunkStopResolve) {
    if (final) audioChunkStopFinal = true;
    return new Promise((resolve) => {
      const previousResolve = audioChunkStopResolve;
      audioChunkStopResolve = () => {
        previousResolve?.();
        resolve();
      };
    });
  }
  const recorder = audioChunkRecorder;
  if (!recorder || recorder.state === 'inactive') return Promise.resolve();
  return new Promise((resolve) => {
    audioChunkStopResolve = resolve;
    audioChunkStopFinal = final;
    try {
      recorder.stop();
    } catch {
      audioChunkStopResolve = null;
      audioChunkStopFinal = false;
      resolve();
    }
  });
}

async function stopRollingAudioTranscription(final: boolean): Promise<void> {
  rollingAudioActive = false;
  await stopCurrentAudioChunk(final);
  stopRollingAudioTranscriptionSync('stop');
}

function stopRollingAudioTranscriptionSync(reason: string): void {
  clearAudioChunkTimer();
  rollingAudioActive = false;
  if (audioChunkRecorder && audioChunkRecorder.state !== 'inactive') {
    try { audioChunkRecorder.stop(); } catch { /* ignore */ }
  }
  audioChunkRecorder = null;
  audioChunkBlobs = [];
  if (audioChunkStream) {
    for (const track of audioChunkStream.getTracks()) track.stop();
    audioChunkStream = null;
  }
  audioChunkStopResolve = null;
  audioChunkStopFinal = false;
  lifecycle('incremental audio stopped', { reason }, 'info');
}

async function startRecording(region: RecorderRegion): Promise<void> {
  lifecycle('renderer start received', { region }, 'start');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    log('already recording, ignoring start');
    lifecycle('renderer start ignored because already recording', {
      mediaRecorderState: mediaRecorder.state,
      chunkCount,
      chunkBytes,
    }, 'warning');
    return;
  }

  try {
    // 1. Full-screen capture. The main-process display-media handler resolves
    //    this to the primary screen source.
    // Windows: fullscreen overlay is alwaysOnTop 'screen-saver' — the OS
    // screen-share dialog can open behind it; main lowers overlays first.
    log('calling getDisplayMedia (watch for Windows "pick what to share")…');
    lifecycle('getDisplayMedia requested', { frameRate: 30 });
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
    const displayTracks = displayStream.getVideoTracks();
    lifecycle('getDisplayMedia resolved', {
      videoTrackCount: displayTracks.length,
      tracks: displayTracks.map((t) => ({
        label: t.label,
        id: t.id,
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
        settings: pickJsonSafeSettings(t),
      })),
    }, displayTracks.length > 0 ? 'success' : 'warning');

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
    lifecycle('recording crop computed', {
      sourceWidth: srcW,
      sourceHeight: srcH,
      cropX,
      cropY,
      cropWidth: outW,
      cropHeight: outH,
      region,
    });

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
      lifecycle('getUserMedia audio requested');
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      lifecycle('getUserMedia audio resolved', {
        audioTrackCount: micStream.getAudioTracks().length,
      }, 'success');
    } catch (err) {
      micGetUserMediaError = (err as Error).message;
      log(`mic unavailable, continuing without audio: ${micGetUserMediaError}`);
      lifecycle('getUserMedia audio failed', { error: micGetUserMediaError }, 'warning');
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
        lifecycle('display track ended', {
          label: t.label,
          id: t.id,
          readyState: t.readyState,
        }, 'warning');
        stopRecording();
      });
    }

    chunks = [];
    chunkCount = 0;
    chunkBytes = 0;
    lastChunkLifecycleAtMs = 0;
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
    mediaRecorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 4_000_000 });
    lifecycle('MediaRecorder constructed', {
      mimeType,
      videoBitsPerSecond: 4_000_000,
      combinedVideoTracks: combined.getVideoTracks().length,
      combinedAudioTracks: combined.getAudioTracks().length,
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunks.push(e.data);
        chunkCount += 1;
        chunkBytes += e.data.size;
        const now = Date.now();
        if (chunkCount === 1 || now - lastChunkLifecycleAtMs >= 10_000) {
          lastChunkLifecycleAtMs = now;
          lifecycle('MediaRecorder data chunk', {
            chunkCount,
            chunkBytes,
            lastChunkBytes: e.data.size,
            mediaRecorderState: mediaRecorder?.state ?? null,
          });
        }
      }
    };

    mediaRecorder.onstop = async () => {
      log('stopped; assembling blob');
      lifecycle('MediaRecorder onstop fired', {
        chunkCount,
        chunkBytes,
      }, 'start');
      await stopRollingAudioTranscription(true);
      const blob = new Blob(chunks, { type: 'video/webm' });
      const buffer = await blob.arrayBuffer();
      lifecycle('webm blob assembled', {
        blobBytes: blob.size,
        bufferBytes: buffer.byteLength,
        chunkCount,
        chunkBytes,
      }, blob.size > 0 ? 'success' : 'error');
      // Tell main we're done capturing BEFORE starting the save. Main's
      // save-webm handler is now fire-and-forget (returns immediately while
      // the pipeline runs in the background), so reporting first gives main
      // a tidy stopped event and doesn't actually delay anything — but it
      // keeps the ordering readable.
      window.snipalotRecorder.reportState('stopped');
      cleanup();
      const filepath = pendingFilepath ?? (await window.snipalotRecorder.getOutputPath());
      lifecycle('save-webm ipc sending', {
        filepath,
        bufferBytes: buffer.byteLength,
      }, 'start');
      const result = await window.snipalotRecorder.saveWebm({ buffer, filepath });
      log(`save-webm IPC returned: ${JSON.stringify(result)}`);
      lifecycle('save-webm ipc returned', result as Record<string, unknown>, 'success');
    };

    pendingFilepath = await window.snipalotRecorder.getOutputPath();
    lifecycle('temp output path assigned', { pendingFilepath });
    resetRecordingClock();
    mediaRecorder.start(250);
    startRollingAudioTranscription();
    lifecycle('MediaRecorder started', {
      pendingFilepath,
      state: mediaRecorder.state,
      timesliceMs: 250,
    }, 'success');
    log(`recording started → ${pendingFilepath}`);
    window.snipalotRecorder.reportState('started', undefined, micDiagnostics);
  } catch (err) {
    const msg = (err as Error).message;
    log(`start failed: ${msg}`);
    lifecycle('renderer start failed', { error: msg }, 'error');
    cleanup();
    window.snipalotRecorder.reportState('error', msg);
  }
}

function stopRecording(): void {
  lifecycle('renderer stop received', {
    hasMediaRecorder: Boolean(mediaRecorder),
    mediaRecorderState: mediaRecorder?.state ?? null,
    chunkCount,
    chunkBytes,
  }, 'start');
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else {
    log('no active recording to stop');
    lifecycle('renderer stop ignored because no active recorder', {
      hasMediaRecorder: Boolean(mediaRecorder),
      mediaRecorderState: mediaRecorder?.state ?? null,
    }, 'warning');
  }
}

function pauseRecording(): void {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.pause();
    if (audioChunkRecorder && audioChunkRecorder.state === 'recording') {
      audioChunkRecorder.pause();
    }
    if (recordingClockPausedAtMs === null) {
      recordingClockPausedAtMs = performance.now();
    }
    log('paused');
  }
}

function resumeRecording(): void {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    if (recordingClockPausedAtMs !== null) {
      recordingClockPausedTotalMs += performance.now() - recordingClockPausedAtMs;
      recordingClockPausedAtMs = null;
    }
    mediaRecorder.resume();
    if (audioChunkRecorder && audioChunkRecorder.state === 'paused') {
      audioChunkRecorder.resume();
    }
    log('resumed');
  }
}

function cleanup(): void {
  lifecycle('renderer cleanup started', {
    hasCanvasStream: Boolean(canvasStream),
    hasDisplayStream: Boolean(displayStream),
    hasMicStream: Boolean(micStream),
    chunkCount,
    chunkBytes,
  });
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  stopRollingAudioTranscriptionSync('cleanup');
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
  lifecycle('renderer cleanup complete', {
    chunkCount,
    chunkBytes,
  });
}

// ─── wiring ──────────────────────────────────────────────────────────

window.snipalotRecorder.onStart((region) => {
  lifecycle('recorder:start ipc received', { region }, 'start');
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
  lifecycle('recorder:stop ipc received', undefined, 'start');
  stopRecording();
});

window.snipalotRecorder.onPause(() => {
  pauseRecording();
});

window.snipalotRecorder.onResume(() => {
  resumeRecording();
});

void window.snipalotRecorder.reportReady();
lifecycle('renderer ready reported');
log('recorder ready · awaiting region-select');
