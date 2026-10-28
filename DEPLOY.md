# Deploying on Vercel

The dashboard and the searches run on **Vercel** (free Hobby plan). The data lives in **Turso** (free hosted database). A **GitHub Actions** workflow (free) calls the bot every 30 minutes so it searches about every 30–60 minutes, and your subdomain **upwork.pelicanstechnologies.com** points to it.

```
GitHub Actions ─every 30 min▶ https://upwork.pelicanstechnologies.com/api/cron ─┐
your browser ──password────▶ https://upwork.pelicanstechnologies.com            ├─ Vercel functions ─▶ Turso database
                                                                                 └─ Upwork MCP (official)
```

Each call answers after about 20 seconds of work and keeps searching in the background, saving its place after every page, so a search that needs longer still continues on the next call. While the dashboard is open, the page starts due searches and pushes them forward itself.

> **Vercel Hobby is for personal, non-commercial use.** If this runs for your company's business, Vercel's terms may require the Pro plan. Check [vercel.com/docs/plans/hobby](https://vercel.com/docs/plans/hobby).

PowerShell commands marked **PC** run on your Windows PC, in `C:\Users\Admin\Desktop\upwork-bot\job-alert-lite`.

## 1. Prepare three secrets (PC)

| Variable | What to use |
| --- | --- |
| `TOKEN_ENCRYPTION_KEY` | **The same value that is already in your `.env`.** It encrypts your Upwork sign-in; a different key can't read the one you already have. |
| `DASHBOARD_PASSWORD` | A password you choose, 12+ characters. It protects the dashboard. |
| `CRON_SECRET` | A random value: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |

Keep them somewhere safe (a password manager). Never put them on GitHub.

## 2. Create the Vercel project

1. Sign in at [vercel.com](https://vercel.com) (you can use your GitHub account).
2. **Add New → Project → Import Git Repository**, then pick **pragnesh-kp/upwork-bot**. If it isn't listed, use "Adjust GitHub App Permissions" to give Vercel access to it.
3. Framework Preset: **Other**. Leave the build settings alone; `vercel.json` sets them (`npm ci`, `npm run build`).
4. Click **Deploy**. The first deployment works, but the site reports missing settings until steps 3–4 are done.

## 3. Add the Turso database

1. In the Vercel project: **Storage → Create Database → Turso** (Marketplace). Choose the free plan and a region close to your Vercel functions (Vercel's default is Washington D.C., `iad1`, so pick US East).
2. Connect it to this project. It adds the environment variables **`TURSO_DATABASE_URL`** and **`TURSO_AUTH_TOKEN`**.
3. Check **Settings → Environment Variables**. If the integration used other names, add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` yourself, with the same values.

## 4. Add your settings to Vercel

**Settings → Environment Variables**, environment **Production**:

| Name | Value |
| --- | --- |
| `TOKEN_ENCRYPTION_KEY` | from step 1 |
| `DASHBOARD_PASSWORD` | from step 1 |
| `CRON_SECRET` | from step 1 |
| `SEARCH_INTERVAL_MINUTES` | `30` (optional) |
| `UPWORK_ACCOUNT_NAME` | only if you set it in `.env` |

Then **Deployments → ⋯ on the latest → Redeploy**, because settings apply only to new deployments.

## 5. Connect Upwork (in the dashboard)

**First stop the bot on your PC**, if it runs there. Only one place may use an Upwork sign-in: when two places renew the same login, one of them gets signed out. In an **Administrator** PowerShell:

```powershell
Disable-ScheduledTask -TaskName UpworkJobAlertLite
Stop-ScheduledTask -TaskName UpworkJobAlertLite
```

Then open your site, log in, and press **Connect Upwork**:

1. Upwork's own sign-in opens in a new tab. Log in and click **Allow**.
2. That tab then shows an error like *"This site can't be reached"* on an address starting with `http://127.0.0.1:53682/callback?code=…`. **That is expected.** Upwork only lets self-registered apps return to the computer they run on, and it refuses hosted sites.
3. Copy the **whole address** from that tab, paste it into the box on the dashboard, and press **Finish** within a few minutes.

The dashboard says *Upwork connected as …* and the first search starts. Add your searches with **+ Add filter**.

**Optional: bring over your PC's filters and saved jobs.** Put the two Turso values in your PC's `.env` (Vercel → Settings → Environment Variables, eye icon), then run `npm run import`. It also copies the PC's Upwork sign-in, so you can skip Connect Upwork in that case.

```
TURSO_DATABASE_URL=libsql://…
TURSO_AUTH_TOKEN=…
```

## 6. Set up the scheduler (GitHub Actions)

Vercel's free plan runs its own scheduler only once a day, so the repository's workflow [`.github/workflows/scheduler.yml`](.github/workflows/scheduler.yml) calls `/api/cron` every 30 minutes instead. It is free for a public repository. It needs one secret:

1. On GitHub: **pragnesh-kp/upwork-bot → Settings → Secrets and variables → Actions → New repository secret**.
2. **Name:** `CRON_SECRET`. **Secret:** exactly the same value as `CRON_SECRET` in Vercel (step 4). Save.
3. **Actions** tab → **Scheduler** → **Run workflow**. The run should be green and print `{"status":"idle"}` (or `finished` / `continued`).

A filter is due again 30 minutes after its previous search and is searched on the next call, so with GitHub's delays a filter can wait up to about an hour. A red run that says `HTTP 401` means the two `CRON_SECRET` values differ. The dashboard's top line warns when the scheduler hasn't called for over 60 minutes. If the address of the site changes, update `APP_URL` in the workflow file.

GitHub pauses scheduled workflows in a public repository after 60 days without any commit; the Actions tab then offers to turn it back on.

Instead of GitHub you can use any service that calls a URL every 30 minutes with the header `Authorization: Bearer <CRON_SECRET>` (for example cron-job.org).

(Vercel also calls `/api/cron` once a day by itself, as a backup only.)

## 7. Point upwork.pelicanstechnologies.com at Vercel

1. Vercel project → **Settings → Domains → Add** → `upwork.pelicanstechnologies.com`. Vercel shows a **CNAME** record to create, usually `cname.vercel-dns.com`. **Use exactly the value Vercel shows.**
2. In **hPanel → Domains → pelicanstechnologies.com → DNS / Nameservers**:
   - If you already added an **A** record named `upwork`, delete it.
   - Add: Type **CNAME**, Name **upwork**, Target **the value from Vercel**, TTL **300**.
3. Wait until Vercel shows **Valid Configuration** (minutes, sometimes up to a few hours). Vercel issues the HTTPS certificate automatically.

## 8. Log in

Open **https://upwork.pelicanstechnologies.com** and enter your `DASHBOARD_PASSWORD`. Everything works as before: filters, Add filter / Remove, calendar, search, Save / Reviewed / Delete, **Search now**.

## Everyday

| What | How |
| --- | --- |
| Update the bot | Push to `main` on GitHub; Vercel deploys automatically. |
| Logs | Vercel project → **Logs**. |
| Change the password | Change `DASHBOARD_PASSWORD` in Vercel, then Redeploy. Everyone is signed out. |
| Upwork asks to sign in again (`Upwork sign-in expired…` on the dashboard) | Press **Reconnect Upwork** on the dashboard (step 5). |
| Check from the PC | `npm run status` / `npm run filters` (with the Turso values in `.env`). |
| Pause searching | GitHub → **Actions → Scheduler → ⋯ → Disable workflow**. |

## Troubleshooting

| Message | Fix |
| --- | --- |
| `TURSO_DATABASE_URL is not set` | Step 3, then Redeploy. |
| `Set DASHBOARD_PASSWORD…` | Step 4, then Redeploy. |
| Dashboard: `⚠ the scheduler has not called yet` | Step 6. Check the GitHub secret and the Actions tab. |
| Scheduler run on GitHub fails with `HTTP 401` | The GitHub secret `CRON_SECRET` must equal Vercel's `CRON_SECRET` (and Vercel must be redeployed after changing it). |
| `Cannot decrypt the stored Upwork sign-in` | `TOKEN_ENCRYPTION_KEY` in Vercel differs from the one used for `import`/`connect`. Make them equal, or run `npm run connect` again. |

## Local development

`npm run dev` runs the same dashboard and API at http://127.0.0.1:5174, plus a local stand-in for the scheduler. Without Turso values in `.env`, it uses a local database file (`data/local.db`). `npm run build` produces exactly what Vercel deploys (`.vercel/output`).

## Notes

* Upwork's terms: see the warning at the top of README.md. It applies on Vercel too.
* Job data is deleted after `RETENTION_DAYS` (at most 30, per Upwork's terms).
* Never commit `.env` or `data/`. A private repo is safer; to change it: GitHub → Settings → General → Danger Zone → Change visibility.
