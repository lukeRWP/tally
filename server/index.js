require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
require('express-async-errors');

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

const app = express();

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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(cookieParser(config.auth.cookieSecret));

app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

storage.init();
storage.ensureBucket().catch(err => logger.warn('MinIO bucket check failed', { error: err.message }));

// ── Health Check ────────────────────────────────────────────────────────────

app.get('/health/live', async (req, res) => {
  let dbStatus = 'disconnected';
  try {
    await db.checkConnection();
    dbStatus = 'connected';
  } catch {
    // DB unavailable — still respond 200 so the process is considered alive
  }

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    db: dbStatus,
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
require('./src/modules/tags/tags.routes')({ app, db, logger, config });
require('./src/modules/labels/labels.routes')({ app, db, logger, config });
require('./src/modules/lending/lending.routes')({ app, db, logger, config });
require('./src/modules/dates/dates.routes')({ app, db, logger, config });
require('./src/modules/accessories/accessories.routes')({ app, db, logger, config });
require('./src/modules/audit/audit.routes')({ app, db, logger, config });
require('./src/modules/notifications/notifications.routes')({ app, db, logger, config });
require('./src/modules/reports/reports.routes')({ app, db, logger, config });

// ── Error Handler (must be last) ────────────────────────────────────────────

app.use(errorHandler);

// ── Start Server ────────────────────────────────────────────────────────────

const server = app.listen(config.port, () => {
  logger.info(`Tally server started on port ${config.port} [${config.nodeEnv}]`);
});

// ── Graceful Shutdown ───────────────────────────────────────────────────────

const shutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
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
