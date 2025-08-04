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
  const noiseBtn = document.getElementById('noise-btn');

  currentUserEl.textContent = username;

  /*
   * Maintain a list of all AudioContext instances created during the
   * lifetime of this page. Mobile browsers require a user gesture to
   * start audio playback. By registering a one‑off click/touch handler
   * that resumes all contexts we ensure that local analysis, noise
   * gating and remote analysis all begin processing as soon as the
   * user interacts with the page. Without this many mobile devices
   * (particularly Safari on iOS) will remain silent until the user
   * explicitly interacts with the page, leading to confusion.
   */
  const audioContexts = [];
  function unlockAudio() {
    audioContexts.forEach((ctx) => {
      try {
        if (ctx && typeof ctx.resume === 'function' && ctx.state !== 'running') {
          ctx.resume().catch(() => {});
        }
      } catch (_) {}
    });
    document.body.removeEventListener('touchstart', unlockAudio);
    document.body.removeEventListener('click', unlockAudio);
  }
  // Use once:true to ensure the handler fires a single time on first interaction
  document.body.addEventListener('touchstart', unlockAudio, { once: true });
  document.body.addEventListener('click', unlockAudio, { once: true });

  /**
   * Apply a flashing neon effect to the main title. Wrap each
   * character in a span with the class .neon-letter and set a
   * random animation delay so the letters flash independently. This
   * runs once when the room script loads.
   */
  function applyNeonEffect() {
    const title = document.querySelector('.app-title');
    if (!title || title.classList.contains('neon-applied')) return;
    const text = title.textContent;
    const fragments = [];
    for (const char of text) {
      if (char.trim() === '') {
        fragments.push(char);
      } else {
        const span = document.createElement('span');
        span.className = 'neon-letter';
        span.textContent = char;
        const delay = (Math.random() * 4).toFixed(2);
        span.style.animationDelay = `-${delay}s`;
        fragments.push(span.outerHTML);
      }
    }
    title.innerHTML = fragments.join('');
    title.classList.add('neon-applied');
  }

  applyNeonEffect();

  /**
   * Introduce occasional letter glitches into the title. Every 8–12
   * seconds a single random letter will dim briefly to simulate a
   * failing neon tube. This implementation is identical to the
   * function in lobby.js to ensure a consistent effect across pages.
   */
  function initGlitch() {
    const letters = document.querySelectorAll('.app-title .neon-letter');
    if (!letters.length) return;
    let timer;
    const trigger = () => {
      const idx = Math.floor(Math.random() * letters.length);
      const el = letters[idx];
      el.classList.add('glitch-off');
      setTimeout(() => {
        el.classList.remove('glitch-off');
      }, 300);
      const delay = 8000 + Math.random() * 4000;
      timer = setTimeout(trigger, delay);
    };
    const initialDelay = 4000 + Math.random() * 4000;
    timer = setTimeout(trigger, initialDelay);
  }

  initGlitch();

  // Local media and analysis variables must be declared before
  // requestMicrophone() is called so that they exist in the scope
  // captured by that function. Otherwise `localStream` would be in
  // a temporal dead zone when accessed inside requestMicrophone.
  let localStream;
  let localAnalyser;
  let audioCtx;
  let localDataArray;
  let isMuted = false;
  // Controller for the dynamic noise gate. It exposes an enable() method
  // to toggle gating on and off at runtime.
  let noiseGateController;
  // Flag to track the current noise suppression state
  let noiseEnabled = true;

  // Play a short beep using the Web Audio API. Different frequencies can
  // indicate different events (e.g. join vs leave). The duration is fixed
  // at 0.2 seconds. This function is safe to call without awaiting.
  function playBeep(frequency = 880) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.connect(gain).connect(ctx.destination);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch (e) {
      console.warn('Beep failed:', e);
    }
  }

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

  // Noise suppression is enabled by default; update the button label
  // accordingly. If noiseEnabled is false then the button should
  // instruct the user to enable the noise gate. Otherwise it should
  // instruct to disable it.
  if (noiseBtn) {
    noiseBtn.textContent = noiseEnabled ? 'إيقاف العزل' : 'تفعيل العزل';
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

  // Update the muted status for a peer. This toggles a CSS class and
  // shows or hides the mute icon within the list item. For the local
  // user the same function will update their own list entry.
  function updateMuteStatus(peerId, muted) {
    const li = peerListEl.querySelector(`[data-peer-id="${peerId}"]`);
    if (!li) return;
    if (muted) {
      li.classList.add('peer-muted');
    } else {
      li.classList.remove('peer-muted');
    }
  }

  // Render the entire peer list
  function renderPeerList(list) {
    peerListEl.innerHTML = '';
    list.forEach(({ peerId, name }) => {
      const li = document.createElement('li');
      li.dataset.peerId = peerId;
      li.classList.add('peer-entry');
      // Name span
      const nameSpan = document.createElement('span');
      nameSpan.className = 'peer-name';
      nameSpan.textContent = name;
      li.appendChild(nameSpan);
      // Mute icon span (hidden by default)
      const muteIcon = document.createElement('span');
      muteIcon.className = 'mute-icon';
      // Leave text empty; the icon is drawn via CSS (see nexus.css)
      muteIcon.textContent = '';
      li.appendChild(muteIcon);
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
      li.classList.add('peer-entry');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'peer-name';
      nameSpan.textContent = name;
      li.appendChild(nameSpan);
      const muteIcon = document.createElement('span');
      muteIcon.className = 'mute-icon';
      muteIcon.textContent = '';
      li.appendChild(muteIcon);
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
    // Keep track of this context so we can resume it on the first user
    // interaction (required on mobile browsers).
    audioContexts.push(audioCtx);
    localAnalyser = audioCtx.createAnalyser();
    // Use a smaller FFT size to improve responsiveness and reduce
    // perceived delay in the speaking indicator.
    localAnalyser.fftSize = 256;
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
      // Raise the threshold slightly to avoid constant triggering from
      // ambient noise. A threshold around 50 works well with our 256
      // point FFT.
      setSpeaking(myPeerId, level > 50);
      requestAnimationFrame(analyse);
    }
    analyse();

    // Ensure the audio context is running. Some browsers start new
    // AudioContext instances in a suspended state until resumed. By
    // calling resume() here we guarantee immediate operation on
    // platforms that allow it, while the unlockAudio handler will
    // resume contexts on user interaction where required.
    audioCtx.resume().catch(() => {});
  }

  // Analyse remote audio stream for a peer
  function analyseRemote(peerId, stream) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Keep a reference for unlocking on mobile
    audioContexts.push(ctx);
    const analyser = ctx.createAnalyser();
    // Use a smaller FFT size for reduced latency on remote streams
    analyser.fftSize = 256;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const source = ctx.createMediaStreamSource(stream);
    source.connect(analyser);
    // Resume the context immediately; some browsers will otherwise
    // suspend the processing graph until a user gesture occurs. The
    // unlockAudio handler will also call resume() again later, but
    // calling it here ensures speaking indicators start as soon as
    // possible on platforms where it is allowed.
    ctx.resume().catch(() => {});
    function analyse() {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const level = sum / dataArray.length;
      // Increase the threshold slightly to reduce false positives from
      // ambient noise. A value around 50 works well with the smaller
      // window.
      setSpeaking(peerId, level > 50);
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
      console.log('getUserMedia success', stream);
      console.log('localStream tracks', stream.getAudioTracks());
      // Apply a dynamic noise gate based on RNNoise research. RNNoise
      // operates on short frames (around 10 ms) and aims to suppress
      // background noise without adding noticeable latency【28416536528651†L103-L107】. To approximate
      // this behaviour within the browser, we create a Web Audio
      // processing graph that analyses 10–20 ms frames and
      // dynamically adjusts a gain node. The calibration step
      // estimates the ambient noise floor and sets a threshold
      // relative to that baseline. This yields a smarter gate that
      // adapts to different environments.
      async function createNoiseGate(micStream) {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          // Keep track of all AudioContext instances for later unlocking on
          // mobile devices. Without pushing the context here it will remain
          // suspended until a user gesture occurs, which would mute
          // participants completely on some platforms.
          audioContexts.push(ctx);
          // Use a smaller FFT size (~256 samples) to reduce latency and
          // improve gate responsiveness. At a 48 kHz sample rate this
          // represents roughly 5 ms frames.
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          const source = ctx.createMediaStreamSource(micStream);
          const gainNode = ctx.createGain();
          source.connect(gainNode);
          gainNode.connect(analyser);
          const dest = ctx.createMediaStreamDestination();
          gainNode.connect(dest);
          const data = new Uint8Array(analyser.fftSize);
          let baseline = 0;
          let frameCount = 0;
          let calibrating = true;
          let enabled = true;
          function update() {
            analyser.getByteTimeDomainData(data);
            let sumSquares = 0;
            for (let i = 0; i < data.length; i++) {
              const v = (data[i] - 128) / 128;
              sumSquares += v * v;
            }
            const rms = Math.sqrt(sumSquares / data.length);
            if (calibrating) {
              baseline += rms;
              frameCount++;
              // Calibrate for roughly 100 ms (20 frames of 5 ms)
              if (frameCount > 20) {
                baseline = baseline / frameCount;
                calibrating = false;
              }
            }
            // Compute a dynamic threshold slightly above the noise floor.
            const threshold = baseline * 1.3;
            // When disabled always pass through. When enabled pass
            // through only when the current RMS exceeds the threshold.
            const targetGain = !enabled || rms > threshold ? 1 : 0;
            // Use a small time constant to avoid audible pumping.
            gainNode.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.01);
            requestAnimationFrame(update);
          }
          update();
          ctx.resume().catch(() => {});
          return {
            processed: dest.stream,
            enable(flag) {
              enabled = flag;
            },
            ctx
          };
        } catch (e) {
          console.warn('Noise gate setup failed', e);
          return {
            processed: micStream,
            enable() {},
            ctx: null
          };
        }
      }
      // Create the gate and set the processed stream as the localStream
      noiseGateController = await createNoiseGate(stream);
      localStream = noiseGateController.processed;
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
      // Apply a new noise gate to the replaced stream
      noiseGateController = await (async () => {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          // Track context for unlocking on mobile
          audioContexts.push(ctx);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          const source = ctx.createMediaStreamSource(newStream);
          const gainNode = ctx.createGain();
          source.connect(gainNode);
          gainNode.connect(analyser);
          const dest = ctx.createMediaStreamDestination();
          gainNode.connect(dest);
          const data = new Uint8Array(analyser.fftSize);
          let baseline = 0;
          let frameCount = 0;
          let calibrating = true;
          let enabled = noiseEnabled;
          function update() {
            analyser.getByteTimeDomainData(data);
            let sumSquares = 0;
            for (let i = 0; i < data.length; i++) {
              const v = (data[i] - 128) / 128;
              sumSquares += v * v;
            }
            const rms = Math.sqrt(sumSquares / data.length);
            if (calibrating) {
              baseline += rms;
              frameCount++;
              // Calibrate for approximately 100 ms
              if (frameCount > 20) {
                baseline = baseline / frameCount;
                calibrating = false;
              }
            }
            const threshold = baseline * 1.3;
            const targetGain = !enabled || rms > threshold ? 1 : 0;
            gainNode.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.01);
            requestAnimationFrame(update);
          }
          update();
          ctx.resume().catch(() => {});
          return {
            processed: dest.stream,
            enable(flag) {
              enabled = flag;
            },
            ctx
          };
        } catch (e) {
          console.warn('Noise gate setup failed', e);
          return {
            processed: newStream,
            enable() {},
            ctx: null
          };
        }
      })();
      const gated = noiseGateController.processed;
      // Replace the track on all senders
      const newTrack = gated.getAudioTracks()[0];
      replaceTrack(newTrack);
      // Stop old tracks and update the local reference
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
      localStream = gated;
      startLocalAnalysis(gated);
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
    // Play a short tone to indicate someone joined
    playBeep(880);
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
    // Play a lower tone to indicate someone left
    playBeep(440);
  });

  // If the server rejects our name because it is already in use, alert the
  // user and redirect back to the lobby. This should rarely happen because
  // the lobby prevents selecting occupied names, but it serves as a safety
  // net for race conditions.
  socket.on('join-error', ({ message }) => {
    alert(message || 'الاسم غير متاح');
    // Clean up local resources
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }
    socket.disconnect();
    sessionStorage.removeItem('username');
    window.location.href = '/';
  });

  // Update the UI when a remote peer mutes or unmutes themselves
  socket.on('mute', ({ peerId, muted }) => {
    updateMuteStatus(peerId, muted);
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
    // Update the button label
    muteBtn.textContent = isMuted ? 'إلغاء الكتم' : 'كتم';
    // Update our own list entry
    updateMuteStatus(myPeerId, isMuted);
    // Notify other peers of our mute state
    socket.emit('mute', { muted: isMuted });
  });

  // Toggle noise suppression on or off. When the gate is disabled, audio
  // passes through unprocessed. When enabled, the dynamic gate runs
  // continuously to attenuate background noise. Update the button
  // label to reflect the current state.
  noiseBtn.addEventListener('click', () => {
    noiseEnabled = !noiseEnabled;
    if (noiseGateController) {
      noiseGateController.enable(noiseEnabled);
    }
    noiseBtn.textContent = noiseEnabled ? 'إيقاف العزل' : 'تفعيل العزل';
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
})();