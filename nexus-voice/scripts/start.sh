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
  # shellcheck disable=SC1091
  export $(grep -v '^#' .env | xargs -0)
fi

# Check Node version and required environment variables
node scripts/checkEnv.js

# Start the server
node server/index.js