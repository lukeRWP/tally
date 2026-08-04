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

// ── user-side job operations ─────────────────────────────────────────────────

const PrintService = require('../src/modules/print/print.service');
function fakeDb(handler) { return { query: async (sql, params) => handler(sql, params) }; }
const logger = { warn() {}, info() {}, error() {} };
const config = { clientUrl: 'https://tally.example' };

test('resolveProperty is membership-scoped and binds userId first', async () => {
  let sql = '', params = null;
  PrintService.init({ db: fakeDb((s, p) => { sql = s; params = p; return [{ PROPERTY_ID: 3 }]; }), logger, config });
  const out = await PrintService.resolveProperty('container', [5, 6], 42);
  assert.deepEqual(out, { propertyId: 3 });
  assert.match(sql, /property_members/i, 'must join property_members');
  assert.match(sql, /pm\.USER_ID = \?/i);
  assert.equal(params[0], 42, 'userId is bound first');
  assert.deepEqual(params.slice(1), [5, 6], 'entity ids follow');
});

test('resolveProperty refuses entities the caller cannot see, and mixed properties', async () => {
  PrintService.init({ db: fakeDb(() => []), logger, config });
  assert.deepEqual(await PrintService.resolveProperty('item', [999], 42), { error: 'not_found' });

  PrintService.init({ db: fakeDb(() => [{ PROPERTY_ID: 3 }, { PROPERTY_ID: 4 }]), logger, config });
  assert.deepEqual(await PrintService.resolveProperty('item', [1, 2], 42), { error: 'mixed' });
});

test('createJob queues when the loaded roll matches and holds when it does not', async () => {
  const mk = (loaded) => fakeDb((sql) => {
    if (/property_members/i.test(sql) && /SELECT DISTINCT/i.test(sql)) return [{ PROPERTY_ID: 3 }];
    if (/FROM TALLY\.printer_agents/i.test(sql)) return [{ LOADED_MEDIA: loaded }];
    if (/INSERT INTO TALLY\.print_jobs/i.test(sql)) return { insertId: 11 };
    return [];
  });

  PrintService.init({ db: mk('large'), logger, config });
  assert.deepEqual(
    await PrintService.createJob({ entityType: 'container', entityIds: [5], preset: 'large', userId: 42 }),
    { id: 11, status: 'queued' });

  PrintService.init({ db: mk('large'), logger, config });
  assert.deepEqual(
    await PrintService.createJob({ entityType: 'container', entityIds: [5], preset: 'medium', userId: 42 }),
    { id: 11, status: 'held' }, 'a 3x3 job while 4x6 is loaded must be held');
});

test('createJob queues normally when no agent is registered yet', async () => {
  PrintService.init({ db: fakeDb((sql) => {
    if (/SELECT DISTINCT/i.test(sql)) return [{ PROPERTY_ID: 3 }];
    if (/FROM TALLY\.printer_agents/i.test(sql)) return [];      // no agent
    if (/INSERT INTO TALLY\.print_jobs/i.test(sql)) return { insertId: 12 };
    return [];
  }), logger, config });
  const out = await PrintService.createJob({ entityType: 'item', entityIds: [1], preset: 'small', userId: 42 });
  assert.equal(out.status, 'queued', 'without an agent a job waits as queued, not held');
});

test('createJob propagates the not_found error instead of inserting', async () => {
  let inserted = false;
  PrintService.init({ db: fakeDb((sql) => {
    if (/INSERT/i.test(sql)) { inserted = true; return { insertId: 1 }; }
    return [];
  }), logger, config });
  const out = await PrintService.createJob({ entityType: 'item', entityIds: [999], preset: 'small', userId: 42 });
  assert.deepEqual(out, { error: 'not_found' });
  assert.equal(inserted, false, 'an unauthorized entity must never create a job');
});

test('listJobs, cancelJob and retryJob are all membership-scoped', async () => {
  for (const call of [
    (s) => s.listJobs(3, 42, 50),
    (s) => s.cancelJob(11, 42),
    (s) => s.retryJob(11, 42),
  ]) {
    let sql = '', params = null;
    PrintService.init({ db: fakeDb((s2, p) => { sql = s2; params = p; return []; }), logger, config });
    await call(PrintService);
    assert.match(sql, /property_members/i, `query must join property_members: ${sql.slice(0, 60)}`);
    assert.ok(params.includes(42), 'userId must be bound');
  }
});

test('retryJob only revives a failed job and resets its attempts', async () => {
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 1 }; }), logger, config });
  assert.equal(await PrintService.retryJob(11, 42), true);
  assert.match(sql, /STATUS\s*=\s*'queued'/i);
  assert.match(sql, /ATTEMPTS\s*=\s*0/i, 'retry resets the attempt counter');
  assert.match(sql, /STATUS\s*=\s*'failed'/i, 'only a failed job may be retried');
});

test('cancelJob refuses to cancel a job already in a terminal state', async () => {
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 0 }; }), logger, config });
  assert.equal(await PrintService.cancelJob(11, 42), false);
  assert.match(sql, /STATUS\s+IN\s*\(/i, 'the update is guarded by a non-terminal status set');
});
