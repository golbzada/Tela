(() => {
  const RTC_CONFIG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  };

  // ---------- estado ----------
  let socket = null;
  let selfId = null;
  let selfName = '';
  let roomId = getRoomIdFromUrl();
  let localStream = null;
  let localTrackIds = new Set();
  const peers = new Map(); // peerId -> { pc, name, polite, makingOffer, ignoreOffer }
  const remoteTiles = new Map(); // peerId -> tile element
  const participantsState = new Map(); // peerId -> name

  // ---------- elementos ----------
  const joinView = document.getElementById('joinView');
  const roomView = document.getElementById('roomView');
  const nameInput = document.getElementById('nameInput');
  const joinBtn = document.getElementById('joinBtn');
  const connDot = document.getElementById('connDot');

  const stageGrid = document.getElementById('stageGrid');
  const stageEmpty = document.getElementById('stageEmpty');
  const liveCount = document.getElementById('liveCount');

  const shareBtn = document.getElementById('shareBtn');
  const stopShareBtn = document.getElementById('stopShareBtn');
  const participantList = document.getElementById('participantList');
  const participantCount = document.getElementById('participantCount');
  const roomLinkInput = document.getElementById('roomLinkInput');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const videoTileTemplate = document.getElementById('videoTileTemplate');

  roomLinkInput.value = `${window.location.origin}${window.location.pathname}?room=${roomId}`;

  function getRoomIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    let r = params.get('room');
    if (!r) {
      r = 'sala-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      params.set('room', r);
      history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    }
    return r;
  }

  // ---------- entrar na sala ----------
  joinBtn.addEventListener('click', doJoin);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  function doJoin() {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    selfName = name;
    joinBtn.disabled = true;
    joinBtn.textContent = 'Entrando...';
    connectSocket();
  }

  function connectSocket() {
    socket = io();

    socket.on('connect', () => {
      connDot.style.background = '#3DDC84';
      socket.emit('join-room', { room: roomId, name: selfName });
    });

    socket.on('disconnect', () => {
      connDot.style.background = 'var(--live)';
    });

    socket.on('joined', ({ selfId: id, existingPeers }) => {
      selfId = id;
      joinView.classList.add('hidden');
      roomView.classList.remove('hidden');

      existingPeers.forEach((p) => {
        participantsState.set(p.id, p.name);
        ensurePeer(p.id, p.name);
      });
      renderParticipants();
    });

    socket.on('peer-joined', ({ id, name }) => {
      participantsState.set(id, name);
      ensurePeer(id, name);
      renderParticipants();
    });

    socket.on('participants-update', (list) => {
      list.forEach((p) => participantsState.set(p.id, p.name));
      renderParticipants();
    });

    socket.on('peer-left', ({ id }) => {
      removePeer(id);
      renderParticipants();
    });

    socket.on('signal', async ({ from, data }) => {
      let peer = peers.get(from);
      if (!peer) {
        peer = ensurePeer(from, participantsState.get(from) || 'Participante');
      }
      const { pc } = peer;

      try {
        if (data.description) {
          const offerCollision =
            data.description.type === 'offer' &&
            (peer.makingOffer || pc.signalingState !== 'stable');

          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) return;

          await pc.setRemoteDescription(data.description);
          if (data.description.type === 'offer') {
            await pc.setLocalDescription();
            sendSignal(from, { description: pc.localDescription });
          }
        } else if (data.candidate) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (err) {
            if (!peer.ignoreOffer) console.warn('ICE candidate error', err);
          }
        } else if (data.stopShare) {
          removeRemoteTile(from);
        }
      } catch (err) {
        console.warn('Erro de sinalizacao', err);
      }
    });
  }

  function sendSignal(to, data) {
    socket.emit('signal', { to, data });
  }

  // ---------- WebRTC peer management ----------
  function ensurePeer(peerId, name) {
    if (peers.has(peerId)) return peers.get(peerId);

    const polite = selfId ? selfId < peerId : true;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = { pc, name, polite, makingOffer: false, ignoreOffer: false };
    peers.set(peerId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(peerId, { candidate: e.candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(peerId, { description: pc.localDescription });
      } catch (err) {
        console.warn('Erro ao renegociar', err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.ontrack = (e) => {
      if (e.track.kind !== 'video') return;
      showRemoteTile(peerId, e.streams[0]);
      e.track.addEventListener('ended', () => removeRemoteTile(peerId));
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        // conexao caiu; a lista de participantes via socket ainda manda a verdade
      }
    };

    // se eu ja estou compartilhando quando um novo peer entra, manda pra ele tambem
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    return peer;
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) {
      peer.pc.close();
      peers.delete(peerId);
    }
    participantsState.delete(peerId);
    removeRemoteTile(peerId);
  }

  // ---------- compartilhar tela ----------
  shareBtn.addEventListener('click', startShare);
  stopShareBtn.addEventListener('click', stopShare);

  async function startShare() {
    try {
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });
    } catch (err) {
      console.warn('Usuario cancelou ou permissao negada', err);
      return;
    }

    localTrackIds = new Set(localStream.getTracks().map((t) => t.id));

    localStream.getVideoTracks()[0].addEventListener('ended', stopShare);

    peers.forEach((peer) => {
      localStream.getTracks().forEach((track) => peer.pc.addTrack(track, localStream));
    });

    shareBtn.classList.add('hidden');
    stopShareBtn.classList.remove('hidden');
    renderParticipants();
  }

  function stopShare() {
    if (!localStream) return;

    peers.forEach((peer, peerId) => {
      peer.pc.getSenders()
        .filter((s) => s.track && localTrackIds.has(s.track.id))
        .forEach((s) => peer.pc.removeTrack(s));
      sendSignal(peerId, { stopShare: true });
    });

    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    localTrackIds = new Set();

    shareBtn.classList.remove('hidden');
    stopShareBtn.classList.add('hidden');
    renderParticipants();
  }

  // ---------- render: grade de video ----------
  function showRemoteTile(peerId, stream) {
    let tile = remoteTiles.get(peerId);
    if (!tile) {
      const frag = videoTileTemplate.content.cloneNode(true);
      tile = frag.querySelector('.video-tile');
      tile.dataset.peerId = peerId;
      stageGrid.appendChild(tile);
      remoteTiles.set(peerId, tile);
    }
    const video = tile.querySelector('video');
    if (video.srcObject !== stream) video.srcObject = stream;
    tile.querySelector('.tile-name').textContent = participantsState.get(peerId) || 'Participante';
    updateStageEmptyState();
    updateLiveCount();
  }

  function removeRemoteTile(peerId) {
    const tile = remoteTiles.get(peerId);
    if (tile) {
      tile.remove();
      remoteTiles.delete(peerId);
    }
    updateStageEmptyState();
    updateLiveCount();
  }

  function updateStageEmptyState() {
    stageEmpty.classList.toggle('hidden', remoteTiles.size > 0);
  }

  function updateLiveCount() {
    const total = remoteTiles.size + (localStream ? 1 : 0);
    liveCount.textContent = `${total} AO VIVO`;
  }

  // ---------- render: lista de participantes ----------
  function renderParticipants() {
    participantList.innerHTML = '';
    const all = [[selfId, selfName], ...Array.from(participantsState.entries())];

    all.forEach(([id, name]) => {
      if (!id) return;
      const li = document.createElement('li');
      li.className = 'participant-item';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = (name || '?').trim().charAt(0).toUpperCase();

      const nameSpan = document.createElement('span');
      nameSpan.textContent = name;
      nameSpan.style.flex = '1';

      li.appendChild(avatar);
      li.appendChild(nameSpan);

      if (id === selfId) {
        const tag = document.createElement('span');
        tag.className = 'tag tag-you';
        tag.textContent = 'VOCÊ';
        li.appendChild(tag);
        if (localStream) {
          const liveTag = document.createElement('span');
          liveTag.className = 'tag tag-live';
          liveTag.textContent = 'AO VIVO';
          li.appendChild(liveTag);
        }
      } else if (remoteTiles.has(id)) {
        const liveTag = document.createElement('span');
        liveTag.className = 'tag tag-live';
        liveTag.textContent = 'AO VIVO';
        li.appendChild(liveTag);
      }

      participantList.appendChild(li);
    });

    participantCount.textContent = all.length;
    updateLiveCount();
  }

  // ---------- copiar link ----------
  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(roomLinkInput.value);
      copyLinkBtn.textContent = 'Copiado!';
      setTimeout(() => (copyLinkBtn.textContent = 'Copiar'), 1500);
    } catch {
      roomLinkInput.select();
      document.execCommand('copy');
    }
  });

  window.addEventListener('beforeunload', () => {
    if (socket) socket.emit('leave-room');
  });
})();
