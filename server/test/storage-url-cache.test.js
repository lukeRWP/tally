const test = require('node:test');
const assert = require('node:assert');

process.env.S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:9000';
process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'test';
process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'test';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'tally-files';

const storage = require('../src/infrastructure/storage');

// getPresignedUrl signs with the client init() builds; without it every call
// dereferences a null client.
storage.init();

/**
 * A presigned URL is the browser's cache key.
 *
 * SigV4 puts X-Amz-Date and X-Amz-Signature in the query string, so signing the
 * same object twice produces two different URLs — and the HTTP cache, keyed on
 * the full URL, could not hit even once. Every list render re-downloaded every
 * photo in full. These tests hold the line that the same object yields the same
 * URL, which is the entire mechanism.
 */

const KEY = 'items/1/photo/abc-photo.jpg';

test('the same object signs to the same URL across calls', async () => {
  const a = await storage.getPresignedUrl(KEY, { inline: true });
  const b = await storage.getPresignedUrl(KEY, { inline: true });
  assert.equal(a, b, 'the URL changed, so every render is a fresh download');
});

test('the signature is stable across a clock tick', async () => {
  // The original bug was time-based: X-Amz-Date is second-resolution, so two
  // calls in the same second happened to match and a naive check passed.
  const a = await storage.getPresignedUrl(KEY, { inline: true });
  await new Promise(r => setTimeout(r, 1100));
  const b = await storage.getPresignedUrl(KEY, { inline: true });
  assert.equal(new URL(a).searchParams.get('X-Amz-Signature'),
    new URL(b).searchParams.get('X-Amz-Signature'));
});

test('different objects do not share a URL', async () => {
  const a = await storage.getPresignedUrl('items/1/photo/one.jpg', { inline: true });
  const b = await storage.getPresignedUrl('items/1/photo/two.jpg', { inline: true });
  assert.notEqual(a, b);
  assert.match(decodeURIComponent(new URL(a).pathname), /one\.jpg/);
  assert.match(decodeURIComponent(new URL(b).pathname), /two\.jpg/);
});

test('an inline image and a download link are cached separately', async () => {
  // Same object, different Content-Disposition. Sharing one entry would serve
  // an attachment header to an <img>, or render a document inline — which is
  // the stored-XSS guard getPresignedUrl exists to enforce.
  const shown = await storage.getPresignedUrl(KEY, { inline: true });
  const saved = await storage.getPresignedUrl(KEY, { fileName: 'photo.jpg' });
  assert.notEqual(shown, saved);
  assert.match(decodeURIComponent(shown), /response-content-disposition=inline/i);
  assert.match(decodeURIComponent(saved), /attachment/i);
});

test('a different expiry is a different cache entry', async () => {
  const long = await storage.getPresignedUrl(KEY, { inline: true, expiresIn: 3600 });
  const short = await storage.getPresignedUrl(KEY, { inline: true, expiresIn: 300 });
  assert.notEqual(long, short);
  assert.equal(new URL(short).searchParams.get('X-Amz-Expires'), '300');
});

test('every URL carries a cache header, including for objects uploaded before this', async () => {
  // ResponseCacheControl is a GET-time override, so it applies to the whole
  // bucket without a backfill — that is why it is here and not only on upload.
  const url = await storage.getPresignedUrl('items/9/photo/old.jpg', { inline: true });
  const cc = new URL(url).searchParams.get('response-cache-control');
  assert.ok(cc, 'no cache header — the browser will not keep the image');
  assert.match(cc, /max-age=\d+/);
  assert.match(cc, /private/, 'these are signed, per-user URLs; they must not go in a shared cache');
});

test('the handed-out URL always has life left on it', async () => {
  // Reuse is capped below the expiry so a URL is never served moments before it
  // dies. Signed at T for 3600s and reused for 80% of that, the worst case
  // still leaves 12 minutes.
  const url = await storage.getPresignedUrl('items/2/photo/margin.jpg', { inline: true, expiresIn: 3600 });
  const expires = Number(new URL(url).searchParams.get('X-Amz-Expires'));
  const cc = new URL(url).searchParams.get('response-cache-control');
  const maxAge = Number(/max-age=(\d+)/.exec(cc)[1]);
  assert.ok(maxAge < expires, `browser told to cache ${maxAge}s past a ${expires}s URL`);
});
