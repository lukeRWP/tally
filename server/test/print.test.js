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
  PrintService.init({
    db: fakeDb((s, p) => {
      sql = s; params = p;
      return [{ ENTITY_ID: 5, PROPERTY_ID: 3 }, { ENTITY_ID: 6, PROPERTY_ID: 3 }];
    }), logger, config,
  });
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

  PrintService.init({ db: fakeDb(() => [{ ENTITY_ID: 1, PROPERTY_ID: 3 }, { ENTITY_ID: 2, PROPERTY_ID: 4 }]), logger, config });
  assert.deepEqual(await PrintService.resolveProperty('item', [1, 2], 42), { error: 'mixed' });
});

test('resolveProperty refuses a partially-visible batch instead of silently narrowing it', async () => {
  // item 5 is visible (property 3); item 999 is foreign/nonexistent and yields no row.
  PrintService.init({ db: fakeDb(() => [{ ENTITY_ID: 5, PROPERTY_ID: 3 }]), logger, config });
  assert.deepEqual(await PrintService.resolveProperty('item', [5, 999], 42), { error: 'not_found' });
});

test('resolveProperty succeeds for a fully-visible multi-id batch', async () => {
  PrintService.init({
    db: fakeDb(() => [{ ENTITY_ID: 5, PROPERTY_ID: 3 }, { ENTITY_ID: 6, PROPERTY_ID: 3 }]),
    logger, config,
  });
  assert.deepEqual(await PrintService.resolveProperty('item', [5, 6], 42), { propertyId: 3 });
});

test('resolveProperty tolerates duplicate ids in the request', async () => {
  PrintService.init({ db: fakeDb(() => [{ ENTITY_ID: 5, PROPERTY_ID: 3 }]), logger, config });
  assert.deepEqual(await PrintService.resolveProperty('item', [5, 5], 42), { propertyId: 3 }, 'a duplicate id must not spuriously trip the not_found count check');
});

test('resolveProperty rejects an empty id array without querying the db', async () => {
  let queried = false;
  PrintService.init({ db: fakeDb(() => { queried = true; return []; }), logger, config });
  assert.deepEqual(await PrintService.resolveProperty('item', [], 42), { error: 'not_found' });
  assert.equal(queried, false, 'an empty id array must be guarded before any SQL is built/run');
});

test('createJob queues when the loaded roll matches and holds when it does not', async () => {
  const mk = (loaded) => fakeDb((sql) => {
    if (/property_members/i.test(sql)) return [{ ENTITY_ID: 5, PROPERTY_ID: 3 }];
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
    if (/property_members/i.test(sql)) return [{ ENTITY_ID: 1, PROPERTY_ID: 3 }];
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

test('createJob refuses a partially-visible batch and never inserts', async () => {
  let inserted = false;
  PrintService.init({ db: fakeDb((sql) => {
    if (/INSERT/i.test(sql)) { inserted = true; return { insertId: 1 }; }
    if (/property_members/i.test(sql)) return [{ ENTITY_ID: 5, PROPERTY_ID: 3 }]; // 999 never resolves
    return [];
  }), logger, config });
  const out = await PrintService.createJob({ entityType: 'item', entityIds: [5, 999], preset: 'small', userId: 42 });
  assert.deepEqual(out, { error: 'not_found' });
  assert.equal(inserted, false, 'a partially-visible batch must never create a job for the subset that resolved');
});

test('createJob picks the printer agent deterministically when more than one is registered', async () => {
  let agentSql = '';
  PrintService.init({ db: fakeDb((sql) => {
    if (/property_members/i.test(sql)) return [{ ENTITY_ID: 5, PROPERTY_ID: 3 }];
    if (/FROM TALLY\.printer_agents/i.test(sql)) { agentSql = sql; return [{ LOADED_MEDIA: 'small' }]; }
    if (/INSERT INTO TALLY\.print_jobs/i.test(sql)) return { insertId: 1 };
    return [];
  }), logger, config });
  await PrintService.createJob({ entityType: 'item', entityIds: [5], preset: 'small', userId: 42 });
  assert.match(agentSql, /ORDER BY ID\s+LIMIT 1/i, 'the agent pick must be deterministic — no ORDER BY makes it depend on storage order');
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

// ── agent-side job operations ────────────────────────────────────────────────

test('claimNext persists telemetry and derives property/preset from the AGENT, not the request', async () => {
  const seen = [];
  PrintService.init({ db: fakeDb((sql, params) => {
    seen.push({ sql, params });
    if (/UPDATE TALLY\.printer_agents/i.test(sql)) return { affectedRows: 1 };
    if (/SET STATUS\s*=\s*'queued'/i.test(sql)) return { affectedRows: 0 };   // stale sweep
    if (/SET STATUS\s*=\s*'claimed'/i.test(sql)) return { affectedRows: 1 };  // claim
    if (/SELECT .* FROM TALLY\.print_jobs/i.test(sql)) {
      return [{ ID: 11, PROPERTY_ID: 3, CREATED_BY: 42, ENTITY_TYPE: 'container',
                ENTITY_IDS: '[5]', PRESET: 'large', STATUS: 'claimed', ATTEMPTS: 0 }];
    }
    return [];
  }), logger, config });

  const agent = { id: 7, propertyId: 3, loadedMedia: 'large' };
  const job = await PrintService.claimNext(agent, { printerState: 'idle', printerStateReasons: ['media-empty'] });

  assert.equal(job.id, 11);
  const telem = seen.find(s => /UPDATE TALLY\.printer_agents/i.test(s.sql));
  assert.ok(telem, 'telemetry must be written on every claim');
  assert.ok(telem.params.includes('idle'), 'printerState persisted');
  assert.match(telem.sql, /LAST_SEEN_AT/i, 'liveness is refreshed on the claim');

  const claim = seen.find(s => /SET STATUS\s*=\s*'claimed'/i.test(s.sql));
  assert.ok(claim.params.includes(3), 'propertyId comes from the agent row');
  assert.ok(claim.params.includes('large'), 'preset comes from the agent LOADED_MEDIA');
  assert.match(claim.sql, /STATUS\s*=\s*'queued'/i, 'only queued jobs are claimable');
  assert.match(claim.sql, /LIMIT 1/i);
});

test('claimNext returns null when nothing is claimable', async () => {
  PrintService.init({ db: fakeDb((sql) => {
    if (/UPDATE/i.test(sql)) return { affectedRows: 0 };
    return [];
  }), logger, config });
  assert.equal(await PrintService.claimNext({ id: 7, propertyId: 3, loadedMedia: 'small' }, {}), null);
});

test('sweepStaleClaims requeues abandoned claims and increments attempts', async () => {
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 2 }; }), logger, config });
  assert.equal(await PrintService.sweepStaleClaims(3), 2);
  assert.match(sql, /STATUS\s*=\s*'claimed'/i, 'only claimed rows are swept');
  assert.match(sql, /ATTEMPTS\s*=\s*ATTEMPTS\s*\+\s*1/i);
  assert.match(sql, /CLAIMED_AT\s*<\s*DATE_SUB/i, 'swept by claim age');
});

test('getClaimedJob refuses a job this agent does not currently hold', async () => {
  let params = null;
  PrintService.init({ db: fakeDb((sql, p) => { params = p; return []; }), logger, config });
  assert.equal(await PrintService.getClaimedJob(11, 7), null);
  assert.deepEqual(params, [11, 7], 'both the job id AND the agent id are bound');
});

test('ackJob(ok) marks done; ack(fail) requeues until the attempt cap then fails', async () => {
  // ok -> done
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 1 }; }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, true, null), 'done');
  assert.match(sql, /STATUS\s*=\s*'done'/i);
  assert.match(sql, /PRINTED_AT/i);

  // fail below the cap -> queued
  PrintService.init({ db: fakeDb((s) => {
    if (/SELECT/i.test(s)) return [{ ATTEMPTS: 1 }];
    return { affectedRows: 1 };
  }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, false, 'media-empty'), 'queued');

  // fail at the cap -> failed
  PrintService.init({ db: fakeDb((s) => {
    if (/SELECT/i.test(s)) return [{ ATTEMPTS: 2 }];   // this ack makes 3
    return { affectedRows: 1 };
  }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, false, 'media-empty'), 'failed');
});

test('renderJobPdf renders as the queuing user so Phase 1 scoping still applies', async () => {
  const Labels = require('../src/modules/labels/labels.service');
  const calls = [];
  const origGet = Labels.getEntityData;
  const origRender = Labels.renderLabelPdf;
  Labels.getEntityData = async (type, ids, userId) => { calls.push({ type, ids, userId }); return [{ name: 'x', qrCode: 'TLY-C-1' }]; };
  Labels.renderLabelPdf = async () => Buffer.from('%PDF-fake');
  try {
    PrintService.init({ db: fakeDb(() => []), logger, config });
    const buf = await PrintService.renderJobPdf({ id: 11, createdBy: 42, entityType: 'container', entityIds: [5], preset: 'medium' });
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual(calls[0], { type: 'container', ids: [5], userId: 42 },
      'the job is rendered as its CREATED_BY user, never unscoped');
  } finally {
    Labels.getEntityData = origGet;
    Labels.renderLabelPdf = origRender;
  }
});

test('ackJob(fail) reports null when a concurrent sweep already requeued the claim', async () => {
  // The SELECT sees the row still claimed, but by the time the UPDATE runs a
  // concurrent claimNext() has swept it stale — the write matches nothing.
  let sql = '';
  PrintService.init({ db: fakeDb((s) => {
    if (/SELECT/i.test(s)) return [{ ATTEMPTS: 0 }];
    sql = s;
    return { affectedRows: 0 };
  }), logger, config });

  assert.equal(await PrintService.ackJob(11, 7, false, 'media-empty'), null,
    'a no-op write must not report a status the row never took');
  assert.match(sql, /STATUS\s*=\s*'claimed'/i,
    "the failure UPDATE must re-assert STATUS='claimed', not just CLAIMED_BY");
});

// ── agent registration & roll-state release ──────────────────────────────────

test('createAgent stores only a hash and returns the plaintext token once', async () => {
  let insertParams = null;
  PrintService.init({ db: fakeDb((sql, params) => {
    if (/FROM TALLY\.property_members/i.test(sql)) return [{ PROPERTY_ID: 3 }];
    if (/INSERT INTO TALLY\.printer_agents/i.test(sql)) { insertParams = params; return { insertId: 7 }; }
    return [];
  }), logger, config });

  const out = await PrintService.createAgent({ propertyId: 3, name: 'Garage Pi', userId: 42 });
  assert.equal(out.id, 7);
  assert.match(out.token, /^tp_[0-9a-f]{64}$/, 'plaintext is returned to the caller');
  assert.ok(insertParams.includes(hashToken(out.token)), 'the HASH is what gets stored');
  assert.ok(!insertParams.includes(out.token), 'the plaintext must never be stored');
});

test('createAgent refuses a property the caller is not a member of', async () => {
  let inserted = false;
  PrintService.init({ db: fakeDb((sql) => {
    if (/INSERT/i.test(sql)) { inserted = true; return { insertId: 1 }; }
    return [];   // membership check finds nothing
  }), logger, config });
  assert.deepEqual(await PrintService.createAgent({ propertyId: 999, name: 'x', userId: 42 }), { error: 'not_found' });
  assert.equal(inserted, false);
});

test('listAgents never returns a token or its hash', async () => {
  PrintService.init({ db: fakeDb(() => [{
    ID: 7, PROPERTY_ID: 3, NAME: 'Garage Pi', TOKEN_HASH: 'deadbeef',
    LOADED_MEDIA: 'large', PRINTER_STATE: 'idle', PRINTER_STATE_REASONS: '[]', LAST_SEEN_AT: null,
  }]), logger, config });
  const [agent] = await PrintService.listAgents(3, 42);
  assert.equal(agent.name, 'Garage Pi');
  assert.equal(agent.token, undefined);
  assert.equal(agent.tokenHash, undefined);
  assert.ok(!JSON.stringify(agent).includes('deadbeef'), 'no hash may leak to the client');
});

test('setLoadedMedia releases exactly the held jobs matching the new roll', async () => {
  const seen = [];
  PrintService.init({ db: fakeDb((sql, params) => {
    seen.push({ sql, params });
    if (/UPDATE TALLY\.printer_agents/i.test(sql)) return { affectedRows: 1 };
    return { affectedRows: 4 };
  }), logger, config });

  const out = await PrintService.setLoadedMedia(7, 'medium', 42);
  assert.deepEqual(out, { released: 4 });

  const release = seen.find(s => /STATUS\s*=\s*'queued'/i.test(s.sql));
  assert.match(release.sql, /STATUS\s*=\s*'held'/i, 'only held jobs are released');
  assert.ok(release.params.includes('medium'), 'released only for the newly loaded roll');
});

test('setLoadedMedia is membership-scoped and returns null for a foreign agent', async () => {
  PrintService.init({ db: fakeDb(() => ({ affectedRows: 0 })), logger, config });
  assert.equal(await PrintService.setLoadedMedia(7, 'small', 42), null);
});

test('revokeAgent is membership-scoped and binds the caller', async () => {
  // The DELETE ... JOIN form is unique to this module, so pin its scoping.
  let sql = '', params = null;
  PrintService.init({ db: fakeDb((s, p) => { sql = s; params = p; return { affectedRows: 1 }; }), logger, config });
  assert.equal(await PrintService.revokeAgent(7, 42), true);
  assert.match(sql, /property_members/i, 'the delete must join property_members');
  assert.match(sql, /pm\.USER_ID = \?/i);
  assert.deepEqual(params, [42, 7], 'userId is bound before the agent id');
});

test('revokeAgent returns false for an agent the caller cannot reach', async () => {
  PrintService.init({ db: fakeDb(() => ({ affectedRows: 0 })), logger, config });
  assert.equal(await PrintService.revokeAgent(7, 42), false);
});
