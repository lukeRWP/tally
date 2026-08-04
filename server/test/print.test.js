const test = require('node:test');
const assert = require('node:assert');
const schema = require('../src/modules/print/print.schema');

// ── schema ──────────────────────────────────────────────────────────────────

test('createJob accepts the three printable presets', () => {
  for (const preset of ['small', 'medium', 'large']) {
    const r = schema.createJob.validate({ entityType: 'container', entityIds: [1], preset });
    assert.equal(r.error, undefined, `${preset} should be accepted`);
  }
});

test('createJob rejects the sheet preset — Avery is download-only', () => {
  const r = schema.createJob.validate({ entityType: 'container', entityIds: [1], preset: 'sheet' });
  assert.ok(r.error, 'sheet must be rejected at queue time');
});

test('createJob requires at least one id and caps at 100', () => {
  assert.ok(schema.createJob.validate({ entityType: 'item', entityIds: [], preset: 'small' }).error);
  const many = Array.from({ length: 101 }, (_, i) => i + 1);
  assert.ok(schema.createJob.validate({ entityType: 'item', entityIds: many, preset: 'small' }).error);
});

test('setLoadedMedia accepts only the three roll sizes (never sheet)', () => {
  for (const media of ['small', 'medium', 'large']) {
    assert.equal(schema.setLoadedMedia.validate({ loadedMedia: media }).error, undefined);
  }
  assert.ok(schema.setLoadedMedia.validate({ loadedMedia: 'sheet' }).error);
});

test('agentClaim tolerates a missing telemetry body and defaults to unknown', () => {
  const r = schema.agentClaim.validate({});
  assert.equal(r.error, undefined, 'a claim with no telemetry must still be valid');
  assert.equal(r.value.printerState, 'unknown');
  assert.deepEqual(r.value.printerStateReasons, []);
});

test('agentClaim rejects an unknown printer state', () => {
  assert.ok(schema.agentClaim.validate({ printerState: 'on fire' }).error);
});

test('agentAck requires ok and carries an optional error string', () => {
  assert.equal(schema.agentAck.validate({ ok: true }).error, undefined);
  assert.equal(schema.agentAck.validate({ ok: false, error: 'media-empty' }).error, undefined);
  assert.ok(schema.agentAck.validate({}).error);
});

// ── agent auth middleware ────────────────────────────────────────────────────

const crypto = require('crypto');
const { hashToken, generateToken, requireAgent } = require('../src/modules/print/agent.middleware');

function fakeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('generateToken is prefixed and hashToken is a stable sha256', () => {
  const t = generateToken();
  assert.match(t, /^tp_[0-9a-f]{64}$/);
  assert.equal(hashToken(t), crypto.createHash('sha256').update(t).digest('hex'));
  assert.equal(hashToken(t), hashToken(t), 'hashing is deterministic');
  assert.notEqual(hashToken(t), t, 'the plaintext is never the stored value');
});

test('requireAgent looks the agent up BY HASH, never by plaintext', async () => {
  const token = generateToken();
  let boundParam = null;
  const db = { query: async (sql, params) => {
    boundParam = params[0];
    return [{ ID: 7, PROPERTY_ID: 3, LOADED_MEDIA: 'large', NAME: 'Garage Pi' }];
  } };
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = fakeRes();
  let nexted = false;
  await requireAgent({ db })(req, res, () => { nexted = true; });

  assert.ok(nexted, 'a valid token calls next()');
  assert.equal(boundParam, hashToken(token), 'the query binds the HASH');
  assert.notEqual(boundParam, token, 'the plaintext token is never sent to the db');
  assert.deepEqual(req.agent, { id: 7, propertyId: 3, loadedMedia: 'large', name: 'Garage Pi' });
});

test('requireAgent rejects a missing, malformed, or unknown token with 401', async () => {
  const db = { query: async () => [] }; // no agent matches
  const mw = requireAgent({ db });

  for (const headers of [{}, { authorization: 'Bearer' }, { authorization: 'Basic abc' }]) {
    const res = fakeRes();
    let nexted = false;
    await mw({ headers }, res, () => { nexted = true; });
    assert.equal(nexted, false, 'malformed auth must not call next()');
    assert.equal(res.statusCode, 401);
  }

  const res = fakeRes();
  let nexted = false;
  await mw({ headers: { authorization: `Bearer ${generateToken()}` } }, res, () => { nexted = true; });
  assert.equal(nexted, false, 'an unknown token must not call next()');
  assert.equal(res.statusCode, 401);
});
