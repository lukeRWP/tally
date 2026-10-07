const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { applyEdge } = require('../src/middleware/edge');

// Production topology (pw.json hardening.realIp): pw-proxy pins X-Forwarded-For to the client it
// saw (Cloudflare's edge is already rewritten to the real client by real_ip), then the container
// nginx — set_real_ip_from on pw-proxy's leg — pins it to $remote_addr again, which is that same
// client. Express therefore has exactly ONE proxy hop (the container nginx, the socket peer) and
// the header carries one entry: the client. Anything left of it is client-supplied.
const CLIENT_A = '203.0.113.7';
const CLIENT_B = '198.51.100.9';

async function start({ max = 3 } = {}) {
  const app = express();
  applyEdge(app);
  // Same options as index.js's limiters: the default key is req.ip.
  app.use(rateLimit({ windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false }));
  app.get('/probe', (req, res) => res.json({ ip: req.ip }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('req.ip is the client the container nginx forwarded, never an entry the client prepended', async () => {
  const { server, baseUrl } = await start();
  try {
    const plain = await fetch(`${baseUrl}/probe`, { headers: { 'X-Forwarded-For': CLIENT_A } });
    assert.strictEqual((await plain.json()).ip, CLIENT_A);
    const spoofed = await fetch(`${baseUrl}/probe`, { headers: { 'X-Forwarded-For': `6.6.6.6, ${CLIENT_A}` } });
    assert.strictEqual((await spoofed.json()).ip, CLIENT_A);
  } finally { server.close(); }
});

test('rate limit: each client has its own bucket and a spoofed leftmost entry cannot pick one', async () => {
  const { server, baseUrl } = await start();
  const hit = (xff) => fetch(`${baseUrl}/probe`, { headers: { 'X-Forwarded-For': xff } });
  try {
    for (let i = 0; i < 3; i += 1) assert.strictEqual((await hit(CLIENT_A)).status, 200);
    assert.strictEqual((await hit(CLIENT_A)).status, 429);
    assert.strictEqual((await hit(`6.6.6.1, ${CLIENT_A}`)).status, 429);
    assert.strictEqual((await hit(`6.6.6.2, ${CLIENT_A}`)).status, 429);
    assert.strictEqual((await hit(CLIENT_B)).status, 200);
  } finally { server.close(); }
});

// pw.json's CSP (sent by the container nginx) is the policy. A second one from helmet is enforced
// as an intersection and silently cancels its allowances (cloudflareinsights, 'wasm-unsafe-eval'),
// and a second Referrer-Policy contradicts pw-proxy's. helmet's remaining duplicated headers stay:
// pw-proxy sends byte-identical copies (proxy-passthrough.conf.j2), so they are a backstop for the
// app ever being reached without it — a copy that DIFFERED would be the conflict, so values are pinned.
test('CSP and Referrer-Policy are left to nginx/pw-proxy; helmet still sends the rest, identically', async () => {
  const { server, baseUrl } = await start();
  try {
    const res = await fetch(`${baseUrl}/probe`);
    assert.strictEqual(res.headers.get('content-security-policy'), null);
    assert.strictEqual(res.headers.get('referrer-policy'), null);
    assert.strictEqual(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.strictEqual(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-xss-protection'), '0');
  } finally { server.close(); }
});

test('index.js wires applyEdge before any route or limiter', () => {
  const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const apply = src.indexOf('applyEdge(app)');
  assert.ok(apply > 0, 'index.js must call applyEdge(app)');
  assert.ok(apply < src.indexOf('rateLimit({'), 'applyEdge must precede the limiters');
  assert.ok(!/app\.set\('trust proxy'/.test(src), 'trust proxy is set only in middleware/edge.js');
  assert.ok(!/helmet\(/.test(src), 'helmet is configured only in middleware/edge.js');
});
