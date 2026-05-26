import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { log } from './logger';
import { writeSessionLog } from './session-log';

const WILYTRADER_BRIDGE_PORT = 17365;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

interface BridgeSession {
  sessionDir: string;
  startedAtMs: number;
  durationMs?: number | null;
  captureTradeScreenshot?: (event: WilyTraderExecutionEvent) => Promise<string | null>;
}

export interface WilyTraderExecutionEvent {
  executionId: string;
  side?: string | null;
  timestamp?: string | null;
  tokenName?: string | null;
  tokenAddress?: string | null;
}

let server: http.Server | null = null;
let activeSession: BridgeSession | null = null;

export function getWilyTraderBridgePort(): number {
  return WILYTRADER_BRIDGE_PORT;
}

export function startWilyTraderBridge(session: BridgeSession): void {
  activeSession = session;
  if (server) {
    log('wilytrader-bridge', 'session updated', session);
    writeSessionLog(session.sessionDir, 'wilytrader-bridge', 'session updated', {
      port: WILYTRADER_BRIDGE_PORT,
    }, 'info');
    return;
  }

  server = http.createServer(handleRequest);
  server.on('error', (err) => {
    log('wilytrader-bridge', 'server error', { err: err.message, port: WILYTRADER_BRIDGE_PORT });
    if (activeSession) {
      writeSessionLog(activeSession.sessionDir, 'wilytrader-bridge', 'server error', {
        error: err.message,
        port: WILYTRADER_BRIDGE_PORT,
      }, 'error');
    }
  });
  server.listen(WILYTRADER_BRIDGE_PORT, '127.0.0.1', () => {
    log('wilytrader-bridge', 'started', { port: WILYTRADER_BRIDGE_PORT, sessionDir: session.sessionDir });
    writeSessionLog(session.sessionDir, 'wilytrader-bridge', 'started', {
      port: WILYTRADER_BRIDGE_PORT,
      endpoint: `http://127.0.0.1:${WILYTRADER_BRIDGE_PORT}/v1/wilytrader/ledger`,
    }, 'start');
  });
}

export function stopWilyTraderBridge(reason: string): void {
  const session = activeSession;
  activeSession = null;
  if (!server) return;
  const closing = server;
  server = null;
  closing.close((err) => {
    if (err) log('wilytrader-bridge', 'close error', { err: err.message, reason });
    else log('wilytrader-bridge', 'stopped', { reason, sessionDir: session?.sessionDir ?? null });
    if (session) {
      writeSessionLog(session.sessionDir, 'wilytrader-bridge', err ? 'stop failed' : 'stopped', {
        reason,
        error: err?.message,
      }, err ? 'error' : 'success');
    }
  });
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/v1/wilytrader/status') {
    writeJson(res, 200, {
      ok: true,
      active: Boolean(activeSession),
      sessionDir: activeSession?.sessionDir ?? null,
      startedAtMs: activeSession?.startedAtMs ?? null,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/wilytrader/ledger') {
    void readJsonBody(req)
      .then((payload) => void receiveLedger(payload, res))
      .catch((err) => {
        log('wilytrader-bridge', 'request rejected', { err: (err as Error).message });
        writeJson(res, 400, { ok: false, error: (err as Error).message });
      });
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Not found' });
}

async function receiveLedger(payload: unknown, res: http.ServerResponse): Promise<void> {
  const session = activeSession;
  if (!session) {
    writeJson(res, 409, { ok: false, error: 'No active Snipalot trade session.' });
    return;
  }

  try {
    const inputsDir = path.join(session.sessionDir, 'Inputs');
    if (!fs.existsSync(inputsDir)) fs.mkdirSync(inputsDir, { recursive: true });
    const ledgerPath = path.join(inputsDir, 'wilytrader.json');
    const event = extractExecutionEvent(payload);
    const screenshotPath =
      event && session.captureTradeScreenshot
        ? await session.captureTradeScreenshot(event)
        : null;
    const enriched = {
      receivedAt: new Date().toISOString(),
      receivedBy: 'snipalot-wilytrader-bridge',
      bridge: {
        port: WILYTRADER_BRIDGE_PORT,
        sessionDir: session.sessionDir,
        recordingStartedAtMs: session.startedAtMs,
        recordingDurationMs: session.durationMs ?? null,
      },
      event,
      screenshotPath,
      payload,
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(enriched, null, 2), 'utf-8');
    if (event) {
      appendJsonLine(path.join(inputsDir, 'wilytrader-executions.jsonl'), {
        receivedAt: enriched.receivedAt,
        event,
        screenshotPath,
        payload,
      });
    }
    writeSessionSnapshot(inputsDir, payload);

    const compatible = extractMockApeCompatibleTrades(payload);
    if (compatible.length > 0) {
      const compatPath = path.join(inputsDir, 'wilytrader-mockape-compatible.json');
      fs.writeFileSync(compatPath, JSON.stringify(compatible, null, 2), 'utf-8');
    }

    log('wilytrader-bridge', 'ledger written', {
      ledgerPath,
      compatibleTrades: compatible.length,
      screenshotPath,
    });
    writeSessionLog(session.sessionDir, 'wilytrader-bridge', 'ledger received', {
      ledgerPath,
      compatibleTrades: compatible.length,
      screenshotPath,
    }, 'success');
    writeJson(res, 200, {
      ok: true,
      sessionDir: session.sessionDir,
      ledgerPath,
      screenshotPath,
      compatibleTrades: compatible.length,
    });
  } catch (err) {
    const message = (err as Error).message;
    log('wilytrader-bridge', 'ledger write failed', { err: message, sessionDir: session.sessionDir });
    writeSessionLog(session.sessionDir, 'wilytrader-bridge', 'ledger write failed', {
      error: message,
    }, 'error');
    writeJson(res, 500, { ok: false, error: message });
  }
}

function extractExecutionEvent(payload: unknown): WilyTraderExecutionEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = (payload as Record<string, unknown>).event;
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  if (record.captureScreenshot !== true) return null;
  const executionId = typeof record.executionId === 'string' ? record.executionId : '';
  if (!executionId) return null;
  return {
    executionId,
    side: typeof record.side === 'string' ? record.side : null,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
    tokenName: typeof record.tokenName === 'string' ? record.tokenName : null,
    tokenAddress: typeof record.tokenAddress === 'string' ? record.tokenAddress : null,
  };
}

function appendJsonLine(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

function writeSessionSnapshot(inputsDir: string, payload: unknown): void {
  const wilyDir = path.join(inputsDir, 'wilytrader');
  if (!fs.existsSync(wilyDir)) fs.mkdirSync(wilyDir, { recursive: true });
  fs.writeFileSync(path.join(wilyDir, 'latest-ledger-payload.json'), JSON.stringify(payload, null, 2), 'utf-8');

  if (!payload || typeof payload !== 'object') return;
  const record = payload as Record<string, unknown>;
  if (record.currentSessionSummary && typeof record.currentSessionSummary === 'object') {
    fs.writeFileSync(
      path.join(wilyDir, 'current-session-summary.json'),
      JSON.stringify(record.currentSessionSummary, null, 2),
      'utf-8'
    );
  }
  if (Array.isArray(record.previousSessions)) {
    fs.writeFileSync(
      path.join(wilyDir, 'previous-sessions.json'),
      JSON.stringify(record.previousSessions, null, 2),
      'utf-8'
    );
  }
  if (Array.isArray(record.executions)) {
    fs.writeFileSync(path.join(wilyDir, 'executions.json'), JSON.stringify(record.executions, null, 2), 'utf-8');
  }
}


function extractMockApeCompatibleTrades(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const direct = record.mockapeCompatibleTrades;
  if (Array.isArray(direct)) return direct;
  const wrapped = record.payload;
  if (wrapped && typeof wrapped === 'object') {
    const wrappedTrades = (wrapped as Record<string, unknown>).mockapeCompatibleTrades;
    if (Array.isArray(wrappedTrades)) return wrappedTrades;
  }
  return [];
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Payload too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
