# Upwork Job Alert Lite

A small, free, self-hosted Node.js + TypeScript bot. Every ~30 minutes it searches your saved Upwork job filters through the **official Upwork MCP server** (free with any Upwork account, no developer key) and lists every matching job on a local dashboard at http://127.0.0.1:5174. Each job appears **once**, even if later searches find it again, and has a link that opens the post on Upwork. Telegram alerts are optional and off unless you configure them. There's no paid API, no scraping, no Docker and no database server. It uses only Node's built-in SQLite.

## ⚠️ Read this first: Upwork's terms

Upwork's API & MCP Terms (s.4.1, effective 5 Oct 2026) say search access "does not authorize activity designed to enumerate or continuously monitor" Upwork's content. **Automatic searches on a timer (`npm run watch` and the background task) go against that clause.** The defaults keep the volume low: 5 filters, 1 page each, every ~30 minutes, with 5 s between searches. Even so, Upwork could rate-limit, restrict or disconnect your account. You run it at your own risk. To stay fully within the terms, don't install the background task. Run `npm run search` or press **Search now** on the dashboard yourself instead.

Other terms the app follows: MCP data is kept at most 30 days (`RETENTION_DAYS`), tokens are stored encrypted, and the app only calls read-only tools (`list_accounts`, `get_tool_help`, `find_jobs` with `action: "search"`).

**Running it on a server (Hostinger VPS, 24/7):** see [DEPLOY.md](DEPLOY.md).

## 1. Setup (Windows)

1. Install **Node.js 22.18+** (24 LTS recommended). Check with `node -v`.
2. In PowerShell:
   ```powershell
   cd C:\Users\Admin\Desktop\upwork-bot\job-alert-lite
   npm ci
   Copy-Item .env.example .env
   Copy-Item filters.example.json filters.json
   ```
3. *(Optional, can be skipped)* **Telegram:** leave `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` empty to use only the dashboard. To get phone alerts later, create a bot with **@BotFather**, fill in both values, and test with `npm run test-telegram`.
4. **Connect Upwork:**
   - Generate a key and put it in `TOKEN_ENCRYPTION_KEY`:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   - `npm run connect` opens Upwork's own sign-in page in your browser. You sign in there; the app only gets OAuth tokens, stored encrypted in `data\upwork-oauth.enc`.
   - `npm run discover` records your account and the live `find_jobs` schema in `data\discovery.json`.
5. Add your searches in the dashboard: copy the link from the Upwork search page, open **+ Add filter** in the left sidebar, paste it (and optionally a name), and press **Add and search**. Its first search starts right away. **Remove** under a filter deletes it and its jobs. A link is refused if it uses an Upwork filter the bot cannot apply yet (it names which one), because the bot would otherwise list jobs outside your filter. Every search runs newest first, whatever the link says. (The filters are stored in `filters.json`, which you can also edit by hand.)
6. `npm run search` runs one search. Jobs found on the first search of a filter are marked **Earlier post** on the dashboard (and never sent to Telegram), so only genuinely new posts are flagged as fresh.

## 2. Run it in the background (always on)

```powershell
# In an Administrator PowerShell, inside the job-alert-lite folder:
npm run background:install
```

This registers the Windows Task Scheduler task **UpworkJobAlertLite**, which runs `npm run watch`:

* It runs **without a window**, whether or not you're signed in, and **starts at boot**.
* A watchdog trigger checks every 5 minutes and restarts it if it stopped (crash, Windows update, and so on). A second copy is never started.
* It searches all enabled filters right away, then every `SEARCH_INTERVAL_MINUTES` (default 30, with ±10% random spread).
* It serves the dashboard at http://127.0.0.1:5174 from the same process.
* The dashboard lists every matching job grouped by posting date (Today, Yesterday, …). Use the **Posted on** calendar (or Today / Yesterday) to see one day, the search box to find words in the title, description or skills (`node js`, `nodejs` and `Node.js` all match), and the left sidebar to see one filter.
* The dashboard shows when the last search ran and when the next one is due. Jobs found by the latest search are marked **Just found**. Use Save / Reviewed / Dismiss to sort them.
* If searches fail (for example, the Upwork sign-in expired), the dashboard's status line shows it, and so does `data\app.log`. With Telegram configured, you also get one warning message.

Check and control it:

| What | Command |
| --- | --- |
| Is it running? | `Get-ScheduledTask UpworkJobAlertLite \| Get-ScheduledTaskInfo` |
| Live log | `Get-Content data\app.log -Wait -Tail 20` |
| Stop / start | `Stop-ScheduledTask UpworkJobAlertLite` / `Start-ScheduledTask UpworkJobAlertLite` |
| Remove | `npm run background:uninstall` (Administrator PowerShell) |

**The PC must be on and awake.** No searches run while Windows is asleep. Missed time is not caught up, and the next search simply runs when the PC wakes. For true 24/7 coverage, set *Settings > System > Power > Sleep* to **Never** while plugged in, or run the bot on an always-on machine.

After changing `.env` or `filters.json`, run `Stop-ScheduledTask UpworkJobAlertLite`, then `Start-ScheduledTask UpworkJobAlertLite`. Filters are re-read on every search, but `.env` is only read at start.

To try the loop in a normal window first, run `npm run watch` (Ctrl+C stops it). Stop any open `npm run dashboard` first, because both use port 5174.

## 3. Commands

| Command | What it does |
| --- | --- |
| `npm run watch` | Search every ~30 min + dashboard, until stopped (what the background task runs) |
| `npm run background:install` / `background:uninstall` | Install / remove the background task (Administrator PowerShell) |
| `npm run search` | One search over all enabled filters (`--filter "Name"` for one) |
| `npm run dashboard` | Dashboard only (http://127.0.0.1:5174); its **Search now** button runs one search |
| `npm run filters` | Shows how each filter URL is translated and what is (not) sent to Upwork |
| `npm run connect` / `disconnect` | Sign in to Upwork / delete local tokens (also revoke in Upwork > Settings > Connected Apps) |
| `npm run discover` | Read-only: account + live `find_jobs` schema |
| `npm run test-telegram` | Send a test message |
| `npm run status` / `purge` | Counts and recent runs / apply retention now |
| `npm test` / `typecheck` | 56 tests (no network) / TypeScript check |

## 4. How your filter URL maps

Example: `amount=1500-500000&hourly_rate=10-100&q=Full%20stack%20developer&sort=recency&t=0,1`

| URL parameter | Meaning | Sent to Upwork as |
| --- | --- | --- |
| `q` | keyword | `query` |
| `amount=1500-500000` | fixed-price budget | `budget_min` / `budget_max` |
| `hourly_rate=10-100` | hourly rate | `rate_min` / `rate_max` |
| `t=0,1` | hourly + fixed | nothing (any type); a single type becomes `job_type` |
| `sort=recency` | newest first | `sort=recency` |
| `category2_uid=A,B` | categories | `category` (one search per id; results combined, as on the website) |
| `subcategory2_uid=C` | subcategories | `subcategory` (one search per id) |
| `jobs_feed` | web-UI tab | not sent |

Paging: Upwork returns 10 jobs per page. A filter's **first** search fetches up to `FIRST_RUN_MAX_PAGES` (default 10 = 100 newest jobs) per search; after that every run reads at least 2 pages and up to `MAX_PAGES_PER_FILTER` (default 3), stopping once a page has nothing new. Two pages are always read because Upwork's newest-first order is not perfectly strict. The Upwork website counts *all* open jobs (often thousands); the bot covers the newest ones and then every new post from then on.

Limits of the live tool: no date filter, and the server may report `filters_ignored`, which each run logs. Budget, rate and contract type are re-checked locally. Local checks can only remove jobs, never recover jobs the server didn't return.

## 5. How it works

* **One run** (`src/run.ts`): takes a lock so runs never overlap (a crashed run's lock expires after 30 min), then searches each enabled filter (and each of its categories) one after another, 5 s apart, paging as described in section 4.
* **Retries:** up to 3 attempts with exponential backoff, never sooner than Upwork's `retry_after_seconds`. If Upwork asks for a wait longer than 2 minutes, or authorization fails, the run stops and the next scheduled run tries again.
* **Each job once:** a job that several filters' searches returned is one dashboard entry naming those filters. A job is labelled with a filter only if that filter's own Upwork search returned it, and the dashboard only shows jobs of the filters currently in `filters.json`.
* **Deduplication** (SQLite `data\jobs.sqlite`): jobs are remembered by their Upwork id, so a job found again is never added twice.
* **Watch loop** (`src/watch.ts`): one search right away, then repeats on the interval. Errors never stop the loop.
* **Logs:** JSON lines in `data\app.log` with tokens redacted. The log rotates at 5 MB (one old file kept as `app.log.1`).

## 6. Security

* `.env`, `filters.json` and `data\` are git-ignored. OAuth tokens are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`. If you lose the key, you just reconnect.
* Upwork grants connected apps **full account scopes**. This app only ever calls the read-only tools listed above. Keep the token file private.
* The dashboard and the OAuth callback listen on `127.0.0.1` only.
* Telegram text is HTML-escaped, and only `https://*.upwork.com` links are rendered.

## 7. Known limitations

* Upwork can change the MCP tool without notice. If searches start failing, run `npm run discover` again.
* Coverage isn't guaranteed: one page per filter, server-side ranking, filters Upwork may ignore, and account restrictions that look like empty results.
* Local keyword checks (used only for cross-filter matching) are token based: `fullstack` doesn't match `full stack`.
* Contract-type codes in URLs (`t=0` hourly, `t=1` fixed) are inferred from the Upwork web UI, not documented.
