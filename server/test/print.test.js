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

test('agentClaim coerces junk telemetry instead of failing the claim', () => {
  // Spec §5a: telemetry must never be able to break a claim. A 400 here would
  // wedge the printer's whole queue over a cosmetic field.
  const r = schema.agentClaim.validate({ printerState: 'on fire', printerStateReasons: 'nonsense' });
  assert.equal(r.error, undefined, 'malformed telemetry must not reject the claim');
  assert.equal(r.value.printerState, 'unknown');
  assert.deepEqual(r.value.printerStateReasons, []);

  const mixed = schema.agentClaim.validate({ printerState: 'stopped', printerStateReasons: ['media-empty', 42] });
  assert.equal(mixed.error, undefined);
  assert.equal(mixed.value.printerState, 'stopped', 'a valid state is preserved');
  assert.deepEqual(mixed.value.printerStateReasons, ['media-empty'], 'non-string reasons are dropped');
});

test('agentAck requires ok AND the claimId fence, and carries an optional error string', () => {
  assert.equal(schema.agentAck.validate({ ok: true, claimId: 'c1' }).error, undefined);
  assert.equal(schema.agentAck.validate({ ok: false, claimId: 'c1', error: 'media-empty' }).error, undefined);
  assert.ok(schema.agentAck.validate({}).error);
  // #104: an ack without its claim id skips the fence and could land on a
  // LATER claim of the same job — the fence is mandatory, not best-effort.
  assert.ok(schema.agentAck.validate({ ok: true }).error, 'an unfenced ack must be rejected');
  assert.ok(schema.agentAck.validate({ ok: false, error: 'x' }).error);
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
    if (/SELECT ROLE FROM TALLY\.property_members/i.test(sql)) return [{ ROLE: 'owner' }];
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
    if (/SELECT ROLE FROM TALLY\.property_members/i.test(sql)) return [{ ROLE: 'owner' }];
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
    if (/SELECT ROLE FROM TALLY\.property_members/i.test(sql)) return [{ ROLE: 'owner' }];
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
    if (/SELECT ROLE FROM TALLY\.property_members/i.test(sql)) return [{ ROLE: 'owner' }];
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

test('claimNext withholds jobs while the agent reports its printer stopped (#125)', async () => {
  const seen = [];
  PrintService.init({ db: fakeDb((sql, params) => {
    seen.push({ sql, params });
    if (/UPDATE TALLY\.printer_agents/i.test(sql)) return { affectedRows: 1 };
    if (/SET STATUS = CASE/i.test(sql)) return { affectedRows: 0 };      // stale sweep
    if (/SET STATUS = 'claimed'/i.test(sql)) return { affectedRows: 1 }; // would deal a job if reached
    return [{ ID: 11, PROPERTY_ID: 3, CREATED_BY: 42, ENTITY_TYPE: 'container',
              ENTITY_IDS: '[5]', PRESET: 'large', STATUS: 'claimed', ATTEMPTS: 0 }];
  }), logger, config });

  const job = await PrintService.claimNext(
    { id: 7, propertyId: 3, loadedMedia: 'large' },
    { printerState: 'stopped', printerStateReasons: ['media-empty'] });

  assert.equal(job, null, 'a printer that says "I cannot print" must not be dealt a job');
  const telem = seen.find(s => /UPDATE TALLY\.printer_agents/i.test(s.sql));
  assert.ok(telem, 'the stopped telemetry is still recorded');
  assert.ok(telem.params.includes('stopped'), 'PRINTER_STATE persists the reported state');
  assert.ok(!seen.some(s => /SET STATUS = 'claimed'/i.test(s.sql)),
    'no claim UPDATE may run — queued jobs keep their attempts unburned');
  assert.ok(seen.some(s => /SET STATUS = CASE/i.test(s.sql)),
    'the stale sweep still runs so a dead process\'s claim is not stranded while stopped');
});

test('claimNext with unknown telemetry claims normally — only an explicit stop withholds', async () => {
  // 'unknown' is what the schema coerces ALL junk to, so this is also the
  // malformed-telemetry path: it must never cost the agent its claim.
  for (const telemetry of [{}, { printerState: 'unknown' }, { printerState: 'idle' }]) {
    PrintService.init({ db: fakeDb((sql) => {
      if (/UPDATE TALLY\.printer_agents/i.test(sql)) return { affectedRows: 1 };
      if (/SET STATUS = CASE/i.test(sql)) return { affectedRows: 0 };
      if (/SET STATUS = 'claimed'/i.test(sql)) return { affectedRows: 1 };
      return [{ ID: 11, PROPERTY_ID: 3, CREATED_BY: 42, ENTITY_TYPE: 'container',
                ENTITY_IDS: '[5]', PRESET: 'large', STATUS: 'claimed', ATTEMPTS: 0 }];
    }), logger, config });
    const job = await PrintService.claimNext({ id: 7, propertyId: 3, loadedMedia: 'large' }, telemetry);
    assert.equal(job?.id, 11, `${JSON.stringify(telemetry)} must still be dealt a job`);
  }
});

test('listAgents carries the agent last-contact time as camelCase lastSeenAt (#204)', async () => {
  PrintService.init({ db: fakeDb(() => [{
    ID: 7, PROPERTY_ID: 3, NAME: 'Garage Pi', LOADED_MEDIA: 'large',
    PRINTER_STATE: 'idle', PRINTER_STATE_REASONS: '[]',
    LAST_SEEN_AT: '2026-08-29 10:00:00',
  }]), logger, config });
  const [agent] = await PrintService.listAgents(3, 42);
  assert.equal(agent.lastSeenAt, '2026-08-29 10:00:00',
    'LAST_SEEN_AT maps through — the UI needs it to say how long the agent has been gone');
});

test('sweepStaleClaims requeues abandoned claims and increments attempts', async () => {
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 2 }; }), logger, config });
  assert.equal(await PrintService.sweepStaleClaims(3), 2);
  assert.match(sql, /STATUS\s*=\s*'claimed'/i, 'only claimed rows are swept');
  assert.match(sql, /ATTEMPTS\s*=\s*ATTEMPTS\s*\+\s*1/i);
  assert.match(sql, /CLAIMED_AT\s*<\s*DATE_SUB/i, 'swept by claim age');
});

test('getClaimedJob returns a job only for the agent AND property that hold it', async () => {
  // A stub that returns [] for everything makes this unfalsifiable — it would
  // pass with the STATUS guard deleted or AND swapped for OR. Discriminate on
  // the exact bound params instead.
  let sql = '';
  const db = fakeDb((s2, p2) => {
    sql = s2;
    const [jobId, agentId, propertyId] = p2;
    return (jobId === 11 && agentId === 7 && propertyId === 3)
      ? [{ ID: 11, PROPERTY_ID: 3, CREATED_BY: 42, ENTITY_TYPE: 'container',
           ENTITY_IDS: '[5]', PRESET: 'large', STATUS: 'claimed', ATTEMPTS: 0, CLAIM_ID: 'c1' }]
      : [];
  });
  PrintService.init({ db, logger, config });

  const mine = await PrintService.getClaimedJob(11, 7, 3);
  assert.equal(mine.id, 11, 'the holding agent gets its job');
  assert.equal(mine.claimId, 'c1', 'the claim id is handed to the agent for ack fencing');

  assert.equal(await PrintService.getClaimedJob(11, 8, 3), null, 'another agent gets nothing');
  assert.equal(await PrintService.getClaimedJob(11, 7, 9), null, 'another property gets nothing');
  assert.match(sql, /STATUS = 'claimed'/i, 'only a currently-claimed job may be fetched');
  // Pin the conjunction explicitly: a fakeDb keys on bound params, so it cannot
  // simulate SQL OR semantics — swapping AND for OR would otherwise let any
  // agent fetch any job's PDF by id and still pass.
  assert.match(sql, /ID = \?\s+AND\s+CLAIMED_BY = \?\s+AND\s+PROPERTY_ID = \?/i,
    'the three guards must be ANDed, never ORed');
});

test('ackJob(ok) marks done; ack(fail) requeues until the attempt cap then fails', async () => {
  // ok -> done
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 1 }; }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, true, null, 'c1'), 'done');
  assert.match(sql, /STATUS\s*=\s*'done'/i);
  assert.match(sql, /PRINTED_AT/i);

  // fail below the cap -> queued
  PrintService.init({ db: fakeDb((s) => {
    if (/SELECT/i.test(s)) return [{ ATTEMPTS: 1 }];
    return { affectedRows: 1 };
  }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, false, 'media-empty', 'c1'), 'queued');

  // fail at the cap -> failed
  PrintService.init({ db: fakeDb((s) => {
    if (/SELECT/i.test(s)) return [{ ATTEMPTS: 2 }];   // this ack makes 3
    return { affectedRows: 1 };
  }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, false, 'media-empty', 'c1'), 'failed');
});

test('ackJob refuses an unfenced ack and fences EVERY statement on CLAIM_ID (#104)', async () => {
  // No claimId -> no write at all. When the fence was optional, an ack that
  // simply omitted it matched on (ID, CLAIMED_BY, STATUS) alone — which a
  // LATER claim of the same job by the same agent also satisfies, so a delayed
  // duplicate ack could mark an in-flight print done or corrupt its attempts.
  let queried = false;
  PrintService.init({ db: fakeDb(() => { queried = true; return { affectedRows: 1 }; }), logger, config });
  assert.equal(await PrintService.ackJob(11, 7, true, null), null, 'an ack with no claimId must not be honored');
  assert.equal(await PrintService.ackJob(11, 7, false, 'x', null), null);
  assert.equal(queried, false, 'an unfenced ack must never reach the database');

  // With a claimId, every statement (done-update, attempts-select, fail-update)
  // carries the fence and binds the id.
  const seen = [];
  PrintService.init({ db: fakeDb((s, p) => {
    seen.push({ sql: s, params: p });
    return /SELECT/i.test(s) ? [{ ATTEMPTS: 0 }] : { affectedRows: 1 };
  }), logger, config });
  await PrintService.ackJob(11, 7, true, null, 'c-A');
  await PrintService.ackJob(11, 7, false, 'media-empty', 'c-A');
  assert.equal(seen.length, 3, 'done-update + attempts-select + fail-update');
  for (const { sql, params } of seen) {
    assert.match(sql, /AND CLAIM_ID = \?/i, `must fence on CLAIM_ID: ${sql.slice(0, 60)}`);
    assert.ok(params.includes('c-A'), 'the claim id is bound');
  }
});

test("cancelJob covers a stuck 'claimed' job and clears its claim (#104 UI escape)", async () => {
  // The stale sweep only runs inside claimNext — an agent that never polls
  // again releases nothing, so user-side cancel is the ONLY escape for a job
  // wedged in 'claimed'. Pin that it stays in the cancellable set.
  let sql = '';
  PrintService.init({ db: fakeDb((s) => { sql = s; return { affectedRows: 1 }; }), logger, config });
  assert.equal(await PrintService.cancelJob(11, 42), true);
  assert.match(sql, /IN\s*\('queued',\s*'held',\s*'claimed'\)/i,
    "'claimed' must remain cancellable — it is the only escape when the agent is gone");
  assert.match(sql, /CLAIM_ID\s*=\s*NULL/i, 'cancel clears the claim so a late ack cannot land on the row');
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

  assert.equal(await PrintService.ackJob(11, 7, false, 'media-empty', 'c1'), null,
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
  assert.equal(out.released, 4, 'held jobs matching the new roll are released');
  assert.equal(typeof out.held, 'number', 'the re-held count is reported too');

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

// ── routes ────────────────────────────────────────────────────────────────────

test('every route is mounted with the correct auth middleware', async () => {
  // Capturing only the path would verify nothing about authorization: an agent
  // route mounted with requireAuth (Pi 401s forever), or a user route mounted
  // with none (unauthenticated job queueing), would both still register 11
  // strings and pass. Capture the handler chain and assert on it.
  const routes = [];
  const requireAuth = (req, res, next) => next();
  const record = (m) => (p, ...handlers) => routes.push({ method: m, path: p, handlers });
  const app = {
    locals: { requireAuth },
    get: record('GET'), post: record('POST'), put: record('PUT'),
    patch: record('PATCH'), delete: record('DELETE'),
  };
  require('../src/modules/print/print.routes')({ app, db: fakeDb(() => []), logger, config });

  const EXPECTED = [
    ['POST', '/api/print/_y_/jobs', 'user'],
    ['GET', '/api/print/_x_/jobs', 'user'],
    ['PATCH', '/api/print/_p_/jobs/:id/cancel', 'user'],
    ['POST', '/api/print/_y_/jobs/:id/retry', 'user'],
    ['POST', '/api/print/_y_/agents', 'user'],
    ['GET', '/api/print/_x_/agents', 'user'],
    ['DELETE', '/api/print/_d_/agents/:id', 'user'],
    ['PUT', '/api/print/_u_/agents/:id/loaded-media', 'user'],
    ['POST', '/api/print/_y_/agent/claim', 'agent'],
    ['GET', '/api/print/_x_/agent/jobs/:id/pdf', 'agent'],
    ['POST', '/api/print/_y_/agent/jobs/:id/ack', 'agent'],
  ];

  for (const [method, path, kind] of EXPECTED) {
    const r = routes.find(x => x.method === method && x.path === path);
    assert.ok(r, `missing route: ${method} ${path}`);
    assert.ok(r.handlers.length > 0, `${path} has no middleware at all`);
    const usesRequireAuth = r.handlers.includes(requireAuth);
    if (kind === 'user') {
      assert.ok(usesRequireAuth, `${path} must be session-authenticated`);
    } else {
      assert.ok(!usesRequireAuth, `${path} must NOT use session auth — it is agent/bearer`);
      // The agent middleware is constructed inside the module, so identity
      // comparison isn't possible; assert a non-handler middleware precedes
      // the final handler instead.
      assert.ok(r.handlers.length >= 2, `${path} must have an auth middleware before its handler`);
      // #104: existence is not enforcement. Probe the chain's first middleware
      // with an unauthenticated request — it must 401 without calling next(),
      // which only the real bearer-auth middleware does.
      const probe = fakeRes();
      let nexted = false;
      await r.handlers[0]({ headers: {} }, probe, () => { nexted = true; });
      assert.equal(nexted, false, `${path} must not pass an unauthenticated request through`);
      assert.equal(probe.statusCode, 401, `${path}'s first middleware must actually enforce bearer auth`);
    }
  }
  assert.equal(routes.length, EXPECTED.length, 'no unexpected extra routes registered');
});


test('createJob rejects the large preset for an item (Phase 1 parity)', () => {
  assert.ok(schema.createJob.validate({ entityType: 'item', entityIds: [1], preset: 'large' }).error,
    'large is a contents manifest — meaningless for an item');
  assert.equal(schema.createJob.validate({ entityType: 'container', entityIds: [1], preset: 'large' }).error, undefined);
  assert.equal(schema.createJob.validate({ entityType: 'area', entityIds: [1], preset: 'large' }).error, undefined);
});

test('sweepStaleClaims applies the attempt cap so a poison job cannot loop forever', async () => {
  let sql = '', params = null;
  PrintService.init({ db: fakeDb((s2, p2) => { sql = s2; params = p2; return { affectedRows: 1 }; }), logger, config });
  await PrintService.sweepStaleClaims(3);
  assert.match(sql, /STATUS\s*=\s*CASE/i, 'the sweep must decide queued-vs-failed, not blindly requeue');
  assert.match(sql, /'failed'/i, 'a repeatedly-abandoned job must eventually fail');
  assert.equal(params[0], 3, 'the attempt cap is bound');
});

test('setLoadedMedia parks now-unprintable queued jobs back into held', async () => {
  const seen = [];
  PrintService.init({ db: fakeDb((s2, p2) => { seen.push({ sql: s2, params: p2 }); return { affectedRows: 2 }; }), logger, config });
  const out = await PrintService.setLoadedMedia(7, 'medium', 42);
  assert.equal(out.held, 2, 'jobs queued for the old roll are re-held');
  const hold = seen.find(x => /SET j\.STATUS = 'held'/i.test(x.sql));
  assert.ok(hold, 'a re-hold statement must run on a roll change');
  assert.match(hold.sql, /STATUS\s*=\s*'queued'\s+AND\s+j\.PRESET\s*<>/i,
    'only queued jobs whose preset no longer matches are parked');
});

test('claimNext reads the job back by CLAIM_ID and claims in FIFO order', async () => {
  // Selecting by CLAIMED_BY instead of CLAIM_ID would hand back the wrong row
  // under concurrency; losing ORDER BY would print labels out of order.
  const seen = [];
  PrintService.init({ db: fakeDb((sql, params) => {
    seen.push({ sql, params });
    if (/UPDATE TALLY\.printer_agents/i.test(sql)) return { affectedRows: 1 };
    if (/SET STATUS = CASE/i.test(sql)) return { affectedRows: 0 };
    if (/SET STATUS = 'claimed'/i.test(sql)) return { affectedRows: 1 };
    return [{ ID: 11, PROPERTY_ID: 3, CREATED_BY: 42, ENTITY_TYPE: 'container',
              ENTITY_IDS: '[5]', PRESET: 'large', STATUS: 'claimed', ATTEMPTS: 0 }];
  }), logger, config });

  await PrintService.claimNext({ id: 7, propertyId: 3, loadedMedia: 'large' }, {});

  const claim = seen.find(s => /SET STATUS = 'claimed'/i.test(s.sql));
  assert.match(claim.sql, /ORDER BY CREATED_AT/i, 'the oldest queued job must be claimed first');
  const readback = seen.find(s => /SELECT \* FROM TALLY\.print_jobs/i.test(s.sql));
  assert.match(readback.sql, /WHERE CLAIM_ID = \?/i, 'the read-back must key on the generated CLAIM_ID');
  assert.equal(readback.params[0], claim.params[0], 'read-back uses the same claim id that was written');
});

test('sweepStaleClaims binds the property and the staleness window', async () => {
  // Use a propertyId that cannot collide with MAX_ATTEMPTS(3) or the 5-minute
  // window — an includes() check against 3 was satisfied by MAX_ATTEMPTS alone,
  // so it passed even with PROPERTY_ID scoping deleted entirely.
  let params = null, sql = '';
  PrintService.init({ db: fakeDb((s2, p) => { sql = s2; params = p; return { affectedRows: 0 }; }), logger, config });
  await PrintService.sweepStaleClaims(42);
  assert.deepEqual(params, [3, 3, 42, 5],
    'binds [cap, cap, propertyId, staleMinutes] in exactly that order');
  assert.match(sql, /PROPERTY_ID = \?/i, 'the sweep is scoped to one property, never global');
});

test('renderJobPdf large branch builds a manifest bundle as the queuing user', async () => {
  const Labels = require('../src/modules/labels/labels.service');
  const origManifest = Labels.getManifest;
  const origBundle = Labels.renderManifestBundle;
  const calls = [];
  Labels.getManifest = async (type, id, userId) => { calls.push({ type, id, userId }); return { header: {}, rows: [] }; };
  Labels.renderManifestBundle = async (manifests, preset) => { calls.push({ manifests: manifests.length, preset }); return Buffer.from('%PDF-x'); };
  try {
    PrintService.init({ db: fakeDb(() => []), logger, config });
    const buf = await PrintService.renderJobPdf({
      id: 11, createdBy: 42, entityType: 'container', entityIds: [5, 6], preset: 'large',
    });
    assert.ok(Buffer.isBuffer(buf));
    assert.deepEqual(calls[0], { type: 'container', id: 5, userId: 42 },
      'each manifest is fetched as the queuing user, never unscoped');
    assert.deepEqual(calls.at(-1), { manifests: 2, preset: 'large' },
      'all resolved manifests are bundled into one PDF');
  } finally {
    Labels.getManifest = origManifest;
    Labels.renderManifestBundle = origBundle;
  }
});

// ── Role enforcement ────────────────────────────────────────────────────────
// The print module shipped with NO role checks: every route was requireAuth
// only. A viewer could mint a printer bearer token and use it to pull
// large-preset contents manifests — the whole inventory — and could delete the
// owner's real printer. These pin the gate shut.

test('createJob refuses a viewer: printing is an editing action', async () => {
  const db = fakeDb((sql) => {
    if (/SELECT ROLE FROM TALLY\.property_members/i.test(sql)) return [{ ROLE: 'viewer' }];
    if (/property_members/i.test(sql)) return [{ ENTITY_ID: 5, PROPERTY_ID: 3 }];
    if (/INSERT INTO TALLY\.print_jobs/i.test(sql)) return { insertId: 11 };
    return [];
  });
  PrintService.init({ db, logger, config });
  const out = await PrintService.createJob({
    entityType: 'container', entityIds: [5], preset: 'large', userId: 42,
  });
  assert.deepEqual(out, { error: 'forbidden' }, 'a viewer must not be able to queue a job');
});

test('createJob still allows owner and editor', async () => {
  for (const role of ['owner', 'editor']) {
    const db = fakeDb((sql) => {
      if (/SELECT ROLE FROM TALLY\.property_members/i.test(sql)) return [{ ROLE: role }];
      if (/property_members/i.test(sql)) return [{ ENTITY_ID: 5, PROPERTY_ID: 3 }];
      if (/INSERT INTO TALLY\.print_jobs/i.test(sql)) return { insertId: 11 };
      return [];
    });
    PrintService.init({ db, logger, config });
    const out = await PrintService.createJob({
      entityType: 'container', entityIds: [5], preset: 'large', userId: 42,
    });
    assert.equal(out.id, 11, `${role} must still be able to print`);
  }
});

test('requirePrintRole resolves the property per route shape and gates on role', async () => {
  const { requirePrintRole } = require('../src/modules/print/role.middleware');
  const run = async (from, req, roles, rows) => {
    const db = fakeDb((sql) => {
      if (/FROM TALLY\.print_jobs/i.test(sql)) return [{ PROPERTY_ID: 3 }];
      if (/FROM TALLY\.printer_agents/i.test(sql)) return [{ PROPERTY_ID: 3 }];
      if (/property_members/i.test(sql)) return rows;
      return [];
    });
    let status = null, body = null, nexted = false;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    await requirePrintRole({ db }, roles, from)({ user: { id: 1 }, params: { id: 9 }, body: {}, query: {}, ...req }, res, () => { nexted = true; });
    return { status, body, nexted };
  };

  // agent management is owner-only, resolved from the agent row
  assert.equal((await run('agent', {}, ['owner'], [{ ROLE: 'viewer' }])).status, 403, 'viewer cannot manage the printer');
  assert.equal((await run('agent', {}, ['owner'], [{ ROLE: 'owner' }])).nexted, true, 'owner can');

  // job routes resolve the property from the job row
  assert.equal((await run('job', {}, ['owner', 'editor'], [{ ROLE: 'viewer' }])).status, 403);
  assert.equal((await run('job', {}, ['owner', 'editor'], [{ ROLE: 'editor' }])).nexted, true);

  // listing is any member; query-string property ids resolve too
  assert.equal((await run('query', { query: { propertyId: '3' } }, ['owner', 'editor', 'viewer'], [{ ROLE: 'viewer' }])).nexted, true,
    'a viewer may still LIST jobs/printers');

  // a non-member gets 404, not 403 — do not leak that the property exists
  assert.equal((await run('agent', {}, ['owner'], [])).status, 404);
});
