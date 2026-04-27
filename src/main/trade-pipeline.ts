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

import { log } from './logger';
import { TranscriptSegment } from './pipeline';
// fs + path imports land in M4 when writeExtractionPrompt() is implemented.

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

  log('trade-pipeline', 'invoked (M1 scaffold)', {
    sessionDir,
    transcriptSegments: transcriptSegments.length,
    tradeMarkers: tradeMarkers.length,
  });
  // The onStep + warnings + sessionDir refs below are no-ops in M1, kept
  // here so TypeScript's no-unused-locals doesn't complain. Real call sites
  // land in M4 (writeExtractionPrompt) and M5 (CSV/MD generators).
  if (onStep) onStep('Trade-mode extraction skipped (M1 scaffold)');
  void sessionDir;

  return {
    extractionPromptPath: null,
    extractionResponsePath: null,
    tradeLogCsvPath: null,
    tradeLogMdPath: null,
    adherenceReportPath: null,
    warnings,
  };
}

