const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const EMPTY_ROOM_TIMEOUT_MS = 5 * 60 * 1000; // sala fecha 5 min depois de ficar vazia

app.use(express.static(path.join(__dirname, 'public')));

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

    // Envia pro novo participante a lista de quem ja esta na sala,
    // ele sera responsavel por iniciar a conexao WebRTC com cada um.
    const existing = participantList(room);
    roomData.participants.set(socket.id, { name: cleanName });

    socket.emit('joined', { selfId: socket.id, existingPeers: existing });
    socket.to(room).emit('peer-joined', { id: socket.id, name: cleanName });
    broadcastParticipants(room);
  });

  // Repassa sinalizacao WebRTC (offer/answer/ice candidate) para o peer alvo
  socket.on('signal', ({ to, data }) => {
    if (!to) return;
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
});
