# Deploying on a Hostinger VPS

Run the bot 24/7 on a Linux VPS (Hostinger KVM 1 or higher, Ubuntu 24.04). It runs as a `systemd` service: it starts at boot, searches every ~30 minutes, and restarts itself after a crash or reboot.

> **Web / shared hosting plans won't work.** They stop long-running background programs. You need a VPS.

You run the commands in boxes marked **PC** in PowerShell on your Windows PC, and the ones marked **server** in an SSH session on the VPS (`ssh root@YOUR_SERVER_IP`; the IP and root password are in hPanel → VPS).

## 1. Install Node.js 24 (server)

```bash
apt update && apt -y upgrade
apt -y install git curl
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt -y install nodejs
node -v    # must print v24.x (v22.18+ also works)
```

## 2. Get the code from your private GitHub repo (server)

The repo is private, so give the server a read-only **deploy key**:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/upwork_bot_deploy
cat ~/.ssh/upwork_bot_deploy.pub
```

Copy the printed line to GitHub: repo → **Settings → Deploy keys → Add deploy key** (leave "Allow write access" off). Then:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-upwork-bot
  HostName github.com
  User git
  IdentityFile ~/.ssh/upwork_bot_deploy
EOF
git clone github-upwork-bot:Pelicans-Technologies/upwork-bot.git /opt/upwork-bot
cd /opt/upwork-bot
npm ci --omit=dev
```

## 3. Copy your settings and Upwork sign-in from the PC

Your `.env`, `filters.json` and `data\` folder are deliberately **not** on GitHub (they hold your encryption key and Upwork sign-in). Copy them from the PC.

**First stop the bot on your PC.** Only one copy may use the Upwork sign-in: when two machines refresh the same login, one of them gets signed out. In an **Administrator** PowerShell:

```powershell
Disable-ScheduledTask -TaskName UpworkJobAlertLite   # if you installed the background task
# and press Ctrl+C in any window running "npm run watch"
```

Then copy (**PC**, normal PowerShell):

```powershell
cd C:\Users\Admin\Desktop\upwork-bot\job-alert-lite
ssh root@YOUR_SERVER_IP "mkdir -p /opt/upwork-bot/data"
scp .env filters.json root@YOUR_SERVER_IP:/opt/upwork-bot/
scp data\upwork-oauth.enc data\discovery.json data\jobs.sqlite root@YOUR_SERVER_IP:/opt/upwork-bot/data/
```

(`data\jobs.sqlite` is optional. It keeps the jobs you already have. Without it, the server starts from zero.)

## 4. Start the service (server)

```bash
adduser --system --group --home /opt/upwork-bot --no-create-home upworkbot
chown -R upworkbot:upworkbot /opt/upwork-bot
chmod 600 /opt/upwork-bot/.env /opt/upwork-bot/data/*
cp /opt/upwork-bot/deploy/upwork-job-alert.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now upwork-job-alert
systemctl status upwork-job-alert --no-pager
```

Watch the first search finish:

```bash
journalctl -u upwork-job-alert -f     # Ctrl+C to stop watching (the bot keeps running)
```

You should see `watch: search finished … "status":"ok"` within a few minutes.

## 5. Open the dashboard (PC)

The dashboard only listens on the server itself and has no password, so it is **not** published on the internet. Open it through an SSH tunnel:

```powershell
ssh -N -L 5174:127.0.0.1:5174 root@YOUR_SERVER_IP
```

Leave that window open and browse to **http://127.0.0.1:5174** on your PC. Closing the window only closes your view; the bot keeps running on the server.

## Everyday commands (server)

| What | Command |
| --- | --- |
| Status | `systemctl status upwork-job-alert --no-pager` |
| Live log | `journalctl -u upwork-job-alert -f` (or `tail -f /opt/upwork-bot/data/app.log`) |
| Restart (after editing `.env`) | `systemctl restart upwork-job-alert` |
| Stop / start | `systemctl stop upwork-job-alert` / `systemctl start upwork-job-alert` |
| Update to the latest code | `cd /opt/upwork-bot && git pull && npm ci --omit=dev && chown -R upworkbot:upworkbot . && systemctl restart upwork-job-alert` |

Filters added or removed in the dashboard are saved on the server (`/opt/upwork-bot/filters.json`) and survive restarts and updates.

## If Upwork asks you to sign in again

If the log shows `Upwork authorization expired or was revoked`, sign in again **through a tunnel** so Upwork's redirect reaches the server.

On the **PC**:

```powershell
ssh -L 53682:127.0.0.1:53682 root@YOUR_SERVER_IP
```

Then in that SSH session (**server**):

```bash
cd /opt/upwork-bot
sudo -u upworkbot npm run connect
```

Copy the printed `https://www.upwork.com/...` link into your PC's browser and sign in. Upwork redirects to `127.0.0.1:53682`, the tunnel carries it to the server, and the bot saves the new sign-in. Then run `systemctl restart upwork-job-alert`.

## Notes

* The server clock is UTC. The dashboard shows dates and times in your browser's time zone.
* Upwork's terms: see the warning at the top of README.md. The same risk applies on a server.
* Keep the repo **private**, and never commit `.env` or `data/`.
