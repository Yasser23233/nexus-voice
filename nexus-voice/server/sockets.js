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

  io.on('connection', (socket) => {
    // Assign a unique peerId to this socket
    const peerId = uuidv4();

    // Immediately inform the client of its peerId and ICE configuration
    socket.emit('welcome', {
      peerId,
      iceServers: ICE_SERVERS,
      icePolicy: ICE_POLICY
    });

    // Handle the join event once the user has selected a name
    socket.on('join', ({ name }) => {
      // Save the peer data
      clients.set(socket.id, { peerId, name });
      peerToSocket.set(peerId, socket.id);

      // Send the list of all current peers to the new user
      const peerList = Array.from(clients.values()).map((c) => ({
        peerId: c.peerId,
        name: c.name
      }));
      socket.emit('peer-list', peerList);

      // Let everyone else know that a new peer has joined
      socket.broadcast.emit('peer-joined', { peerId, name });
    });

    // Relay signalling data between peers
    socket.on('signal', ({ targetPeerId, data }) => {
      const targetSocketId = peerToSocket.get(targetPeerId);
      if (targetSocketId) {
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
        // Inform other peers that this peer has left
        socket.broadcast.emit('peer-left', { peerId: clientInfo.peerId });
      }
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