const test = require('node:test');
const assert = require('node:assert');

const PropertyInvitesService = require('../src/modules/inventory/property-invites.service');
const Audit = require('../src/modules/audit/audit.service');

// PropertyInvitesService.claimRedeemed — the existing-account half of the
// resolveUser hook (plan 2026-09-27-invites-existing-accounts.md). Same
// semantics as claimPending (property-invites.claim.test.js), but matched by
// PWIAM_INVITE_ID (pwiam's redeemedBy list) instead of INVITEE_SUB. Driven
// against a scripted in-memory property_invites/property_members table; pwiam
// is never involved in claiming (only in asking what was redeemed), so
// PropertyInvitesService.init() here gets no fetch stub at all.

const logger = { warn() {}, info() {}, error() {} };
const config = { auth: { iam: { issuer: 'https://id.example.test', clientId: 'x', clientSecret: 'y' } } };

function fakeDb({ invites = [], members = [] }) {
  const queries = [];
  const query = async (sql, params) => {
    queries.push(sql.replace(/\s+/g, ' ').trim());
    const s = sql.replace(/\s+/g, ' ').trim();
    const inMatch = s.match(/^SELECT \* FROM TALLY\.property_invites WHERE PWIAM_INVITE_ID IN \(([?, ]+)\) AND ACCEPTED_AT IS NULL AND REVOKED_AT IS NULL FOR UPDATE$/);
    if (inMatch) {
      return invites.filter((i) => params.includes(i.PWIAM_INVITE_ID) && !i.ACCEPTED_AT && !i.REVOKED_AT);
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
  return { query, withTransaction: async (fn) => fn({ query }), invites, members, queries };
}

let audits;
test.beforeEach(() => {
  audits = [];
  Audit.init({ db: { query: async (sql, params) => { audits.push(params); return []; } }, logger });
});

test('claims redeemed invites: inserts membership, stamps accepted', async () => {
  const db = fakeDb({ invites: [{ ID: 1, PROPERTY_ID: 3, ROLE: 'editor', PWIAM_INVITE_ID: 'inv1', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: null }] });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimRedeemed(['inv1'], 99);

  assert.equal(db.members.length, 1);
  assert.deepEqual(db.members[0], { ID: 1, PROPERTY_ID: 3, USER_ID: 99, ROLE: 'editor', INVITED_BY: 42 });
  assert.ok(db.invites[0].ACCEPTED_AT);
  assert.equal(db.invites[0].ACCEPTED_USER_ID, 99);
  assert.equal(audits.length, 1);
});

test('claims several redeemed invites for the same user across different properties in one call', async () => {
  const db = fakeDb({
    invites: [
      { ID: 1, PROPERTY_ID: 3, ROLE: 'editor', PWIAM_INVITE_ID: 'inv1', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: null },
      { ID: 2, PROPERTY_ID: 4, ROLE: 'viewer', PWIAM_INVITE_ID: 'inv2', INVITED_BY: 7, ACCEPTED_AT: null, REVOKED_AT: null },
    ],
  });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimRedeemed(['inv1', 'inv2'], 99);

  assert.equal(db.members.length, 2);
  assert.deepEqual(db.members.map((m) => m.PROPERTY_ID).sort(), [3, 4]);
});

test('never downgrades an existing membership — an existing row is left untouched', async () => {
  const db = fakeDb({
    invites: [{ ID: 1, PROPERTY_ID: 3, ROLE: 'viewer', PWIAM_INVITE_ID: 'inv1', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: null }],
    members: [{ ID: 5, PROPERTY_ID: 3, USER_ID: 99, ROLE: 'owner', INVITED_BY: null }],
  });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimRedeemed(['inv1'], 99);

  assert.equal(db.members.length, 1, 'no second row inserted');
  assert.equal(db.members[0].ROLE, 'owner', 'the existing owner role is untouched by a viewer invite');
  assert.ok(db.invites[0].ACCEPTED_AT, 'the invite is still marked accepted, closing out the pending state');
});

test('skips a revoked invite entirely', async () => {
  const db = fakeDb({ invites: [{ ID: 1, PROPERTY_ID: 3, ROLE: 'editor', PWIAM_INVITE_ID: 'inv1', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: new Date() }] });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimRedeemed(['inv1'], 99);

  assert.equal(db.members.length, 0);
});

test('skips an already-accepted invite entirely', async () => {
  const db = fakeDb({ invites: [{ ID: 1, PROPERTY_ID: 3, ROLE: 'editor', PWIAM_INVITE_ID: 'inv1', INVITED_BY: 42, ACCEPTED_AT: new Date(), REVOKED_AT: null }] });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimRedeemed(['inv1'], 99);

  assert.equal(db.members.length, 0);
});

test('an empty invite id list does no DB work at all', async () => {
  const db = fakeDb({ invites: [{ ID: 1, PROPERTY_ID: 3, ROLE: 'editor', PWIAM_INVITE_ID: 'inv1', INVITED_BY: 42, ACCEPTED_AT: null, REVOKED_AT: null }] });
  PropertyInvitesService.init({ db, logger, config });

  await PropertyInvitesService.claimRedeemed([], 99);

  assert.equal(db.members.length, 0);
  assert.equal(db.queries.length, 0, 'no query at all — not even the SELECT');
  assert.equal(audits.length, 0);
});
