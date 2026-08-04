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
