/**
 * Snipalot Trade-mode pipeline (TradeCall feature, branch: trade-mode).
 *
 * Runs after the existing `runPipeline()` whisper step completes for a
 * trade-mode session. Consumes the parsed transcript + any user-pressed
 * trade markers, writes an LLM extraction prompt, waits for
 * `Inputs/extraction_response.json` (from Gemini/API auto-extraction or the
 * paste window), then generates the root-level trade workbook and Markdown
 * report for the trader to review.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { clipboard, Notification } from 'electron';
import JSZip from 'jszip';
import { log } from './logger';
import { getConfig } from './config';
import { resolveGeminiCliExecutable } from './gemini-cli-exec';
import { TranscriptSegment, TradeMarkerRecord } from './pipeline';
import { writeSessionLog } from './session-log';

/**
 * Schema for a single extracted trade event. Matches the JSON shape the
 * LLM is asked to return; downstream CSV/MD generators (M5) consume this.
 *
 * Numeric market cap fields are normalized to whole dollars (e.g. "80k"
 * in the transcript becomes 80000 in target_low_mc). Null fields are
 * acceptable for any post-trade field if the trader never closed the
 * position or didn't speak about the exit.
 */
export interface TradeEvent {
  trade_id: number;
  token_name: string;
  pre_call_offset_ms: number | null;
  pre_call_offset_label: string | null;
  post_call_offset_ms: number | null;
  post_call_offset_label: string | null;
  target_low_mc: number | null;
  target_high_mc: number | null;
  stop_loss_mc: number | null;
  rationale: string | null;
  pre_transcript_excerpt: string | null;
  post_transcript_excerpt: string | null;
  exit_mc_estimate: number | null;
  outcome_summary: string | null;
  adherence_self_assessment: string | null;
  pre_confidence: 'low' | 'medium' | 'high' | null;
  post_confidence: 'low' | 'medium' | 'high' | null;
  needs_review: boolean;
  notes: string | null;
  leg_index?: number | null;
  leg_count?: number | null;
  position_fraction?: number | null;
  // â”€â”€ Optional Padre/MockApe outcome fields (filled by joinMockApe) â”€â”€
  /** Matched MockApe trade id for traceability. */
  mockape_trade_id?: string | null;
  /** Confidence of the mockape join: 'high' = exact token + tight time match,
   *  'medium' = token match but loose time, 'low' = fuzzy token. */
  mockape_join_confidence?: 'high' | 'medium' | 'low' | null;
  mockape_timestamp_ms?: number | null;
  entry_mc_actual?: number | null;
  exit_mc_actual?: number | null;
  sol_invested?: number | null;
  sol_received?: number | null;
  pnl_sol?: number | null;
  pnl_percentage?: number | null;
  /** Did the actual exit reach into the spoken target range? */
  target_hit_low?: boolean | null;
  target_hit_high?: boolean | null;
  exit_scenario?: 'early' | 'in_range' | 'overshoot' | null;
  /** NICS/meta judgment fields from the LLM. History-dependent fields are reconciled during master sync. */
  meta_cluster_id?: string | null;
  meta_name?: string | null;
  N_score?: number | null;
  N_why?: string | null;
  I_score?: number | null;
  I_why?: string | null;
  C_score?: number | null;
  C_why?: string | null;
  S_score?: number | null;
  S_why?: string | null;
  NICS_score?: number | null;
  trade_type?: string | null;
  llm_grade_notes?: string | null;
  size_ok?: boolean | null;
  zone_ok?: boolean | null;
  cooldown_ok?: boolean | null;
  counts_toward_50?: boolean | null;
  hard_reset?: boolean | null;
  running_count?: number | null;
  non_nics_pnl_pct?: number | null;
  cluster_pnl_pct?: number | null;
}

export interface TradePipelineInput {
  /** Session directory where outputs land. */
  sessionDir: string;
  /** Path to the finalized mp4 (for legend frame extraction in M5). */
  mp4Path: string;
  /** Whisper-parsed transcript segments (already produced by runPipeline). */
  transcriptSegments: TranscriptSegment[];
  /** User-pressed trade markers, ms relative to recording start. */
  tradeMarkers: TradeMarkerRecord[];
  /**
   * Recording start time (Date.now()-style ms epoch). Combined with
   * pre/post call offsets, lets the MockApe join convert recording-
   * relative timestamps into absolute clock times for matching against
   * the MockApe export's unix-epoch timestamp field.
   */
  startedAtMs: number;
  /** Recording duration in ms. Used for concrete video timeline columns in XLSX output. */
  durationMs: number;
  /** Step callback for launcher UI (mirrors PipelineInput.onStep). */
  onStep?: (step: string) => void;
  /**
   * Called immediately after prompt.txt is written, with the
   * paths the response-paste window needs. index.ts passes a function
   * that opens the BrowserWindow â€” the pipeline stays decoupled from the
   * window layer.
   */
  onPromptReady?: (sessionDir: string, responsePath: string, promptPath: string) => void;
  abortSignal?: AbortSignal;
}

/**
 * Schema for the MockApe / Padre trade export. The user pastes their
 * exported JSON into mockape.json in the session folder; the trade-
 * pipeline parses, joins by tokenName + timestamp, and enriches the
 * trade_log.xlsx with actual entry/exit market caps + P&L.
 */
export interface MockApeTrade {
  chain: string;
  entryMarketCap: number;
  exitMarketCap: number;
  id: string;
  platform: string;
  pnlPercentage: number;
  pnlSol: number;
  solInvested: number;
  solReceived: number;
  /** Unix epoch ms â€” matches Date.now() output. */
  timestamp: number;
  tokenName: string;
}

export interface TradePipelineResult {
  /** Path to prompt.txt (always written in M4+). */
  extractionPromptPath: string | null;
  /** Path to extraction_response.json (written by user paste OR M6 auto-call). */
  extractionResponsePath: string | null;
  /** Deprecated: CSV generation is disabled; kept for IPC shape compatibility. */
  tradeLogCsvPath: string | null;
  /** Path to trade_log.xlsx (formatted workbook view of the trade log). */
  tradeLogXlsxPath: string | null;
  /** Path to trade_log.md (written in M5+ once extraction is parsed). */
  tradeLogMdPath: string | null;
  /** Path to adherence_report.md (written in M5+ once extraction is parsed). */
  adherenceReportPath: string | null;
  /** Soft warnings encountered during processing (mirrors pipeline.ts pattern). */
  warnings: string[];
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new Error('Processing abandoned.');
  }
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
  const abortSignal = input.abortSignal;
  throwIfAborted(abortSignal);

  log('trade-pipeline', 'invoked', {
    sessionDir,
    transcriptSegments: transcriptSegments.length,
    tradeMarkers: tradeMarkers.length,
  });
  writeSessionLog(sessionDir, 'trade-pipeline', 'started', {
    transcriptSegments: transcriptSegments.length,
    tradeMarkers: tradeMarkers.length,
    durationMs: input.durationMs,
  }, 'start');

  // Write markers.json (also useful for the M4 extraction prompt, which
  // formats markers as [MARKER N at M:SS] anchor tags). Always written
  // even if empty so downstream tooling can rely on the file existing.
  if (onStep) onStep('Writing trade markers...');
  const inputsDir = getTradeInputsDir(sessionDir);
  const markersPath = path.join(inputsDir, 'markers.json');
  try {
    const payload = {
      markers: tradeMarkers.map((marker, i) => ({
        index: i + 1,
        offsetMs: marker.offsetMs,
        offsetLabel: marker.offsetLabel || formatOffset(marker.offsetMs),
        screenshotPath: marker.screenshotPath ?? null,
      })),
    };
    fs.writeFileSync(markersPath, JSON.stringify(payload, null, 2), 'utf-8');
    log('trade-pipeline', 'markers.json written', { count: tradeMarkers.length, markersPath });
    writeSessionLog(sessionDir, 'trade-pipeline', 'markers written', {
      count: tradeMarkers.length,
      markersPath,
    }, 'success');
  } catch (err) {
    warnings.push(`markers.json write failed: ${(err as Error).message}`);
    log('trade-pipeline', 'markers.json fail', { err: String(err) });
    writeSessionLog(sessionDir, 'trade-pipeline', 'markers write failed', { error: (err as Error).message }, 'error');
  }

  // â”€â”€ Wait for the trade-context window to close (user submits MockApe
  //    data or clicks Skip). Main opens the window in stopRecording
  //    so it's already up and parallel to whisper / mp4 / gif work.
  //    If autoPromptForTradeData is off, main writes the .skipped
  //    sentinel directly â€” wait returns immediately. â”€â”€
  if (onStep) onStep('Waiting for trade data...');
  await waitForTradeContextDecision(sessionDir, undefined, abortSignal);
  writeSessionLog(sessionDir, 'trade-pipeline', 'trade data window decision received', undefined, 'success');

  // Load the MockApe data NOW (before rendering the prompt) so the
  // prompt template can embed it as canonical trade context.
  const mockape = loadMockApeTrades(sessionDir);
  if (mockape) {
    log('trade-pipeline', 'mockape data loaded for prompt embed', { trades: mockape.length });
    writeSessionLog(sessionDir, 'trade-pipeline', 'mockape loaded', { trades: mockape.length }, 'success');
  } else {
    writeSessionLog(sessionDir, 'trade-pipeline', 'mockape missing or skipped', undefined, 'skipped');
  }

  // â”€â”€ M4: write the extraction prompt + wait for the user's LLM response â”€â”€
  if (onStep) onStep('Writing trade extraction prompt...');
  throwIfAborted(abortSignal);
  const promptText = renderExtractionPrompt(
    transcriptSegments,
    tradeMarkers,
    mockape,
    input.startedAtMs
  );
  const { promptPath, responsePath } = writeExtractionPrompt(sessionDir, promptText);
  writeSessionLog(sessionDir, 'trade-pipeline', 'extraction prompt written', {
    promptPath,
    responsePath,
    promptChars: promptText.length,
  }, 'success');

  // â”€â”€ Auto-extraction backend selection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Preferred mode is Gemini CLI (local command invocation, no API key).
  // API mode remains available for Gemini/OpenRouter/OpenAI flows.
  const cfg = getConfig().trade;
  const llmMode = cfg.llmMode ?? 'gemini-cli';
  let autoSucceeded = false;
  let autoLabel = llmMode === 'gemini-cli' ? 'Gemini CLI' : 'OpenAI-compatible API';

  if (llmMode === 'gemini-cli') {
    const cliCommand = (cfg.geminiCliCommand || 'gemini').trim();
    const cliModel = (cfg.geminiCliModel || 'gemini-3.1-pro-preview').trim();
    try {
      writeSessionLog(sessionDir, 'trade-pipeline', 'gemini cli extraction attempt started', {
        command: cliCommand,
        model: cliModel,
      }, 'start');
      autoSucceeded = await tryGeminiCli(promptText, responsePath, cliCommand, cliModel, onStep, undefined, abortSignal);
      autoLabel = 'Gemini CLI';
      writeSessionLog(sessionDir, 'trade-pipeline', 'gemini cli extraction attempt finished', {
        succeeded: autoSucceeded,
        responsePath: autoSucceeded ? responsePath : null,
      }, autoSucceeded ? 'success' : 'warning');
    } catch (err) {
      log('trade-pipeline', 'gemini-cli: unexpected throw', { err: String(err) });
      writeSessionLog(sessionDir, 'trade-pipeline', 'gemini cli extraction threw', { error: (err as Error).message }, 'error');
    }
    if (!autoSucceeded && cfg.openaiApiKey) {
      const baseUrl = cfg.openaiBaseUrl || 'https://openrouter.ai/api/v1';
      const model = cfg.openaiModel || 'google/gemini-2.5-flash';
      autoLabel = baseUrl.includes('openrouter') ? 'OpenRouter' : 'OpenAI';
      if (onStep) onStep(`Gemini CLI unavailable; trying ${autoLabel} fallback...`);
      log('trade-pipeline', 'gemini-cli failed; attempting api fallback', {
        baseUrl,
        model,
      });
      try {
        writeSessionLog(sessionDir, 'trade-pipeline', 'api fallback extraction attempt started', {
          baseUrl,
          model,
        }, 'start');
        autoSucceeded = await tryOpenAiApi(
          promptText, responsePath, cfg.openaiApiKey, baseUrl, model, onStep, undefined, abortSignal
        );
        writeSessionLog(sessionDir, 'trade-pipeline', 'api fallback extraction attempt finished', {
          label: autoLabel,
          succeeded: autoSucceeded,
          responsePath: autoSucceeded ? responsePath : null,
        }, autoSucceeded ? 'success' : 'warning');
      } catch (err) {
        log('trade-pipeline', 'openai-api fallback: unexpected throw', { err: String(err) });
        writeSessionLog(sessionDir, 'trade-pipeline', 'api fallback extraction threw', { error: (err as Error).message }, 'error');
      }
    }
  } else {
    // API mode: OpenAI-compatible endpoint (OpenRouter/OpenAI/etc).
    if (cfg.openaiApiKey) {
      const baseUrl = cfg.openaiBaseUrl || 'https://openrouter.ai/api/v1';
      const model = cfg.openaiModel || 'google/gemini-2.5-flash';
      autoLabel = baseUrl.includes('openrouter') ? 'OpenRouter' : 'OpenAI';
      try {
        writeSessionLog(sessionDir, 'trade-pipeline', 'api extraction attempt started', {
          baseUrl,
          model,
        }, 'start');
        autoSucceeded = await tryOpenAiApi(
          promptText, responsePath, cfg.openaiApiKey, baseUrl, model, onStep, undefined, abortSignal
        );
        writeSessionLog(sessionDir, 'trade-pipeline', 'api extraction attempt finished', {
          label: autoLabel,
          succeeded: autoSucceeded,
          responsePath: autoSucceeded ? responsePath : null,
        }, autoSucceeded ? 'success' : 'warning');
      } catch (err) {
        log('trade-pipeline', 'openai-api: unexpected throw', { err: String(err) });
        writeSessionLog(sessionDir, 'trade-pipeline', 'api extraction threw', { error: (err as Error).message }, 'error');
      }
    }
  }

  if (autoSucceeded) {
    if (onStep) onStep(`${autoLabel} extracted trades - generating trade log...`);
    if (Notification.isSupported()) {
      new Notification({
        title: 'Snipalot Trade - auto-extracted',
        body: `${autoLabel} extracted your trades automatically. Generating trade log...`,
        silent: false,
      }).show();
    }
  } else {
    // Notify the caller (index.ts) that the prompt is ready â€” it opens the
    // response-paste window so the user can paste the LLM reply without
    // manually saving a file.
    if (input.onPromptReady) {
      input.onPromptReady(sessionDir, responsePath, promptPath);
    }
    if (onStep) onStep('Waiting for LLM response (paste into the response window)...');
    writeSessionLog(sessionDir, 'trade-pipeline', 'manual extraction response required', {
      responsePath,
      promptPath,
    }, 'warning');
  }

  if (!autoSucceeded) {
    void finalizeTradeOutputsFromResponsePath(
      responsePath,
      sessionDir,
      mockape,
      input.startedAtMs,
      input.durationMs,
      abortSignal
    ).catch((err) => {
      log('trade-pipeline', 'background finalize failed', { err: String(err), responsePath });
      writeSessionLog(sessionDir, 'trade-pipeline', 'background finalize failed', {
        responsePath,
        error: (err as Error).message,
      }, 'error');
    });
    return {
      extractionPromptPath: promptPath,
      extractionResponsePath: null,
      tradeLogCsvPath: null,
      tradeLogXlsxPath: null,
      tradeLogMdPath: null,
      adherenceReportPath: null,
      warnings,
    };
  }

  const trades = await waitForExtractionResponse(responsePath, undefined, abortSignal);
  writeSessionLog(sessionDir, 'trade-pipeline', 'extraction response wait completed', {
    responsePath,
    trades: trades?.length ?? 0,
  }, trades ? 'success' : 'timeout');

  if (!trades) {
    warnings.push(
      'extraction_response.json did not appear within 60 minutes; trade log not generated. ' +
        'Drop the file in the session folder later and re-trigger via "Process Trade Session" (CLI command coming).'
    );
    return {
      extractionPromptPath: promptPath,
      extractionResponsePath: null,
      tradeLogCsvPath: null,
      tradeLogXlsxPath: null,
      tradeLogMdPath: null,
      adherenceReportPath: null,
      warnings,
    };
  }

  // â”€â”€ MockApe / Padre outcome enrichment â”€â”€
  // mockape was already loaded earlier (before prompt render). The LLM
  // received it in the prompt and (ideally) populated mockape_trade_id
  // for matched trades â€” joinMockApeById just looks up by ID and copies
  // PnL fields. If the LLM missed the assignment, fall back to fuzzy
  // tokenName + timestamp matching for unjoined trades.
  let mockApeJoinStats = { matched: 0, unmatched: 0 };
  if (mockape) {
    if (onStep) onStep('Joining MockApe outcomes by id...');
    mockApeJoinStats = joinMockApeById(trades, mockape);
    // Any trades the LLM didn't tag get a fallback fuzzy attempt.
    const unjoined = trades.filter((t) => !t.mockape_trade_id);
    if (unjoined.length > 0) {
      const fuzzy = joinMockApe(unjoined, mockape, input.startedAtMs);
      mockApeJoinStats.matched += fuzzy.matched;
      log('trade-pipeline', 'mockape fuzzy fallback applied', fuzzy);
    }
    log('trade-pipeline', 'mockape join total', mockApeJoinStats);
    writeSessionLog(sessionDir, 'trade-pipeline', 'mockape join completed', mockApeJoinStats, 'success');
  } else {
    log('trade-pipeline', 'no mockape.json - actual P&L columns will be blank');
    writeSessionLog(sessionDir, 'trade-pipeline', 'mockape join skipped', undefined, 'skipped');
  }

  const outputTrades = mockape ? trades.filter((t) => Boolean(t.mockape_trade_id)) : trades;
  const omittedSpokenOnly = trades.length - outputTrades.length;
  if (omittedSpokenOnly > 0) {
    log('trade-pipeline', 'omitted spoken-only non-trade rows from outputs', {
      omitted: omittedSpokenOnly,
      kept: outputTrades.length,
    });
    writeSessionLog(sessionDir, 'trade-pipeline', 'omitted spoken-only rows from outputs', {
      omitted: omittedSpokenOnly,
      kept: outputTrades.length,
    }, 'info');
  }
  await ensureNicsJudgmentsForTrades(
    sessionDir,
    outputTrades,
    transcriptSegments,
    onStep,
    abortSignal
  );

  // â”€â”€ Generate trade_log.xlsx + companion Markdown reports â”€â”€
  if (onStep) onStep('Generating trade workbook + adherence report...');
  let csvPath: string | null = null;
  let xlsxPath: string | null = null;
  let mdPath: string | null = null;
  let reportPath: string | null = null;
  try {
    xlsxPath = await writeTradeLogXlsx(sessionDir, outputTrades, input.startedAtMs, input.durationMs);
    mdPath = writeTradeLogMd(sessionDir, outputTrades, input.startedAtMs, input.durationMs);
    reportPath = writeAdherenceReport(getTradeInputsDir(sessionDir), outputTrades);
    organizeTradeSessionRoot(sessionDir);
    writeSessionLog(sessionDir, 'trade-pipeline', 'trade outputs written', {
      trades: outputTrades.length,
      xlsxPath,
      mdPath,
      reportPath,
    }, 'success');
  } catch (err) {
    warnings.push(`trade output generators failed: ${(err as Error).message}`);
    log('trade-pipeline', 'output gen fail', { err: String(err) });
    writeSessionLog(sessionDir, 'trade-pipeline', 'trade output generation failed', {
      error: (err as Error).message,
    }, 'error');
  }

  log('trade-pipeline', 'session complete', {
    trades: outputTrades.length,
    omittedSpokenOnly,
    csvPath,
    xlsxPath,
    mdPath,
    reportPath,
  });
  writeSessionLog(sessionDir, 'trade-pipeline', 'finished', {
    trades: outputTrades.length,
    omittedSpokenOnly,
    xlsxPath,
    mdPath,
    reportPath,
    warnings,
  }, warnings.length > 0 ? 'warning' : 'success');
  if (Notification.isSupported()) {
    new Notification({
      title: 'Snipalot Trade - log ready',
      body: `${outputTrades.length} trade${outputTrades.length === 1 ? '' : 's'} logged. trade_log.xlsx + companions in:\n${sessionDir}`,
      silent: false,
    }).show();
  }

  return {
    extractionPromptPath: promptPath,
    extractionResponsePath: responsePath,
    tradeLogCsvPath: csvPath,
    tradeLogXlsxPath: xlsxPath,
    tradeLogMdPath: mdPath,
    adherenceReportPath: reportPath,
    warnings,
  };
}

// â”€â”€â”€ Auto-extraction backends â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function tryGeminiCli(
  promptText: string,
  responsePath: string,
  cliCommand: string,
  model: string,
  onStep?: (step: string) => void,
  timeoutMs: number = 5 * 60 * 1000,
  abortSignal?: AbortSignal
): Promise<boolean> {
  if (!cliCommand) return false;
  throwIfAborted(abortSignal);
  if (onStep) onStep('Auto-extracting via Gemini CLI...');
  log('trade-pipeline', 'gemini-cli: attempting auto-extraction', { cliCommand, model });

  const resolvedCli = resolveGeminiCliExecutable(cliCommand);
  // Use Gemini CLI's own auth method (OAuth via Google account, or whatever
  // is in ~/.gemini/settings.json). Strip GEMINI_API_KEY env var so a stale
  // value can't force paid API-key auth.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE ?? 'true',
    // electron.exe (process.execPath under Electron) needs this to behave
    // as a Node runtime when running the gemini-cli JS bundle.
    ELECTRON_RUN_AS_NODE: '1',
    // Skip the gemini-cli self-respawn â€” it bypasses our argv shim and
    // re-triggers the yargs phantom-positional bug under Electron.
    GEMINI_CLI_NO_RELAUNCH: 'true',
  };
  delete env.GEMINI_API_KEY;

  const runGemini = (
    args: string[],
    attempt: 'prompt-flag' | 'prompt-positional',
    stdinText?: string
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> =>
    new Promise((resolve) => {
      throwIfAborted(abortSignal);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      // shell:false on Windows keeps multi-word --prompt as a single argv token;
      // shell:true via cmd.exe splits on spaces and triggers Gemini's
      // "positional prompt and --prompt together" error.
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(resolvedCli.command, [...resolvedCli.prefixArgs, ...args], {
          windowsHide: true,
          shell: false,
          env,
          stdio: stdinText ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        log('trade-pipeline', 'gemini-cli: spawn failed', { attempt, err: (err as Error).message });
        resolve({ code: -1, stdout, stderr, timedOut });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      const onAbort = () => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      if (stdinText && child.stdin) {
        child.stdin.on('error', (err) => {
          log('trade-pipeline', 'gemini-cli: stdin write error', { attempt, err: err.message });
        });
        child.stdin.end(stdinText, 'utf-8');
      }
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        abortSignal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
      child.on('error', (err) => {
        abortSignal?.removeEventListener('abort', onAbort);
        clearTimeout(timer);
        log('trade-pipeline', 'gemini-cli: process error', { attempt, err: err.message });
        resolve({ code: -1, stdout, stderr, timedOut });
      });
    });

  let result = await runGemini(
    [
      '--model',
      model,
      '--output-format',
      'json',
      '--prompt',
      'Process the complete Snipalot trade extraction prompt supplied on stdin. Return only the requested JSON.',
    ],
    'prompt-flag',
    promptText
  );
  let fallback = 'none';

  if (result.code !== 0 && /Cannot use both a positional prompt and the --prompt flag together/i.test(result.stderr)) {
    log('trade-pipeline', 'gemini-cli: retrying positional prompt after parser conflict', {
      code: result.code,
      stderr: result.stderr.slice(0, 500),
    });
    result = await runGemini(
      [
        '--model',
        model,
        '--output-format',
        'json',
        'Process the complete Snipalot trade extraction prompt supplied on stdin. Return only the requested JSON.',
      ],
      'prompt-positional',
      promptText
    );
    fallback = 'positional-prompt';
  }

  if (result.timedOut) {
    throwIfAborted(abortSignal);
    log('trade-pipeline', 'gemini-cli: timeout', { timeoutMs, fallback });
    return false;
  }
  throwIfAborted(abortSignal);
  if (result.code !== 0) {
    log('trade-pipeline', 'gemini-cli: non-zero exit', {
      code: result.code,
      fallback,
      stderr: result.stderr.slice(0, 500),
    });
    return false;
  }

  const rawText = extractGeminiCliResponseText(result.stdout);
  if (!rawText) {
    log('trade-pipeline', 'gemini-cli: empty response text', {
      stdoutPreview: result.stdout.slice(0, 500),
      stderrPreview: result.stderr.slice(0, 500),
    });
    return false;
  }
  try {
    parseAndValidateResponse(rawText);
    fs.writeFileSync(responsePath, rawText, 'utf-8');
    log('trade-pipeline', 'gemini-cli: auto-extraction succeeded', { chars: rawText.length, fallback });
    return true;
  } catch (err) {
    log('trade-pipeline', 'gemini-cli: invalid response JSON', {
      err: (err as Error).message,
      preview: rawText.slice(0, 300),
    });
    return false;
  }
}

function extractGeminiCliResponseText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.response === 'string' && parsed.response.trim()) return parsed.response.trim();
    if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text.trim();
    const content = parsed.content as Record<string, unknown> | undefined;
    if (content && typeof content.text === 'string' && content.text.trim()) return content.text.trim();
  } catch {
    // If CLI returned plain text instead of JSON, treat it as response content.
  }
  return trimmed;
}

/**
 * Attempt auto-extraction via any OpenAI-compatible API (OpenAI, OpenRouter,
 * or any other provider that speaks the chat completions format). Falls back
 * to the response-paste window on any failure.
 *
 * OpenRouter usage: set baseUrl=https://openrouter.ai/api/v1 and choose a
 * supported model (including any ":free" model if you want zero-cost limits).
 */
async function tryOpenAiApi(
  promptText: string,
  responsePath: string,
  apiKey: string,
  baseUrl: string,
  model: string,
  onStep?: (step: string) => void,
  timeoutMs: number = 5 * 60 * 1000,
  abortSignal?: AbortSignal
): Promise<boolean> {
  if (!apiKey) {
    log('trade-pipeline', 'openai-api: no API key configured, skipping');
    return false;
  }
  throwIfAborted(abortSignal);

  const label = baseUrl.includes('openrouter') ? 'OpenRouter' : 'OpenAI';
  if (onStep) onStep(`Auto-extracting via ${label}...`);
  log('trade-pipeline', 'openai-api: attempting auto-extraction', { baseUrl, model });

  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: promptText }],
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    abortSignal?.removeEventListener('abort', onAbort);

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      log('trade-pipeline', 'openai-api: HTTP error', {
        status: res.status,
        body: errBody.slice(0, 400),
      });
      return false;
    }

    const data = await res.json() as Record<string, unknown>;
    const choices = data?.choices as Array<Record<string, unknown>> | undefined;
    const rawText = (choices?.[0]?.message as Record<string, unknown>)?.content as string | undefined;

    if (!rawText) {
      log('trade-pipeline', 'openai-api: empty response', { data: JSON.stringify(data).slice(0, 300) });
      return false;
    }

    parseAndValidateResponse(rawText);
    throwIfAborted(abortSignal);
    fs.writeFileSync(responsePath, rawText, 'utf-8');
    log('trade-pipeline', 'openai-api: auto-extraction succeeded', { chars: rawText.length });
    return true;
  } catch (err) {
    clearTimeout(timer);
    abortSignal?.removeEventListener('abort', onAbort);
    throwIfAborted(abortSignal);
    log('trade-pipeline', 'openai-api: failed', { err: String(err) });
    return false;
  }
}

const LLM_NICS_COLUMNS = [
  'meta_name',
  'N_score',
  'N_why',
  'I_score',
  'I_why',
  'C_score',
  'C_why',
  'S_score',
  'S_why',
  'NICS_score',
  'trade_type',
  'llm_grade_notes',
] as const;

async function ensureNicsJudgmentsForTrades(
  sessionDir: string,
  trades: TradeEvent[],
  transcriptSegments: TranscriptSegment[],
  onStep?: (step: string) => void,
  abortSignal?: AbortSignal
): Promise<void> {
  const missing = trades.filter((trade) => !hasCompleteNicsJudgment(trade));
  if (missing.length === 0) return;

  const cfg = getConfig().trade;
  const promptText = renderNicsBackfillPrompt(trades, transcriptSegments);
  const responsePath = path.join(getTradeInputsDir(sessionDir), 'nics_response.json');
  if (onStep) onStep('Backfilling NICS classifications...');
  writeSessionLog(sessionDir, 'trade-pipeline', 'nics backfill started', {
    responsePath,
    missing: missing.length,
    trades: trades.length,
  }, 'start');

  let succeeded = false;
  const llmMode = cfg.llmMode ?? 'gemini-cli';
  if (llmMode === 'gemini-cli') {
    succeeded = await tryGeminiCli(
      promptText,
      responsePath,
      (cfg.geminiCliCommand || 'gemini').trim(),
      (cfg.geminiCliModel || 'gemini-3.1-pro-preview').trim(),
      undefined,
      5 * 60 * 1000,
      abortSignal
    );
    if (!succeeded && cfg.openaiApiKey) {
      succeeded = await tryOpenAiApi(
        promptText,
        responsePath,
        cfg.openaiApiKey,
        cfg.openaiBaseUrl || 'https://openrouter.ai/api/v1',
        cfg.openaiModel || 'google/gemini-2.5-flash',
        undefined,
        5 * 60 * 1000,
        abortSignal
      );
    }
  } else if (cfg.openaiApiKey) {
    succeeded = await tryOpenAiApi(
      promptText,
      responsePath,
      cfg.openaiApiKey,
      cfg.openaiBaseUrl || 'https://openrouter.ai/api/v1',
      cfg.openaiModel || 'google/gemini-2.5-flash',
      undefined,
      5 * 60 * 1000,
      abortSignal
    );
  }

  if (!succeeded || !fs.existsSync(responsePath)) {
    writeSessionLog(sessionDir, 'trade-pipeline', 'nics backfill unavailable', {
      missing: missing.length,
    }, 'warning');
    return;
  }

  const graded = parseAndValidateResponse(fs.readFileSync(responsePath, 'utf-8'));
  const merged = mergeNicsJudgments(trades, graded);
  const stillMissing = trades.filter((trade) => !hasCompleteNicsJudgment(trade)).length;
  writeSessionLog(sessionDir, 'trade-pipeline', 'nics backfill completed', {
    merged,
    stillMissing,
  }, stillMissing > 0 ? 'warning' : 'success');
}

function hasCompleteNicsJudgment(trade: TradeEvent): boolean {
  return Boolean(
    trade.meta_name &&
    trade.N_score !== null && trade.N_score !== undefined &&
    trade.I_score !== null && trade.I_score !== undefined &&
    trade.C_score !== null && trade.C_score !== undefined &&
    trade.S_score !== null && trade.S_score !== undefined &&
    trade.N_why &&
    trade.I_why &&
    trade.C_why &&
    trade.S_why
  );
}

function mergeNicsJudgments(targetTrades: TradeEvent[], gradedTrades: TradeEvent[]): number {
  const byKey = new Map<string, TradeEvent>();
  for (const trade of targetTrades) {
    byKey.set(nicsMergeKey(trade), trade);
  }
  let merged = 0;
  for (const graded of gradedTrades) {
    const target = byKey.get(nicsMergeKey(graded));
    if (!target) continue;
    for (const column of LLM_NICS_COLUMNS) {
      const value = graded[column];
      if (value !== null && value !== undefined && value !== '') {
        (target as unknown as Record<string, unknown>)[column] = value;
      }
    }
    merged++;
  }
  return merged;
}

function nicsMergeKey(trade: TradeEvent): string {
  return [
    trade.mockape_trade_id ?? '',
    String(trade.trade_id ?? ''),
    trade.token_name.trim().toLowerCase(),
  ].join('::');
}

function renderNicsBackfillPrompt(trades: TradeEvent[], transcriptSegments: TranscriptSegment[]): string {
  const transcriptText = transcriptSegments.length > 0
    ? transcriptSegments.map((segment) => segment.text).join('\n')
    : '(Full transcript unavailable in this finalize path; use each row excerpt as evidence.)';
  const rowsForGrading = trades.map((trade) => ({
    trade_id: trade.trade_id,
    token_name: trade.token_name,
    mockape_trade_id: trade.mockape_trade_id,
    rationale: trade.rationale,
    pre_transcript_excerpt: trade.pre_transcript_excerpt,
    post_transcript_excerpt: trade.post_transcript_excerpt,
    target_low_mc: trade.target_low_mc,
    target_high_mc: trade.target_high_mc,
    stop_loss_mc: trade.stop_loss_mc,
    outcome_summary: trade.outcome_summary,
    adherence_self_assessment: trade.adherence_self_assessment,
    notes: trade.notes,
  }));
  return `You are grading Snipalot trade rows for NICS/meta classification.

Return ONLY a JSON array. Return one object per input trade. Each object MUST include:
trade_id, token_name, mockape_trade_id, meta_name, N_score, N_why, I_score, I_why, C_score, C_why, S_score, S_why, NICS_score, trade_type, llm_grade_notes.

Scoring rules:
- N_score, I_score, C_score, and S_score are binary 0 or 1.
- NICS_score = N_score + I_score + C_score + S_score.
- N = the trader clearly names the narrative/meta/setup being traded, not just the ticker.
- I = the trader states why this specific token is the selected ticket for that meta or what immediate evidence supports entry.
- C = the trader gives the actual cut/close reason: why they got out, what failed, what changed, or what stopped working.
- S = the trader states the sell/stay plan for a working trade: profit target, scale-out, cost recovery, trailing logic, or upside management.
- meta_name should identify the repeatable meta cluster, not necessarily the ticker.
- Use 0 and explain the missing evidence when a component is absent. Do not leave any N/I/C/S fields blank.
- Use Core NICS++ when NICS_score >= 3. Otherwise use Scout or Non-NICS.
- Do not populate meta_cluster_id, size_ok, zone_ok, cooldown_ok, counts_toward_50, hard_reset, running_count, non_nics_pnl_pct, or cluster_pnl_pct.

Trades to grade:
${JSON.stringify(rowsForGrading, null, 2)}

Transcript evidence:
${transcriptText}
`;
}

/** Format ms offset as "M:SS" for the markers payload + extraction prompt. */
function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Render the extraction prompt for the LLM. Inlined as a string template
 * for now; can move to an editable file under ~/.snipalot/prompts/ in a
 * later polish milestone if the user wants to tune it without recompile.
 *
 * The trader's transcript is included with [MARKER N at M:SS] anchor tags
 * inserted at the offsets the user pressed the trade-marker hotkey. The model uses
 * markers as focal points but isn't required to find one trade per marker
 * â€” content alone is enough.
 */
/**
 * Wait until either mockape.json or mockape.json.skipped exists in the
 * session folder. The trade-context window writes one of these when the
 * user clicks Continue/Skip, OR main writes the .skipped sentinel
 * directly when autoPromptForTradeData is off. Polls every 1s; max wait
 * a few minutes (defensive if the window is dismissed without writing
 * files â€” closed-window-handler in main also writes the sentinel).
 */
async function waitForTradeContextDecision(
  sessionDir: string,
  /** Shorter default so a dismissed/hidden trade window does not block the pipeline for 30 min. */
  timeoutMs: number = 3 * 60 * 1000,
  abortSignal?: AbortSignal
): Promise<void> {
  const dataPath = getTradeInputPath(sessionDir, 'mockape.json');
  const skipPath = getTradeInputPath(sessionDir, 'mockape.json.skipped');
  const legacyDataPath = path.join(sessionDir, 'mockape.json');
  const legacySkipPath = path.join(sessionDir, 'mockape.json.skipped');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(abortSignal);
    if (
      fs.existsSync(dataPath) ||
      fs.existsSync(skipPath) ||
      fs.existsSync(legacyDataPath) ||
      fs.existsSync(legacySkipPath)
    ) {
      log('trade-pipeline', 'trade-context decision detected', {
        hasData: fs.existsSync(dataPath) || fs.existsSync(legacyDataPath),
        skipped: fs.existsSync(skipPath) || fs.existsSync(legacySkipPath),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throwIfAborted(abortSignal);
  log('trade-pipeline', 'trade-context wait timed out â€” proceeding without trade data');
}

function renderExtractionPrompt(
  transcriptSegments: TranscriptSegment[],
  tradeMarkers: TradeMarkerRecord[],
  mockape: MockApeTrade[] | null,
  recordingStartedAtMs: number
): string {
  // Build the annotated transcript: a stable line-per-segment dump with
  // marker tags spliced in at the closest segment boundary.
  const sortedMarkers = [...tradeMarkers].sort((a, b) => a.offsetMs - b.offsetMs);
  let nextMarkerIdx = 0;
  const annotatedLines: string[] = [];
  for (const seg of transcriptSegments) {
    while (
      nextMarkerIdx < sortedMarkers.length &&
      sortedMarkers[nextMarkerIdx].offsetMs <= seg.startSec * 1000
    ) {
      const marker = sortedMarkers[nextMarkerIdx];
      annotatedLines.push(
        `[TRADE MARKER ${nextMarkerIdx + 1} at ${marker.offsetLabel || formatOffset(marker.offsetMs)}]`
      );
      nextMarkerIdx++;
    }
    annotatedLines.push(seg.text);
  }
  while (nextMarkerIdx < sortedMarkers.length) {
    const marker = sortedMarkers[nextMarkerIdx];
    annotatedLines.push(
      `[TRADE MARKER ${nextMarkerIdx + 1} at ${marker.offsetLabel || formatOffset(marker.offsetMs)}]`
    );
    nextMarkerIdx++;
  }

  let markerBlock = '';
  if (sortedMarkers.length > 0) {
    const lines: string[] = [];
    lines.push('## Trader-entered trade markers');
    lines.push('');
    lines.push('These markers were created during the trade session by the trader');
    lines.push('pressing the configured Trade Marker hotkey / HUD target button.');
    lines.push('Treat each marker as an ENTRY / decision-time anchor unless the');
    lines.push('nearby transcript clearly says it was an exit or trim marker.');
    lines.push('');
    sortedMarkers.forEach((marker, i) => {
      const screenshot = marker.screenshotPath ? ` Â· screenshot=${path.basename(marker.screenshotPath)}` : '';
      lines.push(`${i + 1}. marker at **${marker.offsetLabel || formatOffset(marker.offsetMs)}**${screenshot}`);
    });
    lines.push('');
    markerBlock = lines.join('\n');
  }

  // If MockApe data is available, build a chronological context block
  // with each trade's recording-relative offset (computed from absolute
  // timestamp minus recording start). The LLM uses this as the canonical
  // trade list and aligns spoken commentary against it.
  let mockapeBlock = '';
  if (mockape && mockape.length > 0) {
    const sorted = [...mockape].sort((a, b) => a.timestamp - b.timestamp);
    const lines: string[] = [];
    lines.push('## Actual trades from MockApe / Padre (canonical, chronological)');
    lines.push('');
    lines.push('Each trade fired at a real moment in the session. The "fired at"');
    lines.push('M:SS is computed from the absolute trade timestamp minus the');
    lines.push('recording start. Use this list as the SOURCE OF TRUTH and find');
    lines.push('the spoken context (transcript window around that M:SS) that');
    lines.push('matches each trade.');
    lines.push('');
    sorted.forEach((t, i) => {
      const offsetMs = t.timestamp - recordingStartedAtMs;
      const offsetLabel = offsetMs >= 0 ? formatOffset(offsetMs) : '(before recording)';
      const pnlSign = t.pnlSol >= 0 ? '+' : '';
      lines.push(
        `${i + 1}. **${t.tokenName}** Â· entry $${formatMcInline(t.entryMarketCap)} â†’ exit $${formatMcInline(t.exitMarketCap)} Â· ${pnlSign}${t.pnlSol.toFixed(4)} SOL (${pnlSign}${t.pnlPercentage.toFixed(2)}%) Â· fired at **${offsetLabel}** in session Â· trade_id=${t.id}`
      );
    });
    lines.push('');
    mockapeBlock = lines.join('\n');
  }

  const hasMockape = mockape && mockape.length > 0;

  return `You are analyzing a trader's spoken commentary during a meme coin
trading session.${hasMockape ? ' You have ONE additional data source: the trader\'s actual MockApe / Padre trade history (below).' : ''}
${hasMockape ? `

${mockapeBlock}` : ''}
${markerBlock ? `\n${markerBlock}` : ''}

## Transcript

The transcript below is a chronological narration with optional
[TRADE MARKER N at M:SS] tags indicating moments the trader explicitly
flagged as trade-entry / decision anchors by pressing the trade marker
hotkey or HUD target button.

\`\`\`
${annotatedLines.join('\n')}
\`\`\`

## Task

${hasMockape ? `For EACH actual trade in the MockApe list above, find the matching
spoken context in the transcript:
- Use TRADE MARKER tags as the strongest anchors for the entry / decision
  moment. The trader presses these when entering or intentionally marking
  the setup, because MockApe's timestamp often reflects the later exit or
  resolved trade event rather than the original spoken entry.
- Use the MockApe "fired at" timestamp as the strongest anchor for the
  actual trade/outcome moment. Look seconds before and after it for exit
  commentary, adherence assessment, and the final market-cap context.
- The interval between the nearest entry marker and MockApe timestamp is
  where partial entries, trims, and scale-outs are most likely to be
  discussed. Search that interval before deciding there was only one
  100% in / 100% out leg.
- The trader's commentary near the entry marker is the **pre-trade
  callout** (entry market cap, target market cap range, rationale).
- The trader's commentary near the MockApe timestamp is the **post-trade
  callout** (exit, outcome, adherence assessment).
- If the trader mentions a coin in the transcript but it has no matching
  MockApe trade (musing only â€” no actual entry), include it as an
  EXTRA row at the end with mockape_trade_id=null.

Token-name disambiguation: whisper transcripts mishear meme coin names
("guy" might be heard as "buy", "FELON" might be heard as "felon" or
"fell on"). Use the actual MockApe tokenName as canonical and find
whatever the trader actually said for that trade.` : `Identify each distinct trade in the session. A "trade" pairs a pre-trade
callout (the trader announces a coin and a target market cap range with
a rationale) with a post-trade callout (the trader announces the exit
and how it went). Either side can be missing.`}

## Output schema

Return a JSON array, one object per trade. The shape below uses
\`<PLACEHOLDER>\` markers â€” your actual output must replace each
placeholder with the real value from the MockApe list and transcript
above. The placeholder names are NOT example data; do NOT include
them verbatim in your output.

Use null for any field the transcript / data genuinely doesn't speak to.

[
  {
    "trade_id": <SEQUENTIAL_INT_STARTING_AT_1>,
    "token_name": "<TOKEN_NAME_FROM_MOCKAPE_LIST_ABOVE>",
    "mockape_trade_id": ${hasMockape ? '"<EXACT_TRADE_ID_FROM_MOCKAPE_LIST_ABOVE>"' : 'null'},
    "leg_index": <INT_OR_NULL>,
    "leg_count": <INT_OR_NULL>,
    "position_fraction": <NUMBER_0_TO_1_OR_NULL>,
    "pre_call_offset_label": "<M:SS_OF_PRE_CALLOUT_OR_NULL>",
    "pre_call_offset_ms": <SAME_AS_LABEL_IN_MS_OR_NULL>,
    "post_call_offset_label": "<M:SS_OF_POST_CALLOUT_OR_NULL>",
    "post_call_offset_ms": <SAME_AS_LABEL_IN_MS_OR_NULL>,
    "target_low_mc": <SPOKEN_TARGET_LOW_INT_OR_NULL>,
    "target_high_mc": <SPOKEN_TARGET_HIGH_INT_OR_NULL>,
    "stop_loss_mc": <SPOKEN_STOP_LOSS_INT_OR_NULL>,
    "rationale": "<TRADER_S_OWN_WORDS_FOR_WHY_OR_NULL>",
    "pre_transcript_excerpt": "<NEAR_VERBATIM_PRE_QUOTE_OR_NULL>",
    "post_transcript_excerpt": "<NEAR_VERBATIM_POST_QUOTE_OR_NULL>",
    "exit_mc_estimate": <SPOKEN_EXIT_MC_INT_OR_NULL>,
    "outcome_summary": "<TRADER_S_OWN_WORDS_FOR_OUTCOME_OR_NULL>",
    "adherence_self_assessment": "<TRADER_S_OWN_WORDS_ON_PLAN_ADHERENCE_OR_NULL>",
    "pre_confidence": "<low|medium|high|null>",
    "post_confidence": "<low|medium|high|null>",
    "needs_review": <true_OR_false>,
    "notes": "<ANY_RELEVANT_FLAG_OR_NULL>",
    "meta_name": "<SHORT_META_CLUSTER_NAME_OR_NULL>",
    "N_score": <0_OR_1>,
    "N_why": "<WHY_N_SCORE_WAS_OR_WAS_NOT_EARNED>",
    "I_score": <0_OR_1>,
    "I_why": "<WHY_I_SCORE_WAS_OR_WAS_NOT_EARNED>",
    "C_score": <0_OR_1>,
    "C_why": "<WHY_C_SCORE_WAS_OR_WAS_NOT_EARNED>",
    "S_score": <0_OR_1>,
    "S_why": "<WHY_S_SCORE_WAS_OR_WAS_NOT_EARNED>",
    "NICS_score": <N_SCORE_PLUS_I_SCORE_PLUS_C_SCORE_PLUS_S_SCORE>,
    "trade_type": "<Core NICS++|Scout|Non-NICS|OTHER_SHORT_LABEL>",
    "llm_grade_notes": "<ONE_OR_TWO_SENTENCE_RECONCILIATION_NOTE>"
  }
]

Rules:
- Market cap values are integers in dollars ("80k" â†’ 80000, "1.2m" â†’ 1200000).
- ${hasMockape ? 'mockape_trade_id MUST match the trade_id from the MockApe list above for matched trades. Use null for spoken-only musings with no actual trade.' : 'mockape_trade_id should be null (no MockApe data was provided this session).'}
- pre_call_offset_label / pre_call_offset_ms = where in the recording (M:SS
  + same value in ms) the trader spoke the prediction.
- post_call_offset_label / post_call_offset_ms = where the trader spoke
  about the exit.
- If a trade has no spoken pre-callout (silent entry), set pre_* fields to
  null. Same for missing post-callouts.
- If the trader mentions a coin but doesn't clearly enter a position
  (musing only), set confidence=low, needs_review=true.

**ANTI-FABRICATION (critical):**
- rationale, outcome_summary, adherence_self_assessment, target_low_mc,
  target_high_mc, stop_loss_mc, exit_mc_estimate must come DIRECTLY from words the
  trader said in the transcript. Quote-paraphrase only.
- DO NOT invent rationale ("strong fundamentals", "bullish setup",
  "good entry") if the trader didn't say something equivalent. If the
  trader only said "this looks fun" or "let's see what happens", the
  rationale is "this looks fun" â€” not a synthesized investment thesis.
- DO NOT infer target market caps from the actual entry/exit prices.
  Targets must come from the trader's spoken prediction. If they only
  said "I'm going to double this", target_high_mc = entry Ã— 2 IS a
  defensible inference (double is a clear quantitative claim). If they
  said nothing about a target, target_low_mc and target_high_mc are null.
- Parse explicit profit/stop language. "2x", "double up", or "two-bagger"
  means target_high_mc is roughly entry_mc_actual * 2 when a MockApe entry
  market cap is available. "3x" / "three-bagger" means entry_mc_actual * 3.
  "50% up" means entry_mc_actual * 1.5. "50% loss", "cut it in half",
  "get out around 3.5k", or "stop at 3.5k" should populate stop_loss_mc
  when the spoken entry/actual entry gives enough context.
- pre_transcript_excerpt and post_transcript_excerpt must be VERBATIM
  quotes from the transcript (or near-verbatim with [...] for elision).
  These are evidence â€” the trader will read them to verify your
  extraction is honest.
- If a field would require speculation, set it to null. A null is more
  useful than a fabricated value because the trader can see what wasn't
  captured and decide whether to re-record more clearly next time.
- needs_review=true on any trade where you had to guess at any
  non-trivial field. Better to flag than to silently fabricate.

**NICS / META CLUSTER SCORING:**
- The NICS fields are REQUIRED on every output object: meta_name, N_score, N_why, I_score, I_why, C_score, C_why, S_score, S_why, NICS_score, trade_type, and llm_grade_notes. Do not omit them even when the score is 0.
- Score N_score, I_score, C_score, and S_score as separate binary evidence fields.
- NICS_score = N_score + I_score + C_score + S_score. It ranges from 0 to 4.
- N = the trader clearly names the narrative/meta/setup being traded, not just the ticker. This is required for a counted trade.
- I = the trader states why this specific token is the selected ticket for that meta or what immediate evidence supports entry. This is required for a counted trade.
- C = the trader gives the actual cut/close reason: why they got out, what failed, what changed, or what stopped working. C can come from exit commentary or the immediate post-trade note. "Dead" / "unclear" can earn C if it is the trader's stated exit reason, but flag it in llm_grade_notes because it needs review.
- S = the trader states the sell/stay plan for a working trade: profit target, scale-out, cost recovery, trailing logic, or how they manage upside after deciding to stay in.
- A trade qualifies as Core NICS++ evidence when NICS_score >= 3. Lower scores should be Scout or Non-NICS unless another explicit label is clearly warranted.
- meta_name should identify the repeatable meta cluster, not necessarily the ticker. If multiple tokens are lottery tickets for the same idea, use the same meta_name for them.
- Do not populate meta_cluster_id. Leave it null; master sync assigns stable historical IDs such as M.260518.1.
- Do not treat cooldown as a hard reset. If the transcript suggests a cooldown concern, mention it in llm_grade_notes, but the sync process will track cooldown separately.
- N_why, I_why, C_why, S_why must be evidence-based and compact. If the evidence is absent, score 0 and say what was missing.

**PARTIAL EXITS:**
- Mock Ape's export sometimes shows ONE entry/exit pair per trade even
  if the trader scaled out in pieces. The transcript may mention
  "selling half now" then later "all out" â€” both refer to the same
  underlying trade_id. Treat partial-exit commentary as part of the
  SAME trade, not separate trades. post_transcript_excerpt should
  combine the partial-exit statements ("selling half now [...] all
  out at 4k") so the trader's full exit narrative is preserved.
- If the transcript clearly indicates scaling ("half in", "sold half",
  "trimmed", "took partials", "all out"), you MAY output multiple rows
  for the same mockape_trade_id instead of flattening everything into one
  round-trip row.
- Use leg_index, leg_count, and position_fraction on scaled rows when the
  transcript makes those details explicit or strongly inferable.
- If the trader's single spoken exit market cap would imply breakeven but
  MockApe shows meaningful profit or loss, treat that mismatch as a clue
  to go back through the transcript and look for partial exits or entries
  that explain the aggregate P&L.

- **Output ONLY the JSON array.** No prose before or after, no markdown
  code fences, no commentary. The receiving tool parses your output
  directly.
`;
}

/** Inline market-cap formatter for the prompt context block. */
function formatMcInline(mc: number): string {
  if (mc >= 1_000_000) return `${(mc / 1_000_000).toFixed(2)}m`;
  if (mc >= 1_000) return `${(mc / 1_000).toFixed(1)}k`;
  return mc.toString();
}

/**
 * Write prompt.txt to the session folder + put the prompt text
 * on the clipboard so the user can paste it directly into their LLM
 * without opening the file. Notification surfaces the next step.
 */
function writeExtractionPrompt(
  sessionDir: string,
  promptText: string
): { promptPath: string; responsePath: string } {
  const inputsDir = getTradeInputsDir(sessionDir);
  const promptPath = path.join(sessionDir, 'prompt.txt');
  const responsePath = path.join(inputsDir, 'extraction_response.json');
  fs.writeFileSync(promptPath, promptText, 'utf-8');
  clipboard.writeText(promptText);

  // Drop a clear NEXT_STEPS.md into the folder so anyone browsing it
  // can immediately see the manual-paste workflow without reading a
  // notification or hunting through the codebase.
  const nextStepsPath = path.join(inputsDir, 'NEXT_STEPS.md');
  const nextSteps = `# Next steps for this Trade session

Snipalot has finished recording, transcribing, and packaging your session.
Now it needs YOU to do two things, then it'll automatically generate the
final \`trade_log.xlsx\` plus companion review docs.

## 1. Generate the structured trade JSON via your LLM

The extraction prompt is currently on your **clipboard**. It contains:
- Detailed instructions for the LLM
- Your full transcript with marker tags
- The exact JSON schema to return

Paste that prompt into one of these and let it think:
- **Claude Code** (Jason)
- **Gemini CLI** / **Cursor** / **OpenRouter free tier** (son)
- Or any other LLM you have access to (ChatGPT, etc.)

The LLM will return a JSON array of trade events. **Save that JSON
into \`Inputs/extraction_response.json\`** (exact filename).

If the file is missing or you forgot to copy the prompt: open
\`prompt.txt\` in this folder â€” the same prompt is there.

## 2. (Optional but recommended) Drop your MockApe trade export

If you exported trades from MockApe / Padre, save the JSON array into
the \`Inputs\` folder as \`mockape.json\` (exact filename). Snipalot will:
- Match each spoken trade to its actual MockApe entry by token name +
  timestamp
- Add real entry/exit market caps, P&L SOL, P&L %, win/loss columns
  to \`trade_log.xlsx\`
- Surface aggregate P&L stats in \`Inputs/adherence_report.md\`

If you skip this, the trade log still ships â€” just without the actual
P&L columns.

## 3. Wait

Snipalot is polling this folder every 2 seconds. As soon as
\`Inputs/extraction_response.json\` shows up and validates, it generates:
- \`trade_log.xlsx\` â€” formatted workbook, one row per trade
- \`trade_log.md\` â€” human-readable per-trade view
- \`Inputs/adherence_report.md\` â€” aggregate stats
- \`Inputs/processing_log.jsonl\` â€” compact diagnostic trail for this session

The polling timeout is 60 minutes from the moment the recording stopped.

## Files in this folder right now

- \`transcript.txt\` â€” whisper-generated transcript
- \`prompt.txt\` â€” paste-ready LLM prompt (also on clipboard)
- \`Inputs/markers.json\` â€” your Ctrl+Shift+X marker timestamps
- \`Inputs/NEXT_STEPS.md\` â€” this file
- _(after you save extraction_response.json:)_
  - \`Inputs/extraction_response.json\` â€” your LLM's JSON answer
  - \`Inputs/mockape.json\` â€” your Padre export (optional)
  - \`trade_log.xlsx\`, \`trade_log.md\`, plus \`Inputs/adherence_report.md\` â€” the deliverables
`;
  fs.writeFileSync(nextStepsPath, nextSteps, 'utf-8');

  log('trade-pipeline', 'extraction prompt + NEXT_STEPS written + clipboarded', {
    promptPath,
    nextStepsPath,
    chars: promptText.length,
  });

  if (Notification.isSupported()) {
    new Notification({
      title: 'Snipalot Trade - prompt ready',
      body:
        `Paste the prompt into Claude Code / Gemini / Cursor, then paste ` +
        `the JSON reply into the Snipalot response window. ` +
        `Trade log generates automatically.`,
      silent: false,
    }).show();
  }
  return { promptPath, responsePath };
}

/**
 * Poll for extraction_response.json in the session folder. Resolves with
 * the parsed TradeEvent[] when the file appears and validates, or null if
 * the timeout (default 60 minutes) elapses first. fs.watch is unreliable
 * cross-platform, so we poll every 2s â€” overhead is negligible.
 */
async function waitForExtractionResponse(
  responsePath: string,
  timeoutMs: number = 60 * 60 * 1000,
  abortSignal?: AbortSignal
): Promise<TradeEvent[] | null> {
  const sessionDir = path.dirname(path.dirname(responsePath));
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 2000;
  writeSessionLog(sessionDir, 'trade-pipeline', 'waiting for extraction_response.json', {
    responsePath,
    timeoutMs,
    pollInterval,
  }, 'start');
  while (Date.now() < deadline) {
    throwIfAborted(abortSignal);
    if (fs.existsSync(responsePath)) {
      try {
        const raw = fs.readFileSync(responsePath, 'utf-8');
        const parsed = parseAndValidateResponse(raw);
        log('trade-pipeline', 'extraction_response.json parsed', { trades: parsed.length });
        writeSessionLog(sessionDir, 'trade-pipeline', 'extraction_response.json parsed', {
          responsePath,
          trades: parsed.length,
        }, 'success');
        return parsed;
      } catch (err) {
        log('trade-pipeline', 'extraction_response.json parse error', {
          err: (err as Error).message,
        });
        writeSessionLog(sessionDir, 'trade-pipeline', 'extraction_response.json parse error', {
          responsePath,
          error: (err as Error).message,
        }, 'error');
        if (Notification.isSupported()) {
          new Notification({
            title: 'Snipalot Trade - response invalid',
            body: `extraction_response.json couldn't be parsed: ${(err as Error).message}. Fix and re-save.`,
            silent: false,
          }).show();
        }
        // Move the bad file aside so the next poll picks up a fresh attempt.
        try {
          fs.renameSync(responsePath, responsePath + '.invalid-' + Date.now());
        } catch {
          /* ignore */
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  throwIfAborted(abortSignal);
  log('trade-pipeline', 'extraction_response.json timeout', { responsePath });
  writeSessionLog(sessionDir, 'trade-pipeline', 'extraction_response.json timeout', {
    responsePath,
    timeoutMs,
  }, 'timeout');
  return null;
}

async function finalizeTradeOutputsFromResponsePath(
  responsePath: string,
  sessionDir: string,
  mockape: MockApeTrade[] | null,
  startedAtMs: number,
  durationMs: number,
  abortSignal?: AbortSignal
): Promise<void> {
  writeSessionLog(sessionDir, 'trade-pipeline', 'background finalize waiting for manual response', {
    responsePath,
  }, 'start');
  const trades = await waitForExtractionResponse(responsePath, undefined, abortSignal);
  if (!trades) {
    writeSessionLog(sessionDir, 'trade-pipeline', 'background finalize stopped without response', {
      responsePath,
    }, 'timeout');
    return;
  }
  throwIfAborted(abortSignal);
  if (mockape) {
    joinMockApeById(trades, mockape);
    const unjoined = trades.filter((t) => !t.mockape_trade_id);
    if (unjoined.length > 0) {
      const fuzzy = joinMockApe(unjoined, mockape, startedAtMs);
      log('trade-pipeline', 'mockape fuzzy fallback applied', fuzzy);
    }
  }
  throwIfAborted(abortSignal);
  const outputTrades = mockape ? trades.filter((t) => Boolean(t.mockape_trade_id)) : trades;
  const omittedSpokenOnly = trades.length - outputTrades.length;
  if (omittedSpokenOnly > 0) {
    log('trade-pipeline', 'omitted spoken-only non-trade rows from background outputs', {
      omitted: omittedSpokenOnly,
      kept: outputTrades.length,
    });
  }
  await ensureNicsJudgmentsForTrades(sessionDir, outputTrades, [], undefined, abortSignal);
  await writeTradeLogXlsx(sessionDir, outputTrades, startedAtMs, durationMs);
  writeTradeLogMd(sessionDir, outputTrades, startedAtMs, durationMs);
  writeAdherenceReport(getTradeInputsDir(sessionDir), outputTrades);
  organizeTradeSessionRoot(sessionDir);
  log('trade-pipeline', 'background finalize complete', {
    sessionDir,
    trades: outputTrades.length,
    omittedSpokenOnly,
  });
  writeSessionLog(sessionDir, 'trade-pipeline', 'background finalize complete', {
    trades: outputTrades.length,
    omittedSpokenOnly,
  }, 'success');
}

/**
 * Parse the LLM's JSON response. Tolerates markdown code fences (some
 * LLMs add them despite the prompt asking for raw JSON) by stripping
 * them first. Validates that each entry has the required minimum fields.
 */
function parseAndValidateResponse(raw: string): TradeEvent[] {
  // Strip ```json ... ``` fences if present.
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const arr = JSON.parse(cleaned);
  if (!Array.isArray(arr)) {
    throw new Error('Response root must be an array of trade events.');
  }
  return arr.map((entry, i): TradeEvent => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Entry ${i + 1} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.token_name !== 'string') {
      throw new Error(`Entry ${i + 1} is missing required token_name (string)`);
    }
    return {
      trade_id: typeof e.trade_id === 'number' ? e.trade_id : i + 1,
      token_name: e.token_name,
      pre_call_offset_ms: numOrNull(e.pre_call_offset_ms),
      pre_call_offset_label: strOrNull(e.pre_call_offset_label),
      post_call_offset_ms: numOrNull(e.post_call_offset_ms),
      post_call_offset_label: strOrNull(e.post_call_offset_label),
      target_low_mc: numOrNull(e.target_low_mc),
      target_high_mc: numOrNull(e.target_high_mc),
      stop_loss_mc: numOrNull(e.stop_loss_mc),
      rationale: strOrNull(e.rationale),
      pre_transcript_excerpt: strOrNull(e.pre_transcript_excerpt),
      post_transcript_excerpt: strOrNull(e.post_transcript_excerpt),
      exit_mc_estimate: numOrNull(e.exit_mc_estimate),
      outcome_summary: strOrNull(e.outcome_summary),
      adherence_self_assessment: strOrNull(e.adherence_self_assessment),
      pre_confidence: confOrNull(e.pre_confidence),
      post_confidence: confOrNull(e.post_confidence),
      needs_review: typeof e.needs_review === 'boolean' ? e.needs_review : false,
      notes: strOrNull(e.notes),
      meta_cluster_id: strOrNull(e.meta_cluster_id),
      meta_name: strOrNull(e.meta_name),
      N_score: binaryOrNull(e.N_score),
      N_why: strOrNull(e.N_why),
      I_score: binaryOrNull(e.I_score),
      I_why: strOrNull(e.I_why),
      C_score: binaryOrNull(e.C_score),
      C_why: strOrNull(e.C_why),
      S_score: binaryOrNull(e.S_score),
      S_why: strOrNull(e.S_why),
      NICS_score: numOrNull(e.NICS_score),
      trade_type: strOrNull(e.trade_type),
      llm_grade_notes: strOrNull(e.llm_grade_notes),
      size_ok: boolOrNull(e.size_ok),
      zone_ok: boolOrNull(e.zone_ok),
      cooldown_ok: boolOrNull(e.cooldown_ok),
      counts_toward_50: boolOrNull(e.counts_toward_50),
      hard_reset: boolOrNull(e.hard_reset),
      running_count: numOrNull(e.running_count),
      non_nics_pnl_pct: numOrNull(e.non_nics_pnl_pct),
      cluster_pnl_pct: numOrNull(e.cluster_pnl_pct),
      leg_index: numOrNull(e.leg_index),
      leg_count: numOrNull(e.leg_count),
      position_fraction: numOrNull(e.position_fraction),
      // LLM-provided alignment to the MockApe canonical trade list.
      // When present, joinMockApeById short-circuits the fuzzy matcher
      // and just enriches with PnL from the matching trade.
      mockape_trade_id: strOrNull(e.mockape_trade_id),
      mockape_timestamp_ms: numOrNull(e.mockape_timestamp_ms),
    };
  });
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}
function binaryOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  if (n === null) return null;
  return n >= 1 ? 1 : 0;
}
function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function confOrNull(v: unknown): 'low' | 'medium' | 'high' | null {
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return null;
}

// Trade workbook + Markdown helpers

function wrapCsvText(value: string | null | undefined, width = 40): string {
  if (!value) return '';
  const words = value.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function formatFixedDecimal(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return value.toFixed(decimals);
}

function formatWholeNumberWithCommas(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return Math.round(value).toLocaleString('en-US');
}

function getTradeInputsDir(sessionDir: string): string {
  const inputsDir = path.join(sessionDir, 'Inputs');
  if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });
  return inputsDir;
}

function getTradeInputPath(sessionDir: string, fileName: string): string {
  return path.join(getTradeInputsDir(sessionDir), fileName);
}

const XLSX_SOURCE_COLUMNS = [
  'source_session',
  'source_log_type',
  'source_folder_archived_path',
  'processed_at',
] as const;

const XLSX_WORKFLOW_COLUMNS = [
  'trade_id',
  'token_name',
  'trade_date',
  'video_start_time',
  'entry_commentary_time',
  'entry_time_inferred',
  'exit_commentary_time',
  'exit_time_actual',
  'time_in_trade_seconds',
  'video_end_time',
  'entry_mc_actual',
  'target_exit_low_mc',
  'target_exit_high_mc',
  'stop_loss_mc',
  'exit_mc_actual',
  'sol_invested',
  'sol_received',
  'pnl_sol',
  'pnl_percentage',
  'rationale',
  'pre_transcript_excerpt',
  'post_transcript_excerpt',
  'adherence_self_assessment',
  'notes',
  'needs_review',
  'mockape_trade_id',
] as const;

const XLSX_TIME_BUCKET_COLUMNS = [
  'Hour',
  'Weekday',
  'WeekdayNum',
  'TimeBucket',
] as const;

const XLSX_NICS_COLUMNS = [
  'meta_cluster_id',
  'meta_name',
  'N_score',
  'N_why',
  'I_score',
  'I_why',
  'C_score',
  'C_why',
  'S_score',
  'S_why',
  'NICS_score',
  'size_ok',
  'zone_ok',
  'cooldown_ok',
  'trade_type',
  'counts_toward_50',
  'hard_reset',
  'running_count',
  'non_nics_pnl_pct',
  'cluster_pnl_pct',
  'llm_grade_notes',
] as const;

const XLSX_COLUMNS = [
  ...XLSX_SOURCE_COLUMNS,
  ...XLSX_WORKFLOW_COLUMNS,
  ...XLSX_TIME_BUCKET_COLUMNS,
  ...XLSX_NICS_COLUMNS,
] as const;

type XlsxColumn = typeof XLSX_COLUMNS[number];
type XlsxRow = Record<XlsxColumn, string>;

async function writeTradeLogXlsx(
  sessionDir: string,
  trades: TradeEvent[],
  recordingStartedAtMs: number,
  durationMs: number
): Promise<string> {
  const xlsxPath = path.join(sessionDir, 'trade_log.xlsx');
  const rows = trades.map((trade) => buildTradeXlsxRow(sessionDir, trade, recordingStartedAtMs, durationMs));
  const widths = computeXlsxColumnWidths(rows);
  const zip = new JSZip();

  zip.file('[Content_Types].xml', contentTypesXml());
  zip.folder('_rels')?.file('.rels', rootRelsXml());
  const xl = zip.folder('xl');
  xl?.file('workbook.xml', workbookXml());
  xl?.file('styles.xml', stylesXml());
  xl?.folder('_rels')?.file('workbook.xml.rels', workbookRelsXml());
  xl?.folder('worksheets')?.file('sheet1.xml', worksheetXml(rows, widths));
  zip.folder('docProps')?.file('app.xml', appPropsXml());
  zip.folder('docProps')?.file('core.xml', corePropsXml());

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(xlsxPath, buffer);
  log('trade-pipeline', 'trade_log.xlsx written', { xlsxPath, rows: rows.length });
  return xlsxPath;
}

function buildTradeXlsxRow(
  sessionDir: string,
  trade: TradeEvent,
  recordingStartedAtMs: number,
  durationMs: number
): XlsxRow {
  const timeline = buildTradeTimeline(trade, recordingStartedAtMs, durationMs);
  const nicsScore = trade.NICS_score ?? sumNicsScore(trade);
  const sizeOk = trade.size_ok ?? isHalfSol(trade.sol_invested);
  const zoneOk = trade.zone_ok ?? isNicsMarketCapZone(trade.entry_mc_actual);
  const countsToward50 = trade.counts_toward_50 ?? (
    hasCountedNicsEvidence(trade) === true && sizeOk === true
  );
  const bucketSource = timeline.entryInferred ?? timeline.entryCommentary ?? timeline.exitActual ?? timeline.videoStart;
  return {
    source_session: path.basename(sessionDir),
    source_log_type: 'generated-trade-xlsx',
    source_folder_archived_path: '',
    processed_at: new Date().toISOString(),
    trade_id: String(trade.trade_id),
    token_name: trade.token_name,
    trade_date: formatTradeDate(timeline.tradeDate),
    video_start_time: formatTradeTime(timeline.videoStart),
    entry_commentary_time: formatTradeTime(timeline.entryCommentary),
    entry_time_inferred: formatTradeTime(timeline.entryInferred),
    exit_commentary_time: formatTradeTime(timeline.exitCommentary),
    exit_time_actual: formatTradeTime(timeline.exitActual),
    time_in_trade_seconds: timeline.timeInTradeSeconds === null ? '' : String(timeline.timeInTradeSeconds),
    video_end_time: formatTradeTime(timeline.videoEnd),
    entry_mc_actual: formatWholeNumberWithCommas(trade.entry_mc_actual),
    target_exit_low_mc: formatWholeNumberWithCommas(trade.target_low_mc),
    target_exit_high_mc: formatWholeNumberWithCommas(trade.target_high_mc),
    stop_loss_mc: formatWholeNumberWithCommas(trade.stop_loss_mc),
    exit_mc_actual: formatWholeNumberWithCommas(trade.exit_mc_actual),
    sol_invested: formatFixedDecimal(trade.sol_invested, 2),
    sol_received: formatFixedDecimal(trade.sol_received, 2),
    pnl_sol: formatFixedDecimal(trade.pnl_sol, 2),
    pnl_percentage: formatFixedDecimal(trade.pnl_percentage, 1),
    rationale: wrapSpreadsheetText(trade.rationale),
    pre_transcript_excerpt: wrapSpreadsheetText(trade.pre_transcript_excerpt),
    post_transcript_excerpt: wrapSpreadsheetText(trade.post_transcript_excerpt),
    adherence_self_assessment: wrapSpreadsheetText(trade.adherence_self_assessment),
    notes: wrapSpreadsheetText(trade.notes),
    needs_review: trade.needs_review ? 'true' : 'false',
    mockape_trade_id: trade.mockape_trade_id ?? '',
    Hour: bucketSource ? String(bucketSource.getHours()) : '',
    Weekday: bucketSource ? formatWeekday(bucketSource) : '',
    WeekdayNum: bucketSource ? String(weekdayNumMondayFirst(bucketSource)) : '',
    TimeBucket: bucketSource ? timeBucketLabel(bucketSource) : '',
    meta_cluster_id: trade.meta_cluster_id ?? '',
    meta_name: trade.meta_name ?? '',
    N_score: formatOptionalNumber(trade.N_score),
    N_why: wrapSpreadsheetText(trade.N_why),
    I_score: formatOptionalNumber(trade.I_score),
    I_why: wrapSpreadsheetText(trade.I_why),
    C_score: formatOptionalNumber(trade.C_score),
    C_why: wrapSpreadsheetText(trade.C_why),
    S_score: formatOptionalNumber(trade.S_score),
    S_why: wrapSpreadsheetText(trade.S_why),
    NICS_score: formatOptionalNumber(nicsScore),
    size_ok: formatOptionalBoolean(sizeOk),
    zone_ok: formatOptionalBoolean(zoneOk),
    cooldown_ok: formatOptionalBoolean(trade.cooldown_ok),
    trade_type: trade.trade_type ?? '',
    counts_toward_50: formatOptionalBoolean(countsToward50),
    hard_reset: formatOptionalBoolean(trade.hard_reset),
    running_count: formatOptionalNumber(trade.running_count),
    non_nics_pnl_pct: formatFixedDecimal(trade.non_nics_pnl_pct, 1),
    cluster_pnl_pct: formatFixedDecimal(trade.cluster_pnl_pct, 1),
    llm_grade_notes: wrapSpreadsheetText(trade.llm_grade_notes),
  };
}

function sumNicsScore(trade: TradeEvent): number | null {
  const n = binaryScoreOrNull(trade.N_score);
  const i = binaryScoreOrNull(trade.I_score);
  const c = binaryScoreOrNull(trade.C_score);
  const s = binaryScoreOrNull(trade.S_score);
  if (n === null || i === null || c === null || s === null) return null;
  return n + i + c + s;
}

function hasCountedNicsEvidence(trade: TradeEvent): boolean | null {
  const score = sumNicsScore(trade);
  return score === null ? null : score >= 3;
}

function binaryScoreOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value) === 1 ? 1 : 0;
}

function isHalfSol(value: number | null | undefined): boolean | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.abs(value - 0.5) < 0.0001;
}

function isNicsMarketCapZone(value: number | null | undefined): boolean | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value >= 2000 && value <= 20000;
}

function formatOptionalNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(value);
}

function formatOptionalBoolean(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value ? 'true' : 'false';
}

function buildTradeTimeline(
  trade: TradeEvent,
  recordingStartedAtMs: number,
  durationMs: number
): {
  tradeDate: Date;
  videoStart: Date;
  videoEnd: Date;
  entryCommentary: Date | null;
  entryInferred: Date | null;
  exitCommentary: Date | null;
  exitActual: Date | null;
  timeInTradeSeconds: number | null;
} {
  const videoStart = new Date(recordingStartedAtMs);
  const videoEnd = new Date(recordingStartedAtMs + Math.max(0, durationMs));
  const entryCommentary = dateFromOffset(recordingStartedAtMs, trade.pre_call_offset_ms);
  const exitCommentary = dateFromOffset(recordingStartedAtMs, trade.post_call_offset_ms);
  const exitActual = trade.mockape_timestamp_ms ? new Date(trade.mockape_timestamp_ms) : null;
  const timeInTradeSeconds = getTimeInTradeSeconds(trade);
  const entryInferred =
    exitActual && timeInTradeSeconds !== null
      ? new Date(exitActual.getTime() - timeInTradeSeconds * 1000)
      : null;

  return {
    tradeDate: exitActual ?? videoStart,
    videoStart,
    videoEnd,
    entryCommentary,
    entryInferred,
    exitCommentary,
    exitActual,
    timeInTradeSeconds,
  };
}

function getTimeInTradeSeconds(trade: TradeEvent): number | null {
  if (trade.pre_call_offset_ms === null || trade.post_call_offset_ms === null) return null;
  const diff = trade.post_call_offset_ms - trade.pre_call_offset_ms;
  if (!Number.isFinite(diff) || diff < 0) return null;
  return Math.round(diff / 1000);
}

function dateFromOffset(recordingStartedAtMs: number, offsetMs: number | null): Date | null {
  if (offsetMs === null || !Number.isFinite(offsetMs)) return null;
  return new Date(recordingStartedAtMs + offsetMs);
}

function formatTradeDate(date: Date | null): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  }).format(date);
}

function formatTradeTime(date: Date | null): string {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).format(date);
}

function formatWeekday(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date);
}

function weekdayNumMondayFirst(date: Date): number {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function timeBucketLabel(date: Date): string {
  const hour = date.getHours();
  const weekdayNum = weekdayNumMondayFirst(date);
  if (weekdayNum <= 4 && hour < 18) return 'WD 6am-6pm';
  if (weekdayNum === 5 && hour < 18) return 'WD 6am-6pm';
  if (weekdayNum <= 4 && (hour === 18 || hour === 19)) return 'WD 6pm-8pm';
  if (weekdayNum <= 4 && hour >= 20 && hour <= 23) return 'WD 8pm-12am';
  if (weekdayNum <= 4 && (hour === 0 || hour === 1)) return 'WD 6am-6pm';
  if ((weekdayNum === 6 || weekdayNum === 7) && hour >= 2 && hour <= 11) return 'WE 6am-12pm';
  if ((weekdayNum === 6 || weekdayNum === 7) && hour >= 12 && hour <= 17) return 'WE 12pm-6pm';
  if ((weekdayNum === 5 || weekdayNum === 6 || weekdayNum === 7) && (hour === 18 || hour === 19)) return 'WE 6pm-8pm';
  if (weekdayNum === 5 && hour >= 20 && hour <= 23) return 'WE 8pm-2am';
  if (weekdayNum === 6 && (hour >= 20 || hour <= 1)) return 'WE 8pm-2am';
  if (weekdayNum === 7 && hour >= 20 && hour <= 23) return 'WE 8pm-2am';
  if (weekdayNum === 7 && (hour === 0 || hour === 1)) return 'WE 8pm-2am';
  return '';
}

function wrapSpreadsheetText(value: string | null | undefined, width = 40): string {
  if (!value) return '';
  return wrapCsvText(value, width);
}

function computeXlsxColumnWidths(rows: XlsxRow[]): number[] {
  return XLSX_COLUMNS.map((column) => {
    const values = [column, ...rows.map((row) => row[column])];
    const maxLineLength = values.reduce((max, value) => {
      const lines = String(value ?? '').split(/\r?\n/);
      return Math.max(max, ...lines.map((line) => line.length));
    }, 0);
    return Math.min(40, maxLineLength);
  });
}

function worksheetXml(rows: XlsxRow[], widths: number[]): string {
  const headerCells = XLSX_COLUMNS.map((column, i) =>
    inlineStringCell(cellRef(i, 1), column, 1)
  ).join('');
  const dataRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 2;
    const values = XLSX_COLUMNS.map((column, columnIndex) =>
      inlineStringCell(cellRef(columnIndex, rowNumber), row[column], 2)
    ).join('');
    const maxLines = Math.max(
      1,
      ...XLSX_COLUMNS.map((column) => String(row[column] ?? '').split(/\r?\n/).length)
    );
    const height = Math.min(120, maxLines * 15);
    return `<row r="${rowNumber}" ht="${height}" customHeight="1">${values}</row>`;
  }).join('');
  const colXml = widths.map((width, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${colXml}</cols>
  <sheetData>
    <row r="1">${headerCells}</row>
    ${dataRows}
  </sheetData>
  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

function inlineStringCell(ref: string, value: string, style: number): string {
  return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function cellRef(columnIndex: number, row: number): string {
  return `${columnName(columnIndex)}${row}`;
}

function columnName(columnIndex: number): string {
  let name = '';
  let n = columnIndex + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function xmlText(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '&#10;');
}

function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function workbookXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Trade Log" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function workbookRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
  <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill></fills>
  <borders count="2"><border/><border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function appPropsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Snipalot</Application></Properties>`;
}

function corePropsXml(): string {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>Snipalot</dc:creator>
  <cp:lastModifiedBy>Snipalot</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

/**
 * Write trade_log.md â€” human-readable view of the same data, one section
 * per trade with the key fields formatted for easy review.
 */
function writeTradeLogMd(
  sessionDir: string,
  trades: TradeEvent[],
  recordingStartedAtMs: number,
  durationMs: number
): string {
  const mdPath = path.join(sessionDir, 'trade_log.md');
  const lines: string[] = [];
  lines.push('# Trade Log');
  lines.push('');
  lines.push(`Generated by Snipalot Trade-mode - ${new Date().toLocaleString()}`);
  lines.push(`Total trades: ${trades.length}`);
  const gifPath = findSessionGifPath(sessionDir);
  if (gifPath) {
    lines.push('');
    lines.push(`![Session GIF](./${markdownPath(path.basename(gifPath))})`);
  }
  lines.push('');
  if (trades.length === 0) {
    lines.push('_No trades extracted from this session._');
  }
  for (const t of trades) {
    const timeline = buildTradeTimeline(t, recordingStartedAtMs, durationMs);
    const flag = t.needs_review ? ' needs review' : '';
    lines.push('---');
    lines.push('');
    lines.push(`## #${t.trade_id} - ${t.token_name}${flag}`);
    lines.push('');
    lines.push(`- **Trade date:** ${formatTradeDate(timeline.tradeDate)}`);
    lines.push(`- **Video start:** ${formatTradeTime(timeline.videoStart)}`);
    lines.push(`- **Entry commentary time:** ${formatTradeTime(timeline.entryCommentary) || 'unknown'}`);
    lines.push(`- **Entry time inferred:** ${formatTradeTime(timeline.entryInferred) || 'unknown'}`);
    lines.push(`- **Exit commentary time:** ${formatTradeTime(timeline.exitCommentary) || 'unknown'}`);
    lines.push(`- **Exit time actual:** ${formatTradeTime(timeline.exitActual) || 'unknown'}`);
    lines.push(`- **Time in trade seconds:** ${timeline.timeInTradeSeconds ?? 'unknown'}`);
    lines.push(`- **Video end:** ${formatTradeTime(timeline.videoEnd)}`);
    if (t.entry_mc_actual !== null && t.entry_mc_actual !== undefined) {
      const pnlSol = t.pnl_sol !== null && t.pnl_sol !== undefined ? t.pnl_sol : 0;
      const pnlPct = t.pnl_percentage !== null && t.pnl_percentage !== undefined ? t.pnl_percentage : 0;
      const pnlSign = pnlSol >= 0 ? '+' : '';
      lines.push(
        `- **MockApe actuals:** entry $${formatWholeNumberWithCommas(t.entry_mc_actual)} -> exit $${formatWholeNumberWithCommas(t.exit_mc_actual)}; ${pnlSign}${pnlSol.toFixed(2)} SOL (${pnlSign}${pnlPct.toFixed(1)}%)`
      );
      if (t.exit_scenario) {
        lines.push(`- **Exit vs target:** ${t.exit_scenario}${t.target_hit_low ? '; hit low' : ''}${t.target_hit_high ? '; hit high' : ''}`);
      }
      if (t.mockape_join_confidence) {
        lines.push(`- **MockApe match confidence:** ${t.mockape_join_confidence}`);
      }
    }
    if (t.target_low_mc !== null || t.target_high_mc !== null || t.stop_loss_mc !== null) {
      lines.push(
        `- **Plan:** target exit low $${formatWholeNumberWithCommas(t.target_low_mc) || 'unknown'}; target exit high $${formatWholeNumberWithCommas(t.target_high_mc) || 'unknown'}; stop loss $${formatWholeNumberWithCommas(t.stop_loss_mc) || 'unknown'}`
      );
    }
    if (t.rationale) lines.push(`- **Rationale:** ${t.rationale}`);
    if (t.outcome_summary) lines.push(`- **Spoken outcome:** ${t.outcome_summary}`);
    if (t.adherence_self_assessment) lines.push(`- **Adherence:** ${t.adherence_self_assessment}`);
    if (t.pre_confidence || t.post_confidence) {
      lines.push(`- **Extraction confidence:** pre=${t.pre_confidence ?? '?'} / post=${t.post_confidence ?? '?'}`);
    }
    if (t.pre_transcript_excerpt) {
      lines.push('');
      lines.push(`> _Pre:_ ${t.pre_transcript_excerpt}`);
    }
    if (t.post_transcript_excerpt) {
      lines.push(`> _Post:_ ${t.post_transcript_excerpt}`);
    }
    if (t.notes) {
      lines.push('');
      lines.push(`**Notes:** ${t.notes}`);
    }
    const screenshots = findScreenshotsForTrade(sessionDir, t);
    if (screenshots.length > 0) {
      lines.push('');
      lines.push('**Trade screenshots:**');
      lines.push('');
      for (const screenshot of screenshots) {
        lines.push(`![Trade screenshot](${markdownPath(path.relative(sessionDir, screenshot))})`);
        lines.push('');
      }
    }
    lines.push('');
  }
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf-8');
  log('trade-pipeline', 'trade_log.md written', { mdPath });
  return mdPath;
}

function findSessionGifPath(sessionDir: string): string | null {
  const gif = fs
    .readdirSync(sessionDir)
    .filter((name) => name.toLowerCase().endsWith('.gif'))
    .sort()[0];
  return gif ? path.join(sessionDir, gif) : null;
}

function findScreenshotsForTrade(sessionDir: string, trade: TradeEvent): string[] {
  const dir = path.join(sessionDir, 'Inputs', 'trade-screenshots');
  if (!fs.existsSync(dir)) return [];
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => /^marker-\d+\.png$/i.test(name))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
    .map((name) => path.join(dir, name));
  if (candidates.length === 0) return [];
  const direct = candidates[trade.trade_id - 1];
  return direct ? [direct] : candidates;
}

function markdownPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/ /g, '%20');
}

function organizeTradeSessionRoot(sessionDir: string): void {
  const inputsDir = getTradeInputsDir(sessionDir);
  const keep = new Set(['Inputs', 'prompt.txt', 'transcript.txt', 'trade_log.xlsx', 'trade_log.md']);
  try {
    for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      const name = entry.name;
      if (keep.has(name) || name.toLowerCase().endsWith('.gif')) continue;
      const from = path.join(sessionDir, name);
      const to = path.join(inputsDir, name);
      if (from === to || fs.existsSync(to)) continue;
      fs.renameSync(from, to);
    }
  } catch (err) {
    log('trade-pipeline', 'session root organization failed', { err: (err as Error).message, sessionDir });
  }
}

/**
 * Write adherence_report.md â€” aggregate stats across all trades. PnL
 * fields land in M7 (Padre join); for M5 we report only what extraction
 * gives us: target ranges, exit-vs-target, confidence, review flags.
 */
function writeAdherenceReport(sessionDir: string, trades: TradeEvent[]): string {
  const reportPath = path.join(sessionDir, 'adherence_report.md');
  const total = trades.length;
  const withTarget = trades.filter((t) => t.target_low_mc !== null && t.target_high_mc !== null);
  const withExit = trades.filter((t) => t.exit_mc_estimate !== null);
  const both = trades.filter(
    (t) => t.target_low_mc !== null && t.target_high_mc !== null && t.exit_mc_estimate !== null
  );

  let inRange = 0;
  let early = 0;
  let overshoot = 0;
  for (const t of both) {
    const exit = t.exit_mc_estimate!;
    if (exit < t.target_low_mc!) early++;
    else if (exit > t.target_high_mc!) overshoot++;
    else inRange++;
  }
  const needsReview = trades.filter((t) => t.needs_review).length;

  // Padre/MockApe-derived actuals (when mockape.json was joined)
  const matched = trades.filter((t) => t.mockape_trade_id != null);
  const pnlTotalSol = matched.reduce((sum, t) => sum + (t.pnl_sol ?? 0), 0);
  const wins = matched.filter((t) => (t.pnl_sol ?? 0) > 0);
  const losses = matched.filter((t) => (t.pnl_sol ?? 0) < 0);
  const breakeven = matched.filter((t) => (t.pnl_sol ?? 0) === 0);
  const winRate = matched.length === 0 ? 0 : wins.length / matched.length;
  const actualInRange = matched.filter((t) => t.exit_scenario === 'in_range').length;
  const actualEarly = matched.filter((t) => t.exit_scenario === 'early').length;
  const actualOvershoot = matched.filter((t) => t.exit_scenario === 'overshoot').length;

  const pct = (n: number, d: number): string => (d === 0 ? '-' : `${Math.round((n / d) * 100)}%`);

  const lines: string[] = [];
  lines.push('# Adherence Report');
  lines.push('');
  lines.push(`Generated by Snipalot Trade-mode - ${new Date().toLocaleString()}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Total trades:** ${total}`);
  lines.push(`- **Pre-trade callouts with target range:** ${withTarget.length} (${pct(withTarget.length, total)})`);
  lines.push(`- **Post-trade callouts with exit estimate:** ${withExit.length} (${pct(withExit.length, total)})`);
  lines.push(`- **Trades with both pre + post:** ${both.length} (${pct(both.length, total)})`);
  lines.push(`- **Flagged for review:** ${needsReview} (${pct(needsReview, total)})`);
  lines.push('');
  lines.push('## Exit-vs-target (pre + post available)');
  lines.push('');
  if (both.length === 0) {
    lines.push('_No trades had both a target range and an exit estimate to compare._');
  } else {
    lines.push(`- **In range:** ${inRange} (${pct(inRange, both.length)})`);
    lines.push(`- **Early exit (below low target):** ${early} (${pct(early, both.length)})`);
    lines.push(`- **Overshoot (above high target):** ${overshoot} (${pct(overshoot, both.length)})`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- "In range" (above) uses the trader\'s spoken exit_mc_estimate vs spoken targets. Padre actuals (below) use the real exit price.');
  lines.push('');

  // â”€â”€ Padre / MockApe actuals (only present when mockape.json was joined) â”€â”€
  if (matched.length > 0) {
    lines.push('## Padre / MockApe actuals');
    lines.push('');
    lines.push(`- **Trades matched to MockApe export:** ${matched.length} of ${total} (${pct(matched.length, total)})`);
    lines.push(`- **Total P&L:** ${pnlTotalSol >= 0 ? '+' : ''}${pnlTotalSol.toFixed(4)} SOL`);
    lines.push(`- **Wins / losses / breakeven:** ${wins.length} / ${losses.length} / ${breakeven.length}`);
    lines.push(`- **Win rate:** ${(winRate * 100).toFixed(1)}%`);
    lines.push('');
    lines.push('### Actual exit vs spoken target');
    lines.push('');
    if (matched.filter((t) => t.exit_scenario != null).length === 0) {
      lines.push('_None of the matched trades had both target bounds + an actual exit to compare._');
    } else {
      const actualScored = matched.filter((t) => t.exit_scenario != null);
      lines.push(`- **In range:** ${actualInRange} (${pct(actualInRange, actualScored.length)})`);
      lines.push(`- **Early (sold below low target):** ${actualEarly} (${pct(actualEarly, actualScored.length)})`);
      lines.push(`- **Overshoot (rode past high target):** ${actualOvershoot} (${pct(actualOvershoot, actualScored.length)})`);
    }
    lines.push('');
  } else {
    lines.push('## Padre / MockApe actuals');
    lines.push('');
    lines.push('_No `mockape.json` found in this session folder, or no trades matched. Drop your MockApe export here as `mockape.json` and re-run extraction to get actual entry/exit market caps + P&L per trade._');
    lines.push('');
  }

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  log('trade-pipeline', 'adherence_report.md written', { reportPath });
  return reportPath;
}

/** Format market cap for human display ("80.0k", "1.20m", "500"). */
function formatMc(mc: number): string {
  if (mc >= 1_000_000) return `${(mc / 1_000_000).toFixed(2)}m`;
  if (mc >= 1_000) return `${(mc / 1_000).toFixed(1)}k`;
  return mc.toString();
}

// â”€â”€â”€ MockApe / Padre outcome join â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * If the user dropped a mockape.json into the session folder, parse it
 * as MockApeTrade[] and return. Returns null if the file isn't there or
 * fails to parse â€” joining is optional, the trade log just lacks the
 * actual P&L columns when no MockApe data is available.
 */
function loadMockApeTrades(sessionDir: string): MockApeTrade[] | null {
  const mockApePath = getTradeInputPath(sessionDir, 'mockape.json');
  const legacyMockApePath = path.join(sessionDir, 'mockape.json');
  const actualPath = fs.existsSync(mockApePath) ? mockApePath : legacyMockApePath;
  if (!fs.existsSync(actualPath)) return null;
  try {
    const raw = fs.readFileSync(actualPath, 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      log('trade-pipeline', 'mockape.json not an array, skipping join');
      return null;
    }
    // Best-effort schema validation; skip entries missing required fields.
    const trades: MockApeTrade[] = [];
    for (const e of arr) {
      if (
        typeof e?.tokenName === 'string' &&
        typeof e?.timestamp === 'number' &&
        typeof e?.entryMarketCap === 'number' &&
        typeof e?.exitMarketCap === 'number'
      ) {
        trades.push({
          chain: typeof e.chain === 'string' ? e.chain : '',
          entryMarketCap: e.entryMarketCap,
          exitMarketCap: e.exitMarketCap,
          id: typeof e.id === 'string' ? e.id : '',
          platform: typeof e.platform === 'string' ? e.platform : '',
          pnlPercentage: typeof e.pnlPercentage === 'number' ? e.pnlPercentage : 0,
          pnlSol: typeof e.pnlSol === 'number' ? e.pnlSol : 0,
          solInvested: typeof e.solInvested === 'number' ? e.solInvested : 0,
          solReceived: typeof e.solReceived === 'number' ? e.solReceived : 0,
          timestamp: e.timestamp,
          tokenName: e.tokenName,
        });
      }
    }
    log('trade-pipeline', 'mockape.json loaded', { entries: trades.length, mockApePath: actualPath });
    return trades;
  } catch (err) {
    log('trade-pipeline', 'mockape.json parse fail', { err: (err as Error).message });
    return null;
  }
}

/**
 * Loose token-name match: case-insensitive, alphanumerics-only. Tolerates
 * whisper mishears like "peep" â†’ "pepe" by checking if either string is
 * a prefix of the other (after normalization). Returns true on match.
 */
function tokenNameMatches(spoken: string, mockape: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = norm(spoken);
  const b = norm(mockape);
  if (!a || !b) return false;
  if (a === b) return true;
  // Prefix-tolerance for whisper truncations (e.g. "guy" matches "guytoken")
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * ID-based join: when the LLM has populated mockape_trade_id on a trade,
 * look up the matching MockApe entry by ID and copy PnL fields.
 * Cleaner than fuzzy matching since the LLM already did the alignment
 * with full context. Returns counts of matched + unmatched (no ID).
 */
function joinMockApeById(
  trades: TradeEvent[],
  mockape: MockApeTrade[]
): { matched: number; unmatched: number } {
  const byId = new Map(mockape.map((m) => [m.id, m]));
  let matched = 0;
  let unmatched = 0;
  const groups = new Map<string, TradeEvent[]>();
  for (const trade of trades) {
    if (!trade.mockape_trade_id) {
      unmatched++;
      continue;
    }
    const bucket = groups.get(trade.mockape_trade_id) ?? [];
    bucket.push(trade);
    groups.set(trade.mockape_trade_id, bucket);
  }
  for (const [tradeId, group] of groups.entries()) {
    const m = byId.get(tradeId);
    if (!m) {
      unmatched += group.length;
      continue;
    }
    if (group.length === 1) {
      enrichTradeFromMockape(group[0], m, 'high');
      matched++;
      continue;
    }
    const normalizedShares = normalizeTradeShares(group);
    for (let i = 0; i < group.length; i++) {
      enrichTradeFromMockape(group[i], m, 'high', normalizedShares[i]);
      matched++;
    }
  }
  return { matched, unmatched };
}

/** Apply MockApe PnL fields to a TradeEvent. Shared by id + fuzzy joins. */
function enrichTradeFromMockape(
  trade: TradeEvent,
  m: MockApeTrade,
  confidence: 'high' | 'medium' | 'low',
  share: number = 1
): void {
  trade.mockape_trade_id = m.id;
  trade.mockape_join_confidence = confidence;
  trade.mockape_timestamp_ms = m.timestamp;
  trade.entry_mc_actual = m.entryMarketCap;
  trade.exit_mc_actual = m.exitMarketCap;
  trade.sol_invested = roundTo(m.solInvested * share, 6);
  trade.sol_received = roundTo(m.solReceived * share, 6);
  trade.pnl_sol = roundTo(m.pnlSol * share, 6);
  trade.pnl_percentage = m.pnlPercentage;
  if (trade.target_low_mc !== null && trade.target_high_mc !== null) {
    const exit = m.exitMarketCap;
    trade.target_hit_low = exit >= trade.target_low_mc;
    trade.target_hit_high = exit >= trade.target_high_mc;
    trade.exit_scenario =
      exit < trade.target_low_mc ? 'early' :
      exit > trade.target_high_mc ? 'overshoot' :
      'in_range';
  }
}

function normalizeTradeShares(trades: TradeEvent[]): number[] {
  const positiveFractions: Array<number | null> = trades.map((t) =>
    typeof t.position_fraction === 'number' && t.position_fraction > 0 ? t.position_fraction : null
  );
  const fractionTotal = positiveFractions.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  if (fractionTotal > 0) {
    return positiveFractions.map((v) => (v ?? 0) / fractionTotal);
  }
  return trades.map(() => 1 / trades.length);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * For each TradeEvent, find the closest matching MockApe trade by token
 * name + timestamp proximity, and enrich the event with actual entry/exit
 * market caps + P&L. Match confidence depends on token exactness and
 * timestamp closeness.
 *
 * The match window is Â±10 minutes from the post_call moment (or pre_call
 * if post is missing). MockApe trades match at most one TradeEvent â€” once
 * matched, removed from the candidate pool so a single mockape entry isn't
 * double-counted.
 */
function joinMockApe(
  trades: TradeEvent[],
  mockape: MockApeTrade[],
  recordingStartedAtMs: number
): { matched: number; unmatched: number } {
  const matchWindowMs = 10 * 60 * 1000; // Â±10 minutes
  const remaining = [...mockape];
  let matched = 0;
  let unmatched = 0;

  for (const trade of trades) {
    // Anchor: prefer post_call (closer to actual exit time), fall back to pre_call.
    const offsetMs = trade.post_call_offset_ms ?? trade.pre_call_offset_ms;
    if (offsetMs === null) {
      unmatched++;
      continue;
    }
    const tradeAbsMs = recordingStartedAtMs + offsetMs;

    // Find the closest mockape entry with a matching token name.
    let bestIdx = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    let bestExactToken = false;
    for (let i = 0; i < remaining.length; i++) {
      const m = remaining[i];
      if (!tokenNameMatches(trade.token_name, m.tokenName)) continue;
      const delta = Math.abs(m.timestamp - tradeAbsMs);
      // Prefer exact-token matches even at slightly larger time deltas.
      const exact = m.tokenName.toLowerCase() === trade.token_name.toLowerCase();
      if (
        (exact && !bestExactToken) ||
        ((exact === bestExactToken) && delta < bestDelta)
      ) {
        bestIdx = i;
        bestDelta = delta;
        bestExactToken = exact;
      }
    }

    if (bestIdx === -1 || bestDelta > matchWindowMs) {
      // No match within window. Leave fields null + flag for review.
      trade.mockape_join_confidence = null;
      trade.needs_review = trade.needs_review || true;
      trade.notes = (trade.notes ? trade.notes + ' Â· ' : '') +
        'No matching MockApe trade within Â±10min window';
      unmatched++;
      continue;
    }

    const m = remaining[bestIdx];
    remaining.splice(bestIdx, 1); // consume
    const conf: 'high' | 'medium' | 'low' =
      bestExactToken && bestDelta < 120_000 ? 'high' :
      bestExactToken ? 'medium' :
      'low';
    enrichTradeFromMockape(trade, m, conf);
    matched++;
  }

  log('trade-pipeline', 'mockape join complete', {
    matched,
    unmatched,
    leftoverMockape: remaining.length,
  });
  return { matched, unmatched };
}
