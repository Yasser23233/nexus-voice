const dotenv = require('dotenv');

// Load variables from a .env file into process.env, if present
dotenv.config();

/*
 * Configuration module for the Nexus Voice application.
 *
 * The WebRTC stack requires a list of ICE servers (STUN and TURN) and a
 * transport policy. This file reads those values from environment
 * variables and provides sensible defaults where possible. See
 * `.env.example` for all supported keys.
 */

// Pull variables out of the environment with defaults
const {
  PORT = 3000,
  STUN_URL = 'stun:stun.l.google.com:19302',
  TURN_URL,
  TURN_USER,
  TURN_PASS,
  RELAY_ONLY = 'false'
} = process.env;

// Build a list of ICE servers to hand down to the browser
const ICE_SERVERS = [];
if (STUN_URL) {
  ICE_SERVERS.push({ urls: STUN_URL });
}
if (TURN_URL && TURN_USER && TURN_PASS) {
  ICE_SERVERS.push({
    urls: TURN_URL,
    username: TURN_USER,
    credential: TURN_PASS
  });
}

// Determine the iceTransportPolicy: 'relay' when RELAY_ONLY is truthy
const ICE_POLICY = String(RELAY_ONLY).toLowerCase() === 'true' ? 'relay' : 'all';

module.exports = {
  PORT: Number(PORT),
  STUN_URL,
  TURN_URL,
  TURN_USER,
  TURN_PASS,
  RELAY_ONLY,
  ICE_SERVERS,
  ICE_POLICY
};