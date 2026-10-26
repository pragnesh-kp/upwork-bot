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

The dashboard only listens on the server itself and has no password of its own, so it is **not** published on the internet by itself. Either open it through an SSH tunnel (below), or give it a password-protected web address (section 6).

```powershell
ssh -N -L 5174:127.0.0.1:5174 root@YOUR_SERVER_IP
```

Leave that window open and browse to **http://127.0.0.1:5174** on your PC. Closing the window only closes your view; the bot keeps running on the server.

## 6. Optional: open it at https://upwork.pelicanstechnologies.com (password protected)

This makes the dashboard reachable from any browser or phone, over HTTPS and behind a username and password. **Caddy** (a free web server) gets the HTTPS certificate automatically and asks for the password. The bot itself keeps listening only on the server.

> In every command and in the config below, replace `upwork.pelicanstechnologies.com` with your exact subdomain if you use a different one.

**a) DNS (hPanel → Domains → your domain → DNS / Nameservers).** Add a record: Type **A**, Name **upwork**, Value **your VPS IPv4** (hPanel → VPS → Overview), TTL 300 or 14400. Check it on the PC; the answer must be your VPS IP:

```powershell
nslookup upwork.pelicanstechnologies.com
```

**b) Install Caddy (server):**

```bash
apt -y install debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt -y install caddy
```

**c) Create the password (server).** Pick a long password (12+ characters); this page can add and remove your filters.

```bash
caddy hash-password
```

Type the password twice. It prints a hash starting with `$2a$`. Copy it.

**d) Write the config (server).** Paste your hash in place of `PASTE_HASH_HERE`, and pick a username (here `admin`):

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
upwork.pelicanstechnologies.com {
	basic_auth {
		admin PASTE_HASH_HERE
	}
	reverse_proxy 127.0.0.1:5174 {
		# The dashboard only accepts requests addressed to 127.0.0.1 (DNS-rebinding protection).
		header_up Host 127.0.0.1:5174
	}
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
}
EOF
nano /etc/caddy/Caddyfile        # paste the hash, save with Ctrl+O, Enter, Ctrl+X
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

**e) Firewall (server).** Open only SSH and the web ports. Never open 5174.

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

If hPanel → VPS → **Firewall** has rules turned on, allow TCP 80 and 443 there too.

**f) Open it.** Browse to **https://upwork.pelicanstechnologies.com**. The browser asks for the username and password, then shows the dashboard. The first visit can take up to a minute while Caddy fetches the certificate.

If it doesn't load, `journalctl -u caddy -n 50 --no-pager` shows why. The usual causes are DNS not pointing to the VPS yet, or ports 80/443 blocked.

**Change the password later:** run `caddy hash-password` again, replace the hash in `/etc/caddy/Caddyfile`, then `systemctl reload caddy`.

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
