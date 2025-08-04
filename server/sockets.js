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

// Maintain a list of connected clients at the module level so that
// other parts of the server (e.g. HTTP routes) can introspect who
// is online. Each entry maps socket.id -> { peerId, name }.
const clients = new Map();
// Map peerId -> socket.id for quick signalling lookup
const peerToSocket = new Map();

function registerSockets(io) {

  io.on('connection', (socket) => {
    // Assign a unique peerId to this socket
    const peerId = uuidv4();

    // Immediately inform the client of its peerId and ICE configuration
    socket.emit('welcome', {
      peerId,
      iceServers: ICE_SERVERS,
      icePolicy: ICE_POLICY
    });

    // Send the current presence list to any newly connected socket. This
    // allows the lobby to display which names are already in use.
    {
      const presenceList = Array.from(clients.values()).map((c) => ({ peerId: c.peerId, name: c.name }));
      socket.emit('presence', presenceList);
    }

    // Handle the join event once the user has selected a name
    socket.on('join', ({ name }) => {
      // If the chosen name is already taken by an existing client, refuse to join
      for (const { name: existingName } of clients.values()) {
        if (existingName === name) {
          socket.emit('join-error', { message: 'الاسم مستخدم بالفعل. اختر اسماً آخر.' });
          return;
        }
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

      // Broadcast updated presence list to all clients (including lobby)
      {
        const presenceList = Array.from(clients.values()).map((c) => ({ peerId: c.peerId, name: c.name }));
        io.emit('presence', presenceList);
      }
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

    // Receive mute state from clients and broadcast it to everyone
    socket.on('mute', ({ muted }) => {
      const clientInfo = clients.get(socket.id);
      if (clientInfo) {
        io.emit('mute', { peerId: clientInfo.peerId, muted });
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

        // Broadcast updated presence list
        {
          const presenceList = Array.from(clients.values()).map((c) => ({ peerId: c.peerId, name: c.name }));
          io.emit('presence', presenceList);
        }
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

// Return an array of the names of connected peers. This is used by
// HTTP routes to inform the lobby which names are currently taken.
function getOnlineNames() {
  return Array.from(clients.values()).map((c) => c.name);
}

module.exports = {
  registerSockets,
  getOnlineNames
};