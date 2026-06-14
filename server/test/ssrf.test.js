const test = require('node:test');
const assert = require('node:assert');
const { isPrivateOrReserved } = require('../src/modules/products/lookup/url-extractor');

test('blocks private/reserved IPv4 (incl. cloud metadata + CGNAT)', () => {
  for (const ip of ['0.0.0.0', '127.0.0.1', '10.0.5.40', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1']) {
    assert.equal(isPrivateOrReserved(ip), true, ip);
  }
});

test('blocks loopback/ULA/link-local and IPv4-mapped IPv6', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateOrReserved(ip), true, ip);
  }
});

test('allows public addresses', () => {
  assert.equal(isPrivateOrReserved('8.8.8.8'), false);
  assert.equal(isPrivateOrReserved('1.1.1.1'), false);
  assert.equal(isPrivateOrReserved('2606:4700:4700::1111'), false);
});
