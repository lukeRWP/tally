const logger = require('../utils/logger');
const { error } = require('../utils/response');

// Matched against lower-cased keys in body/params/query and as query-string
// names in the URL. Covers the credentials this API actually carries: the
// print agent's key (`Authorization` header, also `apiKey` when registered),
// share tokens (`?token=`), Entra secrets and OAuth tokens (#354).
const SENSITIVE_FIELDS = new Set([
  'password', 'token', 'secret', 'cookie',
  'authorization', 'apikey', 'api_key', 'x-api-key',
  'client_secret', 'clientsecret', 'access_token', 'accesstoken',
  'refresh_token', 'refreshtoken', 'id_token', 'idtoken',
]);

// Lock errors are retryable by design: MySQL rolled the statement (deadlock)
// or gave up waiting (lock wait timeout) and nothing was applied. The pool
// already retries single-statement deadlocks once (db.js #97); what reaches
// here is the transactional case — closure-table moves, recycle-bin lock
// ordering — where `withTransaction` correctly refuses to retry and the
// caller must re-run. 409 + Retry-After tells the client exactly that
// instead of a 500 (#354).
const RETRYABLE_LOCK_MESSAGE = 'The request conflicted with another change — please retry.';
const MYSQL_CODES = {
  ER_DUP_ENTRY: { status: 409, message: 'A record with this value already exists.' },
  ER_NO_REFERENCED_ROW: { status: 400, message: 'Referenced resource does not exist.' },
  ER_NO_REFERENCED_ROW_2: { status: 400, message: 'Referenced resource does not exist.' },
  ER_LOCK_DEADLOCK: { status: 409, message: RETRYABLE_LOCK_MESSAGE, retryAfter: 1 },
  ER_LOCK_WAIT_TIMEOUT: { status: 409, message: RETRYABLE_LOCK_MESSAGE, retryAfter: 2 },
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
    const { status, message, retryAfter } = MYSQL_CODES[err.code];
    if (retryAfter) res.set('Retry-After', String(retryAfter));
    logger.warn(retryAfter ? 'MySQL lock error' : 'MySQL constraint error', { ...logContext, mysqlCode: err.code });
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
  const message = isProduction ? 'Internal Server Error' : (err.message || 'Internal Server Error');

  return error(res, message, 500);
}

module.exports = errorHandler;
