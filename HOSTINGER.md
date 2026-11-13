# Deploying on Hostinger (upwork.pelicanstechnology.com)

The dashboard and the searches run as a **Node.js Web App** on Hostinger. The data lives in a **MySQL database** in the same Hostinger account. The site is **https://upwork.pelicanstechnology.com**.

```
your browser ──password──▶ https://upwork.pelicanstechnology.com ─┐
Hostinger Cron ─every 5 min─▶ …/api/ping (keep awake)              ├─ Node.js app (dist/server.mjs) ─▶ MySQL (localhost)
the app itself ─every minute─▶ starts searches that are due          ┘                                 └▶ Upwork MCP (official)
```

The server stays running, so it searches by itself every 30 minutes (`SEARCH_INTERVAL_MINUTES`). Hostinger stops apps that sit idle, so a Hostinger Cron Job calls `/api/ping` every 5 minutes to keep it awake (step 8).

PowerShell commands marked **PC** run on your Windows PC, in `C:\Users\Admin\Desktop\upwork-bot\job-alert-lite`.

## 0. Check your plan

Node.js apps need **Business Web Hosting** or a **Cloud** plan (Startup, Professional, Enterprise). In hPanel go to **Websites → Add website**. If you see **Node.js Apps**, your plan supports it. On Premium/Single hosting, upgrade the plan or use a VPS (see the end of this file).

## 1. Create the MySQL database

hPanel → **Websites** → *pelicanstechnology.com* → **Dashboard** → **Databases → Management** (MySQL Databases):

1. **Database name:** `upwork`, **user:** `upwork`, and a **strong password** (16+ characters; the generator is fine). Click **Create**.
2. Write down the **full names** hPanel shows. They carry your account prefix, e.g. `u123456789_upwork` for both.
3. Host: **`localhost`**, port **`3306`** (the app runs on the same server).

The app creates its tables itself on first start. You don't need to import anything in phpMyAdmin.

## 2. Prepare the secrets (PC)

| Variable | What to use |
| --- | --- |
| `TOKEN_ENCRYPTION_KEY` | **The same value as in your `.env` / Vercel.** It encrypts your Upwork sign-in. With a different key the copied sign-in can't be read (you'd just press Connect Upwork again). |
| `DASHBOARD_PASSWORD` | A **new** password, 12+ characters. |
| `CRON_SECRET` | A random value: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |

## 3. The subdomain

The app must be attached to `upwork.pelicanstechnology.com` **when you create it** (step 4).

* You already created the subdomain in hPanel. If step 4 says the domain is already in use, delete the empty subdomain (hPanel → **Domains → Subdomains**, or the site's **Subdomains** page), then pick it again in step 4.
* DNS: if you followed the old Vercel guide and added a **CNAME `upwork` → `cname.vercel-dns.com`**, delete it (hPanel → **Domains → pelicanstechnology.com → DNS / Nameservers**). If the domain uses Hostinger's nameservers, hPanel adds the right record itself.

## 4. Create the Node.js app

hPanel → **Websites → Add website → Node.js Apps → Import Git repository**:

1. Connect GitHub and pick **pragnesh-kp/upwork-bot**, branch **main**.
2. Domain: **upwork.pelicanstechnology.com**.
3. Build settings (**override** what Hostinger detects):

   | Setting | Value |
   | --- | --- |
   | Framework | Other / Express |
   | Node.js version | **22.x** |
   | Install command | `npm ci` |
   | Build command | `npm run build:hostinger` (`npm run build` also works: it builds both the Vercel and the Hostinger version) |
   | Output directory | `dist` |
   | Entry file / start | `dist/server.mjs` (start command `npm start` does the same) |

4. **Environment variables** (add each one; no quotes needed here):

   | Name | Value |
   | --- | --- |
   | `MYSQL_HOST` | `localhost` |
   | `MYSQL_PORT` | `3306` |
   | `MYSQL_USER` | `u123456789_upwork` (your full user name) |
   | `MYSQL_PASSWORD` | the database password from step 1 |
   | `MYSQL_DATABASE` | `u123456789_upwork` (your full database name) |
   | `DASHBOARD_PASSWORD` | from step 2 |
   | `CRON_SECRET` | from step 2 |
   | `TOKEN_ENCRYPTION_KEY` | from step 2 |
   | `SEARCH_INTERVAL_MINUTES` | `30` (optional) |
   | `STEP_BUDGET_SECONDS` | `20` (optional) |
   | `UPWORK_ACCOUNT_NAME` | only if you set it in `.env` |

5. **Deploy.** The build log should end with `Built dist/server.mjs`.

Open https://upwork.pelicanstechnology.com: you should see the login page. If HTTPS isn't active yet, hPanel → **Security → SSL** → install the free certificate for the subdomain (it can take a few minutes).

If the page shows an error such as `MySQL refused MYSQL_USER / MYSQL_PASSWORD…` or `MYSQL_DATABASE does not exist…`, fix that environment variable and redeploy.

## 5. Stop the Vercel version first

**Only one place may use an Upwork sign-in.** When two places renew the same login, one of them gets signed out. Before step 6:

* Vercel → the project → **Settings → Environment Variables** → delete `CRON_SECRET` and redeploy (its scheduler then stops), **or** delete the Vercel project.
* Also stop the old PC task if it still runs (Administrator PowerShell): `Disable-ScheduledTask -TaskName UpworkJobAlertLite`.
* Disable the job on cron-job.org (step 8 points it at the new address).

## 6. Bring over your data (pick A or B)

### A. Start clean (simplest)

Log in, press **Connect Upwork**, then add your searches with **+ Add filter**. The Upwork sign-in works the same as before: log in on Upwork, click **Allow**, copy the whole `http://127.0.0.1:53682/callback?code=…` address from the tab that fails to load, paste it in the dashboard and press **Finish**.

### B. Copy everything from Turso (filters, saved jobs, Upwork sign-in, scan history)

1. hPanel → **Databases → Remote MySQL** → add **your PC's public IP** (google "what is my ip") for the database from step 1. Note the **host** shown there (a server name or IP, not `localhost`).
2. **PC**: add to `.env` next to the existing `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`. Put the password in **double quotes** if it contains `#` or spaces:

   ```
   MYSQL_HOST=<host from Remote MySQL>
   MYSQL_PORT=3306
   MYSQL_USER=u123456789_upwork
   MYSQL_PASSWORD="your database password"
   MYSQL_DATABASE=u123456789_upwork
   ```

3. **PC**:

   ```powershell
   npm ci
   npm run copy-db
   ```

   It lists each table and its row count. Running it twice is harmless (existing rows are kept).
4. Remove your IP from **Remote MySQL** again. While the `MYSQL_*` lines are in your PC's `.env`, `npm run status` / `npm run filters` on the PC show the Hostinger database.

## 7. Log in

Open **https://upwork.pelicanstechnology.com** and enter `DASHBOARD_PASSWORD`. With option B you should see your filters and jobs, and *Upwork connected as …*. Press **Search now** once to check that the Upwork sign-in works.

## 8. Scheduler: search every 30 minutes

Each filter is searched again **30 minutes** (`SEARCH_INTERVAL_MINUTES`) after its previous search. The server checks **every minute** by itself and runs a due search to the end in the background. A check when nothing is due does nothing (no Upwork request).

Hostinger **stops the app when nobody has used it for a while**. A stopped app can't search, and those scans show up as *missed*. A cron job that opens `/api/ping` every 5 minutes keeps it awake. It needs no secret: it only wakes the app and starts searches that are already due.

### 8a. Hostinger Cron Job (keep-awake, required)

hPanel → **Websites** → *pelicanstechnology.com* → **Advanced → Cron Jobs** → **Custom**:

* **Command:**

  ```
  curl -s -m 30 https://upwork.pelicanstechnology.com/api/ping
  ```

* **Schedule:** every 5 minutes (`*/5 * * * *`).
* Save. After a few minutes, **View output** next to the cron job should show `{"ok":true,"searching":false}` (or `true` while a search runs).

The dashboard's top row shows *Scheduler: built in · checked … ago*, and warns (*Keep-awake*) when no wake-up call came for over 60 minutes. The **Insights** tab shows every scan.

`/api/cron` (with `Authorization: Bearer <CRON_SECRET>`) still works as before. You don't need it on Hostinger.

### 8b. Backups (optional)

* **cron-job.org**: URL `https://upwork.pelicanstechnology.com/api/cron`, every 5 minutes, header `Authorization: Bearer <CRON_SECRET>`, timeout 30 s. If you have an old job calling the `vercel.app` address, **change or delete it** (see step 5).
* **GitHub Actions**: the workflow calls `https://upwork.pelicanstechnology.com`. Set the repository secret `CRON_SECRET` (GitHub → Settings → Secrets and variables → Actions) to the same value. GitHub skips many scheduled runs, so it is a backup only.

## Everyday

| What | How |
| --- | --- |
| Update the bot | Push to `main`. Hostinger redeploys if auto-deploy is on; otherwise press **Redeploy** under the app's **Deployments**. |
| Logs | hPanel → the Node.js app → **Deployments** (build log) and the app's runtime logs. |
| Change a setting | Edit the environment variable in the app's settings, then **Redeploy**. Changing `DASHBOARD_PASSWORD` signs everyone out. |
| Look at the data | hPanel → **Databases → phpMyAdmin**. |
| Upwork asks to sign in again | Press **Reconnect Upwork** on the dashboard. |

## Troubleshooting

| Message | Fix |
| --- | --- |
| `No database is set. On Hostinger: add MYSQL_HOST…` | Step 4.4 environment variables, then Redeploy. |
| `MySQL refused MYSQL_USER / MYSQL_PASSWORD` | Retype the password. In hPanel check that the user belongs to the database. Use the full `u…_` names. |
| `MYSQL_DATABASE does not exist` | Use the full name from hPanel, e.g. `u123456789_upwork`. |
| `Set DASHBOARD_PASSWORD…` | Add `DASHBOARD_PASSWORD` (10+ characters), then Redeploy. |
| `Entry file not found` | Entry file must be `dist/server.mjs`, and the build log must show `Built dist/server.mjs`. |
| Login works but buttons answer `Forbidden` | Open the site through `https://upwork.pelicanstechnology.com`, not an internal preview address. |
| `Cannot decrypt the stored Upwork sign-in` | `TOKEN_ENCRYPTION_KEY` differs from the one used before. Set the old value, or press **Reconnect Upwork**. |
| cron-job.org gets `401` | Its `Authorization` header must be `Bearer ` + the exact `CRON_SECRET`. |

## Alternative: Hostinger VPS

On a VPS (Ubuntu): install Node 22 and MySQL/MariaDB, create the database and user, clone the repository, then `npm ci && npm run build:hostinger`. Put the environment variables from step 4 in a `.env` file next to `package.json`, and run `node dist/server.mjs` under pm2 or systemd with `PORT=3000`. Put nginx in front for `upwork.pelicanstechnology.com` with a Let's Encrypt certificate, and point an **A** record `upwork` to the VPS IP.

## Notes

* Upwork's terms: see the warning at the top of README.md. It applies on Hostinger too.
* All data is kept until you delete it: only **Delete** on a job (or **Remove** on a filter) deletes anything. Nothing is cleared after 30 days. A leftover `RETENTION_DAYS` environment variable is ignored, so you can delete it.
* The database tables are upgraded by themselves on start (new columns for "Deleted from Upwork"); nothing to run by hand.
* Never commit `.env` or `data/`.
