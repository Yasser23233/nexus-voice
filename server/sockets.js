const { v4: uuidv4 } = require('uuid');
const { ICE_SERVERS, ICE_POLICY } = require('./config');

/*
 * Socket.IO signalling server for Nexus Voice.
 *
 * When a client connects it is assigned a unique peerId and receives
 * the ICE configuration. Clients must then send a `join` event with
 * their chosen user name. The server keeps track of all peers and
 * propagates signalling messages (offers, answers and ICE candidates)
 * between them. When a client disconnects the server notifies the
 * remaining peers so they can close their connections.
 */

function registerSockets(io) {
  // Map socket.id -> { peerId, name }
  const clients = new Map();
  // Map peerId -> socket.id
  const peerToSocket = new Map();
  // Set of sockets that have subscribed to presence updates from the lobby.
  // These sockets are not yet part of the voice chat but want to know which
  // names are currently in use. Whenever a peer joins or leaves, all
  // subscribers will receive a `presence` event with the list of active names.
  const presenceWatchers = new Set();

  io.on('connection', (socket) => {
    // Assign a unique peerId to this socket
    const peerId = uuidv4();

    // Immediately inform the client of its peerId and ICE configuration
    socket.emit('welcome', {
      peerId,
      iceServers: ICE_SERVERS,
      icePolicy: ICE_POLICY
    });

    /**
     * Presence subscription: sockets connecting on the lobby page can
     * subscribe to presence updates. We add them to the watcher set and
     * immediately send the current list of active names. They can later
     * unsubscribe or will be removed automatically on disconnect.
     */
    socket.on('subscribe-presence', () => {
      presenceWatchers.add(socket);
      const names = Array.from(clients.values()).map((c) => c.name);
      socket.emit('presence', names);
    });

    socket.on('unsubscribe-presence', () => {
      presenceWatchers.delete(socket);
    });

    // Handle the join event once the user has selected a name
    socket.on('join', ({ name }) => {
      // Prevent two users from using the same name concurrently. If the
      // chosen name is already in use emit an error and abort joining.
      const nameTaken = Array.from(clients.values()).some((c) => c.name === name);
      if (nameTaken) {
        socket.emit('join-error', { message: 'الاسم مستخدم بالفعل' });
        return;
      }
      // Save the peer data
      clients.set(socket.id, { peerId, name });
      peerToSocket.set(peerId, socket.id);

      console.log(`peer ${peerId} joined as ${name}`);

      // Send the list of all current peers to the new user
      const peerList = Array.from(clients.values()).map((c) => ({
        peerId: c.peerId,
        name: c.name
      }));
      socket.emit('peer-list', peerList);

      // Let everyone else know that a new peer has joined
      socket.broadcast.emit('peer-joined', { peerId, name });

      // Notify all presence subscribers of the updated list of names
      const activeNames = Array.from(clients.values()).map((c) => c.name);
      for (const watcher of presenceWatchers) {
        watcher.emit('presence', activeNames);
      }
    });

    // When a client toggles mute/unmute, broadcast the new state to all
    // other peers. The client sends its peerId and muted status. We rely on
    // closure variable peerId rather than trusting the payload.
    socket.on('mute', ({ muted }) => {
      // Broadcast to all connected clients except the sender
      socket.broadcast.emit('mute', { peerId, muted });
    });

    // Relay signalling data between peers
    socket.on('signal', ({ targetPeerId, data }) => {
      const targetSocketId = peerToSocket.get(targetPeerId);
      if (targetSocketId) {
        const type = data && data.type ? data.type : (data.candidate ? 'candidate' : 'unknown');
        console.log(`relay signal from ${peerId} to ${targetPeerId} (${type})`);
        io.to(targetSocketId).emit('signal', {
          from: peerId,
          data
        });
      }
    });

    // Clean up when a user disconnects
    socket.on('disconnect', () => {
      const clientInfo = clients.get(socket.id);
      if (clientInfo) {
        clients.delete(socket.id);
        peerToSocket.delete(clientInfo.peerId);
        console.log(`peer ${clientInfo.peerId} disconnected`);
        // Inform other peers that this peer has left
        socket.broadcast.emit('peer-left', { peerId: clientInfo.peerId });

        // Notify presence subscribers of the updated list
        const remainingNames = Array.from(clients.values()).map((c) => c.name);
        for (const watcher of presenceWatchers) {
          watcher.emit('presence', remainingNames);
        }
      }
      // Always remove from presenceWatchers when the socket disconnects
      presenceWatchers.delete(socket);
    });

    // Attempt to rejoin automatically on reconnection
    socket.on('reconnect', () => {
      const clientInfo = clients.get(socket.id);
      if (clientInfo) {
        socket.emit('join', { name: clientInfo.name });
      }
    });
  });
}

module.exports = registerSockets;