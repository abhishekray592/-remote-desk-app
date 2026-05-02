/**
 * client-helper.js
 * Run this on the CLIENT machine: node client-helper.js
 *
 * It starts a local WebSocket server on port 3001.
 * client.html connects to it and forwards remote-control events.
 * This helper injects those events into the OS (mouse + keyboard).
 *
 * Platform support:
 *   Windows  — scripts/mouse-control.ps1 via persistent PowerShell process
 *   macOS    — xdotool-style via cliclick (brew install cliclick) + osascript
 *   Linux    — xdotool
 */

'use strict';

const WebSocket = require('ws');
const { spawn, execSync } = require('child_process');
const os = require('os');
const path = require('path');

const PLATFORM = os.platform();
const WS_PORT = 3001;

// ── Screen resolution detection ───────────────────────────────────────────────
let screenW = 1920, screenH = 1080;

try {
  if (PLATFORM === 'win32') {
    const out = execSync(
      'powershell -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \'$($s.Width)x$($s.Height)\'"',
      { timeout: 5000 }
    ).toString().trim();
    const [w, h] = out.split('x').map(Number);
    if (w && h) { screenW = w; screenH = h; }
  } else if (PLATFORM === 'linux') {
    const out = execSync("xrandr | grep -w connected | grep -oP '\\d+x\\d+' | head -1", { timeout: 3000 }).toString().trim();
    const [w, h] = out.split('x').map(Number);
    if (w && h) { screenW = w; screenH = h; }
  } else if (PLATFORM === 'darwin') {
    const out = execSync("system_profiler SPDisplaysDataType | grep Resolution | head -1", { timeout: 3000 }).toString();
    const m = out.match(/(\d+) x (\d+)/);
    if (m) { screenW = parseInt(m[1]); screenH = parseInt(m[2]); }
  }
} catch (_) { /* use defaults */ }

console.log(`[helper] Platform: ${PLATFORM}  Screen: ${screenW}x${screenH}`);

// ── Windows: persistent PowerShell injector ───────────────────────────────────
let psProc = null;
let psStdoutBuf = '';
let lastClipboard = '';

function startWindowsInjector() {
  const script = path.join(__dirname, 'scripts', 'mouse-control.ps1');
  psProc = spawn('powershell.exe', [
    '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script
  ], { windowsHide: true });
  psProc.stderr.on('data', d => process.stderr.write('[PS] ' + d.toString()));
  psProc.stdout.on('data', d => {
    psStdoutBuf += d.toString();
    let idx;
    while ((idx = psStdoutBuf.indexOf('\n')) !== -1) {
      const line = psStdoutBuf.slice(0, idx).trim();
      psStdoutBuf = psStdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'clipboard') handleClipboardFromOS(msg.text);
      } catch (_) {}
    }
  });
  psProc.on('exit', () => {
    console.log('[helper] PowerShell exited — restarting in 1s');
    setTimeout(startWindowsInjector, 1000);
  });
  console.log('[helper] PowerShell injector started');
}

function sendPS(cmd) {
  if (psProc && !psProc.killed && psProc.stdin.writable) {
    psProc.stdin.write(JSON.stringify(cmd) + '\n');
  }
}

function handleClipboardFromOS(text) {
  if (text === lastClipboard) return;
  lastClipboard = text;
  // Broadcast to all connected browsers
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'clipboard-from-os', text }));
    }
  });
  console.log('[helper] clipboard → browser (' + text.length + ' chars)');
}

// Poll OS clipboard every 1.5s on Windows
if (PLATFORM === 'win32') {
  setInterval(() => sendPS({ type: 'get-clipboard' }), 1500);
}

// ── macOS/Linux: key name mapping ─────────────────────────────────────────────
const XDOTOOL_KEYS = {
  'Enter': 'Return', 'Escape': 'Escape', 'Tab': 'Tab', 'Backspace': 'BackSpace',
  'Delete': 'Delete', 'Insert': 'Insert', 'Home': 'Home', 'End': 'End',
  'PageUp': 'Prior', 'PageDown': 'Next',
  'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
  'F1':'F1','F2':'F2','F3':'F3','F4':'F4','F5':'F5','F6':'F6',
  'F7':'F7','F8':'F8','F9':'F9','F10':'F10','F11':'F11','F12':'F12',
  'CapsLock': 'Caps_Lock', 'NumLock': 'Num_Lock', 'ScrollLock': 'Scroll_Lock',
  'PrintScreen': 'Print', 'Pause': 'Pause',
  ' ': 'space'
};

function xdotoolKey(event) {
  let k = event.key;
  if (k === ' ') k = 'space';
  else if (k.length === 1) k = k; // literal char
  else k = XDOTOOL_KEYS[k] || k;

  let combo = '';
  if (event.ctrl)  combo += 'ctrl+';
  if (event.alt)   combo += 'alt+';
  if (event.shift && k.length > 1) combo += 'shift+';
  combo += k;
  return combo;
}

// ── Event injection ───────────────────────────────────────────────────────────
function injectEvent(event) {
  // Convert normalised coords → screen pixels
  if (event.nx !== undefined) {
    event.x = Math.round(event.nx * screenW);
    event.y = Math.round(event.ny * screenH);
  }

  if (PLATFORM === 'win32') {
    sendPS(event);
    return;
  }

  if (PLATFORM === 'linux') {
    injectLinux(event);
  } else if (PLATFORM === 'darwin') {
    injectMac(event);
  }
}

function injectLinux(ev) {
  const { exec } = require('child_process');
  switch (ev.type) {
    case 'mousemove':
      exec(`xdotool mousemove ${ev.x} ${ev.y}`);
      break;
    case 'mousedown': {
      const b = ev.button === 0 ? 1 : ev.button === 2 ? 3 : 2;
      exec(`xdotool mousemove ${ev.x} ${ev.y} mousedown ${b}`);
      break;
    }
    case 'mouseup': {
      const b = ev.button === 0 ? 1 : ev.button === 2 ? 3 : 2;
      exec(`xdotool mouseup ${b}`);
      break;
    }
    case 'wheel':
      if (ev.deltaY < 0) exec('xdotool click 4');
      else               exec('xdotool click 5');
      break;
    case 'keydown': {
      const k = xdotoolKey(ev);
      exec(`xdotool key ${k}`);
      break;
    }
  }
}

function injectMac(ev) {
  const { exec } = require('child_process');
  switch (ev.type) {
    case 'mousemove':
      exec(`cliclick m:${ev.x},${ev.y}`);
      break;
    case 'mousedown':
      if (ev.button === 0) exec(`cliclick dd:${ev.x},${ev.y}`);
      else exec(`cliclick rc:${ev.x},${ev.y}`);
      break;
    case 'mouseup':
      if (ev.button === 0) exec(`cliclick du:${ev.x},${ev.y}`);
      break;
    case 'wheel':
      // cliclick doesn't support scroll well; fall back to osascript
      exec(`osascript -e 'tell application "System Events" to scroll down'`);
      break;
    case 'keydown': {
      // Use osascript for key combos
      const key = ev.key.length === 1 ? ev.key : XDOTOOL_KEYS[ev.key] || ev.key;
      exec(`osascript -e 'tell application "System Events" to key code ${key}'`);
      break;
    }
  }
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log(`[helper] WebSocket listening on ws://localhost:${WS_PORT}`);
  console.log(`[helper] Open http://localhost:3000/client.html in your browser`);
  console.log(`[helper] Share the session code with your support agent`);
  if (PLATFORM === 'win32') startWindowsInjector();
});

wss.on('connection', (ws, req) => {
  console.log(`[helper] Browser connected from ${req.socket.remoteAddress}`);

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (event.type === 'clipboard-to-os') {
        // Update lastClipboard FIRST so the next poll won't echo this back
        lastClipboard = event.text || '';
        sendPS({ type: 'set-clipboard', text: event.text || '' });
        console.log('[helper] clipboard ← browser (' + (event.text || '').length + ' chars)');
        return;
      }
      if (event.type !== 'mousemove') console.log('[helper] inject:', event.type, JSON.stringify(event));
      injectEvent(event);
    } catch (e) {
      console.error('[helper] bad message:', e.message);
    }
  });

  ws.on('close', () => console.log('[helper] Browser disconnected'));
});

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[helper] Port ${WS_PORT} already in use. Is client-helper already running?`);
    process.exit(1);
  }
});

process.on('SIGINT', () => {
  console.log('\n[helper] Shutting down');
  if (psProc) psProc.kill();
  process.exit(0);
});
