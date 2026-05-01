import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { app } from 'electron';

// Single shared log file. Packaged installs must NOT write under process.cwd()
// (e.g. C:\Program Files\Snipalot) — that hits EPERM. Use Electron's logs dir.
let logPath: string | null = null;
let initialized = false;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_LOGS = 3;

function logDir(): string {
  try {
    if (app?.isPackaged) {
      return app.getPath('logs');
    }
  } catch {
    /* app.getPath may throw in rare init orders */
  }
  return path.join(process.cwd(), 'spike-output');
}

function ensureInit(): void {
  if (initialized) return;
  const outDir = logDir();
  try {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    logPath = path.join(outDir, 'snipalot.log');
    rotateLogIfNeeded(logPath);
  } catch {
    // Last resort: temp dir so logging never takes down the app
    try {
      const fallback = path.join(os.tmpdir(), 'snipalot-logs');
      if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
      logPath = path.join(fallback, 'snipalot.log');
    } catch {
      logPath = null;
      initialized = true;
      return;
    }
  }
  // APPEND at init so multiple concurrent instances each leave a clear
  // session-start marker (with their PID) without nuking each other's log
  // lines. This lets us detect the "ghost second instance" problem.
  try {
    if (logPath) {
      fs.appendFileSync(
        logPath,
        `\n[${new Date().toISOString()}] [logger] session start pid=${process.pid}\n`
      );
    }
  } catch {
    /* ignore */
  }
  initialized = true;
}

function rotateLogIfNeeded(currentPath: string): void {
  try {
    if (!fs.existsSync(currentPath)) return;
    const stat = fs.statSync(currentPath);
    if (stat.size < MAX_LOG_BYTES) return;

    for (let i = MAX_ROTATED_LOGS; i >= 1; i--) {
      const from = `${currentPath}.${i}`;
      const to = `${currentPath}.${i + 1}`;
      if (i === MAX_ROTATED_LOGS && fs.existsSync(from)) {
        fs.rmSync(from, { force: true });
      } else if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    }
    fs.renameSync(currentPath, `${currentPath}.1`);
  } catch {
    // Logging must never prevent the app from launching.
  }
}

function sanitizeLogText(text: string): string {
  return text
    .replace(/(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s\\]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)(sk-[A-Za-z0-9._-]+)/g, '$1[REDACTED]')
    .replace(/((?:openaiApiKey|geminiApiKey|apiKey|token|secret|password)["']?\s*[:=]\s*["']?)[^"',\s\\]+/gi, '$1[REDACTED]')
    .replace(/sk-or-[A-Za-z0-9._-]+/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/sk-[A-Za-z0-9._-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_GOOGLE_API_KEY]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

function stringifyLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function log(scope: string, ...args: unknown[]): void {
  ensureInit();
  if (!logPath) return;
  const ts = new Date().toISOString();
  const parts = sanitizeLogText(args.map(stringifyLogArg).join(' '));
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
