const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

// Carrega arquivo .env local se existir
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...values] = trimmed.split('=');
        const k = key.trim();
        const v = values.join('=').trim().replace(/^["'](.*)["']$/, '$1');
        if (k && !process.env[k]) {
          process.env[k] = v;
        }
      }
    });
  } catch (e) {
    console.warn('Não foi possível ler o arquivo .env:', e);
  }
}

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 3000;
const EMPTY_ROOM_TIMEOUT_MS = 5 * 60 * 1000; // sala fecha 5 min depois de ficar vazia

app.use(express.static(path.join(__dirname, 'public')));

// Monta lista de servidores ICE a partir de variáveis de ambiente
function getIceServers() {
  const iceServers = [];

  // STUN servers
  const stunEnv = process.env.STUN_URL;
  if (stunEnv) {
    const stunUrls = stunEnv.split(',').map((u) => u.trim()).filter(Boolean);
    if (stunUrls.length > 0) {
      iceServers.push({ urls: stunUrls });
    }
  } else {
    iceServers.push({
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    });
  }

  // TURN servers
  const turnEnv = process.env.TURN_URL;
  if (turnEnv) {
    const turnUrls = turnEnv.split(',').map((u) => u.trim()).filter(Boolean);
    if (turnUrls.length > 0) {
      const turnConfig = { urls: turnUrls };
      if (process.env.TURN_USERNAME) {
        turnConfig.username = process.env.TURN_USERNAME;
      }
      if (process.env.TURN_CREDENTIAL) {
        turnConfig.credential = process.env.TURN_CREDENTIAL;
      }
      iceServers.push(turnConfig);
    }
  } else {
    // Fallback público com suporte a TURN (UDP e TCP) para garantir conexões em redes com CGNAT
    iceServers.push(
      {
        urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: ['turn:openrelay.metered.ca:443?transport=tcp'],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      }
    );
  }

  return iceServers;
}

// Endpoint para fornecer servidores ICE dinamicamente ao frontend
app.get('/api/ice-servers', (req, res) => {
  res.json({ iceServers: getIceServers() });
});

// roomId -> { participants: Map(socketId -> {name}), emptyTimer: Timeout|null }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { participants: new Map(), emptyTimer: null });
  }
  return rooms.get(roomId);
}

function participantList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.participants.entries()).map(([id, data]) => ({
    id,
    name: data.name,
  }));
}

function broadcastParticipants(roomId) {
  io.to(roomId).emit('participants-update', participantList(roomId));
}

function scheduleRoomCleanup(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (r && r.participants.size === 0) {
      rooms.delete(roomId);
    }
  }, EMPTY_ROOM_TIMEOUT_MS);
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ room, name }) => {
    if (!room || typeof room !== 'string') return;
    const cleanName = (name || 'Sem nome').toString().slice(0, 40);

    currentRoom = room;
    socket.join(room);

    const roomData = getRoom(room);
    if (roomData.emptyTimer) {
      clearTimeout(roomData.emptyTimer);
      roomData.emptyTimer = null;
    }

    // Envia pro novo participante a lista de quem já está na sala
    const existing = participantList(room);
    roomData.participants.set(socket.id, { name: cleanName });

    socket.emit('joined', { selfId: socket.id, existingPeers: existing });
    socket.to(room).emit('peer-joined', { id: socket.id, name: cleanName });
    broadcastParticipants(room);
  });

  // Repassa sinalização WebRTC (offer/answer/ice candidate) para o peer alvo
  socket.on('signal', ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('leave-room', () => {
    handleLeave();
  });

  socket.on('disconnect', () => {
    handleLeave();
  });

  function handleLeave() {
    if (!currentRoom) return;
    const roomData = rooms.get(currentRoom);
    if (roomData) {
      roomData.participants.delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { id: socket.id });
      broadcastParticipants(currentRoom);
      if (roomData.participants.size === 0) {
        scheduleRoomCleanup(currentRoom);
      }
    }
    currentRoom = null;
  }
});

server.listen(PORT, () => {
  console.log(`TelaJunto rodando em http://localhost:${PORT}`);
  console.log('Servidores ICE ativos:', JSON.stringify(getIceServers(), null, 2));
});
