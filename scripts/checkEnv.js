/*
 * Environment validation script.
 *
 * This script is executed before starting the server to warn about
 * missing environment variables and unsupported Node.js versions.
 * It does not terminate the process on error but prints messages to
 * guide the user.
 */

const { engines } = require('../package.json');

// Verify that the current Node version satisfies the engines range
function checkNodeVersion() {
  const required = engines && engines.node;
  if (!required) return;
  const currentMajor = parseInt(process.versions.node.split('.')[0], 10);
  const minMajor = parseInt(required.replace(/^>=/, ''), 10);
  if (Number.isInteger(minMajor) && currentMajor < minMajor) {
    console.warn(`Warning: Node.js ${required} is required. Current version is ${process.versions.node}.`);
  }
}

// Warn about any missing required environment variables
function checkEnvVars() {
  const required = ['PORT', 'STUN_URL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}. ` +
                 `Create a .env file or export these values.`);
  }
}

function main() {
  checkNodeVersion();
  checkEnvVars();
  console.log('Environment check complete');
}

main();