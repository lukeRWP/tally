const test = require('node:test');
const assert = require('node:assert');
const { storableImageUrl, publicImageUrl, PUBLIC_IMAGE_HOSTS } = require('../src/modules/products/image-url');
const { createProduct } = require('../src/modules/products/products.schema');

// #355: a product's IMAGE_URL is chosen by whichever household member (or
// lookup) first wrote the row, and the public share page renders it into an
// anonymous viewer's browser. Two gates: what may be stored, what may be
// shown to a third party.

test('storableImageUrl keeps https and drops every other scheme', () => {
  assert.equal(storableImageUrl('https://images.openfoodfacts.org/a.jpg'), 'https://images.openfoodfacts.org/a.jpg');
  assert.equal(storableImageUrl('http://images.openfoodfacts.org/a.jpg'), null, 'http');
  assert.equal(storableImageUrl('javascript:alert(1)'), null, 'javascript:');
  assert.equal(storableImageUrl('data:image/png;base64,AAAA'), null, 'data:');
  assert.equal(storableImageUrl('//cdn.example/a.jpg'), null, 'scheme-relative is not a URL');
  assert.equal(storableImageUrl('not a url'), null);
  assert.equal(storableImageUrl(''), null);
  assert.equal(storableImageUrl(null), null);
  assert.equal(storableImageUrl(42), null);
});

test('storableImageUrl refuses credentials and oversize values', () => {
  assert.equal(storableImageUrl('https://user:pw@cdn.example/a.jpg'), null);
  assert.equal(storableImageUrl(`https://cdn.example/${'a'.repeat(2000)}`), null);
});

test('publicImageUrl passes provider hosts, including subdomains, and nothing else', () => {
  assert.equal(publicImageUrl('https://images.openfoodfacts.org/a.jpg'), 'https://images.openfoodfacts.org/a.jpg');
  assert.equal(publicImageUrl('https://i5.walmartimages.com/a.jpg'), 'https://i5.walmartimages.com/a.jpg');
  assert.equal(publicImageUrl('https://target.scene7.com/is/image/x'), 'https://target.scene7.com/is/image/x');
  assert.equal(publicImageUrl('https://IMAGES.OPENFOODFACTS.ORG/a.jpg'), 'https://images.openfoodfacts.org/a.jpg', 'host case-folded');
  assert.equal(publicImageUrl('https://tracker.example/pixel.gif'), null, 'unknown host');
  assert.equal(publicImageUrl('https://walmartimages.com.evil.example/a.jpg'), null, 'suffix must be a label boundary');
  assert.equal(publicImageUrl('https://notwalmartimages.com/a.jpg'), null, 'bare suffix is not a match');
  assert.equal(publicImageUrl('http://images.openfoodfacts.org/a.jpg'), null, 'http fails even on an allowed host');
});

test('the allowlist is bare registrable domains, so suffix matching is meaningful', () => {
  for (const h of PUBLIC_IMAGE_HOSTS) {
    assert.doesNotMatch(h, /^https?:|\//, `${h} must be a hostname, not a URL`);
    assert.ok(!h.startsWith('.') && !h.startsWith('*'), `${h} is matched by label boundary already`);
  }
});

test('createProduct schema rejects a non-https imageUrl but still allows empty', () => {
  const base = { barcode: '012345678905', name: 'Thing' };
  assert.equal(createProduct.validate({ ...base, imageUrl: 'https://cdn.example/a.jpg' }).error, undefined);
  assert.equal(createProduct.validate({ ...base, imageUrl: '' }).error, undefined);
  assert.equal(createProduct.validate({ ...base, imageUrl: null }).error, undefined);
  assert.ok(createProduct.validate({ ...base, imageUrl: 'http://cdn.example/a.jpg' }).error, 'http');
  assert.ok(createProduct.validate({ ...base, imageUrl: 'javascript:alert(1)' }).error, 'javascript:');
  assert.ok(createProduct.validate({ ...base, imageUrl: 'data:image/png;base64,AAAA' }).error, 'data:');
});
