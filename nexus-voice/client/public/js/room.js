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

(function () {
  const username = sessionStorage.getItem('username');
  if (!username) {
    // If no username is stored, redirect back to lobby
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

  // Peer connections keyed by peerId
  const peers = {};

  // Signalling via Socket.IO
  const socket = io();
  let myPeerId = null;
  let iceServers = [];
  let icePolicy = 'all';

  // Audio constraints
  const audioConstraints = {
    audio: {
      autoGainControl: true,
      noiseSuppression: true,
      echoCancellation: true
    },
    video: false
  };

  // Utility to update speaking indicator on the UI
  function setSpeaking(peerId, speaking) {
    const item = peerListEl.querySelector(`[data-peer-id="${peerId}"]`);
    if (item) {
      if (speaking) item.classList.add('peer-speaking');
      else item.classList.remove('peer-speaking');
    }
  }

  // Render the entire peer list
  function renderPeerList(list) {
    peerListEl.innerHTML = '';
    list.forEach(({ peerId, name }) => {
      const li = document.createElement('li');
      li.dataset.peerId = peerId;
      li.textContent = name;
      if (peerId === myPeerId) {
        li.classList.add('peer-self');
      }
      peerListEl.appendChild(li);
    });
  }

  // Add a single peer to the list if not already present
  function addPeerToList(peerId, name) {
    let li = peerListEl.querySelector(`[data-peer-id="${peerId}"]`);
    if (!li) {
      li = document.createElement('li');
      li.dataset.peerId = peerId;
      li.textContent = name;
      peerListEl.appendChild(li);
    }
    if (peerId === myPeerId) {
      li.classList.add('peer-self');
    }
  }

  // Remove a peer from the list
  function removePeerFromList(peerId) {
    const li = peerListEl.querySelector(`[data-peer-id="${peerId}"]`);
    if (li) li.remove();
  }

  // Start analysing local audio for speaking detection
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
      for (let i = 0; i < localDataArray.length; i++) {
        sum += localDataArray[i];
      }
      const level = sum / localDataArray.length;
      setSpeaking(myPeerId, level > 40);
      requestAnimationFrame(analyse);
    }
    analyse();
  }

  // Analyse remote audio stream for a peer
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

  // Acquire microphone access
  async function acquireMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      localStream = stream;
      startLocalAnalysis(stream);
    } catch (err) {
      console.error('Failed to acquire microphone:', err);
      alert('تعذر الوصول إلى الميكروفون. يرجى السماح بالأذونات والمحاولة مجددًا.');
    }
  }

  // Replace the audio track on all peer connections with a new track
  function replaceTrack(newTrack) {
    Object.values(peers).forEach(({ pc }) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track && sender.track.kind === 'audio') {
          sender.replaceTrack(newTrack);
        }
      });
    });
  }

  // Handle device changes (e.g. user plugged in a new microphone)
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      const newTrack = newStream.getAudioTracks()[0];
      // Replace the track on all senders
      replaceTrack(newTrack);
      // Stop old tracks and update the local reference
      localStream.getTracks().forEach((t) => t.stop());
      localStream = newStream;
      startLocalAnalysis(newStream);
    } catch (err) {
      console.error('Error while handling device change:', err);
    }
  });

  // Create a new RTCPeerConnection for a remote peer
  function createPeerConnection(remotePeerId) {
    const pc = new RTCPeerConnection({
      iceServers: iceServers,
      iceTransportPolicy: icePolicy
    });
    // Add the local audio track to the connection
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }
    // Relay candidates to the remote peer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', {
          targetPeerId: remotePeerId,
          data: { candidate: event.candidate }
        });
      }
    };
    // When a remote track arrives, start analysing it
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      analyseRemote(remotePeerId, stream);
    };
    return pc;
  }

  // Start negotiating with a remote peer. If createOffer is true, this peer
  // initiates the offer; otherwise it waits for the offer.
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

  // Socket.IO event handlers
  socket.on('welcome', async ({ peerId, iceServers: servers, icePolicy: policy }) => {
    myPeerId = peerId;
    iceServers = servers || [];
    icePolicy = policy || 'all';
    // Acquire microphone before joining
    await acquireMicrophone();
    // Now announce ourselves to the server
    socket.emit('join', { name: username });
  });

  socket.on('peer-list', (list) => {
    // Render the full list in the UI
    renderPeerList(list);
    // For each peer create or update a connection
    list.forEach(({ peerId, name }) => {
      if (peerId === myPeerId) return;
      addPeerToList(peerId, name);
      // If we don't have a connection yet, this client will initiate
      if (!peers[peerId]) {
        ensurePeerConnection(peerId, name, true);
      }
    });
  });

  socket.on('peer-joined', ({ peerId, name }) => {
    addPeerToList(peerId, name);
    // Initiate a connection to the new peer
    ensurePeerConnection(peerId, name, true);
  });

  socket.on('peer-left', ({ peerId }) => {
    // Remove the peer from the UI
    removePeerFromList(peerId);
    // Close and delete the peer connection
    const entry = peers[peerId];
    if (entry) {
      entry.pc.close();
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
        // Remote peer is initiating; set remote description and answer
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

  // Re-join on reconnection
  socket.io.on('reconnect', () => {
    if (username) {
      socket.emit('join', { name: username });
    }
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
})();