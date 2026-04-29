/**
 * Snipalot trade-context renderer.
 *
 * Modal-style window that opens after a Trade-mode recording stops.
 * User pastes their MockApe / Padre trade export (JSON or CSV); we parse
 * + validate + send to main, which writes mockape.json into the session
 * folder before the trade-pipeline renders the LLM extraction prompt.
 *
 * The whole step is optional and togglable — user can Skip per-session
 * or check "Don't ask again" to disable for all future trade sessions.
 */

interface MockApeTrade {
  chain: string;
  entryMarketCap: number;
  exitMarketCap: number;
  id: string;
  platform: string;
  pnlPercentage: number;
  pnlSol: number;
  solInvested: number;
  solReceived: number;
  timestamp: number;
  tokenName: string;
}

// IIFE wrap: isolates top-level vars (api, btnBrowse, setStatus, etc.)
// from the same-named globals in settings.ts and other renderer scripts.
// Snipalot renderer scripts share TS script-scope per the project tsconfig.
// Same pattern as annotator.ts.
(() => {

const api = window.snipalotTradeContext;

const subtitleEl = document.getElementById('subtitle')!;
const pasteAreaEl = document.getElementById('paste-area') as HTMLTextAreaElement;
const statusEl = document.getElementById('status')!;
const dontAskEl = document.getElementById('dont-ask-again') as HTMLInputElement;
const btnBrowse = document.getElementById('btn-browse') as HTMLButtonElement;
const btnSkip = document.getElementById('btn-skip') as HTMLButtonElement;
const btnContinue = document.getElementById('btn-continue') as HTMLButtonElement;
const filterPanelEl = document.getElementById('filter-panel') as HTMLDivElement;
const filterSummaryEl = document.getElementById('filter-summary')!;
const filterWindowEl = document.getElementById('filter-window')!;
const filterListEl = document.getElementById('filter-list') as HTMLUListElement;
const includeAllEl = document.getElementById('include-all') as HTMLInputElement;

let parsedTrades: MockApeTrade[] | null = null;
let sessionInfo: { sessionDir: string; recordingStartedAtMs: number; durationMs: number } | null = null;

/**
 * Buffer on each side of the recording window when filtering MockApe
 * trades. Captures trades fired right before recording started (user
 * hit the Trade hotkey then executed) or right after it stopped (user
 * exited then stopped recording).
 */
const SESSION_BUFFER_MS = 60_000;

// ── boot ──────────────────────────────────────────────────────────────

api.getSessionInfo().then((info) => {
  sessionInfo = info;
  void api.log('boot', 'session info', info);
  const durationMin = Math.round(info.durationMs / 60_000);
  subtitleEl.textContent =
    `Optional — paste MockApe / Padre export so the LLM can align spoken ` +
    `callouts to actual trades. (Session was ${durationMin} min.)`;
  // Re-render the filter panel in case the user pasted before
  // session info arrived.
  if (parsedTrades) renderFilterPanel();
});

// ── paste / browse / parse ────────────────────────────────────────────

pasteAreaEl.addEventListener('input', () => {
  const text = pasteAreaEl.value.trim();
  if (!text) {
    parsedTrades = null;
    setStatus('No data pasted yet', 'neutral');
    btnContinue.disabled = true;
    return;
  }
  tryParse(text);
});

btnBrowse.addEventListener('click', async () => {
  const result = await api.browseForFile();
  if (!result) return;
  pasteAreaEl.value = result.contents;
  void api.log('browse', 'loaded file', { filename: result.filename, chars: result.contents.length });
  tryParse(result.contents);
});

function tryParse(text: string): void {
  // Detect format: JSON if starts with [ or {, otherwise try CSV.
  const trimmed = text.trim();
  const isJson = trimmed.startsWith('[') || trimmed.startsWith('{');
  try {
    const trades = isJson ? parseJson(trimmed) : parseCsv(trimmed);
    if (trades.length === 0) {
      throw new Error('No valid trade rows found');
    }
    parsedTrades = trades;
    setStatus(`✓ Parsed ${trades.length} trade${trades.length === 1 ? '' : 's'} (${isJson ? 'JSON' : 'CSV'})`, 'ok');
    renderFilterPanel();
  } catch (err) {
    parsedTrades = null;
    filterPanelEl.style.display = 'none';
    setStatus(`✗ ${(err as Error).message}`, 'err');
    btnContinue.disabled = true;
  }
}

/**
 * Compute which pasted trades fall inside the current recording's time
 * window (with SESSION_BUFFER_MS on each side), render the breakdown,
 * and gate Continue based on whether anything is in-window OR the user
 * has overridden the filter.
 */
function renderFilterPanel(): void {
  if (!parsedTrades || !sessionInfo) {
    filterPanelEl.style.display = 'none';
    return;
  }
  const start = sessionInfo.recordingStartedAtMs - SESSION_BUFFER_MS;
  const end = sessionInfo.recordingStartedAtMs + sessionInfo.durationMs + SESSION_BUFFER_MS;
  const inWindow = parsedTrades.filter((t) => t.timestamp >= start && t.timestamp <= end);
  const outOfWindow = parsedTrades.length - inWindow.length;

  // Update summary line + window range
  const startLabel = formatDateTime(sessionInfo.recordingStartedAtMs);
  const endLabel = formatDateTime(sessionInfo.recordingStartedAtMs + sessionInfo.durationMs);
  filterWindowEl.textContent = `Session window: ${startLabel} → ${endLabel}`;

  if (inWindow.length === 0) {
    filterPanelEl.classList.remove('warn');
    filterPanelEl.classList.add('err');
    filterSummaryEl.innerHTML = `<strong>None of your ${parsedTrades.length} pasted trades fall within this session.</strong> Either the export is from a different day, or you can check "Include all" below to use the full list anyway.`;
    filterListEl.innerHTML = '';
    btnContinue.disabled = !includeAllEl.checked;
  } else if (outOfWindow > 0) {
    filterPanelEl.classList.remove('err');
    filterPanelEl.classList.add('warn');
    filterSummaryEl.innerHTML = `<strong>${inWindow.length} of ${parsedTrades.length} trades fall within this session</strong> · ${outOfWindow} outside the window will be filtered out.`;
    filterListEl.innerHTML = inWindow
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((t) => {
        const offsetMs = t.timestamp - sessionInfo!.recordingStartedAtMs;
        const offsetLabel = formatOffset(offsetMs);
        const pnlSign = t.pnlSol >= 0 ? '+' : '';
        return `<li>${escapeHtml(t.tokenName)} · ${pnlSign}${t.pnlSol.toFixed(4)} SOL · at ${offsetLabel}</li>`;
      })
      .join('');
    btnContinue.disabled = false;
  } else {
    filterPanelEl.classList.remove('warn');
    filterPanelEl.classList.remove('err');
    filterSummaryEl.innerHTML = `<strong>All ${parsedTrades.length} trades fall within this session.</strong>`;
    filterListEl.innerHTML = inWindow
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((t) => {
        const offsetMs = t.timestamp - sessionInfo!.recordingStartedAtMs;
        const offsetLabel = formatOffset(offsetMs);
        const pnlSign = t.pnlSol >= 0 ? '+' : '';
        return `<li>${escapeHtml(t.tokenName)} · ${pnlSign}${t.pnlSol.toFixed(4)} SOL · at ${offsetLabel}</li>`;
      })
      .join('');
    btnContinue.disabled = false;
  }
  filterPanelEl.style.display = 'flex';
}

includeAllEl.addEventListener('change', renderFilterPanel);

function formatOffset(ms: number): string {
  const negative = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${negative ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Compute the trades to actually send to main on Continue. Default:
 * only in-window trades. Override: full pasted list when "Include all"
 * is checked. (The override exists for edge cases where the user
 * explicitly wants the full export — e.g. if the recording started a
 * few seconds late and a trade fired just before the buffer window.)
 */
function computeSubmitTrades(): MockApeTrade[] {
  if (!parsedTrades || !sessionInfo) return [];
  if (includeAllEl.checked) return parsedTrades;
  const start = sessionInfo.recordingStartedAtMs - SESSION_BUFFER_MS;
  const end = sessionInfo.recordingStartedAtMs + sessionInfo.durationMs + SESSION_BUFFER_MS;
  return parsedTrades.filter((t) => t.timestamp >= start && t.timestamp <= end);
}

function parseJson(text: string): MockApeTrade[] {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) {
    throw new Error('JSON must be an array of trade objects');
  }
  const out: MockApeTrade[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const trade = normalizeTrade(e);
    if (trade) out.push(trade);
  }
  return out;
}

/**
 * CSV parse: minimal, handles quoted strings with commas, header row
 * required. We only need the columns that map to MockApeTrade fields;
 * extra columns are ignored.
 */
function parseCsv(text: string): MockApeTrade[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV needs a header row + at least one data row');
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const out: MockApeTrade[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length === 0) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, j) => { row[h] = (cells[j] ?? '').trim(); });
    const trade = normalizeTrade({
      tokenName: row.tokenName ?? row.token ?? row.name ?? '',
      timestamp: Number(row.timestamp ?? row.time ?? row.ts ?? '0'),
      entryMarketCap: Number(row.entryMarketCap ?? row.entry ?? '0'),
      exitMarketCap: Number(row.exitMarketCap ?? row.exit ?? '0'),
      pnlSol: Number(row.pnlSol ?? row.pnl_sol ?? '0'),
      pnlPercentage: Number(row.pnlPercentage ?? row.pnl_pct ?? row.pnl_percentage ?? '0'),
      solInvested: Number(row.solInvested ?? '0'),
      solReceived: Number(row.solReceived ?? '0'),
      chain: row.chain ?? '',
      id: row.id ?? '',
      platform: row.platform ?? '',
    });
    if (trade) out.push(trade);
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') { inQuotes = true; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function normalizeTrade(raw: unknown): MockApeTrade | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tokenName = typeof r.tokenName === 'string' ? r.tokenName : '';
  const timestamp = typeof r.timestamp === 'number' ? r.timestamp : 0;
  const entry = typeof r.entryMarketCap === 'number' ? r.entryMarketCap : 0;
  const exit = typeof r.exitMarketCap === 'number' ? r.exitMarketCap : 0;
  if (!tokenName || timestamp <= 0) return null;
  return {
    tokenName,
    timestamp,
    entryMarketCap: entry,
    exitMarketCap: exit,
    pnlSol: typeof r.pnlSol === 'number' ? r.pnlSol : 0,
    pnlPercentage: typeof r.pnlPercentage === 'number' ? r.pnlPercentage : 0,
    solInvested: typeof r.solInvested === 'number' ? r.solInvested : 0,
    solReceived: typeof r.solReceived === 'number' ? r.solReceived : 0,
    chain: typeof r.chain === 'string' ? r.chain : '',
    id: typeof r.id === 'string' ? r.id : '',
    platform: typeof r.platform === 'string' ? r.platform : '',
  };
}

function setStatus(msg: string, kind: 'neutral' | 'ok' | 'err'): void {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
}

// ── submit / skip ─────────────────────────────────────────────────────

btnContinue.addEventListener('click', async () => {
  if (!parsedTrades) return;
  const toSubmit = computeSubmitTrades();
  if (toSubmit.length === 0) {
    // Shouldn't happen — Continue is disabled in this case — but defend.
    setStatus('No trades to submit.', 'err');
    return;
  }
  btnContinue.disabled = true;
  void api.log('submit', 'submitting trades', {
    pasted: parsedTrades.length,
    submitted: toSubmit.length,
    overrideAll: includeAllEl.checked,
  });
  await api.submit({ trades: toSubmit, dontAskAgain: dontAskEl.checked });
  // Main closes the window after writing mockape.json.
});

btnSkip.addEventListener('click', async () => {
  btnSkip.disabled = true;
  await api.skip({ dontAskAgain: dontAskEl.checked });
});

// Keyboard shortcut: Esc = Skip
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    btnSkip.click();
  }
});

void api.log('boot', 'trade-context renderer ready');
})();
