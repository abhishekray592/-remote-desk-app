# RemoteDesk — Project Notes

Self-hosted remote support tool. A support agent views and controls a client's
desktop from a browser, while screen video flows peer-to-peer over WebRTC.

---

## 1. High-Level Architecture

Three components, each running on a different host:

```
┌─────────────────────┐         ┌────────────────────┐         ┌──────────────────────┐
│ SUPPORT AGENT       │         │ SIGNALING SERVER   │         │ CLIENT (end user)    │
│ Browser             │◄───────►│ Node.js + Socket.IO│◄───────►│ Browser              │
│ support.html        │  socket │ server.js          │  socket │ client.html          │
│                     │         │ port 3000          │         │                      │
│                     │         │                    │         │      ▲ ws://3001     │
│                     │         │                    │         │      ▼               │
│                     │         │                    │         │ client-helper.js     │
│                     │         │                    │         │  ▲ stdin/stdout      │
│                     │         │                    │         │  ▼                   │
│                     │         │                    │         │ mouse-control.ps1    │
│                     │         │                    │         │ (Win32 SendInput)    │
└─────────────────────┘         └────────────────────┘         └──────────────────────┘
        ▲                                                              ▲
        │     WebRTC peer-to-peer (video stream, no media on server)    │
        └──────────────────────────────────────────────────────────────┘
```

- **Signaling server** (`server.js`) only relays messages — no media passes through it.
- **WebRTC** carries the screen video directly between the two browsers (with STUN for NAT traversal).
- **client-helper.js** is the bridge between the browser sandbox and the OS — it
  receives remote-control events from the browser via a local WebSocket and
  injects them into the OS using Win32 `SendInput` (Windows), `xdotool`
  (Linux), or `cliclick` + `osascript` (macOS).

---

## 2. Files

### `server.js` — Signaling server
Express + Socket.IO + static file serving on port 3000.

Socket events handled:
- `create-session` (client only) → generates a 6-char code, stores
  `{clientId, supportId: null, createdAt}` in an in-memory `sessions` Map,
  emits `session-created` back.
- `join-session` (support only) → looks up code, attaches `supportId`,
  emits `support-joined` to the client and `session-joined` to support.
  Errors: code not found, another agent already attached.
- `webrtc-offer` / `webrtc-answer` / `webrtc-ice` → relays the SDP/ICE between
  the two peers (server never inspects them).
- `chat` → broadcasts to the other peer in the session.
- `remote-event` → relayed only when sender's socket id matches `supportId`.
- `clipboard-sync` → bidirectional relay between client and support.
- `end-session` → only the support side may force-end; emits
  `session-ended-by-support` to the client and deletes the session.
- `disconnect` → emits `peer-disconnected` to the other side and removes the session.

Background: `setInterval` cleans up sessions older than 2 hours.

Health endpoint: `GET /health` returns `{status, sessions, timestamp}`.

### `public/client.html` — End user's screen-sharing page
The page the person being helped opens.

State: `socket`, `peerConn`, `localStream`, `sessionCode`, `helperWs`, `helperReady`.

Flow:
1. Page loads → `connectHelper()` runs immediately, opens `ws://localhost:3001`
   to the local helper. Auto-reconnects every 5s on failure.
2. User clicks **Start Session** → `getDisplayMedia()` runs *first* inside
   the user-gesture handler (so the OS permission prompt actually appears),
   *then* the socket connects and emits `create-session`. This avoids a
   black-preview race condition where the support agent could join before
   the screen-share dialog was approved.
3. On `support-joined` → `startWebRTC()` creates the `RTCPeerConnection`,
   adds the screen-share tracks, sends an offer through the signaling server.
4. On `remote-event` from socket → forwards to `helperWs` if connected.
5. On `clipboard-sync` from socket → forwards as `clipboard-to-os` to helper.
6. `helperWs.onmessage` handles `clipboard-from-os` and emits `clipboard-sync`
   back through the socket (so a copy on the client desktop syncs to support).
7. On `session-ended-by-support` → tears down everything via `endSession()`.

### `public/support.html` — Support agent dashboard
The page the support technician opens.

State: `socket`, `peerConn`, `sessionCode`, `controlActive`, `lastClipboard`,
plus stat polling intervals.

Flow:
1. Page loads → `initSocket()` connects.
2. Agent enters the 6-digit code → `connectSession()` emits `join-session`.
3. On `webrtc-offer` from socket → `handleOffer()` creates the
   `RTCPeerConnection`, sets the remote description, sends back an answer.
4. On `ontrack` → attaches the incoming MediaStream to `#remoteVideo`,
   shows the toolbar, starts the timer and `startStatsPolling()` (FPS, resolution).
5. **Remote control** (`toggleControl`):
   - Adds `mousemove`/`mousedown`/`mouseup`/`wheel` listeners on the video
     element, plus `keydown`/`keyup` on the document.
   - `getVideoNormCoords()` converts mouse coordinates inside the rendered
     video area to normalized `[0,1]` values, accounting for letterbox/pillarbox
     from `object-fit: contain`.
   - Mousemove is throttled to ~60 events/sec (16 ms).
   - `keydown` ignores typing inside sidebar inputs.
   - **Esc** exits control mode.
   - The cursor over the video is `default` (was `crosshair` — looked like a
     plus sign and confused users).
6. **Clipboard sync** (`pollClipboard` + `manualClipboardSync`):
   - Polls `navigator.clipboard.readText()` every 1.5 s when the window has focus.
   - Manual `📋` button in the toolbar pushes the current clipboard immediately
     (also doubles as a way to trigger the browser permission prompt with a
     real user gesture).
   - On incoming `clipboard-sync` → writes via `navigator.clipboard.writeText`.
   - `lastClipboard` tracks the most recent value to prevent echo loops.
7. `disconnectSession()` emits `end-session` first, then disconnects the socket.

### `client-helper.js` — Local OS bridge (runs on the client PC)
Node.js process that bridges the browser sandbox and the OS.

What it does:
- Starts a WebSocket server on port 3001.
- On Windows, spawns `scripts/mouse-control.ps1` as a persistent PowerShell
  child process (`{ windowsHide: true, -WindowStyle Hidden }` so no console
  window steals focus).
- Forwards browser events to the PS process over its stdin as JSON lines.
- Reads PS stdout for clipboard updates from the OS.
- On Linux/macOS, uses `xdotool` / `cliclick` / `osascript` per event.
- Auto-restarts the PS process if it exits.
- Logs every non-mousemove event for debugging.
- Polls OS clipboard every 1.5 s by sending `{type:'get-clipboard'}` to PS.
- When browser sends `{type:'clipboard-to-os'}`, sets `lastClipboard` first
  (so the next poll won't echo back) then forwards as `set-clipboard` to PS.

### `scripts/mouse-control.ps1` — Windows input injector
Persistent PowerShell process that reads JSON commands from stdin and injects
events using the modern `SendInput` Win32 API.

Key implementation details:
- Sets `[Console]::OutputEncoding = UTF-8` so JSON survives the pipe to Node.
- Loads `System.Windows.Forms` for `SendKeys` and `Clipboard`.
- Defines `WinInput` C# class via `Add-Type` with:
  - `[StructLayout(LayoutKind.Sequential)]` `MOUSEINPUT` and `INPUT` structs
    that match the Win32 layout on both 32-bit and 64-bit (the CLR adds the
    correct padding before `IntPtr` automatically).
  - `MouseAbs(ax, ay, flags, data)` — `MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE`
    using normalized `[0..65535]` coordinates. **No screen-resolution
    detection needed**, which sidesteps DPI-scaling bugs.
  - `MouseEvent(flags, data)` — for button up/down and wheel events at the
    current cursor position.
- Reads stdin with `StreamReader.ReadLine()` in an infinite loop.
- Command types:
  - `mousemove` → `MouseAbs(nx*65535, ny*65535, 0, 0)`
  - `mousedown` → move + LDOWN/MDOWN/RDOWN based on button (0/1/2)
  - `mouseup`   → LUP/MUP/RUP
  - `wheel`     → fixed ±120 (WHEEL_DELTA) per scroll, sign from browser deltaY
  - `keydown`   → translates browser key name to SendKeys format with
    modifier prefixes (`^` ctrl, `%` alt, `+` shift). Special chars
    `+^%~{}()[]` are escaped.
  - `get-clipboard` → reads `[System.Windows.Forms.Clipboard]::GetText()`,
    writes `{type:'clipboard',text:...}` JSON line to stdout.
  - `set-clipboard` → `[System.Windows.Forms.Clipboard]::SetText($cmd.text)`.
- Writes a `[PS] Ready - SendInput injector active` line to stderr at startup
  so the helper terminal confirms successful Add-Type compilation.

### `package.json`
- Dependencies: `express`, `socket.io`, `ws`.
- Dev: `nodemon`.
- Scripts: `start` (`node server.js`), `dev` (`nodemon server.js`).
- Engines: `node >=16`.

### `.gitignore`
Excludes `node_modules/`, `.env*`, OS junk, `.vscode/`, `.idea/`, `.claude/`, logs.

---

## 3. UI / Visual Design

Both pages use **IBM Plex Sans** for body and **IBM Plex Mono** for code/codes,
loaded from Google Fonts.

### `public/index.html` — Landing page
Two cards: "Need help?" → links to `client.html`; "Provide support" → links
to `support.html`.

### `public/client.html` UI
- Dark theme with cyan accents (`--accent: #00d4ff`).
- Logo: `Tech` + cyan `sara` wordmark with a small gradient-square icon.
- **Start panel** (initial state): three numbered steps, single primary
  "🔴 Start Support Session" button.
- **Session panel** (after Start clicked):
  - Large dashed-border code box showing the 6-digit session code
    (44 px IBM Plex Mono, 8 px letter-spacing). Click to copy.
  - Status bar with pulsing dot (yellow "waiting" / green "connected").
  - Session timer (`MM:SS`).
  - **Helper status indicator** (small text):
    - Gray "checking…" before the WS attempt.
    - 🟢 Green "Helper: connected — remote control ready" when the local
      WebSocket to `client-helper.js` is open.
    - 🔴 Red "Helper: not running — remote control disabled" otherwise.
  - 16:9 screen-share preview box with letterboxed video (`object-fit: contain`)
    and a small "YOUR SCREEN (preview)" overlay label.
  - Chat panel (160 px scrollable) with text input + Send button.
  - Red "⏹ End Session" button.
  - Privacy note at bottom about peer-to-peer encryption.

### `public/support.html` UI
- Even darker theme with blue accents (`--accent: #58a6ff`).
- **Top bar** (52 px): logo + "SUPPORT AGENT" badge, server-status dot,
  session timer.
- **Two-column layout** below: viewer pane (left, fills space) and
  320 px sidebar (right).
- **Viewer pane**:
  - Black background with the remote video (`object-fit: contain`).
  - Empty state: large grey monitor emoji + "No Active Session" + hint text.
  - Floating toolbar (centered top, only visible during session):
    - Session label (`Session: ABC123`).
    - ⛶ Fullscreen
    - 📷 Screenshot (downloads PNG via canvas)
    - 🖱 Remote control toggle (turns blue when active)
    - 📋 Manual clipboard push
    - Quality label ("HD"/"SD" with colored dot from RTC stats)
  - Red **"REMOTE CONTROL ACTIVE — Press ESC to exit"** badge (centered
    bottom) that appears whenever control mode is on.
- **Sidebar**:
  - **Connect panel**: 6-character code input (auto-uppercase), Connect button,
    error message slot, hidden Disconnect button.
  - **Session info** (revealed when active): connection status, session code,
    stream-quality label.
  - **Stats grid**: large FPS number and resolution.
  - **Chat section**: header, scrollable message bubbles (left-aligned for
    client, right-aligned blue for self, centered italic for system),
    input row at bottom with circular ↑ send button.
- **Toast notifications** (bottom center, 3-second fade) for events like
  "Client disconnected", "Screenshot saved!", "Clipboard synced from client".

---

## 4. Feature Inventory

### Session lifecycle
- 6-character alphanumeric session codes (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` —
  no ambiguous characters like 0/O, 1/I).
- Server-side join validation: code must exist; only one support per session.
- 2-hour idle cleanup.
- Only the support agent can force-end via `end-session`.
- Disconnect detection on either side cleans up the session.

### Screen sharing
- WebRTC `getDisplayMedia()` with `frameRate: 15`, ideal `1920x1080`, no audio.
- STUN servers: Google + Cloudflare (no TURN — works on most home networks
  but may fail behind symmetric NAT).
- The client requests screen share *before* the socket session is created,
  inside the user-gesture context, so the browser permission dialog reliably
  appears.
- Stream end (user clicks "Stop sharing" in the browser's overlay) auto-ends
  the session.
- Letterbox-aware coordinate mapping ensures clicks land on the right pixel
  even when the video aspect ratio doesn't match the viewer pane.

### Remote control
- Mouse: move, left/middle/right buttons, wheel scroll.
- Keyboard: all printable characters, special keys (Enter, Tab, arrows, F1–F12,
  etc.), modifiers (Ctrl/Alt/Shift) including combos like Ctrl+C / Alt+Tab.
- Throttled mousemove (~60 events/sec).
- Right-click context menu suppressed in control mode.
- Esc exits control mode (and is *not* sent as a key event).
- Inputs in the support sidebar (chat, code box) are exempt — typing there
  doesn't go to the client.
- Server enforces that only the session's `supportId` can send remote events.
- **Coordinates**: support sends normalized `{nx, ny}` in `[0,1]`; PS1
  multiplies by 65535 and uses `MOUSEEVENTF_ABSOLUTE` — no screen-resolution
  detection on the client side, so DPI scaling never breaks alignment.

### Bidirectional clipboard sync
- Client → support: `client-helper.js` polls `[System.Windows.Forms.Clipboard]`
  every 1.5 s, sends changes through `helper WS → socket → support browser →
  navigator.clipboard.writeText()`.
- Support → client: `support.html` polls `navigator.clipboard.readText()` every
  1.5 s when focused, plus the manual 📋 button. Sends through
  `socket → client browser → helper WS → PowerShell Set-Clipboard`.
- Loop prevention: each side tracks `lastClipboard` and skips identical
  values; the helper updates `lastClipboard` *before* setting the OS clipboard
  so the next poll doesn't echo back.

### Chat
- Free-form text in both directions, timestamped by the server.
- Local echo on the sender side, separate styling for self vs peer vs system.

### Cross-platform support
- **Windows**: persistent PowerShell process + Win32 `SendInput`.
- **Linux**: `xdotool` (apt-get install xdotool).
- **macOS**: `cliclick` (brew install cliclick) + `osascript` for fallbacks.

---

## 5. Bugs Fixed During Development

In order, with brief root cause:

1. **Black screen-share preview** — `getDisplayMedia()` was being called
   inside the `socket.on('session-created')` callback, an async context that
   no longer counts as a user gesture, so the browser silently denied access
   if the support agent joined fast enough. *Fix:* call `getDisplayMedia()`
   directly inside the Start-Session button handler with `await`, then create
   the socket session.

2. **`npm install` blocked by execution policy** — fixed by invoking
   `node.exe` against `npm-cli.js` directly, bypassing the npm.ps1 wrapper.

3. **Mouse control not working at all** — the original `mouse-control.ps1`
   used the deprecated `mouse_event` Win32 API and pixel coordinates derived
   from `Screen.PrimaryScreen.Bounds`, which returns *logical* (DPI-scaled)
   pixels while `SetCursorPos` uses physical pixels in DPI-aware processes —
   alignment was off on any display with scaling. *Fix:* rewrote PS1 to use
   modern `SendInput` with `MOUSEEVENTF_ABSOLUTE` and `[0..65535]` normalized
   coordinates, eliminating screen-resolution detection.

4. **Crosshair cursor looked like a plus sign** — `cursor: crosshair` was
   confusing in the support viewer. *Fix:* switched to `cursor: default`.

5. **PowerShell child process stole keyboard focus** — the spawned PS console
   window was visible. *Fix:* added `windowsHide: true` to the `spawn()`
   options *and* `-WindowStyle Hidden` to the PowerShell argv.

6. **PS1 syntax error from corrupted em dash** — saving the file with an
   em-dash character (`—`) ended up encoded as Windows-1252 bytes that PS
   parsed as invalid string termination. *Fix:* use ASCII hyphens in PS1
   string literals.

7. **F1 SendKeys mapping** — `'F1' = 'F1'` was missing the braces required
   by `SendKeys`. *Fix:* `'F1' = '{F1}'`.

8. **Wheel scroll overshoot** — `[int](-deltaY * 3)` made the scroll
   distance unpredictable and risked cast errors with `uint dwData`. *Fix:*
   send a fixed `±120` (`WHEEL_DELTA`) per scroll event using the sign of
   `deltaY` only, with `int mouseData` in the struct so negatives marshal
   cleanly.

9. **Clipboard JSON not parsed by Node** — PowerShell 5.1 defaults to
   non-UTF-8 stdout encoding, so multibyte characters in clipboard text
   would garble the JSON. *Fix:* set
   `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` at PS startup
   and use `[System.Windows.Forms.Clipboard]` direct API instead of the
   `Get-Clipboard`/`Set-Clipboard` cmdlets (which can be flaky under
   `-NonInteractive`).

10. **Git commit attributed to the wrong GitHub account** — the email in
    the session context belonged to a different user. *Fix:* updated
    `user.email` and `user.name`, ran `git commit --amend --reset-author`,
    force-pushed.

---

## 6. Running Locally

```powershell
# In the remotedesk folder
node server.js          # signaling server on :3000
node client-helper.js   # only on the client PC; Windows-only PS injector
```

Open in browsers:
- Client: `http://localhost:3000/client.html`
- Support: `http://localhost:3000/support.html`

For two PCs on the same LAN, replace `localhost` with the server PC's LAN IP
(e.g. `http://192.168.x.x:3000/...`). Open inbound port 3000 in the firewall:

```powershell
# Run as Administrator
New-NetFirewallRule -DisplayName "RemoteDesk Server (3000)" `
  -Direction Inbound -Protocol TCP -LocalPort 3000 `
  -Action Allow -Profile Private,Domain
```

---

## 7. Running on Render (Cloud Deploy)

The signaling server is deployed at `https://remote-desk-7isv.onrender.com`.

The architecture *requires* `client-helper.js` to keep running on the local
client PC — only the signaling server runs in the cloud. The helper has to
inject OS-level events, which is impossible from a remote container.

### Important constraint over HTTPS
- `navigator.clipboard.readText()` / `writeText()` need a "secure context".
  Render gives you HTTPS, so this works for the support side from the cloud URL.
- `ws://localhost:3001` (helper) from an HTTPS page is allowed in modern
  Chrome/Firefox under the "potentially trustworthy origin" rule, but Safari
  and some hardened configurations may block it (mixed content).

### Deployment steps used
1. Pushed code to `https://github.com/abhishekray592/-remote-desk-app`.
2. Render: Web Service → connect repo → build `npm install` → start
   `node server.js` → public URL provisioned automatically.

---

## 8. Known Limitations

- **No TURN server**: WebRTC may fail on symmetric NAT or restrictive
  corporate networks. Adding a TURN server (like coturn) would fix this.
- **Single support per session**: server rejects a second `join-session`
  with the same code.
- **Sessions are in-memory**: restarting the server kills all live sessions.
- **No authentication**: anyone with a session code can join. Code is
  6 chars from a 32-char alphabet → 32^6 ≈ 1B combinations. For higher
  security, add agent login.
- **Clipboard sync over LAN HTTP** doesn't work on the support side because
  `navigator.clipboard` requires a secure context (HTTPS / localhost). Mouse
  and keyboard control are unaffected.
- **UAC-elevated windows on Windows**: a non-elevated helper can't inject
  input into elevated windows (UIPI). To control the UAC prompt itself or
  admin apps, the helper must be launched as Administrator.
- **No file transfer, no recording, no audio**.

---

## 9. Repository

- GitHub: `https://github.com/abhishekray592/-remote-desk-app`
- Default branch: `main`
- Author identity: `Abhishek Ray <abhishek.ray@techsarasolutions.com>`

Standard update flow:
```powershell
git add .
git commit -m "describe the change"
git push
```
