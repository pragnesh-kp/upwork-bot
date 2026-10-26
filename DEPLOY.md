# Deploying on Vercel

The dashboard and the searches run on **Vercel** (free Hobby plan). The data lives in **Turso** (free hosted database). **cron-job.org** (free) calls the bot every 5 minutes so it searches about every 30 minutes, and your subdomain **upwork.pelicanstechnologies.com** points to it.

```
cron-job.org ──every 5 min──▶ https://upwork.pelicanstechnologies.com/api/cron ─┐
your browser ──password────▶ https://upwork.pelicanstechnologies.com            ├─ Vercel functions ─▶ Turso database
                                                                                 └─ Upwork MCP (official)
```

Each call does about 20 seconds of work and saves its place, so a search that needs longer simply continues on the next call. While the dashboard is open, the page pushes searches forward itself.

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
2. **Add New → Project → Import Git Repository**, then pick **pragnesh-kp/upwork-bot**. If it isn't listed, use "Adjust GitHub App Permissions" to give Vercel access to that private repo.
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

## 5. Move your filters, Upwork sign-in and saved jobs into Turso (PC)

**First stop the bot on your PC.** Only one copy may use the Upwork sign-in: when two places renew the same login, one of them gets signed out. In an **Administrator** PowerShell:

```powershell
Disable-ScheduledTask -TaskName UpworkJobAlertLite
Stop-ScheduledTask -TaskName UpworkJobAlertLite
```

Then put the two Turso values in your PC's `.env`. Copy them from Vercel → Settings → Environment Variables (click the eye icon to reveal):

```
TURSO_DATABASE_URL=libsql://…
TURSO_AUTH_TOKEN=…
```

and run (**PC**):

```powershell
npm ci
npm run import
npm run status
```

`import` copies your filters, your encrypted Upwork sign-in, the discovered Upwork tool schema and your saved jobs into Turso. `status` should say `Database: Turso database …`, list your 3 filters, and show `Upwork: connected as …`.

(Starting fresh instead? Run `npm run connect` and `npm run discover` with the Turso values in `.env`, then add filters in the dashboard.)

## 6. Set up the scheduler (cron-job.org)

1. Create a free account at [cron-job.org](https://cron-job.org) and choose **Create cronjob**.
2. **URL:** `https://upwork.pelicanstechnologies.com/api/cron`. Until your domain works (step 7), use the `https://<project>.vercel.app/api/cron` address Vercel shows.
3. **Schedule:** every **5 minutes**.
4. **Advanced → Headers:** add header `Authorization` with value `Bearer YOUR_CRON_SECRET` (the word `Bearer`, a space, then your secret).
5. Request method **GET**, then save. Use **Test run**: the response should be `200` with a body like `{"status":"finished",…}` or `{"status":"idle"}`.

Most calls do nothing and return `idle`. A search starts when 30 minutes have passed since the last one, and runs over a few calls. If cron-job.org shows `401`, the header is wrong. The dashboard's top line warns when the scheduler hasn't called for over 30 minutes.

(Vercel also calls `/api/cron` once a day by itself, as a backup only.)

## 7. Point upwork.pelicanstechnologies.com at Vercel

1. Vercel project → **Settings → Domains → Add** → `upwork.pelicanstechnologies.com`. Vercel shows a **CNAME** record to create, usually `cname.vercel-dns.com`. **Use exactly the value Vercel shows.**
2. In **hPanel → Domains → pelicanstechnologies.com → DNS / Nameservers**:
   - If you already added an **A** record named `upwork`, delete it.
   - Add: Type **CNAME**, Name **upwork**, Target **the value from Vercel**, TTL **300**.
3. Wait until Vercel shows **Valid Configuration** (minutes, sometimes up to a few hours). Vercel issues the HTTPS certificate automatically.

## 8. Log in

Open **https://upwork.pelicanstechnologies.com** and enter your `DASHBOARD_PASSWORD`. Everything works as before: filters, Add filter / Remove, calendar, search, Save / Reviewed / Dismiss, **Search now**.

## Everyday

| What | How |
| --- | --- |
| Update the bot | Push to `main` on GitHub; Vercel deploys automatically. |
| Logs | Vercel project → **Logs**. |
| Change the password | Change `DASHBOARD_PASSWORD` in Vercel, then Redeploy. Everyone is signed out. |
| Upwork asks to sign in again (`Upwork authorization expired…` on the dashboard) | On the PC, with the Turso values in `.env`: `npm run connect`, then `npm run discover`. |
| Check from the PC | `npm run status` / `npm run filters` (with the Turso values in `.env`). |
| Pause searching | Disable the job in cron-job.org. |

## Troubleshooting

| Message | Fix |
| --- | --- |
| `TURSO_DATABASE_URL is not set` | Step 3, then Redeploy. |
| `Set DASHBOARD_PASSWORD…` | Step 4, then Redeploy. |
| Dashboard: `⚠ the scheduler has not called yet` | Step 6. Check the URL and the `Authorization` header. |
| cron-job.org: `401` | The header must be exactly `Bearer <CRON_SECRET>`, matching Vercel's value. |
| `Cannot decrypt the stored Upwork sign-in` | `TOKEN_ENCRYPTION_KEY` in Vercel differs from the one used for `import`/`connect`. Make them equal, or run `npm run connect` again. |

## Local development

`npm run dev` runs the same dashboard and API at http://127.0.0.1:5174, plus a local stand-in for the scheduler. Without Turso values in `.env`, it uses a local database file (`data/local.db`). `npm run build` produces exactly what Vercel deploys (`.vercel/output`).

## Notes

* Upwork's terms: see the warning at the top of README.md. It applies on Vercel too.
* Job data is deleted after `RETENTION_DAYS` (at most 30, per Upwork's terms).
* Never commit `.env` or `data/`. A private repo is safer; to change it: GitHub → Settings → General → Danger Zone → Change visibility.
