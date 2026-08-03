const test = require('node:test');
const assert = require('node:assert');
const { requireRole, resolvePropertyRole } = require('../src/modules/auth/auth.middleware');

// The authorization backbone: resolvePropertyRole reads the caller's role on a
// property from property_members; requireRole gates on that role. Every
// multi-tenant route depends on this pair, so a regression here silently
// collapses household isolation — yet it had no tests. These lock the contract.

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// ── resolvePropertyRole ─────────────────────────────────────────────────────

test('resolvePropertyRole sets req.propertyRole from membership', async () => {
  const mw = resolvePropertyRole({ query: async () => [{ ROLE: 'owner' }] });
  const req = { params: { propertyId: 5 }, user: { id: 42 } };
  let nexted = false;
  await mw(req, mockRes(), () => { nexted = true; });
  assert.equal(req.propertyRole, 'owner');
  assert.ok(nexted, 'calls next()');
});

test('resolvePropertyRole yields a null role for a non-member', async () => {
  const mw = resolvePropertyRole({ query: async () => [] });
  const req = { params: { propertyId: 5 }, user: { id: 42 } };
  let nexted = false;
  await mw(req, mockRes(), () => { nexted = true; });
  assert.equal(req.propertyRole, null, 'non-member → null role (requireRole then 403s)');
  assert.ok(nexted);
});

test('resolvePropertyRole scopes the membership query by property AND user', async () => {
  let params = null;
  const mw = resolvePropertyRole({ query: async (_sql, p) => { params = p; return []; } });
  await mw({ params: { propertyId: 5 }, user: { id: 42 } }, mockRes(), () => {});
  assert.deepEqual(params, [5, 42], 'binds [propertyId, userId]');
});

// ── requireRole ─────────────────────────────────────────────────────────────

test('requireRole allows a listed role', () => {
  const mw = requireRole('owner', 'editor');
  let nexted = false;
  mw({ propertyRole: 'editor' }, mockRes(), () => { nexted = true; });
  assert.ok(nexted, 'editor is allowed for owner/editor');
});

test('requireRole 403s an unlisted role', () => {
  const mw = requireRole('owner', 'editor');
  const res = mockRes();
  let nexted = false;
  mw({ propertyRole: 'viewer' }, res, () => { nexted = true; });
  assert.equal(nexted, false, 'viewer is blocked');
  assert.equal(res.statusCode, 403);
});

test('requireRole 403s when no property role is set (non-member)', () => {
  const mw = requireRole('owner');
  const res = mockRes();
  let nexted = false;
  mw({ propertyRole: null }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});
