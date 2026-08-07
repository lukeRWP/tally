const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const logger = require('../utils/logger');

let s3Client = null;
// A second client that differs ONLY in endpoint, used for signing links the
// browser will follow. Signing is local, so this costs nothing at runtime.
let presignClient = null;

function init() {
  s3Client = new S3Client({
    endpoint: config.storage.endpoint,
    region: config.storage.region,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
    forcePathStyle: true, // Required for MinIO
  });

  const publicEndpoint = normalisePublicEndpoint(config.storage.publicEndpoint);

  presignClient = publicEndpoint === config.storage.endpoint
    ? s3Client
    : new S3Client({
        endpoint: publicEndpoint,
        region: config.storage.region,
        credentials: {
          accessKeyId: config.storage.accessKeyId,
          secretAccessKey: config.storage.secretAccessKey,
        },
        forcePathStyle: true,
      });
}

/**
 * SigV4 signs the request PATH, and with forcePathStyle the SDK builds that
 * path as /{bucket}/{key}. So any path already on the endpoint is a
 * signature-breaking trap:
 *
 *   endpoint https://host/tally-files  ->  signs /tally-files/tally-files/key
 *
 * which S3 answers with NoSuchKey, or — if something in front rewrites the
 * path on the way through — SignatureDoesNotMatch, an error that says nothing
 * about the actual cause.
 *
 * A trailing copy of the bucket is unambiguous, so strip it. Any OTHER path is
 * left alone (a proxy may genuinely serve S3 at a sub-path) but warned about
 * loudly, because it only works if that proxy passes the path through byte for
 * byte, and silence here costs hours.
 */
function normalisePublicEndpoint(endpoint) {
  if (!endpoint) return endpoint;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    logger.warn(`S3 public endpoint is not a valid URL: ${endpoint}`);
    return endpoint;
  }

  const path = url.pathname.replace(/\/+$/, '');
  if (path === `/${config.storage.bucket}`) {
    url.pathname = '/';
    const fixed = url.toString().replace(/\/$/, '');
    logger.warn(
      `S3 public endpoint included the bucket ("${path}") — using ${fixed} instead. ` +
      'The SDK appends the bucket itself, so leaving it on the endpoint signs it twice.',
    );
    return fixed;
  }

  if (path && path !== '') {
    logger.warn(
      `S3 public endpoint has a path ("${path}"). SigV4 signs the path, so presigned ` +
      'links only work if whatever serves this origin forwards the path unchanged.',
    );
  }
  return endpoint.replace(/\/+$/, '');
}

async function ensureBucket() {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: config.storage.bucket }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: config.storage.bucket }));
    logger.info(`Created bucket: ${config.storage.bucket}`);
  }
}

async function upload(key, body, contentType) {
  await s3Client.send(new PutObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
}

/**
 * Presigned GET URL.
 *
 * @param {string} key
 * @param {object|number} [opts] - options object, or a number for legacy expiresIn
 * @param {number} [opts.expiresIn=3600]
 * @param {string} [opts.contentType] - server-derived content type to assert on the response
 * @param {string} [opts.fileName]    - download filename for non-inline responses
 * @param {boolean} [opts.inline]     - force inline (e.g. verified images)
 *
 * Non-image content is served as `attachment` (forced download) so a file can
 * never be rendered/executed inline from the storage origin (stored-XSS guard).
 */
async function getPresignedUrl(key, opts = {}) {
  if (typeof opts === 'number') opts = { expiresIn: opts };
  const { expiresIn = 3600, contentType, fileName, inline } = opts;

  const isInline = inline === true || (typeof contentType === 'string' && contentType.startsWith('image/'));
  const safeFileName = String(fileName || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');

  return getSignedUrl(presignClient || s3Client, new GetObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
    ...(contentType ? { ResponseContentType: contentType } : {}),
    ResponseContentDisposition: isInline ? 'inline' : `attachment; filename="${safeFileName}"`,
  }), { expiresIn });
}

async function remove(key) {
  await s3Client.send(new DeleteObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
  }));
}

// Readiness probe: verify the bucket is reachable. Short timeout so a hung or
// unreachable storage endpoint fails fast instead of blocking the health check.
async function checkConnection(timeoutMs = 3000) {
  await Promise.race([
    s3Client.send(new HeadBucketCommand({ Bucket: config.storage.bucket })),
    new Promise((_, reject) => setTimeout(() => reject(new Error('storage check timed out')), timeoutMs)),
  ]);
}

module.exports = { init, ensureBucket, upload, getPresignedUrl, remove, checkConnection };
