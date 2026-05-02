/**
 * RemoteDesk - Signaling Server
 * Handles WebRTC session setup between Client and Support Agent
 * Requires: express, socket.io
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size, timestamp: new Date().toISOString() });
});

// Active sessions store: code -> { clientId, supportId, createdAt }
const sessions = new Map();

function generateSessionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Clean up stale sessions older than 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > 2 * 60 * 60 * 1000) {
      sessions.delete(code);
      console.log(`[Cleanup] Removed stale session: ${code}`);
    }
  }
}, 10 * 60 * 1000);

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── CLIENT: Create a new session ──────────────────────────────────────────
  socket.on('create-session', () => {
    let code;
    do { code = generateSessionCode(); } while (sessions.has(code));

    sessions.set(code, {
      clientId: socket.id,
      supportId: null,
      createdAt: Date.now()
    });

    socket.join(code);
    socket.sessionCode = code;
    socket.role = 'client';

    socket.emit('session-created', { code });
    console.log(`[Session] Created: ${code} by ${socket.id}`);
  });

  // ── SUPPORT: Join an existing session ─────────────────────────────────────
  socket.on('join-session', ({ code }) => {
    const session = sessions.get(code.toUpperCase());
    if (!session) {
      socket.emit('join-error', { message: 'Session code not found. Ask client to refresh and share a new code.' });
      return;
    }
    if (session.supportId) {
      socket.emit('join-error', { message: 'Another agent is already in this session.' });
      return;
    }

    session.supportId = socket.id;
    socket.join(code);
    socket.sessionCode = code;
    socket.role = 'support';

    // Tell client that support has connected → client starts WebRTC offer
    io.to(session.clientId).emit('support-joined');
    socket.emit('session-joined', { code });
    console.log(`[Session] Support ${socket.id} joined: ${code}`);
  });

  // ── WebRTC SIGNALING ──────────────────────────────────────────────────────
  socket.on('webrtc-offer', ({ code, offer }) => {
    socket.to(code).emit('webrtc-offer', { offer });
  });

  socket.on('webrtc-answer', ({ code, answer }) => {
    socket.to(code).emit('webrtc-answer', { answer });
  });

  socket.on('webrtc-ice', ({ code, candidate }) => {
    socket.to(code).emit('webrtc-ice', { candidate });
  });

  // ── CHAT MESSAGES ─────────────────────────────────────────────────────────
  socket.on('chat', ({ code, text, from }) => {
    socket.to(code).emit('chat', { text, from, time: new Date().toLocaleTimeString() });
  });

  // ── REMOTE CONTROL EVENTS (mouse / keyboard from support) ─────────────────
  socket.on('remote-event', ({ code, event }) => {
    const session = sessions.get(code);
    if (session && socket.id === session.supportId) {
      io.to(session.clientId).emit('remote-event', { event });
    }
  });

  // ── CLIPBOARD SYNC (bidirectional between client and support) ─────────────
  socket.on('clipboard-sync', ({ code, text }) => {
    const session = sessions.get(code);
    if (!session) return;
    // Allow either end to sync; relay to the other side
    if (socket.id === session.clientId && session.supportId) {
      io.to(session.supportId).emit('clipboard-sync', { text });
    } else if (socket.id === session.supportId && session.clientId) {
      io.to(session.clientId).emit('clipboard-sync', { text });
    }
  });

  // ── SUPPORT: Force-end session (only support side can call this) ───────────
  socket.on('end-session', ({ code }) => {
    const session = sessions.get(code);
    if (session && socket.id === session.supportId) {
      io.to(session.clientId).emit('session-ended-by-support');
      sessions.delete(code);
      console.log(`[Session] Force-ended by support: ${code}`);
    }
  });

  // ── DISCONNECT ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const code = socket.sessionCode;
    if (!code) return;

    const session = sessions.get(code);
    if (!session) return;

    socket.to(code).emit('peer-disconnected', { role: socket.role });
    sessions.delete(code);
    console.log(`[Session] Ended: ${code}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n✅  Techsara server running at http://localhost:${PORT}`);
  console.log(`   Client page : http://localhost:${PORT}/client.html`);
  console.log(`   Support page: http://localhost:${PORT}/support.html\n`);
});
