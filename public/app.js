(() => {
  const SERVER_URL = (window.location.hostname === 'localhost' && window.location.port === '3000')
    ? 'http://localhost:3000'
    : 'https://tela-production-dff8.up.railway.app';

  // Configuração padrão de ICE Servers (fallback caso a API falhe)
  let rtcConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
    ],
  };

  // Carrega configuração de servidores STUN/TURN dinamicamente da API do servidor
  async function loadIceConfig() {
    try {
      const res = await fetch(`${SERVER_URL}/api/ice-servers`);
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

  loadIceConfig();

  // ---------- estado ----------
  let socket = null;
  let selfId = null;
  let selfName = '';
  let roomId = getRoomIdFromUrl();
  let localStream = null;
  let isCameraActive = false;
  let isNativeCaptureActive = false;
  let nativeFrameListener = null;
  let nativeStopListener = null;
  let currentFacingMode = 'user';
  let currentSpotlightId = null; // null = Modo Grade; string (peerId ou 'local') = Modo Foco

  const peers = new Map();
  const remoteTiles = new Map(); // peerId -> tile element
  const participantsState = new Map(); // peerId -> { name: string, isSharing: boolean }

  // ---------- elementos ----------
  const joinView = document.getElementById('joinView');
  const roomView = document.getElementById('roomView');
  const nameInput = document.getElementById('nameInput');
  const joinBtn = document.getElementById('joinBtn');
  const connDot = document.getElementById('connDot');

  const stagePanel = document.getElementById('stagePanel');
  const stageGrid = document.getElementById('stageGrid');
  const stageEmpty = document.getElementById('stageEmpty');
  const liveCount = document.getElementById('liveCount');

  const layoutGridBtn = document.getElementById('layoutGridBtn');
  const layoutFocusBtn = document.getElementById('layoutFocusBtn');
  const panelFullscreenBtn = document.getElementById('panelFullscreenBtn');
  const stageFullscreenBtn = document.getElementById('stageFullscreenBtn');

  const shareBtn = document.getElementById('shareBtn');
  const cameraBtn = document.getElementById('cameraBtn');
  const flipCameraBtn = document.getElementById('flipCameraBtn');
  const stopShareBtn = document.getElementById('stopShareBtn');
  const participantList = document.getElementById('participantList');
  const participantCount = document.getElementById('participantCount');
  const roomLinkInput = document.getElementById('roomLinkInput');
  const copyLinkBtn = document.getElementById('copyLinkBtn');
  const videoTileTemplate = document.getElementById('videoTileTemplate');

  roomLinkInput.value = `https://tela-production-dff8.up.railway.app/?room=${roomId}`;

  function getRoomIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    let r = params.get('room');
    if (!r) {
      r = 'sala-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

    await loadIceConfig();
    connectSocket();
  }

  function connectSocket() {
    socket = io(SERVER_URL, {
      secure: SERVER_URL.startsWith('https:'),
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      console.log(`[GOLBTELAS] Conectado ao servidor (${socket.id})`);
      connDot.style.background = '#3DDC84';
      socket.emit('join-room', { room: roomId, name: selfName });
    });

    socket.on('disconnect', (reason) => {
      console.warn('[GOLBTELAS] Desconectado do servidor:', reason);
      connDot.style.background = 'var(--live)';
    });

    socket.on('joined', ({ selfId: id, existingPeers }) => {
      selfId = id;
      console.log(`[GOLBTELAS] Entrou na sala ${roomId} com ID ${selfId}. Peers existentes:`, existingPeers);
      participantsState.set(selfId, { name: selfName, isSharing: false });
      joinView.classList.add('hidden');
      roomView.classList.remove('hidden');

      existingPeers.forEach((p) => {
        participantsState.set(p.id, { name: p.name, isSharing: !!p.isSharing });
        const peer = ensurePeer(p.id, p.name);
        peer.isSharing = !!p.isSharing;
      });
      renderParticipants();
    });

    socket.on('peer-joined', ({ id, name, isSharing }) => {
      participantsState.set(id, { name, isSharing: !!isSharing });
      const peer = ensurePeer(id, name);
      peer.isSharing = !!isSharing;
      renderParticipants();
    });

    socket.on('participants-update', (list) => {
      list.forEach((p) => {
        participantsState.set(p.id, { name: p.name, isSharing: !!p.isSharing });
        const peer = peers.get(p.id);
        if (peer) {
          peer.isSharing = !!p.isSharing;
          if (!peer.isSharing) {
            removeRemoteTile(p.id);
          } else if (peer.remoteStream && peer.remoteStream.getVideoTracks().length > 0) {
            showRemoteTile(p.id, peer.remoteStream);
          }
        }
      });
      renderParticipants();
    });

    socket.on('peer-share-state', ({ id, sharing }) => {
      const pState = participantsState.get(id);
      if (pState) pState.isSharing = sharing;
      const peer = peers.get(id);
      if (peer) {
        peer.isSharing = sharing;
        if (sharing) {
          if (peer.remoteStream && peer.remoteStream.getVideoTracks().length > 0) {
            showRemoteTile(id, peer.remoteStream);
          }
        } else {
          removeRemoteTile(id);
        }
      }
      renderParticipants();
    });

    socket.on('peer-left', ({ id }) => {
      removePeer(id);
      renderParticipants();
    });

    socket.on('signal', async ({ from, data }) => {
      if (!data) return;

      let peer = peers.get(from);
      if (!peer) {
        const pInfo = participantsState.get(from);
        peer = ensurePeer(from, pInfo ? pInfo.name : 'Participante');
      }
      const { pc, name } = peer;

      try {
        if (data.description) {
          const description = data.description;
          const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
          const offerCollision = description.type === 'offer' && !readyForOffer;

          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) return;

          peer.isSettingRemoteAnswerPending = (description.type === 'answer');
          await pc.setRemoteDescription(new RTCSessionDescription(description));
          peer.isSettingRemoteAnswerPending = false;

          if (peer.iceCandidateQueue.length > 0) {
            const candidates = peer.iceCandidateQueue.splice(0, peer.iceCandidateQueue.length);
            for (const cand of candidates) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(cand));
              } catch (err) {}
            }
          }

          if (description.type === 'offer') {
            await pc.setLocalDescription();
            sendSignal(from, { description: pc.localDescription });
          }
        } else if (data.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {}
          } else {
            peer.iceCandidateQueue.push(data.candidate);
          }
        }
      } catch (err) {
        console.error(`[GOLBTELAS][${name}] Erro no sinal:`, err);
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
      isSettingRemoteAnswerPending: false,
      isSharing: false,
      restartCount: 0,
      lastRestartTime: 0,
      iceCandidateQueue: [],
      videoTransceiver,
      audioTransceiver,
      remoteStream: new MediaStream(),
    };
    peers.set(peerId, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal(peerId, { candidate: e.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        peer.restartCount = 0;
      } else if (state === 'failed') {
        handleIceFailure(peerId, peer);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        peer.restartCount = 0;
      } else if (state === 'failed') {
        handleIceFailure(peerId, peer);
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(peerId, { description: pc.localDescription });
      } catch (err) {
        console.error(`[GOLBTELAS][${name}] Falha na negociação:`, err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.ontrack = (e) => {
      if (!peer.remoteStream.getTracks().includes(e.track)) {
        peer.remoteStream.addTrack(e.track);
      }
      if (e.track.kind === 'video' && peer.isSharing) {
        showRemoteTile(peerId, peer.remoteStream);
      }
      e.track.onunmute = () => {
        if (e.track.kind === 'video' && peer.isSharing) {
          showRemoteTile(peerId, peer.remoteStream);
        }
      };
    };

    if (localStream) {
      const vTrack = localStream.getVideoTracks()[0] || null;
      const aTrack = localStream.getAudioTracks()[0] || null;
      videoTransceiver.sender.replaceTrack(vTrack).catch(() => {});
      audioTransceiver.sender.replaceTrack(aTrack).catch(() => {});
    }

    return peer;
  }

  function handleIceFailure(peerId, peer) {
    const now = Date.now();
    if (now - peer.lastRestartTime < 8000) return;
    if (peer.restartCount >= 2) return;

    peer.restartCount = (peer.restartCount || 0) + 1;
    peer.lastRestartTime = now;

    if (typeof peer.pc.restartIce === 'function') {
      try {
        peer.pc.restartIce();
      } catch (err) {}
    }
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (peer) {
      try {
        peer.pc.close();
      } catch (err) {}
      peers.delete(peerId);
    }
    participantsState.delete(peerId);
    removeRemoteTile(peerId);
  }

  // ---------- Iniciar Transmissão de Tela / Câmera ----------
  shareBtn.addEventListener('click', startScreenShare);
  cameraBtn.addEventListener('click', startCamera);
  flipCameraBtn.addEventListener('click', flipCamera);
  stopShareBtn.addEventListener('click', stopShare);

  async function startScreenShare() {
    const isCapacitorNative = !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenCapture);

    if (isCapacitorNative) {
      try {
        const { ScreenCapture } = window.Capacitor.Plugins;
        await ScreenCapture.startCapture();

        const canvas = document.createElement('canvas');
        canvas.width = 720;
        canvas.height = 1280;
        const ctx = canvas.getContext('2d');
        const img = new Image();

        const canvasStream = canvas.captureStream(25);
        localStream = canvasStream;
        isNativeCaptureActive = true;
        isCameraActive = false;

        nativeFrameListener = await ScreenCapture.addListener('screenFrame', (data) => {
          if (data && data.image) {
            img.onload = () => {
              if (canvas.width !== img.width || canvas.height !== img.height) {
                canvas.width = img.width;
                canvas.height = img.height;
              }
              ctx.drawImage(img, 0, 0);
            };
            img.src = data.image;
          }
        });

        nativeStopListener = await ScreenCapture.addListener('screenCaptureStopped', () => {
          stopShare();
        });

        applyLocalStreamAndBroadcast();
        return;
      } catch (nativeErr) {
        console.warn('[GOLBTELAS] Permissão cancelada ou erro:', nativeErr);
        return;
      }
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      alert('O compartilhamento de tela não é suportado pelo seu navegador atual. Use o app Android ou acesse pelo computador.');
      return;
    }

    try {
      try {
        localStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
      } catch (audioErr) {
        localStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
      }
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') return;
      alert('Não foi possível iniciar o compartilhamento: ' + (err.message || err.name));
      return;
    }

    isCameraActive = false;
    isNativeCaptureActive = false;
    applyLocalStreamAndBroadcast();
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Seu dispositivo não possui permissão para acessar a câmera.');
      return;
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode },
        audio: true,
      });
    } catch (err) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: currentFacingMode },
          audio: false,
        });
      } catch (camErr) {
        if (camErr.name === 'NotAllowedError' || camErr.name === 'AbortError') return;
        alert('Não foi possível acessar a câmera: ' + (camErr.message || camErr.name));
        return;
      }
    }

    isCameraActive = true;
    isNativeCaptureActive = false;
    applyLocalStreamAndBroadcast();
  }

  async function flipCamera() {
    if (!localStream || !isCameraActive) return;

    currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';

    let newStream = null;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: currentFacingMode } },
        audio: true,
      });
    } catch (err) {
      try {
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: currentFacingMode } },
          audio: false,
        });
      } catch (err2) {
        alert('Não foi possível alternar a câmera.');
        currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';
        return;
      }
    }

    const newVideoTrack = newStream.getVideoTracks()[0] || null;
    const newAudioTrack = newStream.getAudioTracks()[0] || null;

    peers.forEach((peer) => {
      if (peer.videoTransceiver && peer.videoTransceiver.sender && newVideoTrack) {
        peer.videoTransceiver.sender.replaceTrack(newVideoTrack).catch(() => {});
      }
      if (peer.audioTransceiver && peer.audioTransceiver.sender && newAudioTrack) {
        peer.audioTransceiver.sender.replaceTrack(newAudioTrack).catch(() => {});
      }
    });

    localStream.getTracks().forEach((t) => t.stop());
    localStream = newStream;

    showLocalTile(localStream);
  }

  function applyLocalStreamAndBroadcast() {
    if (!localStream) return;

    const videoTrack = localStream.getVideoTracks()[0] || null;
    const audioTrack = localStream.getAudioTracks()[0] || null;

    if (videoTrack) {
      videoTrack.addEventListener('ended', stopShare);
    }

    peers.forEach((peer) => {
      if (peer.videoTransceiver && peer.videoTransceiver.sender) {
        peer.videoTransceiver.sender.replaceTrack(videoTrack).catch(() => {});
      }
      if (peer.audioTransceiver && peer.audioTransceiver.sender) {
        peer.audioTransceiver.sender.replaceTrack(audioTrack).catch(() => {});
      }
    });

    if (socket && socket.connected) {
      socket.emit('share-state', { sharing: true });
    }

    const myState = participantsState.get(selfId);
    if (myState) myState.isSharing = true;

    showLocalTile(localStream);

    shareBtn.classList.add('hidden');
    cameraBtn.classList.add('hidden');
    if (isCameraActive) {
      flipCameraBtn.classList.remove('hidden');
    } else {
      flipCameraBtn.classList.add('hidden');
    }
    stopShareBtn.classList.remove('hidden');
    renderParticipants();
  }

  function stopShare() {
    if (!localStream) return;

    if (isNativeCaptureActive && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenCapture) {
      if (nativeFrameListener && nativeFrameListener.remove) nativeFrameListener.remove();
      if (nativeStopListener && nativeStopListener.remove) nativeStopListener.remove();
      window.Capacitor.Plugins.ScreenCapture.stopCapture().catch(() => {});
      isNativeCaptureActive = false;
    }

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
    isCameraActive = false;

    if (socket && socket.connected) {
      socket.emit('share-state', { sharing: false });
    }

    const myState = participantsState.get(selfId);
    if (myState) myState.isSharing = false;

    removeRemoteTile('local');

    shareBtn.classList.remove('hidden');
    cameraBtn.classList.remove('hidden');
    flipCameraBtn.classList.add('hidden');
    stopShareBtn.classList.add('hidden');
    renderParticipants();
  }

  // ---------- Gestão de Layout: Grade vs Modo Foco / Destaque ----------
  layoutGridBtn.addEventListener('click', () => setSpotlightMode(null));
  layoutFocusBtn.addEventListener('click', () => {
    // Escolhe o primeiro stream ativo como foco se não houver nenhum
    const firstActive = Array.from(remoteTiles.keys())[0] || 'local';
    setSpotlightMode(firstActive);
  });

  panelFullscreenBtn.addEventListener('click', () => toggleFullscreen(stagePanel));
  stageFullscreenBtn.addEventListener('click', () => toggleFullscreen(document.documentElement));

  function setSpotlightMode(peerId) {
    currentSpotlightId = peerId;
    layoutGridBtn.classList.toggle('active', !peerId);
    layoutFocusBtn.classList.toggle('active', !!peerId);
    reorganizeStageTiles();
  }

  function reorganizeStageTiles() {
    stageGrid.classList.toggle('spotlight-mode', !!currentSpotlightId);

    // Remove qualquer barra de miniaturas antiga
    let strip = stageGrid.querySelector('.spotlight-strip');
    if (strip) strip.remove();

    if (!currentSpotlightId) {
      // Modo Grade: todas as tiles voltam à grade normal
      remoteTiles.forEach((tile) => {
        tile.classList.remove('is-spotlight');
        stageGrid.appendChild(tile);
      });
    } else {
      // Modo Foco: tile em destaque no topo + barra de miniaturas embaixo
      strip = document.createElement('div');
      strip.className = 'spotlight-strip';

      remoteTiles.forEach((tile, id) => {
        if (id === currentSpotlightId) {
          tile.classList.add('is-spotlight');
          stageGrid.appendChild(tile);
        } else {
          tile.classList.remove('is-spotlight');
          strip.appendChild(tile);
        }
      });

      if (strip.children.length > 0) {
        stageGrid.appendChild(strip);
      }
    }
  }

  // Render: Tile local
  function showLocalTile(stream) {
    let tile = remoteTiles.get('local');
    if (!tile) {
      const frag = videoTileTemplate.content.cloneNode(true);
      tile = frag.querySelector('.video-tile');
      tile.dataset.peerId = 'local';
      tile.classList.add('is-self');
      
      const muteBtn = tile.querySelector('.mute-toggle');
      if (muteBtn) muteBtn.remove();

      const focusBtn = tile.querySelector('.focus-toggle');
      if (focusBtn) {
        focusBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setSpotlightMode(currentSpotlightId === 'local' ? null : 'local');
        });
      }

      const fsBtn = tile.querySelector('.fullscreen-toggle');
      if (fsBtn) {
        fsBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleFullscreen(tile.querySelector('video') || tile);
        });
      }

      // Clique direto na tile alterna foco para ela
      tile.addEventListener('click', () => {
        if (currentSpotlightId !== 'local') setSpotlightMode('local');
      });

      // Duplo clique entra em tela cheia
      tile.addEventListener('dblclick', () => toggleFullscreen(tile.querySelector('video') || tile));

      stageGrid.appendChild(tile);
      remoteTiles.set('local', tile);
    }
    const video = tile.querySelector('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', 'true');

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    tile.querySelector('.tile-name').textContent = `${selfName} (você)`;
    attemptPlay(video);
    updateStageEmptyState();
    updateLiveCount();
    reorganizeStageTiles();
  }

  // Render: Tile remoto
  function showRemoteTile(peerId, stream) {
    let tile = remoteTiles.get(peerId);
    if (!tile) {
      const frag = videoTileTemplate.content.cloneNode(true);
      tile = frag.querySelector('.video-tile');
      tile.dataset.peerId = peerId;

      const muteBtn = tile.querySelector('.mute-toggle');
      if (muteBtn) {
        muteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const v = tile.querySelector('video');
          v.muted = !v.muted;
          muteBtn.textContent = v.muted ? '🔇' : '🔊';
          muteBtn.title = v.muted ? 'Ativar áudio' : 'Mutar áudio';
          if (!v.muted) attemptPlay(v);
        });
      }

      const focusBtn = tile.querySelector('.focus-toggle');
      if (focusBtn) {
        focusBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setSpotlightMode(currentSpotlightId === peerId ? null : peerId);
        });
      }

      const fsBtn = tile.querySelector('.fullscreen-toggle');
      if (fsBtn) {
        fsBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleFullscreen(tile.querySelector('video') || tile);
        });
      }

      // Clique direto na tile alterna foco para ela
      tile.addEventListener('click', () => {
        if (currentSpotlightId !== peerId) setSpotlightMode(peerId);
      });

      // Duplo clique entra em tela cheia
      tile.addEventListener('dblclick', () => toggleFullscreen(tile.querySelector('video') || tile));

      stageGrid.appendChild(tile);
      remoteTiles.set(peerId, tile);
    }

    const video = tile.querySelector('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', 'true');

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    const pState = participantsState.get(peerId);
    tile.querySelector('.tile-name').textContent = pState ? pState.name : 'Participante';
    attemptPlay(video);
    updateStageEmptyState();
    updateLiveCount();
    reorganizeStageTiles();
  }

  function toggleFullscreen(elem) {
    if (!elem) return;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      } else {
        if (elem.requestFullscreen) {
          elem.requestFullscreen();
        } else if (elem.webkitRequestFullscreen) {
          elem.webkitRequestFullscreen();
        } else if (elem.webkitEnterFullscreen) {
          elem.webkitEnterFullscreen();
        } else if (elem.msRequestFullscreen) {
          elem.msRequestFullscreen();
        }
      }
    } catch (err) {
      console.warn('[GOLBTELAS] Erro ao alternar tela cheia:', err);
    }
  }

  function attemptPlay(video) {
    if (!video) return;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', 'true');

    const p = video.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        video.muted = true;
        video.play().catch(() => {});
      });
    }
  }

  function removeRemoteTile(peerId) {
    const tile = remoteTiles.get(peerId);
    if (tile) {
      const video = tile.querySelector('video');
      if (video) video.srcObject = null;
      tile.remove();
      remoteTiles.delete(peerId);
    }
    if (currentSpotlightId === peerId) {
      currentSpotlightId = null;
    }
    updateStageEmptyState();
    updateLiveCount();
    reorganizeStageTiles();
  }

  function updateStageEmptyState() {
    stageEmpty.classList.toggle('hidden', remoteTiles.size > 0);
  }

  function updateLiveCount() {
    let count = 0;
    if (localStream) count++;
    remoteTiles.forEach((_, key) => {
      if (key !== 'local') count++;
    });
    liveCount.textContent = `${count} AO VIVO`;
  }

  function renderParticipants() {
    participantList.innerHTML = '';
    const all = Array.from(participantsState.entries());

    all.forEach(([id, data]) => {
      if (!id) return;
      const li = document.createElement('li');
      li.className = 'participant-item';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = (data.name || '?').trim().charAt(0).toUpperCase();

      const nameSpan = document.createElement('span');
      nameSpan.textContent = data.name;
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
      } else if (data.isSharing) {
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
