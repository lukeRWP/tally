const test = require('node:test');
const assert = require('node:assert');
const { normaliseCandidates } = require('../src/modules/products/lookup/product-match');

test('drops a candidate with no name', () => {
  const out = normaliseCandidates([{ sourceUrl: 'https://example.com/a' }], 3);
  assert.equal(out.length, 0);
});

test('drops a candidate with no sourceUrl', () => {
  const out = normaliseCandidates([{ name: 'Drill' }], 3);
  assert.equal(out.length, 0);
});

test('rejects a non-https sourceUrl', () => {
  const out = normaliseCandidates(
    [{ name: 'Drill', sourceUrl: 'http://example.com/a' }], 3);
  assert.equal(out.length, 0);
});

test('keeps a valid UPC and nulls a malformed one', () => {
  const [good] = normaliseCandidates(
    [{ name: 'A', sourceUrl: 'https://e.com/a', upc: '885911474764' }], 3);
  assert.equal(good.upc, '885911474764');

  const [bad] = normaliseCandidates(
    [{ name: 'A', sourceUrl: 'https://e.com/a', upc: '12345' }], 3);
  assert.equal(bad.upc, null, 'a 5-digit UPC is not a UPC');
});

test('accepts every valid GTIN length', () => {
  for (const upc of ['12345678', '123456789012', '1234567890123', '12345678901234']) {
    const [c] = normaliseCandidates(
      [{ name: 'A', sourceUrl: 'https://e.com/a', upc }], 3);
    assert.equal(c.upc, upc, `${upc.length}-digit GTIN is valid`);
  }
});

test('a 16-digit UPC is dropped, not truncated into a fake 14-digit GTIN', () => {
  const [c] = normaliseCandidates(
    [{ name: 'A', sourceUrl: 'https://e.com/a', upc: '1234567890123456' }], 3);
  assert.equal(c.upc, null, 'validation must run on the untruncated value');
});

test('derives sourceDomain from the URL, ignoring what the model claimed', () => {
  const [c] = normaliseCandidates([{
    name: 'A', sourceUrl: 'https://www.walmart.com/ip/123', sourceDomain: 'amazon.com',
  }], 3);
  assert.equal(c.sourceDomain, 'walmart.com', 'domain comes from the URL, not the model');
});

test('caps the list at max', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    name: `P${i}`, sourceUrl: `https://e.com/${i}`,
  }));
  assert.equal(normaliseCandidates(many, 3).length, 3);
});

test('a max of 0 returns zero candidates', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    name: `P${i}`, sourceUrl: `https://e.com/${i}`,
  }));
  assert.equal(normaliseCandidates(many, 0).length, 0);
});

test('a non-array is an empty list, not a throw', () => {
  assert.deepEqual(normaliseCandidates(null, 3), []);
  assert.deepEqual(normaliseCandidates({ candidates: [] }, 3), []);
});

test('drops a negative or non-numeric price', () => {
  const [c] = normaliseCandidates(
    [{ name: 'A', sourceUrl: 'https://e.com/a', priceUsd: -5 }], 3);
  assert.equal(c.priceUsd, null);
});
