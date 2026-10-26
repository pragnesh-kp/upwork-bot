import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let minLevel: Level = 'info';
let file: string | null = null;

export function configureLog(level: Level, logFile: string | null): void {
  minLevel = level;
  file = logFile;
  if (file) mkdirSync(dirname(file), { recursive: true });
}

/** Removes bot tokens and bearer tokens from any text before it is logged. */
export function redact(text: string): string {
  return text
    .replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/("?(access|refresh)_token"?\s*[:=]\s*"?)[^",\s]+/gi, '$1[REDACTED]');
}

function write(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = redact(JSON.stringify({ time: new Date().toISOString(), level, msg, ...data }));
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  if (file) {
    try {
      // The background watcher never exits: keep at most ~5 MB of current log plus one old file.
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, `${line}\n`);
    } catch {
      // Logging must never crash a run.
    }
  }
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => write('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => write('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write('error', msg, data),
};
