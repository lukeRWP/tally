const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const NodeCache = require('node-cache');
const { createRemoteJWKSet, jwtVerify } = require('jose');

// State → codeVerifier cache: 5 minute TTL
const stateCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Singleton service state
let _db = null;
let _config = null;
let _logger = null;
let _devSession = null;

const AuthService = {
  // ── Initialization ───────────────────────────────────────────────────────

  init({ db, config, logger }) {
    _db = db;
    _config = config;
    _logger = logger;

    if (config.auth.bypassAuth) {
      logger.warn('[auth] BYPASS_AUTH is enabled — skipping real authentication');
      // Auto-create a dev session on startup (fire-and-forget)
      AuthService._initDevSession().catch(err => {
        logger.error('[auth] Failed to initialize dev session', { error: err.message });
      });
    }
  },

  isBypassAuth() {
    return _config.auth.bypassAuth === true;
  },

  // ── Dev / Bypass helpers ─────────────────────────────────────────────────

  async _initDevSession() {
    const user = await AuthService.findOrCreateUser(AuthService._devProfile());
    const session = await AuthService.createSession(user.id);
    _devSession = session;
    _logger.info('[auth] Dev session created', { token: session.token.slice(0, 8) + '...' });
    return session;
  },

  _devProfile() {
    return {
      entraId: 'dev-user',
      email: 'dev@tally.local',
      displayName: 'Dev User',
      avatarUrl: null,
    };
  },

  async getOrCreateDevUser() {
    return AuthService.findOrCreateUser(AuthService._devProfile());
  },

  // ── OAuth / PKCE ─────────────────────────────────────────────────────────

  getAuthorizationUrl() {
    if (_config.auth.bypassAuth) {
      // Return a fake redirect straight to the callback with a fake code+state
      const fakeState = 'bypass-state';
      const fakeCode = 'bypass-code';
      const callbackUrl = `${_config.clientUrl}/api/auth/_x_/oauth/callback?code=${fakeCode}&state=${fakeState}`;
      // Store a fake verifier so exchangeCode can find it
      stateCache.set(fakeState, 'bypass-verifier');
      return { url: callbackUrl, state: fakeState };
    }

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    stateCache.set(state, codeVerifier);

    const params = new URLSearchParams({
      client_id: _config.auth.entraClientId,
      response_type: 'code',
      redirect_uri: `${_config.clientUrl}/api/auth/_x_/oauth/callback`,
      scope: 'openid profile email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const url = `https://login.microsoftonline.com/${_config.auth.entraTenantId}/oauth2/v2.0/authorize?${params}`;
    return { url, state };
  },

  async exchangeCode(code, state) {
    if (_config.auth.bypassAuth) {
      return AuthService._devProfile();
    }

    const codeVerifier = stateCache.get(state);
    if (!codeVerifier) {
      throw new Error('Invalid or expired state parameter');
    }
    stateCache.del(state);

    // Exchange code for tokens
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${_config.auth.entraTenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: _config.auth.entraClientId,
          code,
          redirect_uri: `${_config.clientUrl}/api/auth/_x_/oauth/callback`,
          code_verifier: codeVerifier,
        }),
      }
    );

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`);
    }

    const tokens = await tokenRes.json();

    // Validate the ID token using JWKS
    const JWKS = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${_config.auth.entraTenantId}/discovery/v2.0/keys`)
    );

    const { payload } = await jwtVerify(tokens.id_token, JWKS, {
      issuer: `https://login.microsoftonline.com/${_config.auth.entraTenantId}/v2.0`,
      audience: _config.auth.entraClientId,
    });

    return {
      entraId: payload.oid || payload.sub,
      email: payload.email || payload.preferred_username || '',
      displayName: payload.name || '',
      avatarUrl: null,
    };
  },

  // ── User management ──────────────────────────────────────────────────────

  async findOrCreateUser(profile) {
    const existing = await _db.query(
      'SELECT * FROM TALLY.users WHERE ENTRA_ID = ?',
      [profile.entraId]
    );

    if (existing.length > 0) {
      const row = existing[0];
      await _db.query(
        'UPDATE TALLY.users SET LAST_LOGIN_AT = NOW() WHERE ID = ?',
        [row.ID]
      );
      return AuthService._mapUser({ ...row, LAST_LOGIN_AT: new Date() });
    }

    // Insert new user
    const result = await _db.query(
      `INSERT INTO TALLY.users (ENTRA_ID, EMAIL, DISPLAY_NAME, AVATAR_URL, LAST_LOGIN_AT)
       VALUES (?, ?, ?, ?, NOW())`,
      [profile.entraId, profile.email, profile.displayName, profile.avatarUrl || null]
    );

    const inserted = await _db.query(
      'SELECT * FROM TALLY.users WHERE ID = ?',
      [result.insertId]
    );

    return AuthService._mapUser(inserted[0]);
  },

  // ── Session management ───────────────────────────────────────────────────

  async createSession(userId) {
    const token = uuidv4().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await _db.query(
      `INSERT INTO TALLY.sessions (USER_ID, TOKEN, EXPIRES_AT) VALUES (?, ?, ?)`,
      [userId, token, expiresAt]
    );

    await _db.query(
      'UPDATE TALLY.users SET LAST_LOGIN_AT = NOW() WHERE ID = ?',
      [userId]
    );

    return { token, expiresAt };
  },

  async validateSession(token) {
    const rows = await _db.query(
      `SELECT s.ID as SESSION_ID, s.TOKEN, s.EXPIRES_AT,
              u.ID, u.ENTRA_ID, u.EMAIL, u.DISPLAY_NAME, u.AVATAR_URL,
              u.CREATED_AT, u.LAST_LOGIN_AT
       FROM TALLY.sessions s
       JOIN TALLY.users u ON s.USER_ID = u.ID
       WHERE s.TOKEN = ? AND s.EXPIRES_AT > NOW()`,
      [token]
    );

    if (!rows.length) return null;

    return { user: AuthService._mapUser(rows[0]) };
  },

  async destroySession(token) {
    await _db.query(
      'DELETE FROM TALLY.sessions WHERE TOKEN = ?',
      [token]
    );
  },

  // ── Helpers ──────────────────────────────────────────────────────────────

  _mapUser(row) {
    return {
      id: row.ID,
      entraId: row.ENTRA_ID,
      email: row.EMAIL,
      displayName: row.DISPLAY_NAME,
      avatarUrl: row.AVATAR_URL || null,
      createdAt: row.CREATED_AT,
      lastLoginAt: row.LAST_LOGIN_AT || null,
    };
  },
};

module.exports = AuthService;
