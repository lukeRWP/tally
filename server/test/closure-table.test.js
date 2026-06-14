const test = require('node:test');
const assert = require('node:assert');
const ClosureTableService = require('../src/modules/inventory/closure-table.service');

// A fake executor that records the first line of every query it runs.
function exec() {
  const calls = [];
  return { calls, query: async (sql) => { calls.push(sql.trim().split('\n')[0]); return []; } };
}

test('addNode runs all writes on the passed executor, not this.db', async () => {
  const pool = exec();
  const tx = exec();
  await new ClosureTableService(pool).addNode(42, 7, tx); // parent => self + ancestor copy
  assert.equal(pool.calls.length, 0, 'pooled db must not be touched inside a transaction');
  assert.equal(tx.calls.length, 2);
  assert.match(tx.calls[0], /INSERT INTO TALLY\.container_paths/);
});

test('addNode falls back to this.db when no executor is passed', async () => {
  const pool = exec();
  await new ClosureTableService(pool).addNode(42, null); // no parent => single self-path insert
  assert.equal(pool.calls.length, 1);
});

test('moveNode reads AND writes through the executor', async () => {
  const pool = exec();
  const tx = exec();
  await new ClosureTableService(pool).moveNode(42, 9, tx);
  assert.equal(pool.calls.length, 0);
  assert.ok(tx.calls.some((c) => /SELECT DESCENDANT_ID/.test(c)), 'reads on the tx');
});

test('removeNode deletes paths on the executor', async () => {
  const tx = {
    calls: [],
    query: async (sql) => { tx.calls.push(sql); return /SELECT/.test(sql) ? [{ DESCENDANT_ID: 1 }] : []; },
  };
  await new ClosureTableService(exec()).removeNode(42, tx);
  assert.ok(tx.calls.some((c) => /DELETE FROM TALLY\.container_paths/.test(c)));
});
