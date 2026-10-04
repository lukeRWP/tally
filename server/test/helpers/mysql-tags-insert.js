// A fake for `INSERT INTO TALLY.tags (...) VALUES (...)` that enforces what
// MySQL enforces on that table: NAME, COLOR and PROPERTY_ID are all NOT NULL
// with no default (SQL/expected-schema.sql).
//
// It maps every column to the value it actually receives — a bound `?` param
// OR a literal written into the SQL text — because the 2026-10-04 prod bug was
// `VALUES (?, NULL, ?)`: the NULL lived in the SQL, so a fake that only looked
// at params[1] saw the property id and let it through. A literal NULL, a NULL
// or undefined param, a literal DEFAULT, or a missing column all fail here the
// way they fail in MySQL; anything else returns { insertId }, the same
// ResultSetHeader-ish contract as db.query (src/infrastructure/db.js).
//
// SQL it cannot parse throws, so a reshaped INSERT cannot pass by accident.
const INSERT_RE = /INSERT\s+INTO\s+\S+\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i;
const NOT_NULL_NO_DEFAULT = ['NAME', 'COLOR', 'PROPERTY_ID'];

function mysqlError(message, code) {
  return Object.assign(new Error(message), { code });
}

function columnValues(sql, params) {
  const m = INSERT_RE.exec(sql);
  if (!m) throw new Error(`mysqlTagsInsertRoute: cannot parse INSERT: ${sql}`);
  const cols = m[1].split(',').map((c) => c.trim().replace(/`/g, '').toUpperCase());
  const vals = m[2].split(',').map((v) => v.trim());
  if (cols.length !== vals.length) {
    throw new Error(`mysqlTagsInsertRoute: ${cols.length} columns but ${vals.length} values: ${sql}`);
  }
  let next = 0;
  const row = {};
  cols.forEach((col, i) => {
    row[col] = vals[i] === '?'
      ? { bound: true, value: params[next++] }
      : { bound: false, literal: vals[i].toUpperCase() };
  });
  if (next !== params.length) {
    throw new Error(`mysqlTagsInsertRoute: ${next} placeholders but ${params.length} params: ${sql}`);
  }
  return row;
}

function mysqlTagsInsertRoute(writes, insertId) {
  return [/INSERT INTO TALLY\.tags/, (sql, params = []) => {
    writes.push({ sql, params });
    const row = columnValues(sql, params);
    for (const col of NOT_NULL_NO_DEFAULT) {
      const v = row[col];
      if (!v || (!v.bound && v.literal === 'DEFAULT')) {
        throw mysqlError(`Field '${col}' doesn't have a default value`, 'ER_NO_DEFAULT_FOR_FIELD');
      }
      if (v.bound ? v.value == null : v.literal === 'NULL') {
        throw mysqlError(`Column '${col}' cannot be null`, 'ER_BAD_NULL_ERROR');
      }
    }
    return { insertId };
  }];
}

module.exports = { mysqlTagsInsertRoute };
