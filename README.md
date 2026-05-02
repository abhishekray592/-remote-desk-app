# 🖥 RemoteDesk — Self-Hosted Remote Support Tool

A lightweight, self-hosted alternative to GetScreen / AnyDesk for IT support teams.
- **Client (USA)** opens a URL → clicks "Start Session" → gets a 6-digit code
- **Support (India)** opens dashboard → enters code → instantly sees client screen live

---

## 📁 File Structure

```
remotedesk/
├── server.js           ← Node.js signaling server
├── package.json        ← Dependencies
└── public/
    ├── client.html     ← Client side (share screen)
    └── support.html    ← Your IT support dashboard
```

---

## ⚡ Quick Local Test (Your Own Computer First)

1. Install Node.js from https://nodejs.org (v16 or higher)
2. Open Terminal / Command Prompt in the remotedesk folder
3. Run:

```bash
npm install
node server.js
```

4. Open **http://localhost:3000/client.html** in Chrome (Tab 1)
5. Open **http://localhost:3000/support.html** in Chrome (Tab 2)
6. Test it — client clicks Start Session, support enters the code

---

## 🌐 WHERE TO HOST — RECOMMENDATION

### ✅ BEST OPTION: DigitalOcean Droplet (~$6/month)

1. Go to https://digitalocean.com → Create Droplet
2. Choose: **Ubuntu 22.04** | **Basic** | **$6/month** (1GB RAM, 1 CPU)
3. Add your SSH key, create the droplet
4. SSH into your server:

```bash
ssh root@YOUR_SERVER_IP
```

5. Install Node.js:

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

6. Upload your files (from your local machine):

```bash
scp -r ./remotedesk root@YOUR_SERVER_IP:/home/remotedesk
```

7. On the server, install and start:

```bash
cd /home/remotedesk
npm install
npm install -g pm2          # keeps it running 24/7
pm2 start server.js --name remotedesk
pm2 startup                 # auto-start on reboot
pm2 save
```

8. Open firewall port 3000:

```bash
ufw allow 3000
ufw allow OpenSSH
ufw enable
```

9. Access your app at:
   - Client page: **http://YOUR_SERVER_IP:3000/client.html**
   - Support page: **http://YOUR_SERVER_IP:3000/support.html**

---

### ✅ OPTION 2: AWS EC2 (Free Tier available)

1. Go to AWS Console → EC2 → Launch Instance
2. Choose: **Ubuntu 22.04** | **t2.micro** (Free Tier)
3. Security Group: Allow TCP port **3000** and **22** from anywhere
4. Connect via SSH, then follow same steps as DigitalOcean above

---

### ✅ OPTION 3: Heroku / Railway (Easiest, no server management)

**Railway.app (Free tier):**
1. Push your code to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Set PORT=3000 in environment variables
4. Done! Railway gives you a URL like `https://remotedesk-production.up.railway.app`

---

## 🔒 IMPORTANT: Add a Password for Your Support Page

Add this to the top of `support.html` inside `<script>` (before everything else):

```javascript
const AGENT_PASSWORD = 'YourTeamPassword123';
const entered = prompt('Enter support agent password:');
if (entered !== AGENT_PASSWORD) {
  document.body.innerHTML = '<h1 style="color:red;text-align:center;margin-top:40vh">Access Denied</h1>';
}
```

---

## 🌍 Custom Domain (Optional)

1. Buy a domain (e.g., `support.yourcompany.com`) from GoDaddy/Namecheap
2. Point DNS A record to your server IP
3. Install Nginx + SSL (free with Let's Encrypt):

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/remotedesk`:

```nginx
server {
    server_name support.yourcompany.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/remotedesk /etc/nginx/sites-enabled/
sudo certbot --nginx -d support.yourcompany.com
sudo systemctl reload nginx
```

Now your links are:
- Client: `https://support.yourcompany.com/client.html`
- Support: `https://support.yourcompany.com/support.html`

---

## 📋 HOW TO USE IN DAILY SUPPORT

### For your team (India side):
1. Open `http://YOUR_SERVER_IP:3000/support.html` in Chrome
2. Call the client, ask them to open `http://YOUR_SERVER_IP:3000/client.html`
3. Ask them to click **"Start Support Session"** and allow screen sharing
4. They'll read you a 6-letter code (e.g., `KT4M9X`)
5. Enter the code on your dashboard → You instantly see their screen

### For your clients (USA side):
- They just need Chrome/Firefox on Windows or Mac
- No software install needed — it runs in the browser
- They click "Start Session", allow screen sharing, read you the code

---

## 🖥 BROWSER SUPPORT

| Browser | Client (Share Screen) | Support (View Screen) |
|---------|----------------------|----------------------|
| Chrome  | ✅ Full support       | ✅ Full support       |
| Firefox | ✅ Full support       | ✅ Full support       |
| Edge    | ✅ Full support       | ✅ Full support       |
| Safari  | ⚠️ Limited (macOS 13+) | ✅ Works             |

**Recommend Chrome for best experience.**

---

## 🔧 FEATURES INCLUDED

- ✅ Real-time screen viewing (WebRTC, peer-to-peer, low latency)
- ✅ 6-digit session codes (easy to share over phone)
- ✅ Built-in text chat between support and client
- ✅ Screenshot button (save client's screen to your PC)
- ✅ Fullscreen viewer mode
- ✅ Live FPS and resolution stats
- ✅ Session timer
- ✅ Auto-disconnect cleanup

---

## 💰 COST SUMMARY

| Option | Monthly Cost | Effort |
|--------|-------------|--------|
| DigitalOcean Droplet | $6/mo | Easy |
| AWS t2.micro (after free year) | ~$10/mo | Easy |
| Railway.app | Free (hobby) | Easiest |
| Your own office PC/server | $0 | Medium |

**Recommendation: Start with Railway.app for free, then move to DigitalOcean if you need more reliability.**

---

## ❓ Troubleshooting

**Client can't share screen?**
→ Must use Chrome/Firefox. Safari has limited support.
→ Check the browser asked for screen permission.

**Support can't see screen?**
→ Both sides need internet. Check if server is reachable.
→ Try opening port 3000 on your server firewall.

**Session code says "not found"?**
→ Client may have refreshed. Ask them to click "Start Session" again and get a new code.

**High latency?**
→ WebRTC is peer-to-peer, so latency depends on internet speeds on both sides, not your server.
