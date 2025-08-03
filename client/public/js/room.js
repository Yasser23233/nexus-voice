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

  // Check that getUserMedia is supported and request microphone access.
  async function requestMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('المتصفح لا يدعم الوصول إلى الميكروفون. الرجاء استخدام متصفح حديث مثل كروم أو فايرفوكس.');
      throw new Error('getUserMedia not supported');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      localStream = stream;
      // Log success and list of audio tracks for debugging
      console.log('getUserMedia success', stream);
      console.log('localStream tracks', stream.getAudioTracks());
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
    // When a remote track arrives, create an audio element and analyse it
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      // Create or update audio element for this peer
      let audioEl = peers[remotePeerId] && peers[remotePeerId].audio;
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.muted = false;
        audioContainer.appendChild(audioEl);
        // Save reference to remove later
        if (peers[remotePeerId]) peers[remotePeerId].audio = audioEl;
      }
      audioEl.srcObject = stream;
      // Play explicitly to satisfy some browsers
      const playPromise = audioEl.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.catch(() => {/* ignore */});
      }
      // Start analysing the remote stream
      analyseRemote(remotePeerId, stream);
      console.log('ontrack fired', stream);
      console.log('audioEl.srcObject', audioEl.srcObject);
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