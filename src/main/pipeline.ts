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

export interface AnnotationRecord {
  number: number;
  x: number;
  y: number;
  w: number;
  h: number;
  drawnAtMs: number;
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
  /** Annotation snapshot pushed by the overlay. */
  annotations: AnnotationRecord[];
  /**
   * Session directory that was pre-created during recording (for live snaps).
   * If provided, the pipeline writes into this directory instead of computing
   * a new one from startedAtMs. Any snap-N-MMSS.png files already in there
   * are preserved.
   */
  preCreatedSessionDir?: string;
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
  await runFfmpeg(
    [
      '-y',
      '-i', webmPath,
      '-c:v', 'libx264',
      '-crf', '20',
      '-preset', 'fast',
      '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-vsync', 'cfr',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      mp4Path,
    ],
    'webm→mp4 (forced CFR 30fps)'
  );
}

async function mp4ToWav(mp4Path: string, wavPath: string): Promise<void> {
  // 16 kHz mono PCM is what whisper.cpp expects.
  await runFfmpeg(
    [
      '-y',
      '-i', mp4Path,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      wavPath,
    ],
    'mp4→wav (16kHz mono)'
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

interface TranscriptSegment {
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
  const sessionBasename = `${stamp} feedback`;
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

  // 1. Persist the webm buffer.
  fs.writeFileSync(webmPath, input.webmBuffer);
  log('pipeline', 'wrote webm', { bytes: input.webmBuffer.length });

  // 2. webm → mp4 (at parent level — overwrites the previous "latest").
  try {
    await webmToMp4(webmPath, mp4Path);
    log('pipeline', 'mp4 written (latest, parent level)', { mp4Path });
  } catch (err) {
    warnings.push(`mp4 conversion failed: ${(err as Error).message}`);
    log('pipeline', 'mp4 fail', { err: String(err) });
  }

  // 3-4. mp4 → wav → whisper → transcript.txt (skipped if whisper is missing)
  let finalTranscriptPath: string | null = null;
  let transcriptSegments: TranscriptSegment[] = [];
  const whisper = findWhisperBinary();
  if (whisper && fs.existsSync(mp4Path)) {
    try {
      await mp4ToWav(mp4Path, wavPath);
      const whisperOutPrefix = path.join(sessionDir, 'whisper-out');
      await runWhisper(whisper.exe, whisper.model, wavPath, whisperOutPrefix);
      const srtPath = `${whisperOutPrefix}.srt`;
      if (fs.existsSync(srtPath)) {
        const srt = fs.readFileSync(srtPath, 'utf-8');
        transcriptSegments = parseSrtToTranscript(srt);
        fs.writeFileSync(transcriptPath, transcriptSegments.map((s) => s.text).join('\n') + '\n', 'utf-8');
        finalTranscriptPath = transcriptPath;
        try {
          fs.unlinkSync(srtPath);
        } catch {
          /* ignore */
        }
      } else {
        warnings.push('whisper ran but produced no SRT');
      }
    } catch (err) {
      warnings.push(`whisper failed: ${(err as Error).message}`);
      log('pipeline', 'whisper fail', { err: String(err) });
    }
    try {
      fs.unlinkSync(wavPath);
    } catch {
      /* ignore */
    }
  } else {
    warnings.push(
      whisper
        ? 'whisper present but mp4 missing; skipped transcription'
        : 'whisper.cpp + model not installed — run `npm run fetch-resources`; skipped transcription'
    );
  }

  // 5. mp4 → gif (kept on disk for the human's visual review; not shared
  //    with the LLM since it can't read animated frames).
  if (fs.existsSync(mp4Path)) {
    try {
      await mp4ToGif(mp4Path, gifPath, input.outputRoot);
    } catch (err) {
      warnings.push(`gif generation failed: ${(err as Error).message}`);
      log('pipeline', 'gif fail', { err: String(err) });
    }
  }

  // 6a. Extract a PNG at the exact millisecond each annotation was drawn.
  //     The overlay bakes the red numbered rectangle into the live canvas,
  //     so these frames show exactly what was on screen + what was circled.
  const annotationFrames: Array<{ number: number; path: string; drawnAtMs: number }> = [];
  if (fs.existsSync(mp4Path) && input.annotations.length > 0) {
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
  //     HUD snap button. They already exist in sessionDir (written during
  //     recording); we just need to discover and sort them.
  const snapFrames: Array<{ path: string; name: string }> = fs
    .readdirSync(sessionDir)
    .filter((f) => /^snap-\d+-.+\.png$/.test(f))
    .sort()
    .map((f) => ({ path: path.join(sessionDir, f), name: f }));
  if (snapFrames.length > 0) {
    log('pipeline', 'snap frames found', { count: snapFrames.length });
  }

  // 7. annotations.json
  const annotationsDoc = {
    recordingStartedAtUtc: startedAt.toISOString(),
    durationMs: input.durationMs,
    recordingRegion: input.recordingRegion,
    annotations: input.annotations,
  };
  fs.writeFileSync(annotationsPath, JSON.stringify(annotationsDoc, null, 2), 'utf-8');

  // 8. prompt.txt + clipboard
  const promptText = buildPromptText({
    transcriptPath: finalTranscriptPath,
    annotationsPath,
    annotationFrames,
    snapFrames,
    annotations: input.annotations,
  });

  fs.writeFileSync(promptPath, promptText, 'utf-8');
  clipboard.writeText(promptText);
  log('pipeline', 'prompt written + clipboarded', {
    length: promptText.length,
    annotationFrames: annotationFrames.length,
    snapFrames: snapFrames.length,
  });

  // 8. cleanup intermediate webm
  try {
    fs.unlinkSync(webmPath);
  } catch {
    /* leave it if we can't delete */
  }

  log('pipeline', 'session complete', { sessionDir, warnings });

  return {
    sessionDir,
    mp4Path,
    transcriptPath: finalTranscriptPath,
    annotationsPath,
    promptPath,
    framePaths: [...annotationFrames.map((f) => f.path), ...snapFrames.map((f) => f.path)],
    promptText,
    warnings,
  };
}
