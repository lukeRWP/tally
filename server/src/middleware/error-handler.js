const logger = require('../utils/logger');
const { error } = require('../utils/response');

const SENSITIVE_FIELDS = new Set(['password', 'token', 'secret', 'cookie']);

const MYSQL_CODES = {
  ER_DUP_ENTRY: { status: 409, message: 'A record with this value already exists.' },
  ER_NO_REFERENCED_ROW: { status: 400, message: 'Referenced resource does not exist.' },
  ER_NO_REFERENCED_ROW_2: { status: 400, message: 'Referenced resource does not exist.' },
};

function redactSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const redacted = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
    } else if (val && typeof val === 'object') {
      redacted[key] = redactSensitive(val);
    } else {
      redacted[key] = val;
    }
  }
  return redacted;
}

// Routes whose path carries a credential. Express restores `req.params` as
// each layer exits, so by the time an app-level error handler runs they are
// `{}` — the `params` field below was never what leaked. The token lived on
// in `req.url`, and a failed public share request wrote the whole bearer for
// that page to winston (#349). Nothing generic can find it there, so the one
// such route is named and masked by shape.
const SENSITIVE_PATH_PREFIXES = ['/api/sharing/_x_/view/'];
const SENSITIVE_QUERY = new RegExp(`([?&](?:${[...SENSITIVE_FIELDS].join('|')})=)[^&#]*`, 'gi');

function redactUrl(url) {
  let out = String(url || '');
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (out.startsWith(prefix)) {
      out = prefix + '[REDACTED]' + out.slice(prefix.length).replace(/^[^/?#]*/, '');
    }
  }
  return out.replace(SENSITIVE_QUERY, '$1[REDACTED]');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production';

  // Build a safe log context
  const logContext = {
    method: req.method,
    url: redactUrl(req.url),
    statusCode: err.statusCode || err.status || 500,
    errorCode: err.code,
    stack: err.stack,
    body: redactSensitive(req.body),
    params: redactSensitive(req.params),
    query: redactSensitive(req.query),
  };

  // ── Joi ValidationError ──────────────────────────────────────────────────
  if (err.isJoi || err.name === 'ValidationError') {
    const errors = (err.details || []).map(d => ({
      field: d.path.join('.'),
      message: d.message.replace(/['"]/g, ''),
    }));
    logger.warn('Validation error', { ...logContext, errors });
    return error(res, 'Validation failed', 400, errors);
  }

  // ── MySQL errors ─────────────────────────────────────────────────────────
  if (err.code && MYSQL_CODES[err.code]) {
    const { status, message } = MYSQL_CODES[err.code];
    logger.warn('MySQL constraint error', { ...logContext, mysqlCode: err.code });
    return error(res, message, status);
  }

  // ── Explicit application errors (err.statusCode / err.status set by a service) ─
  const explicitStatus = err.statusCode || err.status;
  if (explicitStatus && explicitStatus >= 400 && explicitStatus < 500) {
    logger.warn('Application error', { ...logContext });
    return error(res, err.message || 'Request failed', explicitStatus);
  }

  // ── Default / unexpected errors ──────────────────────────────────────────
  logger.error('Unhandled error', logContext);

  // Hide internal error details in production to prevent information leakage
  const isProd = process.env.NODE_ENV === 'production';
  const message = isProd ? 'Internal Server Error' : (err.message || 'Internal Server Error');

  return error(res, message, 500);
}

module.exports = errorHandler;
