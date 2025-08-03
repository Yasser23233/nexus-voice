/*
 * Client-side logic for the Nexus Voice chat room.
 *
 * Handles acquiring audio from the user's microphone, connecting to the
 * Socket.IO signalling server, establishing WebRTC peer connections,
 * exchanging session descriptions and ICE candidates, maintaining a
 * list of peers and providing UI feedback (speaking indicator, mute
 * toggle, copy link). The code is written to be robust against
 * reconnects and device changes by reusing sessionStorage for the
 * chosen user name and replacing audio tracks on the fly.
 */

(async function () {
  const username = sessionStorage.getItem('username');
  if (!username) {
    window.location.href = '/';
    return;
  }

  // DOM elements
  const currentUserEl = document.getElementById('current-user');
  const peerListEl = document.getElementById('peer-list');
  const muteBtn = document.getElementById('mute-btn');
  const copyLinkBtn = document.getElementById('copy-link');

  currentUserEl.textContent = username;

  // Local media and analysis
  let localStream;
  let localAnalyser;
  let audioCtx;
  let localDataArray;
  let isMuted = false;

  const audioContainer = document.createElement('div');
  audioContainer.id = 'audio-container';
  audioContainer.style.display = 'none';
  document.body.appendChild(audioContainer);

  // Peer connections
  const peers = {};
  const socket = io();
  let myPeerId = null;
  let iceServers = [];
  let icePolicy = 'all';

  // Microphone initialization (fix: request basic audio then apply constraints)
  async function requestMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('المتصفح لا يدعم الوصول إلى الميكروفون.');
      throw new Error('getUserMedia not supported');
    }
    try {
      // Basic audio request
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Try applying advanced constraints if supported
      const [track] = stream.getAudioTracks();
      if (track && track.getCapabilities) {
        const caps = track.getCapabilities();
        const wanted = { autoGainControl: true, echoCancellation: true, noiseSuppression: true };
        const supported = {};
        for (const k in wanted) if (caps[k] !== undefined) supported[k] = wanted[k];
        if (Object.keys(supported).length) {
          await track.applyConstraints(supported);
        }
      }

      localStream = stream;
    } catch (err) {
      alert('حدث خطأ في الوصول إلى الميكروفون: ' + err.message);
      throw err;
    }
  }

  // Start local speaking detection
  function startLocalAnalysis(stream) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    localAnalyser = audioCtx.createAnalyser();
    localAnalyser.fftSize = 512;
    localDataArray = new Uint8Array(localAnalyser.frequencyBinCount);
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(localAnalyser);
    function analyse() {
      localAnalyser.getByteFrequencyData(localDataArray);
      let sum = 0;
      for (let i = 0; i < localDataArray.length; i++) sum += localDataArray[i];
      const level = sum / localDataArray.length;
      setSpeaking(myPeerId, level > 40);
      requestAnimationFrame(analyse);
    }
    analyse();
  }

  // Analyse remote peer speaking
  function analyseRemote(peerId, stream) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    function analyse() {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const level = sum / dataArray.length;
      setSpeaking(peerId, level > 40);
      requestAnimationFrame(analyse);
    }
    analyse();
  }

  // Update UI speaking indicator
  function setSpeaking(peerId, speaking) {
    const item = peerListEl.querySelector(`[data-peer-id="${peerId}"]`);
    if (item) {
      if (speaking) item.classList.add('peer-speaking');
      else item.classList.remove('peer-speaking');
    }
  }

  // Render peer list
  function renderPeerList(list) {
    peerListEl.innerHTML = '';
    list.forEach(({ peerId, name }) => {
      const li = document.createElement('li');
      li.dataset.peerId = peerId;
      li.textContent = name;
      if (peerId === myPeerId) li.classList.add('peer-self');
      peerListEl.appendChild(li);
    });
  }

  // Add peer to list
  function addPeerToList(peerId, name) {
    let li = peerListEl.querySelector(`[data-peer-id="${peerId}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.peerId = peerId;
      li.textContent = name;
      peerListEl.appendChild(li);
    }
    if (peerId === myPeerId) li.classList.add('peer-self');
  }

  // Remove peer
  function removePeerFromList(peerId) {
    const li = peerListEl.querySelector(`[data-peer-id="${peerId}"]`);
    if (li) li.remove();
  }

  // Replace audio track in active peers
  function replaceTrack(newTrack) {
    Object.values(peers).forEach(({ pc }) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === 'audio') {
          sender.replaceTrack(newTrack);
        }
      });
    });
  }

  // Handle device change
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const newTrack = newStream.getAudioTracks()[0];
      replaceTrack(newTrack);
      localStream.getTracks().forEach((t) => t.stop());
      localStream = newStream;
      startLocalAnalysis(newStream);
    } catch (err) {
      console.error('Error while handling device change:', err);
    }
  });

  // Create PeerConnection
  function createPeerConnection(remotePeerId) {
    const pc = new RTCPeerConnection({
      iceServers: iceServers,
      iceTransportPolicy: icePolicy
    });

    if (localStream) {
      const track = localStream.getAudioTracks()[0];
      try {
        pc.addTrack(track, localStream);
      } catch (err) {
        pc.getSenders().forEach((sender) => {
          if (sender.track && sender.track.kind === 'audio') sender.replaceTrack(track);
        });
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', {
          targetPeerId: remotePeerId,
          data: { candidate: event.candidate }
        });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      let audioEl = peers[remotePeerId] && peers[remotePeerId].audio;
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.muted = false;
        audioContainer.appendChild(audioEl);
        if (peers[remotePeerId]) peers[remotePeerId].audio = audioEl;
      }
      audioEl.srcObject = stream;
      audioEl.play().catch(() => {});
      analyseRemote(remotePeerId, stream);
    };

    return pc;
  }

  // Ensure PeerConnection
  async function ensurePeerConnection(remotePeerId, remoteName, createOffer = false) {
    if (!peers[remotePeerId]) {
      peers[remotePeerId] = {
        pc: createPeerConnection(remotePeerId),
        name: remoteName
      };
    }
    if (createOffer) {
      try {
        const pc = peers[remotePeerId].pc;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('signal', {
          targetPeerId: remotePeerId,
          data: pc.localDescription.toJSON()
        });
      } catch (err) {
        console.error('Failed to create offer:', err);
      }
    }
  }

  // Socket handlers
  socket.on('welcome', ({ peerId, iceServers: servers, icePolicy: policy }) => {
    myPeerId = peerId;
    iceServers = servers || [];
    icePolicy = policy || 'all';
    if (localStream) startLocalAnalysis(localStream);
    socket.emit('join', { name: username });
  });

  socket.on('peer-list', (list) => {
    renderPeerList(list);
    list.forEach(({ peerId, name }) => {
      if (peerId === myPeerId) return;
      addPeerToList(peerId, name);
      if (!peers[peerId]) ensurePeerConnection(peerId, name, true);
    });
  });

  socket.on('peer-joined', ({ peerId, name }) => {
    addPeerToList(peerId, name);
    ensurePeerConnection(peerId, name, true);
  });

  socket.on('peer-left', ({ peerId }) => {
    removePeerFromList(peerId);
    const entry = peers[peerId];
    if (entry) {
      entry.pc.close();
      if (entry.audio && entry.audio.parentNode) {
        entry.audio.srcObject = null;
        entry.audio.parentNode.removeChild(entry.audio);
      }
      delete peers[peerId];
    }
  });

  socket.on('signal', async ({ from, data }) => {
    let entry = peers[from];
    if (!entry) {
      entry = peers[from] = {
        pc: createPeerConnection(from),
        name: ''
      };
    }
    const pc = entry.pc;
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', {
          targetPeerId: from,
          data: pc.localDescription.toJSON()
        });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.error('Error handling signal', err);
    }
  });

  socket.io.on('reconnect', () => {
    if (username) socket.emit('join', { name: username });
  });

  // UI interactions
  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });
    }
    muteBtn.textContent = isMuted ? 'إلغاء الكتم' : 'كتم';
  });

  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copyLinkBtn.textContent = 'تم النسخ';
      setTimeout(() => {
        copyLinkBtn.textContent = 'نسخ الرابط';
      }, 2000);
    } catch (err) {
      console.error('Copy to clipboard failed:', err);
    }
  });

  // Initialize microphone before connecting
  try {
    await requestMicrophone();
  } catch (_) {
    return;
  }
})();
