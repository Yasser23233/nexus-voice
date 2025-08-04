const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const morgan = require('morgan');
const { Server } = require('socket.io');

const {
  PORT,
  ICE_SERVERS,
  ICE_POLICY
} = require('./config');
const registerSockets = require('./sockets');

/*
 * Entry point for the Nexus Voice server.
 *
 * This file sets up an Express HTTP server with sensible security
 * defaults via Helmet, request logging via Morgan and static file
 * serving from the client build directory. It also exposes an
 * endpoint to allow clients to retrieve the configured ICE servers
 * and transport policy. A Socket.IO server sits on top of the HTTP
 * server to handle all WebRTC signalling events.
 */

const app = express();

// Serve static assets from the client/public directory
app.use(express.static(path.join(__dirname, '..', 'client', 'public')));

// Also serve files from the assets directory (e.g. logo.svg)
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// Apply basic security headers
app.use(helmet());

// Log HTTP requests to the console
app.use(morgan('dev'));

// Expose ICE configuration to the frontend
app.get('/ice-config', (req, res) => {
  res.json({ iceServers: ICE_SERVERS, icePolicy: ICE_POLICY });
});

// Catch-all: serve the lobby page for any unknown route. This makes direct
// links to /room.html work when served through a static HTTP server.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'public', 'index.html'));
});

// Create HTTP server and bind Socket.IO to it
const server = http.createServer(app);
const io = new Server(server);

// Register WebSocket handlers for signalling
registerSockets(io);

// Start listening on the configured port
server.listen(PORT, () => {
  /* eslint-disable no-console */
  console.log(`Nexus Voice listening on http://localhost:${PORT}`);
});