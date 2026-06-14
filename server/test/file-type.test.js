const test = require('node:test');
const assert = require('node:assert');
const { sniffMime } = require('../src/utils/fileType');

test('sniffMime detects real image + pdf magic bytes', () => {
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  assert.equal(sniffMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])), 'image/gif');
  assert.equal(sniffMime(Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), 'image/webp');
  assert.equal(sniffMime(Buffer.from('%PDF-1.7 ....')), 'application/pdf');
});

test('sniffMime returns null for disguised / unrecognized / short content', () => {
  // An HTML/script payload uploaded as image/png must NOT sniff as an image.
  assert.equal(sniffMime(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8])), null); // too short
  assert.equal(sniffMime(null), null);
});
