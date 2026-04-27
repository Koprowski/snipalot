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

let parsedTrades: MockApeTrade[] | null = null;
let sessionInfo: { sessionDir: string; recordingStartedAtMs: number; durationMs: number } | null = null;

// ── boot ──────────────────────────────────────────────────────────────

api.getSessionInfo().then((info) => {
  sessionInfo = info;
  void api.log('boot', 'session info', info);
  const durationMin = Math.round(info.durationMs / 60_000);
  subtitleEl.textContent =
    `Optional — paste MockApe / Padre export so the LLM can align spoken ` +
    `callouts to actual trades. (Session was ${durationMin} min.)`;
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
    btnContinue.disabled = false;
  } catch (err) {
    parsedTrades = null;
    setStatus(`✗ ${(err as Error).message}`, 'err');
    btnContinue.disabled = true;
  }
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
  btnContinue.disabled = true;
  await api.submit({ trades: parsedTrades, dontAskAgain: dontAskEl.checked });
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
