import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from './db.ts';
import { log, redact } from './log.ts';
import type { Job } from './sources/types.ts';

export const MAX_MESSAGE = 4096;
const MAX_ATTEMPTS = 6;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Only http(s) links on upwork.com are rendered as links. */
export function safeUpworkUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)upwork\.com$/i.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

function money(n: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch {
    return `${n} ${currency ?? ''}`.trim();
  }
}

/** Formats the budget from parsed numbers; the source's own text is used only when nothing was parsed. */
export function budgetText(job: Job): string {
  if (job.contractType === 'FIXED') {
    if (job.fixedBudget !== null) return `Fixed price · ${money(job.fixedBudget, job.currency)}`;
    return job.budgetLabel ? `Fixed price · ${job.budgetLabel}` : 'Fixed price · budget not provided';
  }
  if (job.contractType === 'HOURLY') {
    const lo = job.hourlyMin !== null ? money(job.hourlyMin, job.currency) : null;
    const hi = job.hourlyMax !== null ? money(job.hourlyMax, job.currency) : null;
    if (lo && hi) return `Hourly · ${lo === hi ? lo : `${lo}–${hi}`}/hr`;
    if (lo) return `Hourly · ${lo}+/hr`;
    if (hi) return `Hourly · up to ${hi}/hr`;
    return job.budgetLabel ? `Hourly · ${job.budgetLabel}` : 'Hourly · rate not provided';
  }
  return job.budgetLabel ?? 'Not provided';
}

export function postedText(iso: string | null, nowMs = Date.now()): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'Not provided';
  const mins = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return `${ago} (${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC)`;
}

/** Builds the alert. Every value from the source is HTML-escaped; missing values are labelled. */
export function formatAlert(job: Job, filterNames: string[], opts: { descriptionMaxChars: number; nowMs?: number }): string {
  const lines = [
    '🚀 <b>NEW UPWORK OPPORTUNITY</b>',
    '',
    `<b>Job:</b> ${escapeHtml(job.title)}`,
    `<b>Budget:</b> ${escapeHtml(budgetText(job))}`,
    `<b>Posted:</b> ${escapeHtml(postedText(job.postedAt, opts.nowMs))}`,
  ];
  if (job.skills.length) lines.push(`<b>Skills:</b> ${escapeHtml(job.skills.slice(0, 8).join(', '))}`);
  if (job.clientCountry !== undefined) lines.push(`<b>Client country:</b> ${job.clientCountry ? escapeHtml(job.clientCountry) : 'Not provided'}`);
  if (job.clientPaymentVerified !== undefined) {
    lines.push(`<b>Payment verified:</b> ${job.clientPaymentVerified === null ? 'Not provided' : job.clientPaymentVerified ? 'Yes' : 'No'}`);
  }
  if (job.proposals) lines.push(`<b>Proposals:</b> ${escapeHtml(job.proposals)}`);
  lines.push('', '<b>Matched filters:</b>', ...filterNames.map((n) => `• ${escapeHtml(n)}`));
  if (opts.descriptionMaxChars > 0) {
    const d = (job.description ?? '').replace(/\s+/g, ' ').trim();
    lines.push('', '<b>Description:</b>', d ? escapeHtml(d.length > opts.descriptionMaxChars ? `${d.slice(0, opts.descriptionMaxChars - 1)}…` : d) : '<i>Not provided</i>');
  }
  const url = safeUpworkUrl(job.url);
  lines.push('', url ? `<a href="${escapeHtml(url)}">View job on Upwork</a>` : '<i>Job link not provided by the source</i>');
  let text = lines.join('\n');
  if (text.length > MAX_MESSAGE) text = `${text.slice(0, MAX_MESSAGE - 20)}\n…(truncated)`;
  return text;
}

export class TelegramError extends Error {
  readonly kind: 'temporary' | 'permanent' | 'ambiguous';
  readonly retryAfterSeconds: number | null;
  constructor(kind: 'temporary' | 'permanent' | 'ambiguous', message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TelegramSender {
  send(chatId: string, html: string): Promise<{ messageId: string }>;
}

export function telegramClient(token: string, apiBase = 'https://api.telegram.org', fetchImpl: typeof fetch = fetch): TelegramSender {
  return {
    async send(chatId, html) {
      let res: Response;
      try {
        res = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        const timeout = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError';
        // A timeout may mean Telegram received the message; retrying could duplicate it.
        throw new TelegramError(timeout ? 'ambiguous' : 'temporary', redact(`Telegram request failed: ${(err as Error).message}`));
      }
      const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { message_id?: number }; description?: string; parameters?: { retry_after?: number } } | null;
      if (body?.ok && typeof body.result?.message_id === 'number') return { messageId: String(body.result.message_id) };
      const desc = redact(body?.description ?? `HTTP ${res.status}`);
      if (res.status === 429) throw new TelegramError('temporary', `Telegram rate limit: ${desc}`, body?.parameters?.retry_after ?? 30);
      if (res.status >= 500) throw new TelegramError('temporary', `Telegram server error: ${desc}`);
      throw new TelegramError('permanent', `Telegram rejected the message: ${desc}`);
    },
  };
}

/** Writes messages to a local file instead of Telegram (TELEGRAM_DRY_RUN=true). */
export function dryRunSender(file: string): TelegramSender {
  mkdirSync(dirname(file), { recursive: true });
  let n = 0;
  return {
    async send(chatId, html) {
      appendFileSync(file, `----- ${new Date().toISOString()} → chat ${chatId}\n${html}\n\n`);
      return { messageId: `dry-run-${Date.now()}-${n++}` };
    },
  };
}

/**
 * Delivers every due outbox row. A row is marked sent only after Telegram
 * returns a message_id. Temporary failures stay pending and are retried on this
 * or a later run (so alerts survive restarts); permanent failures are recorded.
 */
export async function deliverOutbox(store: Store, sender: TelegramSender): Promise<{ sent: number; retrying: number; failed: number }> {
  const out = { sent: 0, retrying: 0, failed: 0 };
  for (const row of store.dueOutbox()) {
    if (!row.text) {
      store.markFailed(row.id, 'Message body missing');
      out.failed++;
      continue;
    }
    try {
      const { messageId } = await sender.send(row.chat_id, row.text);
      store.markSent(row.id, messageId);
      out.sent++;
    } catch (err) {
      const te = err instanceof TelegramError ? err : new TelegramError('temporary', (err as Error).message);
      if (te.kind === 'permanent') {
        store.markFailed(row.id, te.message);
        out.failed++;
        log.error('telegram delivery failed permanently', { outboxId: row.id, chat: row.chat_id, error: te.message });
        continue;
      }
      const delay = Math.max((te.retryAfterSeconds ?? 0) * 1000, Math.min(30 * 60_000, 15_000 * 2 ** row.attempts));
      const status = store.markRetry(row.id, `${te.kind}: ${te.message}`, delay, MAX_ATTEMPTS);
      if (status === 'failed') out.failed++;
      else out.retrying++;
      log.warn('telegram delivery will be retried', { outboxId: row.id, kind: te.kind, error: te.message, retryInSeconds: Math.round(delay / 1000) });
      if (te.retryAfterSeconds) break; // Rate-limited: stop sending for this run.
    }
  }
  return out;
}
