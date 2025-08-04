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
    // If no username is stored, redirect back to lobby
    window.location.href = '/';
    return;
  }

  // DOM elements
  const currentUserEl = document.getElementById('current-user');
  const peerListEl = document.getElementById('peer-list');
  const muteBtn = document.getElementById('mute-btn');
  const copyLinkBtn = document.getElementById('copy-link');

  // Configure the mute button to show an unmuted speaker icon by default.
  // We will toggle the icon in the click handler below. If icons are not
  // rendered correctly the fallback text will still make sense.
  muteBtn.textContent = '🔈';

  currentUserEl.textContent = username;

  // Local media and analysis variables must be declared before
  // requestMicrophone() is called so that they exist in the scope
  // captured by that function. Otherwise `localStream` would be in
  // a temporal dead zone when accessed inside requestMicrophone.
  let localStream;
  let localAnalyser;
  let audioCtx;
  let localDataArray;
  let isMuted = false;

  // Audio constraints
  const audioConstraints = {
    audio: {
      autoGainControl: true,
      noiseSuppression: true,
      echoCancellation: true
    },
    video: false
  };

  // Request microphone access up front. If this fails the user will
  // receive a clear error message. We do this before connecting to
  // Socket.IO so that we have a stream ready to attach to peer
  // connections as soon as they are created.
  try {
    await requestMicrophone();
  } catch (_) {
    // If requesting the microphone failed, stop initialisation.
    return;
  }

  // Hidden container for remote audio elements
  const audioContainer = document.createElement('div');
  audioContainer.id = 'audio-container';
  audioContainer.style.display = 'none';
  document.body.appendChild(audioContainer);

  // Peer connections keyed by peerId
  const peers = {};

  // Signalling via Socket.IO
  const socket = io();
  let myPeerId = null;
  let iceServers = [];
  let icePolicy = 'all';


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
      // Span for the name
      const nameSpan = document.createElement('span');
      nameSpan.className = 'peer-name';
      nameSpan.textContent = name;
      // Span to display mute state
      const muteSpan = document.createElement('span');
      muteSpan.className = 'mute-indicator';
      muteSpan.textContent = '🔇';
      muteSpan.style.display = 'none';
      li.appendChild(nameSpan);
      li.appendChild(muteSpan);
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
      // Add name span and mute indicator
      const nameSpan = document.createElement('span');
      nameSpan.className = 'peer-name';
      nameSpan.textContent = name;
      const muteSpan = document.createElement('span');
      muteSpan.className = 'mute-indicator';
      muteSpan.textContent = '🔇';
      muteSpan.style.display = 'none';
      li.appendChild(nameSpan);
      li.appendChild(muteSpan);
      peerListEl.appendChild(li);
    }
    if (peerId === myPeerId) {
      li.classList.add('peer-self');
    }
  }

  // Update the mute indicator for a given peer
  function updateMuteStatus(peerId, muted) {
    const li = peerListEl.querySelector(`[data-peer-id="${peerId}"]`);
    if (li) {
      const muteEl = li.querySelector('.mute-indicator');
      if (muteEl) {
        muteEl.style.display = muted ? 'inline' : 'none';
      }
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
    // Local noise gate state: whether the audio track is currently enabled
    let gated = false;
    // Threshold above which the track is considered speaking.
    const SPEAK_THRESHOLD = 40;
    // Hysteresis to prevent rapid toggling (in dB/level units)
    const THRESHOLD_OFF = SPEAK_THRESHOLD * 0.7;

    function analyse() {
      localAnalyser.getByteFrequencyData(localDataArray);
      let sum = 0;
      for (let i = 0; i < localDataArray.length; i++) {
        sum += localDataArray[i];
      }
      const level = sum / localDataArray.length;
      // Show speaking indicator on the UI regardless of mute state
      setSpeaking(myPeerId, level > SPEAK_THRESHOLD);

      // Noise gate: enable/disable the audio track based on level when not manually muted
      const track = localStream && localStream.getAudioTracks()[0];
      if (track && !isMuted) {
        if (!gated && level > SPEAK_THRESHOLD) {
          // Start sending audio
          track.enabled = true;
          gated = true;
        } else if (gated && level < THRESHOLD_OFF) {
          // Suppress audio when quiet
          track.enabled = false;
          gated = false;
        }
      }
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

  // Check that getUserMedia is supported and request microphone access.
  async function requestMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('المتصفح لا يدعم الوصول إلى الميكروفون. الرجاء استخدام متصفح حديث مثل كروم أو فايرفوكس.');
      throw new Error('getUserMedia not supported');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      // Apply a dynamics compressor to suppress constant background
      // noise and level out the volume. This emulates noise
      // suppression found in VoIP applications like Discord. We pipe
      // the input stream through a DynamicsCompressorNode and extract
      // the processed MediaStream from a MediaStreamDestination.
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const compressor = ctx.createDynamicsCompressor();
      // Tune the compressor parameters for a gentle noise gate effect
      compressor.threshold.setValueAtTime(-50, ctx.currentTime);
      compressor.knee.setValueAtTime(40, ctx.currentTime);
      compressor.ratio.setValueAtTime(12, ctx.currentTime);
      compressor.attack.setValueAtTime(0.003, ctx.currentTime);
      compressor.release.setValueAtTime(0.25, ctx.currentTime);
      source.connect(compressor);
      const destination = ctx.createMediaStreamDestination();
      compressor.connect(destination);
      // Use the processed stream for all WebRTC connections
      localStream = destination.stream;
      // Log success and list of audio tracks for debugging
      console.log('getUserMedia success', stream);
      console.log('localStream tracks after compression', localStream.getAudioTracks());
    } catch (err) {
      console.error('getUserMedia error', err);
      if (err.name === 'NotAllowedError') {
        alert('تم رفض إذن الميكروفون. يرجى السماح بالوصول إلى الميكروفون من إعدادات المتصفح.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        alert('لم يتم العثور على جهاز ميكروفون. يرجى التحقق من توصيل الميكروفون.');
      } else {
        alert('حدث خطأ في الوصول إلى الميكروفون: ' + err.message);
      }
      throw err;
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
    // Add the local audio track to the connection. If it fails because
    // a track already exists, replace it. Log track addition for
    // debugging.
    if (localStream) {
      const track = localStream.getAudioTracks()[0];
      try {
        pc.addTrack(track, localStream);
        console.log('track added', track);
      } catch (err) {
        // If addTrack throws because a sender already exists, use replaceTrack
        pc.getSenders().forEach((sender) => {
          if (sender.track && sender.track.kind === 'audio') {
            sender.replaceTrack(track);
            console.log('track replaced');
          }
        });
      }
    }
    // Relay candidates to the remote peer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('signal', {
          targetPeerId: remotePeerId,
          data: { candidate: event.candidate }
        });
        console.log('sent ICE candidate to', remotePeerId, event.candidate);
      }
    };
    // When a remote track arrives, create or update an <audio> element
    pc.ontrack = ({ streams: [stream] }) => {
      console.log('ontrack fired', stream);
      // Look for an existing audio element for this peer by data attribute
      let audioEl = document.querySelector(`[data-audio="${remotePeerId}"]`);
      if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.dataset.audio = remotePeerId;
          audioEl.autoplay = true;
          audioEl.playsInline = true;
          audioEl.muted = false;
          document.body.appendChild(audioEl);
          // Save reference for removal when the peer leaves
          if (peers[remotePeerId]) {
            peers[remotePeerId].audio = audioEl;
          }
      }
      audioEl.srcObject = stream;
      // Attempt to play, catching any exceptions
      const p = audioEl.play();
      if (p && typeof p.then === 'function') p.catch((err) => console.error(err));
      console.log('audioEl.srcObject', audioEl.srcObject);
      // Analyse the remote stream for speaking indicator
      analyseRemote(remotePeerId, stream);
    };
    // Log ICE connection state changes
    pc.oniceconnectionstatechange = () => {
      console.log('ICE state:', pc.iceConnectionState);
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
        console.log('emit offer to', remotePeerId, offer);
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
  socket.on('welcome', ({ peerId, iceServers: servers, icePolicy: policy }) => {
    myPeerId = peerId;
    iceServers = servers || [];
    icePolicy = policy || 'all';
    // Start analysing local audio now that we have our own peerId
    if (localStream) {
      startLocalAnalysis(localStream);
    }
    // Announce ourselves to the server
    socket.emit('join', { name: username });
  });

  socket.on('peer-list', (list) => {
    // Render the full list in the UI
    renderPeerList(list);
    // For each peer create or update a connection
    list.forEach(({ peerId, name }) => {
      if (peerId === myPeerId) return;
      addPeerToList(peerId, name);
      // Create a peer connection but do not offer; the existing
      // participants will initiate negotiation when a new peer joins.
      ensurePeerConnection(peerId, name, /*createOffer=*/false);
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
      // Remove any associated audio element
      if (entry.audio && entry.audio.parentNode) {
        entry.audio.srcObject = null;
        entry.audio.parentNode.removeChild(entry.audio);
      }
      delete peers[peerId];
    }
  });

  socket.on('signal', async ({ from, data }) => {
    console.log('received signal from', from, data);
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
        console.log('emit answer to', from, answer);
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

  // Handle server rejection due to name conflict
  socket.on('join-error', ({ message }) => {
    alert(message || 'حدث خطأ عند الانضمام. يرجى اختيار اسم آخر.');
    // Disconnect and go back to lobby
    socket.disconnect();
    sessionStorage.removeItem('username');
    window.location.href = '/';
  });

  // Re-join on reconnection
  socket.io.on('reconnect', () => {
    if (username) {
      socket.emit('join', { name: username });
    }
  });

  // UI interactions
  muteBtn.addEventListener('click', () => {
    // Toggle the local mute state and update track enabled flags
    isMuted = !isMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = !isMuted;
      });
    }
    // Emit our mute status to other peers so they can update
    // indicators. Only manual toggles are propagated.
    socket.emit('mute', { muted: isMuted });
    // Update the button appearance: show a muted or unmuted speaker icon
    if (isMuted) {
      muteBtn.textContent = '🔇';
      muteBtn.classList.add('muted');
    } else {
      muteBtn.textContent = '🔈';
      muteBtn.classList.remove('muted');
    }
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

  // Handle logout: clear session, close connections and redirect
  const logoutBtn = document.getElementById('logout-btn');
  logoutBtn.addEventListener('click', () => {
    try {
      // Close all peer connections
      Object.values(peers).forEach(({ pc, audio }) => {
        if (pc) pc.close();
        if (audio && audio.parentNode) {
          audio.srcObject = null;
          audio.parentNode.removeChild(audio);
        }
      });
      // Stop local stream
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
      // Disconnect socket
      socket.disconnect();
    } catch (err) {
      console.error('Error during logout', err);
    }
    sessionStorage.removeItem('username');
    window.location.href = '/';
  });

  // Listen for mute events from other peers and update the UI
  socket.on('mute', ({ peerId, muted }) => {
    updateMuteStatus(peerId, muted);
  });
})();