const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const logger = require('../utils/logger');

let s3Client = null;

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

  return getSignedUrl(s3Client, new GetObjectCommand({
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
