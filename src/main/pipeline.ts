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
 *   5. renders a 1-fps animated GIF with a burned-in timecode overlay
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
import { clipboard } from 'electron';
import { log } from './logger';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegPathRaw: string | null = require('ffmpeg-static');

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
   * mode === 'record' or when the user never pressed Ctrl+Shift+T during a
   * trade session. Markers are anchor points for the LLM extraction prompt;
   * extraction works without them, just less precisely.
   */
  tradeMarkers?: number[];
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

function runFfmpeg(args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPathRaw) {
      reject(new Error('ffmpeg-static did not resolve a binary path'));
      return;
    }
    log('ffmpeg', label, { args });
    const proc = spawn(ffmpegPathRaw, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg (${label}) exited ${code}. stderr tail: ${stderr.slice(-500)}`));
      }
    });
  });
}

async function webmToMp4(webmPath: string, mp4Path: string): Promise<void> {
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
    'webm→mp4 (CFR 30fps, ≤1080p)'
  );
}

async function webmToWav(webmPath: string, wavPath: string): Promise<void> {
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
    'webm→wav (16kHz mono, audio-only)'
  );
}

async function mp4ToGif(
  mp4Path: string,
  gifPath: string,
  outputRoot: string
): Promise<void> {
  // 12x time-lapse GIF with original-time timecode burned in.
  //
  // Filter order MATTERS — discovered empirically:
  //   setpts=PTS/12  (compress timeline 12x)
  //   fps=12         (resample at 12fps; yields one frame per source-second)
  //   drawtext       (timecode label using `n` which now == source-seconds)
  //   scale=800:-1   (downscale)
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
  const textRel = path
    .relative(process.cwd(), textfilePath)
    .replace(/\\/g, '/');

  const filter =
    `[0:v]setpts=PTS/12,fps=12,drawtext=textfile=${textRel}:expansion=normal:x=10:y=10:fontsize=24:fontcolor=white:borderw=2:bordercolor=black,scale=800:-1,split[a][b];` +
    '[a]palettegen=stats_mode=diff[palette];' +
    '[b][palette]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';

  try {
    await runFfmpeg(
      ['-y', '-i', mp4Path, '-filter_complex', filter, gifPath],
      'mp4→gif (12x speedup, palette 2-pass)'
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
  atMs: number
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
    `frame at ${seekSec}s`
  );
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
  atMs: number
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
    `frame at ${seekSec}s (accurate)`
  );
}

// ─── whisper.cpp helpers ─────────────────────────────────────────────

function findWhisperBinary(): { exe: string; model: string } | null {
  // During development, resources/ lives next to the project root. For a
  // packaged build, process.resourcesPath would be used instead. For now,
  // check both.
  const candidates = [
    path.join(process.cwd(), 'resources'),
    // Packaged app: bundled under resources/
    path.join(process.resourcesPath || '', 'resources'),
  ];

  for (const root of candidates) {
    if (!root || !fs.existsSync(root)) continue;
    const binDir = path.join(root, 'bin', 'whisper');
    // whisper.cpp recent releases renamed main.exe → whisper-cli.exe.
    const exeCandidates = [
      path.join(binDir, 'whisper-cli.exe'),
      path.join(binDir, 'main.exe'),
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
}

function parseSrtToTranscript(srtText: string): TranscriptSegment[] {
  // SRT block pattern: index, HH:MM:SS,mmm --> HH:MM:SS,mmm, text, blank.
  // We fold each subtitle into "[M:SS - M:SS] text" and retain the start
  // second so the pipeline can extract a representative frame for each segment.
  const lines = srtText.split(/\r?\n/);
  const out: TranscriptSegment[] = [];
  let currentStamp = '';
  let currentStartSec = 0;

  // SRT timestamp: HH:MM:SS,mmm --> HH:MM:SS,mmm
  const tsPattern = /^(\d{2}):(\d{2}):(\d{2}),\d+\s+-->\s+(\d{2}):(\d{2}):(\d{2}),\d+/;

  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(tsPattern);
    if (m) {
      const startTotalSec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      const endTotalSec   = parseInt(m[4], 10) * 3600 + parseInt(m[5], 10) * 60 + parseInt(m[6], 10);
      const startMin = Math.floor(startTotalSec / 60);
      const startSecRem = startTotalSec % 60;
      const endMin = Math.floor(endTotalSec / 60);
      const endSecRem = endTotalSec % 60;
      currentStartSec = startTotalSec;
      currentStamp = `[${startMin}:${String(startSecRem).padStart(2, '0')} - ${endMin}:${String(endSecRem).padStart(2, '0')}]`;
      continue;
    }
    if (line !== '' && !/^\d+$/.test(line) && currentStamp) {
      out.push({ text: `${currentStamp} ${line}`, startSec: currentStartSec });
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
  return out;
}

function runWhisper(
  exe: string,
  modelPath: string,
  wavPath: string,
  outPrefix: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', modelPath,
      '-f', wavPath,
      '-l', 'en',
      '-osrt',
      '-of', outPrefix,
    ];
    log('whisper', 'spawn', { exe, args });
    const proc = spawn(exe, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`whisper exited ${code}. stderr tail: ${stderr.slice(-500)}`));
    });
  });
}

// ─── prompt template ─────────────────────────────────────────────────

function formatMsAsMinSec(ms: number): string {
  const mm = Math.floor(ms / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  return `${mm}:${String(ss).padStart(2, '0')}`;
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
  mp4Path: string;
  gifPath: string;
  transcriptPath: string | null;
  chapters: ChapterArtifact[];
  durationMs: number;
}): string {
  const { sessionDir, mp4Path, gifPath, transcriptPath, chapters, durationMs } = args;
  const screenCount = chapters.length;
  const durationLabel = formatMsAsMinSec(durationMs);

  const lines: string[] = [];
  lines.push(
    `I recorded a ${durationLabel} feedback walkthrough covering ${screenCount} screen${screenCount === 1 ? '' : 's'}.`
  );
  lines.push('');
  lines.push(`Session folder: ${sessionDir}`);
  lines.push(`Recording: ${mp4Path}`);
  lines.push(`GIF (for visual reference, not for Claude): ${gifPath}`);
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
}): string {
  const { transcriptPath, annotationsPath, annotationFrames, snapFrames, annotations } = args;

  const transcriptLine = transcriptPath
    ? `1. Read the transcript: ${transcriptPath}`
    : `1. (Transcript unavailable — whisper.cpp not installed; see annotations.json for the visual context only.)`;

  // Annotation frames: captured at the exact ms the user drew each numbered rectangle.
  const annotationFrameListing =
    annotationFrames.length === 0
      ? '(No annotation frames — no numbered rectangles were drawn this session.)'
      : annotationFrames
          .map((f) => `   #${f.number} (${formatMsAsMinSec(f.drawnAtMs)}): ${f.path}`)
          .join('\n');

  // Snap frames: captured by the user pressing the HUD 📷 button.
  const snapFrameListing =
    snapFrames.length === 0
      ? '(No manual snaps this session.)'
      : snapFrames.map((f) => `   ${f.name}: ${f.path}`).join('\n');

  const annotationSummary =
    annotations.length === 0
      ? 'No annotations were drawn during this recording.'
      : annotations
          .map((a) => `#${a.number} at ${formatMsAsMinSec(a.drawnAtMs)} (region ${a.x},${a.y} ${a.w}×${a.h})`)
          .join('\n');

  return [
    'I have a screen-recorded walkthrough with spoken feedback about my app. Please review and apply all changes.',
    '',
    transcriptLine,
    `2. Annotations (numbered rectangles I drew while recording): ${annotationsPath}`,
    '3. Frames captured at the moment each annotation was drawn (read these images directly):',
    annotationFrameListing,
    '4. Manual snap frames captured via the 📷 button (read these images directly):',
    snapFrameListing,
    '',
    'The transcript references my annotations by number ("#1", "the first box", etc.). For each numbered comment, open the matching frame-N.png to see what was on screen at that moment; the red numbered rectangle in the frame shows exactly what I was pointing at. annotations.json lists the region coordinates if you need pixel-level precision.',
    '',
    'Annotation summary (timestamps are M:SS since recording start):',
    annotationSummary,
    '',
    'Work through each observation in the transcript in order. For each item:',
    '- Open the corresponding frame PNG to confirm visually what I meant',
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
  log('pipeline', 'session start', { sessionDir, annotations: input.annotations.length });

  // Fixed-name MP4 in the parent output root — overwritten on each run, so
  // only the most recent recording's MP4 is retained. Session subfolders
  // keep GIF / transcript / frames / annotations / prompt for history.
  //
  // The GIF filename mirrors the session folder name so it's self-describing
  // if moved or referenced elsewhere.
  const webmPath = path.join(input.outputRoot, 'recording.webm');
  const mp4Path = path.join(input.outputRoot, 'recording.mp4');
  const wavPath = path.join(input.outputRoot, 'recording.wav');
  const gifPath = path.join(sessionDir, `${sessionBasename}.gif`);
  const transcriptPath = path.join(sessionDir, 'transcript.txt');
  const annotationsPath = path.join(sessionDir, 'annotations.json');
  const promptPath = path.join(sessionDir, 'prompt.txt');

  // Helper: best-effort step notification. UI bookkeeping must never break
  // the pipeline, so any throw inside the callback is silently swallowed.
  const step = (label: string) => {
    if (!input.onStep) return;
    try { input.onStep(label); } catch { /* ignore */ }
  };

  // 1. Persist the webm buffer.
  step('Saving recording…');
  fs.writeFileSync(webmPath, input.webmBuffer);
  log('pipeline', 'wrote webm', { bytes: input.webmBuffer.length });

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
        'whisper.cpp + model not installed — run `npm run fetch-resources`; skipped transcription'
      );
      return;
    }
    try {
      step('Extracting audio…');
      await webmToWav(webmPath, wavPath);
      const whisperOutPrefix = path.join(sessionDir, 'whisper-out');
      step('Transcribing speech (whisper)…');
      await runWhisper(whisper.exe, whisper.model, wavPath, whisperOutPrefix);
      const srtPath = `${whisperOutPrefix}.srt`;
      if (fs.existsSync(srtPath)) {
        const srt = fs.readFileSync(srtPath, 'utf-8');
        transcriptSegments = parseSrtToTranscript(srt);
        fs.writeFileSync(transcriptPath, transcriptSegments.map((s) => s.text).join('\n') + '\n', 'utf-8');
        finalTranscriptPath = transcriptPath;
        try { fs.unlinkSync(srtPath); } catch { /* ignore */ }
      } else {
        warnings.push('whisper ran but produced no SRT');
      }
    } catch (err) {
      warnings.push(`whisper failed: ${(err as Error).message}`);
      log('pipeline', 'whisper fail', { err: String(err) });
    } finally {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
  })();

  // ── Branch B: webm → mp4 → gif ─────────────────────────────────────
  // gif waits on mp4 (it reads from the normalized CFR mp4). The mp4
  // also gates the chapter PNG extraction below, so we expose the mp4
  // promise separately and await it before the chapters step.
  const mp4Promise = (async () => {
    step('Converting video to MP4…');
    try {
      await webmToMp4(webmPath, mp4Path);
      log('pipeline', 'mp4 written (latest, parent level)', { mp4Path });
    } catch (err) {
      warnings.push(`mp4 conversion failed: ${(err as Error).message}`);
      log('pipeline', 'mp4 fail', { err: String(err) });
    }
  })();
  const gifPromise = mp4Promise.then(async () => {
    if (!fs.existsSync(mp4Path)) return;
    try {
      step('Generating GIF preview…');
      await mp4ToGif(mp4Path, gifPath, input.outputRoot);
    } catch (err) {
      warnings.push(`gif generation failed: ${(err as Error).message}`);
      log('pipeline', 'gif fail', { err: String(err) });
    }
  });

  // Wait for whisper + mp4. Chapters need both: the mp4 for tail-frame
  // extraction, and transcriptSegments for slicing. (gif keeps running
  // in the background and we'll await it at the very end.)
  await Promise.all([audioBranch, mp4Promise]);

  const chapters = input.chapters ?? [];
  const useChapterFlow = chapters.length > 0;

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

  // 8. prompt.txt + clipboard
  const promptText = useChapterFlow
    ? buildCombinedSnapshotPrompt({
        sessionDir,
        mp4Path,
        gifPath,
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
      'This is a trade-mode session. The Snipalot prompt for your LLM is in:',
      '  extraction_prompt.md',
      '',
      'Paste that into Claude Code / Gemini / Cursor, then save the JSON',
      'reply as extraction_response.json in this folder. Snipalot will',
      'pick it up and generate trade_log.csv + trade_log.md.',
      '',
      'For richer reporting, also drop your MockApe trade export into',
      'this folder as mockape.json — the trade-pipeline will join it to',
      'your spoken trades by token name + timestamp and enrich the log',
      'with actual entry/exit market caps + P&L per trade.',
      '',
    ].join('\n');
    fs.writeFileSync(promptPath, stub, 'utf-8');
    log('pipeline', 'trade-mode stub prompt.txt written (trade-pipeline owns clipboard)');
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
  }

  // The user's clipboard is now populated — they can act on it. The gif
  // may still be encoding in the background; await it so the cleanup of
  // recording.webm doesn't yank the input out from under it. (gif reads
  // from the mp4, not the webm, but we await for log/error symmetry.)
  await gifPromise;

  // 9. cleanup intermediate webm (mp4/gif/transcript stay; this is the
  //    only intermediate). At this point the gif promise has resolved
  //    so nothing else is reading from disk.
  try {
    fs.unlinkSync(webmPath);
  } catch {
    /* leave it if we can't delete */
  }

  // 10. Trade-mode extension: after the legacy pipeline finishes, run the
  //     trade-pipeline which writes extraction_prompt.md (M4) and once the
  //     user pastes a response, generates trade_log.csv + .md (M5). This
  //     is fire-and-forget — the launcher already exited 'processing' so
  //     trade work happens in the background. M3 scaffold logs only.
  if (mode === 'trade') {
    try {
      const { runTradePipeline } = await import('./trade-pipeline');
      void runTradePipeline({
        sessionDir,
        mp4Path,
        transcriptSegments,
        tradeMarkers: input.tradeMarkers ?? [],
        startedAtMs: input.startedAtMs,
        onStep: input.onStep,
      });
    } catch (err) {
      warnings.push(`trade-pipeline import/launch failed: ${(err as Error).message}`);
      log('pipeline', 'trade-pipeline launch fail', { err: String(err) });
    }
  }

  log('pipeline', 'session complete', { sessionDir, warnings, mode });

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
