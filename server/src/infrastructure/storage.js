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

async function getPresignedUrl(key, expiresIn = 3600) {
  return getSignedUrl(s3Client, new GetObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
  }), { expiresIn });
}

async function remove(key) {
  await s3Client.send(new DeleteObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
  }));
}

module.exports = { init, ensureBucket, upload, getPresignedUrl, remove };
