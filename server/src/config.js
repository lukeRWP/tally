require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

// Required vars that must always be present
const alwaysRequired = [
  'MYSQL_URL',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'TALLY_DB',
  'COOKIE_SECRET',
  'CLIENT_URL',
];

// Entra vars — required in production, warned in development (BYPASS_AUTH may be used)
const entraVars = [
  'ENTRA_CLIENT_ID',
  'ENTRA_TENANT_ID',
];

const missing = {
  required: alwaysRequired.filter(key => !process.env[key]),
  entra: entraVars.filter(key => !process.env[key]),
};

if (missing.required.length > 0) {
  const msg = `Missing required environment variables: ${missing.required.join(', ')}`;
  if (isProduction) {
    throw new Error(msg);
  } else {
    console.warn(`[config] WARNING: ${msg}`);
  }
}

if (missing.entra.length > 0 && process.env.BYPASS_AUTH !== 'true') {
  const msg = `Missing Entra environment variables: ${missing.entra.join(', ')}. Auth will not work unless BYPASS_AUTH=true.`;
  if (isProduction) {
    throw new Error(msg);
  } else {
    console.warn(`[config] WARNING: ${msg}`);
  }
} else if (missing.entra.length > 0) {
  console.warn(`[config] WARNING: Entra vars missing but BYPASS_AUTH=true — skipping auth check`);
}

const config = Object.freeze({
  port: parseInt(process.env.PORT || '2727', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  isDevelopment: !isProduction,

  db: {
    url: process.env.MYSQL_URL,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.TALLY_DB,
    useSsl: process.env.MYSQL_USE_SSL === 'true',
  },

  auth: {
    entraClientId: process.env.ENTRA_CLIENT_ID,
    entraClientSecret: process.env.ENTRA_CLIENT_SECRET,
    entraTenantId: process.env.ENTRA_TENANT_ID,
    bypassAuth: (() => {
      if (process.env.BYPASS_AUTH !== 'true') return false;
      if (isProduction) {
        console.error('[SECURITY] BYPASS_AUTH=true is BLOCKED in production. Auth will NOT be bypassed.');
        return false;
      }
      console.warn('[config] BYPASS_AUTH=true — all requests use dev user identity');
      return true;
    })(),
    cookieSecret: process.env.COOKIE_SECRET,
  },

  clientUrl: process.env.CLIENT_URL,

  storage: {
    endpoint: process.env.S3_ENDPOINT,
    // The endpoint a BROWSER can reach. Presigned URLs are signed against a
    // host, so signing them with the internal service name produces links the
    // client cannot load — which is why uploaded photos never rendered. Falls
    // back to the internal endpoint for setups where they are the same host.
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET,
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
    region: process.env.S3_REGION || 'us-east-1',
  },

  logging: {
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    toFile: process.env.LOG_TO_FILE === 'true',
  },
});

module.exports = config;
