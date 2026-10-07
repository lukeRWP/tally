const helmet = require('helmet');

// How many proxies Express believes for `req.ip`.
//
// Production path: Cloudflare/clients -> pw-proxy (nginx) -> the app's container nginx -> Node.
// With PW `hardening.realIp` (pw.json) each nginx PINS X-Forwarded-For to the client address it
// resolved ($remote_addr, after real_ip) instead of appending, so Node sees ONE proxy hop (the
// container nginx, the socket peer) and a header holding just the client. Trusting exactly that
// hop makes `req.ip` the real client; every entry to its left is client-supplied and ignored.
// Raising this to 2 would let a prepended entry win. If realIp is ever dropped the header
// becomes "client, pw-proxy" and this must become 2 — test/edge.test.js pins the arithmetic.
const TRUST_PROXY_HOPS = 1;

function applyEdge(app) {
  app.set('trust proxy', TRUST_PROXY_HOPS);

  // The container nginx sends the CSP from pw.json (on every location, /api included) and
  // pw-proxy sends Referrer-Policy. A second CSP from helmet is enforced as an intersection and
  // silently cancels pw.json's allowances; a second Referrer-Policy contradicts the first. So
  // helmet sends neither, in dev and prod alike. Its other defaults stay (HSTS, X-Frame-Options,
  // nosniff, X-XSS-Protection are byte-identical to pw-proxy's copies).
  app.use(helmet({ contentSecurityPolicy: false, referrerPolicy: false }));
}

module.exports = { applyEdge, TRUST_PROXY_HOPS };
