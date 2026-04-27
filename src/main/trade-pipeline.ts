/**
 * Snipalot Trade-mode pipeline (TradeCall feature, branch: trade-mode).
 *
 * Runs after the existing `runPipeline()` whisper step completes for a
 * trade-mode session. Consumes the parsed transcript + any user-pressed
 * trade markers, writes an LLM extraction prompt the user pastes into
 * Claude Code / Gemini / Cursor / etc., and once the LLM response lands
 * in the session folder as `extraction_response.json`, parses it into a
 * trade log (CSV + Markdown) for the trader to review.
 *
 * Milestone 1 scaffolding: file exists, exports the function signature
 * the orchestrator will call, but the body is intentionally a no-op.
 * Real extraction prompt + response watcher land in M4. CSV/MD generators
 * land in M5.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './logger';
import { TranscriptSegment } from './pipeline';

export interface TradePipelineInput {
  /** Session directory where outputs land. */
  sessionDir: string;
  /** Path to the finalized mp4 (for legend frame extraction in M5). */
  mp4Path: string;
  /** Whisper-parsed transcript segments (already produced by runPipeline). */
  transcriptSegments: TranscriptSegment[];
  /** User-pressed trade marker offsets, ms relative to recording start. */
  tradeMarkers: number[];
  /** Step callback for launcher UI (mirrors PipelineInput.onStep). */
  onStep?: (step: string) => void;
}

export interface TradePipelineResult {
  /** Path to extraction_prompt.md (always written in M4+). */
  extractionPromptPath: string | null;
  /** Path to extraction_response.json (written by user paste OR M6 auto-call). */
  extractionResponsePath: string | null;
  /** Path to trade_log.csv (written in M5+ once extraction is parsed). */
  tradeLogCsvPath: string | null;
  /** Path to trade_log.md (written in M5+ once extraction is parsed). */
  tradeLogMdPath: string | null;
  /** Path to adherence_report.md (written in M5+ once extraction is parsed). */
  adherenceReportPath: string | null;
  /** Soft warnings encountered during processing (mirrors pipeline.ts pattern). */
  warnings: string[];
}

/**
 * Trade-pipeline entry point. Called by `runPipeline()` after whisper
 * succeeds when `input.mode === 'trade'`. Body is a no-op in M1; real
 * work lands in M4-M6.
 */
export async function runTradePipeline(
  input: TradePipelineInput
): Promise<TradePipelineResult> {
  const { sessionDir, transcriptSegments, tradeMarkers, onStep } = input;
  const warnings: string[] = [];

  log('trade-pipeline', 'invoked', {
    sessionDir,
    transcriptSegments: transcriptSegments.length,
    tradeMarkers: tradeMarkers.length,
  });

  // Write markers.json (also useful for the M4 extraction prompt, which
  // formats markers as [MARKER N at M:SS] anchor tags). Always written
  // even if empty so downstream tooling can rely on the file existing.
  if (onStep) onStep('Writing trade markers…');
  const markersPath = path.join(sessionDir, 'markers.json');
  try {
    const payload = {
      markers: tradeMarkers.map((offsetMs, i) => ({
        index: i + 1,
        offsetMs,
        offsetLabel: formatOffset(offsetMs),
      })),
    };
    fs.writeFileSync(markersPath, JSON.stringify(payload, null, 2), 'utf-8');
    log('trade-pipeline', 'markers.json written', { count: tradeMarkers.length, markersPath });
  } catch (err) {
    warnings.push(`markers.json write failed: ${(err as Error).message}`);
    log('trade-pipeline', 'markers.json fail', { err: String(err) });
  }

  // M4 lands writeExtractionPrompt() and the extraction_response.json watcher.
  // M5 lands buildTradeLogCsv() + buildTradeLogMd() + adherence_report.md.
  return {
    extractionPromptPath: null,
    extractionResponsePath: null,
    tradeLogCsvPath: null,
    tradeLogMdPath: null,
    adherenceReportPath: null,
    warnings,
  };
}

/** Format ms offset as "M:SS" for the markers payload + future extraction prompt. */
function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

