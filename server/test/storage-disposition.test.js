// Storage env must be set before requiring config/storage (config reads env at
// load). getSignedUrl signs OFFLINE, so no MinIO/network is needed.
process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:9000';
process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'test-key';
process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'test-secret';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'test-bucket';

const test = require('node:test');
const assert = require('node:assert');
const storage = require('../src/infrastructure/storage');
storage.init();

// The Content-Disposition on the presigned URL is a stored-XSS guard: only
// verified images are served `inline`; everything else is forced to
// `attachment` so a stored file can never render/execute from the storage
// origin. These lock that behavior.

test('non-image files are presigned as attachment (download), not inline', async () => {
  const url = await storage.getPresignedUrl('items/1/receipt/x.pdf', { contentType: 'application/pdf', fileName: 'x.pdf' });
  const decoded = decodeURIComponent(url);
  assert.match(decoded, /response-content-disposition=attachment/i, 'served as attachment');
  assert.doesNotMatch(decoded, /response-content-disposition=inline/i);
});

test('images are presigned inline for display', async () => {
  const url = await storage.getPresignedUrl('items/1/photo/p.png', { contentType: 'image/png', fileName: 'p.png' });
  assert.match(decodeURIComponent(url), /response-content-disposition=inline/i);
});

test('explicit inline:true forces inline', async () => {
  const url = await storage.getPresignedUrl('k', { inline: true });
  assert.match(decodeURIComponent(url), /response-content-disposition=inline/i);
});

test('a malicious download filename is sanitized in the disposition', async () => {
  const url = await storage.getPresignedUrl('k', { contentType: 'application/pdf', fileName: 'a"b<script>.pdf' });
  assert.match(decodeURIComponent(url), /filename="a_b_script_\.pdf"/i, 'unsafe chars replaced with _');
});
