import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import type { RunSummary } from '../src/run.ts';
import type { TelegramSender } from '../src/telegram.ts';
import { healthNotifier, runProblem, startWatch } from '../src/watch.ts';

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  status: 'ok',
  source: 'upwork-mcp',
  filters: [],
  newJobs: 0,
  alertsQueued: 0,
  delivery: { sent: 0, retrying: 0, failed: 0 },
  recoveredFromPreviousRun: 0,
  stoppedEarly: null,
  ...over,
});

test('health notices are sent only when the state changes', async () => {
  const sent: string[] = [];
  const sender: TelegramSender = { send: async (_chat, html) => (sent.push(html), { messageId: String(sent.length) }) };
  const notify = healthNotifier(sender, ['1']);
  await notify(true, '');
  await notify(false, 'Upwork authorization expired <x>');
  await notify(false, 'still broken');
  await notify(true, '');
  assert.equal(sent.length, 2);
  assert.match(sent[0]!, /Searches are failing/);
  assert.match(sent[0]!, /&lt;x&gt;/);
  assert.match(sent[1]!, /working again/);
});

test('runProblem reports stopped and failed runs, not partial ones', () => {
  assert.equal(runProblem(summary()), null);
  assert.equal(runProblem(summary({ status: 'partial' })), null);
  assert.equal(runProblem(summary({ stoppedEarly: 'auth expired' })), 'auth expired');
  const failed = summary({ status: 'failed', filters: [{ name: 'A', baselineRun: false, pages: 0, returned: 0, accepted: 0, rejectedLocally: 0, ignoredFilters: [], emptyReason: null, moreResultsNotFetched: false, error: 'boom' }] });
  assert.equal(runProblem(failed), 'boom');
});

test('watch searches immediately and notifies Telegram when a search throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-'));
  const cfg = loadConfig({ DATA_DIR: dir, TELEGRAM_CHAT_ID: '123' } as NodeJS.ProcessEnv);
  const store = new Store(':memory:');
  let runs = 0;
  const stop = await startWatch(cfg, store, {
    dashboard: null,
    run: async () => {
      runs++;
      throw new Error('Could not connect to the Upwork MCP server');
    },
  });
  await stop();
  store.close();
  assert.equal(runs, 1);
  assert.match(readFileSync(join(dir, 'telegram-dry-run.log'), 'utf8'), /Searches are failing/);
});
