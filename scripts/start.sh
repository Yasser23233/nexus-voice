#!/usr/bin/env bash
#
# Start script for Nexus Voice
#
# This helper loads environment variables from a local .env file if
# present, runs a simple environment check and then launches the
# application server. It is intended to be invoked via `npm start`.

set -euo pipefail

# Export variables from .env if it exists
if [ -f .env ]; then
  # Export variables from the .env file into the environment. The set -o
  # allexport directive automatically exports all sourced variables.
  set -o allexport
  . ./.env
  set +o allexport
fi

# Check Node version and required environment variables
node scripts/checkEnv.js

# Start the server
node server/index.js