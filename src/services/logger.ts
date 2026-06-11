/**
 * Structured, categorized logger for the UwU backend.
 *
 * Every meaningful event (key creation, Ed25519 signing, Setu token/consent
 * fetches, intent reconciliation, on-chain anchoring, DB writes) is logged under
 * a category tag so the activity reads cleanly in the console AND is buffered in
 * memory so it can be viewed *separately* via GET /api/v1/logs and the /logs page.
 */
import 'dotenv/config';

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';
export type LogCategory =
  | 'BOOT' | 'HTTP' | 'AUTH' | 'KEYS' | 'INTENT' | 'SIGN' | 'SETU' | 'CHAIN' | 'DB';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  data?: unknown;
}

const MAX_BUFFER = 1000;
const buffer: LogEntry[] = [];

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

const CAT_COLOR: Record<LogCategory, string> = {
  BOOT: C.cyan, HTTP: C.gray, AUTH: C.magenta, KEYS: C.blue,
  INTENT: C.yellow, SIGN: C.magenta, SETU: C.green, CHAIN: C.cyan, DB: C.gray,
};
const LEVEL_COLOR: Record<LogLevel, string> = {
  info: C.reset, success: C.green, warn: C.yellow, error: C.red, debug: C.gray,
};
const LEVEL_MARK: Record<LogLevel, string> = {
  info: '·', success: '✓', warn: '!', error: '✗', debug: '·',
};

// Never let a secret slip into the logs/buffer.
const SENSITIVE = /(secret|mnemonic|private|password|seed|clientsecret|sk|token)/i;
function redact(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '••redacted••' : val;
    }
    return out;
  }
  return v;
}

const USE_COLOR = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const paint = (s: string, color: string) => (USE_COLOR ? `${color}${s}${C.reset}` : s);

function emit(level: LogLevel, category: LogCategory, message: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const safe = data === undefined ? undefined : redact(data);
  const entry: LogEntry = { ts, level, category, message, data: safe };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  const time = paint(ts.slice(11, 23), C.dim);
  const tag = paint(`[${category}]`.padEnd(8), CAT_COLOR[category] + (USE_COLOR ? C.bold : ''));
  const mark = paint(LEVEL_MARK[level], LEVEL_COLOR[level]);
  const msg = level === 'error' || level === 'warn' || level === 'success' ? paint(message, LEVEL_COLOR[level]) : message;
  // eslint-disable-next-line no-console
  console.log(`${time} ${tag} ${mark} ${msg}`);
  if (safe !== undefined) {
    const json = typeof safe === 'string' ? safe : JSON.stringify(safe);
    // eslint-disable-next-line no-console
    console.log(paint(`           ${json}`, C.dim));
  }
}

export const log = {
  info: (c: LogCategory, m: string, d?: unknown) => emit('info', c, m, d),
  success: (c: LogCategory, m: string, d?: unknown) => emit('success', c, m, d),
  warn: (c: LogCategory, m: string, d?: unknown) => emit('warn', c, m, d),
  error: (c: LogCategory, m: string, d?: unknown) => emit('error', c, m, d),
  debug: (c: LogCategory, m: string, d?: unknown) => emit('debug', c, m, d),
  /** Recent entries, newest last; optionally filtered by category. */
  recent: (limit = 200, category?: string): LogEntry[] => {
    const list = category ? buffer.filter((e) => e.category === category) : buffer;
    return list.slice(-limit);
  },
  clear: (): void => { buffer.length = 0; },
};
