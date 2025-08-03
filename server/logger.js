const morgan = require('morgan');

/*
 * Centralised request logger.
 *
 * This helper exports a configured Morgan middleware that can be
 * attached to an Express application to log incoming HTTP requests.
 * Logging in one place makes it easy to change format and
 * configuration across the codebase.
 */

function createLogger(format = 'dev') {
  return morgan(format);
}

module.exports = createLogger;