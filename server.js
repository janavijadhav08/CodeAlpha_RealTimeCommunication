require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const sqlite3  = require('sqlite3').verbose();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: true } });
const db     = new sqlite3.Database('./meetings.db');
const SECRET = process.env.JWT_SECRET || 'dev-only-change-me';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Database ──────────────────────────────────────────────────────────────────
db.run(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT
)`);

// ── Auth routes ───────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8)
    return res.status(400).json({ error: 'All fields required; password 8+ chars' });
  db.run('INSERT INTO users(name,email,password) VALUES(?,?,?)',
    [name.trim(), email.toLowerCase(), await bcrypt.hash(password, 10)],
    function (e) {
      if (e) return res.status(409).json({ error: 'Email already registered' });
      res.json({ token: jwt.sign({ id: this.lastID, name: name.trim() }, SECRET), name: name.trim() });
    }
  );
});

app.post('/api/login', (req, res) => {
  db.get('SELECT * FROM users WHERE email=?', [String(req.body.email || '').toLowerCase()],
    async (e, u) => {
      if (!u || !(await bcrypt.compare(req.body.password || '', u.password)))
        return res.status(401).json({ error: 'Invalid credentials' });
      res.json({ token: jwt.sign({ id: u.id, name: u.name }, SECRET), name: u.name });
    }
  );
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── Socket.IO signaling ───────────────────────────────────────────────────────
io.on('connection', socket => {

  // Join room
  socket.on('join-room', ({ room, name }) => {
    if (!/^[a-zA-Z0-9_-]{3,40}$/.test(room || '')) return;
    socket.join(room);
    socket.data.room = room;
    socket.data.name = String(name || 'Guest').slice(0, 40);

    // Tell this peer about everyone else already in room
    const peers = Array.from(io.sockets.adapter.rooms.get(room) || [])
      .filter(id => id !== socket.id)
      .map(id => ({ id, name: io.sockets.sockets.get(id)?.data?.name || 'Guest' }));
    socket.emit('room-peers', peers);

    // Tell everyone else a new peer joined
    socket.to(room).emit('peer-joined', { id: socket.id, name: socket.data.name });

    // Broadcast updated participant list to everyone in room
    broadcastParticipants(room);
  });

  // WebRTC signaling
  ['offer', 'answer', 'ice-candidate'].forEach(ev => {
    socket.on(ev, data => {
      if (data.to) io.to(data.to).emit(ev, { from: socket.id, payload: data.payload });
    });
  });

  // Whiteboard
  socket.on('whiteboard-draw', data => socket.to(socket.data.room || '').emit('whiteboard-draw', data));
  socket.on('whiteboard-clear', ()  => socket.to(socket.data.room || '').emit('whiteboard-clear'));

  // Chat
  socket.on('chat-message', data => {
    const msg = {
      name: socket.data.name || 'Guest',
      text: String(data.text || '').slice(0, 1000),
      at:   Date.now(),
    };
    io.to(socket.data.room || '').emit('chat-message', msg);
  });

  // File share (max 2 MB relay)
  socket.on('file-share', data => {
    if (data?.name && data?.data && data.data.length < 3_000_000)
      socket.to(socket.data.room || '').emit('file-share', {
        name: String(data.name).slice(0, 100),
        data: data.data,
        from: socket.data.name,
      });
  });

  // Raise hand
  socket.on('raise-hand', () => {
    io.to(socket.data.room || '').emit('raise-hand', { id: socket.id, name: socket.data.name });
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (socket.data.room) {
      socket.to(socket.data.room).emit('peer-left', { id: socket.id, name: socket.data.name });
      broadcastParticipants(socket.data.room);
    }
  });

  function broadcastParticipants(room) {
    const list = Array.from(io.sockets.adapter.rooms.get(room) || [])
      .map(id => ({ id, name: io.sockets.sockets.get(id)?.data?.name || 'Guest' }));
    io.to(room).emit('participants', list);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✦ Relay Rooms running at http://localhost:${PORT}`));
