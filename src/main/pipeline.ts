/**
 * Snipalot post-processing pipeline.
 *
 * On recording stop, the recorder renderer hands main a webm buffer. From
 * there this module:
 *
 *   1. creates a session folder named "YYYYMMDD.HHMM feedback/"
 *   2. writes the webm, transcodes to mp4 (H.264 + AAC) via ffmpeg-static
 *   3. extracts a 16 kHz mono WAV (for Whisper)
 *   4. runs whisper.cpp on the WAV, parses the SRT into
 *      "[M:SS - M:SS] text" lines, writes transcript.txt
 *   5. renders a readable time-lapse GIF with a burned-in timecode overlay
 *   6. writes annotations.json using the snapshot main has been collecting
 *      from the overlay
 *   7. builds prompt.txt referencing absolute paths to every artifact and
 *      copies it to the clipboard
 *   8. cleans up intermediate files (.webm, .wav)
 *
 * Whisper + ffmpeg are optional from the pipeline's perspective: if a
 * binary or model is missing, that stage is skipped gracefully, a note
 * goes in the prompt, and the remaining artifacts still land.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { app, clipboard } from 'electron';
import { log } from './logger';
import { writeSessionLog } from './session-log';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegPathRaw: string | null = require('ffmpeg-static');

function resolveFfmpegPath(rawPath: string | null): string | null {
  if (!rawPath) return null;
  const unpackedFromRaw = rawPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const candidates = [
    // In packaged Electron apps, require('ffmpeg-static') can resolve to the
    // virtual app.asar path. fs.existsSync can return true for that path, but
    // Windows cannot spawn an executable from inside the asar archive. Prefer
    // the real unpacked executable before considering the raw path.
    unpackedFromRaw,
    app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
      : '',
    rawPath.includes(`${path.sep}app.asar${path.sep}`) ? '' : rawPath,
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
  ].filter((candidate, index, arr) => Boolean(candidate) && arr.indexOf(candidate) === index);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  log('ffmpeg', 'binary not found in known locations', { rawPath, candidates });
  return rawPath;
}

const ffmpegPath = resolveFfmpegPath(ffmpegPathRaw);
const GIF_PREVIEW_MAX_WIDTH = 1600;

/**
 * Annotation schema v2 (discriminated union). Mirrors the shape types the
 * overlay produces; typed here as a loose record so pipeline-side callers
 * don't need to re-derive the union.
 */
export type FeedbackType = 'bug' | 'improvement' | 'question' | 'praise';

export interface AnnotationRecord {
  id?: string;
  shape?: 'rect' | 'circle' | 'oval' | 'line' | 'arrow' | 'text';
  number: number;
  /** Common rect/circle/oval fields. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Line/arrow endpoints. */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** Text shape. */
  text?: string;
  fontSize?: number;
  color?: string;
  strokeWidth?: number;
  drawnAtMs: number;
  type?: FeedbackType;
  /** Filled in by the pipeline from the transcript word bucket. */
  note?: string;
}

/**
 * Snapshot chapter: a bounded slice of the recording closed off by a 📸 press.
 * Main collects these during recording; the pipeline emits one folder per chapter.
 */
export interface ChapterRecord {
  /** 1-based snapshot number. */
  snapshotIndex: number;
  /** Ms offset from recording start at which the snapshot fired. */
  capturedAtMs: number;
  /** Annotations that were on the overlay at the moment 📸 was pressed. */
  annotations: AnnotationRecord[];
  /**
   * Path to a PNG captured live at the snapshot moment (already written by
   * main in hud:snap). Optional: the pipeline falls back to extractFrameAt
   * if it's missing.
   */
  pngPath?: string;
  /** "snapshot-1" etc. — folder name inside snapshots/. */
  folderName: string;
}

export interface TradeMarkerRecord {
  offsetMs: number;
  offsetLabel: string;
  screenshotPath?: string;
}

export interface PipelineInput {
  /** Raw webm buffer from the recorder renderer. */
  webmBuffer: Buffer;
  /** Path to the app's output root (spike-output/ in dev). */
  outputRoot: string;
  /** Recording start timestamp (Date.now() ms). */
  startedAtMs: number;
  /** Recording duration in ms (end - start, pause time subtracted). */
  durationMs: number;
  /** Region coordinates in display-local CSS pixels. */
  recordingRegion: { x: number; y: number; w: number; h: number } | null;
  /** Annotation snapshot at stop time (the tail chapter, if any). */
  annotations: AnnotationRecord[];
  /**
   * Snapshot chapters accumulated during recording. Empty array ⇒ legacy
   * single-prompt behaviour.
   */
  chapters?: ChapterRecord[];
  /**
   * Session directory that was pre-created during recording (for live snaps).
   * If provided, the pipeline writes into this directory instead of computing
   * a new one from startedAtMs.
   */
  preCreatedSessionDir?: string;
  /**
   * Optional progress callback. Pipeline invokes this at the start of each
   * major stage (transcode, transcribe, gif, frames, prompt) so the caller
   * can surface progress to the UI. Errors thrown inside this callback are
   * swallowed; never let UI bookkeeping break the pipeline.
   */
  onStep?: (step: string) => void;
  /**
   * Capture mode that produced this recording. Determines downstream output
   * shape and folder-name suffix.
   *  - 'record' (default): existing feedback-walkthrough flow → `{stamp} feedback/`
   *  - 'trade':            TradeCall flow → `{stamp} trade/`, runs trade-pipeline
   *                        for LLM extraction + CSV/MD log after whisper.
   */
  mode?: 'record' | 'trade';
  /**
   * Trade-mode hotkey markers (recording-relative ms). Empty / undefined when
   * mode === 'record' or when the user never pressed the trade-marker hotkey during a
   * trade session. Markers are anchor points for the LLM extraction prompt;
   * extraction works without them, just less precisely.
   */
  tradeMarkers?: TradeMarkerRecord[];
  /**
   * Called by trade-pipeline once prompt.txt is written. index.ts
   * supplies this to open the response-paste window, eliminating the manual
   * "save extraction_response.json to disk" step. Optional — if omitted the
   * pipeline falls back to the disk-poll-only path.
   */
  onTradePromptReady?: (sessionDir: string, responsePath: string, promptPath: string) => void;
  /** Cancellation signal for an in-flight processing run. */
  abortSignal?: AbortSignal;
  /**
   * Transcript work already performed while the recording was live. When this
   * resolves cleanly, runPipeline writes transcript.txt from it instead of
   * re-running Whisper over the final WebM after stop.
   */
  incrementalTranscript?: Promise<IncrementalTranscriptionResult | null>;
  /**
   * Record-mode media artifact switches. Trade sessions ignore these and
   * always generate the MP4/GIF artifacts their reports expect.
   */
  feedbackOutputs?: {
    generateMp4?: boolean;
    generateGif?: boolean;
  };
}

export interface PipelineResult {
  sessionDir: string;
  mp4Path: string;
  transcriptPath: string | null;
  annotationsPath: string;
  promptPath: string;
  framePaths: string[];
  promptText: string;
  warnings: string[];
}

export interface IncrementalTranscriptionResult {
  segments: TranscriptSegment[];
  diagnostics: ChunkAudioDiagnostic[];
  chunkCount: number;
  failedChunks: number;
  warnings: string[];
}

export interface IncrementalTranscriptionChunkResult {
  index: number;
  startSec: number;
  endSec: number;
  segments: TranscriptSegment[];
  diagnostic: ChunkAudioDiagnostic;
}

export type DiscardedTradeAuditStatus =
  | 'potential_trade_activity'
  | 'no_trade_evidence'
  | 'review_incomplete';

export interface DiscardedTradeAuditInput {
  webmBuffer: Buffer;
  sessionDir: string;
  startedAtMs: number;
  durationMs: number;
  annotations: AnnotationRecord[];
  chapters: ChapterRecord[];
  tradeMarkers: TradeMarkerRecord[];
  abortSignal?: AbortSignal;
}

export interface DiscardedTradeAuditResult {
  sessionDir: string;
  inputsDir: string;
  status: DiscardedTradeAuditStatus;
  suspected: boolean;
  retainedWebm: boolean;
  webmPath: string;
  transcriptPath: string | null;
  reviewJsonPath: string;
  reviewMarkdownPath: string;
  suspectedTradeTimestamps: string[];
  comments: string;
  markerCount: number;
  evidenceCount: number;
  warnings: string[];
}

// ─── file layout ─────────────────────────────────────────────────────

export function formatSessionStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `.${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── ffmpeg helpers ──────────────────────────────────────────────────

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new Error('Processing abandoned.');
  }
}

function runFfmpeg(args: string[], label: string, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(abortSignal);
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static did not resolve a binary path'));
      return;
    }
    log('ffmpeg', label, { args, ffmpegPath });
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('Processing abandoned.'));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      abortSignal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg (${label}) exited ${code}. stderr tail: ${stderr.slice(-500)}`));
      }
    });
  });
}

function runFfmpegCapture(args: string[], label: string, abortSignal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    throwIfAborted(abortSignal);
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static did not resolve a binary path'));
      return;
    }
    log('ffmpeg', label, { args, ffmpegPath });
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('Processing abandoned.'));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      abortSignal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve(stderr);
      } else {
        reject(new Error(`ffmpeg (${label}) exited ${code}. stderr tail: ${stderr.slice(-500)}`));
      }
    });
  });
}

async function webmToMp4(webmPath: string, mp4Path: string, abortSignal?: AbortSignal): Promise<void> {
  // Force CFR 30fps. MediaRecorder emits variable-timestamp webm (timestamps
  // follow wall-clock when chunks finalize, not a clean 30fps cadence).
  // Downstream filters like fps=1 misbehave on VFR input — they either
  // duplicate frames or skip unique seconds. Normalizing here means every
  // second of source really does have distinct pixels to sample.
  //
  // Preset is `ultrafast`: at the user's typical 4K capture (1280×720
  // logical × scaleFactor 3 = 3840×2160 effective) `-preset fast` took
  // ~3:19 for a 7-min clip — most of the post-stop wait. `ultrafast`
  // drops that to ~30-40s on the same machine. Trade-off is ~2x file
  // size at the same CRF, which for short feedback clips lands at maybe
  // 25 MB instead of 12 MB. Worth it for the responsiveness.
  //
  // Also caps height at 1080p. The user's effective capture is 4K but
  // the only consumers of the mp4 are (a) human playback and (b) the
  // tail snapshot-final PNG extraction. 1080p is fine for both, and
  // halves both the encode time and the file size. The min(1080,ih)
  // means small captures pass through untouched. The trunc(.../2)*2
  // shenanigans are because libx264 requires even dimensions.
  await runFfmpeg(
    [
      '-y',
      '-i', webmPath,
      '-vf', "scale=trunc(iw*min(1\\,1080/ih)/2)*2:trunc(min(ih\\,1080)/2)*2",
      '-c:v', 'libx264',
      '-crf', '23',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-vsync', 'cfr',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      mp4Path,
    ],
    'webm→mp4 (CFR 30fps, ≤1080p)',
    abortSignal
  );
}

async function webmToWav(webmPath: string, wavPath: string, abortSignal?: AbortSignal): Promise<void> {
  // Audio-only extraction directly from webm. Used to feed whisper without
  // waiting on the (slower) video transcode step. The Opus → PCM pass is
  // <1s on a 7-min recording, so this lets whisper kick off almost
  // immediately after stop. -vn drops the video stream so we don't burn
  // cycles decoding frames we'll throw away.
  await runFfmpeg(
    [
      '-y',
      '-i', webmPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      wavPath,
    ],
    'webm→wav (16kHz mono, audio-only)',
    abortSignal
  );
}

async function extractWavChunk(
  wavPath: string,
  chunkPath: string,
  startSec: number,
  durationSec: number,
  abortSignal?: AbortSignal
): Promise<void> {
  await runFfmpeg(
    [
      '-y',
      '-ss', startSec.toFixed(3),
      '-t', durationSec.toFixed(3),
      '-i', wavPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      chunkPath,
    ],
    `wav chunk ${formatTranscriptTime(startSec)}-${formatTranscriptTime(startSec + durationSec)}`,
    abortSignal
  );
}

async function normalizeWavForRetry(
  wavPath: string,
  normalizedPath: string,
  abortSignal?: AbortSignal
): Promise<void> {
  await runFfmpeg(
    [
      '-y',
      '-i', wavPath,
      '-vn',
      '-af', 'highpass=f=80,lowpass=f=8000,dynaudnorm=f=150:g=15,volume=3dB',
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      normalizedPath,
    ],
    'wav normalize for whisper retry',
    abortSignal
  );
}

async function measureWavAudio(
  wavPath: string,
  abortSignal?: AbortSignal
): Promise<{ meanVolumeDb: number | null; maxVolumeDb: number | null; audioPresent: boolean }> {
  const stderr = await runFfmpegCapture(
    ['-hide_banner', '-i', wavPath, '-vn', '-af', 'volumedetect', '-f', 'null', 'NUL'],
    'wav volumedetect',
    abortSignal
  );
  const meanMatch = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  const maxMatch = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i);
  const meanVolumeDb = meanMatch ? Number(meanMatch[1]) : null;
  const maxVolumeDb = maxMatch ? Number(maxMatch[1]) : null;
  const audioPresent = (
    (maxVolumeDb !== null && maxVolumeDb > AUDIO_PRESENT_MAX_DB) ||
    (meanVolumeDb !== null && meanVolumeDb > AUDIO_PRESENT_MEAN_DB)
  );
  return { meanVolumeDb, maxVolumeDb, audioPresent };
}

async function mp4ToGif(
  mp4Path: string,
  gifPath: string,
  outputRoot: string,
  abortSignal?: AbortSignal
): Promise<void> {
  // 12x time-lapse GIF with original-time timecode burned in.
  //
  // Filter order MATTERS — discovered empirically:
  //   setpts=PTS/12  (compress timeline 12x)
  //   fps=12         (resample at 12fps; yields one frame per source-second)
  //   drawtext       (timecode label using `n` which now == source-seconds)
  //   scale=min(1600,iw):-2 with lanczos (readable downscale)
  //   split + palettegen + paletteuse (better color than ffmpeg's default)
  //
  // Several other orders we tried produced dup/drop artifacts:
  //   - fps=1,setpts=N/12/TB,-r 12   →  dup=29 drop=23 (the original bug)
  //   - fps=1,setpts=PTS/12          →  drops most frames (no output -r)
  //   - fps=1,...,setpts=PTS/12,fps=12 →  ~20% frame loss
  //
  // The drawtext label is read from a textfile to dodge ffmpeg's colon
  // parsing collisions (text='%{eif:floor(n/60):d:2}:%{eif:mod(n,60):d:2}'
  // would collide with the outer drawtext option separator).
  const textfilePath = path.join(outputRoot, '_tc.txt');
  fs.writeFileSync(textfilePath, '%{eif:floor(n/60):d:2}:%{eif:mod(n,60):d:2}');

  // Use forward slashes for the textfile path inside the filter so we don't
  // have to escape backslashes (Windows native paths use \). Relative paths
  // work because ffmpeg runs in our cwd.
  const textRel = escapeFfmpegFilterPath(textfilePath);

  const filter =
    `[0:v]setpts=PTS/12,fps=12,drawtext=textfile=${textRel}:expansion=normal:x=10:y=10:fontsize=24:fontcolor=white:borderw=2:bordercolor=black,scale=w='min(${GIF_PREVIEW_MAX_WIDTH}\\,iw)':h=-2:flags=lanczos,split[a][b];` +
    '[a]palettegen=stats_mode=diff[palette];' +
    '[b][palette]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';

  try {
    await runFfmpeg(
      ['-y', '-i', mp4Path, '-filter_complex', filter, gifPath],
      'mp4→gif (12x speedup, palette 2-pass)',
      abortSignal
    );
  } finally {
    try {
      fs.unlinkSync(textfilePath);
    } catch {
      /* ignore */
    }
  }
}

async function extractFrameAt(
  mp4Path: string,
  framePath: string,
  atMs: number,
  abortSignal?: AbortSignal
): Promise<void> {
  // Extract a single frame at a specific timestamp. `-ss` before `-i` uses
  // fast (keyframe-aligned) seek; that's accurate enough for our purposes
  // and an order of magnitude faster than decode-accurate seeking.
  const seekSec = Math.max(0, atMs / 1000).toFixed(3);
  await runFfmpeg(
    [
      '-y',
      '-ss', seekSec,
      '-i', mp4Path,
      '-frames:v', '1',
      '-q:v', '2',
      framePath,
    ],
    `frame at ${seekSec}s`,
    abortSignal
  );
}

function escapeFfmpegFilterPath(filePath: string): string {
  const escaped = filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/**
 * Decode-accurate seek fallback. Slower, but always produces a frame as long
 * as the timestamp is within the stream. Used when the fast-seek variant
 * returns success without writing a PNG (happens near EOF when the nearest
 * keyframe is before the request and the decoder hits stream end first).
 */
async function extractFrameAtAccurate(
  mp4Path: string,
  framePath: string,
  atMs: number,
  abortSignal?: AbortSignal
): Promise<void> {
  const seekSec = Math.max(0, atMs / 1000).toFixed(3);
  await runFfmpeg(
    [
      '-y',
      '-i', mp4Path,
      '-ss', seekSec,
      '-frames:v', '1',
      '-q:v', '2',
      framePath,
    ],
    `frame at ${seekSec}s (accurate)`,
    abortSignal
  );
}

// ─── whisper.cpp helpers ─────────────────────────────────────────────

function findWhisperBinary(): { exe: string; model: string } | null {
  // During development, resources/ lives next to the project root. For a
  // packaged build, process.resourcesPath would be used instead. For now,
  // check both.
  // Prefer packaged extraResources path first — cwd is Program Files and may
  // not contain whisper even when the bundle does.
  const candidates = app.isPackaged
    ? [
        path.join(app.getPath('userData'), 'resources'),
        path.join(process.resourcesPath || '', 'resources'),
        path.join(process.cwd(), 'resources'),
      ]
    : [
        path.join(process.cwd(), 'resources'),
        path.join(app.getPath('userData'), 'resources'),
        path.join(process.resourcesPath || '', 'resources'),
      ];

  for (const root of candidates) {
    if (!root || !fs.existsSync(root)) continue;
    const binDir = path.join(root, 'bin', 'whisper');
    // whisper.cpp recent releases renamed main.exe → whisper-cli.exe.
    const exeCandidates = [
      path.join(binDir, 'whisper-cli.exe'),
      path.join(binDir, 'main.exe'),
      path.join(binDir, 'Release', 'whisper-cli.exe'),
      path.join(binDir, 'Release', 'main.exe'),
    ];
    const exe = exeCandidates.find((p) => fs.existsSync(p));
    if (!exe) continue;
    const model = path.join(root, 'models', 'ggml-base.en.bin');
    if (!fs.existsSync(model)) continue;
    return { exe, model };
  }
  return null;
}

export interface TranscriptSegment {
  /** Formatted line: "[M:SS - M:SS] text" */
  text: string;
  /** Segment start in whole seconds from recording start. */
  startSec: number;
  /** Segment end in whole seconds from recording start. */
  endSec: number;
}

export interface ChunkAudioDiagnostic {
  startSec: number;
  endSec: number;
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  audioPresent: boolean;
  suspicious: boolean;
  retried: boolean;
  segmentCount: number;
  speechLikeCount: number;
}

const WHISPER_CHUNK_SEC = 180;
const WHISPER_CHUNK_OVERLAP_SEC = 5;
const AUDIO_PRESENT_MAX_DB = -45;
const AUDIO_PRESENT_MEAN_DB = -55;

function formatTranscriptTime(s: number): string {
  const whole = Math.max(0, Math.round(s));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function parseSrtToTranscript(
  srtText: string,
  offsetSec = 0,
  shouldFilter = true
): TranscriptSegment[] {
  // SRT block pattern: index, HH:MM:SS,mmm --> HH:MM:SS,mmm, text, blank.
  // We fold each subtitle into "[M:SS - M:SS] text" and retain the start
  // second so the pipeline can extract a representative frame for each segment.
  const lines = srtText.split(/\r?\n/);
  const out: TranscriptSegment[] = [];
  let currentStamp = '';
  let currentStartSec = 0;
  let currentEndSec = 0;

  // SRT timestamp: HH:MM:SS,mmm --> HH:MM:SS,mmm
  const tsPattern = /^(\d{2}):(\d{2}):(\d{2}),\d+\s+-->\s+(\d{2}):(\d{2}):(\d{2}),\d+/;

  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(tsPattern);
    if (m) {
      const startTotalSec = offsetSec + parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      const endTotalSec   = offsetSec + parseInt(m[4], 10) * 3600 + parseInt(m[5], 10) * 60 + parseInt(m[6], 10);
      const startMin = Math.floor(startTotalSec / 60);
      const startSecRem = startTotalSec % 60;
      const endMin = Math.floor(endTotalSec / 60);
      const endSecRem = endTotalSec % 60;
      currentStartSec = startTotalSec;
      currentEndSec = endTotalSec;
      currentStamp = `[${startMin}:${String(startSecRem).padStart(2, '0')} - ${endMin}:${String(endSecRem).padStart(2, '0')}]`;
      continue;
    }
    if (line !== '' && !/^\d+$/.test(line) && currentStamp) {
      out.push({ text: `${currentStamp} ${line}`, startSec: currentStartSec, endSec: currentEndSec });
      currentStamp = '';
    }
  }

  // Trim trailing Whisper "silence artifact" lines — typically empty or "you".
  while (out.length > 0) {
    const last = out[out.length - 1].text.replace(/^\[.*?\]\s*/, '').trim();
    if (last === '' || /^you\.?$/i.test(last)) {
      out.pop();
    } else {
      break;
    }
  }
  return shouldFilter ? filterRepeatedTranscriptSegments(out) : out;
}

function normalizeTranscriptTextForRepeat(text: string): string {
  return text
    .replace(/^\[[^\]]+\]\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTranscriptStamp(text: string): string {
  return text.replace(/^\[[^\]]+\]\s*/, '').trim();
}

function isNonSpeechWhisperLabel(text: string): boolean {
  const body = stripTranscriptStamp(text)
    .toLowerCase()
    .replace(/[.。]+$/g, '')
    .trim();
  if (!body) return true;
  const label = body.match(/^[[(]\s*([^)\]]+?)\s*[\])]$/)?.[1]?.trim() ?? '';
  if (!label) return false;
  return /^(silence|silent|typing|typing sounds|keyboard|keyboard clicking|clicking|music|noise|background noise|applause|laughter|sigh)$/i.test(label);
}

function isSpeechLikeTranscriptSegment(segment: TranscriptSegment): boolean {
  return !isNonSpeechWhisperLabel(segment.text);
}

export function mergeTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const merged: TranscriptSegment[] = [];
  for (const segment of sorted) {
    const normalized = normalizeTranscriptTextForRepeat(segment.text);
    const recentDuplicate = merged.some((prior) =>
      Math.abs(prior.startSec - segment.startSec) <= WHISPER_CHUNK_OVERLAP_SEC + 2 &&
      normalizeTranscriptTextForRepeat(prior.text) === normalized
    );
    if (recentDuplicate) continue;
    merged.push(segment);
  }
  return filterRepeatedTranscriptSegments(merged);
}

function compactRepeatedPhrases(text: string): string {
  const prefixMatch = text.match(/^(\[[^\]]+\]\s*)([\s\S]*)$/);
  const prefix = prefixMatch ? prefixMatch[1] : '';
  let body = prefixMatch ? prefixMatch[2] : text;
  body = body.replace(
    /\b([a-z][a-z' ]{2,70}?)(?:,\s+\1\b){2,}/gi,
    (_match, phrase: string) => `${phrase}, ${phrase}`
  );
  body = body.replace(/\b(okay|alright)(?:,\s+\1\b){3,}/gi, '$1, $1');
  return `${prefix}${body}`;
}

function filterRepeatedTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const recent = new Map<string, { count: number; lastEndSec: number }>();
  const filtered: TranscriptSegment[] = [];
  let dropped = 0;
  let compacted = 0;

  for (const segment of segments) {
    const cleanedText = compactRepeatedPhrases(segment.text);
    const normalized = normalizeTranscriptTextForRepeat(cleanedText);
    if (!normalized) continue;

    for (const [key, value] of recent.entries()) {
      if (segment.startSec - value.lastEndSec > 90) recent.delete(key);
    }

    const seen = recent.get(normalized);
    if (seen && seen.count >= 2 && segment.startSec - seen.lastEndSec <= 90) {
      seen.count += 1;
      seen.lastEndSec = segment.endSec;
      dropped += 1;
      continue;
    }

    recent.set(normalized, {
      count: (seen?.count ?? 0) + 1,
      lastEndSec: segment.endSec,
    });
    if (cleanedText !== segment.text) compacted += 1;
    filtered.push({ ...segment, text: cleanedText });
  }

  if (dropped > 0 || compacted > 0) {
    log('pipeline', 'transcript repetition cleanup', {
      before: segments.length,
      after: filtered.length,
      dropped,
      compacted,
    });
  }
  return filtered;
}

function runWhisper(
  exe: string,
  modelPath: string,
  wavPath: string,
  outPrefix: string,
  abortSignal?: AbortSignal,
  extraArgs: string[] = []
): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(abortSignal);
    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '-l', 'en',
      ...extraArgs,
      '-osrt',
      '-of', outPrefix,
    ];
    log('whisper', 'spawn', { exe, args });
    const proc = spawn(exe, args, { windowsHide: true });
    let stderr = '';
    const onAbort = () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      reject(new Error('Processing abandoned.'));
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const maxMs = 25 * 60 * 1000;
    const killTimer = setTimeout(() => {
      log('whisper', 'timeout — killing hung process', { maxMs });
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 5000);
    }, maxMs);
    proc.on('error', (err) => {
      abortSignal?.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      reject(err);
    });
    proc.on('exit', (code) => {
      abortSignal?.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else reject(new Error(`whisper exited ${code}. stderr tail: ${stderr.slice(-500)}`));
    });
  });
}

async function runWhisperToSegments(
  exe: string,
  modelPath: string,
  wavPath: string,
  outPrefix: string,
  offsetSec: number,
  abortSignal?: AbortSignal
): Promise<TranscriptSegment[]> {
  await runWhisper(exe, modelPath, wavPath, outPrefix, abortSignal, ['--max-context', '0']);
  const srtPath = `${outPrefix}.srt`;
  if (!fs.existsSync(srtPath)) return [];
  const srt = fs.readFileSync(srtPath, 'utf-8');
  return parseSrtToTranscript(srt, offsetSec, false);
}

async function transcribeWavInChunks(
  exe: string,
  modelPath: string,
  wavPath: string,
  sessionDir: string,
  recordingDurationSec: number,
  abortSignal?: AbortSignal
): Promise<{ segments: TranscriptSegment[]; diagnostics: ChunkAudioDiagnostic[] }> {
  const chunkDir = path.join(sessionDir, 'whisper-chunks');
  ensureDir(chunkDir);
  const diagnostics: ChunkAudioDiagnostic[] = [];
  const allSegments: TranscriptSegment[] = [];
  const stepSec = Math.max(30, WHISPER_CHUNK_SEC - WHISPER_CHUNK_OVERLAP_SEC);

  try {
    for (let startSec = 0, index = 1; startSec < recordingDurationSec; startSec += stepSec, index += 1) {
      throwIfAborted(abortSignal);
      const durationSec = Math.min(WHISPER_CHUNK_SEC, recordingDurationSec - startSec);
      const endSec = startSec + durationSec;
      const chunkPath = path.join(chunkDir, `chunk-${String(index).padStart(3, '0')}.wav`);
      const normalizedPath = path.join(chunkDir, `chunk-${String(index).padStart(3, '0')}-normalized.wav`);
      const outPrefix = path.join(chunkDir, `chunk-${String(index).padStart(3, '0')}`);
      const retryOutPrefix = path.join(chunkDir, `chunk-${String(index).padStart(3, '0')}-retry`);
      let retried = false;

      await extractWavChunk(wavPath, chunkPath, startSec, durationSec, abortSignal);
      const audio = await measureWavAudio(chunkPath, abortSignal);
      let chunkSegments = await runWhisperToSegments(exe, modelPath, chunkPath, outPrefix, startSec, abortSignal);
      let speechLikeCount = chunkSegments.filter(isSpeechLikeTranscriptSegment).length;

      if (audio.audioPresent && speechLikeCount === 0) {
        retried = true;
        await normalizeWavForRetry(chunkPath, normalizedPath, abortSignal);
        const retrySegments = await runWhisperToSegments(exe, modelPath, normalizedPath, retryOutPrefix, startSec, abortSignal);
        const retrySpeechLikeCount = retrySegments.filter(isSpeechLikeTranscriptSegment).length;
        if (retrySpeechLikeCount > speechLikeCount) {
          chunkSegments = retrySegments;
          speechLikeCount = retrySpeechLikeCount;
        }
      }

      const suspicious = audio.audioPresent && speechLikeCount === 0;
      if (suspicious) {
        chunkSegments.push({
          startSec,
          endSec,
          text: `[${formatTranscriptTime(startSec)} - ${formatTranscriptTime(endSec)}] [AUDIO PRESENT - Whisper detected mostly typing/noise in this chunk; speech may need review]`,
        });
      }

      diagnostics.push({
        startSec,
        endSec,
        meanVolumeDb: audio.meanVolumeDb,
        maxVolumeDb: audio.maxVolumeDb,
        audioPresent: audio.audioPresent,
        suspicious,
        retried,
        segmentCount: chunkSegments.length,
        speechLikeCount,
      });

      writeSessionLog(sessionDir, 'whisper', 'chunk transcribed', {
        index,
        startSec,
        endSec,
        audioPresent: audio.audioPresent,
        meanVolumeDb: audio.meanVolumeDb,
        maxVolumeDb: audio.maxVolumeDb,
        retried,
        suspicious,
        segments: chunkSegments.length,
        speechLikeCount,
      }, suspicious ? 'warning' : 'success');

      allSegments.push(...chunkSegments);
      for (const file of [
        chunkPath,
        normalizedPath,
        `${outPrefix}.srt`,
        `${retryOutPrefix}.srt`,
      ]) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
      }
    }
  } finally {
    try { fs.rmSync(chunkDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  return { segments: mergeTranscriptSegments(allSegments), diagnostics };
}

export function buildTranscriptText(
  recordingDurationSec: number,
  segments: TranscriptSegment[],
  diagnostics: ChunkAudioDiagnostic[],
  transcriptionMode: string
): string {
  const lastSegEndSec = segments.length > 0 ? segments[segments.length - 1].endSec : 0;
  const suspiciousChunks = diagnostics.filter((d) => d.suspicious);
  const headerLines: string[] = [];
  headerLines.push(`# Recording duration: ${formatTranscriptTime(recordingDurationSec)}`);
  headerLines.push(`# Transcription mode: ${transcriptionMode}`);
  if (segments.length > 0) {
    headerLines.push(`# Last narration segment ended at ${formatTranscriptTime(lastSegEndSec)}`);
  } else {
    headerLines.push('# No narration detected (whisper produced no segments)');
  }
  if (suspiciousChunks.length > 0) {
    headerLines.push(`# Audio review warnings: ${suspiciousChunks.length} chunk(s) had audio but no speech-like transcript after retry`);
  }
  headerLines.push('');

  const tailGapSec = recordingDurationSec - lastSegEndSec;
  const tailLines: string[] = [];
  if (tailGapSec > 10) {
    const tailHasAudio = diagnostics.some((d) => d.audioPresent && d.endSec > lastSegEndSec + 1);
    tailLines.push(
      tailHasAudio
        ? `[${formatTranscriptTime(lastSegEndSec)} - ${formatTranscriptTime(recordingDurationSec)}] [AUDIO PRESENT - no speech-like transcript was produced in the remaining ${formatTranscriptTime(tailGapSec)}; review source audio if commentary is expected]`
        : `[${formatTranscriptTime(lastSegEndSec)} - ${formatTranscriptTime(recordingDurationSec)}] [SILENT - no audible speech detected for ${formatTranscriptTime(tailGapSec)}; recording continued through this stretch]`
    );
  }

  return [
    ...headerLines,
    ...segments.map((s) => s.text),
    ...tailLines,
  ].join('\n') + '\n';
}

export async function transcribeIncrementalAudioChunk(input: {
  audioBuffer: Buffer;
  sessionDir: string;
  index: number;
  startMs: number;
  endMs: number;
  mimeType?: string | null;
  abortSignal?: AbortSignal;
}): Promise<IncrementalTranscriptionChunkResult> {
  const whisper = findWhisperBinary();
  if (!whisper) {
    throw new Error('Whisper is not installed; incremental transcription skipped');
  }

  const chunkDir = path.join(input.sessionDir, 'Inputs', 'incremental-transcript');
  ensureDir(chunkDir);
  const id = `chunk-${String(input.index).padStart(3, '0')}`;
  const audioWebmPath = path.join(chunkDir, `${id}.webm`);
  const wavPath = path.join(chunkDir, `${id}.wav`);
  const normalizedPath = path.join(chunkDir, `${id}-normalized.wav`);
  const outPrefix = path.join(chunkDir, id);
  const retryOutPrefix = path.join(chunkDir, `${id}-retry`);
  const startSec = Math.max(0, Math.round(input.startMs / 1000));
  const endSec = Math.max(startSec + 1, Math.round(input.endMs / 1000));
  let retried = false;

  try {
    throwIfAborted(input.abortSignal);
    fs.writeFileSync(audioWebmPath, input.audioBuffer);
    await webmToWav(audioWebmPath, wavPath, input.abortSignal);
    const audio = await measureWavAudio(wavPath, input.abortSignal);
    let chunkSegments = await runWhisperToSegments(
      whisper.exe,
      whisper.model,
      wavPath,
      outPrefix,
      startSec,
      input.abortSignal
    );
    let speechLikeCount = chunkSegments.filter(isSpeechLikeTranscriptSegment).length;

    if (audio.audioPresent && speechLikeCount === 0) {
      retried = true;
      await normalizeWavForRetry(wavPath, normalizedPath, input.abortSignal);
      const retrySegments = await runWhisperToSegments(
        whisper.exe,
        whisper.model,
        normalizedPath,
        retryOutPrefix,
        startSec,
        input.abortSignal
      );
      const retrySpeechLikeCount = retrySegments.filter(isSpeechLikeTranscriptSegment).length;
      if (retrySpeechLikeCount > speechLikeCount) {
        chunkSegments = retrySegments;
        speechLikeCount = retrySpeechLikeCount;
      }
    }

    const suspicious = audio.audioPresent && speechLikeCount === 0;
    if (suspicious) {
      chunkSegments.push({
        startSec,
        endSec,
        text: `[${formatTranscriptTime(startSec)} - ${formatTranscriptTime(endSec)}] [AUDIO PRESENT - Whisper detected mostly typing/noise in this chunk; speech may need review]`,
      });
    }

    const diagnostic: ChunkAudioDiagnostic = {
      startSec,
      endSec,
      meanVolumeDb: audio.meanVolumeDb,
      maxVolumeDb: audio.maxVolumeDb,
      audioPresent: audio.audioPresent,
      suspicious,
      retried,
      segmentCount: chunkSegments.length,
      speechLikeCount,
    };
    writeSessionLog(input.sessionDir, 'whisper', 'incremental chunk transcribed', {
      index: input.index,
      startSec,
      endSec,
      audioPresent: audio.audioPresent,
      meanVolumeDb: audio.meanVolumeDb,
      maxVolumeDb: audio.maxVolumeDb,
      retried,
      suspicious,
      segments: chunkSegments.length,
      speechLikeCount,
      bytes: input.audioBuffer.length,
      mimeType: input.mimeType ?? null,
    }, suspicious ? 'warning' : 'success');

    return {
      index: input.index,
      startSec,
      endSec,
      segments: chunkSegments,
      diagnostic,
    };
  } finally {
    for (const file of [
      audioWebmPath,
      wavPath,
      normalizedPath,
      `${outPrefix}.srt`,
      `${retryOutPrefix}.srt`,
    ]) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
}

// ─── prompt template ─────────────────────────────────────────────────

interface DiscardedTradeEvidence {
  kind: 'marker' | 'transcript' | 'annotation';
  timestamp: string;
  offsetMs: number | null;
  confidence: 'high' | 'medium' | 'low';
  detail: string;
  sourcePath?: string;
}

const DIRECT_TRADE_PATTERNS: RegExp[] = [
  /\b(i\s+)?(bought|buying|buy|aped|apeing|entered|entering|entry|filled|market\s+buy|took\s+(a\s+)?position|position\s+in)\b/i,
  /\b(i\s+)?(sold|selling|sell|exited|exiting|exit|closed|closing|trimmed|trimming|cut|cutting|stopped\s+out|took\s+profit|taking\s+profit)\b/i,
  /\b(partial|half|quarter|full)\s+(entry|exit|sell|sold|fill|position)\b/i,
];

const CONTEXT_TRADE_PATTERNS: RegExp[] = [
  /\b(token|ticker|contract|ca|market\s*cap|mc|liquidity|volume|narrative|meta|setup)\b/i,
  /\b(long|short|position|risk|stop|target|pnl|profit|loss|break\s*even)\b/i,
];

function formatMsAsMinSec(ms: number): string {
  const mm = Math.floor(ms / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function buildDiscardedTranscriptText(
  recordingDurationSec: number,
  segments: TranscriptSegment[],
  diagnostics: ChunkAudioDiagnostic[]
): string {
  const lastSegEndSec = segments.length > 0 ? segments[segments.length - 1].endSec : 0;
  const suspiciousChunks = diagnostics.filter((d) => d.suspicious);
  const headerLines = [
    `# Recording duration: ${formatTranscriptTime(recordingDurationSec)}`,
    `# Transcription mode: discarded trade audit (${WHISPER_CHUNK_SEC}s chunks, ${WHISPER_CHUNK_OVERLAP_SEC}s overlap, max-context 0)`,
    segments.length > 0
      ? `# Last narration segment ended at ${formatTranscriptTime(lastSegEndSec)}`
      : '# No narration detected (whisper produced no segments)',
  ];
  if (suspiciousChunks.length > 0) {
    headerLines.push(`# Audio review warnings: ${suspiciousChunks.length} chunk(s) had audio but no speech-like transcript after retry`);
  }
  const tailGapSec = recordingDurationSec - lastSegEndSec;
  const tailLines: string[] = [];
  if (tailGapSec > 10) {
    const tailHasAudio = diagnostics.some((d) => d.audioPresent && d.endSec > lastSegEndSec + 1);
    tailLines.push(
      tailHasAudio
        ? `[${formatTranscriptTime(lastSegEndSec)} - ${formatTranscriptTime(recordingDurationSec)}] [AUDIO PRESENT - no speech-like transcript was produced in the remaining ${formatTranscriptTime(tailGapSec)}; review source audio if commentary is expected]`
        : `[${formatTranscriptTime(lastSegEndSec)} - ${formatTranscriptTime(recordingDurationSec)}] [SILENT - no audible speech detected for ${formatTranscriptTime(tailGapSec)}; recording continued through this stretch]`
    );
  }
  return [
    ...headerLines,
    '',
    ...segments.map((s) => s.text),
    ...tailLines,
  ].join('\n') + '\n';
}

function collectDiscardedTradeEvidence(
  segments: TranscriptSegment[],
  tradeMarkers: TradeMarkerRecord[],
  annotations: AnnotationRecord[]
): DiscardedTradeEvidence[] {
  const evidence: DiscardedTradeEvidence[] = [];
  for (let i = 0; i < tradeMarkers.length; i += 1) {
    const marker = tradeMarkers[i];
    evidence.push({
      kind: 'marker',
      timestamp: marker.offsetLabel || formatMsAsMinSec(marker.offsetMs),
      offsetMs: marker.offsetMs,
      confidence: marker.screenshotPath ? 'high' : 'medium',
      detail: `Trade marker #${i + 1} was pressed${marker.screenshotPath ? ' and captured a marker screenshot' : ''}.`,
      sourcePath: marker.screenshotPath,
    });
  }
  for (const segment of segments) {
    const body = stripTranscriptStamp(segment.text);
    if (!body) continue;
    const direct = DIRECT_TRADE_PATTERNS.some((pattern) => pattern.test(body));
    const contextual = CONTEXT_TRADE_PATTERNS.some((pattern) => pattern.test(body));
    if (!direct && !contextual) continue;
    evidence.push({
      kind: 'transcript',
      timestamp: formatTranscriptTime(segment.startSec),
      offsetMs: segment.startSec * 1000,
      confidence: direct ? 'high' : 'low',
      detail: body.length > 240 ? `${body.slice(0, 237)}...` : body,
    });
  }
  for (const annotation of annotations) {
    const text = [annotation.text, annotation.note].filter(Boolean).join(' ');
    if (!text) continue;
    const direct = DIRECT_TRADE_PATTERNS.some((pattern) => pattern.test(text));
    const contextual = CONTEXT_TRADE_PATTERNS.some((pattern) => pattern.test(text));
    if (!direct && !contextual) continue;
    evidence.push({
      kind: 'annotation',
      timestamp: formatMsAsMinSec(annotation.drawnAtMs),
      offsetMs: annotation.drawnAtMs,
      confidence: direct ? 'medium' : 'low',
      detail: text.length > 240 ? `${text.slice(0, 237)}...` : text,
    });
  }
  return evidence.sort((a, b) => (a.offsetMs ?? Number.MAX_SAFE_INTEGER) - (b.offsetMs ?? Number.MAX_SAFE_INTEGER));
}

function writeDiscardedTradeReviewMarkdown(
  filePath: string,
  result: {
    status: DiscardedTradeAuditStatus;
    comments: string;
    retainedWebm: boolean;
    transcriptPath: string | null;
    webmPath: string;
    warnings: string[];
    evidence: DiscardedTradeEvidence[];
  }
): void {
  const lines: string[] = [
    '# Discarded Trade Session Review',
    '',
    `Status: ${result.status}`,
    `Comments: ${result.comments}`,
    `WebM retained: ${result.retainedWebm ? 'yes' : 'no'}`,
    `Transcript: ${result.transcriptPath ?? 'not available'}`,
    `WebM: ${result.retainedWebm ? result.webmPath : 'deleted after no trade evidence was found'}`,
    '',
    '## Evidence',
  ];
  if (result.evidence.length === 0) {
    lines.push('', 'No trade markers or trade-language transcript/annotation evidence was found.');
  } else {
    for (const item of result.evidence) {
      lines.push(
        '',
        `- ${item.timestamp} (${item.kind}, ${item.confidence}): ${item.detail}${item.sourcePath ? ` [${item.sourcePath}]` : ''}`
      );
    }
  }
  if (result.warnings.length > 0) {
    lines.push('', '## Warnings');
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

function copyDiscardedSnapshotInputs(chapters: ChapterRecord[], inputsDir: string): string[] {
  const copied: string[] = [];
  const snapshotDir = path.join(inputsDir, 'discarded-snapshots');
  for (const chapter of chapters) {
    if (!chapter.pngPath || !fs.existsSync(chapter.pngPath)) continue;
    ensureDir(snapshotDir);
    const targetPath = path.join(snapshotDir, `snapshot-${chapter.snapshotIndex}.png`);
    try {
      fs.copyFileSync(chapter.pngPath, targetPath);
      copied.push(targetPath);
    } catch (err) {
      writeSessionLog(path.dirname(inputsDir), 'discard-audit', 'snapshot copy failed', {
        sourcePath: chapter.pngPath,
        targetPath,
        error: (err as Error).message,
      }, 'warning');
    }
  }
  return copied;
}

export async function runDiscardedTradeAudit(input: DiscardedTradeAuditInput): Promise<DiscardedTradeAuditResult> {
  const { sessionDir } = input;
  const inputsDir = path.join(sessionDir, 'Inputs');
  ensureDir(sessionDir);
  ensureDir(inputsDir);

  const webmPath = path.join(inputsDir, 'discarded_recording.webm');
  const wavPath = path.join(inputsDir, 'discarded_recording.wav');
  const transcriptPath = path.join(inputsDir, 'transcript.txt');
  const markersPath = path.join(inputsDir, 'markers.json');
  const annotationsPath = path.join(inputsDir, 'annotations.json');
  const reviewJsonPath = path.join(inputsDir, 'discarded_trade_review.json');
  const reviewMarkdownPath = path.join(inputsDir, 'discarded_trade_review.md');
  const warnings: string[] = [];
  const allAnnotations = [
    ...input.annotations,
    ...input.chapters.flatMap((chapter) => chapter.annotations),
  ];
  let retainedWebm = true;
  let finalTranscriptPath: string | null = null;
  let transcriptSegments: TranscriptSegment[] = [];
  let diagnostics: ChunkAudioDiagnostic[] = [];
  let status: DiscardedTradeAuditStatus = 'review_incomplete';

  writeSessionLog(sessionDir, 'discard-audit', 'started', {
    webmBytes: input.webmBuffer.length,
    durationMs: input.durationMs,
    annotations: allAnnotations.length,
    chapters: input.chapters.length,
    tradeMarkers: input.tradeMarkers.length,
  }, 'start');

  fs.writeFileSync(webmPath, input.webmBuffer);
  fs.writeFileSync(markersPath, JSON.stringify({
    discarded: true,
    markers: input.tradeMarkers.map((marker, i) => ({
      index: i + 1,
      offsetMs: marker.offsetMs,
      offsetLabel: marker.offsetLabel,
      screenshotPath: marker.screenshotPath ?? null,
    })),
  }, null, 2), 'utf-8');
  const copiedSnapshots = copyDiscardedSnapshotInputs(input.chapters, inputsDir);
  fs.writeFileSync(annotationsPath, JSON.stringify({
    discarded: true,
    annotations: input.annotations,
    chapters: input.chapters,
    copiedSnapshots,
  }, null, 2), 'utf-8');

  const whisper = findWhisperBinary();
  if (!whisper) {
    warnings.push('Whisper is not installed; retained discarded_recording.webm for manual review.');
  } else {
    try {
      await webmToWav(webmPath, wavPath, input.abortSignal);
      const recordingDurationSec = Math.max(1, Math.round(input.durationMs / 1000));
      const chunked = await transcribeWavInChunks(
        whisper.exe,
        whisper.model,
        wavPath,
        sessionDir,
        recordingDurationSec,
        input.abortSignal
      );
      transcriptSegments = chunked.segments;
      diagnostics = chunked.diagnostics;
      if (transcriptSegments.length > 0 || diagnostics.some((d) => d.audioPresent)) {
        fs.writeFileSync(
          transcriptPath,
          buildDiscardedTranscriptText(recordingDurationSec, transcriptSegments, diagnostics),
          'utf-8'
        );
        finalTranscriptPath = transcriptPath;
      } else {
        warnings.push('Whisper ran but produced no speech or audio diagnostics.');
      }
    } catch (err) {
      warnings.push(`Discarded trade transcription failed: ${(err as Error).message}`);
      writeSessionLog(sessionDir, 'discard-audit', 'transcription failed', {
        error: (err as Error).message,
      }, 'error');
    } finally {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
  }

  const evidence = collectDiscardedTradeEvidence(transcriptSegments, input.tradeMarkers, allAnnotations);
  if (evidence.length > 0) {
    status = 'potential_trade_activity';
  } else if (finalTranscriptPath && warnings.length === 0) {
    status = 'no_trade_evidence';
  } else if (finalTranscriptPath && warnings.every((warning) => !/failed|not installed/i.test(warning))) {
    status = 'no_trade_evidence';
  }

  if (status === 'no_trade_evidence') {
    try {
      fs.unlinkSync(webmPath);
      retainedWebm = false;
    } catch (err) {
      retainedWebm = true;
      warnings.push(`Could not delete discarded WebM after no-evidence review: ${(err as Error).message}`);
      status = 'review_incomplete';
    }
  }

  const comments = status === 'potential_trade_activity'
    ? `Potential trade activity found at ${evidence.map((item) => item.timestamp).join(', ')}. Retained discarded_recording.webm for review.`
    : status === 'no_trade_evidence'
      ? 'No trade markers or trade-language evidence found in the discarded session transcript; discarded_recording.webm was deleted.'
      : 'Discarded trade audit could not rule out trade activity; retained discarded_recording.webm for manual review.';

  const reviewPayload = {
    status,
    comments,
    retainedWebm,
    webmPath: retainedWebm ? webmPath : null,
    transcriptPath: finalTranscriptPath,
    markersPath,
    annotationsPath,
    copiedSnapshots,
    warnings,
    evidence,
    audioDiagnostics: diagnostics,
    durationMs: input.durationMs,
    startedAtIso: new Date(input.startedAtMs).toISOString(),
    reviewedAtIso: new Date().toISOString(),
  };
  fs.writeFileSync(reviewJsonPath, JSON.stringify(reviewPayload, null, 2), 'utf-8');
  writeDiscardedTradeReviewMarkdown(reviewMarkdownPath, {
    status,
    comments,
    retainedWebm,
    transcriptPath: finalTranscriptPath,
    webmPath,
    warnings,
    evidence,
  });

  writeSessionLog(sessionDir, 'discard-audit', 'finished', {
    status,
    retainedWebm,
    transcriptPath: finalTranscriptPath,
    evidenceCount: evidence.length,
    warnings: warnings.length,
  }, status === 'potential_trade_activity' || status === 'review_incomplete' ? 'warning' : 'success');

  return {
    sessionDir,
    inputsDir,
    status,
    suspected: status === 'potential_trade_activity',
    retainedWebm,
    webmPath,
    transcriptPath: finalTranscriptPath,
    reviewJsonPath,
    reviewMarkdownPath,
    suspectedTradeTimestamps: evidence.map((item) => item.timestamp),
    comments,
    markerCount: input.tradeMarkers.length,
    evidenceCount: evidence.length,
    warnings,
  };
}

// ─── snapshot chapter helpers ────────────────────────────────────────

/**
 * Keyword heuristic for classifying an annotation's transcript-derived note
 * into bug / improvement / question / praise (matches the buckets in
 * screenshot-annotator's prompt template).
 */
export function classifyAnnotationType(note: string): FeedbackType {
  const s = (note || '').toLowerCase().trim();
  if (!s) return 'improvement';
  // Question: trailing "?" or common interrogatives at the start.
  if (/\?\s*$/.test(s) || /^(what|why|how|when|where|who|can|could|should|would|is|are|do|does)\b/.test(s)) {
    return 'question';
  }
  // Bug: problem indicators.
  if (/\b(bug|broken|error|crash|fail|failed|glitch|wrong|missing|not\s+working|doesn'?t\s+work)\b/.test(s)) {
    return 'bug';
  }
  // Praise: positive sentiment.
  if (/\b(love|great|awesome|nice|beautiful|excellent|perfect|wonderful)\b/.test(s)) {
    return 'praise';
  }
  return 'improvement';
}

/**
 * Slice transcript segments to a time range, returning the formatted lines.
 * Time units are whole seconds; chapter ranges are supplied in ms.
 */
function sliceTranscriptByRange(
  segments: TranscriptSegment[],
  startMs: number,
  endMs: number
): TranscriptSegment[] {
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.ceil(endMs / 1000);
  return segments.filter((s) => s.startSec >= startSec && s.startSec < endSec);
}

/**
 * Given the transcript segments for a chapter's time range and the chapter's
 * annotations (sorted by drawnAtMs), bucket each transcript segment into the
 * annotation whose [drawnAtMs, nextDrawnAtMs) window contains the segment
 * start. Returns a map from annotation number → concatenated note text.
 */
function bucketNotesToAnnotations(
  segments: TranscriptSegment[],
  annotations: AnnotationRecord[],
  chapterStartMs: number,
  chapterEndMs: number
): Map<number, string> {
  const sorted = [...annotations].sort((a, b) => a.drawnAtMs - b.drawnAtMs);
  const bucketRanges = sorted.map((a, i) => ({
    number: a.number,
    startSec: Math.floor(Math.max(chapterStartMs, a.drawnAtMs) / 1000),
    endSec: Math.floor(
      (i + 1 < sorted.length ? sorted[i + 1].drawnAtMs : chapterEndMs) / 1000
    ),
  }));

  const out = new Map<number, string>();
  for (const b of bucketRanges) out.set(b.number, '');

  for (const seg of segments) {
    // Strip the leading "[M:SS - M:SS] " prefix so notes read cleanly.
    const cleanText = seg.text.replace(/^\[.*?\]\s*/, '').trim();
    if (!cleanText) continue;
    const bucket = bucketRanges.find((b) => seg.startSec >= b.startSec && seg.startSec < b.endSec);
    if (!bucket) continue;
    const prev = out.get(bucket.number) ?? '';
    out.set(bucket.number, prev ? `${prev} ${cleanText}` : cleanText);
  }
  return out;
}

/**
 * Build a screenshot-annotator-format prompt.md for a chapter's annotations.
 * Matches the template in E:\OneDrive\Apps\claude-toolkit\tools\screenshot-annotator.html.
 */
function buildPerSnapshotPromptMd(annotations: AnnotationRecord[], pngPath: string): string {
  if (annotations.length === 0) {
    return `Screenshot: ${pngPath}\n\nNo annotations were drawn on this screen.\n`;
  }

  const groups: Record<FeedbackType, AnnotationRecord[]> = {
    bug: [], improvement: [], question: [], praise: [],
  };
  for (const a of annotations) {
    const t = a.type ?? classifyAnnotationType(a.note ?? '');
    groups[t].push(a);
  }

  const lines: string[] = [];
  lines.push(`Screenshot: ${pngPath}`);
  lines.push('');
  lines.push(
    `I've annotated a screenshot with ${annotations.length} note${annotations.length === 1 ? '' : 's'}. Please apply the following feedback:`
  );
  lines.push('');

  const sections: Array<{ type: FeedbackType; heading: string }> = [
    { type: 'bug', heading: '🐛 Bugs:' },
    { type: 'improvement', heading: '💡 Improvements:' },
    { type: 'question', heading: '❓ Questions:' },
    { type: 'praise', heading: '✅ Praise:' },
  ];

  for (const { type, heading } of sections) {
    const group = groups[type];
    if (group.length === 0) continue;
    lines.push(heading);
    for (const a of group.sort((x, y) => x.number - y.number)) {
      const body = (a.note && a.note.trim()) || '(no spoken note)';
      lines.push(`  #${a.number}: ${body}`);
    }
    lines.push('');
  }

  lines.push('Please make all changes in the file, keeping the same overall structure.');
  lines.push('');
  return lines.join('\n');
}

interface ChapterArtifact {
  folderName: string;
  snapshotIndex: number;
  capturedAtMs: number;
  chapterStartMs: number;
  chapterEndMs: number;
  dir: string;
  pngPath: string;
  promptPath: string;
  transcriptPath: string;
  annotationsPath: string;
  annotationCount: number;
}

/**
 * Emit all chapter artifacts. Called after transcript parsing completes.
 */
async function buildSnapshotChapters(
  mp4Path: string,
  sessionDir: string,
  chapters: ChapterRecord[],
  tailAnnotations: AnnotationRecord[],
  segments: TranscriptSegment[],
  recordingDurationMs: number,
  warnings: string[]
): Promise<ChapterArtifact[]> {
  if (chapters.length === 0 && tailAnnotations.length === 0) return [];

  const snapshotsRoot = path.join(sessionDir, 'snapshots');
  ensureDir(snapshotsRoot);

  // Build the full chapter list: explicit chapters + optional tail chapter.
  // Tail chapter covers [lastSnapshot.capturedAtMs, recordingDurationMs) and
  // uses the stop-time annotations (which were never snapshot-flushed).
  const allChapters: ChapterRecord[] = [...chapters];
  if (tailAnnotations.length > 0) {
    const lastCapture = chapters.length > 0 ? chapters[chapters.length - 1].capturedAtMs : 0;
    allChapters.push({
      snapshotIndex: chapters.length + 1,
      capturedAtMs: recordingDurationMs,
      annotations: tailAnnotations,
      folderName: chapters.length > 0 ? 'snapshot-final' : 'snapshot-1',
      // For the tail, extract the frame at the very end (minus 500ms so the
      // last real frame is preserved — extractFrameAt rounds down).
      pngPath: undefined,
    });
    // Note: if chapters.length === 0, a "tail-only" session gets labeled
    // snapshot-1 (not snapshot-final), since there's nothing to be "final" to.
    void lastCapture;
  }

  const artifacts: ChapterArtifact[] = [];

  for (let i = 0; i < allChapters.length; i++) {
    const ch = allChapters[i];
    const chapterStartMs = i === 0 ? 0 : allChapters[i - 1].capturedAtMs;
    const chapterEndMs = ch.capturedAtMs;
    const folderName = ch.folderName;
    const dir = path.join(snapshotsRoot, folderName);
    ensureDir(dir);

    // PNG: use the live one if already written; else extract from MP4 at capturedAtMs.
    const canonicalPng = path.join(dir, `${folderName}.png`);
    let pngPath = canonicalPng;
    if (ch.pngPath && fs.existsSync(ch.pngPath) && ch.pngPath !== canonicalPng) {
      try {
        fs.renameSync(ch.pngPath, canonicalPng);
      } catch {
        // Copy fallback if rename across dirs fails.
        try {
          fs.copyFileSync(ch.pngPath, canonicalPng);
          fs.unlinkSync(ch.pngPath);
        } catch { /* leave it */ }
      }
    } else if (!fs.existsSync(canonicalPng) && fs.existsSync(mp4Path)) {
      // Extract from MP4 at capturedAtMs. For the tail chapter, offset further
      // back (500ms) so fast-seek lands safely inside the stream: libx264 at
      // -g default puts keyframes ~8s apart and `-ss` before `-i` can silently
      // exit 0 without writing a PNG when the request lands between the last
      // keyframe and true EOF. Verify the file exists; if not, retry with
      // accurate (slow) seek by placing -ss after -i.
      const isTail = folderName.startsWith('snapshot-final');
      const safetyMs = isTail ? 500 : 100;
      const extractAtMs = Math.max(0, Math.min(chapterEndMs, recordingDurationMs) - safetyMs);
      try {
        await extractFrameAt(mp4Path, canonicalPng, extractAtMs);
      } catch (err) {
        warnings.push(`chapter ${folderName} PNG extraction failed: ${(err as Error).message}`);
      }
      if (!fs.existsSync(canonicalPng)) {
        // Fallback: accurate seek (slower, but always decodes to the frame).
        try {
          await extractFrameAtAccurate(mp4Path, canonicalPng, extractAtMs);
        } catch (err) {
          warnings.push(`chapter ${folderName} accurate-seek PNG fallback failed: ${(err as Error).message}`);
        }
      }
      if (!fs.existsSync(canonicalPng)) {
        warnings.push(`chapter ${folderName} PNG missing after extract attempts (extractAtMs=${extractAtMs}, durationMs=${recordingDurationMs})`);
      }
    }

    // Bucket transcript → per-annotation notes.
    const chapterSegs = sliceTranscriptByRange(segments, chapterStartMs, chapterEndMs);
    const noteMap = bucketNotesToAnnotations(chapterSegs, ch.annotations, chapterStartMs, chapterEndMs);

    // Clone annotations and fill in `note` + `type`.
    const annsWithNotes = ch.annotations.map((a) => {
      const note = noteMap.get(a.number) ?? '';
      const type = classifyAnnotationType(note);
      return { ...a, note, type };
    });

    // Chapter artifacts.
    const transcriptPath = path.join(dir, 'transcript.txt');
    fs.writeFileSync(
      transcriptPath,
      chapterSegs.map((s) => s.text).join('\n') + (chapterSegs.length > 0 ? '\n' : ''),
      'utf-8'
    );

    const annotationsPath = path.join(dir, 'annotations.json');
    fs.writeFileSync(
      annotationsPath,
      JSON.stringify({
        snapshotIndex: ch.snapshotIndex,
        folderName,
        chapterStartMs,
        chapterEndMs,
        capturedAtMs: ch.capturedAtMs,
        annotations: annsWithNotes,
      }, null, 2),
      'utf-8'
    );

    const promptMd = buildPerSnapshotPromptMd(annsWithNotes, pngPath);
    const promptPath = path.join(dir, 'prompt.md');
    fs.writeFileSync(promptPath, promptMd, 'utf-8');

    artifacts.push({
      folderName,
      snapshotIndex: ch.snapshotIndex,
      capturedAtMs: ch.capturedAtMs,
      chapterStartMs,
      chapterEndMs,
      dir,
      pngPath,
      promptPath,
      transcriptPath,
      annotationsPath,
      annotationCount: ch.annotations.length,
    });
  }

  return artifacts;
}

/**
 * Combined prompt when snapshot chapters are present. References each chapter's
 * prompt.md by absolute path so Claude Code can walk them in order.
 */
function buildCombinedSnapshotPrompt(args: {
  sessionDir: string;
  gifPath: string | null;
  transcriptPath: string | null;
  chapters: ChapterArtifact[];
  durationMs: number;
}): string {
  const { sessionDir, gifPath, transcriptPath, chapters, durationMs } = args;
  const screenCount = chapters.length;
  const durationLabel = formatMsAsMinSec(durationMs);

  const lines: string[] = [];
  lines.push(
    `I recorded a ${durationLabel} feedback walkthrough covering ${screenCount} screen${screenCount === 1 ? '' : 's'}.`
  );
  lines.push('');
  lines.push(`Session folder: ${sessionDir}`);
  // MP4 intentionally omitted because LLMs usually cannot decode video.
  // Session-local recording.mp4 is retained for human troubleshooting.
  if (gifPath) {
    lines.push(`GIF preview (LLMs see the FIRST FRAME only — opening shot): ${gifPath}`);
  } else {
    lines.push('GIF preview: not generated for this feedback session.');
  }
  if (transcriptPath) lines.push(`Full transcript: ${transcriptPath}`);
  lines.push('');
  lines.push('Per-screen deliverables (each prompt.md has its own screenshot + transcript slice + numbered annotations):');
  for (const c of chapters) {
    const dur = formatMsAsMinSec(c.chapterEndMs - c.chapterStartMs);
    lines.push(`  ${c.snapshotIndex}. ${c.promptPath}   (${c.annotationCount} annotation${c.annotationCount === 1 ? '' : 's'}, ${dur})`);
  }
  lines.push('');
  lines.push(
    'Please process each per-screen prompt.md in order. Open each screenshot PNG to see exactly what was on screen and what was annotated. The transcript slice in each chapter folder contains the spoken notes that belong to those numbered annotations (bucketed by the timestamp when each was drawn). Keep track of which file/component each screen refers to.'
  );
  lines.push('');
  return lines.join('\n');
}

function buildPromptText(args: {
  transcriptPath: string | null;
  annotationsPath: string;
  annotationFrames: Array<{ number: number; path: string; drawnAtMs: number }>;
  snapFrames: Array<{ path: string; name: string }>;
  annotations: AnnotationRecord[];
  /**
   * Absolute path to the GIF preview. Included in the prompt so the LLM
   * (or whatever client opens the prompt) has a still-image reference
   * for the opening shot of the recording. The MP4 is intentionally not
   * passed in because LLMs usually cannot decode video; the session-local
   * recording.mp4 is retained for human troubleshooting.
   */
  gifPath: string | null;
}): string {
  const { transcriptPath, annotationsPath, annotationFrames, snapFrames, annotations, gifPath } = args;

  // Source files block: only the LLM-readable artifacts. The MP4 is not
  // listed because most LLMs cannot decode video; session-local recording.mp4
  // remains available for human troubleshooting.
  const sourceBlock = [
    'Source files (all paths absolute):',
    gifPath
      ? `- GIF preview (12x speedup with timecode burned in): ${gifPath}`
      : '- GIF preview: not generated for this feedback session.',
    gifPath ? "  ↑ Multimodal LLMs (Claude, GPT-4o, Gemini) decode GIFs as still" : null,
    gifPath ? '    images and read the FIRST FRAME — i.e. T=0 of the recording.' : null,
    gifPath ? '    Useful for "what app/screen was I on" but NOT for mid-session' : null,
    gifPath ? '    moments. For specific moments, see the annotation/snapshot' : null,
    gifPath ? '    frames below (if any) — those are PNGs captured at exact times.' : null,
    transcriptPath
      ? `- Transcript (timestamped): ${transcriptPath}`
      : '- Transcript unavailable (Whisper is not installed — open Settings > Trade Mode > Install Whisper)',
    `- Structured metadata (annotations, region, durations): ${annotationsPath}`,
  ].filter(Boolean).join('\n');

  const hasAnnotations = annotations.length > 0;
  const hasSnaps = snapFrames.length > 0;
  const hasVisualEvidence = annotationFrames.length > 0 || hasSnaps;

  // Annotation evidence section — shown only when there's actually
  // visual evidence to reference. Skips the empty "(no annotation
  // frames)" / "(no manual snaps)" lines that previously cluttered
  // transcript-only prompts.
  const annotationFrameListing = annotationFrames
    .map((f) => `  #${f.number} (${formatMsAsMinSec(f.drawnAtMs)}): ${f.path}`)
    .join('\n');
  const snapFrameListing = snapFrames.map((f) => `  ${f.name}: ${f.path}`).join('\n');
  const visualEvidenceBlock = hasVisualEvidence
    ? [
        '',
        'Visual evidence:',
        annotationFrames.length > 0 ? '- Frames captured at the moment each annotation was drawn:' : null,
        annotationFrames.length > 0 ? annotationFrameListing : null,
        snapFrames.length > 0 ? '- Manual snap frames captured during the recording:' : null,
        snapFrames.length > 0 ? snapFrameListing : null,
      ].filter(Boolean).join('\n')
    : '';

  // Annotation summary — only when annotations exist.
  const annotationSummaryBlock = hasAnnotations
    ? [
        '',
        'Annotation summary (timestamps are M:SS since recording start):',
        annotations
          .map((a) => `#${a.number} at ${formatMsAsMinSec(a.drawnAtMs)} (region ${a.x},${a.y} ${a.w}×${a.h})`)
          .join('\n'),
      ].join('\n')
    : '';

  // Workflow guidance — adapts based on whether we have annotation
  // evidence or it's a transcript-only walkthrough.
  const workflowBlock = hasVisualEvidence
    ? [
        '',
        'The transcript references my annotations by number ("#1", "the first box", etc.). For each numbered comment, open the matching frame PNG to see what was on screen at that moment; the red numbered rectangle in the frame shows exactly what I was pointing at. annotations.json lists the region coordinates if you need pixel-level precision.',
      ].join('\n')
    : [
        '',
        gifPath
          ? "This was a transcript-only walkthrough — I described things verbally without drawing rectangles. The GIF (first frame) gives you the opening shot of the session for context; for mid-session moments, rely on the transcript's timestamps and the verbal cues there (the GIF's timecode is burned in, so if you need to reason about what was likely visible at minute X, mention it and I can confirm)."
          : "This was a transcript-only walkthrough — I described things verbally without drawing rectangles. GIF/MP4 preview generation was disabled, so rely on the transcript's timestamps and verbal cues.",
      ].join('\n');

  return [
    'I have a screen-recorded walkthrough with spoken feedback about my app. Please review and apply all changes.',
    '',
    sourceBlock,
    visualEvidenceBlock,
    annotationSummaryBlock,
    workflowBlock,
    '',
    'Work through each observation in the transcript in order. For each item:',
    hasVisualEvidence
      ? '- Open the corresponding frame PNG (or the GIF first frame) to confirm visually what I meant'
      : gifPath
        ? '- Open the GIF (first frame) for the opening visual context; rely on transcript timestamps for mid-session moments'
        : '- Rely on transcript timestamps and verbal cues; no GIF/MP4 preview was generated for this session',
    '- Identify which file(s) need to change',
    '- Make the change',
    '- Note the timestamp from the transcript so I can verify',
    '',
    'Start by reading the transcript and opening each frame, then summarize what you see before making changes.',
  ].join('\n');
}

// ─── main entry ──────────────────────────────────────────────────────

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const warnings: string[] = [];
  const abortSignal = input.abortSignal;
  throwIfAborted(abortSignal);
  const startedAt = new Date(input.startedAtMs);
  const stamp = formatSessionStamp(startedAt);
  // Folder suffix mirrors the capture mode: 'feedback' for record-mode (the
  // legacy default — annotation walkthroughs) and 'trade' for trade-mode
  // (TradeCall sessions). Pre-created dirs (live snaps) already encode the
  // right suffix in main; this fallback handles the case where main didn't
  // pre-create the dir (e.g. unexpected stop with no live snaps).
  const mode = input.mode ?? 'record';
  const folderSuffix = mode === 'trade' ? 'trade' : 'feedback';
  const sessionBasename = `${stamp} ${folderSuffix}`;
  // Use a pre-created dir (for live snaps) if available, otherwise create one.
  const sessionDir = input.preCreatedSessionDir ?? path.join(input.outputRoot, sessionBasename);
  ensureDir(sessionDir);
  const sessionInputsDir = mode === 'trade' ? path.join(sessionDir, 'Inputs') : sessionDir;
  ensureDir(sessionInputsDir);
  const tempInputsDir = path.join(sessionDir, 'Inputs');
  ensureDir(tempInputsDir);
  const chapters = input.chapters ?? [];
  const useChapterFlow = chapters.length > 0;
  const feedbackOutputs = input.feedbackOutputs ?? { generateMp4: true, generateGif: true };
  const keepMp4Output = mode === 'trade' || feedbackOutputs.generateMp4 !== false;
  const generateGifOutput = mode === 'trade' || feedbackOutputs.generateGif !== false;
  const missingChapterPng = chapters.some((chapter) => !chapter.pngPath || !fs.existsSync(chapter.pngPath));
  const needsMp4ForFrames = input.annotations.length > 0 || missingChapterPng;
  const shouldTranscodeMp4 = keepMp4Output || generateGifOutput || needsMp4ForFrames;
  log('pipeline', 'session start', { sessionDir, annotations: input.annotations.length });

  // Session-local media is the processing source of truth. Parent-level fixed
  // temp files can collide when a new recording starts while an older one is
  // still processing, so only the latest MP4 convenience copy lives at root.
  //
  // The GIF filename mirrors the session folder name so it's self-describing
  // if moved or referenced elsewhere.
  const webmPath = path.join(sessionDir, 'recording.webm');
  const mp4OutputPath = path.join(sessionDir, 'recording.mp4');
  const mp4Path = keepMp4Output ? mp4OutputPath : path.join(tempInputsDir, 'recording.preview-source.mp4');
  const latestMp4Path = path.join(input.outputRoot, 'recording.mp4');
  const wavPath = path.join(sessionInputsDir, 'recording.wav');
  const gifPath = path.join(sessionDir, `${sessionBasename}.gif`);
  const promptGifPath = generateGifOutput ? gifPath : null;
  const transcriptPath = path.join(sessionDir, 'transcript.txt');
  const annotationsPath = path.join(sessionInputsDir, 'annotations.json');
  const promptPath = path.join(sessionDir, 'prompt.txt');
  writeSessionLog(sessionDir, 'pipeline', 'session processing started', {
    mode,
    webmBytes: input.webmBuffer.length,
    durationMs: input.durationMs,
    annotations: input.annotations.length,
    chapters: input.chapters?.length ?? 0,
    tradeMarkers: input.tradeMarkers?.length ?? 0,
    hasPreCreatedSessionDir: Boolean(input.preCreatedSessionDir),
    keepMp4Output,
    generateGifOutput,
    shouldTranscodeMp4,
  }, 'start');

  // Helper: best-effort step notification. UI bookkeeping must never break
  // the pipeline, so any throw inside the callback is silently swallowed.
  const step = (label: string) => {
    throwIfAborted(abortSignal);
    if (!input.onStep) return;
    try { input.onStep(label); } catch { /* ignore */ }
  };

  // 1. Persist the webm buffer.
  step('Saving recording…');
  throwIfAborted(abortSignal);
  fs.writeFileSync(webmPath, input.webmBuffer);
  log('pipeline', 'wrote session webm', { webmPath, bytes: input.webmBuffer.length });
  writeSessionLog(sessionDir, 'pipeline', 'session recording.webm written', {
    webmPath,
    bytes: input.webmBuffer.length,
  }, 'success');

  // 2-5. Parallel branches: audio (whisper) and video (mp4 + gif). Both
  //      read directly from the webm. Whisper is the long pole (~60s on
  //      a 7-min clip); mp4 transcode is ~30-40s; gif is ~30s. Running
  //      them in parallel lets the prompt + clipboard land at roughly
  //      max(whisper, mp4+gif) instead of their sum.
  let finalTranscriptPath: string | null = null;
  let transcriptSegments: TranscriptSegment[] = [];

  // ── Branch A: webm → wav → whisper → transcript.txt ────────────────
  const whisper = findWhisperBinary();
  const audioBranch = (async () => {
    if (!whisper) {
      warnings.push(
        'Whisper is not installed — open Settings > Trade Mode > Install Whisper; skipped transcription'
      );
      writeSessionLog(sessionDir, 'whisper', 'not installed; transcription skipped', undefined, 'skipped');
      return;
    }
    try {
      if (input.incrementalTranscript) {
        step('Finalizing live transcript…');
        try {
          const incremental = await input.incrementalTranscript;
          if (incremental && incremental.chunkCount > 0 && incremental.failedChunks === 0) {
            transcriptSegments = incremental.segments;
            const recordingDurationSec = Math.round(input.durationMs / 1000);
            const finalText = buildTranscriptText(
              recordingDurationSec,
              transcriptSegments,
              incremental.diagnostics,
              `incremental whisper during recording (${incremental.chunkCount} chunks, max-context 0)`
            );
            fs.writeFileSync(transcriptPath, finalText, 'utf-8');
            log('pipeline', 'incremental transcript written', {
              segments: transcriptSegments.length,
              recordingDurationSec,
              chunks: incremental.chunkCount,
              warnings: incremental.warnings.length,
            });
            writeSessionLog(sessionDir, 'whisper', 'incremental transcript used', {
              transcriptPath,
              segments: transcriptSegments.length,
              recordingDurationSec,
              chunks: incremental.chunkCount,
              warnings: incremental.warnings,
            }, incremental.warnings.length > 0 ? 'warning' : 'success');
            warnings.push(...incremental.warnings.map((warning) => `incremental transcription: ${warning}`));
            finalTranscriptPath = transcriptPath;
            return;
          }
          if (incremental && incremental.failedChunks > 0) {
            warnings.push(`incremental transcription had ${incremental.failedChunks} failed chunk(s); falling back to full post-stop transcription`);
            writeSessionLog(sessionDir, 'whisper', 'incremental transcript rejected; falling back to full transcription', {
              chunks: incremental.chunkCount,
              failedChunks: incremental.failedChunks,
              warnings: incremental.warnings,
            }, 'warning');
          } else {
            writeSessionLog(sessionDir, 'whisper', 'incremental transcript unavailable; falling back to full transcription', undefined, 'skipped');
          }
        } catch (err) {
          warnings.push(`incremental transcription failed: ${(err as Error).message}; falling back to full post-stop transcription`);
          writeSessionLog(sessionDir, 'whisper', 'incremental transcript promise failed; falling back to full transcription', {
            error: (err as Error).message,
          }, 'warning');
        }
      }
      step('Extracting audio…');
      await webmToWav(webmPath, wavPath, abortSignal);
      writeSessionLog(sessionDir, 'whisper', 'audio extracted for transcription', undefined, 'success');
      step('Transcribing speech (whisper)…');
      writeSessionLog(sessionDir, 'whisper', 'transcription started', {
        exe: whisper.exe,
        model: whisper.model,
        chunkSec: WHISPER_CHUNK_SEC,
        overlapSec: WHISPER_CHUNK_OVERLAP_SEC,
        maxContext: 0,
      }, 'start');
      const recordingDurationSec = Math.round(input.durationMs / 1000);
      const chunked = await transcribeWavInChunks(
        whisper.exe,
        whisper.model,
        wavPath,
        sessionDir,
        recordingDurationSec,
        abortSignal
      );
      transcriptSegments = chunked.segments;
      if (transcriptSegments.length > 0 || chunked.diagnostics.some((d) => d.audioPresent)) {
        // Build the transcript text with a duration header + silence-tail
        // marker. Without these, a long silent stretch at the end of the
        // recording (e.g. trader watches charts without commentary) makes
        // the transcript appear to end early. The user (and the LLM that
        // reads the prompt) sees the file ending at, say, 5:48 and assumes
        // the recording was 5:48 long — when in fact it was 10:21 with the
        // trader silent from 4:38 onwards. Trades firing during that silent
        // stretch then look like they fired "after the recording" when
        // they're actually inside it. Explicit tail marker fixes this.
        const lastSegEndSec = transcriptSegments.length > 0
          ? transcriptSegments[transcriptSegments.length - 1].endSec
          : 0;
        const fmt = formatTranscriptTime;
        const headerLines: string[] = [];
        headerLines.push(`# Recording duration: ${fmt(recordingDurationSec)}`);
        headerLines.push(`# Transcription mode: chunked whisper (${WHISPER_CHUNK_SEC}s chunks, ${WHISPER_CHUNK_OVERLAP_SEC}s overlap, max-context 0)`);
        if (transcriptSegments.length > 0) {
          headerLines.push(`# Last narration segment ended at ${fmt(lastSegEndSec)}`);
        } else {
          headerLines.push('# No narration detected (whisper produced no segments)');
        }
        const suspiciousChunks = chunked.diagnostics.filter((d) => d.suspicious);
        if (suspiciousChunks.length > 0) {
          headerLines.push(`# Audio review warnings: ${suspiciousChunks.length} chunk(s) had audio but no speech-like transcript after retry`);
        }
        headerLines.push('');
        const bodyLines = transcriptSegments.map((s) => s.text);
        // Append tail marker when there's a non-trivial silent gap
        // (>10s) between the last whisper segment and the end of the
        // recording. The threshold avoids spamming the marker for
        // every recording that ends 1-2s after the last word.
        const tailGapSec = recordingDurationSec - lastSegEndSec;
        const tailLines: string[] = [];
        if (tailGapSec > 10) {
          const tailHasAudio = chunked.diagnostics.some((d) =>
            d.audioPresent && d.endSec > lastSegEndSec + 1
          );
          tailLines.push(
            tailHasAudio
              ? `[${fmt(lastSegEndSec)} - ${fmt(recordingDurationSec)}] [AUDIO PRESENT - no speech-like transcript was produced in the remaining ${fmt(tailGapSec)}; review source audio if commentary is expected]`
              : `[${fmt(lastSegEndSec)} - ${fmt(recordingDurationSec)}] [SILENT - no audible speech detected for ${fmt(tailGapSec)}; recording continued through this stretch]`
          );
        }
        const finalText = [
          ...headerLines,
          ...bodyLines,
          ...tailLines,
        ].join('\n') + '\n';
        fs.writeFileSync(transcriptPath, finalText, 'utf-8');
        log('pipeline', 'transcript written', {
          segments: transcriptSegments.length,
          recordingDurationSec,
          lastSegEndSec,
          silentTailSec: tailGapSec > 0 ? tailGapSec : 0,
          chunks: chunked.diagnostics.length,
          suspiciousChunks: suspiciousChunks.length,
        });
        writeSessionLog(sessionDir, 'whisper', 'transcript written', {
          transcriptPath,
          segments: transcriptSegments.length,
          recordingDurationSec,
          lastSegEndSec,
          silentTailSec: tailGapSec > 0 ? tailGapSec : 0,
          chunks: chunked.diagnostics.length,
          suspiciousChunks: suspiciousChunks.length,
        }, 'success');
        finalTranscriptPath = transcriptPath;
      } else {
        warnings.push('whisper ran but produced no SRT');
        writeSessionLog(sessionDir, 'whisper', 'whisper finished without SRT output', undefined, 'warning');
      }
    } catch (err) {
      warnings.push(`whisper failed: ${(err as Error).message}`);
      log('pipeline', 'whisper fail', { err: String(err) });
      writeSessionLog(sessionDir, 'whisper', 'transcription failed', { error: (err as Error).message }, 'error');
    } finally {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
  })();

  // ── Branch B: webm → mp4 → gif ─────────────────────────────────────
  // gif waits on mp4 (it reads from the normalized CFR mp4). The mp4
  // also gates the chapter PNG extraction below, so we expose the mp4
  // promise separately and await it before the chapters step.
  const mp4Promise = (async () => {
    if (!shouldTranscodeMp4) {
      writeSessionLog(sessionDir, 'video', 'mp4 conversion skipped by feedback output settings', {
        keepMp4Output,
        generateGifOutput,
        needsMp4ForFrames,
      }, 'skipped');
      return;
    }
    step('Converting video to MP4…');
    try {
      await webmToMp4(webmPath, mp4Path, abortSignal);
      log('pipeline', 'session mp4 written', { mp4Path });
      writeSessionLog(sessionDir, 'video', keepMp4Output ? 'session recording.mp4 written' : 'temporary mp4 written for derived artifacts', {
        mp4Path,
        keepMp4Output,
      }, 'success');
      if (keepMp4Output) {
        try {
          fs.copyFileSync(mp4Path, latestMp4Path);
          log('pipeline', 'latest parent mp4 copied', { latestMp4Path });
          writeSessionLog(sessionDir, 'video', 'latest parent recording.mp4 copied', {
            sourcePath: mp4Path,
            latestMp4Path,
          }, 'success');
        } catch (copyErr) {
          const message = (copyErr as Error).message;
          warnings.push(`latest recording.mp4 copy failed: ${message}`);
          log('pipeline', 'latest parent mp4 copy failed', { err: message, latestMp4Path });
          writeSessionLog(sessionDir, 'video', 'latest parent recording.mp4 copy failed', {
            sourcePath: mp4Path,
            latestMp4Path,
            error: message,
          }, 'warning');
        }
      }
    } catch (err) {
      warnings.push(`mp4 conversion failed: ${(err as Error).message}`);
      log('pipeline', 'mp4 fail', { err: String(err) });
      writeSessionLog(sessionDir, 'video', 'mp4 conversion failed', { error: (err as Error).message }, 'error');
    }
  })();
  const gifPromise = mp4Promise.then(async () => {
    if (!generateGifOutput) {
      writeSessionLog(sessionDir, 'video', 'gif generation skipped by feedback output settings', undefined, 'skipped');
      return;
    }
    if (!fs.existsSync(mp4Path)) return;
    try {
      step('Generating GIF preview…');
      await mp4ToGif(mp4Path, gifPath, input.outputRoot, abortSignal);
      writeSessionLog(sessionDir, 'video', 'gif written', { gifPath }, 'success');
    } catch (err) {
      warnings.push(`gif generation failed: ${(err as Error).message}`);
      log('pipeline', 'gif fail', { err: String(err) });
      writeSessionLog(sessionDir, 'video', 'gif generation failed', { error: (err as Error).message }, 'error');
    }
  });

  // Wait for whisper + mp4. Chapters need both: the mp4 for tail-frame
  // extraction, and transcriptSegments for slicing. (gif keeps running
  // in the background and we'll await it at the very end.)
  await Promise.all([audioBranch, mp4Promise]);
  throwIfAborted(abortSignal);

  // 6a. (legacy path only) Extract a PNG at the exact millisecond each
  //     annotation was drawn. Skipped in the snapshot-chapter flow because
  //     each chapter's own PNG already bakes in the relevant annotations.
  const annotationFrames: Array<{ number: number; path: string; drawnAtMs: number }> = [];
  if (!useChapterFlow && fs.existsSync(mp4Path) && input.annotations.length > 0) {
    for (const a of input.annotations) {
      const framePath = path.join(sessionDir, `frame-${a.number}.png`);
      try {
        await extractFrameAt(mp4Path, framePath, a.drawnAtMs);
        if (fs.existsSync(framePath)) {
          annotationFrames.push({ number: a.number, path: framePath, drawnAtMs: a.drawnAtMs });
        }
      } catch (err) {
        warnings.push(`frame for annotation #${a.number} failed: ${(err as Error).message}`);
        log('pipeline', 'frame fail', { number: a.number, err: String(err) });
      }
    }
    log('pipeline', 'annotation frames extracted', { count: annotationFrames.length });
  }

  // 6b. Collect any snap-N-MM-SS.png files the user captured live via the
  //     HUD snap button (legacy — preserved for back-compat). They already
  //     exist in sessionDir (written during recording); we just need to
  //     discover and sort them.
  const snapFrames: Array<{ path: string; name: string }> = fs
    .readdirSync(sessionDir)
    .filter((f) => /^snap-\d+-.+\.png$/.test(f))
    .sort()
    .map((f) => ({ path: path.join(sessionDir, f), name: f }));
  if (snapFrames.length > 0) {
    log('pipeline', 'snap frames found', { count: snapFrames.length });
  }

  // 6c. Snapshot chapters: one folder per 📸 press plus an optional tail
  //     chapter for any annotations drawn after the last snapshot.
  let chapterArtifacts: ChapterArtifact[] = [];
  if (useChapterFlow) {
    step('Slicing snapshot chapters…');
    try {
      chapterArtifacts = await buildSnapshotChapters(
        mp4Path,
        sessionDir,
        chapters,
        input.annotations,
        transcriptSegments,
        input.durationMs,
        warnings
      );
      log('pipeline', 'chapters written', { count: chapterArtifacts.length });
    } catch (err) {
      warnings.push(`snapshot chapters failed: ${(err as Error).message}`);
      log('pipeline', 'chapters fail', { err: String(err) });
    }
  }

  // 7. annotations.json (master — every annotation across all chapters + tail).
  const allAnnotations: AnnotationRecord[] = useChapterFlow
    ? [...chapters.flatMap((c) => c.annotations), ...input.annotations]
    : input.annotations;
  const annotationsDoc = {
    recordingStartedAtUtc: startedAt.toISOString(),
    durationMs: input.durationMs,
    recordingRegion: input.recordingRegion,
    annotations: allAnnotations,
    chapters: useChapterFlow
      ? chapterArtifacts.map((c) => ({
          snapshotIndex: c.snapshotIndex,
          folderName: c.folderName,
          chapterStartMs: c.chapterStartMs,
          chapterEndMs: c.chapterEndMs,
          capturedAtMs: c.capturedAtMs,
          annotationCount: c.annotationCount,
        }))
      : undefined,
  };
  fs.writeFileSync(annotationsPath, JSON.stringify(annotationsDoc, null, 2), 'utf-8');
  writeSessionLog(sessionDir, 'pipeline', 'annotations written', {
    annotationsPath,
    annotationCount: allAnnotations.length,
    chapterCount: chapterArtifacts.length,
  }, 'success');
  throwIfAborted(abortSignal);

  // 8. prompt.txt + clipboard
  const promptText = useChapterFlow
    ? buildCombinedSnapshotPrompt({
        sessionDir,
        gifPath: promptGifPath,
        transcriptPath: finalTranscriptPath,
        chapters: chapterArtifacts,
        durationMs: input.durationMs,
      })
    : buildPromptText({
        transcriptPath: finalTranscriptPath,
        annotationsPath,
        annotationFrames,
        snapFrames,
        annotations: input.annotations,
        gifPath: promptGifPath,
      });

  // In trade-mode, the trade-pipeline (below) owns the clipboard — it
  // writes the extraction prompt the user pastes into their LLM. If we
  // wrote the legacy walkthrough prompt + clipboarded it here, the user
  // could paste in the ~30s gap before the trade-pipeline catches up
  // and get the wrong prompt. Skip the legacy clipboard write entirely
  // for trade sessions; still write a stub prompt.txt pointing at the
  // trade artifacts so the file isn't missing.
  if (mode === 'trade') {
    const stub = [
      'This is a trade-mode session. The Snipalot extraction prompt will be written here shortly.',
      '',
      'Paste prompt.txt into Claude Code / Gemini / Cursor, then save the JSON',
      'reply as Inputs/extraction_response.json. Snipalot will',
      'pick it up and generate trade_log.xlsx + trade_log.md.',
      '',
      'For richer reporting, also drop your MockApe trade export into',
      'Inputs/mockape.json — the trade-pipeline will join it to',
      'your spoken trades by token name + timestamp and enrich the log',
      'with actual entry/exit market caps + P&L per trade.',
      '',
    ].join('\n');
    fs.writeFileSync(promptPath, stub, 'utf-8');
    log('pipeline', 'trade-mode stub prompt.txt written (trade-pipeline owns clipboard)');
    writeSessionLog(sessionDir, 'pipeline', 'trade prompt placeholder written', { promptPath }, 'success');
  } else {
    step('Writing prompt + copying to clipboard…');
    fs.writeFileSync(promptPath, promptText, 'utf-8');
    clipboard.writeText(promptText);
    log('pipeline', 'prompt written + clipboarded', {
      length: promptText.length,
      mode: useChapterFlow ? 'chapters' : 'legacy',
      chapters: chapterArtifacts.length,
      annotationFrames: annotationFrames.length,
      snapFrames: snapFrames.length,
    });
    writeSessionLog(sessionDir, 'pipeline', 'prompt written and copied to clipboard', {
      promptPath,
      chars: promptText.length,
      mode: useChapterFlow ? 'chapters' : 'legacy',
      chapters: chapterArtifacts.length,
      annotationFrames: annotationFrames.length,
      snapFrames: snapFrames.length,
    }, 'success');
  }

  // The user's clipboard is now populated — they can act on it. The gif
  // may still be encoding in the background; await it so the cleanup of
  // recording.webm doesn't yank the input out from under it. (gif reads
  // from the mp4, not the webm, but we await for log/error symmetry.)
  await gifPromise;
  throwIfAborted(abortSignal);

  if (!keepMp4Output && fs.existsSync(mp4Path)) {
    try {
      fs.unlinkSync(mp4Path);
      writeSessionLog(sessionDir, 'video', 'temporary mp4 deleted after derived artifacts', { mp4Path }, 'success');
    } catch (err) {
      writeSessionLog(sessionDir, 'video', 'temporary mp4 retained after delete failure', {
        mp4Path,
        error: (err as Error).message,
      }, 'warning');
    }
  }

  // 9. cleanup intermediate webm (mp4/gif/transcript stay; this is the
  //    only intermediate). At this point the gif promise has resolved
  //    so nothing else is reading from disk.
  try {
    fs.unlinkSync(webmPath);
    writeSessionLog(sessionDir, 'pipeline', 'session recording.webm deleted after processing', { webmPath }, 'success');
  } catch {
    writeSessionLog(sessionDir, 'pipeline', 'session recording.webm retained', { webmPath }, 'warning');
  }

  // 10. Trade-mode extension: after the legacy pipeline finishes, run the
  //     trade-pipeline which writes prompt.txt (M4) and once the
  //     user pastes a response, generates trade_log.xlsx + trade_log.md (M5). This
  //     is fire-and-forget — the launcher already exited 'processing' so
  //     trade work happens in the background. M3 scaffold logs only.
  if (mode === 'trade') {
    try {
      const { runTradePipeline } = await import('./trade-pipeline');
      const tradeResult = await runTradePipeline({
        sessionDir,
        mp4Path,
        transcriptSegments,
        tradeMarkers: input.tradeMarkers ?? [],
        startedAtMs: input.startedAtMs,
        durationMs: input.durationMs,
        onStep: input.onStep,
        onPromptReady: input.onTradePromptReady,
        abortSignal,
      });
      warnings.push(...tradeResult.warnings);
    } catch (err) {
      warnings.push(`trade-pipeline import/launch failed: ${(err as Error).message}`);
      log('pipeline', 'trade-pipeline launch fail', { err: String(err) });
      writeSessionLog(sessionDir, 'trade-pipeline', 'launch failed', { error: (err as Error).message }, 'error');
    }
  }

  log('pipeline', 'session complete', { sessionDir, warnings, mode });
  writeSessionLog(sessionDir, 'pipeline', 'session processing finished', {
    mode,
    warnings,
    transcriptWritten: Boolean(finalTranscriptPath),
    frameCount: [
      ...annotationFrames.map((f) => f.path),
      ...snapFrames.map((f) => f.path),
      ...chapterArtifacts.map((c) => c.pngPath),
    ].length,
  }, warnings.length > 0 ? 'warning' : 'success');

  return {
    sessionDir,
    mp4Path,
    transcriptPath: finalTranscriptPath,
    annotationsPath,
    promptPath,
    framePaths: [
      ...annotationFrames.map((f) => f.path),
      ...snapFrames.map((f) => f.path),
      ...chapterArtifacts.map((c) => c.pngPath),
    ],
    promptText,
    warnings,
  };
}
