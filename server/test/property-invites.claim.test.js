const test = require('node:test');
const assert = require('node:assert');

const PropertyInvitesService = require('../src/modules/inventory/property-invites.service');
const Audit = require('../src/modules/audit/audit.service');

// PropertyInvitesService.claimPending — the resolveUser hook (plan
// 2026-09-26-property-invites.md, "Contract → tally"). Driven directly
// against a scripted in-memory property_invites/property_members table;
// pwiam is never involved in claiming (only in minting/revoking), so
// PropertyInvitesService.init() here gets no fetch stub at all.

const logger = { warn() {}, info() {}, error() {} };
const config = { auth: { iam: { issuer: 'https://id.example.test', clientId: 'x', clientSecret: 'y' } } };

function fakeDb({ invites = [], members = [] }) {
  const query = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT \* FROM TALLY\.property_invites WHERE INVITEE_SUB = \? AND ACCEPTED_AT IS NULL AND REVOKED_AT IS NULL FOR UPDATE$/.test(s)) {
      return invites.filter((i) => i.INVITEE_SUB === params[0] && !i.ACCEPTED_AT && !i.REVOKED_AT);
    }
    if (/^SELECT ID FROM TALLY\.property_members WHERE PROPERTY_ID = \? AND USER_ID = \?$/.test(s)) {
      return members.filter((m) => m.PROPERTY_ID === params[0] && m.USER_ID === params[1]);
    }
    if (/^INSERT INTO TALLY\.property_members/.test(s)) {
      const [propertyId, userId, role, invitedBy] = params;
      members.push({ ID: members.length + 1, PROPERTY_ID: propertyId, USER_ID: userId, ROLE: role, INVITED_BY: invitedBy });
      return { affectedRows: 1 };
    }
    if (/^UPDATE TALLY\.property_invites SET ACCEPTED_AT = NOW\(\), ACCEPTED_USER_ID = \? WHERE ID = \?$/.test(s)) {
      const inv = invites.find((i) => i.ID === params[1]);
      if (inv) { inv.ACCEPTED_AT = new Date(); inv.ACCEPTED_USER_ID = params[0]; }
      return { affectedRows: 1 };
    }
    throw new Error(`fakeDb: unexpected statement: ${s}`);
  };
  return { query, withTransaction: async (fn) => fn({ query }), invites, members };
}

let audits;
test.beforeEach(() => {
  audits = [];
  Audit.init({ db: { query: async (sql, params) => { audits.push(params); return []; } }, logger });
});

test('claims a pending invite for a brand-new user: inserts membership, stamps accepted', async () => {
  const db = fakeDb({ invites: [{ ID: 1, PROPERTY_ID: 3, ROLE: 'editor', INVITEE_SUB: '01JINV', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: null }] });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimPending('01JINV', 99);

  assert.equal(db.members.length, 1);
  assert.deepEqual(db.members[0], { ID: 1, PROPERTY_ID: 3, USER_ID: 99, ROLE: 'editor', INVITED_BY: 42 });
  assert.ok(db.invites[0].ACCEPTED_AT);
  assert.equal(db.invites[0].ACCEPTED_USER_ID, 99);
  assert.equal(audits.length, 1);
});

test('claims a pending invite for a RETURNING user the same way', async () => {
  // "returning" just means resolveUser's SUB match branch ran instead of the
  // insert branch — claimPending itself only ever sees (sub, userId), so the
  // same path exercises both.
  const db = fakeDb({ invites: [{ ID: 1, PROPERTY_ID: 5, ROLE: 'viewer', INVITEE_SUB: '01JINV', INVITED_BY: 7, ACCEPTED_AT: null, REVOKED_AT: null }] });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimPending('01JINV', 100);

  assert.equal(db.members.length, 1);
  assert.equal(db.members[0].USER_ID, 100);
  assert.equal(db.members[0].ROLE, 'viewer');
});

test('never downgrades an existing membership — an existing row is left untouched', async () => {
  const db = fakeDb({
    invites: [{ ID: 1, PROPERTY_ID: 3, ROLE: 'viewer', INVITEE_SUB: '01JINV', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: null }],
    members: [{ ID: 5, PROPERTY_ID: 3, USER_ID: 99, ROLE: 'owner', INVITED_BY: null }],
  });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimPending('01JINV', 99);

  assert.equal(db.members.length, 1, 'no second row inserted');
  assert.equal(db.members[0].ROLE, 'owner', 'the existing owner role is untouched by a viewer invite');
  assert.ok(db.invites[0].ACCEPTED_AT, 'the invite is still marked accepted, closing out the pending state');
});

test('skips a revoked invite entirely', async () => {
  const db = fakeDb({ invites: [{ ID: 1, PROPERTY_ID: 3, ROLE: 'editor', INVITEE_SUB: '01JINV', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: new Date() }] });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimPending('01JINV', 99);

  assert.equal(db.members.length, 0);
});

test('is idempotent: a second call (e.g. a silent refresh) after claiming is a no-op', async () => {
  const db = fakeDb({ invites: [{ ID: 1, PROPERTY_ID: 3, ROLE: 'editor', INVITEE_SUB: '01JINV', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: null }] });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimPending('01JINV', 99);
  assert.equal(db.members.length, 1);
  assert.equal(audits.length, 1);

  await PropertyInvitesService.claimPending('01JINV', 99);
  assert.equal(db.members.length, 1, 'no second membership row');
  assert.equal(audits.length, 1, 'no second audit entry');
});

test('claims several pending invites for the same sub across different properties in one call', async () => {
  const db = fakeDb({
    invites: [
      { ID: 1, PROPERTY_ID: 3, ROLE: 'editor', INVITEE_SUB: '01JINV', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: null },
      { ID: 2, PROPERTY_ID: 4, ROLE: 'viewer', INVITEE_SUB: '01JINV', INVITED_BY: 7, ACCEPTED_AT: null, REVOKED_AT: null },
    ],
  });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimPending('01JINV', 99);

  assert.equal(db.members.length, 2);
  assert.deepEqual(db.members.map((m) => m.PROPERTY_ID).sort(), [3, 4]);
});
