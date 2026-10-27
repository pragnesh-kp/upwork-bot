# Upwork Job Alert Lite

A small Node.js + TypeScript bot. About every 30 minutes it searches your saved Upwork job filters through the **official Upwork MCP server** (free with any Upwork account, no developer key) and lists every matching job on a password-protected dashboard. Each job appears **once**, even if later searches find it again, and links to the post on Upwork. No scraping.

It runs on **Vercel** (functions + page) with a **Turso** database and a GitHub Actions workflow as the scheduler. **Setup: [DEPLOY.md](DEPLOY.md).**

## ⚠️ Read this first: Upwork's terms

Upwork's API & MCP Terms (s.4.1, effective 5 Oct 2026) say search access "does not authorize activity designed to enumerate or continuously monitor" Upwork's content. **Automatic searches on a schedule go against that clause.** The defaults keep the volume low: one search per filter (and category) every ~30 minutes, 2–3 pages each, 3 s apart. Even so, Upwork could rate-limit, restrict or disconnect your account. You run it at your own risk. To stay fully within the terms, don't set up the scheduler; press **Search now** on the dashboard yourself instead.

Other terms the app follows: MCP data is kept at most 30 days (`RETENTION_DAYS`), the Upwork sign-in is stored encrypted, and the app only calls read-only tools (`list_accounts`, `get_tool_help`, `find_jobs` with `action: "search"`).

## The dashboard

* **Every matching job, grouped by posting date** (Today, Yesterday, …), with budget, posting time, client details, matched filters and an **Open on Upwork ↗** link.
* **Posted on** calendar (plus Today / Yesterday) and a search box over title, description and skills (`node js`, `nodejs` and `Node.js` all match).
* **Filters** in the left sidebar: click one to see only its jobs. **+ Add filter** takes a link copied from the Upwork search page, and its first search starts right away. **Remove** deletes a filter and its jobs. A link is refused if it uses an Upwork filter the bot can't apply yet (it names which one); otherwise the bot would list jobs outside your filter.
* **Search now** searches the selected filter (or all of them). **Just found** marks jobs from the latest search. Save / Reviewed / Dismiss sort them.
* The top line shows the last and next scan (date, time and how long ago / until), live progress, and warnings: an expired Upwork sign-in, or a scheduler that stopped calling. Each filter in the sidebar shows its own last scan (and new jobs found) and next scan.

## How it works

* **Search engine** (`src/engine.ts`): a search is a list of small tasks (one per filter and category, each with its page cursor) saved in the database. Each call does up to `STEP_BUDGET_SECONDS` (20) of work, saving after every page, and the next call continues. A database lock makes sure only one search runs at a time.
* **Scheduler** (`/api/cron`, called every 5 min by the GitHub Actions workflow `.github/workflows/scheduler.yml` with `Authorization: Bearer <CRON_SECRET>`): continues a running search, or starts one for every filter whose `SEARCH_INTERVAL_MINUTES` (30) have passed since that filter was last searched. Each filter keeps its own time, so searching one filter by hand never delays the others. The call answers within ~20 s (external schedulers such as cron-job.org give up after 30 s) and the search continues in the background on Vercel, so a whole search finishes in one call. Most calls do nothing. While the dashboard is open, it also starts due searches itself.
* **Paging:** Upwork returns 10 jobs per page, newest first. A filter's first search reads up to `FIRST_RUN_MAX_PAGES` (10) pages. After that, each search reads at least 2 and up to `MAX_PAGES_PER_FILTER` (3) pages, stopping once a page has nothing new. At least 2 pages, because Upwork's order isn't perfectly strict.
* **Matching:** Upwork applies the keyword and categories. Budget, hourly rate and contract type are re-checked locally, and missing data is *unknown*, never 0. A job is labelled with a filter only if that filter's own search returned it.
* **Retries:** up to 3 attempts per page with backoff, never sooner than Upwork's `retry_after_seconds`. A longer wait carries over to a later call. An expired sign-in stops the search and shows on the dashboard.
* **Storage** (`src/db.ts`, libSQL): Turso on Vercel, a local file (`data/local.db`) on your PC.

### How a filter URL maps

| URL parameter | Meaning | Sent to Upwork as |
| --- | --- | --- |
| `q` | keyword | `query` |
| `amount=1500-500000` | fixed-price budget | `budget_min` / `budget_max` |
| `hourly_rate=10-100` | hourly rate | `rate_min` / `rate_max` |
| `t=0,1` | hourly + fixed | nothing (any type); a single type becomes `job_type` |
| `sort` | order | always newest first (needed to catch every new post) |
| `category2_uid=A,B` | categories | `category`, one search per id, results combined |
| `subcategory2_uid=C` | subcategories | `subcategory`, one search per id |
| `jobs_feed` | web-UI tab | not sent |

## Commands (on your PC)

With `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` in `.env` these act on the live database; without them, on `data/local.db`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dashboard + API at http://127.0.0.1:5174, plus a local scheduler (`-- --no-scheduler` to skip it) |
| `npm run connect` / `disconnect` | Sign in to Upwork in your browser / delete the stored sign-in (also revoke in Upwork → Settings → Connected Apps) |
| `npm run discover` | Read-only: account + live `find_jobs` schema |
| `npm run import` | Copy `filters.json`, the old `data/` sign-in and saved jobs into the database |
| `npm run search` | One full search now (`-- --filter "Name"` for one filter) |
| `npm run filters` | How each filter URL is translated and what is (not) sent to Upwork |
| `npm run status` / `purge` | Overview / apply retention now |
| `npm run build` | Build the Vercel output (`.vercel/output`) |
| `npm test` / `typecheck` | Tests (no network) / TypeScript check |

## Security

* The dashboard needs `DASHBOARD_PASSWORD` (required on Vercel). Sessions use a signed, HttpOnly, SameSite=Strict cookie, and repeated wrong passwords are blocked per IP for 15 minutes. Every change also needs a custom request header that other websites can't send.
* `/api/cron` only accepts `Authorization: Bearer <CRON_SECRET>`.
* The Upwork sign-in is AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY` before it's stored. Upwork grants connected apps **full account scopes**; this app only calls the read-only tools listed above.
* Job content is shown as text only, and only `https://*.upwork.com` links are kept. Strict security headers (CSP, no framing).
* `.env`, `filters.json` and `data/` are git-ignored. Keep the repo private.

## Known limitations

* Upwork can change the MCP tool without notice. If searches start failing, run `npm run discover` again.
* Coverage isn't guaranteed: the newest pages only, server-side ranking, filters Upwork may ignore, and account restrictions that look like empty results.
* Contract-type codes in URLs (`t=0` hourly, `t=1` fixed) are inferred from the Upwork web UI, not documented.
