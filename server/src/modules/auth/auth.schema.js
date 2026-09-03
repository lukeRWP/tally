const Joi = require('joi');

// GET /oauth/callback query. Entra appends extras (`session_state`, and
// `error`/`error_description` when the user cancels), so unknown keys pass;
// only the two we act on are required (#356).
const oauthCallback = Joi.object({
  code: Joi.string().required(),
  state: Joi.string().required(),
}).unknown(true);

module.exports = { oauthCallback };
