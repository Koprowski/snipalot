import * as fs from 'node:fs';
import * as path from 'node:path';

export type SessionLogStatus = 'info' | 'start' | 'success' | 'warning' | 'error' | 'timeout' | 'skipped';

const MAX_STRING_LENGTH = 700;
const MAX_ARRAY_ITEMS = 30;
const MAX_OBJECT_DEPTH = 4;

function sessionInputsDir(sessionDir: string): string {
  return path.join(sessionDir, 'Inputs');
}

export function getSessionLogPath(sessionDir: string): string {
  return path.join(sessionInputsDir(sessionDir), 'processing_log.jsonl');
}

function sanitizeText(text: string): string {
  return text
    .replace(/(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^"',\s\\]+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)(sk-[A-Za-z0-9._-]+)/g, '$1[REDACTED]')
    .replace(/((?:openaiApiKey|geminiApiKey|apiKey|token|secret|password)["']?\s*[:=]\s*["']?)[^"',\s\\]+/gi, '$1[REDACTED]')
    .replace(/sk-or-[A-Za-z0-9._-]+/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/sk-[A-Za-z0-9._-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_GOOGLE_API_KEY]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

function truncate(text: string): string {
  if (text.length <= MAX_STRING_LENGTH) return text;
  return `${text.slice(0, MAX_STRING_LENGTH)}... [truncated ${text.length - MAX_STRING_LENGTH} chars]`;
}

function sanitizeValue(value: unknown, key: string = '', depth: number = 0): unknown {
  const lowerKey = key.toLowerCase();
  if (/(apikey|api_key|authorization|bearer|password|secret|token)/i.test(lowerKey)) {
    return '[REDACTED]';
  }
  if (/(prompttext|transcripttext|rawtext|responsetext)/i.test(lowerKey)) {
    return typeof value === 'string' ? `[omitted ${value.length} chars]` : '[omitted]';
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeText(truncate(value.message)),
    };
  }
  if (typeof value === 'string') {
    return truncate(sanitizeText(value));
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'undefined') return undefined;
  if (depth >= MAX_OBJECT_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, key, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) out.push(`[truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeValue(childValue, childKey, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function writeSessionLog(
  sessionDir: string | null | undefined,
  phase: string,
  event: string,
  details?: unknown,
  status: SessionLogStatus = 'info'
): void {
  if (!sessionDir) return;
  try {
    const inputsDir = sessionInputsDir(sessionDir);
    fs.mkdirSync(inputsDir, { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      phase,
      event,
      status,
      details: sanitizeValue(details),
    };
    fs.appendFileSync(getSessionLogPath(sessionDir), `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    // Session diagnostics must never interfere with capture or processing.
  }
}

