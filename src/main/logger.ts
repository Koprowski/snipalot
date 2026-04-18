import * as fs from 'node:fs';
import * as path from 'node:path';

// Single shared log file. New session truncates so we don't accrete forever.
let logPath: string | null = null;
let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  const outDir = path.join(process.cwd(), 'spike-output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  logPath = path.join(outDir, 'snipalot.log');
  // APPEND at init so multiple concurrent instances each leave a clear
  // session-start marker (with their PID) without nuking each other's log
  // lines. This lets us detect the "ghost second instance" problem.
  try {
    fs.appendFileSync(
      logPath,
      `\n[${new Date().toISOString()}] [logger] session start pid=${process.pid}\n`
    );
  } catch {
    /* ignore */
  }
  initialized = true;
}

export function log(scope: string, ...args: unknown[]): void {
  ensureInit();
  if (!logPath) return;
  const ts = new Date().toISOString();
  const parts = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
  const line = `[${ts}] [pid=${process.pid}] [${scope}] ${parts}\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch {
    /* ignore */
  }
  // Also echo to stdout for live tail when launched via npm.
  // eslint-disable-next-line no-console
  console.log(line.trimEnd());
}

export function getLogPath(): string | null {
  ensureInit();
  return logPath;
}
