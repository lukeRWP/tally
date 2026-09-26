// pwiam client for the property-invite endpoints (plan
// docs/superpowers/plans/2026-09-26-property-invites.md, "Contract → pwiam").
//
// Basic-auth'd with the app's own WEB client credentials — the same
// PW_IAM_CLIENT_ID/SECRET @pw/auth-express uses for sign-in (config.auth.iam)
// — because pwiam's /rp/invites gate is `apps.verifyClientSecret` +
// `kind === 'web'`, the same rule as /apikeys/introspect. Nothing here reads
// or writes TALLY.property_invites — that is property-invites.service.js;
// this module only speaks to pwiam.
//
// `fetch` is a constructor argument, not a bare require of the global, so
// tests can stub it without touching the network — same idiom as the rest of
// this module's dependency injection ({ db, logger, config }).

const TIMEOUT_MS = 10000;

// pwiam status codes this client understands, mapped onto what tally tells
// its own caller. 429/403 are the caller-actionable outcomes the plan names;
// everything else pwiam could return here (401 invalid_client, a malformed
// 400, an outage) is tally's own misconfiguration or pwiam being unavailable
// — never something the property owner did — so it collapses to one 502
// "could not reach the invite service", logged at error without secrets or
// the URL (the URL contains the raw, single-use join token).
function pwiamInvitesClient({ config, logger, fetch: fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { issuer, clientId, clientSecret } = config.auth.iam;
  const authHeader = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  async function post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    // The timer stays armed for the WHOLE request — fetch() resolving is
    // only the headers; a stalled or slow body read must still be abortable
    // by the same 10s budget. Clearing it right after fetch() resolves (the
    // original bug) leaves nothing armed to abort a hang inside res.json().
    try {
      let res;
      try {
        res = await doFetch(`${issuer}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authHeader },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
      } catch (err) {
        logger.error('[pwiam-invites] request failed', { path, error: err.message });
        const wrapped = new Error('Could not reach the invite service');
        wrapped.statusCode = 502;
        throw wrapped;
      }

      let json = null;
      try { json = await res.json(); } catch { /* not JSON — treated as no body below */ }

      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * `{ displayName, invitedBy: { sub, name } }` → the minted ticket
     * `{ id, userId, url, expiresAt }`. Throws (statusCode set) on anything
     * that isn't 201: 429 cap_reached → 429, everything else → 502 (403
     * not_enabled included — a property owner seeing "not enabled" reads as
     * a tally bug, not something they can fix, so it is not distinguished
     * from any other upstream failure here).
     */
    async createInvite({ displayName, invitedBy }) {
      const { status, json } = await post('/rp/invites', { displayName, invitedBy });
      if (status === 201 && json) return json;
      if (status === 429) {
        const err = new Error('Invite limit reached for today');
        err.statusCode = 429;
        throw err;
      }
      logger.error('[pwiam-invites] create invite rejected', { status, pwiamError: json && json.error });
      const err = new Error('Could not reach the invite service');
      err.statusCode = status === 403 ? 503 : 502;
      throw err;
    },

    /**
     * Revoke by pwiam invite id. 200/404/409 are all expected outcomes the
     * caller branches on — see property-invites.service.js's revoke() — so
     * they come back as a value, not a throw. Anything else (429/5xx/network)
     * throws, same mapping as createInvite.
     */
    async revokeInvite(id) {
      const { status, json } = await post(`/rp/invites/${id}/revoke`);
      if (status === 200) return { revoked: true };
      if (status === 404) return { revoked: false, reason: 'not_found' };
      if (status === 409) return { revoked: false, reason: 'redeemed' };
      if (status === 429) {
        const err = new Error('Invite limit reached for today');
        err.statusCode = 429;
        throw err;
      }
      logger.error('[pwiam-invites] revoke invite rejected', { status, pwiamError: json && json.error });
      const err = new Error('Could not reach the invite service');
      err.statusCode = status === 403 ? 503 : 502;
      throw err;
    },
  };
}

module.exports = { pwiamInvitesClient };
