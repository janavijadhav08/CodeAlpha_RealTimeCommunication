/* ── Utilities ───────────────────────────────────────────────────────────── */
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const tok = () => localStorage.token || '';
const timeFmt = ts => new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

async function api(url, opt = {}) {
  const r = await fetch('/api' + url, {
    ...opt,
    headers: { 'Content-Type':'application/json', ...(tok()?{Authorization:'Bearer '+tok()}:{}), ...(opt.headers||{}) }
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

let _tt;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (type ? ' '+type : '');
  clearTimeout(_tt); _tt = setTimeout(() => el.className = 'toast', 3500);
}

/* ── WebRTC state ────────────────────────────────────────────────────────── */
const ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let socket      = null;
let localStream = null;
let screenStream = null;
let peers       = {};           // id → RTCPeerConnection
let myRoom      = '';
let myName      = 'Guest';
let micOn       = true;
let camOn       = true;

/* ── Nav / Auth ──────────────────────────────────────────────────────────── */
function getMyName() {
  if (!tok()) return null;
  try { return JSON.parse(atob(tok().split('.')[1])).name; } catch { return null; }
}
function updateNav() {
  const n = getMyName();
  document.getElementById('navLogin').style.display  = n ? 'none' : '';
  document.getElementById('navLogout').style.display = n ? '' : 'none';
}
function showAuth(mode) {
  const overlay = document.getElementById('authOverlay');
  overlay.style.display = 'flex';
  document.getElementById('authTitle').textContent  = mode==='register' ? 'Create Account' : 'Welcome Back';
  document.getElementById('nameWrap').style.display = mode==='register' ? 'block' : 'none';
  document.getElementById('authSwitch').innerHTML   = mode==='register'
    ? 'Already have an account? <a onclick="showAuth(\'login\')">Sign in</a>'
    : 'New to SabMeet? <a onclick="showAuth(\'register\')">Create account</a>';

  document.getElementById('authForm').onsubmit = async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const btn = document.getElementById('authSubmit'); btn.disabled = true;
    try {
      const r = await api('/'+mode, { method:'POST', body:JSON.stringify(data) });
      localStorage.token = r.token;
      overlay.style.display = 'none';
      updateNav();
      document.getElementById('displayName').value = r.name;
      toast('Welcome, ' + r.name + '!', 'success');
    } catch(err) { toast(err.message, 'error'); }
    finally { btn.disabled = false; }
  };
}

document.getElementById('navLogin').onclick  = e => { e.preventDefault(); showAuth('login'); };
document.getElementById('navLogout').onclick = e => {
  e.preventDefault(); localStorage.removeItem('token'); updateNav(); toast('Signed out 👋');
};

/* ── Lobby ───────────────────────────────────────────────────────────────── */
function quickRoom() {
  const code = 'room-' + Math.random().toString(36).slice(2, 7);
  document.getElementById('roomCode').value = code;
  toast('Quick room code: ' + code);
}

async function joinRoom() {
  myRoom = document.getElementById('roomCode').value.trim();
  myName = document.getElementById('displayName').value.trim() || (getMyName() || 'Guest');

  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(myRoom)) {
    toast('Room code must be 3–40 letters, numbers, _ or -', 'error'); return;
  }

  document.getElementById('lobbyStatus').textContent = 'Requesting camera & microphone…';
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch(e) {
    toast('Could not access camera/mic: ' + e.message + ' — use localhost or HTTPS.', 'error');
    document.getElementById('lobbyStatus').textContent = 'Permission denied. Use localhost or HTTPS.';
    return;
  }

  // Show local video
  const lv = document.getElementById('localVideo');
  lv.srcObject = localStream;
  document.querySelector('#localWrap .video-label').textContent = myName + ' (you)';

  // Switch views
  document.getElementById('lobby').style.display          = 'none';
  document.getElementById('meetingSection').style.display = '';
  document.getElementById('roomLabel').style.display      = '';
  document.getElementById('roomLabel').textContent        = '📍 ' + myRoom;
  document.getElementById('stageRoomLabel').textContent   = myRoom;
  document.getElementById('leaveBtn').style.display       = '';

  // Connect socket
  socket = io();
  socket.emit('join-room', { room: myRoom, name: myName });
  wireSocket();
  addChatMsg('System', 'You joined ' + myRoom, true);
  toast('Joined room: ' + myRoom, 'success');
}

/* ── Socket wiring ───────────────────────────────────────────────────────── */
function wireSocket() {
  socket.on('room-peers', peers => {
    peers.forEach(p => makeOffer(p.id));
  });

  socket.on('peer-joined', p => {
    addChatMsg('System', p.name + ' joined the room', true);
    toast(p.name + ' joined 👋');
  });

  socket.on('peer-left', p => {
    closePeer(p.id);
    addChatMsg('System', p.name + ' left the room', true);
  });

  socket.on('offer', async d => {
    const pc = createPeer(d.from);
    await pc.setRemoteDescription(d.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: d.from, payload: answer });
  });

  socket.on('answer', async d => {
    if (peers[d.from]) await peers[d.from].setRemoteDescription(d.payload);
  });

  socket.on('ice-candidate', d => {
    peers[d.from]?.addIceCandidate(d.payload).catch(() => {});
  });

  socket.on('participants', list => updateParticipants(list));
  socket.on('whiteboard-draw',  drawRemote);
  socket.on('whiteboard-clear', () => ctx.clearRect(0, 0, canvas.width, canvas.height));
  socket.on('chat-message', m => addChatMsg(m.name, m.text, false, m.at));
  socket.on('raise-hand',   m => { toast(m.name + ' ✋ raised their hand!'); addChatMsg('System', m.name + ' raised their hand ✋', true); });
  socket.on('file-share',   f => receiveFile(f));
}

/* ── WebRTC helpers ──────────────────────────────────────────────────────── */
function createPeer(id) {
  if (peers[id]) return peers[id];
  const pc = new RTCPeerConnection(ICE_CONFIG);
  peers[id] = pc;

  (localStream?.getTracks() || []).forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { to: id, payload: e.candidate });
  };

  pc.ontrack = e => {
    let wrap = document.getElementById('vw-' + id);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'vw-' + id;
      wrap.className = 'video-wrap';
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true;
      const lbl = document.createElement('span');
      lbl.className = 'video-label';
      lbl.textContent = 'Peer';
      wrap.appendChild(v);
      wrap.appendChild(lbl);
      document.getElementById('videos').appendChild(wrap);
    }
    wrap.querySelector('video').srcObject = e.streams[0];
  };

  pc.onconnectionstatechange = () => {
    if (['failed','disconnected','closed'].includes(pc.connectionState)) closePeer(id);
  };

  return pc;
}

async function makeOffer(id) {
  const pc    = createPeer(id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('offer', { to: id, payload: offer });
}

function closePeer(id) {
  peers[id]?.close();
  delete peers[id];
  document.getElementById('vw-' + id)?.remove();
}

/* ── Media controls ──────────────────────────────────────────────────────── */
function toggleMedia(kind) {
  if (!localStream) return toast('Join a room first', 'error');
  if (kind === 'audio') {
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    document.getElementById('micBtn').classList.toggle('muted-state', !micOn);
    document.getElementById('micBtn').textContent = micOn ? '🎙️ Mic' : '🔇 Muted';
  } else {
    camOn = !camOn;
    localStream.getVideoTracks().forEach(t => t.enabled = camOn);
    document.getElementById('camBtn').classList.toggle('muted-state', !camOn);
    document.getElementById('camBtn').textContent = camOn ? '📷 Cam' : '📷 Off';
  }
}

async function shareScreen() {
  if (!socket) return toast('Join a room first', 'error');
  if (screenStream) {
    // stop sharing
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
    const videoTrack = localStream.getVideoTracks()[0];
    Object.values(peers).forEach(pc => {
      const s = pc.getSenders().find(x => x.track?.kind === 'video');
      if (s) s.replaceTrack(videoTrack);
    });
    document.getElementById('localVideo').srcObject = localStream;
    document.getElementById('screenBtn').textContent = '🖥️ Screen';
    toast('Screen sharing stopped');
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track  = screenStream.getVideoTracks()[0];
    Object.values(peers).forEach(pc => {
      const s = pc.getSenders().find(x => x.track?.kind === 'video');
      if (s) s.replaceTrack(track);
    });
    document.getElementById('localVideo').srcObject = screenStream;
    document.getElementById('screenBtn').textContent = '🖥️ Stop';
    track.onended = () => shareScreen(); // auto-stop when user ends from browser UI
    toast('Screen sharing started', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

function raiseHand() {
  if (!socket) return toast('Join a room first', 'error');
  socket.emit('raise-hand');
  toast('Hand raised ✋');
}

/* ── Leave ───────────────────────────────────────────────────────────────── */
function leaveRoom() {
  Object.keys(peers).forEach(id => closePeer(id));
  localStream?.getTracks().forEach(t => t.stop());
  screenStream?.getTracks().forEach(t => t.stop());
  socket?.disconnect();
  socket = null; localStream = null; screenStream = null;
  document.getElementById('videos').innerHTML = `
    <div class="video-wrap" id="localWrap">
      <video id="localVideo" autoplay muted playsinline></video>
      <span class="video-label">You</span>
    </div>`;
  document.getElementById('meetingSection').style.display = 'none';
  document.getElementById('lobby').style.display          = '';
  document.getElementById('roomLabel').style.display      = 'none';
  document.getElementById('leaveBtn').style.display       = 'none';
  document.getElementById('chat').innerHTML               = '';
  document.getElementById('fileList').innerHTML           = '';
  document.getElementById('participantList').innerHTML    = '';
  toast('You left the meeting');
}

/* ── Participants list ───────────────────────────────────────────────────── */
function updateParticipants(list) {
  document.getElementById('participantCount').textContent = list.length;
  document.getElementById('participantList').innerHTML = list.map(p =>
    `<div class="participant-item">
      <span class="participant-dot"></span>
      <span>${esc(p.name)}${p.id === socket?.id ? ' <b style="color:var(--muted)">(you)</b>' : ''}</span>
    </div>`
  ).join('');
}

/* ── Chat ────────────────────────────────────────────────────────────────── */
function sendChat() {
  const text = document.getElementById('chatInput').value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', { text });
  document.getElementById('chatInput').value = '';
}

function addChatMsg(name, text, isSystem = false, ts = Date.now()) {
  const chatEl = document.getElementById('chat');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `
    <span class="chat-name${isSystem?' system':''}">${esc(name)}</span>
    <span class="chat-time"> ${timeFmt(ts)}</span>
    <div class="chat-text">${esc(text)}</div>`;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

/* ── File share ──────────────────────────────────────────────────────────── */
function sendFile() {
  const f = document.getElementById('fileInput').files[0];
  if (!f)      return toast('Select a file first', 'error');
  if (!socket) return toast('Join a room first', 'error');
  if (f.size > 2 * 1024 * 1024) return toast('File must be under 2 MB', 'error');
  const reader = new FileReader();
  reader.onload = () => {
    socket.emit('file-share', { name: f.name, data: reader.result });
    addFileItem(f.name, reader.result, 'You');
    addChatMsg('System', 'You shared: ' + f.name, true);
    toast('File shared ✓', 'success');
  };
  reader.readAsDataURL(f);
}

function receiveFile(f) {
  addFileItem(f.name, f.data, f.from);
  addChatMsg('System', f.from + ' shared: ' + f.name, true);
}

function addFileItem(name, dataUrl, from) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.innerHTML = `📄 <a href="${dataUrl}" download="${esc(name)}">${esc(name)}</a><span class="file-from">from ${esc(from)}</span>`;
  document.getElementById('fileList').prepend(div);
}

/* ── Whiteboard ──────────────────────────────────────────────────────────── */
const canvas = document.getElementById('boardCanvas');
const ctx    = canvas.getContext('2d');
let drawing  = false, lastPt = null;

function getPoint(e) {
  const r = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - r.left) * canvas.width  / r.width,
    y: (src.clientY - r.top)  * canvas.height / r.height,
  };
}

function getColor() { return document.getElementById('brushColor').value; }
function getSize()  { return Number(document.getElementById('brushSize').value) || 3; }

function drawLine(a, b, color = '#315fbd', size = 3) {
  ctx.strokeStyle = color;
  ctx.lineWidth   = size;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function drawRemote(d) { drawLine(d.a, d.b, d.color, d.size); }

function clearBoard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  socket?.emit('whiteboard-clear');
}

canvas.addEventListener('pointerdown', e => { drawing = true; lastPt = getPoint(e); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => {
  if (!drawing) return;
  const pt = getPoint(e);
  drawLine(lastPt, pt, getColor(), getSize());
  socket?.emit('whiteboard-draw', { a: lastPt, b: pt, color: getColor(), size: getSize() });
  lastPt = pt;
});
canvas.addEventListener('pointerup',   () => drawing = false);
canvas.addEventListener('pointerleave',() => drawing = false);

/* ── Boot ────────────────────────────────────────────────────────────────── */
updateNav();
const savedName = getMyName();
if (savedName) document.getElementById('displayName').value = savedName;
