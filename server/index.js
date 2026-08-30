require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
// Express 5 forwards rejected promises from middleware/handlers to the error
// handler natively (v4→v5 migration guide, "Rejected promises"), so the
// express-async-errors monkey-patch is gone.

const config = require('./src/config');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const db = require('./src/infrastructure/db');
const storage = require('./src/infrastructure/storage');
const logger = require('./src/utils/logger');
const errorHandler = require('./src/middleware/error-handler');
const { getBuildInfo } = require('./src/utils/version');

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Nginx)

// ── Middleware ──────────────────────────────────────────────────────────────

app.use(
  helmet({
    contentSecurityPolicy: config.isProduction
      ? undefined
      : false, // Permissive CSP in development
  })
);

app.use(cors({ origin: config.clientUrl, credentials: true }));

app.use(compression());

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Express 5 leaves req.body undefined when no parser matched (v4→v5 migration
// guide, "req.body"), where v4 guaranteed {}. Routes and Joi validators here
// were written against the {} contract (destructures like `const { url } =
// req.body`), so a content-type-less POST would 500 on a TypeError instead of
// 400 on validation. Restore the v4 contract in one place.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

app.use(cookieParser(config.auth.cookieSecret));
app.use(require('./src/middleware/csrf')());

// Paths the Pi print agent polls. Kept next to the limiters below because the
// global limiter must SKIP them: middleware runs in registration order, so a
// more permissive limiter mounted later never raises this one's ceiling — the
// first limiter to match still 429s. Exempting here is what actually works.
// Match on segment boundaries, NOT a raw prefix: a bare startsWith would also
// match the user-facing '/api/print/_y_/agents' (printer registration, which
// issues a token) and '/api/print/_x_/agents'. Express's app.use() below is
// segment-aware, so those routes would be skipped here yet never covered by
// agentLimiter — leaving token issuance with no rate limit at all.
const AGENT_PATHS = ['/api/print/_y_/agent', '/api/print/_x_/agent'];
const isAgentPath = (req) => AGENT_PATHS.some(p => req.path === p || req.path.startsWith(`${p}/`));

app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isAgentPath,
  })
);

// Stricter rate limits for auth and public endpoints
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const shareLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth', authLimiter);
app.use('/api/sharing/_x_/view', shareLimiter);

// The Pi agent polls every 2s and, while draining a batch, fires claim+pdf+ack
// per label — a 50-label burst is ~150 requests, which the global 200/min
// limiter would throttle. It skips these paths (see above) so this higher
// budget is the one that actually binds.
const agentLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
AGENT_PATHS.forEach(p => app.use(p, agentLimiter));

storage.init();
storage.ensureBucket().catch(err => logger.warn('MinIO bucket check failed', { error: err.message }));

// ── Health Check ────────────────────────────────────────────────────────────

app.get('/health/live', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    await db.checkConnection();
    dbStatus = 'connected';
  } catch {
    // DB unavailable — report unhealthy so load balancer / orchestrator can detect
  }

  const healthy = dbStatus === 'connected';
  const build = getBuildInfo();
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    version: build.version,
    sha: build.sha,
    uptime: process.uptime(),
    db: dbStatus,
  });
});

// Readiness: process + external deps (DB and object storage). The PW deploy
// gate points here so a broken storage config fails the deploy instead of going
// green (file ops would otherwise 500 at runtime). /health/live stays
// process+DB only so a transient storage blip doesn't flap liveness.
app.get('/health/ready', async (req, res) => {
  let dbStatus = 'disconnected';
  let storageStatus = 'unreachable';
  await Promise.all([
    db.checkConnection().then(() => { dbStatus = 'connected'; }).catch(() => {}),
    storage.checkConnection().then(() => { storageStatus = 'reachable'; }).catch(() => {}),
  ]);
  const ready = dbStatus === 'connected' && storageStatus === 'reachable';
  const build = getBuildInfo();
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    version: build.version,
    sha: build.sha,
    uptime: process.uptime(),
    db: dbStatus,
    storage: storageStatus,
  });
});

// ── Module Routes ───────────────────────────────────────────────────────────
require('./src/modules/auth/auth.routes')({ app, db, logger, config });
require('./src/modules/inventory/properties.routes')({ app, db, logger, config });
require('./src/modules/inventory/areas.routes')({ app, db, logger, config });
require('./src/modules/inventory/containers.routes')({ app, db, logger, config });
require('./src/modules/inventory/items.routes')({ app, db, logger, config });
require('./src/modules/files/files.routes')({ app, db, logger, config });
require('./src/modules/files/condition.routes')({ app, db, logger, config });
require('./src/modules/products/products.routes')({ app, db, logger, config });
require('./src/modules/products/matches.routes')({ app, db, logger, config });
require('./src/modules/tags/tags.routes')({ app, db, logger, config });
require('./src/modules/labels/labels.routes')({ app, db, logger, config });
require('./src/modules/lending/lending.routes')({ app, db, logger, config });
require('./src/modules/dates/dates.routes')({ app, db, logger, config });
require('./src/modules/accessories/accessories.routes')({ app, db, logger, config });
require('./src/modules/audit/audit.routes')({ app, db, logger, config });
require('./src/modules/notifications/notifications.routes')({ app, db, logger, config });
require('./src/modules/reports/reports.routes')({ app, db, logger, config });
require('./src/modules/sharing/sharing.routes')({ app, db, logger, config });
require('./src/modules/recycle/recycle.routes')({ app, db, logger, config });
require('./src/modules/print/print.routes')({ app, db, logger, config });

// ── Error Handler (must be last) ────────────────────────────────────────────

app.use(errorHandler);

// ── Start Server ────────────────────────────────────────────────────────────

// Express 5 passes listen errors (e.g. EADDRINUSE) to the callback instead of
// throwing them (v4→v5 migration guide, "app.listen").
const server = app.listen(config.port, (err) => {
  if (err) {
    logger.error(`Failed to start server on port ${config.port}`, { error: err.message });
    process.exit(1);
  }
  logger.info(`Tally server started on port ${config.port} [${config.nodeEnv}]`);
});

// ── Graceful Shutdown ───────────────────────────────────────────────────────

const shutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  server.close(async () => {
    try { await db.pool.end(); } catch { /* ignore */ }
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
