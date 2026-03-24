const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');
const logToFile = process.env.LOG_TO_FILE === 'true';

const structuredFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? ' ' + JSON.stringify(meta)
      : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

const transports = [];

// Console transport: always on in development, errors-only in production (unless overridden)
if (!isProduction) {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      level: logLevel,
    })
  );
} else {
  // In production also log errors to console so container logs capture them
  transports.push(
    new winston.transports.Console({
      format: structuredFormat,
      level: 'error',
    })
  );
}

// File transports when LOG_TO_FILE=true
if (logToFile) {
  transports.push(
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      format: structuredFormat,
      maxFiles: '14d',
      zippedArchive: true,
    }),
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: logLevel,
      format: structuredFormat,
      maxFiles: '14d',
      zippedArchive: true,
    })
  );
}

const logger = winston.createLogger({
  level: logLevel,
  levels: winston.config.npm.levels, // error, warn, info, http, verbose, debug, silly
  transports,
  exitOnError: false,
});

module.exports = logger;
