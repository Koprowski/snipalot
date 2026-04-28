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
import { clipboard, Notification, shell } from 'electron';
import { stringify as csvStringify } from 'csv-stringify/sync';
import { log } from './logger';
import { TranscriptSegment } from './pipeline';

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
  // ── Optional Padre/MockApe outcome fields (filled by joinMockApe) ──
  /** Matched MockApe trade id for traceability. */
  mockape_trade_id?: string | null;
  /** Confidence of the mockape join: 'high' = exact token + tight time match,
   *  'medium' = token match but loose time, 'low' = fuzzy token. */
  mockape_join_confidence?: 'high' | 'medium' | 'low' | null;
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
}

export interface TradePipelineInput {
  /** Session directory where outputs land. */
  sessionDir: string;
  /** Path to the finalized mp4 (for legend frame extraction in M5). */
  mp4Path: string;
  /** Whisper-parsed transcript segments (already produced by runPipeline). */
  transcriptSegments: TranscriptSegment[];
  /** User-pressed trade marker offsets, ms relative to recording start. */
  tradeMarkers: number[];
  /**
   * Recording start time (Date.now()-style ms epoch). Combined with
   * pre/post call offsets, lets the MockApe join convert recording-
   * relative timestamps into absolute clock times for matching against
   * the MockApe export's unix-epoch timestamp field.
   */
  startedAtMs: number;
  /** Step callback for launcher UI (mirrors PipelineInput.onStep). */
  onStep?: (step: string) => void;
}

/**
 * Schema for the MockApe / Padre trade export. The user pastes their
 * exported JSON into mockape.json in the session folder; the trade-
 * pipeline parses, joins by tokenName + timestamp, and enriches the
 * trade_log.csv with actual entry/exit market caps + P&L.
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
  /** Unix epoch ms — matches Date.now() output. */
  timestamp: number;
  tokenName: string;
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

  // ── Wait for the trade-context window to close (user submits MockApe
  //    data or clicks Skip). Main opens the window in stopRecording
  //    so it's already up and parallel to whisper / mp4 / gif work.
  //    If autoPromptForTradeData is off, main writes the .skipped
  //    sentinel directly — wait returns immediately. ──
  if (onStep) onStep('Waiting for trade-context decision…');
  await waitForTradeContextDecision(sessionDir);

  // Load the MockApe data NOW (before rendering the prompt) so the
  // prompt template can embed it as canonical trade context.
  const mockape = loadMockApeTrades(sessionDir);
  if (mockape) {
    log('trade-pipeline', 'mockape data loaded for prompt embed', { trades: mockape.length });
  }

  // ── M4: write the extraction prompt + wait for the user's LLM response ──
  if (onStep) onStep('Writing trade extraction prompt…');
  const promptText = renderExtractionPrompt(
    transcriptSegments,
    tradeMarkers,
    mockape,
    input.startedAtMs
  );
  const { promptPath, responsePath } = writeExtractionPrompt(sessionDir, promptText);

  if (onStep) onStep('Waiting for extraction_response.json (paste prompt into your LLM)…');
  const trades = await waitForExtractionResponse(responsePath);

  if (!trades) {
    warnings.push(
      'extraction_response.json did not appear within 60 minutes; trade log not generated. ' +
        'Drop the file in the session folder later and re-trigger via "Process Trade Session" (CLI command coming).'
    );
    return {
      extractionPromptPath: promptPath,
      extractionResponsePath: null,
      tradeLogCsvPath: null,
      tradeLogMdPath: null,
      adherenceReportPath: null,
      warnings,
    };
  }

  // ── MockApe / Padre outcome enrichment ──
  // mockape was already loaded earlier (before prompt render). The LLM
  // received it in the prompt and (ideally) populated mockape_trade_id
  // for matched trades — joinMockApeById just looks up by ID and copies
  // PnL fields. If the LLM missed the assignment, fall back to fuzzy
  // tokenName + timestamp matching for unjoined trades.
  let mockApeJoinStats = { matched: 0, unmatched: 0 };
  if (mockape) {
    if (onStep) onStep('Joining MockApe outcomes by id…');
    mockApeJoinStats = joinMockApeById(trades, mockape);
    // Any trades the LLM didn't tag get a fallback fuzzy attempt.
    const unjoined = trades.filter((t) => !t.mockape_trade_id);
    if (unjoined.length > 0) {
      const fuzzy = joinMockApe(unjoined, mockape, input.startedAtMs);
      mockApeJoinStats.matched += fuzzy.matched;
      log('trade-pipeline', 'mockape fuzzy fallback applied', fuzzy);
    }
    log('trade-pipeline', 'mockape join total', mockApeJoinStats);
  } else {
    log('trade-pipeline', 'no mockape.json — actual P&L columns will be blank');
  }

  // ── M5: generate trade_log.csv + trade_log.md + adherence_report.md ──
  if (onStep) onStep('Generating trade log + adherence report…');
  let csvPath: string | null = null;
  let mdPath: string | null = null;
  let reportPath: string | null = null;
  try {
    csvPath = writeTradeLogCsv(sessionDir, trades);
    mdPath = writeTradeLogMd(sessionDir, trades);
    reportPath = writeAdherenceReport(sessionDir, trades);
  } catch (err) {
    warnings.push(`trade output generators failed: ${(err as Error).message}`);
    log('trade-pipeline', 'output gen fail', { err: String(err) });
  }

  log('trade-pipeline', 'session complete', {
    trades: trades.length,
    csvPath,
    mdPath,
    reportPath,
  });
  if (Notification.isSupported()) {
    new Notification({
      title: 'Snipalot Trade · log ready',
      body: `${trades.length} trade${trades.length === 1 ? '' : 's'} logged. trade_log.csv + .md in:\n${sessionDir}`,
      silent: false,
    }).show();
  }

  return {
    extractionPromptPath: promptPath,
    extractionResponsePath: responsePath,
    tradeLogCsvPath: csvPath,
    tradeLogMdPath: mdPath,
    adherenceReportPath: reportPath,
    warnings,
  };
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
 * inserted at the offsets the user pressed Ctrl+Shift+T. The model uses
 * markers as focal points but isn't required to find one trade per marker
 * — content alone is enough.
 */
/**
 * Wait until either mockape.json or mockape.json.skipped exists in the
 * session folder. The trade-context window writes one of these when the
 * user clicks Continue/Skip, OR main writes the .skipped sentinel
 * directly when autoPromptForTradeData is off. Polls every 1s; max wait
 * 30 minutes (defensive against the user closing the window without any
 * action — closed-window-handler in main also writes the sentinel, but
 * we time out as a final safety net).
 */
async function waitForTradeContextDecision(
  sessionDir: string,
  timeoutMs: number = 30 * 60 * 1000
): Promise<void> {
  const dataPath = path.join(sessionDir, 'mockape.json');
  const skipPath = path.join(sessionDir, 'mockape.json.skipped');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(dataPath) || fs.existsSync(skipPath)) {
      log('trade-pipeline', 'trade-context decision detected', {
        hasData: fs.existsSync(dataPath),
        skipped: fs.existsSync(skipPath),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  log('trade-pipeline', 'trade-context wait timed out — proceeding without trade data');
}

function renderExtractionPrompt(
  transcriptSegments: TranscriptSegment[],
  tradeMarkers: number[],
  mockape: MockApeTrade[] | null,
  recordingStartedAtMs: number
): string {
  // Build the annotated transcript: a stable line-per-segment dump with
  // marker tags spliced in at the closest segment boundary.
  const sortedMarkers = [...tradeMarkers].sort((a, b) => a - b);
  let nextMarkerIdx = 0;
  const annotatedLines: string[] = [];
  for (const seg of transcriptSegments) {
    while (
      nextMarkerIdx < sortedMarkers.length &&
      sortedMarkers[nextMarkerIdx] <= seg.startSec * 1000
    ) {
      annotatedLines.push(
        `[MARKER ${nextMarkerIdx + 1} at ${formatOffset(sortedMarkers[nextMarkerIdx])}]`
      );
      nextMarkerIdx++;
    }
    annotatedLines.push(seg.text);
  }
  while (nextMarkerIdx < sortedMarkers.length) {
    annotatedLines.push(
      `[MARKER ${nextMarkerIdx + 1} at ${formatOffset(sortedMarkers[nextMarkerIdx])}]`
    );
    nextMarkerIdx++;
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
        `${i + 1}. **${t.tokenName}** · entry $${formatMcInline(t.entryMarketCap)} → exit $${formatMcInline(t.exitMarketCap)} · ${pnlSign}${t.pnlSol.toFixed(4)} SOL (${pnlSign}${t.pnlPercentage.toFixed(2)}%) · fired at **${offsetLabel}** in session · trade_id=${t.id}`
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

## Transcript

The transcript below is a chronological narration with optional
[MARKER N at M:SS] tags indicating moments the trader explicitly
flagged as significant by pressing a hotkey.

\`\`\`
${annotatedLines.join('\n')}
\`\`\`

## Task

${hasMockape ? `For EACH actual trade in the MockApe list above, find the matching
spoken context in the transcript:
- The trader's commentary RIGHT BEFORE the trade's "fired at" timestamp
  is the **pre-trade callout** (target market cap range, rationale).
- The trader's commentary RIGHT AFTER the trade's "fired at" timestamp
  is the **post-trade callout** (outcome, adherence assessment).
- If the trader mentions a coin in the transcript but it has no matching
  MockApe trade (musing only — no actual entry), include it as an
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
\`<PLACEHOLDER>\` markers — your actual output must replace each
placeholder with the real value from the MockApe list and transcript
above. The placeholder names are NOT example data; do NOT include
them verbatim in your output.

Use null for any field the transcript / data genuinely doesn't speak to.

[
  {
    "trade_id": <SEQUENTIAL_INT_STARTING_AT_1>,
    "token_name": "<TOKEN_NAME_FROM_MOCKAPE_LIST_ABOVE>",
    "mockape_trade_id": ${hasMockape ? '"<EXACT_TRADE_ID_FROM_MOCKAPE_LIST_ABOVE>"' : 'null'},
    "pre_call_offset_label": "<M:SS_OF_PRE_CALLOUT_OR_NULL>",
    "pre_call_offset_ms": <SAME_AS_LABEL_IN_MS_OR_NULL>,
    "post_call_offset_label": "<M:SS_OF_POST_CALLOUT_OR_NULL>",
    "post_call_offset_ms": <SAME_AS_LABEL_IN_MS_OR_NULL>,
    "target_low_mc": <SPOKEN_TARGET_LOW_INT_OR_NULL>,
    "target_high_mc": <SPOKEN_TARGET_HIGH_INT_OR_NULL>,
    "rationale": "<TRADER_S_OWN_WORDS_FOR_WHY_OR_NULL>",
    "pre_transcript_excerpt": "<NEAR_VERBATIM_PRE_QUOTE_OR_NULL>",
    "post_transcript_excerpt": "<NEAR_VERBATIM_POST_QUOTE_OR_NULL>",
    "exit_mc_estimate": <SPOKEN_EXIT_MC_INT_OR_NULL>,
    "outcome_summary": "<TRADER_S_OWN_WORDS_FOR_OUTCOME_OR_NULL>",
    "adherence_self_assessment": "<TRADER_S_OWN_WORDS_ON_PLAN_ADHERENCE_OR_NULL>",
    "pre_confidence": "<low|medium|high|null>",
    "post_confidence": "<low|medium|high|null>",
    "needs_review": <true_OR_false>,
    "notes": "<ANY_RELEVANT_FLAG_OR_NULL>"
  }
]

Rules:
- Market cap values are integers in dollars ("80k" → 80000, "1.2m" → 1200000).
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
  target_high_mc, exit_mc_estimate must come DIRECTLY from words the
  trader said in the transcript. Quote-paraphrase only.
- DO NOT invent rationale ("strong fundamentals", "bullish setup",
  "good entry") if the trader didn't say something equivalent. If the
  trader only said "this looks fun" or "let's see what happens", the
  rationale is "this looks fun" — not a synthesized investment thesis.
- DO NOT infer target market caps from the actual entry/exit prices.
  Targets must come from the trader's spoken prediction. If they only
  said "I'm going to double this", target_high_mc = entry × 2 IS a
  defensible inference (double is a clear quantitative claim). If they
  said nothing about a target, target_low_mc and target_high_mc are null.
- pre_transcript_excerpt and post_transcript_excerpt must be VERBATIM
  quotes from the transcript (or near-verbatim with [...] for elision).
  These are evidence — the trader will read them to verify your
  extraction is honest.
- If a field would require speculation, set it to null. A null is more
  useful than a fabricated value because the trader can see what wasn't
  captured and decide whether to re-record more clearly next time.
- needs_review=true on any trade where you had to guess at any
  non-trivial field. Better to flag than to silently fabricate.

**PARTIAL EXITS:**
- Mock Ape's export sometimes shows ONE entry/exit pair per trade even
  if the trader scaled out in pieces. The transcript may mention
  "selling half now" then later "all out" — both refer to the same
  underlying trade_id. Treat partial-exit commentary as part of the
  SAME trade, not separate trades. post_transcript_excerpt should
  combine the partial-exit statements ("selling half now [...] all
  out at 4k") so the trader's full exit narrative is preserved.

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
 * Write extraction_prompt.md to the session folder + put the prompt text
 * on the clipboard so the user can paste it directly into their LLM
 * without opening the file. Notification surfaces the next step.
 */
function writeExtractionPrompt(
  sessionDir: string,
  promptText: string
): { promptPath: string; responsePath: string } {
  const promptPath = path.join(sessionDir, 'extraction_prompt.md');
  const responsePath = path.join(sessionDir, 'extraction_response.json');
  fs.writeFileSync(promptPath, promptText, 'utf-8');
  clipboard.writeText(promptText);

  // Drop a clear NEXT_STEPS.md into the folder so anyone browsing it
  // can immediately see the manual-paste workflow without reading a
  // notification or hunting through the codebase.
  const nextStepsPath = path.join(sessionDir, 'NEXT_STEPS.md');
  const nextSteps = `# Next steps for this Trade session

Snipalot has finished recording, transcribing, and packaging your session.
Now it needs YOU to do two things, then it'll automatically generate the
final \`trade_log.csv\` + \`trade_log.md\` + \`adherence_report.md\`.

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
into this folder as \`extraction_response.json\`** (exact filename).

If the file is missing or you forgot to copy the prompt: open
\`extraction_prompt.md\` in this folder — the same prompt is there.

## 2. (Optional but recommended) Drop your MockApe trade export

If you exported trades from MockApe / Padre, save the JSON array into
this folder as \`mockape.json\` (exact filename). Snipalot will:
- Match each spoken trade to its actual MockApe entry by token name +
  timestamp
- Add real entry/exit market caps, P&L SOL, P&L %, win/loss columns
  to \`trade_log.csv\`
- Surface aggregate P&L stats in \`adherence_report.md\`

If you skip this, the trade log still ships — just without the actual
P&L columns.

## 3. Wait

Snipalot is polling this folder every 2 seconds. As soon as
\`extraction_response.json\` shows up and validates, it generates:
- \`trade_log.csv\` — analysis-ready, one row per trade
- \`trade_log.md\` — human-readable per-trade view
- \`adherence_report.md\` — aggregate stats

The polling timeout is 60 minutes from the moment the recording stopped.

## Files in this folder right now

- \`recording.mp4\` — the raw recording (lives in the parent folder)
- \`transcript.txt\` — whisper-generated transcript
- \`markers.json\` — your Ctrl+Shift+M marker timestamps
- \`extraction_prompt.md\` — paste-ready LLM prompt (also on clipboard)
- \`NEXT_STEPS.md\` — this file
- _(after you save extraction_response.json:)_
  - \`extraction_response.json\` — your LLM's JSON answer
  - \`mockape.json\` — your Padre export (optional)
  - \`trade_log.csv\`, \`trade_log.md\`, \`adherence_report.md\` — the deliverables
`;
  fs.writeFileSync(nextStepsPath, nextSteps, 'utf-8');

  log('trade-pipeline', 'extraction prompt + NEXT_STEPS written + clipboarded', {
    promptPath,
    nextStepsPath,
    chars: promptText.length,
  });

  // Open the session folder in Explorer so the user actually sees the
  // files and the workflow is impossible to miss.
  void shell.openPath(sessionDir);

  if (Notification.isSupported()) {
    new Notification({
      title: 'Snipalot Trade · prompt ready (on clipboard)',
      body:
        `Step 1: paste the prompt into Claude Code / Gemini / Cursor.\n` +
        `Step 2: save the LLM's JSON reply as extraction_response.json ` +
        `in the folder that just opened.\n` +
        `Step 3 (optional): drop your MockApe export as mockape.json.\n\n` +
        `Read NEXT_STEPS.md in the session folder for full instructions.`,
      silent: false,
    }).show();
  }
  return { promptPath, responsePath };
}

/**
 * Poll for extraction_response.json in the session folder. Resolves with
 * the parsed TradeEvent[] when the file appears and validates, or null if
 * the timeout (default 60 minutes) elapses first. fs.watch is unreliable
 * cross-platform, so we poll every 2s — overhead is negligible.
 */
async function waitForExtractionResponse(
  responsePath: string,
  timeoutMs: number = 60 * 60 * 1000
): Promise<TradeEvent[] | null> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 2000;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const raw = fs.readFileSync(responsePath, 'utf-8');
        const parsed = parseAndValidateResponse(raw);
        log('trade-pipeline', 'extraction_response.json parsed', { trades: parsed.length });
        return parsed;
      } catch (err) {
        log('trade-pipeline', 'extraction_response.json parse error', {
          err: (err as Error).message,
        });
        if (Notification.isSupported()) {
          new Notification({
            title: 'Snipalot Trade · response invalid',
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
  log('trade-pipeline', 'extraction_response.json timeout', { responsePath });
  return null;
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
      // LLM-provided alignment to the MockApe canonical trade list.
      // When present, joinMockApeById short-circuits the fuzzy matcher
      // and just enriches with PnL from the matching trade.
      mockape_trade_id: strOrNull(e.mockape_trade_id),
    };
  });
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function confOrNull(v: unknown): 'low' | 'medium' | 'high' | null {
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return null;
}

// ─── M5: trade_log.csv + trade_log.md + adherence_report.md ──────────

/**
 * Write trade_log.csv to the session folder. Column order matches the
 * PRD schema. Pre/post fields are emitted as separate columns; null
 * becomes empty string for clean Excel parsing.
 */
function writeTradeLogCsv(sessionDir: string, trades: TradeEvent[]): string {
  const csvPath = path.join(sessionDir, 'trade_log.csv');
  const rows = trades.map((t) => {
    const targetMid =
      t.target_low_mc !== null && t.target_high_mc !== null
        ? Math.round((t.target_low_mc + t.target_high_mc) / 2)
        : '';
    const timeInTradeSec =
      t.pre_call_offset_ms !== null && t.post_call_offset_ms !== null
        ? Math.round((t.post_call_offset_ms - t.pre_call_offset_ms) / 1000)
        : '';
    return {
      trade_id: t.trade_id,
      token_name: t.token_name,
      pre_call_timestamp: t.pre_call_offset_label ?? '',
      post_call_timestamp: t.post_call_offset_label ?? '',
      target_low_mc: t.target_low_mc ?? '',
      target_high_mc: t.target_high_mc ?? '',
      target_midpoint_mc: targetMid,
      rationale: t.rationale ?? '',
      pre_transcript_excerpt: t.pre_transcript_excerpt ?? '',
      post_transcript_excerpt: t.post_transcript_excerpt ?? '',
      exit_mc_estimate: t.exit_mc_estimate ?? '',
      outcome_summary: t.outcome_summary ?? '',
      adherence_self_assessment: t.adherence_self_assessment ?? '',
      time_in_trade_seconds: timeInTradeSec,
      // Filled from mockape.json join when present (else blank)
      entry_mc_actual: t.entry_mc_actual ?? '',
      exit_mc_actual: t.exit_mc_actual ?? '',
      sol_invested: t.sol_invested ?? '',
      sol_received: t.sol_received ?? '',
      pnl_sol: t.pnl_sol ?? '',
      pnl_percentage: t.pnl_percentage ?? '',
      target_hit_low: t.target_hit_low === null || t.target_hit_low === undefined ? '' : (t.target_hit_low ? 'true' : 'false'),
      target_hit_high: t.target_hit_high === null || t.target_hit_high === undefined ? '' : (t.target_hit_high ? 'true' : 'false'),
      exit_scenario: t.exit_scenario ?? '',
      mockape_trade_id: t.mockape_trade_id ?? '',
      mockape_join_confidence: t.mockape_join_confidence ?? '',
      // Extraction quality
      pre_extraction_confidence: t.pre_confidence ?? '',
      post_extraction_confidence: t.post_confidence ?? '',
      needs_review: t.needs_review ? 'true' : 'false',
      notes: t.notes ?? '',
    };
  });
  const csv = csvStringify(rows, { header: true });
  fs.writeFileSync(csvPath, csv, 'utf-8');
  log('trade-pipeline', 'trade_log.csv written', { csvPath, rows: rows.length });
  return csvPath;
}

/**
 * Write trade_log.md — human-readable view of the same data, one section
 * per trade with the key fields formatted for easy review.
 */
function writeTradeLogMd(sessionDir: string, trades: TradeEvent[]): string {
  const mdPath = path.join(sessionDir, 'trade_log.md');
  const lines: string[] = [];
  lines.push('# Trade Log');
  lines.push('');
  lines.push(`Generated by Snipalot Trade-mode · ${new Date().toLocaleString()}`);
  lines.push(`Total trades: ${trades.length}`);
  lines.push('');
  if (trades.length === 0) {
    lines.push('_No trades extracted from this session._');
  }
  for (const t of trades) {
    const targetRange =
      t.target_low_mc !== null && t.target_high_mc !== null
        ? `$${formatMc(t.target_low_mc)} – $${formatMc(t.target_high_mc)}`
        : '_(no target)_';
    const exit = t.exit_mc_estimate !== null ? `$${formatMc(t.exit_mc_estimate)}` : '_(no exit)_';
    const flag = t.needs_review ? ' ⚠️ needs review' : '';
    lines.push('---');
    lines.push('');
    lines.push(`## #${t.trade_id} · ${t.token_name}${flag}`);
    lines.push('');
    lines.push(`- **Pre-call:** ${t.pre_call_offset_label ?? '_(unknown)_'} · target ${targetRange}`);
    lines.push(`- **Post-call:** ${t.post_call_offset_label ?? '_(unknown)_'} · spoken exit ${exit}`);
    // MockApe / Padre actuals (only present if mockape.json was joined)
    if (t.entry_mc_actual !== null && t.entry_mc_actual !== undefined) {
      const pnlSol = t.pnl_sol !== null && t.pnl_sol !== undefined ? t.pnl_sol : 0;
      const pnlPct = t.pnl_percentage !== null && t.pnl_percentage !== undefined ? t.pnl_percentage : 0;
      const pnlSign = pnlSol >= 0 ? '+' : '';
      const pnlEmoji = pnlSol > 0 ? '🟢' : pnlSol < 0 ? '🔴' : '⚪';
      lines.push(
        `- **Padre actuals:** entry $${formatMc(t.entry_mc_actual!)} → exit $${formatMc(t.exit_mc_actual ?? 0)} · ${pnlEmoji} ${pnlSign}${pnlSol.toFixed(4)} SOL (${pnlSign}${pnlPct.toFixed(2)}%)`
      );
      if (t.exit_scenario) {
        lines.push(`- **Exit vs target:** ${t.exit_scenario}${t.target_hit_low ? ' · hit low' : ''}${t.target_hit_high ? ' · hit high' : ''}`);
      }
      if (t.mockape_join_confidence) {
        lines.push(`- **Padre match confidence:** ${t.mockape_join_confidence}`);
      }
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
    lines.push('');
  }
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf-8');
  log('trade-pipeline', 'trade_log.md written', { mdPath });
  return mdPath;
}

/**
 * Write adherence_report.md — aggregate stats across all trades. PnL
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

  const pct = (n: number, d: number): string => (d === 0 ? '–' : `${Math.round((n / d) * 100)}%`);

  const lines: string[] = [];
  lines.push('# Adherence Report');
  lines.push('');
  lines.push(`Generated by Snipalot Trade-mode · ${new Date().toLocaleString()}`);
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

  // ── Padre / MockApe actuals (only present when mockape.json was joined) ──
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

// ─── MockApe / Padre outcome join ─────────────────────────────────────

/**
 * If the user dropped a mockape.json into the session folder, parse it
 * as MockApeTrade[] and return. Returns null if the file isn't there or
 * fails to parse — joining is optional, the trade log just lacks the
 * actual P&L columns when no MockApe data is available.
 */
function loadMockApeTrades(sessionDir: string): MockApeTrade[] | null {
  const mockApePath = path.join(sessionDir, 'mockape.json');
  if (!fs.existsSync(mockApePath)) return null;
  try {
    const raw = fs.readFileSync(mockApePath, 'utf-8');
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
    log('trade-pipeline', 'mockape.json loaded', { entries: trades.length });
    return trades;
  } catch (err) {
    log('trade-pipeline', 'mockape.json parse fail', { err: (err as Error).message });
    return null;
  }
}

/**
 * Loose token-name match: case-insensitive, alphanumerics-only. Tolerates
 * whisper mishears like "peep" → "pepe" by checking if either string is
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
  for (const trade of trades) {
    if (!trade.mockape_trade_id) {
      unmatched++;
      continue;
    }
    const m = byId.get(trade.mockape_trade_id);
    if (!m) {
      unmatched++;
      continue;
    }
    enrichTradeFromMockape(trade, m, 'high');
    matched++;
  }
  return { matched, unmatched };
}

/** Apply MockApe PnL fields to a TradeEvent. Shared by id + fuzzy joins. */
function enrichTradeFromMockape(
  trade: TradeEvent,
  m: MockApeTrade,
  confidence: 'high' | 'medium' | 'low'
): void {
  trade.mockape_trade_id = m.id;
  trade.mockape_join_confidence = confidence;
  trade.entry_mc_actual = m.entryMarketCap;
  trade.exit_mc_actual = m.exitMarketCap;
  trade.sol_invested = m.solInvested;
  trade.sol_received = m.solReceived;
  trade.pnl_sol = m.pnlSol;
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

/**
 * For each TradeEvent, find the closest matching MockApe trade by token
 * name + timestamp proximity, and enrich the event with actual entry/exit
 * market caps + P&L. Match confidence depends on token exactness and
 * timestamp closeness.
 *
 * The match window is ±10 minutes from the post_call moment (or pre_call
 * if post is missing). MockApe trades match at most one TradeEvent — once
 * matched, removed from the candidate pool so a single mockape entry isn't
 * double-counted.
 */
function joinMockApe(
  trades: TradeEvent[],
  mockape: MockApeTrade[],
  recordingStartedAtMs: number
): { matched: number; unmatched: number } {
  const matchWindowMs = 10 * 60 * 1000; // ±10 minutes
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
      trade.notes = (trade.notes ? trade.notes + ' · ' : '') +
        'No matching MockApe trade within ±10min window';
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

