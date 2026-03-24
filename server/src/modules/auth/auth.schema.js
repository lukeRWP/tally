const Joi = require('joi');

const oauthCallback = Joi.object({
  code: Joi.string().required(),
  state: Joi.string().required(),
});

module.exports = { oauthCallback };
