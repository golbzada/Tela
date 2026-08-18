(() => {
  // Configuração padrão de ICE Servers (fallback caso a API falhe)
  let rtcConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ],
  };

  // Carrega configuração de servidores STUN/TURN dinamicamente da API do servidor
  async function loadIceConfig() {
    try {
      const res = await fetch('/api/ice-servers');
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          rtcConfiguration = { iceServers: data.iceServers };
          console.log('[GOLBTELAS] Servidores ICE carregados dinamicamente:', rtcConfiguration.iceServers);
        }
      }
    } catch (err) {
      console.warn('[GOLBTELAS] Falha ao buscar /api/ice-servers, mantendo fallback:', err);
    }
  }

  // Carrega configurações ICE imediatamente ao iniciar o script
  loadIceConfig();

  // ---------- estado ----------
  let socket = null;
  let selfId = null;
  let selfName = '';
  let roomId = getRoomIdFromUrl();
  let localStream = null;

  // peerId -> {
  //   pc: RTCPeerConnection,
  //   name: string,
  //   polite: boolean,
  //   makingOffer: boolean,
  //   ignoreOffer: boolean,
  //   iceCandidateQueue: Array,
  //   lastRestartTime: number,
  //   videoTransceiver: RTCRtpTransceiver,
  //   audioTransceiver: RTCRtpTransceiver,
  //   remoteStream: MediaStream
  // }
  const peers = new Map();
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
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });

  async function doJoin() {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    selfName = name;
    joinBtn.disabled = true;
    joinBtn.textContent = 'Entrando...';

    // Garante que a configuração mais recente de ICE foi buscada
    await loadIceConfig();
    connectSocket();
  }

  function connectSocket() {
    const isHttps = window.location.protocol === 'https:';
    socket = io(window.location.origin, {
      secure: isHttps,
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      console.log(`[GOLBTELAS] Conectado ao servidor de sinalização (${socket.id}) via ${socket.io.engine.transport.name}`);
      connDot.style.background = '#3DDC84';
      socket.emit('join-room', { room: roomId, name: selfName });
    });

    socket.io.engine.on('upgrade', (transport) => {
      console.log(`[GOLBTELAS] WebSocket atualizado para transporte: ${transport.name}`);
    });

    socket.on('disconnect', (reason) => {
      console.warn('[GOLBTELAS] Desconectado do servidor de sinalização:', reason);
      connDot.style.background = 'var(--live)';
    });

    socket.on('joined', ({ selfId: id, existingPeers }) => {
      selfId = id;
      console.log(`[GOLBTELAS] Entrou na sala ${roomId} com ID ${selfId}. Peers existentes:`, existingPeers);
      participantsState.set(selfId, selfName);
      joinView.classList.add('hidden');
      roomView.classList.remove('hidden');

      existingPeers.forEach((p) => {
        participantsState.set(p.id, p.name);
        ensurePeer(p.id, p.name);
      });
      renderParticipants();
    });

    socket.on('peer-joined', ({ id, name }) => {
      console.log(`[GOLBTELAS] Novo participante entrou: ${name} (${id})`);
      participantsState.set(id, name);
      ensurePeer(id, name);
      renderParticipants();
    });

    socket.on('participants-update', (list) => {
      list.forEach((p) => participantsState.set(p.id, p.name));
      renderParticipants();
    });

    socket.on('peer-left', ({ id }) => {
      console.log(`[GOLBTELAS] Participante saiu: ${id}`);
      removePeer(id);
      renderParticipants();
    });

    socket.on('signal', async ({ from, data }) => {
      if (!data) return;

      let peer = peers.get(from);
      if (!peer) {
        peer = ensurePeer(from, participantsState.get(from) || 'Participante');
      }
      const { pc, name } = peer;

      try {
        if (data.description) {
          const description = data.description;
          console.log(`[GOLBTELAS][${name}] Mensagem de sinalização recebida: SDP ${description.type}`);

          // Perfect Negotiation: detecção de colisão de ofertas
          const offerCollision =
            description.type === 'offer' &&
            (peer.makingOffer || pc.signalingState !== 'stable');

          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) {
            console.warn(`[GOLBTELAS][${name}] Colisão detectada: oferta remota ignorada (peer impolite)`);
            return;
          }

          console.log(`[GOLBTELAS][${name}] Aplicando setRemoteDescription (${description.type})`);
          await pc.setRemoteDescription(new RTCSessionDescription(description));

          // Esvazia e processa a fila de ICE candidates recebidos antes da remoteDescription
          if (peer.iceCandidateQueue.length > 0) {
            console.log(`[GOLBTELAS][${name}] Processando ${peer.iceCandidateQueue.length} candidatos ICE enfileirados...`);
            const candidates = peer.iceCandidateQueue.splice(0, peer.iceCandidateQueue.length);
            for (const cand of candidates) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
                console.log(`[GOLBTELAS][${name}] Candidato enfileirado aplicado com sucesso`);
              } catch (candidateErr) {
                console.warn(`[GOLBTELAS][${name}] Erro ao aplicar candidato enfileirado:`, candidateErr);
              }
            }
          }

          if (description.type === 'offer') {
            console.log(`[GOLBTELAS][${name}] Criando e definindo resposta (answer) local...`);
            await pc.setLocalDescription();
            sendSignal(from, { description: pc.localDescription });
          }
        } else if (data.candidate) {
          const candidateData = data.candidate;
          console.log(`[GOLBTELAS][${name}] Sinalização de ICE Candidate recebida`);

          // Se a remoteDescription já estiver pronta, adiciona imediatamente. Senão, enfileira.
          if (pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(candidateData));
              console.log(`[GOLBTELAS][${name}] Candidato ICE adicionado com sucesso`);
            } catch (err) {
              if (!peer.ignoreOffer) {
                console.warn(`[GOLBTELAS][${name}] Falha ao adicionar ICE candidate imediato:`, err);
              }
            }
          } else {
            console.log(`[GOLBTELAS][${name}] setRemoteDescription ainda não executado. Enfileirando ICE candidate.`);
            peer.iceCandidateQueue.push(candidateData);
          }
        }
      } catch (err) {
        console.error(`[GOLBTELAS][${name}] Erro no processamento de sinalização:`, err);
      }
    });
  }

  function sendSignal(to, data) {
    if (socket && socket.connected) {
      socket.emit('signal', { to, data });
    }
  }

  // ---------- WebRTC peer management ----------
  function ensurePeer(peerId, name) {
    if (peers.has(peerId)) return peers.get(peerId);
    console.log(`[GOLBTELAS] Criando RTCPeerConnection individual para ${name} (${peerId})`);

    // Padrão Perfect Negotiation: define quem cede em caso de colisão de ofertas
    const polite = selfId ? selfId < peerId : true;
    const pc = new RTCPeerConnection(rtcConfiguration);

    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' });
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });

    const peer = {
      pc,
      name,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      iceCandidateQueue: [],
      lastRestartTime: 0,
      videoTransceiver,
      audioTransceiver,
      remoteStream: new MediaStream(),
    };
    peers.set(peerId, peer);

    // Envio de ICE candidates locais via sinalização
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        console.log(
          `[GOLBTELAS][${name}] ICE Candidate gerado: tipo=${e.candidate.type || 'unknown'}, ` +
          `protocolo=${e.candidate.protocol || 'unknown'}, ` +
          `endereço=${e.candidate.address || e.candidate.ip || 'unknown'}:${e.candidate.port || ''}`
        );
        sendSignal(peerId, { candidate: e.candidate });
      } else {
        console.log(`[GOLBTELAS][${name}] Todos os ICE candidates locais foram coletados (null candidate).`);
      }
    };

    // Diagnósticos e logs detalhados de estados
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`[GOLBTELAS][${name}] ICE Connection State: ${state}`);
      if (state === 'failed') {
        console.warn(`[GOLBTELAS][${name}] ICE Connection State entrou em FAILED. Tentando restartIce()...`);
        handleIceFailure(peerId, peer);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[GOLBTELAS][${name}] Peer Connection State: ${state}`);
      if (state === 'failed') {
        console.warn(`[GOLBTELAS][${name}] Peer Connection State entrou em FAILED. Tentando restartIce()...`);
        handleIceFailure(peerId, peer);
      } else if (state === 'closed' || state === 'disconnected') {
        console.log(`[GOLBTELAS][${name}] Conexão ${state}.`);
      }
    };

    pc.onsignalingstatechange = () => {
      console.log(`[GOLBTELAS][${name}] Signaling State: ${pc.signalingState}`);
    };

    pc.onicegatheringstatechange = () => {
      console.log(`[GOLBTELAS][${name}] ICE Gathering State: ${pc.iceGatheringState}`);
    };

    pc.onicecandidateerror = (e) => {
      console.error(`[GOLBTELAS][${name}] Erro de ICE Candidate:`, {
        errorCode: e.errorCode,
        errorText: e.errorText,
        url: e.url,
        address: e.address,
        port: e.port,
      });
    };

    // Tratamento de negotiationneeded com Perfect Negotiation
    pc.onnegotiationneeded = async () => {
      console.log(`[GOLBTELAS][${name}] onnegotiationneeded disparado.`);
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        console.log(`[GOLBTELAS][${name}] Enviando oferta SDP local originada por negotiationneeded`);
        sendSignal(peerId, { description: pc.localDescription });
      } catch (err) {
        console.error(`[GOLBTELAS][${name}] Falha durante negociação automática:`, err);
      } finally {
        peer.makingOffer = false;
      }
    };

    // Recepção e atribuição de faixas de mídia (ontrack)
    pc.ontrack = (e) => {
      console.log(`[GOLBTELAS][${name}] ontrack recebido: kind=${e.track.kind}, id=${e.track.id}, streams=${e.streams.length}`);

      // Usa event.streams[0] se presente, ou remonta na stream dedicada
      let streamToUse = null;
      if (e.streams && e.streams[0]) {
        streamToUse = e.streams[0];
      } else {
        if (!peer.remoteStream.getTracks().includes(e.track)) {
          peer.remoteStream.addTrack(e.track);
        }
        streamToUse = peer.remoteStream;
      }
      peer.remoteStream = streamToUse;

      if (e.track.kind === 'video') {
        showRemoteTile(peerId, streamToUse);
      }

      e.track.onunmute = () => {
        console.log(`[GOLBTELAS][${name}] Faixa de ${e.track.kind} ativa (onunmute)`);
        if (e.track.kind === 'video') {
          showRemoteTile(peerId, streamToUse);
        }
      };

      e.track.onmute = () => {
        console.log(`[GOLBTELAS][${name}] Faixa de ${e.track.kind} mutada (onmute)`);
      };

      e.track.onended = () => {
        console.log(`[GOLBTELAS][${name}] Faixa de ${e.track.kind} finalizada (onended)`);
      };
    };

    // Se já estiver transmitindo quando um novo peer entrar, injeta as tracks
    if (localStream) {
      const vTrack = localStream.getVideoTracks()[0] || null;
      const aTrack = localStream.getAudioTracks()[0] || null;
      videoTransceiver.sender.replaceTrack(vTrack).catch((err) =>
        console.error(`[GOLBTELAS] Erro ao aplicar videoTrack no novo peer ${name}:`, err)
      );
      audioTransceiver.sender.replaceTrack(aTrack).catch((err) =>
        console.error(`[GOLBTELAS] Erro ao aplicar audioTrack no novo peer ${name}:`, err)
      );
    }

    return peer;
  }

  // Reconexão ICE quando entrar em failed
  function handleIceFailure(peerId, peer) {
    const now = Date.now();
    if (now - peer.lastRestartTime < 4000) {
      console.log(`[GOLBTELAS][${peer.name}] Cooldown de restartIce ativo. Aguardando...`);
      return;
    }
    peer.lastRestartTime = now;

    console.log(`[GOLBTELAS][${peer.name}] Executando restartIce()...`);
    if (typeof peer.pc.restartIce === 'function') {
      try {
        peer.pc.restartIce();
      } catch (err) {
        console.warn(`[GOLBTELAS][${peer.name}] Falha ao chamar pc.restartIce():`, err);
      }
    } else {
      // Fallback para navegadores sem restartIce nativo
      (async () => {
        try {
          peer.makingOffer = true;
          const offer = await peer.pc.createOffer({ iceRestart: true });
          await peer.pc.setLocalDescription(offer);
          sendSignal(peerId, { description: peer.pc.localDescription });
        } catch (err) {
          console.error(`[GOLBTELAS][${peer.name}] Falha no fallback de iceRestart:`, err);
        } finally {
          peer.makingOffer = false;
        }
      })();
    }
  }

  // Limpeza correta de conexões encerradas
  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) {
      console.log(`[GOLBTELAS] Limpando conexão e recursos do peer ${peer.name} (${peerId})`);
      try {
        peer.pc.onicecandidate = null;
        peer.pc.oniceconnectionstatechange = null;
        peer.pc.onconnectionstatechange = null;
        peer.pc.onsignalingstatechange = null;
        peer.pc.onicegatheringstatechange = null;
        peer.pc.onicecandidateerror = null;
        peer.pc.onnegotiationneeded = null;
        peer.pc.ontrack = null;
        peer.pc.close();
      } catch (err) {
        console.warn(`[GOLBTELAS] Erro ao fechar RTCPeerConnection de ${peer.name}:`, err);
      }
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
      console.warn('[GOLBTELAS] Usuário cancelou ou permissão de tela negada:', err);
      return;
    }

    const videoTrack = localStream.getVideoTracks()[0] || null;
    const audioTrack = localStream.getAudioTracks()[0] || null;

    console.log('[GOLBTELAS] Iniciando transmissão de tela para os pares conectados:', peers.size);

    if (videoTrack) {
      videoTrack.addEventListener('ended', stopShare);
    }

    peers.forEach((peer, peerId) => {
      console.log(`[GOLBTELAS] Enviando faixa de vídeo e áudio para ${peer.name} (${peerId})`);
      if (peer.videoTransceiver && peer.videoTransceiver.sender) {
        peer.videoTransceiver.sender.replaceTrack(videoTrack)
          .then(() => console.log(`[GOLBTELAS] replaceTrack de vídeo OK para ${peer.name}`))
          .catch((err) => console.error(`[GOLBTELAS] replaceTrack de vídeo FALHOU para ${peer.name}:`, err));
      }
      if (peer.audioTransceiver && peer.audioTransceiver.sender) {
        peer.audioTransceiver.sender.replaceTrack(audioTrack)
          .then(() => console.log(`[GOLBTELAS] replaceTrack de áudio OK para ${peer.name}`))
          .catch((err) => console.error(`[GOLBTELAS] replaceTrack de áudio FALHOU para ${peer.name}:`, err));
      }
    });

    showLocalTile(localStream);

    shareBtn.classList.add('hidden');
    stopShareBtn.classList.remove('hidden');
    renderParticipants();
  }

  function stopShare() {
    if (!localStream) return;
    console.log('[GOLBTELAS] Parando transmissão de tela local');

    peers.forEach((peer) => {
      if (peer.videoTransceiver && peer.videoTransceiver.sender) {
        peer.videoTransceiver.sender.replaceTrack(null).catch(() => {});
      }
      if (peer.audioTransceiver && peer.audioTransceiver.sender) {
        peer.audioTransceiver.sender.replaceTrack(null).catch(() => {});
      }
    });

    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;

    removeRemoteTile('local');

    shareBtn.classList.remove('hidden');
    stopShareBtn.classList.add('hidden');
    renderParticipants();
  }

  // Preview da sua própria tela compartilhada
  function showLocalTile(stream) {
    let tile = remoteTiles.get('local');
    if (!tile) {
      const frag = videoTileTemplate.content.cloneNode(true);
      tile = frag.querySelector('.video-tile');
      tile.dataset.peerId = 'local';
      tile.classList.add('is-self');
      const muteBtn = tile.querySelector('.mute-toggle');
      if (muteBtn) muteBtn.remove(); // Sua própria tela não precisa de botão de som
      stageGrid.appendChild(tile);
      remoteTiles.set('local', tile);
    }
    const video = tile.querySelector('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    tile.querySelector('.tile-name').textContent = `${selfName} (você)`;
    attemptPlay(video);
    updateStageEmptyState();
    updateLiveCount();
  }

  // Render: grade de vídeo remoto
  function showRemoteTile(peerId, stream) {
    let tile = remoteTiles.get(peerId);
    if (!tile) {
      const frag = videoTileTemplate.content.cloneNode(true);
      tile = frag.querySelector('.video-tile');
      tile.dataset.peerId = peerId;
      const muteBtn = tile.querySelector('.mute-toggle');
      if (muteBtn) {
        muteBtn.addEventListener('click', () => {
          const v = tile.querySelector('video');
          v.muted = !v.muted;
          muteBtn.textContent = v.muted ? '🔇' : '🔊';
          muteBtn.title = v.muted ? 'Ativar áudio' : 'Mutar áudio';
          if (!v.muted) attemptPlay(v);
        });
      }
      stageGrid.appendChild(tile);
      remoteTiles.set(peerId, tile);
    }

    const video = tile.querySelector('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');

    // Atribui event.streams[0] (ou o stream remoto equivalente) ao srcObject do vídeo
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    tile.querySelector('.tile-name').textContent = participantsState.get(peerId) || 'Participante';
    attemptPlay(video);
    updateStageEmptyState();
    updateLiveCount();
  }

  function attemptPlay(video) {
    if (!video) return;
    const p = video.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // Se autoplay com som falhar por política de segurança do navegador, muta e reproduz
        video.muted = true;
        video.play().catch(() => {});
      });
    }
  }

  function removeRemoteTile(peerId) {
    const tile = remoteTiles.get(peerId);
    if (tile) {
      const video = tile.querySelector('video');
      if (video) {
        video.srcObject = null;
      }
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

  // Render: lista de participantes
  function renderParticipants() {
    participantList.innerHTML = '';
    const all = Array.from(participantsState.entries());

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

  // Copiar link da sala
  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(roomLinkInput.value);
      copyLinkBtn.textContent = 'Copiado!';
      setTimeout(() => (copyLinkBtn.textContent = 'Copiar'), 1500);
    } catch {
      roomLinkInput.select();
      document.execCommand('copy');
      copyLinkBtn.textContent = 'Copiado!';
      setTimeout(() => (copyLinkBtn.textContent = 'Copiar'), 1500);
    }
  });

  window.addEventListener('beforeunload', () => {
    peers.forEach((peer, peerId) => removePeer(peerId));
    if (socket) socket.emit('leave-room');
  });
})();
