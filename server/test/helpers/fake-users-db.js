// An in-memory stand-in for the handful of statements AuthService.resolveUser
// issues against TALLY.users, matched by shape. Anything
// else throws, so a new query in the service cannot pass by accident.
//
// Returns rows for SELECTs and a ResultSetHeader-ish object for writes —
// the same contract as db.query (src/infrastructure/db.js).
function fakeUsersDb({ users = [] } = {}) {
  let nextId = users.reduce((m, u) => Math.max(m, u.ID), 0) + 1;
  const calls = [];

  async function query(sql, params = []) {
    calls.push({ sql, params });
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT \* FROM TALLY\.users WHERE SUB = \?$/.test(s)) {
      return users.filter((u) => u.SUB === params[0]);
    }
    if (/^SELECT \* FROM TALLY\.users WHERE ENTRA_ID = \? AND SUB IS NULL$/.test(s)) {
      return users.filter((u) => u.ENTRA_ID === params[0] && u.SUB == null);
    }
    if (/^SELECT \* FROM TALLY\.users WHERE ID = \?$/.test(s)) {
      return users.filter((u) => u.ID === params[0]);
    }
    if (/^UPDATE TALLY\.users SET SUB = \? WHERE ID = \? AND SUB IS NULL$/.test(s)) {
      const u = users.find((x) => x.ID === params[1] && x.SUB == null);
      if (u) u.SUB = params[0];
      return { affectedRows: u ? 1 : 0 };
    }
    if (/^INSERT INTO TALLY\.users \(SUB, ENTRA_ID, EMAIL, DISPLAY_NAME, AVATAR_URL\) VALUES \(\?, \?, \?, \?, NULL\)$/.test(s)) {
      if (users.some((u) => u.SUB === params[0])) {
        const err = new Error('Duplicate entry');
        err.code = 'ER_DUP_ENTRY';
        throw err;
      }
      const row = {
        ID: nextId++, SUB: params[0], ENTRA_ID: params[1], EMAIL: params[2], DISPLAY_NAME: params[3],
        AVATAR_URL: null, CREATED_AT: new Date('2026-01-01T00:00:00Z'), LAST_LOGIN_AT: null,
      };
      users.push(row);
      return { insertId: row.ID, affectedRows: 1 };
    }
    if (/^UPDATE TALLY\.users SET LAST_LOGIN_AT = \? WHERE ID = \? AND \(LAST_LOGIN_AT IS NULL OR LAST_LOGIN_AT < \?\)$/.test(s)) {
      const u = users.find((x) => x.ID === params[1]);
      const newer = u && (u.LAST_LOGIN_AT == null || u.LAST_LOGIN_AT < params[2]);
      if (newer) u.LAST_LOGIN_AT = params[0];
      return { affectedRows: newer ? 1 : 0 };
    }
    if (/^DELETE FROM `TALLY`\.`sessions` WHERE `EXPIRES_AT` <= \?$/.test(s)) {
      return { affectedRows: 0 }; // the shim's sweepExpiredSessions
    }
    throw new Error(`fakeUsersDb: unexpected statement: ${s}`);
  }

  return { query, users, calls };
}

module.exports = { fakeUsersDb };
