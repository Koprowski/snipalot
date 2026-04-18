/**
 * Snipalot Frame Picker.
 *
 * Opens after the pipeline completes. Loads the session's recording.mp4
 * into an HTML5 <video> element, lets the user scrub to any moment, and
 * exports the current frame as an exported-MM-SS.png via ffmpeg.
 */

const playerEl = document.getElementById('player') as HTMLVideoElement;
const timeEl = document.getElementById('time-display')!;
const btnExportEl = document.getElementById('btn-export') as HTMLButtonElement;
const fpStatusEl = document.getElementById('status')!;
const sessionDirEl = document.getElementById('session-dir')!;

let sessionDir = '';

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

playerEl.addEventListener('timeupdate', () => {
  timeEl.textContent = formatTime(playerEl.currentTime);
});

playerEl.addEventListener('seeked', () => {
  timeEl.textContent = formatTime(playerEl.currentTime);
});

btnExportEl.addEventListener('click', async () => {
  if (!sessionDir) return;
  btnExportEl.disabled = true;
  fpStatusEl.textContent = 'Exporting…';
  fpStatusEl.className = 'status';
  try {
    const result = await window.snipalotFramePicker.exportFrame(playerEl.currentTime, sessionDir);
    if (result.ok && result.path) {
      fpStatusEl.textContent = `Saved → ${result.path}`;
    } else {
      fpStatusEl.textContent = `Export failed: ${result.error ?? 'unknown error'}`;
      fpStatusEl.className = 'status error';
    }
  } catch (err) {
    fpStatusEl.textContent = `Export error: ${(err as Error).message}`;
    fpStatusEl.className = 'status error';
  } finally {
    btnExportEl.disabled = false;
  }
});

window.snipalotFramePicker.onInit((payload) => {
  sessionDir = payload.sessionDir;
  sessionDirEl.textContent = payload.sessionDir;
  sessionDirEl.title = payload.sessionDir;
  // Load the mp4 via file:// URL so the <video> element can play it.
  playerEl.src = `file:///${payload.mp4Path.replace(/\\/g, '/')}`;
  playerEl.load();
});
